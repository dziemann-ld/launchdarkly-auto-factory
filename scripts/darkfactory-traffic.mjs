#!/usr/bin/env node
/**
 * Synthetic traffic generator for the Dark Software Factory demo project.
 *
 * Simulates factory runs through the `dark-factory` agent graph and emits the
 * real `$ld:ai:*` metric events (via the LD AI SDK trackers) that populate the
 * agent-graph monitoring page: per-node invocations, avg duration, error rate,
 * token usage, plus graph-level invocations/duration/tokens/path and per-edge
 * handoffs. No LLM is called — the "work" is sampled from per-station profiles.
 *
 *   DARKFACTORY_SDK_KEY=sdk-... node scripts/darkfactory-traffic.mjs [runs]
 *
 * Defaults to 40 runs. Each run walks the graph with probabilistic routing:
 * duplicate signals die at triage, tests fail and loop back to the implementer,
 * verification findings route through the Remediation Agent and re-verify,
 * rejected releases replan, canary regressions trigger the incident lane and
 * close the macro loop back to Signal Triage.
 */
import { init } from "@launchdarkly/node-server-sdk";
import { initAi } from "@launchdarkly/server-sdk-ai";
import { randomUUID } from "node:crypto";

const GRAPH_KEY = "dark-factory";
const RUNS = Number(process.argv[2] ?? 40);
const sdkKey = process.env.DARKFACTORY_SDK_KEY;
if (!sdkKey) {
  console.error("DARKFACTORY_SDK_KEY is required (production SDK key of the dark-software-factory project)");
  process.exit(1);
}

// Per-station realism profiles: duration (seconds), tokens, error rate, tools.
// durS/inTok are [lo, hi] uniform ranges; errors get a retry so the station
// still completes, which is how real runners behave.
const P = {
  "df-signal-triage":            { durS: [4, 18],    inTok: [800, 4000],    outTok: [80, 500],    err: 0.005, tools: ["grep", "read_file"] },
  "df-intent-researcher":        { durS: [45, 160],  inTok: [8000, 35000],  outTok: [800, 3000],  err: 0.02,  tools: ["read_file", "grep", "read_ld_docs", "query_related_repos"] },
  "df-impact-analyst":           { durS: [40, 140],  inTok: [9000, 40000],  outTok: [700, 2500],  err: 0.02,  tools: ["query_dependencies", "query_related_repos", "grep", "read_file"] },
  "autofactory-research-planner":{ durS: [60, 200],  inTok: [12000, 45000], outTok: [1500, 5000], err: 0.02,  tools: ["read_file", "grep", "list_dir", "tag_conversation"] },
  "autofactory-manifest-steward":{ durS: [8, 30],    inTok: [3000, 9000],   outTok: [300, 1200],  err: 0.01,  tools: ["write_manifest", "tag_conversation"] },
  "autofactory-flag-implementer":{ durS: [120, 480], inTok: [25000, 90000], outTok: [3000, 12000],err: 0.045, tools: ["create_flag", "edit_file", "write_file", "read_file", "grep", "git_diff", "commit_and_push"] },
  "autofactory-metrics-author":  { durS: [50, 180],  inTok: [10000, 40000], outTok: [1200, 4500], err: 0.03,  tools: ["create_metric", "list_metrics", "edit_file", "commit_and_push"] },
  "df-docs-author":              { durS: [25, 90],   inTok: [5000, 20000],  outTok: [900, 3500],  err: 0.01,  tools: ["read_file", "git_diff", "write_file", "commit_and_push"] },
  "autofactory-flag-testing":    { durS: [80, 300],  inTok: [15000, 55000], outTok: [2000, 8000], err: 0.04,  tools: ["write_file", "edit_file", "run_tests", "commit_and_push", "git_diff"] },
  "df-synthetic-tester":         { durS: [90, 360],  inTok: [6000, 25000],  outTok: [500, 2000],  err: 0.05,  tools: ["run_tests", "read_file", "git_diff"] },
  "df-qa-verifier":              { durS: [60, 240],  inTok: [8000, 30000],  outTok: [700, 2500],  err: 0.03,  tools: ["run_tests", "read_file", "grep", "git_diff"] },
  "autofactory-code-reviewer":   { durS: [40, 150],  inTok: [15000, 60000], outTok: [1000, 4000], err: 0.02,  tools: ["git_diff", "read_file", "grep"] },
  "df-style-reviewer":           { durS: [10, 40],   inTok: [6000, 25000],  outTok: [300, 1200],  err: 0.01,  tools: ["git_diff", "read_file", "grep"] },
  "df-bug-hunter":               { durS: [70, 260],  inTok: [20000, 70000], outTok: [1500, 6000], err: 0.03,  tools: ["git_diff", "grep", "read_file", "run_tests"] },
  "df-security-scanner":         { durS: [60, 220],  inTok: [18000, 65000], outTok: [1200, 5000], err: 0.025, tools: ["git_diff", "grep", "read_file", "query_dependencies"] },
  "df-dependency-auditor":       { durS: [15, 60],   inTok: [3000, 12000],  outTok: [300, 1500],  err: 0.015, tools: ["query_dependencies", "read_file"] },
  "df-sensitivity-classifier":   { durS: [6, 25],    inTok: [4000, 15000],  outTok: [150, 600],   err: 0.005, tools: ["git_diff", "grep"] },
  "df-policy-guardian":          { durS: [15, 55],   inTok: [6000, 20000],  outTok: [500, 2000],  err: 0.01,  tools: ["read_file", "git_diff", "write_manifest"] },
  "df-remediation-agent":        { durS: [90, 360],  inTok: [20000, 75000], outTok: [2500, 9000], err: 0.04,  tools: ["read_file", "edit_file", "write_file", "run_tests", "commit_and_push"] },
  "df-release-approver":         { durS: [12, 45],   inTok: [8000, 28000],  outTok: [400, 1500],  err: 0.01,  tools: ["read_file", "write_manifest"] },
  "df-release-manager":          { durS: [40, 150],  inTok: [4000, 15000],  outTok: [400, 1500],  err: 0.02,  tools: ["get_flag_state", "use_existing_flag", "write_manifest", "commit_and_push"] },
  "df-canary-analyst":           { durS: [300, 1500],inTok: [5000, 20000],  outTok: [500, 2000],  err: 0.02,  tools: ["get_flag_state", "list_metrics"] },
  "df-experiment-analyst":       { durS: [45, 160],  inTok: [6000, 22000],  outTok: [800, 3000],  err: 0.015, tools: ["list_metrics", "create_metric"] },
  "df-incident-responder":       { durS: [120, 500], inTok: [15000, 55000], outTok: [1500, 6000], err: 0.02,  tools: ["get_flag_state", "use_existing_flag", "git_diff", "grep", "read_file"] },
  "df-knowledge-curator":        { durS: [15, 60],   inTok: [4000, 15000],  outTok: [600, 2500],  err: 0.005, tools: ["read_file", "write_file"] },
};

