/**
 * Tool set for the Anthropic agent path, capability-gated per node.
 *
 *  - Always: read-only repo inspection (`read_file`, `list_dir`, `grep`) +
 *    `tag_conversation` (routing tags the graph walker needs).
 *  - When `createFlag` is enabled: `create_flag` (real flag in the app project).
 *  - When `editFiles` is enabled: `write_file` / `edit_file` (mutate the checkout)
 *    + `commit_and_push` (commit to the PR branch). This is how the
 *    flag-implementer wires the flag into the code and the testing agent adds
 *    tests — completing the "wire the code and push" half of their jobs.
 *
 * Pushes use the workflow's GITHUB_TOKEN, whose commits do NOT recursively
 * trigger workflows, so there's no CI loop to guard against.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { intentSkeleton, normalizeReleaseIntent } from "../releaseIntent.js";
import type { KnowledgeGraph } from "../graph/schema.js";
import { fileNodeId, flagNodeId, serviceNodeId } from "../graph/schema.js";
import { blastRadius, neighbors } from "../graph/query.js";
import type { LdResourceWriter, MetricCategory } from "./ldWriter.js";
import type { ReleaseFlagFile, Scope } from "../types.js";

export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: { type: "object"; [k: string]: unknown };
}

const READONLY_TOOLS: AnthropicToolDef[] = [
  {
    name: "read_file",
    description:
      "Read a UTF-8 text file from the repository (relative to the repo root). Use this to inspect source files referenced in the PR or the prior step's brief.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Repo-relative file path, e.g. backend/app.py" } },
      required: ["path"],
    },
  },
  {
    name: "list_dir",
    description: "List the entries of a directory (relative to the repo root). Use to explore project structure.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Repo-relative directory path; \"\" or \".\" for the root" } },
      required: ["path"],
    },
  },
  {
    name: "grep",
    description:
      "Search the repository for a regular expression and return matching file:line snippets. Use to find existing patterns (e.g. flag-evaluation calls, endpoints).",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "JavaScript regular expression" },
        path: { type: "string", description: "Optional repo-relative subdirectory to scope the search" },
      },
      required: ["pattern"],
    },
  },
  {
    name: "git_diff",
    description:
      "Show the pull request's changes as a unified diff (base...HEAD), including commits added by earlier agents (flag wiring, tests). Call this FIRST to see exactly what changed instead of reading files one by one.",
    input_schema: {
      type: "object",
      properties: { base: { type: "string", description: "Base ref to diff against (default: the PR base / main)" } },
    },
  },
  {
    name: "tag_conversation",
    description:
      "Record routing tags for the AutoFactory pipeline. Call this once you've decided the outcome of your step so the chain can advance. Pass the tags your instructions specify (e.g. {\"flag_created\":\"true\"}, {\"skip_flagging\":\"true\"}, {\"needs_tests\":\"true\"}, {\"review_approved\":\"true\"}, {\"risk_level\":\"low\"}).",
    input_schema: {
      type: "object",
      properties: {
        tags: {
          type: "object",
          description: "Flat map of string tag keys to string values.",
          additionalProperties: { type: "string" },
        },
      },
      required: ["tags"],
    },
  },
];

const CREATE_FLAG_TOOL: AnthropicToolDef = {
  name: "create_flag",
  description:
    "Create a boolean feature flag in LaunchDarkly (the app/data-plane project). Treatment=true (new behavior), Control=false (existing behavior, served when off). Idempotent: re-creating an existing key is a no-op. For frontend/fullstack scopes, client-side SDK availability is enabled automatically so browser apps can evaluate the flag. After it succeeds, the flag_created/flag_key tags are set for you.",
  input_schema: {
    type: "object",
    properties: {
      key: { type: "string", description: "Flag key, e.g. enable-farewell (lowercase, hyphenated)" },
      name: { type: "string", description: "Human-readable flag name" },
      description: { type: "string", description: "What the flag gates" },
      scope: {
        type: "string",
        enum: ["frontend", "backend", "fullstack"],
        description:
          "Deploy scope from the release manifest. frontend/fullstack flags are exposed to the client-side SDK; backend flags are server-only. When omitted, read from `.release-flags/pr-<N>.json` if present.",
      },
      tags: { type: "array", items: { type: "string" }, description: "Extra tags (auto-factory tags are added automatically)" },
    },
    required: ["key"],
  },
};

const CREATE_METRIC_TOOL: AnthropicToolDef = {
  name: "create_metric",
  description:
    "Create a guarded-release metric in LaunchDarkly (the app/data-plane project). TWO backings: (1) EVENT-backed (default) — pass event_key; you must FIRST instrument the matching event in code (a LaunchDarkly `track(event_key, …)` call on the path the flag wraps, via edit_file) so the metric has data once live. (2) TRACE-backed — pass trace_query (an observability span filter, e.g. service_name=x AND span_name=\"GET /api/y\") INSTEAD of event_key; valid ONLY when the flag is evaluated inside the matched trace (the observability SDK's afterEvaluation hook enriches the span — see your Metric Backing rules), and requires the service to already emit spans. Latency-category trace metrics measure the span's duration (override with trace_value_location). Idempotent: re-creating an existing key is a no-op. After it succeeds the metrics_created/metric_keys tags are updated for you.",
  input_schema: {
    type: "object",
    properties: {
      key: { type: "string", description: "Metric key, convention <flag-key>-<category>, e.g. enable-fact-endpoint-error-rate" },
      category: { type: "string", enum: ["error", "latency", "business"], description: "error/latency = lower is better; business = higher is better" },
      event_key: { type: "string", description: "EVENT-backed: the custom event name your track() call emits, e.g. fact-endpoint-error. Omit when trace_query is set." },
      trace_query: { type: "string", description: "TRACE-backed: span filter selecting the spans to measure. The flag MUST be evaluated within the matched traces or the metric cannot attribute." },
      trace_value_location: { type: "string", description: "TRACE-backed latency only: span field/attribute holding the numeric value (default 'duration')." },
      name: { type: "string", description: "Human-readable metric name" },
      description: { type: "string", description: "What the metric measures" },
      randomization_unit: { type: "string", description: "Unit the metric is measured on; MUST match the flag rollout's unit. Default 'user'." },
      unit: { type: "string", description: "Numeric unit for latency metrics (default 'ms'); ignored for error/business." },
      tags: { type: "array", items: { type: "string" }, description: "Extra tags (auto-factory tags are added automatically)" },
    },
    required: ["key", "category"],
  },
};

const WRITE_FILE_TOOL: AnthropicToolDef = {
  name: "write_file",
  description:
    "Create or overwrite a repo file with the given contents (parent directories are created). Use for new files (e.g. a test file). Path is repo-relative.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Repo-relative file path" },
      content: { type: "string", description: "Full file contents" },
    },
    required: ["path", "content"],
  },
};

const EDIT_FILE_TOOL: AnthropicToolDef = {
  name: "edit_file",
  description:
    "Replace an exact substring in an existing repo file. Use to wire flag evaluation into code. `old_string` must appear exactly once; include enough surrounding context to make it unique.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Repo-relative file path" },
      old_string: { type: "string", description: "Exact text to replace (must be unique in the file)" },
      new_string: { type: "string", description: "Replacement text" },
    },
    required: ["path", "old_string", "new_string"],
  },
};

const RUN_TESTS_TOOL: AnthropicToolDef = {
  name: "run_tests",
  description:
    "Run the repository's test suite (auto-detected: pytest for Python, `npm test` for Node, `go test` for Go; dependencies are installed first) and return the output. Use this AFTER writing tests to confirm they actually pass — fix any failures and re-run before committing. Optionally scope to a subdirectory.",
  input_schema: {
    type: "object",
    properties: { dir: { type: "string", description: "Subdirectory to run tests in (e.g. backend). Defaults to repo root." } },
  },
};

const COMMIT_PUSH_TOOL: AnthropicToolDef = {
  name: "commit_and_push",
  description:
    "Stage all changes, commit, and push to the PR branch. Call this once after you've made your file edits so they land on the pull request. Provide a concise commit message.",
  input_schema: {
    type: "object",
    properties: { message: { type: "string", description: "Commit message" } },
    required: ["message"],
  },
};

export interface ToolCapabilities {
  /** Offer `create_flag` (needs a writer). */
  createFlag: boolean;
  /** Offer `create_metric` (needs a writer). */
  createMetric: boolean;
  /** Offer `write_file` / `edit_file` / `commit_and_push`. */
  editFiles: boolean;
  /** Offer `write_manifest` (release manifest create/update; intent-preserving). */
  writeManifest?: boolean;
  /** Steward-grade `write_manifest`: may also update an existing releaseIntent. */
  stewardManifest?: boolean;
  /** Offer `query_dependencies` (needs a composed knowledge graph, ADR 0010). */
  queryGraph?: boolean;
  /** Offer `read_ld_docs` (LaunchDarkly docs pages as markdown, allowlisted). */
  readDocs?: boolean;
}

