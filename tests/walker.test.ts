import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  AgentGraphDefinition,
  type LDAIAgentConfig,
  type LDAIConfigTracker,
  type LDAgentGraphFlagValue,
  type LDGraphTracker,
} from "@launchdarkly/server-sdk-ai";
import type {
  AgentNodeRequest,
  AgentNodeResult,
  AgentRunner,
} from "@auto-factory/shared";
import { walkGraph } from "@auto-factory/shared";

/**
 * Fake runner: returns a scripted `{status, tags}` per config key (no network,
 * no Anthropic/Vega plumbing). The final assistant message is synthesized so the
 * walker has something to carry forward as PREVIOUS_STEP_OUTPUT.
 */
class FakeRunner implements AgentRunner {
  constructor(private readonly scriptByKey: Record<string, Partial<AgentNodeResult>>) {}
  async runNode(req: AgentNodeRequest): Promise<AgentNodeResult> {
    const scripted = this.scriptByKey[req.configKey] ?? {};
    return {
      status: scripted.status ?? "completed",
      messages: scripted.messages ?? [
        { role: "assistant", content: `done: ${req.configKey}`, isFinal: true },
      ],
      tags: scripted.tags ?? {},
    };
  }
}

/** Minimal LDAIConfigTracker stub — the fake runner never reads it. */
const fakeConfigTracker = () => ({}) as unknown as LDAIConfigTracker;

/** Build an LDAIAgentConfig for a node key. */
function agentConfig(key: string): LDAIAgentConfig {
  return {
    key,
    enabled: true,
    instructions: `instructions for ${key}`,
    model: { name: "Anthropic.claude-sonnet-4-6" },
    createTracker: fakeConfigTracker,
  } as LDAIAgentConfig;
}

/**
 * Build a real `AgentGraphDefinition` for the linear research → flag → test →
 * review chain the walker traverses, with the same handoff conditions the
 * canonical graph uses.
 */
function buildGraph(): AgentGraphDefinition {
  const flagValue: LDAgentGraphFlagValue = {
    root: "research",
    edges: {
      research: [{ key: "flag", handoff: { skip_if_tags: { skip_flagging: "true" } } }],
      flag: [{ key: "test", handoff: { require_tags: { flag_created: "true" } } }],
      test: [{ key: "review" }],
    },
  };
  const configs: Record<string, LDAIAgentConfig> = {
    research: agentConfig("research"),
    flag: agentConfig("flag"),
    test: agentConfig("test"),
    review: agentConfig("review"),
  };
  const nodes = AgentGraphDefinition.buildNodes(flagValue, configs);
  return new AgentGraphDefinition(
    flagValue,
    nodes,
    true,
    () => ({}) as unknown as LDGraphTracker,
  );
}

const run = (script: Record<string, Partial<AgentNodeResult>>) =>
  walkGraph(buildGraph(), new FakeRunner(script), { PR_NUMBER: "1" });

describe("walkGraph", () => {
  it("runs the full chain when conditions pass", async () => {
    const r = await run({
      flag: { tags: { flag_created: "true" } },
      review: { tags: { review_approved: "approve" } },
    });
    assert.deepEqual(
      r.runs.map((x) => x.configKey),
      ["research", "flag", "test", "review"],
    );
    assert.equal(r.skipped.length, 0);
  });

  it("short-circuits when research sets skip_flagging (no flag needed) — NOT a stall", async () => {
    const r = await run({ research: { tags: { skip_flagging: "true" } } });
    assert.deepEqual(
      r.runs.map((x) => x.configKey),
      ["research"],
    );
    assert.deepEqual(r.skipped.sort(), ["flag", "review", "test"]);
    // An intentional skip_if short-circuit is a clean stop, not a stall.
    assert.equal(r.stalledAt, undefined);
  });

  it("stalls observably at flag when require_tags(flag_created) is unmet", async () => {
    const r = await run({ flag: { tags: {} } });
    assert.deepEqual(
      r.runs.map((x) => x.configKey),
      ["research", "flag"],
    );
    assert.ok(r.skipped.includes("test") && r.skipped.includes("review"));
    // The stall is surfaced with the node and the missing required tag.
    assert.equal(r.stalledAt?.node, "flag");
    assert.deepEqual(r.stalledAt?.unmet, [{ target: "test", requireMissing: { flag_created: "true" } }]);
  });

  it("a clean full run has no stall", async () => {
    const r = await run({
      flag: { tags: { flag_created: "true" } },
      review: { tags: { review_approved: "approve" } },
    });
    assert.equal(r.stalledAt, undefined);
  });

  it("emits a 'stalled' walk event for live UIs", async () => {
    const events: string[] = [];
    await walkGraph(buildGraph(), new FakeRunner({ flag: { tags: {} } }), { PR_NUMBER: "1" }, undefined, (e) =>
      events.push(e.type),
    );
    assert.ok(events.includes("stalled"), `expected a stalled event, got: ${events.join(", ")}`);
  });
});

