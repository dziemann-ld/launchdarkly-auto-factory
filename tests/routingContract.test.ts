import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";

import {
  AgentGraphDefinition,
  type LDAIAgentConfig,
  type LDAIConfigTracker,
  type LDAgentGraphFlagValue,
  type LDGraphTracker,
} from "@launchdarkly/server-sdk-ai";
import {
  type AgentNodeRequest,
  type AgentNodeResult,
  type AgentRunner,
  NODE_REQUIRED_TAGS,
  type WalkResult,
  decideApproval,
  interpretWalk,
  walkGraph,
} from "@auto-factory/shared";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (p: string) => JSON.parse(readFileSync(resolve(repoRoot, p), "utf8"));

// ---------------------------------------------------------------------------
// Fixture: the real 5-node chain (real config keys + real handoff conditions),
// so these tests double as executable documentation of the routing contract.
// ---------------------------------------------------------------------------
const KEYS = {
  research: "autofactory-research-planner",
  flag: "autofactory-flag-implementer",
  metrics: "autofactory-metrics-author",
  test: "autofactory-flag-testing",
  review: "autofactory-code-reviewer",
};

class FakeRunner implements AgentRunner {
  constructor(private readonly scriptByKey: Record<string, Partial<AgentNodeResult>>) {}
  async runNode(req: AgentNodeRequest): Promise<AgentNodeResult> {
    const s = this.scriptByKey[req.configKey] ?? {};
    return {
      status: s.status ?? "completed",
      messages: s.messages ?? [{ role: "assistant", content: `done: ${req.configKey}`, isFinal: true }],
      tags: s.tags ?? {},
    };
  }
}

function buildChain(): AgentGraphDefinition {
  const flagValue: LDAgentGraphFlagValue = {
    root: KEYS.research,
    edges: {
      [KEYS.research]: [{ key: KEYS.flag, handoff: { skip_if_tags: { skip_flagging: "true" } } }],
      [KEYS.flag]: [{ key: KEYS.metrics, handoff: { require_tags: { flag_ready: "true" } } }],
      [KEYS.metrics]: [{ key: KEYS.test, handoff: { require_tags: { needs_tests: "true" } } }],
      [KEYS.test]: [{ key: KEYS.review }],
    },
  };
  const cfg = (key: string): LDAIAgentConfig =>
    ({
      key,
      enabled: true,
      instructions: `instructions for ${key}`,
      model: { name: "Anthropic.claude-sonnet-4-6" },
      createTracker: () => ({}) as unknown as LDAIConfigTracker,
    }) as LDAIAgentConfig;
  const configs = Object.fromEntries(Object.values(KEYS).map((k) => [k, cfg(k)]));
  const nodes = AgentGraphDefinition.buildNodes(flagValue, configs);
  return new AgentGraphDefinition(flagValue, nodes, true, () => ({}) as unknown as LDGraphTracker);
}

async function runShape(script: Record<string, Partial<AgentNodeResult>>): Promise<WalkResult> {
  return walkGraph(buildChain(), new FakeRunner(script), { PR_NUMBER: "1" });
}
const path = (w: WalkResult) => w.runs.map((r) => r.configKey);
const decide = (w: WalkResult) => decideApproval(interpretWalk(w.tags));

