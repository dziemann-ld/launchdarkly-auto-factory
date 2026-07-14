import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";

import {
  RelatedReposClient,
  SandboxToolExecutor,
  buildSandboxTools,
  loadRelatedRepos,
  parseRelatedRepos,
} from "@auto-factory/shared";

const REGISTRY = `
services:
  togglemart-gateway:
    side: backend
    dir: gateway
relatedRepos:
  mobile-app:
    repo: acme/togglemart-mobile
    relationship: downstream
    description: React Native app consuming the gateway API
  platform-lib:
    repo: acme/platform-lib
    relationship: upstream
  bad-entry:
    relationship: downstream
  bad-repo-shape:
    repo: not-a-repo
`;

describe("relatedRepos: registry parsing", () => {
  it("parses valid entries and drops malformed ones", () => {
    const repos = parseRelatedRepos(REGISTRY);
    assert.equal(repos.length, 2);
    const mobile = repos.find((r) => r.key === "mobile-app");
    assert.equal(mobile?.repo, "acme/togglemart-mobile");
    assert.equal(mobile?.relationship, "downstream");
    assert.match(mobile?.description ?? "", /React Native/);
    const lib = repos.find((r) => r.key === "platform-lib");
    assert.equal(lib?.relationship, "upstream");
    assert.equal(lib?.description, undefined);
  });

  it("returns [] for missing section, empty, or unparseable YAML", () => {
    assert.deepEqual(parseRelatedRepos("services: {}"), []);
    assert.deepEqual(parseRelatedRepos(""), []);
    assert.deepEqual(parseRelatedRepos("::: not yaml {"), []);
  });

  it("loadRelatedRepos reads the checkout registry, [] when absent", () => {
    const root = mkdtempSync(join(tmpdir(), "af-related-"));
    try {
      assert.deepEqual(loadRelatedRepos(root), []);
      mkdirSync(join(root, ".autofactory"), { recursive: true });
      writeFileSync(join(root, ".autofactory", "services.yaml"), REGISTRY);
      assert.equal(loadRelatedRepos(root).length, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("relatedRepos: client", () => {
  const repos = parseRelatedRepos(REGISTRY);
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubFetch(handler: (url: string) => { status: number; body: unknown }) {
    globalThis.fetch = (async (input: string | URL) => {
      const { status, body } = handler(String(input));
      return new Response(JSON.stringify(body), { status });
    }) as typeof fetch;
  }

  it("resolves registry keys and owner/name; rejects unregistered repos", async () => {
    const client = new RelatedReposClient(repos, "tok");
    assert.equal(client.resolve("mobile-app")?.repo, "acme/togglemart-mobile");
    assert.equal(client.resolve("ACME/togglemart-mobile")?.key, "mobile-app");
    assert.equal(client.resolve("acme/other"), undefined);
    await assert.rejects(() => client.readFile("acme/other", "x"), /not a registered related repo/);
  });

  it("list() formats the registry with relationships", () => {
    const client = new RelatedReposClient(repos, "tok");
    const out = client.list();
    assert.match(out, /mobile-app \(acme\/togglemart-mobile\) \[downstream\]/);
    assert.match(out, /platform-lib/);
  });

  it("searchCode returns fragments, and a weak-evidence note on zero hits", async () => {
    stubFetch((url) => {
      assert.match(url, /\/search\/code\?q=/);
      return {
        status: 200,
        body: {
          total_count: 1,
          items: [{ path: "src/api/orders.ts", text_matches: [{ fragment: "fetch('/api/orders/cancel')" }] }],
        },
      };
    });
    const client = new RelatedReposClient(repos, "tok");
    const hit = await client.searchCode("mobile-app", "/api/orders/cancel");
    assert.match(hit, /acme\/togglemart-mobile:src\/api\/orders\.ts/);
    assert.match(hit, /orders\/cancel/);

    stubFetch(() => ({ status: 200, body: { total_count: 0, items: [] } }));
    const miss = await client.searchCode("mobile-app", "nope");
    assert.match(miss, /weak evidence/);
  });

  it("readFile decodes base64 contents; listDir lists entries", async () => {
    stubFetch(() => ({
      status: 200,
      body: { type: "file", encoding: "base64", content: Buffer.from("hello cross repo").toString("base64") },
    }));
    const client = new RelatedReposClient(repos, "tok");
    assert.equal(await client.readFile("mobile-app", "README.md"), "hello cross repo");

    stubFetch(() => ({
      status: 200,
      body: [
        { name: "src", type: "dir" },
        { name: "package.json", type: "file" },
      ],
    }));
    const dir = await client.listDir("mobile-app", "");
    assert.match(dir, /d src/);
    assert.match(dir, /f package\.json/);
  });

  it("auth failures explain the token constraint; 404 stays actionable", async () => {
    stubFetch(() => ({ status: 403, body: {} }));
    const client = new RelatedReposClient(repos, "tok");
    await assert.rejects(() => client.readFile("mobile-app", "x"), /AUTOFACTORY_REPOS_TOKEN|rate limit/);
    stubFetch(() => ({ status: 404, body: {} }));
    await assert.rejects(() => client.listDir("mobile-app", "gone"), /not found \(404\)/);
  });

  it("rejects path traversal", async () => {
    const client = new RelatedReposClient(repos, "tok");
    await assert.rejects(() => client.readFile("mobile-app", "../secrets"), /invalid path/);
  });
});

describe("relatedRepos: query_related_repos tool", () => {
  const root = mkdtempSync(join(tmpdir(), "af-related-tool-"));
  after(() => rmSync(root, { recursive: true, force: true }));

  it("is offered only under the queryRepos capability", () => {
    const withoutCap = buildSandboxTools({ createFlag: false, createMetric: false, editFiles: false });
    assert.ok(!withoutCap.some((t) => t.name === "query_related_repos"));
    const withCap = buildSandboxTools({ createFlag: false, createMetric: false, editFiles: false, queryRepos: true });
    assert.ok(withCap.some((t) => t.name === "query_related_repos"));
  });

  it("degrades with guidance when no registry was provided", async () => {
    const executor = new SandboxToolExecutor(root);
    const res = await executor.execute("query_related_repos", { op: "list" });
    assert.equal(res.isError, true);
    assert.match(res.content, /no related repositories are registered/);
  });

  it("op=list is free; unknown op errors; per-run fetch budget is enforced", async () => {
    const executor = new SandboxToolExecutor(root);
    executor.provideRelatedRepos(new RelatedReposClient(parseRelatedRepos(REGISTRY), "tok"));
    const list = await executor.execute("query_related_repos", { op: "list" });
    assert.equal(list.isError, undefined);
    assert.match(list.content, /mobile-app/);

    const bad = await executor.execute("query_related_repos", { op: "explode" });
    assert.equal(bad.isError, true);

    const missingQuery = await executor.execute("query_related_repos", { op: "search", repo: "mobile-app" });
    assert.equal(missingQuery.isError, true);
    assert.match(missingQuery.content, /'query' is required/);
  });
});
