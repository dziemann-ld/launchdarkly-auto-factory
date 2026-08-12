/**
 * Renders the pull-request comment and check-run text.
 *
 * The comment is the pipeline's entire user interface, and the first version of it
 * was written for whoever debugs the pipeline, not for the engineer whose PR it is:
 * it opened with the list of agents that DIDN'T run, spent four lines on the twelve
 * convention files it read, and gave the reader no indication of what to do next.
 * The verdict — the only line that matters on most runs — had the same weight as
 * everything else.
 *
 * So the shape here is deliberate:
 *  1. A headline that states the OUTCOME, with a state-specific icon.
 *  2. One bolded next action. If the reader does nothing else, they read this.
 *  3. A short facts table: the flag (linked into LaunchDarkly), metrics, what
 *     changed, how the review landed. Only rows that apply.
 *  4. The artifacts — proposed diff, code review — expanded, since they're the work.
 *  5. Everything diagnostic collapsed behind "Pipeline details".
 *
 * Nothing is repeated across sections.
 */

import type { FlagState, NodeRun, RepoProfile, StallInfo } from "@auto-factory/shared";

/** Terminal outcome of a run, in the order the headline checks for them. */
export type RunState =
  | "verification-failed"
  | "incomplete"
  | "no-flag"
  | "no-verdict"
  | "rejected"
  | "approved";

export interface SummaryInput {
  state: RunState;
  /** `decideApproval().reason` — the canonical short phrasing. */
  reason: string;
  runs: readonly NodeRun[];
  /** Accumulated agent tags (flag_key, metric_keys, risk_score, …). */
  tags: Record<string, string>;
  skipped: readonly string[];
  judgeScores: ReadonlyMap<string, number>;
  /** App/data-plane project, for linking the flag into the LaunchDarkly UI. */
  appProjectKey?: string;
  ldBaseUrl?: string;
  /**
   * The flag's ACTUAL per-environment targeting, read from LaunchDarkly after the
   * walk. Undefined when it could not be read (no API access, or no flag).
   *
   * This exists because the first version of this summary asserted the flag was
   * "serving the control variation in every environment" as a hardcoded string. On
   * the very first flag-worthy run that was false — the flag was ON in `test`
   * serving the treatment — and the claim appeared exactly where a reviewer looks
   * to decide whether merging is safe. Release state is a fact to be read, never a
   * reassurance to be templated.
   */
  flagState?: FlagState;
  /** True when the agents' edits were left uncommitted for a human to apply. */
  propose: boolean;
  /** Rendered `<details>` block for the proposed diff, or "". */
  patchBlock?: string;
  /**
   * How the agents' work was delivered, when it was. Propose mode's whole value
   * depends on this being actionable: "apply with `git apply`" asked the reviewer to
   * copy a diff out of a browser.
   */
  delivery?: {
    /** Suggested changes posted as a review (Apply button, batchable). */
    suggestions: number;
    /** Stacked branch/PR carrying whatever couldn't be a suggestion. */
    stacked?: { branch: string; prUrl?: string; compareUrl?: string; files: string[] };
    /** Why some changes couldn't be suggestions, deduped by reason. */
    deferredReasons?: string[];
    /** Set when the suggestion review failed to post at all. */
    suggestionError?: string;
  };
  /** Raw reviewer markdown, or "". */
  review?: string;
  repoProfile?: RepoProfile;
  approvalMode?: string;
  approvalThreshold?: number;
  /** Warning lines, already prose. Empty strings are dropped. */
  warnings?: {
    stall?: StallInfo | undefined;
    stallText?: string;
    verifyText?: string;
    truncText?: string;
    intentLine?: string;
    intentWarning?: string;
    configDrift?: string;
    kgLine?: string;
  };
}

export interface RenderedSummary {
  /** Full PR comment body. */
  comment: string;
  /** Check-run title (max ~255 chars). */
  checkTitle: string;
  /** Check-run summary — the headline, action, and facts. */
  checkSummary: string;
  /** Check-run detail pane — review and patch. */
  checkText?: string;
}

