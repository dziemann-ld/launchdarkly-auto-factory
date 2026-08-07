/**
 * Create a GitHub check run to carry the per-step approval-gate status, distinct
 * from the job's own pass/fail check.
 *
 * Why a separate check run: a workflow job can only resolve to success (exit 0)
 * or failure (exit non-zero), so a gate pause would otherwise read as the same
 * red X as a real failure or a reviewer rejection. A check run can carry the
 * canonical `action_required` conclusion — "a human must act" — which renders
 * distinctly and (under branch protection) blocks merge without masquerading as
 * a failure. When the gate is later approved we post `success` under the same
 * name so it supersedes the prior `action_required` on the same head SHA.
 *
 * Best-effort and non-fatal: needs `checks: write` on the workflow token and the
 * PR head SHA; missing either, it logs and returns (a 403 almost always means
 * the consuming workflow is missing `permissions: checks: write`).
 */

const CHECK_NAME = "AutoFactory — Approval gate";

export interface CheckRunTarget {
  repo?: string; // owner/name
  headSha?: string;
  token?: string;
}

export interface CheckRunOptions extends CheckRunTarget {
  /** Check-run name; defaults to the approval-gate check. */
  name?: string;
  conclusion: "action_required" | "success" | "neutral" | "failure";
  title: string;
  summary: string;
  /**
   * Optional long-form detail rendered below the summary in the check's own pane
   * (markdown). Used to carry the code reviewer's findings, so a red check is
   * never just a verdict with the reasoning left in the Actions log.
   */
  text?: string;
}

export async function postCheckRun(opts: CheckRunOptions): Promise<void> {
  const token = opts.token ?? process.env.GITHUB_TOKEN;
  const repo = opts.repo ?? process.env.GITHUB_REPOSITORY;
  const headSha = opts.headSha;

  if (!token || !repo || !headSha) {
    console.log("(check run skipped — missing token / repo / head SHA)");
    return;
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/check-runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name: opts.name ?? CHECK_NAME,
        head_sha: headSha,
        status: "completed",
        conclusion: opts.conclusion,
        output: { title: opts.title, summary: opts.summary, ...(opts.text ? { text: opts.text } : {}) },
      }),
    });
    if (res.ok) {
      console.log(`Posted check run '${opts.name ?? CHECK_NAME}' [${opts.conclusion}].`);
    } else if (res.status === 403) {
      console.log(
        `Check run failed: HTTP 403 — the workflow token likely lacks 'permissions: checks: write'.`,
      );
    } else {
      console.log(`Check run failed: HTTP ${res.status}`);
    }
  } catch (e) {
    console.warn(`Check run error (non-fatal): ${e instanceof Error ? e.message : e}`);
  }
}