const READ_LD_DOCS_TOOL: AnthropicToolDef = {
  name: "read_ld_docs",
  description:
    "Fetch a LaunchDarkly documentation page as clean markdown (docs pages serve markdown when '.md' is appended; this tool handles that). Use it when you are UNCERTAIN about LaunchDarkly-specific semantics or SDK syntax — e.g. track() in a language this repo doesn't demonstrate, guarded-rollout mechanics, metric type rules. Your instructions list a shortlist of relevant pages; pass 'llms.txt' to get the full documentation directory if the shortlist doesn't cover your question. LaunchDarkly docs only — other URLs are rejected. A failed fetch must never block your task: fall back to the repo's existing patterns.",
  input_schema: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Docs path, e.g. 'sdk/features/events' or 'home/releases/guarded-rollouts' (a full launchdarkly.com/docs URL also works), or 'llms.txt' for the directory.",
      },
      filter: {
        type: "string",
        description:
          "For 'llms.txt' only: case-insensitive term to filter the directory's lines (it is ~200KB — ALWAYS pass a filter, e.g. 'metric' or 'python').",
      },
    },
    required: ["path"],
  },
};

/** Docs-fetch policy: bounded, allowlisted, and never load-bearing. */
const DOCS_HOST = "launchdarkly.com";
const DOCS_MAX_BYTES = 25_000;
const DOCS_MAX_FETCHES_PER_RUN = 8;
const DOCS_TIMEOUT_MS = 10_000;

/**
 * Normalize a docs reference to a fetchable markdown URL. Accepts bare paths
 * ("sdk/features/events"), /docs/-prefixed paths, full launchdarkly.com URLs,
 * and "llms.txt". Returns an error string for anything off the allowlist.
 */
