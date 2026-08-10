import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { FlagState, NodeRun, RepoProfile } from "@auto-factory/shared";
import { buildPrSummary, countFindings, flagUrl, type SummaryInput } from "../packages/phase1-resource-factory/src/summary.js";

/**
 * The PR comment is the pipeline's whole UI. These tests pin the properties that
 * make it readable: the outcome leads, exactly one next action is stated, and
 * diagnostics stay collapsed instead of crowding out the answer.
 */
const run = (configKey: string, tags: Record<string, string> = {}, status: NodeRun["status"] = "completed"): NodeRun => ({
  configKey,
  status,
  output: "",
  tags,
});

const profile = (paths: string[]): RepoProfile => ({
  text: "…",
  truncated: false,
  sources: paths.map((path) => ({ path, chars: 100, truncated: false })),
});

const base: SummaryInput = {
  state: "approved",
  reason: "code review APPROVED",
  runs: [],
  tags: {},
  skipped: [],
  judgeScores: new Map(),
  propose: true,
};

describe("countFindings", () => {
  it("counts h4 findings per severity section", () => {
    const review = [
      "## Review: REJECT",
      "### Blocking",
      "#### R01 — a bug",
      "text",
      "#### R00 — a convention",
      "### Warnings",
      "#### R04 — dead branch",
      "### Notes",
      "- minor thing",
      "- another",
    ].join("\n");
    assert.deepEqual(countFindings(review), { blocking: 2, warnings: 1, notes: 2 });
  });

  it("returns zeroes for an unexpected shape rather than guessing", () => {
    assert.deepEqual(countFindings("just some prose"), { blocking: 0, warnings: 0, notes: 0 });
    assert.deepEqual(countFindings(""), { blocking: 0, warnings: 0, notes: 0 });
  });
});

describe("flagUrl", () => {
  it("deep-links into the LaunchDarkly UI", () => {
    assert.equal(
      flagUrl("enable-x", "proj"),
      "https://app.launchdarkly.com/projects/proj/flags/enable-x/targeting",
    );
  });

  it("honors a custom base and strips trailing slashes", () => {
    assert.equal(flagUrl("f", "p", "https://ld.example.com/"), "https://ld.example.com/projects/p/flags/f/targeting");
  });

  it("is undefined without both a flag and a project", () => {
    assert.equal(flagUrl(undefined, "p"), undefined);
    assert.equal(flagUrl("f", undefined), undefined);
  });
});