interface FindingCounts {
  blocking: number;
  warnings: number;
  notes: number;
}

/**
 * Count findings per severity from the reviewer's markdown. The reviewer is
 * instructed to emit `### Blocking` / `### Warnings` / `### Notes` sections with a
 * `#### ` heading per finding (or `- ` bullets under Notes).
 *
 * Deliberately lenient: this drives presentation only, so an unexpected shape
 * yields zeroes and the summary simply omits the counts rather than misreporting.
 */
export function countFindings(review: string): FindingCounts {
  const counts: FindingCounts = { blocking: 0, warnings: 0, notes: 0 };
  if (!review) return counts;
  let section: keyof FindingCounts | undefined;
  for (const line of review.split("\n")) {
    const h3 = /^###\s+(.+?)\s*$/.exec(line);
    if (h3) {
      const name = (h3[1] as string).toLowerCase();
      section = name.startsWith("blocking")
        ? "blocking"
        : name.startsWith("warning")
          ? "warnings"
          : name.startsWith("note")
            ? "notes"
            : undefined;
      continue;
    }
    if (!section) continue;
    // A finding is an h4; Notes are commonly bullets instead.
    if (/^####\s+\S/.test(line) || (section === "notes" && /^[-*]\s+\S/.test(line))) counts[section] += 1;
  }
  return counts;
}

/** Deep-link a flag into the LaunchDarkly UI, or undefined if we can't. */
export function flagUrl(flagKey?: string, projectKey?: string, baseUrl?: string): string | undefined {
  if (!flagKey || !projectKey) return undefined;
  // LD_BASE_URL is the API base but shares the host with the app UI.
  const base = (baseUrl || "https://app.launchdarkly.com").replace(/\/+$/, "");
  return `${base}/projects/${projectKey}/flags/${flagKey}/targeting`;
}

/** Shorten a variation value for display; folder IDs and JSON get long. */
function shortValue(v: string): string {
  if (v === "") return '""';
  return v.length > 24 ? `${v.slice(0, 21)}…` : v;
}

/** Environments where the flag is on AND actually serving a variation to traffic. */
function liveEnvironments(state?: FlagState): string[] {
  if (!state?.exists) return [];
  return Object.entries(state.environments)
    .filter(([, e]) => e.on && e.released.length > 0)
    .map(([env]) => env);
}

/**
 * Per-environment targeting, stated plainly. "off" means the off-variation is
 * served, which is the control path; "on → value" means real traffic is getting
 * that variation right now.
 */
function targetingSummary(state: FlagState): string {
  const envs = Object.entries(state.environments);
  if (envs.length === 0) return "targeting could not be read";
  return envs
    .map(([env, e]) => {
      if (!e.on) return `\`${env}\` off`;
      if (e.released.length === 0) return `\`${env}\` on (serving no traffic)`;
      return `\`${env}\` **on** → ${e.released.map((v) => `\`${shortValue(v)}\``).join(", ")}`;
    })
    .join(" · ");
}

const HEADLINE: Record<RunState, { icon: string; title: string }> = {
  "verification-failed": { icon: "⛔", title: "checks failed" },
  incomplete: { icon: "⚠️", title: "run incomplete" },
  "no-flag": { icon: "⚪", title: "no flag needed" },
  "no-verdict": { icon: "⚠️", title: "no review verdict" },
  rejected: { icon: "❌", title: "changes requested" },
  approved: { icon: "✅", title: "review passed" },
};

/**
 * How to accept the agents' work, in the reader's terms. Names the concrete
 * mechanism rather than a git incantation, and never implies a change was delivered
 * when it wasn't.
 */
function applyInstruction(input: SuggestionInput): string {
  const d = input.delivery;
  if (!d) return "**Review the proposed changes below,**";
  const parts: string[] = [];
  if (d.suggestions > 0) {
    parts.push(
      `**Apply the ${d.suggestions} suggested change${d.suggestions === 1 ? "" : "s"}** in the Files changed tab (each has an *Apply* button; batch them into one commit)`,
    );
  }
  if (d.stacked) {
    const n = d.stacked.files.length;
    const files = `the ${n} file${n === 1 ? "" : "s"} that can't be suggestions`;
    // Prefer a link the reader can click. compareUrl is the fallback when we were
    // not allowed to open the PR ourselves — it opens GitHub's prefilled Open-PR
    // page, so it stays one click rather than becoming a git command.
    parts.push(
      d.stacked.prUrl
        ? `**merge [the stacked PR](${d.stacked.prUrl})** for ${files}`
        : d.stacked.compareUrl
          ? `**[open the stacked PR](${d.stacked.compareUrl})** and merge it, for ${files}`
          : `**merge branch \`${d.stacked.branch}\`** for ${files}`,
    );
  }
  if (parts.length === 0) return "**Review the proposed changes below,**";
  return `${parts.join(", then ")},`;
}

