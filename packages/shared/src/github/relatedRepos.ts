/**
 * Cross-repo research for distributed estates (split repositories): the data
 * half of the `query_related_repos` tool. An app repo registers its sibling
 * repositories in `.autofactory/services.yaml` under `relatedRepos:`, and the
 * research planner queries them over the GitHub REST API to establish
 * upstream/downstream impact of a PR — consumers of a changed endpoint,
 * providers of a contract this repo depends on, shared flag keys — with
 * file-level evidence rather than registry hearsay.
 *
 * FAIL-SOFT BY POLICY: a missing registry simply means the tool is never
 * offered; an API failure surfaces as a tool error the model reads and works
 * around. Cross-repo reads must never block or fail a run.
 *
 * Auth: `GITHUB_TOKEN` (the Actions default token) reads the current repo and
 * public repos. Private sibling repos need a token that can read them —
 * `AUTOFACTORY_REPOS_TOKEN` overrides when set.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

import { SERVICES_FILE } from "../graph/assemble.js";

/** One registered related repository. */
export interface RelatedRepo {
  /** Registry key (short name agents refer to it by). */
  key: string;
  /** GitHub repo as owner/name. */
  repo: string;
  /** How it relates to THIS repo: it consumes us (downstream), we consume it (upstream), or peer (sibling). */
  relationship?: "upstream" | "downstream" | "sibling";
  /** What crosses the boundary — API contracts, events, shared flag keys. Shown to the agent. */
  description?: string;
}

const RELATIONSHIPS = new Set(["upstream", "downstream", "sibling"]);

/** Parse the `relatedRepos:` section of `.autofactory/services.yaml`. */
export function parseRelatedRepos(yamlText: string): RelatedRepo[] {
  let doc: { relatedRepos?: Record<string, Partial<RelatedRepo>> };
  try {
    doc = parseYaml(yamlText) as typeof doc;
  } catch {
    return [];
  }
  const repos: RelatedRepo[] = [];
  for (const [key, def] of Object.entries(doc?.relatedRepos ?? {})) {
    if (!def || typeof def !== "object" || typeof def.repo !== "string") continue;
    if (!/^[\w.-]+\/[\w.-]+$/.test(def.repo)) continue;
    repos.push({
      key,
      repo: def.repo,
      ...(def.relationship && RELATIONSHIPS.has(def.relationship) ? { relationship: def.relationship } : {}),
      ...(typeof def.description === "string" ? { description: def.description } : {}),
    });
  }
  return repos;
}

/** Read the registry from a checkout; [] when absent/unparseable (tool not offered). */
export function loadRelatedRepos(sandboxRoot: string): RelatedRepo[] {
  const path = join(sandboxRoot, SERVICES_FILE);
  if (!existsSync(path)) return [];
  try {
    return parseRelatedRepos(readFileSync(path, "utf8"));
  } catch {
    return [];
  }
}

const API_BASE = "https://api.github.com";
const RATE_LIMIT_RETRIES = 2;
const RATE_LIMIT_DEFAULT_WAIT_MS = 30_000;
const RATE_LIMIT_MAX_WAIT_MS = 65_000;
const MAX_SEARCH_RESULTS = 8;
const MAX_FILE_BYTES = 40_000;
const MAX_DIR_ENTRIES = 100;

interface SearchMatch {
  path: string;
  fragments: string[];
}

/**
 * Read-only GitHub client scoped to the registered related repos. Every method
 * throws on failure with a message the model can act on; the tool executor
 * turns throws into isError results.
 */
export class RelatedReposClient {
  constructor(
    readonly repos: RelatedRepo[],
    private readonly token: string,
    private readonly apiBase: string = process.env.GITHUB_API_URL ?? API_BASE,
  ) {}

  /** Resolve a registry key or owner/name to a registered repo (never beyond the registry). */
  resolve(ref: string): RelatedRepo | undefined {
    const r = ref.trim();
    return this.repos.find((x) => x.key === r || x.repo.toLowerCase() === r.toLowerCase());
  }

  /** The registry, formatted for the model. */
  list(): string {
    const lines = this.repos.map((r) => {
      const rel = r.relationship ? ` [${r.relationship}]` : "";
      const desc = r.description ? ` — ${r.description}` : "";
      return `- ${r.key} (${r.repo})${rel}${desc}`;
    });
    return `Registered related repositories (${this.repos.length}):\n${lines.join("\n")}\nrelationship semantics: downstream = consumes this repo's surfaces; upstream = this repo consumes theirs; sibling = peer.`;
  }

