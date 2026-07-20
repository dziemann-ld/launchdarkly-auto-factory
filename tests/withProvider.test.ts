import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { pipelineContext, withProvider } from "@auto-factory/shared";

type MultiCtx = { kind: string; run?: { key?: string; provider?: string }; service?: Record<string, unknown> };

describe("withProvider", () => {
  it("stamps the provider on the run kind without changing the run key", () => {
    const ctx = pipelineContext() as MultiCtx;
    const stamped = withProvider(ctx as never, "cursor") as MultiCtx;
    assert.equal(stamped.run?.provider, "cursor");
    assert.equal(stamped.run?.key, ctx.run?.key); // bucketing unchanged
    assert.deepEqual(stamped.service, ctx.service);
    assert.equal((ctx.run as { provider?: string }).provider, undefined); // original untouched
  });

  it("passes non-multi / run-less contexts through unchanged", () => {
    const single = { kind: "service", key: "x" };
    assert.equal(withProvider(single as never, "anthropic"), single);
    const noRun = { kind: "multi", service: { key: "x" } };
    assert.equal(withProvider(noRun as never, "anthropic"), noRun);
  });
});
