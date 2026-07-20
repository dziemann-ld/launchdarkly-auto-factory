/**
 * A local record of the last completed AutoFactory run against a repo, written
 * to `<git-dir>/autofactory-last-run.json` — inside `.git/` on purpose, so it
 * can never be committed and never dirties the working tree.
 *
 * This is the evidence the pre-push gate reads (the PreToolUse hook in
 * bootstrap/claude-code/hooks/): "has AutoFactory run on this branch?" is
 * answered by branch match on this record, not by inferring from manifests
 * (a no-flag-needed run produces no manifest but still counts as a run).
 * Deliberately NOT written for dry runs (nothing was created), approval
 * pauses, or errors — those must not satisfy the gate.
 */

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

export type RunOutcome = "approved" | "noop" | "rejected" | "incomplete" | "verification-failed";

export interface RunRecord {
  branch?: string;
  head?: string;
  outcome: RunOutcome;
  flagKey?: string;
  manifest?: string;
  at: string;
}

/** Best-effort: a missing record only means the gate stays closed. */
export function writeRunRecord(root: string, record: Omit<RunRecord, "at">): void {
  try {
    // rev-parse resolves worktrees/submodules where `.git` is a file, not a dir.
    const rawGitDir = execFileSync("git", ["rev-parse", "--git-dir"], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    const gitDir = isAbsolute(rawGitDir) ? rawGitDir : resolve(root, rawGitDir);
    writeFileSync(
      join(gitDir, "autofactory-last-run.json"),
      JSON.stringify({ ...record, at: new Date().toISOString() }, null, 2) + "\n",
      "utf8",
    );
  } catch (e) {
    console.warn(`could not write run record (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
}