  private async gh(path: string, accept = "application/vnd.github+json"): Promise<unknown> {
    // Rate limits (search: 10/min; secondary limits on bursts) killed live run
    // PR #11's evidence-gathering — wait out up to two rate-limit responses
    // (Retry-After-aware, capped) before giving up. Auth failures don't retry.
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${this.apiBase}${path}`, {
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: accept,
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (res.status === 404) throw new Error(`not found (404) — check the path, or the token cannot see this repo`);

      const rateLimited =
        res.status === 429 ||
        (res.status === 403 &&
          (res.headers.get("x-ratelimit-remaining") === "0" || res.headers.get("retry-after") !== null));
      if (rateLimited && attempt < RATE_LIMIT_RETRIES) {
        const retryAfter = Number(res.headers.get("retry-after"));
        const resetAt = Number(res.headers.get("x-ratelimit-reset")) * 1000;
        const waitMs = Math.min(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : resetAt > Date.now()
              ? resetAt - Date.now() + 1000
              : RATE_LIMIT_DEFAULT_WAIT_MS,
          RATE_LIMIT_MAX_WAIT_MS,
        );
        await new Promise((r) => setTimeout(r, waitMs));
        continue;
      }
      if (rateLimited) {
        throw new Error(
          `GitHub API rate limit persisted after ${RATE_LIMIT_RETRIES} waits — prefer read_file/list_dir (higher limits than search), or proceed with the evidence you have`,
        );
      }
      if (res.status === 403 || res.status === 401) {
        throw new Error(
          `GitHub API ${res.status} — the run's token cannot read this repo (private repos need AUTOFACTORY_REPOS_TOKEN)`,
        );
      }
      if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}`);
      return res.json();
    }
  }

  /**
   * Code search within one registered repo (GitHub search API — default branch
   * only, index may lag very recent pushes). Returns matched paths with text
   * fragments when available.
   */
  async searchCode(repoRef: string, query: string): Promise<string> {
    const repo = this.mustResolve(repoRef);
    const q = encodeURIComponent(`${query} repo:${repo.repo}`);
    const data = (await this.gh(
      `/search/code?q=${q}&per_page=${MAX_SEARCH_RESULTS}`,
      "application/vnd.github.text-match+json",
    )) as {
      total_count?: number;
      items?: Array<{ path?: string; text_matches?: Array<{ fragment?: string }> }>;
    };
    const items: SearchMatch[] = (data.items ?? []).map((i) => ({
      path: i.path ?? "?",
      fragments: (i.text_matches ?? []).map((m) => m.fragment ?? "").filter(Boolean).slice(0, 3),
    }));
    if (items.length === 0) {
      return `No code-search hits for '${query}' in ${repo.repo}. NOTE: search covers the DEFAULT branch and the index can lag; absence of hits is weak evidence — use list_dir/read_file to verify hot paths directly.`;
    }
    const shown = items
      .map((i) => `${repo.repo}:${i.path}\n${i.fragments.map((f) => "  | " + f.replace(/\n/g, "\n  | ")).join("\n")}`)
      .join("\n\n");
    const more = (data.total_count ?? items.length) > items.length ? `\n(${data.total_count} total matches; first ${items.length} shown)` : "";
    return shown + more;
  }

  /** Fetch one file's text from a registered repo's default branch. */
  async readFile(repoRef: string, path: string): Promise<string> {
    const repo = this.mustResolve(repoRef);
    const clean = this.cleanPath(path);
    const data = (await this.gh(`/repos/${repo.repo}/contents/${encodeURI(clean)}`)) as {
      type?: string;
      encoding?: string;
      content?: string;
      size?: number;
    };
    if (Array.isArray(data)) throw new Error(`'${clean}' is a directory — use op='list_dir'`);
    if (data.type !== "file" || typeof data.content !== "string") {
      throw new Error(`'${clean}' in ${repo.repo} is not a readable file`);
    }
    const text = data.encoding === "base64" ? Buffer.from(data.content, "base64").toString("utf8") : data.content;
    if (text.length > MAX_FILE_BYTES) {
      return text.slice(0, MAX_FILE_BYTES) + `\n… [truncated at ${MAX_FILE_BYTES} bytes of ${text.length}]`;
    }
    return text;
  }

  /** List a directory of a registered repo's default branch. */
  async listDir(repoRef: string, path: string): Promise<string> {
    const repo = this.mustResolve(repoRef);
    const clean = this.cleanPath(path);
    const data = (await this.gh(`/repos/${repo.repo}/contents/${encodeURI(clean || "")}`)) as Array<{
      name?: string;
      type?: string;
    }>;
    if (!Array.isArray(data)) throw new Error(`'${clean}' is a file — use op='read_file'`);
    const entries = data
      .slice(0, MAX_DIR_ENTRIES)
      .map((e) => `${e.type === "dir" ? "d" : "f"} ${e.name ?? "?"}`);
    const more = data.length > MAX_DIR_ENTRIES ? `\n… ${data.length - MAX_DIR_ENTRIES} more entries` : "";
    return `${repo.repo}:${clean || "/"}\n${entries.join("\n")}${more}`;
  }

  private mustResolve(ref: string): RelatedRepo {
    const repo = this.resolve(ref);
    if (!repo) {
      throw new Error(
        `'${ref}' is not a registered related repo. Registered: ${this.repos.map((r) => r.key).join(", ")} (use op='list')`,
      );
    }
    return repo;
  }

  private cleanPath(path: string): string {
    const clean = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (clean.includes("..")) throw new Error("invalid path");
    return clean;
  }
}
