/**
 * Evidence for judges: the agent's ACTUAL changes, not its self-report.
 *
 * The judge otherwise sees only the brief the agent received and the agent's
 * final message — so a polished-but-wrong report could score well. This
 * collector gives the judge hook ground truth: a node-scoped `git diff` of
 * exactly the commits the just-finished agent landed.
 *
 * Node scoping works by snapshotting HEAD when the collector is created (before
 * the chain runs) and advancing the snapshot on every call: each call diffs
 * lastSeenHead..HEAD, which is precisely the commits made since the previous
 * judged node. "No new commits" is itself evidence (e.g. an honest skip).
 *
 * Defensive throughout: any git failure yields undefined (judge runs without
 * evidence) rather than breaking the evaluation.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Cap the evidence payload so judge prompts stay bounded. */
const MAX_EVIDENCE_CHARS = 24_000;

export type JudgeEvidenceCollector = (nodeKey: string) => Promise<string | undefined>;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function truncate(s: string): string {
  return s.length > MAX_EVIDENCE_CHARS ? `${s.slice(0, MAX_EVIDENCE_CHARS)}\n…[evidence truncated]` : s;
}

/**
 * Create a collector rooted at `cwd` (the repo the agents commit to). Returns a
 * collector that always yields undefined when `cwd` isn't a usable git checkout.
 */
export function createGitDiffEvidence(cwd: string): JudgeEvidenceCollector {
  let lastSeenHead: string | undefined;
  try {
    lastSeenHead = git(cwd, ["rev-parse", "HEAD"]);
  } catch {
    console.warn(`[judge] evidence disabled: '${cwd}' is not a git checkout`);
    return async () => undefined;
  }

  return async (nodeKey: string) => {
    try {
      const prev = lastSeenHead;
      if (!prev) return undefined;
      const head = git(cwd, ["rev-parse", "HEAD"]);
      if (head === prev) {
        return `The agent landed NO new commits during this step (repository HEAD unchanged at ${head.slice(0, 12)}).`;
      }
      const range = `${prev}..${head}`;
      const log = git(cwd, ["log", "--format=%h %an: %s", range]);
      const stat = git(cwd, ["diff", "--stat", prev, head]);
      const patch = git(cwd, ["diff", prev, head]);
      lastSeenHead = head;
      return truncate(
        `Commits landed by this step (${range}):\n${log}\n\nFiles changed:\n${stat}\n\nFull diff:\n${patch}`,
      );
    } catch (e) {
      console.warn(`[judge] evidence collection failed for '${nodeKey}' (non-fatal): ${e instanceof Error ? e.message : e}`);
      return undefined;
    }
  };
}

/**
 * Working-tree analog of `createGitDiffEvidence`, for front ends that run with
 * gitMode "workingTree" (the CLI, the Cursor extension): the agents normally
 * never commit, so commit-scoped evidence would report "no new commits" for
 * every node. This snapshots the set of dirty/untracked files (with content
 * hashes) and, per call, returns the diff-vs-HEAD of exactly the files whose
 * content changed since the previous judged node. Untracked files don't appear
 * in `git diff HEAD`, so their contents are appended as new-file sections (the
 * release manifest lands this way).
 *
 * It ALSO tracks HEAD: if commits landed since the previous call, their
 * node-scoped diff is included too. "Normally never commit" failed once in the
 * wild — a Cursor local agent committed each step via its native git, the tree
 * was clean at every judge call, and judges scored honest work 0.00 on "no
 * working-tree changes" evidence. Whoever moves the tree OR the history, the
 * evidence stays truthful.
 */
export function createWorkingTreeEvidence(cwd: string): JudgeEvidenceCollector {
  /** path → blob hash for every file differing from HEAD (incl. untracked). */
  const snapshot = (): Map<string, string> => {
    const files = new Set<string>();
    for (const f of git(cwd, ["diff", "HEAD", "--name-only"]).split("\n")) if (f) files.add(f);
    for (const f of git(cwd, ["ls-files", "--others", "--exclude-standard"]).split("\n")) if (f) files.add(f);
    const map = new Map<string, string>();
    for (const f of files) {
      try {
        map.set(f, git(cwd, ["hash-object", "--", f]));
      } catch {
        map.set(f, "(deleted)"); // dirty because deleted in the tree
      }
    }
    return map;
  };

  let last: Map<string, string>;
  let lastHead: string;
  try {
    lastHead = git(cwd, ["rev-parse", "HEAD"]);
    last = snapshot();
  } catch {
    console.warn(`[judge] evidence disabled: '${cwd}' is not a git checkout`);
    return async () => undefined;
  }

  return async (nodeKey: string) => {
    try {
      const parts: string[] = [];

      // Commits landed since the previous judged node (should not happen in
      // workingTree mode, but is primary evidence when it does).
      const head = git(cwd, ["rev-parse", "HEAD"]);
      if (head !== lastHead) {
        const range = `${lastHead}..${head}`;
        const log = git(cwd, ["log", "--format=%h %an: %s", range]);
        const patch = git(cwd, ["diff", lastHead, head]);
        parts.push(`Commits landed during this step (${range}):\n${log}\n\nCommitted diff:\n${patch}`);
        lastHead = head;
      }

      const now = snapshot();
      const changed = new Set<string>();
      for (const [f, h] of now) if (last.get(f) !== h) changed.add(f);
      // Files gone from the dirty set: reverted, removed — or just committed
      // above, in which case the commit diff already carries their content.
      for (const f of last.keys()) if (!now.has(f)) changed.add(f);
      last = now;

      if (changed.size > 0) {
        const files = [...changed].sort();
        const tracked = git(cwd, ["diff", "HEAD", "--", ...files]);
        const untracked = new Set(git(cwd, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean));
        const newFileParts: string[] = [];
        for (const f of files) {
          if (!untracked.has(f)) continue;
          try {
            newFileParts.push(`--- new file: ${f} ---\n${readFileSync(resolve(cwd, f), "utf8")}`);
          } catch {
            /* unreadable/binary — the file list above still names it */
          }
        }
        parts.push(
          `Working-tree changes made by this step (uncommitted, vs HEAD):\nFiles: ${files.join(", ")}\n\n${tracked}` +
            (newFileParts.length ? `\n\n${newFileParts.join("\n\n")}` : ""),
        );
      }

      if (parts.length === 0) {
        return "The agent made NO changes during this step (no working-tree edits, no commits).";
      }
      return truncate(parts.join("\n\n"));
    } catch (e) {
      console.warn(`[judge] evidence collection failed for '${nodeKey}' (non-fatal): ${e instanceof Error ? e.message : e}`);
      return undefined;
    }
  };
}