/**
 * A node that ends without finishing (turn cap, failure, cancellation) has only a
 * partial final message — and the walker hands that message to the next agent as
 * its ENTIRE prompt. Halting is what stops one truncated node from silently
 * degrading every agent after it.
 */
describe("walkGraph — incomplete nodes halt the chain", () => {
  it("halts when the root stops mid-task instead of forwarding a fragment", async () => {
    const r = await run({
      research: {
        status: "stopped",
        messages: [{ role: "assistant", content: "Now let me look at existing tests and", isFinal: true }],
      },
    });
    assert.deepEqual(
      r.runs.map((x) => x.configKey),
      ["research"],
    );
    assert.deepEqual(r.truncatedAt, { node: "research", status: "stopped" });
    // Not a stall: routing was fine, the agent ran out of room.
    assert.equal(r.stalledAt, undefined);
  });

  it("halts on a failed node too", async () => {
    const r = await run({ flag: { status: "failed", tags: { flag_created: "true" } } });
    assert.deepEqual(
      r.runs.map((x) => x.configKey),
      ["research", "flag"],
    );
    assert.equal(r.truncatedAt?.node, "flag");
    assert.equal(r.truncatedAt?.status, "failed");
  });

  it("a fully completed chain reports no truncation", async () => {
    const r = await run({
      flag: { tags: { flag_created: "true" } },
      review: { tags: { review_approved: "approve" } },
    });
    assert.equal(r.truncatedAt, undefined);
  });

  it("gives the root an explicit turn budget (it has no inbound edge to carry one)", async () => {
    const seen: (number | undefined)[] = [];
    class RecordingRunner implements AgentRunner {
      async runNode(req: AgentNodeRequest): Promise<AgentNodeResult> {
        seen.push(req.maxTurns);
        return {
          status: "completed",
          messages: [{ role: "assistant", content: "ok", isFinal: true }],
          tags: req.configKey === "flag" ? { flag_created: "true" } : {},
        };
      }
    }
    await walkGraph(buildGraph(), new RecordingRunner(), { PR_NUMBER: "1" });
    // The root previously fell through to the runner's conservative default.
    assert.ok(
      typeof seen[0] === "number" && seen[0] >= 30,
      `expected the root to get an explicit budget, got ${String(seen[0])}`,
    );
  });
});

describe("walkGraph — approval gates", () => {
  const fullScript = {
    flag: { tags: { flag_created: "true" } },
    review: { tags: { review_approved: "approve" } },
  };

  it("halts BEFORE a gated node when approval is not granted", async () => {
    const r = await walkGraph(buildGraph(), new FakeRunner(fullScript), { PR_NUMBER: "1" }, undefined, undefined, {
      steps: ["flag"],
      resolve: () => false, // not approved
    });
    // Only research ran; the gated flag node and everything after did not.
    assert.deepEqual(
      r.runs.map((x) => x.configKey),
      ["research"],
    );
    assert.deepEqual(r.pendingApproval, { node: "flag" });
    assert.ok(r.skipped.includes("flag"));
  });

  it("runs the gated node (and continues) once approval is granted", async () => {
    const r = await walkGraph(buildGraph(), new FakeRunner(fullScript), { PR_NUMBER: "1" }, undefined, undefined, {
      steps: ["flag"],
      resolve: () => true, // approved
    });
    assert.deepEqual(
      r.runs.map((x) => x.configKey),
      ["research", "flag", "test", "review"],
    );
    assert.equal(r.pendingApproval, undefined);
  });

  it("only consults the gate for gated nodes, and supports async resolve", async () => {
    const asked: string[] = [];
    const r = await walkGraph(buildGraph(), new FakeRunner(fullScript), { PR_NUMBER: "1" }, undefined, undefined, {
      steps: ["test"],
      resolve: async (node) => {
        asked.push(node);
        return true;
      },
    });
    assert.deepEqual(asked, ["test"]); // never asked about research/flag/review
    assert.deepEqual(
      r.runs.map((x) => x.configKey),
      ["research", "flag", "test", "review"],
    );
  });

  it("emits an 'awaiting-approval' event when it halts", async () => {
    const events: string[] = [];
    await walkGraph(buildGraph(), new FakeRunner(fullScript), { PR_NUMBER: "1" }, undefined, (e) => events.push(e.type), {
      steps: ["flag"],
      resolve: () => false,
    });
    assert.ok(events.includes("awaiting-approval"), `got: ${events.join(", ")}`);
  });

  it("no gate config → unchanged behavior (full chain)", async () => {
    const r = await run(fullScript);
    assert.equal(r.pendingApproval, undefined);
    assert.equal(r.runs.length, 4);
  });
});