// ---------------------------------------------------------------------------
describe("routing contract: PR-shape fixtures (walk → interpret → decide)", () => {
  it("flag-worthy PR runs the full chain and APPROVES", async () => {
    const w = await runShape({
      [KEYS.research]: { tags: { flag_worthy: "true" } },
      [KEYS.flag]: { tags: { flag_ready: "true", flag_created: "true" } },
      [KEYS.metrics]: { tags: { metrics_created: "true", metric_keys: "k-error-rate", needs_tests: "true" } },
      [KEYS.review]: { tags: { review_approved: "approve", risk_level: "low" } },
    });
    assert.deepEqual(path(w), [KEYS.research, KEYS.flag, KEYS.metrics, KEYS.test, KEYS.review]);
    assert.equal(w.stalledAt, undefined);
    const d = decide(w);
    assert.equal(d.apply, true);
    assert.equal(d.incomplete, false);
  });

  it("no-flag PR (skip_flagging) short-circuits to a clean no-op", async () => {
    const w = await runShape({ [KEYS.research]: { tags: { skip_flagging: "true", flag_worthy: "false" } } });
    assert.deepEqual(path(w), [KEYS.research]);
    assert.equal(w.stalledAt, undefined);
    const d = decide(w);
    assert.equal(d.noop, true);
    assert.equal(d.incomplete, false);
    assert.doesNotMatch(d.reason, /reject/i);
  });

  it("rejected PR runs the full chain and REJECTS (not incomplete)", async () => {
    const w = await runShape({
      [KEYS.research]: { tags: { flag_worthy: "true" } },
      [KEYS.flag]: { tags: { flag_ready: "true", flag_created: "true" } },
      [KEYS.metrics]: { tags: { needs_tests: "true" } },
      [KEYS.review]: { tags: { review_approved: "reject", risk_level: "high" } },
    });
    assert.deepEqual(path(w), [KEYS.research, KEYS.flag, KEYS.metrics, KEYS.test, KEYS.review]);
    const d = decide(w);
    assert.equal(d.apply, false);
    assert.equal(d.incomplete, false);
    assert.match(d.reason, /reject/i);
  });

  it("stall at metrics-author (needs_tests never set) → INCOMPLETE, not REJECTED (issue #9 failure mode #2)", async () => {
    const w = await runShape({
      [KEYS.research]: { tags: { flag_worthy: "true" } },
      [KEYS.flag]: { tags: { flag_ready: "true", flag_created: "true" } },
      [KEYS.metrics]: { tags: { metrics_created: "true" } }, // forgot needs_tests
    });
    assert.deepEqual(path(w), [KEYS.research, KEYS.flag, KEYS.metrics]);
    assert.equal(w.stalledAt?.node, KEYS.metrics);
    assert.deepEqual(w.stalledAt?.unmet, [{ target: KEYS.test, requireMissing: { needs_tests: "true" } }]);
    const d = decide(w);
    assert.equal(d.incomplete, true);
    assert.doesNotMatch(d.reason, /reject/i);
  });

  it("stall at flag-implementer (no verified flag outcome — no tool set flag_ready) → INCOMPLETE", async () => {
    const w = await runShape({
      [KEYS.research]: { tags: { flag_worthy: "true" } },
      [KEYS.flag]: { tags: {} }, // ran but no flag tool succeeded (create/add_variation/use_existing)
    });
    assert.deepEqual(path(w), [KEYS.research, KEYS.flag]);
    assert.equal(w.stalledAt?.node, KEYS.flag);
    assert.equal(decide(w).incomplete, true);
  });
});

// ---------------------------------------------------------------------------
describe("routing contract: registry ⟷ runtime + graph consistency", () => {
  const registry = readJson("config/agentcontrol/tags.json").tags as Record<string, unknown>;
  const registryKeys = new Set(Object.keys(registry));

  it("every NODE_REQUIRED_TAGS entry is a registry tag (the .mjs guard can't see this TS map)", () => {
    for (const [node, tags] of Object.entries(NODE_REQUIRED_TAGS)) {
      for (const t of tags) {
        assert.ok(registryKeys.has(t), `${node} forces '${t}', which is not in tags.json`);
      }
    }
  });

  it("every graph edge condition tag is a registry tag", () => {
    const graph = readJson("config/agentcontrol/graphs/auto-factory.json");
    for (const edge of graph.edges ?? []) {
      const h = edge.handoff ?? {};
      for (const kind of ["require_tags", "skip_if_tags"]) {
        for (const t of Object.keys(h[kind] ?? {})) {
          assert.ok(registryKeys.has(t), `edge ${edge.sourceConfig}→${edge.targetConfig} gates on '${t}', not in tags.json`);
        }
      }
    }
  });

  it("the verdict/routing tags interpretWalk reads are registry tags", () => {
    for (const t of ["review_approved", "risk_level", "skip_flagging"]) {
      assert.ok(registryKeys.has(t), `interpretWalk reads '${t}', which is not in tags.json`);
    }
  });
});

// ---------------------------------------------------------------------------
describe("routing contract: tag_conversation examples in committed instructions", () => {
  const configFiles = [
    "autofactory-research-planner",
    "autofactory-flag-implementer",
    "autofactory-metrics-author",
    "autofactory-flag-testing",
    "autofactory-code-reviewer",
  ].map((k) => `config/agentcontrol/ai-configs/${k}.json`);

  it("every tag_conversation example uses the valid {tags:{…}} object form (never key=…, value=…)", () => {
    for (const file of configFiles) {
      const instr: string = readJson(file).variations?.[0]?.instructions ?? "";
      // No invalid positional/keyword form.
      assert.equal(
        /tag_conversation\(\s*key\b/.test(instr),
        false,
        `${file}: uses the invalid tag_conversation(key=…) form`,
      );
      // Every explicit call example contains a tags object.
      for (const call of instr.match(/tag_conversation\([^)]*\)/g) ?? []) {
        assert.match(call, /\{\s*"?tags"?\s*:/, `${file}: example is not a tags object: ${call}`);
      }
    }
  });
});
