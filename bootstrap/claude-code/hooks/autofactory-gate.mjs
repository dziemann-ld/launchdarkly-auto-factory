#!/usr/bin/env node
/**
 * PreToolUse gate: don't let a PR leave the machine before AutoFactory has run.
 *
 * Wired in .claude/settings.json against the Bash tool, this intercepts
 * `git push` and `gh pr create` and checks the run record the `autofactory`
 * CLI writes at `<git-dir>/autofactory-last-run.json` (dry runs don't write
 * one). Decisions:
 *
 *   - no record, or record from another branch → DENY, with the fix
 *     ("run /autofactory") fed back to Claude.
 *   - record says the review REJECTED the change (or a deterministic check
 *     failed) → ASK the human — a red verdict is a review opinion, not a
 *     pipeline failure, so the human may knowingly push anyway.
 *   - otherwise → allow.
 *
 * Deliberately branch-granular, not content-granular: committing the agents'
 * edits (or small follow-ups) after a run must not re-trip the gate. "Re-run
 * after significant new changes" stays advisory, in CLAUDE.md.
 *
 * Standalone by design — no imports from the tooling repo, so it can be
 * committed to any app repo as-is. Fails OPEN on its own errors: a broken
 * gate must not brick pushing.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

function decide(permissionDecision, reason) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision, permissionDecisionReason: reason },
    }),
  );
  process.exit(0);
}

try {
  let command = "";
  try {
    command = String(JSON.parse(readFileSync(0, "utf8"))?.tool_input?.command ?? "");
  } catch {
    decide("allow", "unparsable hook input — gate skipped");
  }

  // Only outward-bound PR actions are gated: `git`/`gh` must sit at a command
  // position (start, or after && ; | etc.), and `push` must be git's
  // SUBCOMMAND (allowing global options like -C <dir> / --no-pager before
  // it) — so `git stash push`, `echo git push`, and commit messages that
  // mention pushing all pass through.
  const cmdPos = String.raw`(?:^|[;&|(]\s*|\n\s*)`;
  const isGitPush = new RegExp(`${cmdPos}git\\s+(?:-[cC]\\s+\\S+\\s+|--?\\S+\\s+)*push\\b`).test(command);
  const isPrCreate = new RegExp(`${cmdPos}gh\\s+pr\\s+create\\b`).test(command);
  if (!isGitPush && !isPrCreate) {
    decide("allow", "not a push / PR-create command");
  }

  const git = (args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  let branch;
  let gitDir;
  try {
    branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
    const raw = git(["rev-parse", "--git-dir"]);
    gitDir = isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
  } catch {
    decide("allow", "not a git repository — gate skipped");
  }
  // The chain is for change branches; pushing the default branch isn't a PR.
  if (branch === "main" || branch === "master" || branch === "HEAD") {
    decide("allow", `no AutoFactory gate on '${branch}'`);
  }

  const recordPath = join(gitDir, "autofactory-last-run.json");
  if (!existsSync(recordPath)) {
    decide(
      "deny",
      `AutoFactory has not run on branch '${branch}'. Run /autofactory on the change set first (a dry run does not count), then push.`,
    );
  }
  let record;
  try {
    record = JSON.parse(readFileSync(recordPath, "utf8"));
  } catch {
    record = undefined;
  }
  if (!record || record.branch !== branch) {
    decide(
      "deny",
      `AutoFactory last ran on branch '${record?.branch ?? "(unknown)"}', not '${branch}'. Run /autofactory on this branch first, then push.`,
    );
  }
  if (record.outcome === "rejected" || record.outcome === "verification-failed" || record.outcome === "incomplete") {
    decide(
      "ask",
      `AutoFactory's last run on '${branch}' ended '${record.outcome}' (${record.at}). A red verdict is a review opinion — push anyway, or fix and re-run /autofactory?`,
    );
  }
  decide("allow", `AutoFactory ran on '${branch}': ${record.outcome}${record.flagKey ? ` (flag ${record.flagKey})` : ""}`);
} catch (e) {
  decide("allow", `AutoFactory gate error (failing open): ${e instanceof Error ? e.message : e}`);
}