/** Narrow alias so applyInstruction reads independently of the full input. */
type SuggestionInput = Pick<SummaryInput, "delivery">;

/** The single most important line: what should the reader do now. */
function nextAction(input: SummaryInput, counts: FindingCounts): string {
  const hasPatch = Boolean(input.patchBlock);
  switch (input.state) {
    // Don't guess whose fault a failed check is — a red suite at handoff can be
    // the change, the agents' edits, or a missing test environment. State what
    // failed and let the detail (rendered right below) speak.
    case "verification-failed":
      return "**Nothing was applied.** A mechanical check on the pipeline's output failed, so the chain stopped before review:";
    case "incomplete":
      return "**Nothing was applied.** An agent stopped before finishing, so the run halted rather than continue on a partial brief:";
    case "no-flag":
      return "No action needed — this change doesn't need a feature flag, so no flag, metrics, or tests were created.";
    case "no-verdict":
      return "**Nothing was applied.** The chain ended without a review verdict, so nothing here is a judgment on your code — see _Pipeline details_.";
    case "rejected": {
      const n = counts.blocking;
      const what = n > 0 ? `${n} blocking ${n === 1 ? "issue" : "issues"}` : "blocking issues";
      return `**Start with the ${what} under _Code review_ below.** ${
        hasPatch ? "The proposed changes are included but not applied." : "Nothing was merged or applied."
      }`;
    }
    case "approved": {
      // "then merge this PR" — with a stacked PR in play, a bare "merge as usual"
      // leaves the reader guessing which of the two PRs is meant.
      const lead = hasPatch ? `${applyInstruction(input)} then merge this PR as usual.` : "**Ready to merge.**";
      const live = liveEnvironments(input.flagState);
      // Only claim the flag is dark when LaunchDarkly actually says so. If it is
      // already serving somewhere, that is the reviewer's business — flag it.
      if (live.length > 0) {
        return `${lead} ⚠️ Note: this flag is **already live** in ${live.map((e) => `\`${e}\``).join(", ")} — merging changes behavior there immediately, not on release.`;
      }
      if (input.flagState?.exists) return `${lead} The flag is off in every environment, so merging does not change behavior yet.`;
      return lead;
    }
  }
}

/** `| label | value |` rows for the facts table — only what applies. */
function factRows(input: SummaryInput, counts: FindingCounts): string[] {
  const rows: string[] = [];
  const flagKey = input.tags.flag_key;
  if (flagKey) {
    const url = flagUrl(flagKey, input.appProjectKey, input.ldBaseUrl);
    const link = url ? `[\`${flagKey}\`](${url})` : `\`${flagKey}\``;
    const created = input.tags.flag_created === "true";
    const kind = input.flagState?.exists ? `${input.flagState.kind}, ` : "";
    rows.push(`| **Flag** | ${link} — ${kind}${created ? "created" : "reused"} |`);
    // Targeting is READ, never assumed. When we couldn't read it, say so rather
    // than implying the flag is dark.
    rows.push(
      `| **Targeting** | ${
        input.flagState?.exists ? targetingSummary(input.flagState) : "not read this run — check LaunchDarkly before merging"
      } |`,
    );
  }
  const metrics = (input.tags.metric_keys ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (metrics.length) {
    rows.push(`| **Metrics** | ${metrics.map((m) => `\`${m}\``).join(", ")} |`);
  }
  if (input.patchBlock) {
    const files = countPatchFiles(input.patchBlock);
    const d = input.delivery;
    // Say HOW to take the work, not just how much of it there is.
    const how: string[] = [];
    if (d?.suggestions) how.push(`${d.suggestions} as suggested change${d.suggestions === 1 ? "" : "s"}`);
    if (d?.stacked) {
      const link = d.stacked.prUrl ?? d.stacked.compareUrl;
      how.push(link ? `${d.stacked.files.length} in a [stacked PR](${link})` : `${d.stacked.files.length} on \`${d.stacked.branch}\``);
    }
    rows.push(
      `| **Changes** | ${files ? `${files} file${files === 1 ? "" : "s"}` : "proposed"}, **not committed**${how.length ? ` — ${how.join(", ")}` : " — see the diff below"} |`,
    );
    if (d?.deferredReasons?.length) {
      rows.push(`| **Why not all suggestions** | ${d.deferredReasons.join("; ")} |`);
    }
    if (d?.suggestionError) {
      rows.push(`| **⚠ Suggestions** | could not be posted (${d.suggestionError}) — everything is on the branch instead |`);
    }
  } else if (input.propose && input.state !== "no-flag") {
    rows.push("| **Changes** | none proposed |");
  }
  if (input.review) {
    const parts: string[] = [];
    if (counts.blocking) parts.push(`**${counts.blocking} blocking**`);
    if (counts.warnings) parts.push(`${counts.warnings} warning${counts.warnings === 1 ? "" : "s"}`);
    if (counts.notes) parts.push(`${counts.notes} note${counts.notes === 1 ? "" : "s"}`);
    rows.push(`| **Review** | ${parts.length ? parts.join(" · ") : "no issues found"} |`);
  }
  // Risk is context for the rest, never the whole story: a table whose only row
  // is a bare score tells the reader nothing and just adds furniture.
  const risk = input.tags.risk_score;
  if (risk && rows.length) rows.push(`| **Risk score** | ${risk} |`);
  return rows;
}