export function normalizeLdDocsUrl(raw: string): { url: string } | { error: string } {
  let path = raw.trim();
  if (!path) return { error: "read_ld_docs: empty path" };
  if (/^https?:\/\//i.test(path)) {
    let parsed: URL;
    try {
      parsed = new URL(path);
    } catch {
      return { error: `read_ld_docs: unparseable URL '${raw}'` };
    }
    const host = parsed.hostname.toLowerCase();
    if (host !== DOCS_HOST && !host.endsWith(`.${DOCS_HOST}`)) {
      return { error: `read_ld_docs: only ${DOCS_HOST} docs are fetchable (got '${parsed.hostname}')` };
    }
    path = parsed.pathname;
  }
  path = path.replace(/^\/+/, "").replace(/^docs\/+/, "").replace(/[?#].*$/, "").replace(/\/+$/, "");
  if (!path) return { error: "read_ld_docs: empty docs path" };
  if (path.includes("..")) return { error: "read_ld_docs: invalid path" };
  if (!/^[A-Za-z0-9._\/-]+$/.test(path)) return { error: `read_ld_docs: invalid characters in path '${raw}'` };
  if (!path.endsWith(".md") && !path.endsWith(".txt")) path += ".md";
  return { url: `https://${DOCS_HOST}/docs/${path}` };
}

const QUERY_DEPENDENCIES_TOOL: AnthropicToolDef = {
  name: "query_dependencies",
  description:
    "Query the estate's knowledge graph (service-to-service call edges observed from LaunchDarkly telemetry, plus flag-to-code wrap points). Call it with NO arguments for the blast radius of THIS PR's changed files: which services the change belongs to, which services depend on them (consumers at risk), which services they call, and which flags already wrap the changed code. Or pass `node` (a service key, flag key, or repo-relative file path) with `direction` to walk dependents/dependencies of one node. Results include a `gaps` list — treat a listed gap as UNKNOWN coverage, never as evidence of no impact.",
  input_schema: {
    type: "object",
    properties: {
      node: {
        type: "string",
        description:
          "Optional: service key (e.g. 'togglemart-catalog'), flag key, or repo-relative file path. Omit for the PR's blast radius.",
      },
      direction: {
        type: "string",
        enum: ["dependents", "dependencies"],
        description: "With `node`: walk who depends on it (default) or what it depends on.",
      },
      max_depth: { type: "number", description: "Traversal depth cap (default 3)." },
    },
  },
};

const WRITE_MANIFEST_TOOL: AnthropicToolDef = {
  name: "write_manifest",
  description:
    "Create or update the release manifest (.release-flags/pr-<N>.json). Pass only the fields you own — they are MERGED into the existing file (agent fields: flagKey, scope, releasePlan.*). The human-editable releaseIntent block is auto-initialized on first write and PRESERVED on later writes (you cannot overwrite it). The file is validated, written as schema 1.1, and committed to the PR branch automatically — do not also edit it with write_file/edit_file.",
  input_schema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Repo-relative manifest path, e.g. .release-flags/pr-42.json" },
      manifest: {
        type: "object",
        description:
          "Fields to merge, e.g. {\"flagKey\": \"enable-x\", \"scope\": \"backend\", \"releasePlan\": {\"metricKeys\": [...], \"randomizationUnit\": \"user\"}}",
      },
    },
    required: ["path", "manifest"],
  },
};

/**
 * Every sandbox tool definition, keyed by name — the built-in DEFAULTS for the
 * model-facing interface (description + schema), and the registry the
 * committed copies under config/agentcontrol/tools/ are generated from
 * (`npm run export:tools`). At run time, tool definitions ATTACHED to the
 * node's AI Config variation in LaunchDarkly override these (see
 * `applyLdToolOverlay`); execution always stays here in the executor.
 */
export const SANDBOX_TOOL_DEFS: ReadonlyMap<string, AnthropicToolDef> = new Map(
  [
    ...READONLY_TOOLS,
    READ_LD_DOCS_TOOL,
    QUERY_DEPENDENCIES_TOOL,
    CREATE_FLAG_TOOL,
    CREATE_METRIC_TOOL,
    WRITE_MANIFEST_TOOL,
    WRITE_FILE_TOOL,
    EDIT_FILE_TOOL,
    RUN_TESTS_TOOL,
    COMMIT_PUSH_TOOL,
  ].map((d) => [d.name, d]),
);

/** The LaunchDarkly-resolved tool attachments for a node (AI SDK `config.tools`). */
export interface LdToolAttachment {
  name?: string;
  description?: string;
  /** JSON schema for the tool input (the tools library's `schema` field). */
  parameters?: Record<string, unknown>;
}

/**
 * Apply the LaunchDarkly tool attachments to the capability-derived tool set.
 * LD shapes the INTERFACE within the code-set ceiling; it never broadens it:
 *  - attachments present → the offering is restricted to attached names
 *    (∩ capability set), except `tag_conversation`, which is always offered —
 *    the graph's routing depends on it, so a UI detach must not stall the chain;
 *  - an attachment's description/schema overrides the built-in default;
 *  - attached names with no local implementation are returned in `unknown`
 *    (log them — visible drift, never a silently offered no-op tool);
 *  - no attachments → the built-in defaults, unchanged (pre-tools projects).
 */
export function applyLdToolOverlay(
  defs: AnthropicToolDef[],
  ldTools?: Record<string, LdToolAttachment>,
): { tools: AnthropicToolDef[]; unknown: string[] } {
  const names = Object.keys(ldTools ?? {});
  if (!ldTools || names.length === 0) return { tools: defs, unknown: [] };
  const attached = new Set(names);
  const tools = defs
    .filter((d) => d.name === "tag_conversation" || attached.has(d.name))
    .map((d) => {
      const ld = ldTools[d.name];
      if (!ld) return d;
      const schema = ld.parameters;
      const schemaLooksValid =
        schema && typeof schema === "object" && ("properties" in schema || schema.type === "object");
      return {
        ...d,
        ...(ld.description ? { description: ld.description } : {}),
        ...(schemaLooksValid ? { input_schema: { type: "object" as const, ...schema } } : {}),
      };
    });
  const implemented = new Set(defs.map((d) => d.name));
  return { tools, unknown: names.filter((n) => !implemented.has(n)) };
}

/** Build the tool set offered to the model for a node, per its capabilities. */
export function buildSandboxTools(caps: ToolCapabilities): AnthropicToolDef[] {
  const tools = [...READONLY_TOOLS];
  if (caps.readDocs) tools.push(READ_LD_DOCS_TOOL);
  if (caps.queryGraph) tools.push(QUERY_DEPENDENCIES_TOOL);
  if (caps.createFlag) tools.push(CREATE_FLAG_TOOL);
  if (caps.createMetric) tools.push(CREATE_METRIC_TOOL);
  if (caps.writeManifest || caps.stewardManifest) tools.push(WRITE_MANIFEST_TOOL);
  if (caps.editFiles) tools.push(WRITE_FILE_TOOL, EDIT_FILE_TOOL, RUN_TESTS_TOOL, COMMIT_PUSH_TOOL);
  return tools;
}

