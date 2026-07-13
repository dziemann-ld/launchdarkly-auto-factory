import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LdResourceWriter, type LdClient } from "@auto-factory/shared";

function fakeLd() {
  const bodies: Array<Record<string, unknown>> = [];
  const ld = {
    projectKey: "app-proj",
    createMetric: async (body: unknown) => {
      bodies.push(body as Record<string, unknown>);
      return { status: 201, ok: true, data: {} };
    },
  } as unknown as LdClient;
  return { ld, bodies };
}

describe("createMetric: trace-backed shape (verified against the live API)", () => {
  it("event-backed body is unchanged (kind=custom + eventKey)", async () => {
    const { ld, bodies } = fakeLd();
    await new LdResourceWriter(ld).createMetric({ key: "m-err", eventKey: "e-err", category: "error" });
    const b = bodies[0];
    assert.ok(b);
    assert.equal(b.kind, "custom");
    assert.equal(b.eventKey, "e-err");
    assert.equal(b.isNumeric, false);
    assert.equal(b.successCriteria, "LowerThanBaseline");
    assert.ok(!("traceQuery" in b));
  });

  it("trace-backed occurrence: kind=trace + traceQuery + launchdarkly-hosted source, no eventKey", async () => {
    const { ld, bodies } = fakeLd();
    const r = await new LdResourceWriter(ld).createMetric({
      key: "m-biz", category: "business", traceQuery: "service_name=togglemart-gateway",
    });
    const b = bodies[0];
    assert.ok(b);
    assert.equal(b.kind, "trace");
    assert.equal(b.traceQuery, "service_name=togglemart-gateway");
    assert.deepEqual(b.dataSource, { key: "launchdarkly-hosted" });
    assert.equal(b.successCriteria, "HigherThanBaseline");
    assert.equal(b.unitAggregationType, "sum");
    assert.ok(!("eventKey" in b));
    assert.ok(!("traceValueLocation" in b));
    assert.match(r.detail, /TRACE metric/);
  });

  it("trace-backed latency: numeric + traceValueLocation default 'duration'", async () => {
    const { ld, bodies } = fakeLd();
    await new LdResourceWriter(ld).createMetric({
      key: "m-lat", category: "latency", traceQuery: "span_name=\"GET /api/storefront\"",
    });
    const b = bodies[0];
    assert.ok(b);
    assert.equal(b.isNumeric, true);
    assert.equal(b.traceValueLocation, "duration");
    assert.equal(b.unit, "ms");
    assert.equal(b.successCriteria, "LowerThanBaseline");
  });

  it("requires eventKey OR traceQuery", async () => {
    const { ld } = fakeLd();
    await assert.rejects(
      () => new LdResourceWriter(ld).createMetric({ key: "m", category: "error" }),
      /eventKey is required/,
    );
  });
});
