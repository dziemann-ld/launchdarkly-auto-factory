/**
 * Delivery for propose mode: get the agents' uncommitted work to the reviewer in a
 * form they can accept with a click.
 *
 * Propose mode leaves edits in a CI checkout that is destroyed when the job ends, so
 * the first version posted the diff as text and said "apply with `git apply`" —
 * copy out of a browser, save a file, run git. Two mechanisms replace that, because
 * neither covers everything on its own:
 *
 *  - **Suggested changes** for edits to existing lines: a review comment with a
 *    ```suggestion block, which GitHub renders with an Apply button and can batch
 *    into one commit. Best UX, but it cannot create a file.
 *  - **A stacked branch + pull request** for everything else: the deferred work is
 *    committed to `autofactory/pr-<n>` and a PR is opened INTO the feature branch, so
 *    it has a Merge button, a reviewable diff, and CI of its own.
 *
 * The two are disjoint on purpose — whatever became a suggestion is left off the
 * branch, so nothing can be applied twice and conflict with itself. If the review
 * fails to post, the branch takes everything instead; a change must never be dropped
 * silently just because the nicer mechanism refused it.
 */

import { execFileSync } from "node:child_process";
import type { SuggestionComment } from "./suggestions.js";

const GH_HEADERS = (token: string) => ({
  Authorization: `Bearer ${token}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "Content-Type": "application/json",
});

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 20 * 1024 * 1024 });
}

/**
 * The agents' uncommitted work as a unified diff against the PR head.
 *
 * `-N` first: `git diff` ignores untracked files, and the agents' new files (tests,
 * the release manifest) are exactly what matters most here.
 */
export function rawProposedDiff(root: string): string {
  try {
    git(root, ["add", "-A", "-N"]);
    return git(root, ["diff", "HEAD"]).trim();
  } catch (e) {
    console.warn(`Could not read the proposed diff (non-fatal): ${e instanceof Error ? e.message : e}`);
    return "";
  }
}

/** Paths the agents touched, tracked or not. */
export function changedPaths(root: string): string[] {
  try {
    git(root, ["add", "-A", "-N"]);
    return git(root, ["diff", "--name-only", "HEAD"])
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export interface ReviewResult {
  posted: number;
  error?: string;
}

/**
 * Post the suggestions as ONE review, so GitHub offers "Add suggestion to batch" and
 * the reviewer can commit them all together.
 *
 * `event: "COMMENT"` deliberately, not `REQUEST_CHANGES`: these are offers to apply,
 * not a verdict. The verdict is the reviewer agent's, reported separately.
 */
export async function postSuggestionReview(
  repo: string,
  prNumber: string,
  token: string,
  comments: readonly SuggestionComment[],
  intro: string,
): Promise<ReviewResult> {
  if (comments.length === 0) return { posted: 0 };
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls/${prNumber}/reviews`, {
      method: "POST",
      headers: GH_HEADERS(token),
      body: JSON.stringify({
        event: "COMMENT",
        body: intro,
        comments: comments.map((c) => ({
          path: c.path,
          line: c.line,
          side: c.side,
          ...(c.start_line !== undefined ? { start_line: c.start_line, start_side: c.side } : {}),
          body: c.body,
        })),
      }),
    });
    if (res.ok) {
      console.log(`Posted ${comments.length} suggested change(s) as a review.`);
      return { posted: comments.length };
    }
    // A single bad anchor rejects the whole review, so report it and let the caller
    // fall back to the branch rather than losing the work.
    const detail = (await res.text()).slice(0, 300);
    console.warn(`Suggested-changes review failed: HTTP ${res.status} ${detail}`);
    return { posted: 0, error: `HTTP ${res.status}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`Suggested-changes review error: ${msg}`);
    return { posted: 0, error: msg };
  }
}

export interface StackedProposal {
  branch: string;
  /** URL of the stacked PR, when one could be opened or already existed. */
  prUrl?: string;
  prNumber?: number;
  files: string[];
}

/**
 * Commit `paths` to `autofactory/pr-<n>` and open a pull request into the PR's own
 * branch, so the reviewer gets a Merge button for work that cannot be a suggestion.
 *
 * Force-pushed: a re-run should replace its previous proposal rather than accumulate
 * commits, and the stacked PR then updates in place.
 */
export async function publishStackedProposal(opts: {
  root: string;
  repo: string;
  prNumber: string;
  prBranch: string;
  token: string;
  paths: readonly string[];
  /** Body for the stacked PR. */
  body: string;
}): Promise<StackedProposal | undefined> {
  const { root, repo, prNumber, prBranch, token, paths, body } = opts;
  if (paths.length === 0) return undefined;
  const branch = `autofactory/pr-${prNumber}`;

  try {
    git(root, ["config", "user.email", "autofactory@launchdarkly.com"]);
    git(root, ["config", "user.name", "LaunchDarkly AutoFactory"]);
    // Branch from the PR head, carrying ONLY the paths this proposal covers.
    git(root, ["checkout", "-B", branch]);
    git(root, ["reset"]);
    git(root, ["add", "--", ...paths]);
    const staged = git(root, ["diff", "--cached", "--name-only"]).trim();
    if (!staged) {
      console.log("Stacked proposal: nothing to commit.");
      return undefined;
    }
    // [skip ci] on the branch itself: the stacked PR runs CI, and the agents already
    // ran the suite in-chain.
    git(root, ["commit", "-q", "-m", `chore(auto-factory): proposed changes for #${prNumber}\n\n[skip ci]`]);
    git(root, ["push", "--force", "origin", `HEAD:refs/heads/${branch}`]);
    console.log(`Pushed stacked proposal to '${branch}' (${staged.split("\n").length} file(s)).`);
  } catch (e) {
    console.warn(`Could not push the stacked proposal (non-fatal): ${e instanceof Error ? e.message : e}`);
    return undefined;
  }

  const files = paths.slice();
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/pulls`, {
      method: "POST",
      headers: GH_HEADERS(token),
      body: JSON.stringify({
        title: `AutoFactory: proposed changes for #${prNumber}`,
        head: branch,
        base: prBranch,
        body,
        maintainer_can_modify: true,
      }),
    });
    if (res.ok) {
      const pr = (await res.json()) as { html_url?: string; number?: number };
      console.log(`Opened stacked PR ${pr.html_url ?? "(url unknown)"} into '${prBranch}'.`);
      return { branch, files, ...(pr.html_url ? { prUrl: pr.html_url } : {}), ...(pr.number ? { prNumber: pr.number } : {}) };
    }
    // 422 is the normal "a PR for this head already exists" case on a re-run: the
    // force-push already updated it, so find and reuse it.
    if (res.status === 422) {
      const owner = repo.split("/")[0];
      const list = await fetch(`https://api.github.com/repos/${repo}/pulls?head=${owner}:${branch}&state=open`, {
        headers: GH_HEADERS(token),
      });
      if (list.ok) {
        const open = (await list.json()) as Array<{ html_url?: string; number?: number }>;
        const existing = open[0];
        if (existing) {
          console.log(`Stacked PR already open: ${existing.html_url} (updated by force-push).`);
          return {
            branch,
            files,
            ...(existing.html_url ? { prUrl: existing.html_url } : {}),
            ...(existing.number ? { prNumber: existing.number } : {}),
          };
        }
      }
    }
    console.warn(`Could not open the stacked PR: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  } catch (e) {
    console.warn(`Stacked PR error (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
  // The branch exists even when the PR couldn't be opened — still usable.
  return { branch, files };
}