const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "__pycache__", ".venv"]);
const MAX_GREP_MATCHES = 80;
const MAX_FILE_BYTES = 200_000;

export interface ToolExecResult {
  content: string;
  isError?: boolean;
}

/**
 * How `commit_and_push` finalizes the agents' edits:
 *  - "push" (default, GitHub Action): commit the changes and push to the PR branch.
 *  - "workingTree" (Cursor extension): leave the edits in the working tree,
 *    uncommitted, for the developer to review in the editor's SCM and commit
 *    themselves. No git writes.
 */
export type GitMode = "push" | "workingTree";

/**
 * Routing tags that assert a SIDE EFFECT actually happened. These are set ONLY by
 * their tool on a real success (create_flag → flag_created/flag_key; create_metric
 * → metrics_created/metric_keys) and are stripped from any agent-supplied
 * `tag_conversation` call. Otherwise an agent could fake e.g. `flag_created=true`
 * after the tool failed (a 401 on flag creation), advancing the chain — and
 * yielding a green run with no flag. Decision tags (flag_worthy, skip_flagging,
 * review_approved, risk_level, needs_tests) are the agent's judgment and stay
 * agent-settable.
 */
export const TOOL_OWNED_TAGS: ReadonlySet<string> = new Set([
  "flag_created",
  "flag_key",
  "metrics_created",
  "metric_keys",
]);

/**
 * Executes tool calls against a fixed root directory, accumulating routing tags.
 * One instance per node run. `writer` enables `create_flag` / `create_metric`;
 * `allowEdits` enables the file-mutation + git tools.
 */
export class SandboxToolExecutor {
  readonly tags: Record<string, string> = {};
  private knowledgeGraph?: KnowledgeGraph;
  private changedFiles: string[] = [];
  private docsFetches = 0;

  /**
   * Supply the composed knowledge graph (ADR 0010) + the PR's changed files.
   * Only meaningful for nodes granted `queryGraph`; set after construction so
   * existing call sites stay unchanged.
   */
  provideKnowledgeGraph(graph: KnowledgeGraph, changedFiles: string[] = []): void {
    this.knowledgeGraph = graph;
    this.changedFiles = changedFiles;
  }

  constructor(
    private readonly root: string,
    private readonly writer?: LdResourceWriter,
    private readonly allowEdits = false,
    /** PR head branch to push to (git tools). Falls back to PR_BRANCH env. */
    private readonly prBranch?: string,
    /** PR base ref for the git_diff base...HEAD. Falls back to PR_BASE_REF env. */
    private readonly prBaseRef?: string,
    /** Whether commit_and_push commits+pushes or leaves edits in the working tree. */
    private readonly gitMode: GitMode = "push",
    /** Offer `write_manifest` (intent-preserving release-manifest writes). */
    private readonly allowWriteManifest = false,
    /** Steward grade: `write_manifest` may also update an existing releaseIntent. */
    private readonly stewardManifest = false,
  ) {}

  /** Resolve a repo-relative path and reject anything escaping the sandbox root. */
  private safeResolve(rel: string): string {
    const abs = resolve(this.root, rel || ".");
    // `relative` is "" for the root itself, "sub/x" for descendants, and starts
    // with ".." (or is absolute, on a different drive/root) for escapes.
    const within = relative(this.root, abs);
    if (within === ".." || within.startsWith(".." + sep) || isAbsolute(within)) {
      throw new Error(`path '${rel}' is outside the sandbox`);
    }
    return abs;
  }

  async execute(name: string, input: Record<string, unknown>): Promise<ToolExecResult> {
    try {
      switch (name) {
        case "read_file":
          return { content: this.readFile(String(input.path ?? "")) };
        case "list_dir":
          return { content: this.listDir(String(input.path ?? "")) };
        case "grep":
          return { content: this.grep(String(input.pattern ?? ""), input.path ? String(input.path) : "") };
        case "git_diff":
          return this.gitDiff(input.base ? String(input.base) : undefined);
        case "tag_conversation":
          return { content: this.tag(input.tags) };
        case "create_flag":
          return await this.createFlag(input);
        case "create_metric":
          return await this.createMetric(input);
        case "write_manifest":
          return this.writeManifestTool(String(input.path ?? ""), input.manifest);
        case "query_dependencies":
          return this.queryDependencies(input);
        case "read_ld_docs":
          return await this.readLdDocs(String(input.path ?? ""), input.filter ? String(input.filter) : undefined);
        case "write_file":
          return this.writeFile(String(input.path ?? ""), String(input.content ?? ""));
        case "edit_file":
          return this.editFile(String(input.path ?? ""), String(input.old_string ?? ""), String(input.new_string ?? ""));
        case "run_tests":
          return this.runTests(input.dir ? String(input.dir) : undefined);
        case "commit_and_push":
          return this.commitAndPush(String(input.message ?? "AutoFactory changes"));
        default:
          return { content: `Unknown tool: ${name}`, isError: true };
      }
    } catch (e) {
      return { content: e instanceof Error ? e.message : String(e), isError: true };
    }
  }

