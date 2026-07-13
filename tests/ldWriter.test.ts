import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { LdResourceWriter, type LdClient } from "@auto-factory/shared";

/** Fake LdClient capturing the createFlag/createMetric body, returning a scripted status. */
function fakeClient(status: number) {
  let lastBody: Record<string, unknown> | undefined;
  let lastPatch: { instructions: unknown[] } | undefined;
  const capture = async (body: unknown) => {
    lastBody = body as Record<string, unknown>;
    return { status, data: {} };
  };
  const client = {
    projectKey: "demo",
    createFlag: capture,
    createMetric: capture,
    patchFlagProjectSemantic: async (_key: string, instructions: unknown[]) => {
      lastPatch = { instructions };
      return { status: 200, data: {} };
    },
  } as unknown as LdClient;
  return { client, body: () => lastBody, patch: () => lastPatch };
}

describe("LdResourceWriter.createBooleanFlag", () => {
  it("throws when key is missing", async () => {
    const { client } = fakeClient(201);
    const writer = new LdResourceWriter(client);
    await assert.rejects(() => writer.createBooleanFlag({ key: "" }), /flag key is required/);
  });

  it("reports created on a success status", async () => {
    const { client } = fakeClient(201);
    const r = await new LdResourceWriter(client).createBooleanFlag({ key: "enable-x" });
    assert.equal(r.created, true);
    assert.equal(r.alreadyExists, false);
    assert.equal(r.key, "enable-x");
    assert.match(r.detail, /Created flag 'enable-x'/);
  });

  it("reports alreadyExists on 409 (idempotent re-run)", async () => {
    const { client } = fakeClient(409);
    const r = await new LdResourceWriter(client).createBooleanFlag({ key: "enable-x" });
    assert.equal(r.created, false);
    assert.equal(r.alreadyExists, true);
    assert.match(r.detail, /already exists/);
  });

  it("merges + dedupes the standard auto-factory tags with caller tags", async () => {
    const { client, body } = fakeClient(201);
    await new LdResourceWriter(client).createBooleanFlag({ key: "k", tags: ["auto-factory", "custom"] });
    const tags = body()?.tags as string[];
    assert.deepEqual([...tags].sort(), ["auto-factory", "auto-generated", "custom"]);
  });

  it("sets the safe-default variation shape (on=treatment, off=control)", async () => {
    const { client, body } = fakeClient(201);
    await new LdResourceWriter(client).createBooleanFlag({ key: "k" });
    const b = body();
    assert.equal(b?.temporary, true);
    assert.deepEqual(b?.defaults, { onVariation: 0, offVariation: 1 });
  });

  it("frontend scope enables client-side SDK availability on create", async () => {
    const { client, body } = fakeClient(201);
    await new LdResourceWriter(client).createBooleanFlag({ key: "k", scope: "frontend" });
    assert.deepEqual(body()?.clientSideAvailability, {
      usingEnvironmentId: true,
      usingMobileKey: false,
    });
  });

  it("backend scope does not expose the flag to the client-side SDK", async () => {
    const { client, body, patch } = fakeClient(201);
    await new LdResourceWriter(client).createBooleanFlag({ key: "k", scope: "backend" });
    assert.equal(body()?.clientSideAvailability, undefined);
    assert.equal(patch(), undefined);
  });

  it("on 409 with frontend scope, patches client-side availability for an existing flag", async () => {
    const { client, patch } = fakeClient(409);
    await new LdResourceWriter(client).createBooleanFlag({ key: "k", scope: "frontend" });
    assert.deepEqual(patch()?.instructions, [
      { kind: "turnOnClientSideAvailability", value: "usingEnvironmentId" },
    ]);
  });
});

describe("LdResourceWriter.createMetric", () => {
  it("throws when key or eventKey is missing", async () => {
    const { client } = fakeClient(201);
    const w = new LdResourceWriter(client);
    await assert.rejects(() => w.createMetric({ key: "", eventKey: "e", category: "error" }), /metric key is required/);
    await assert.rejects(() => w.createMetric({ key: "k", eventKey: "", category: "error" }), /eventKey is required/);
  });

  it("error category → occurrence, LowerThanBaseline, default user unit", async () => {
    const { client, body } = fakeClient(201);
    await new LdResourceWriter(client).createMetric({ key: "k-error-rate", eventKey: "k-error", category: "error" });
    const b = body();
    assert.equal(b?.kind, "custom");
    assert.equal(b?.eventKey, "k-error");
    assert.equal(b?.isNumeric, false);
    assert.equal(b?.successCriteria, "LowerThanBaseline");
    assert.deepEqual(b?.randomizationUnits, ["user"]);
    assert.equal(b?.unit, undefined); // occurrence metrics carry no numeric unit
  });

  it("latency category → numeric with unit + aggregation", async () => {
    const { client, body } = fakeClient(201);
    await new LdResourceWriter(client).createMetric({ key: "k-latency", eventKey: "k-latency", category: "latency" });
    const b = body();
    assert.equal(b?.isNumeric, true);
    assert.equal(b?.unit, "ms");
    assert.equal(b?.unitAggregationType, "average");
    assert.equal(b?.successCriteria, "LowerThanBaseline");
  });

  it("business category → HigherThanBaseline occurrence", async () => {
    const { client, body } = fakeClient(201);
    await new LdResourceWriter(client).createMetric({ key: "k-success", eventKey: "k-success", category: "business" });
    const b = body();
    assert.equal(b?.isNumeric, false);
    assert.equal(b?.successCriteria, "HigherThanBaseline");
  });

  it("honors a custom randomization unit and merges standard tags", async () => {
    const { client, body } = fakeClient(201);
    await new LdResourceWriter(client).createMetric({
      key: "k",
      eventKey: "e",
      category: "error",
      randomizationUnit: "account",
      // LaunchDarkly tags cannot contain ":" — the flag-reference convention is flag-<key>
      tags: ["flag-enable-x"],
    });
    const b = body();
    assert.deepEqual(b?.randomizationUnits, ["account"]);
    assert.deepEqual([...(b?.tags as string[])].sort(), ["auto-factory", "auto-generated", "flag-enable-x"]);
  });

  it("reports alreadyExists on 409", async () => {
    const { client } = fakeClient(409);
    const r = await new LdResourceWriter(client).createMetric({ key: "k", eventKey: "e", category: "error" });
    assert.equal(r.created, false);
    assert.equal(r.alreadyExists, true);
    assert.match(r.detail, /already exists/);
  });
});