/** `diff --git` lines in a rendered patch block. */
function countPatchFiles(patchBlock: string): number {
  return (patchBlock.match(/^diff --git /gm) ?? []).length;
}

/**
 * The collapsed diagnostics: agent table, warnings, context that was read.
 * `promoted` is a reason already shown above the fold — don't repeat it here.
 */
function pipelineDetails(input: SummaryInput, promoted?: string): string {
  const rows = input.runs.map((r) => {
    const judge = input.judgeScores.get(r.configKey);
    const tags =
      Object.entries(r.tags)
        .map(([k, v]) => `${k}=${v}`)
        .join(", ")
        .slice(0, 140) || "—";
    // Short names: the `autofactory-` prefix is on every row and adds nothing.
    const name = r.configKey.replace(/^autofactory-/, "");
    return `| \`${name}\` | ${r.status} | ${judge !== undefined ? judge.toFixed(2) : "—"} | ${tags} |`;
  });

  const w = input.warnings ?? {};
  const notes = [
    w.verifyText && w.verifyText !== promoted ? `- **Failed check:** ${w.verifyText}` : "",
    w.truncText && w.truncText !== promoted ? `- **Halted:** ${w.truncText}` : "",
    w.stallText ? `- **Stalled:** ${w.stallText}` : "",
    w.intentWarning ? `- **Release intent:** ${w.intentWarning}` : "",
    w.configDrift ? `- **Config drift:** ${w.configDrift}` : "",
    w.intentLine ? `- ${w.intentLine}` : "",
    w.kgLine ? `- ${w.kgLine}` : "",
    input.skipped.length ? `- **Not run:** ${input.skipped.map((s) => s.replace(/^autofactory-/, "")).join(", ")}` : "",
    input.approvalMode && input.approvalMode !== "yolo"
      ? `- **Approval mode:** ${input.approvalMode}${input.approvalMode === "risk-threshold" && input.approvalThreshold !== undefined ? ` @ ${input.approvalThreshold}` : ""}`
      : "",
  ].filter(Boolean);

  const profile = input.repoProfile
    ? [
        "",
        `**Repository conventions applied** (${input.repoProfile.sources.length} files, ${input.repoProfile.sources
          .reduce((n, s) => n + s.chars, 0)
          .toLocaleString()} chars)`,
        "",
        input.repoProfile.sources.map((s) => `\`${s.path}\``).join(" · "),
      ]
    : ["", "_No repository conventions found — the agents ran without repo context._"];

  return [
    "<details>",
    "<summary>Pipeline details</summary>",
    "",
    ...(notes.length ? [...notes, ""] : []),
    "| Agent | Status | Judge | Tags |",
    "|---|---|---|---|",
    ...(rows.length ? rows : ["| (none ran) | — | — | — |"]),
    ...profile,
    "",
    "</details>",
  ].join("\n");
}