const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const randInt = (lo, hi) => Math.round(rand(lo, hi));
const chance = (p) => Math.random() < p;
const pick = (arr, n) => [...arr].sort(() => Math.random() - 0.5).slice(0, Math.max(1, Math.min(n, arr.length)));

function makeContext() {
  return {
    kind: "multi",
    service: { key: "dark-factory-demo", name: "Dark Software Factory" },
    run: { key: randomUUID() },
  };
}

/** One station invocation: emits duration/tokens/tool-calls/success-or-error. */
function visit(graphDef, key, run) {
  const node = graphDef.getNode(key);
  if (!node) throw new Error(`graph has no node '${key}'`);
  const p = P[key];
  if (!p) throw new Error(`no profile for '${key}'`);
  const tracker = node.getConfig().createTracker();
  const failed = chance(p.err);
  // Errored invocations die early: partial duration, no token/tool telemetry.
  const durMs = Math.round(rand(...p.durS) * 1000 * (failed ? rand(0.1, 0.6) : 1));
  tracker.trackDuration(durMs);
  if (failed) {
    tracker.trackError();
    run.path.push(key);
    run.durMs += durMs;
    // Real runners retry once; the retry is its own invocation.
    return visit(graphDef, key, run);
  }
  const input = randInt(...p.inTok);
  const output = randInt(...p.outTok);
  tracker.trackTokens({ input, output, total: input + output });
  tracker.trackToolCalls(pick(p.tools, randInt(1, p.tools.length)));
  tracker.trackSuccess();
  run.path.push(key);
  run.durMs += durMs;
  run.tokens += input + output;
}