  /**
   * `query_dependencies`: no `node` → blast radius of the PR's changed files;
   * with `node` → BFS dependents/dependencies. Bare names are resolved against
   * service, flag, then file node ids. Compact JSON out; the graph's `gaps`
   * ride along so thin coverage reads as unknown, not safe.
   */
  private queryDependencies(input: Record<string, unknown>): ToolExecResult {
    const graph = this.knowledgeGraph;
    if (!graph) {
      return {
        content:
          "knowledge graph unavailable for this run (flag off or composition failed) — reason about impact from the code instead",
        isError: true,
      };
    }
    const maxDepth = typeof input.max_depth === "number" && input.max_depth > 0 ? Math.min(input.max_depth, 6) : 3;
    const rawNode = typeof input.node === "string" ? input.node.trim() : "";
    if (!rawNode) {
      return { content: JSON.stringify(blastRadius(graph, this.changedFiles, maxDepth), null, 1) };
    }
    const candidates = [rawNode, serviceNodeId(rawNode), flagNodeId(rawNode), fileNodeId(rawNode)];
    const nodeId = candidates.find((id) => graph.nodes.some((n) => n.id === id));
    if (!nodeId) {
      const services = graph.services.map((s) => s.key).join(", ");
      return {
        content: `node '${rawNode}' not in the graph. Known services: ${services}. Flags/files must match a graph node (flag:<key> / file:<repo-relative path>).`,
        isError: true,
      };
    }
    const direction = input.direction === "dependencies" ? "dependencies" : "dependents";
    const hits = neighbors(graph, nodeId, direction, maxDepth).map((h) => ({
      id: h.id,
      kind: h.kind,
      depth: h.depth,
      via: `${h.via.kind} (${h.via.provenance}${h.via.evidence ? `: ${h.via.evidence}` : ""})`,
    }));
    return { content: JSON.stringify({ node: nodeId, direction, hits, gaps: graph.gaps }, null, 1) };
  }

  /**
   * `read_ld_docs`: fetch an allowlisted LaunchDarkly docs page as markdown.
   * Bounded (size cap, timeout, per-run fetch budget) and never load-bearing —
   * every failure returns an isError result telling the agent to proceed from
   * repo evidence. Note: the docs CDN serves brotli; Node's fetch decompresses
   * transparently (don't replace this with a raw-socket client).
   */
  private async readLdDocs(rawPath: string, filter?: string): Promise<ToolExecResult> {
    if (this.docsFetches >= DOCS_MAX_FETCHES_PER_RUN) {
      return {
        content: `read_ld_docs: fetch budget (${DOCS_MAX_FETCHES_PER_RUN}/run) exhausted — proceed with what you have`,
        isError: true,
      };
    }
    const normalized = normalizeLdDocsUrl(rawPath);
    if ("error" in normalized) return { content: normalized.error, isError: true };
    this.docsFetches += 1;
    try {
      const res = await fetch(normalized.url, {
        signal: AbortSignal.timeout(DOCS_TIMEOUT_MS),
        headers: { Accept: "text/markdown, text/plain" },
      });
      if (!res.ok) {
        return {
          content: `read_ld_docs: ${res.status} for ${normalized.url} — check the path (or fetch 'llms.txt' with a filter for the directory); proceed from repo evidence if unsure`,
          isError: true,
        };
      }
      let text = await res.text();
      // The docs site answers unknown pages with 200 + a not-found stub that
      // lists similar pages — surface it as an error but keep the suggestions.
      if (/^#\s*Page Not Found/im.test(text.slice(0, 200))) {
        return { content: `read_ld_docs: no page at ${normalized.url}. ${text.slice(0, 1500)}`, isError: true };
      }
      // llms.txt is a ~200KB directory; filter to matching lines when asked.
      if (normalized.url.endsWith("llms.txt") && filter) {
        const needle = filter.toLowerCase();
        const lines = text.split("\n").filter((l) => l.toLowerCase().includes(needle));
        text = lines.length
          ? `[${lines.length} directory entries matching '${filter}']\n${lines.join("\n")}`
          : `no directory entries match '${filter}' — try a broader term`;
      }
      const body =
        text.length > DOCS_MAX_BYTES
          ? `${text.slice(0, DOCS_MAX_BYTES)}\n…[truncated at ${DOCS_MAX_BYTES} chars${normalized.url.endsWith("llms.txt") ? " — pass a (narrower) 'filter' to search the directory" : " — the page continues"}]`
          : text;
      return { content: `[source: ${normalized.url}]\n\n${body}` };
    } catch (e) {
      return {
        content: `read_ld_docs: fetch failed (${e instanceof Error ? e.message : String(e)}) — proceed from the repo's existing patterns`,
        isError: true,
      };
    }
  }

  private readFile(rel: string): string {
    const abs = this.safeResolve(rel);
    const buf = readFileSync(abs);
    if (buf.byteLength > MAX_FILE_BYTES) {
      return `${buf.subarray(0, MAX_FILE_BYTES).toString("utf8")}\n…[truncated at ${MAX_FILE_BYTES} bytes]`;
    }
    return buf.toString("utf8");
  }

  private listDir(rel: string): string {
    const abs = this.safeResolve(rel);
    const entries = readdirSync(abs, { withFileTypes: true })
      .filter((e) => !SKIP_DIRS.has(e.name))
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort();
    return entries.length ? entries.join("\n") : "(empty)";
  }