/** Wrap the reviewer's markdown, demoting its headings to fit under ours. */
function reviewBlock(review: string, counts: FindingCounts): string {
  // The reviewer emits `## Review: …` plus `###`/`####` sections. Inside a
  // <details> those compete with the comment's own headings, so drop its title
  // line (the verdict is already the headline) and push the rest down one level.
  const body = review
    .split("\n")
    .filter((l) => !/^##\s+Review:/i.test(l))
    .map((l) => (/^#{3,5}\s/.test(l) ? `#${l}` : l))
    .join("\n")
    .trim();
  const label = counts.blocking
    ? `${counts.blocking} blocking`
    : counts.warnings
      ? `${counts.warnings} warning${counts.warnings === 1 ? "" : "s"}`
      : "no issues";
  return ["<details open>", `<summary><b>Code review</b> · ${label}</summary>`, "", body, "", "</details>"].join("\n");
}

export function buildPrSummary(input: SummaryInput): RenderedSummary {
  const counts = countFindings(input.review ?? "");
  const { icon, title } = HEADLINE[input.state];
  const action = nextAction(input, counts);
  const rows = factRows(input, counts);

  // The reason a run failed is the single most useful thing on the comment, so it
  // goes ABOVE the fold rather than collapsed with the diagnostics. Previously a
  // halted run said only "see Pipeline details" and the reader had to expand.
  const w = input.warnings ?? {};
  const blockingReason =
    input.state === "verification-failed" ? w.verifyText : input.state === "incomplete" ? w.truncText : undefined;

  const head = [
    `### ${icon} AutoFactory — ${title}`,
    "",
    action,
    ...(blockingReason ? ["", `> ${blockingReason}`] : []),
    ...(rows.length ? ["", "| | |", "|---|---|", ...rows] : []),
  ].join("\n");

  const artifacts = [
    input.patchBlock ?? "",
    input.review ? reviewBlock(input.review, counts) : "",
  ].filter(Boolean);

  const comment = [head, ...artifacts, pipelineDetails(input, blockingReason)].join("\n\n");

  return {
    comment,
    checkTitle: `${title.charAt(0).toUpperCase()}${title.slice(1)} — ${input.reason}`,
    checkSummary: head,
    ...(artifacts.length ? { checkText: artifacts.join("\n\n") } : {}),
  };
}