function handoff(gt, run, from, to) {
  // Rare transport-level handoff failures, then the handoff is retried.
  if (chance(0.008)) gt.trackHandoffFailure(from, to);
  gt.trackHandoffSuccess(from, to);
}

/** The verification fan-out: returns the set of stations with findings. */
function verificationPass(graphDef, gt, run, findingScale) {
  const stations = [
    ["autofactory-code-reviewer", 0.22 * findingScale, "changes_requested"],
    ["df-synthetic-tester", 0.15 * findingScale, "scenario_failures"],
    ["df-qa-verifier", 0.12 * findingScale, "regressions_found"],
    ["df-style-reviewer", 0, null], // advisory only — never routes to remediation
    ["df-bug-hunter", 0.18 * findingScale, "findings"],
    ["df-security-scanner", 0.09 * findingScale, "findings"],
    ["df-dependency-auditor", 0.05 * findingScale, "findings"],
    ["df-sensitivity-classifier", 0, null],
  ];
  const withFindings = [];
  for (const [key, p] of stations) {
    handoff(gt, run, "autofactory-flag-testing", key);
    visit(graphDef, key, run);
    if (chance(p)) withFindings.push(key);
  }
  // Governance lane: classifier always reports in; scanner forwards evidence.
  handoff(gt, run, "df-sensitivity-classifier", "df-policy-guardian");
  handoff(gt, run, "df-security-scanner", "df-policy-guardian");
  visit(graphDef, "df-policy-guardian", run);
  return withFindings;
}

/** Build spine: implementer → metrics/docs → flag testing, with the test-fail loop. */
function buildAndTest(graphDef, gt, run, { withDocs }) {
  visit(graphDef, "autofactory-flag-implementer", run);
  if (withDocs) {
    handoff(gt, run, "autofactory-flag-implementer", "df-docs-author");
    visit(graphDef, "df-docs-author", run);
  }
  handoff(gt, run, "autofactory-flag-implementer", "autofactory-metrics-author");
  visit(graphDef, "autofactory-metrics-author", run);
  handoff(gt, run, "autofactory-metrics-author", "autofactory-flag-testing");
  visit(graphDef, "autofactory-flag-testing", run);
  // Test-failure loop back to the implementer (first pass fails often, then rarely).
  let pFail = 0.3;
  while (chance(pFail)) {
    handoff(gt, run, "autofactory-flag-testing", "autofactory-flag-implementer");
    visit(graphDef, "autofactory-flag-implementer", run);
    handoff(gt, run, "autofactory-flag-implementer", "autofactory-metrics-author");
    visit(graphDef, "autofactory-metrics-author", run);
    handoff(gt, run, "autofactory-metrics-author", "autofactory-flag-testing");
    visit(graphDef, "autofactory-flag-testing", run);
    pFail *= 0.35;
  }
}