describe("buildPrSummary — the no-flag case (the common one)", () => {
  // Regression for the original layout: it opened with the list of agents that
  // did NOT run and spent four lines listing twelve convention files, so the
  // actual answer — "nothing to do" — had no more weight than the diagnostics.
  const rendered = buildPrSummary({
    ...base,
    state: "no-flag",
    reason: "no flag needed — nothing to review",
    runs: [run("autofactory-research-planner", { flag_worthy: "false", risk_score: "0.15", skip_flagging: "true" })],
    skipped: ["autofactory-flag-implementer", "autofactory-code-reviewer"],
    repoProfile: profile([".autofactory/profile.md", "CLAUDE.md", "docs/TESTING.md"]),
  });

  it("leads with the outcome", () => {
    assert.match(rendered.comment.split("\n")[0] as string, /^### ⚪ AutoFactory — no flag needed$/);
  });

  it("states plainly that no action is needed, above the fold", () => {
    const head = rendered.comment.slice(0, rendered.comment.indexOf("<details"));
    assert.match(head, /No action needed/);
  });

  it("keeps skipped agents and the conventions list out of the visible body", () => {
    const visible = rendered.comment.slice(0, rendered.comment.indexOf("<details"));
    assert.doesNotMatch(visible, /flag-implementer/);
    assert.doesNotMatch(visible, /CLAUDE\.md/);
    assert.doesNotMatch(visible, /TESTING\.md/);
    // Still available, just collapsed.
    assert.match(rendered.comment, /<details>\n<summary>Pipeline details<\/summary>/);
    assert.match(rendered.comment, /CLAUDE\.md/);
  });

  it("drops the redundant autofactory- prefix in the agent table", () => {
    assert.match(rendered.comment, /\| `research-planner` \| completed \|/);
  });
});

describe("buildPrSummary — approved with a proposed patch", () => {
  const patch = ["<details>", "```diff", "diff --git a/a.ts b/a.ts", "diff --git a/b.ts b/b.ts", "```", "</details>"].join("\n");
  const rendered = buildPrSummary({
    ...base,
    tags: { flag_key: "enable-x", flag_created: "true", metric_keys: "m-error,m-latency", risk_score: "0.4" },
    appProjectKey: "enablement-launchpad",
    patchBlock: patch,
    review: "## Review: APPROVE\n### Warnings\n#### R04 — dead branch\nbody",
    runs: [run("autofactory-code-reviewer", { review_approved: "true" })],
  });

  it("tells the reader to apply the diff, not just that it passed", () => {
    assert.match(rendered.comment, /\*\*Apply the proposed changes below\*\*/);
  });

  it("links the flag into LaunchDarkly", () => {
    assert.match(rendered.comment, /\[`enable-x`\]\(https:\/\/app\.launchdarkly\.com\/projects\/enablement-launchpad\/flags\/enable-x\/targeting\)/);
  });

  it("makes no claim about targeting when it wasn't read", () => {
    assert.match(rendered.comment, /\| \*\*Targeting\*\* \| not read this run/);
    assert.doesNotMatch(rendered.comment, /every environment/);
  });

  it("summarizes metrics, changed-file count, and review severity in the facts table", () => {
    assert.match(rendered.comment, /\| \*\*Metrics\*\* \| `m-error`, `m-latency` \|/);
    assert.match(rendered.comment, /\| \*\*Changes\*\* \| 2 files — \*\*not committed\*\*/);
    assert.match(rendered.comment, /\| \*\*Review\*\* \| 1 warning \|/);
  });

  // Regression: the review was wrapped in <details> by BOTH the action and the
  // renderer, so the live comment showed a nested block with "Code review" twice.
  it("wraps the review in exactly one <details>", () => {
    assert.equal(rendered.comment.split("<b>Code review</b>").length - 1, 1);
    const opens = (rendered.comment.match(/<details/g) ?? []).length;
    const closes = (rendered.comment.match(/<\/details>/g) ?? []).length;
    assert.equal(opens, closes, "unbalanced <details> tags");
    // patch + review + pipeline details, and nothing nested inside them.
    assert.equal(opens, 3);
  });

  it("demotes the reviewer's headings so they nest under the comment's own", () => {
    // The reviewer's `### Warnings` becomes `#### Warnings` inside <details>.
    assert.match(rendered.comment, /^#### Warnings$/m);
    // Its title line is dropped — the verdict is already the headline.
    assert.doesNotMatch(rendered.comment, /## Review: APPROVE/);
  });
});

/**
 * Regression for the worst bug this summary has had: it printed "serving the
 * control variation in every environment" as a hardcoded string. On the first
 * flag-worthy run that was false — the flag was ON in `test` serving the treatment
 * — and the claim sat exactly where a reviewer decides whether merging is safe.
 */
describe("buildPrSummary — flag targeting is read, never assumed", () => {
  const env = (on: boolean, released: string[]) => ({
    on,
    released,
    fallthroughServes: released,
    prerequisites: [],
    rulesServe: [],
    individualTargets: false,
  });
  const state = (envs: Record<string, ReturnType<typeof env>>): FlagState => ({
    exists: true,
    key: "drive-root-folder-id",
    kind: "multivariate",
    variations: [{ value: "0AAxkpvxpc6uvUk9PVA" }, { value: "" }],
    environments: envs,
  });
  const withFlag = { ...base, tags: { flag_key: "drive-root-folder-id" }, appProjectKey: "p" };

  it("reports the real per-environment state, and warns when already live", () => {
    const r = buildPrSummary({
      ...withFlag,
      flagState: state({ production: env(false, []), test: env(true, ["0AAxkpvxpc6uvUk9PVA"]) }),
    });
    assert.match(r.comment, /\| \*\*Targeting\*\* \| `production` off · `test` \*\*on\*\* → `0AAxkpvxpc6uvUk9PVA` \|/);
    // The dangerous claim must be gone, and replaced with a warning.
    assert.doesNotMatch(r.comment, /off in every environment/);
    assert.match(r.comment, /already live\*\* in `test`/);
    assert.match(r.comment, /merging changes behavior there immediately/);
  });

  it("only claims 'off everywhere' when LaunchDarkly actually says so", () => {
    const r = buildPrSummary({ ...withFlag, flagState: state({ production: env(false, []), test: env(false, []) }) });
    assert.match(r.comment, /The flag is off in every environment, so merging does not change behavior yet/);
    assert.doesNotMatch(r.comment, /already live/);
  });

  it("an 'on' flag serving no traffic is not reported as live", () => {
    const r = buildPrSummary({ ...withFlag, flagState: state({ production: env(true, []) }) });
    assert.match(r.comment, /`production` on \(serving no traffic\)/);
    assert.doesNotMatch(r.comment, /already live/);
  });

  it("says the targeting was not read rather than implying the flag is dark", () => {
    const r = buildPrSummary(withFlag);
    assert.match(r.comment, /not read this run — check LaunchDarkly before merging/);
    assert.doesNotMatch(r.comment, /off in every environment/);
  });

  it("shows the empty-string variation legibly", () => {
    const r = buildPrSummary({ ...withFlag, flagState: state({ production: env(true, [""]) }) });
    assert.match(r.comment, /`""`/);
  });
});

describe("buildPrSummary — rejected", () => {
  const rendered = buildPrSummary({
    ...base,
    state: "rejected",
    reason: "code review REJECTED",
    review: "## Review: REJECT\n### Blocking\n#### R01 — a\n#### R01 — b\n### Warnings\n#### R08 — c",
  });

  it("counts the blocking issues in the headline and points at them", () => {
    assert.match(rendered.comment, /^### ❌ AutoFactory — changes requested$/m);
    assert.match(rendered.comment, /\*\*Start with the 2 blocking issues under _Code review_ below\.\*\*/);
  });

  it("says nothing was applied", () => {
    assert.match(rendered.comment, /Nothing was merged or applied|not applied/);
  });
});

describe("buildPrSummary — failed runs explain themselves above the fold", () => {
  // The first version said only "see Pipeline details", so the reader had to
  // expand a collapsed block to learn why the check was red — and it asserted the
  // failure was the pipeline's fault, which for a red test suite at handoff is a
  // guess (it can equally be the change or a missing test environment).
  it("promotes a failed check's reason into the visible body", () => {
    const detail = "deterministic check failed after 'flag-implementer': [tests-green-at-handoff] the suite was red";
    const r = buildPrSummary({
      ...base,
      state: "verification-failed",
      reason: "check failed",
      warnings: { verifyText: detail },
    });
    const visible = r.comment.slice(0, r.comment.indexOf("<details"));
    assert.match(visible, /> deterministic check failed after 'flag-implementer'/);
    assert.doesNotMatch(r.comment, /not a problem with your code/);
    // And it isn't repeated inside the collapsed diagnostics.
    assert.equal(r.comment.split("tests-green-at-handoff").length - 1, 1);
  });

  it("promotes a halted run's reason too", () => {
    const detail = "'research-planner' ended 'stopped' before finishing";
    const r = buildPrSummary({ ...base, state: "incomplete", reason: "INCOMPLETE", warnings: { truncText: detail } });
    const visible = r.comment.slice(0, r.comment.indexOf("<details"));
    assert.match(r.comment, /^### ⚠️ AutoFactory — run incomplete$/m);
    assert.match(visible, /> 'research-planner' ended 'stopped'/);
  });

  it("a missing verdict is not presented as a rejection", () => {
    const r = buildPrSummary({ ...base, state: "no-verdict", reason: "INCOMPLETE" });
    assert.match(r.comment, /nothing here is a judgment on your code/);
  });
});

describe("buildPrSummary — check run", () => {
  it("puts the headline in the summary and the artifacts in the detail pane", () => {
    const r = buildPrSummary({
      ...base,
      review: "## Review: APPROVE\n### Notes\n- fine",
    });
    assert.match(r.checkSummary, /AutoFactory — review passed/);
    assert.ok(r.checkText);
    assert.match(r.checkText, /Code review/);
    // The detail pane must not repeat the headline block.
    assert.doesNotMatch(r.checkText, /AutoFactory — review passed/);
    assert.match(r.checkTitle, /Review passed — code review APPROVED/);
  });

  it("omits the detail pane when there is nothing to put in it", () => {
    const r = buildPrSummary({ ...base, state: "no-flag", reason: "no flag needed" });
    assert.equal(r.checkText, undefined);
  });

  it("warns when no repo conventions were found, since that degrades every agent", () => {
    const r = buildPrSummary({ ...base, state: "no-flag", reason: "no flag needed" });
    assert.match(r.comment, /No repository conventions found/);
  });
});
