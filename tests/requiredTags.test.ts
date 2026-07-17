import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NODE_REQUIRED_TAGS, missingRequiredTags } from "@auto-factory/shared";

describe("missingRequiredTags (forced routing-tag safety net, issue #9 item #1)", () => {
  it("reports the node's required tags as missing when absent", () => {
    // research-planner finished with no routing decision recorded.
    assert.deepEqual(missingRequiredTags("autofactory-research-planner", {}), ["flag_worthy", "flag_action", "risk_score"]);
    // metrics-author created a metric (auto tags) but never set the testing hand-off.
    assert.deepEqual(
      missingRequiredTags("autofactory-metrics-author", { metrics_created: "true", metric_keys: "x" }),
      ["needs_tests"],
    );
    // reviewer finished without a verdict — would otherwise read as REJECTED.
    assert.deepEqual(missingRequiredTags("autofactory-code-reviewer", { risk_level: "low" }), ["review_approved"]);
  });

  it("reports nothing missing once the required tag is present (any value)", () => {
    assert.deepEqual(
      missingRequiredTags("autofactory-research-planner", { flag_worthy: "false", flag_action: "none", risk_score: "0.3" }),
      [],
    );
    assert.deepEqual(missingRequiredTags("autofactory-metrics-author", { needs_tests: "true" }), []);
    assert.deepEqual(missingRequiredTags("autofactory-code-reviewer", { review_approved: "approve" }), []);
  });

  it("requires nothing for nodes with no declared routing tags (e.g. flag-implementer, unknown keys)", () => {
    assert.deepEqual(missingRequiredTags("autofactory-flag-implementer", {}), []);
    assert.deepEqual(missingRequiredTags("autofactory-flag-testing", {}), []);
    assert.deepEqual(missingRequiredTags("some-unknown-node", {}), []);
  });

  it("every declared required tag is a single non-empty routing key", () => {
    for (const [node, tags] of Object.entries(NODE_REQUIRED_TAGS)) {
      assert.ok(tags.length > 0, `${node} should declare at least one tag or be omitted`);
      for (const t of tags) assert.match(t, /^[a-z][a-z0-9_]+$/, `${node}: ${t}`);
    }
  });
});