  private grep(pattern: string, rel: string): string {
    const re = new RegExp(pattern);
    const start = this.safeResolve(rel);
    const matches: string[] = [];
    const walk = (dir: string): void => {
      if (matches.length >= MAX_GREP_MATCHES) return;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (matches.length >= MAX_GREP_MATCHES) return;
        if (SKIP_DIRS.has(entry.name)) continue;
        const abs = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          walk(abs);
        } else if (entry.isFile() && statSync(abs).size <= MAX_FILE_BYTES) {
          let text: string;
          try {
            text = readFileSync(abs, "utf8");
          } catch {
            continue;
          }
          const lines = text.split("\n");
          for (let i = 0; i < lines.length && matches.length < MAX_GREP_MATCHES; i++) {
            const line = lines[i] ?? "";
            if (re.test(line)) {
              matches.push(`${relative(this.root, abs)}:${i + 1}: ${line.trim().slice(0, 200)}`);
            }
          }
        }
      }
    };
    walk(start);
    return matches.length ? matches.join("\n") : "(no matches)";
  }

  private tag(raw: unknown): string {
    if (!raw || typeof raw !== "object") return "tag_conversation: expected a `tags` object";
    const recorded: string[] = [];
    const ignored: string[] = [];
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      // Side-effect tags can't be set by the agent — only by their tool on a real
      // success. Stripping them here makes a faked `flag_created=true` impossible.
      if (TOOL_OWNED_TAGS.has(k)) {
        ignored.push(k);
        continue;
      }
      this.tags[k] = String(v);
      recorded.push(`${k}=${String(v)}`);
    }
    let msg = recorded.length ? `Recorded tags: ${recorded.join(", ")}` : "No tags recorded";
    if (ignored.length) {
      msg += `. Ignored [${ignored.join(", ")}]: these are set only by their tool (create_flag / create_metric) on success and cannot be set via tag_conversation. If creation failed, do not claim it succeeded.`;
    }
    return msg;
  }

  private async createFlag(input: Record<string, unknown>): Promise<ToolExecResult> {
    if (!this.writer) return { content: "create_flag is not available", isError: true };
    const key = String(input.key ?? "");
    const scope = this.resolveFlagScope(input, key);
    const result = await this.writer.createBooleanFlag({
      key,
      ...(input.name ? { name: String(input.name) } : {}),
      ...(input.description ? { description: String(input.description) } : {}),
      ...(Array.isArray(input.tags) ? { tags: input.tags.map(String) } : {}),
      ...(scope ? { scope } : {}),
    });
    // Set routing tags so the chain advances even if the agent forgets to tag.
    this.tags.flag_created = "true";
    this.tags.flag_key = result.key;
    return { content: result.detail };
  }

  /**
   * Scope for client-side SDK exposure: explicit `scope` arg, else the matching
   * (or sole) `.release-flags/*.json` entry. Manifest scope defaults to frontend.
   */
  private resolveFlagScope(input: Record<string, unknown>, flagKey: string): Scope | undefined {
    const raw = typeof input.scope === "string" ? input.scope.trim() : "";
    if (raw === "frontend" || raw === "backend" || raw === "fullstack") return raw;
    return this.readScopeFromManifest(flagKey);
  }

  private readScopeFromManifest(flagKey: string): Scope | undefined {
    const dir = resolve(this.root, ".release-flags");
    if (!existsSync(dir)) return undefined;
    const files = readdirSync(dir).filter((name) => name.endsWith(".json"));
    if (!files.length) return undefined;

    let sole: ReleaseFlagFile | undefined;
    for (const name of files) {
      try {
        const data = JSON.parse(readFileSync(resolve(dir, name), "utf8")) as ReleaseFlagFile;
        sole = data;
        if (data.flagKey === flagKey) return data.scope ?? "frontend";
      } catch {
        /* ignore malformed manifest */
      }
    }
    // Planner creates the manifest before implementer; a single file is the PR's scope source.
    if (files.length === 1 && sole) return sole.scope ?? "frontend";
    return undefined;
  }

  private async createMetric(input: Record<string, unknown>): Promise<ToolExecResult> {
    if (!this.writer) return { content: "create_metric is not available", isError: true };
    const category = String(input.category ?? "");
    if (category !== "error" && category !== "latency" && category !== "business") {
      return { content: "create_metric: category must be one of error | latency | business", isError: true };
    }
    if (!input.event_key && !input.trace_query) {
      return { content: "create_metric: provide event_key (event-backed) or trace_query (trace-backed)", isError: true };
    }
    const result = await this.writer.createMetric({
      key: String(input.key ?? ""),
      ...(input.event_key ? { eventKey: String(input.event_key) } : {}),
      category: category as MetricCategory,
      ...(input.name ? { name: String(input.name) } : {}),
      ...(input.description ? { description: String(input.description) } : {}),
      ...(input.randomization_unit ? { randomizationUnit: String(input.randomization_unit) } : {}),
      ...(input.unit ? { unit: String(input.unit) } : {}),
      ...(input.trace_query ? { traceQuery: String(input.trace_query) } : {}),
      ...(input.trace_value_location ? { traceValueLocation: String(input.trace_value_location) } : {}),
      ...(Array.isArray(input.tags) ? { tags: input.tags.map(String) } : {}),
    });
    // Accumulate routing tags so the chain reflects real metric creation even if
    // the agent forgets to tag. metric_keys is a growing comma-separated list.
    this.tags.metrics_created = "true";
    const keys = this.tags.metric_keys ? this.tags.metric_keys.split(",").filter(Boolean) : [];
    if (!keys.includes(result.key)) keys.push(result.key);
    this.tags.metric_keys = keys.join(",");
    return { content: result.detail };
  }

  /**
   * Release-manifest writes: schema-validated, MERGED (never clobbering), with
   * the human-editable releaseIntent block structurally protected — agents get
   * create-if-absent semantics; only the steward grade may update an existing
   * intent. Auto-commits the manifest (with the [skip ci] loop guard) in push
   * mode; leaves it in the working tree otherwise.
   */
  private writeManifestTool(rel: string, incoming: unknown): ToolExecResult {
    if (!this.allowWriteManifest && !this.stewardManifest) {
      return { content: "write_manifest is not available", isError: true };
    }
    if (!/^\.release-flags\/[A-Za-z0-9._-]+\.json$/.test(rel)) {
      return { content: `write_manifest: path must be .release-flags/<name>.json (got '${rel}')`, isError: true };
    }
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      return { content: "write_manifest: `manifest` must be an object of fields to merge", isError: true };
    }
    const abs = this.safeResolve(rel);
    const inc = incoming as Record<string, unknown>;

    let existing: Record<string, unknown> = {};
    let existed = false;
    if (existsSync(abs)) {
      try {
        existing = JSON.parse(readFileSync(abs, "utf8")) as Record<string, unknown>;
        existed = true;
      } catch {
        // Corrupt/empty manifest on disk: treat as absent and rebuild it.
        existing = {};
      }
    }

    // releasePlan: merge field-wise; heal the legacy releaseOverrides key.
    const planOf = (o: Record<string, unknown>): Record<string, unknown> =>
      ((o.releasePlan ?? o.releaseOverrides) as Record<string, unknown> | undefined) ?? {};
    const mergedPlan = { ...planOf(existing), ...planOf(inc) };

    // releaseIntent: create-if-absent for agents; steward grade may update it.
    const existingIntent = existing.releaseIntent as Record<string, unknown> | undefined;
    let intent: Record<string, unknown>;
    let intentNote: string;
    if (existingIntent && !this.stewardManifest) {
      intent = existingIntent;
      intentNote = inc.releaseIntent !== undefined ? "releaseIntent PRESERVED (human-owned; your value was ignored)" : "releaseIntent preserved";
    } else if (inc.releaseIntent && typeof inc.releaseIntent === "object") {
      intent = inc.releaseIntent as Record<string, unknown>;
      intentNote = existingIntent ? "releaseIntent updated (steward)" : "releaseIntent set";
    } else if (existingIntent) {
      intent = existingIntent;
      intentNote = "releaseIntent preserved";
    } else {
      intent = intentSkeleton();
      intentNote = "releaseIntent initialized (human-editable skeleton)";
    }

    const {
      releasePlan: _ip, releaseOverrides: _io, releaseIntent: _ii, schemaVersion: _iv, ...incRest
    } = inc;
    const {
      releasePlan: _ep, releaseOverrides: _eo, releaseIntent: _ei, schemaVersion: _ev, ...existRest
    } = existing;
    const manifest: Record<string, unknown> = {
      schemaVersion: "1.1",
      ...existRest,
      ...incRest,
      releasePlan: mergedPlan,
      releaseIntent: intent,
    };

    // Deterministic intent check — report problems to the agent, never block the write.
    const { issues } = normalizeReleaseIntent(intent);

    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(manifest, null, 2) + "\n", "utf8");

    let commitNote = "left in the working tree (review and commit in your editor)";
    if (this.gitMode === "push") {
      try {
        this.runGit(["config", "user.email", "autofactory@launchdarkly.com"]);
        this.runGit(["config", "user.name", "LaunchDarkly AutoFactory"]);
        this.runGit(["add", rel]);
        const staged = this.runGit(["diff", "--cached", "--name-only"]).trim();
        if (staged) {
          this.runGit(["commit", "-m", `chore(auto-factory): ${existed ? "update" : "create"} ${rel}\n\n[skip ci]`]);
          const branch = this.prBranch ?? process.env.PR_BRANCH;
          this.runGit(branch ? ["push", "origin", `HEAD:${branch}`] : ["push"]);
          commitNote = "committed and pushed to the PR branch";
        } else {
          commitNote = "no changes (file already up to date)";
        }
      } catch (e) {
        const err = e as { stderr?: Buffer | string; message?: string };
        return {
          content: `write_manifest: wrote ${rel} but commit/push failed: ${(err.stderr?.toString() || err.message || String(e)).slice(0, 300)}`,
          isError: true,
        };
      }
    }

    return {
      content:
        `${existed ? "Updated" : "Created"} ${rel} (schema 1.1); ${intentNote}; ${commitNote}.` +
        (issues.length ? ` Intent issues (informational): ${issues.join("; ")}` : ""),
    };
  }

  private writeFile(rel: string, content: string): ToolExecResult {
    if (!this.allowEdits) return { content: "write_file is not available", isError: true };
    if (rel.startsWith(".release-flags/")) {
      return { content: "write_file: .release-flags/ manifests are managed by the write_manifest tool — use it instead", isError: true };
    }
    // An empty write is never intentional in this pipeline and has silently
    // produced a 0-byte release manifest (Phase 2's input) that the agent then
    // reported as written. Refuse it so the agent sees the problem and retries.
    if (!content.trim()) {
      return {
        content: `write_file: refusing to write empty content to ${rel} — pass the full file contents in the \`content\` argument`,
        isError: true,
      };
    }
    // JSON files (e.g. the .release-flags/ manifest) are machine-read downstream;
    // reject content that does not parse rather than committing garbage.
    if (rel.endsWith(".json")) {
      try {
        JSON.parse(content);
      } catch (e) {
        return {
          content: `write_file: ${rel} is a .json file but the content is not valid JSON (${e instanceof Error ? e.message : e}) — fix the JSON and retry`,
          isError: true,
        };
      }
    }
    const abs = this.safeResolve(rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
    return { content: `Wrote ${rel} (${Buffer.byteLength(content)} bytes)` };
  }

  private editFile(rel: string, oldStr: string, newStr: string): ToolExecResult {
    if (!this.allowEdits) return { content: "edit_file is not available", isError: true };
    if (rel.startsWith(".release-flags/")) {
      return { content: "edit_file: .release-flags/ manifests are managed by the write_manifest tool — use it instead", isError: true };
    }
    if (!oldStr) return { content: "edit_file: old_string is required", isError: true };
    const abs = this.safeResolve(rel);
    const text = readFileSync(abs, "utf8");
    const idx = text.indexOf(oldStr);
    if (idx === -1) return { content: `edit_file: old_string not found in ${rel}`, isError: true };
    if (text.indexOf(oldStr, idx + oldStr.length) !== -1) {
      return { content: `edit_file: old_string is not unique in ${rel}; add more context`, isError: true };
    }
    writeFileSync(abs, text.slice(0, idx) + newStr + text.slice(idx + oldStr.length), "utf8");
    return { content: `Edited ${rel}` };
  }

  private runGit(args: string[]): string {
    return execFileSync("git", args, { cwd: this.root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }

  /** Resolve the first base ref that exists locally, for a base...HEAD diff. */
  private resolveBaseRef(base?: string): string | undefined {
    const name = base || this.prBaseRef || process.env.PR_BASE_REF || "main";
    const candidates = [base, `origin/${name}`, name, "origin/main", "main"].filter((v): v is string => !!v);
    for (const ref of candidates) {
      try {
        this.runGit(["rev-parse", "--verify", "--quiet", ref]);
        return ref;
      } catch {
        /* try next */
      }
    }
    return undefined;
  }

  private gitDiff(base?: string): ToolExecResult {
    try {
      const ref = this.resolveBaseRef(base);
      if (!ref) return { content: "git_diff: could not resolve a base ref (not a git checkout?)", isError: true };
      // push mode (GHA): committed delta vs base. workingTree mode (extension):
      // diff the working tree against base so UNCOMMITTED agent edits (flag
      // wiring, instrumentation, tests) are included — downstream agents need them.
      const args = this.gitMode === "workingTree" ? ["diff", ref] : ["diff", `${ref}...HEAD`];
      const out = this.runGit(args);
      if (!out.trim()) return { content: `(no differences vs ${ref})` };
      return out.length > 60_000 ? { content: `${out.slice(0, 60_000)}\n…[diff truncated]` } : { content: out };
    } catch (e) {
      const err = e as { stderr?: Buffer | string; message?: string };
      return { content: `git_diff failed: ${(err.stderr?.toString() || err.message || String(e)).slice(0, 400)}`, isError: true };
    }
  }

  /** Run a command capturing output + exit code without throwing. */
  private sh(file: string, args: string[], cwd: string, timeoutMs = 240_000): { code: number; out: string } {
    const r = spawnSync(file, args, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
    const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
    if (r.error) return { code: -1, out: `${out}\n${r.error.message}` };
    return { code: r.status ?? 0, out };
  }

  private trunc(s: string): string {
    return s.length > 30_000 ? `${s.slice(0, 15_000)}\n…[output truncated]…\n${s.slice(-15_000)}` : s;
  }

  /** Auto-detect the repo's test runner (pytest / npm / go), install deps, and run it. */
  private runTests(dir?: string): ToolExecResult {
    if (!this.allowEdits) return { content: "run_tests is not available", isError: true };
    const cwd = dir ? this.safeResolve(dir) : this.root;
    const has = (f: string) => existsSync(resolve(cwd, f));
    let entries: string[] = [];
    try {
      entries = readdirSync(cwd);
    } catch {
      /* */
    }
    const where = dir || ".";

    const hasPyTests =
      has("pytest.ini") || has("pyproject.toml") || entries.some((f) => /^test_.+\.py$|_test\.py$/.test(f));
    if (has("requirements.txt") || hasPyTests) {
      const log: string[] = [];
      if (has("requirements.txt")) {
        const i = this.sh("python3", ["-m", "pip", "install", "-q", "-r", "requirements.txt"], cwd);
        if (i.code !== 0) log.push(`[deps] pip install -r requirements.txt exited ${i.code}:\n${i.out.slice(-1200)}`);
      }
      this.sh("python3", ["-m", "pip", "install", "-q", "pytest"], cwd);
      const t = this.sh("python3", ["-m", "pytest", "-q"], cwd);
      const body = `${log.join("\n")}\n$ python3 -m pytest -q (in ${where})\n${t.out}`.trim();
      return { content: this.trunc(body), isError: t.code !== 0 };
    }
    if (has("package.json")) {
      this.sh("npm", ["install", "--no-audit", "--no-fund"], cwd);
      const t = this.sh("npm", ["test"], cwd);
      return { content: this.trunc(`$ npm test (in ${where})\n${t.out}`), isError: t.code !== 0 };
    }
    if (has("go.mod")) {
      const t = this.sh("go", ["test", "./..."], cwd);
      return { content: this.trunc(`$ go test ./... (in ${where})\n${t.out}`), isError: t.code !== 0 };
    }
    return { content: "run_tests: no recognized test setup (pytest/npm/go) found in this directory", isError: true };
  }

  private commitAndPush(message: string): ToolExecResult {
    if (!this.allowEdits) return { content: "commit_and_push is not available", isError: true };
    // Cursor/extension mode: don't commit or push. The edits the agents made are
    // already in the working tree; the developer reviews them in the editor's
    // SCM and commits. Report what changed so the chain (and its tags) complete.
    if (this.gitMode === "workingTree") {
      try {
        const changed = this.runGit(["status", "--porcelain"]).trim();
        if (!changed) return { content: "No file changes were made." };
        const n = changed.split("\n").filter(Boolean).length;
        return {
          content: `Left ${n} changed file(s) in the working tree for review (not committed). Review and commit them in your editor. Intended commit message: "${message}"`,
        };
      } catch (e) {
        const err = e as { stderr?: Buffer | string; message?: string };
        return { content: `could not read working-tree status: ${(err.stderr?.toString() || err.message || String(e)).slice(0, 300)}`, isError: true };
      }
    }
    try {
      this.runGit(["config", "user.email", "autofactory@launchdarkly.com"]);
      this.runGit(["config", "user.name", "LaunchDarkly AutoFactory"]);
      this.runGit(["add", "-A"]);
      // Nothing staged → report rather than fail the node.
      const staged = this.runGit(["diff", "--cached", "--name-only"]).trim();
      if (!staged) return { content: "commit_and_push: no changes to commit" };
      // CI-LOOP GUARD: append [skip ci] so the agents' own push does NOT trigger a
      // new workflow run. This is the only reliable guard — a job-level `if:` can't
      // help because GitHub gates bot-triggered PR runs for approval at the run
      // level, BEFORE job conditions evaluate, so each agent commit would otherwise
      // sit waiting for manual approval (and risk a re-run loop). Tradeoff: this
      // skips ALL workflows on the agent commit, not just AutoFactory — acceptable
      // because the agents already run tests in-chain and the human's own pushes
      // (and the post-merge deploy) still trigger CI normally.
      const ciSafeMessage = /\[(skip ci|ci skip)\]/i.test(message) ? message : `${message}\n\n[skip ci]`;
      this.runGit(["commit", "-m", ciSafeMessage]);
      const branch = this.prBranch ?? process.env.PR_BRANCH;
      this.runGit(branch ? ["push", "origin", `HEAD:${branch}`] : ["push"]);
      return { content: `Committed and pushed (${staged.split("\n").length} file(s)): ${message}` };
    } catch (e) {
      const err = e as { stderr?: Buffer | string; message?: string };
      const detail = (err.stderr ? err.stderr.toString() : "") || err.message || String(e);
      return { content: `commit_and_push failed: ${detail.slice(0, 500)}`, isError: true };
    }
  }
}
