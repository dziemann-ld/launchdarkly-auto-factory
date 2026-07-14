import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import {
  assembleKnowledgeGraph,
  changedFilesInCheckout,
  fetchRecentSpans,
  parseServicesRegistry,
  toSpanRecord,
} from "@auto-factory/shared";

const REGISTRY = `
# ToggleMart-shaped registry
services:
  togglemart-gateway:
    side: backend
    dir: gateway
    hosts: [gateway]
    statusUrl: https://gateway-production.up.railway.app/api/status
  togglemart-orders:
    side: backend
    dir: orders
`;

describe("knowledge graph: assembly", () => {
  it("parses the services registry, folding the statusUrl host into hosts", () => {
    const services = parseServicesRegistry(REGISTRY);
    assert.equal(services.length, 2);
    const gw = services.find((s) => s.key === "togglemart-gateway");
    assert.equal(gw?.dir, "gateway");
    assert.deepEqual(gw?.hosts, ["gateway", "gateway-production.up.railway.app"]);
    const orders = services.find((s) => s.key === "togglemart-orders");
    assert.equal(orders?.hosts, undefined);
  });

  it("maps raw trace nodes to span records", () => {
    const span = toSpanRecord({
      serviceName: "togglemart-gateway",
      spanKind: "Client",
      traceAttributes: { server: { address: "catalog" } },
    });
    assert.equal(span.serviceName, "togglemart-gateway");
    assert.equal(span.traceAttributes?.server?.address, "catalog");
  });

  it("fetchRecentSpans NEVER throws — bad endpoint degrades to a warning", async () => {
    const r = await fetchRecentSpans({
      apiKey: "api-nope",
      projectKey: "nope",
      url: "http://127.0.0.1:9/unreachable",
      windowHours: 1,
      retryDelaysMs: [],
    });
    assert.deepEqual(r.spans, []);
    assert.match(r.warning ?? "", /trace query failed after 1 attempt /);
  });

  it("fetchRecentSpans retries failed attempts before degrading", async () => {
    const r = await fetchRecentSpans({
      apiKey: "api-nope",
      projectKey: "nope",
      url: "http://127.0.0.1:9/unreachable",
      windowHours: 1,
      retryDelaysMs: [1, 1],
    });
    assert.deepEqual(r.spans, []);
    assert.match(r.warning ?? "", /trace query failed after 3 attempts /);
  });

  describe("against a scratch git checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "af-kg-assemble-"));
    after(() => rmSync(root, { recursive: true, force: true }));

    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    mkdirSync(join(root, "gateway", "src"), { recursive: true });
    writeFileSync(join(root, "gateway", "src", "app.ts"), "export {}\n");
    git("add", "-A");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "pr-branch");
    writeFileSync(join(root, "gateway", "src", "storefront.ts"), "export {}\n");
    git("add", "-A");
    git("commit", "-qm", "change");

    it("changedFilesInCheckout diffs base...HEAD", () => {
      assert.deepEqual(changedFilesInCheckout(root, "main"), ["gateway/src/storefront.ts"]);
    });

    it("assembles with every source missing: graph + gaps + warnings, no throw", async () => {
      // no services.yaml, no o11y opts, no codeRefs opts — the fully-degraded path
      const r = await assembleKnowledgeGraph({ sandboxRoot: root, prBaseRef: "main", sha: "headsha" });
      assert.equal(r.graph.schema, 1);
      assert.equal(r.graph.sha, "headsha");
      assert.deepEqual(r.graph.services, []);
      assert.ok(r.warnings.some((w) => w.includes(".autofactory/services.yaml")));
      assert.ok(r.graph.gaps.some((g) => g.startsWith("traces:")));
      assert.ok(r.graph.gaps.some((g) => g.startsWith("code_refs:")));
      assert.deepEqual(r.changedFiles, ["gateway/src/storefront.ts"]);
    });

    it("uses a committed registry and skips span fetch gracefully when o11y is unreachable", async () => {
      mkdirSync(join(root, ".autofactory"), { recursive: true });
      writeFileSync(join(root, ".autofactory", "services.yaml"), REGISTRY);
      process.env.LD_O11Y_MCP_URL = "http://127.0.0.1:9/unreachable";
      try {
        const r = await assembleKnowledgeGraph({
          sandboxRoot: root,
          prBaseRef: "main",
          o11y: { apiKey: "api-nope", projectKey: "nope", windowHours: 1, retryDelaysMs: [] },
        });
        assert.equal(r.graph.services.length, 2);
        assert.ok(r.warnings.some((w) => w.includes("trace query failed")));
        // file→service attribution still works without spans
        assert.ok(r.graph.nodes.some((n) => n.id === "service:togglemart-gateway"));
      } finally {
        delete process.env.LD_O11Y_MCP_URL;
      }
    });
  });
});