function simulateRun(graphDef) {
  const gt = graphDef.createTracker();
  const run = { path: [], durMs: 0, tokens: 0 };
  const finish = (ok) => {
    ok ? gt.trackInvocationSuccess() : gt.trackInvocationFailure();
    // Wall clock < sum of stations because research and verification fan out.
    gt.trackDuration(Math.round(run.durMs * 0.72));
    const outTok = Math.round(run.tokens * 0.09);
    gt.trackTotalTokens({ total: run.tokens, input: run.tokens - outTok, output: outTok });
    gt.trackPath(run.path);
  };

  // 1. Intake
  visit(graphDef, "df-signal-triage", run);
  if (chance(0.18)) return finish(true); // duplicate / non-actionable signal

  // 2. Research fan-out → planner fan-in
  handoff(gt, run, "df-signal-triage", "df-intent-researcher");
  visit(graphDef, "df-intent-researcher", run);
  handoff(gt, run, "df-signal-triage", "df-impact-analyst");
  visit(graphDef, "df-impact-analyst", run);
  handoff(gt, run, "df-intent-researcher", "autofactory-research-planner");
  handoff(gt, run, "df-impact-analyst", "autofactory-research-planner");
  visit(graphDef, "autofactory-research-planner", run);
  if (chance(0.05)) return finish(true); // skip_flagging: nothing to build

  // 3. Build spine
  handoff(gt, run, "autofactory-research-planner", "autofactory-manifest-steward");
  visit(graphDef, "autofactory-manifest-steward", run);
  handoff(gt, run, "autofactory-manifest-steward", "autofactory-flag-implementer");
  buildAndTest(graphDef, gt, run, { withDocs: true });

  // 4. Verification fan-out, remediation loops until findings drain
  let findings = verificationPass(graphDef, gt, run, 1);
  let round = 0;
  while (findings.length > 0 && round < 3) {
    for (const station of findings) handoff(gt, run, station, "df-remediation-agent");
    visit(graphDef, "df-remediation-agent", run);
    handoff(gt, run, "df-remediation-agent", "autofactory-flag-testing");
    visit(graphDef, "autofactory-flag-testing", run);
    findings = verificationPass(graphDef, gt, run, 0.3);
    round += 1;
  }

  // 5. Fan-in to the approval gate
  for (const station of [
    "autofactory-code-reviewer", "df-style-reviewer", "df-synthetic-tester",
    "df-qa-verifier", "df-dependency-auditor", "df-policy-guardian", "df-docs-author",
  ]) handoff(gt, run, station, "df-release-approver");
  visit(graphDef, "df-release-approver", run);

  // 6. Rejection loop: back to planning, one abbreviated rebuild
  if (chance(0.06)) {
    handoff(gt, run, "df-release-approver", "autofactory-research-planner");
    visit(graphDef, "autofactory-research-planner", run);
    handoff(gt, run, "autofactory-research-planner", "autofactory-manifest-steward");
    visit(graphDef, "autofactory-manifest-steward", run);
    handoff(gt, run, "autofactory-manifest-steward", "autofactory-flag-implementer");
    buildAndTest(graphDef, gt, run, { withDocs: false });
    handoff(gt, run, "autofactory-flag-testing", "autofactory-code-reviewer");
    visit(graphDef, "autofactory-code-reviewer", run);
    handoff(gt, run, "autofactory-code-reviewer", "df-release-approver");
    visit(graphDef, "df-release-approver", run);
  }

  // 7. Ship lane
  handoff(gt, run, "df-release-approver", "df-release-manager");
  visit(graphDef, "df-release-manager", run);
  handoff(gt, run, "df-release-manager", "df-canary-analyst");
  visit(graphDef, "df-canary-analyst", run);

  // 8. Operate: healthy → measure; regression → incident lane (macro loop)
  if (chance(0.1)) {
    handoff(gt, run, "df-canary-analyst", "df-incident-responder");
    visit(graphDef, "df-incident-responder", run);
    if (chance(0.7)) {
      handoff(gt, run, "df-incident-responder", "df-remediation-agent");
      visit(graphDef, "df-remediation-agent", run);
      handoff(gt, run, "df-remediation-agent", "autofactory-flag-testing");
      visit(graphDef, "autofactory-flag-testing", run);
    }
    if (chance(0.5)) {
      // The escape analysis becomes a new work item: the macro loop closes.
      handoff(gt, run, "df-incident-responder", "df-signal-triage");
      visit(graphDef, "df-signal-triage", run);
    }
    handoff(gt, run, "df-incident-responder", "df-knowledge-curator");
    visit(graphDef, "df-knowledge-curator", run);
    return finish(false); // the release itself regressed
  }
  handoff(gt, run, "df-canary-analyst", "df-experiment-analyst");
  visit(graphDef, "df-experiment-analyst", run);
  handoff(gt, run, "df-experiment-analyst", "df-knowledge-curator");
  visit(graphDef, "df-knowledge-curator", run);
  return finish(true);
}

const ldClient = init(sdkKey, { logger: { error: console.error, warn: () => {}, info: () => {}, debug: () => {} } });
await ldClient.waitForInitialization({ timeout: 15 });
const aiClient = initAi(ldClient);

for (let i = 0; i < RUNS; i += 1) {
  const graphDef = await aiClient.agentGraph(GRAPH_KEY, makeContext(), {});
  if (!graphDef.enabled && i === 0) {
    console.warn("warning: graph resolved with enabled=false — metrics may still record, continuing");
  }
  simulateRun(graphDef);
  if ((i + 1) % 10 === 0) {
    await ldClient.flush();
    console.log(`${i + 1}/${RUNS} runs simulated`);
  }
}
await ldClient.flush();
await new Promise((r) => setTimeout(r, 1000));
ldClient.close();
console.log(`done: ${RUNS} factory runs emitted to project dark-software-factory (graph '${GRAPH_KEY}')`);
