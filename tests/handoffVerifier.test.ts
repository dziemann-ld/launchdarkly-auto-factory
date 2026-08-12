import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { buildHandoffVerifier, filesContaining, isTestPath, type LdResourceWriter } from "@auto-factory/shared";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "verify-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const write = (rel: string, content: string): void => {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), content);
};

/** Writer stub whose getFlagState reports the given variations (or absence). */
function fakeWriter(flags: Record<string, string[]>): LdResourceWriter {
  return {
    projectKey: "app",
    async getFlagState(key: string) {
      const values = flags[key];
      if (!values) return { exists: false, key, kind: "multivariate", variations: [], environments: {} };
      return {
        exists: true,
        key,
        kind: "multivariate",
        variations: values.map((value) => ({ value })),
        environments: {},
      };
    },
  } as unknown as LdResourceWriter;
}

describe("handoff shims — flag claims", () => {
  it("passes when the flag exists in LD and key + variation are wired in code", async () => {
    write("src/feature.ts", `const v = flags.variation('enable-x', 'control');\nif (v === 'v2') { /* new */ }\n`);
    const verify = buildHandoffVerifier({ sandboxRoot: root, writer: fakeWriter({ "enable-x": ["control", "v1", "v2"] }) });
    const r = await verify({ configKey: "impl", tags: { flag_ready: "true", flag_key: "enable-x", flag_variation: "v2" } });
    assert.equal(r?.ok, true);
    assert.deepEqual(
      r?.passed.map((c) => c.name).sort(),
      ["flag-exists-in-ld", "flag-wired-in-code", "variation-exists-in-ld", "variation-wired-in-code"],
    );
  });

  it("fails when the flag key is referenced nowhere in the code", async () => {
    write("src/other.ts", "nothing to see\n");
    const verify = buildHandoffVerifier({ sandboxRoot: root, writer: fakeWriter({ "enable-x": ["control", "v1"] }) });
    const r = await verify({ configKey: "impl", tags: { flag_ready: "true", flag_key: "enable-x", flag_variation: "v1" } });
    assert.equal(r?.ok, false);
    assert.ok(r?.failures.some((c) => c.name === "flag-wired-in-code"));
  });

  it("fails the boolean-helper shape: key wired, vN never compared (the live PR #12 bug)", async () => {
    write("src/feature.ts", `const on = await flags.isEnabled('enable-x', false);\nif (!on) return;\n`);
    const verify = buildHandoffVerifier({ sandboxRoot: root, writer: fakeWriter({ "enable-x": ["control", "v1"] }) });
    const r = await verify({ configKey: "impl", tags: { flag_ready: "true", flag_key: "enable-x", flag_variation: "v1" } });
    assert.equal(r?.ok, false);
    const failure = r?.failures.find((c) => c.name === "variation-wired-in-code");
    assert.ok(failure);
    assert.match(failure.detail, /boolean helper/);
  });

  it("skips the variation check for boolean rides (flag_variation 'true')", async () => {
    write("orders/main.py", `REORDER_FLAG = "enable-old"\nif not flags.is_enabled(REORDER_FLAG):\n    pass\n`);
    const verify = buildHandoffVerifier({ sandboxRoot: root });
    const r = await verify({ configKey: "impl", tags: { flag_ready: "true", flag_key: "enable-old", flag_variation: "true" } });
    assert.equal(r?.ok, true);
    assert.ok(!r?.passed.some((c) => c.name === "variation-wired-in-code"));
  });

  it("fails when LD does not have the flag or the claimed variation", async () => {
    write("src/feature.ts", `flags.variation('enable-x', 'control') === 'v3'\n`);
    const verify = buildHandoffVerifier({ sandboxRoot: root, writer: fakeWriter({ "enable-x": ["control", "v1"] }) });
    const missingVar = await verify({ configKey: "impl", tags: { flag_ready: "true", flag_key: "enable-x", flag_variation: "v3" } });
    assert.equal(missingVar?.ok, false);
    assert.ok(missingVar?.failures.some((c) => c.name === "variation-exists-in-ld"));

    const verify2 = buildHandoffVerifier({ sandboxRoot: root, writer: fakeWriter({}) });
    const missingFlag = await verify2({ configKey: "impl", tags: { flag_ready: "true", flag_key: "enable-x", flag_variation: "v3" } });
    assert.ok(missingFlag?.failures.some((c) => c.name === "flag-exists-in-ld"));
  });

  it("without a writer, LD checks are skipped but code checks still run", async () => {
    write("src/feature.ts", `flags.variation('enable-x', 'control') === 'v1'\n`);
    const verify = buildHandoffVerifier({ sandboxRoot: root });
    const r = await verify({ configKey: "impl", tags: { flag_ready: "true", flag_key: "enable-x", flag_variation: "v1" } });
    assert.equal(r?.ok, true);
    assert.ok(!r?.passed.some((c) => c.name === "flag-exists-in-ld"));
    assert.ok(r?.passed.some((c) => c.name === "flag-wired-in-code"));
  });

  it("manifest references don't count as wiring (.release-flags is excluded)", async () => {
    write(".release-flags/pr-9.json", JSON.stringify({ flagKey: "enable-x" }));
    const verify = buildHandoffVerifier({ sandboxRoot: root });
    const r = await verify({ configKey: "impl", tags: { flag_ready: "true", flag_key: "enable-x" } });
    assert.equal(r?.ok, false);
    assert.ok(r?.failures.some((c) => c.name === "flag-wired-in-code"));
  });
});

describe("handoff shims — metric + test claims", () => {
  it("passes when every event-backed metric has an emitter; fails when one has none", async () => {
    write("src/api.ts", `flags.track('enable-x-error');\nflags.track('enable-x-latency', ms);\n`);
    const verify = buildHandoffVerifier({ sandboxRoot: root });
    const ok = await verify({ configKey: "metrics", tags: { metric_event_keys: "enable-x-error,enable-x-latency" } });
    assert.equal(ok?.ok, true);

    const bad = await verify({ configKey: "metrics", tags: { metric_event_keys: "enable-x-error,enable-x-success" } });
    assert.equal(bad?.ok, false);
    assert.match(bad?.failures[0]?.detail ?? "", /enable-x-success/);
  });

  it("skips track() emitter check for Sentry integration event keys", async () => {
    const verify = buildHandoffVerifier({ sandboxRoot: root });
    const r = await verify({ configKey: "metrics", tags: { metric_event_keys: "sentry-errors" } });
    assert.equal(r?.ok, true);
    assert.ok(r?.passed.some((c) => c.name === "metric-event-instrumented"));
  });

  it("requires launchdarklyContext when sentry_guardrail=true", async () => {
    const verify = buildHandoffVerifier({ sandboxRoot: root });
    const bad = await verify({ configKey: "metrics", tags: { sentry_guardrail: "true" } });
    assert.equal(bad?.ok, false);
    assert.ok(bad?.failures.some((c) => c.name === "sentry-launchdarkly-context"));

    write("app.py", `sentry_sdk.set_context("launchdarklyContext", {"key": "u"})\n`);
    const ok = await verify({ configKey: "metrics", tags: { sentry_guardrail: "true" } });
    assert.equal(ok?.ok, true);
  });

  it("tests_last_run=fail fails the handoff; pass passes; absent applies no check", async () => {
    const verify = buildHandoffVerifier({ sandboxRoot: root });
    const fail = await verify({ configKey: "testing", tags: { tests_last_run: "fail" } });
    assert.equal(fail?.ok, false);
    const pass = await verify({ configKey: "testing", tags: { tests_last_run: "pass" } });
    assert.equal(pass?.ok, true);
    const none = await verify({ configKey: "research", tags: { flag_worthy: "true" } });
    assert.equal(none, null); // no claims → no checks → no verification
  });
});

describe("filesContaining", () => {
  it("skips node_modules/dist/.release-flags and finds nested hits", () => {
    write("a/b/hit.txt", "needle here");
    write("node_modules/pkg/miss.txt", "needle");
    write("dist/miss.txt", "needle");
    write(".release-flags/pr-1.json", "needle");
    assert.deepEqual(filesContaining(root, "needle"), ["a/b/hit.txt"]);
  });
});

/**
 * Regression for the failure that slipped through as a SUCCESS: the flag-testing node
 * ended `completed` with empty tags, having described the tests it intended to write
 * ("I'll write flag-path tests that: 1… 2… 3…") without ever calling write_file. No
 * turn cap was hit, so the truncation halt didn't fire, and the run went green having
 * produced no tests at all.
 */
describe("handoff shims — the testing agent actually wrote tests", () => {
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

  /** A repo whose committed state includes the human's own test, but no agent work. */
  function repoWithHumanTest(): void {
    git(["init", "-q"]);
    git(["config", "user.email", "human@example.com"]);
    git(["config", "user.name", "A Human"]);
    // References the flag key so the unrelated flag-wiring shim passes and `ok`
    // reflects only the check under test here.
    write("src/app.ts", "const on = await boolVariation('enable-x', user);\n");
    write("src/human.test.ts", "it('human wrote this', () => {});\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "author's own work"]);
  }

  const verifyTesting = (tags: Record<string, string>) =>
    buildHandoffVerifier({ sandboxRoot: root })({ configKey: "autofactory-flag-testing", tags });

  it("FAILS when the node wrote nothing", async () => {
    repoWithHumanTest();
    const v = await verifyTesting({ flag_ready: "true", flag_key: "enable-x" });
    const failure = v?.failures.find((f) => f.name === "tests-authored");
    assert.ok(failure, "expected a tests-authored failure");
    assert.match(failure.detail, /produced NO test file/);
    assert.match(failure.detail, /Describing tests is not writing them/);
    assert.equal(v?.ok, false);
  });

  it("is NOT satisfied by a test the PR author wrote themselves", async () => {
    repoWithHumanTest();
    // src/human.test.ts is committed by the human and must not count.
    const v = await verifyTesting({ flag_ready: "true", flag_key: "enable-x" });
    assert.equal(v?.passed.some((c) => c.name === "tests-authored"), false);
  });

  it("passes on an uncommitted agent test file (propose mode)", async () => {
    repoWithHumanTest();
    write("src/agent.test.ts", "it('agent wrote this', () => {});\n");
    const v = await verifyTesting({ flag_ready: "true", flag_key: "enable-x" });
    const ok = v?.passed.find((c) => c.name === "tests-authored");
    assert.ok(ok, "expected tests-authored to pass");
    assert.match(ok.detail, /src\/agent\.test\.ts/);
    assert.equal(v?.ok, true);
  });

  it("passes on an agent-committed test file (commit mode)", async () => {
    repoWithHumanTest();
    write("src/agent.test.ts", "it('agent wrote this', () => {});\n");
    git(["config", "user.email", "autofactory@launchdarkly.com"]);
    git(["config", "user.name", "LaunchDarkly AutoFactory"]);
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "test(auto-factory): flag-path tests"]);
    const v = await verifyTesting({ flag_ready: "true", flag_key: "enable-x" });
    assert.ok(v?.passed.some((c) => c.name === "tests-authored"));
  });

  it("accepts an explicit tests_not_needed decline", async () => {
    repoWithHumanTest();
    const v = await verifyTesting({ flag_ready: "true", flag_key: "enable-x", tests_not_needed: "true" });
    const ok = v?.passed.find((c) => c.name === "tests-authored");
    assert.match(ok?.detail ?? "", /tests_not_needed/);
    assert.equal(v?.ok, true);
  });

  it("does not apply when no flag was ready — nothing to test", async () => {
    repoWithHumanTest();
    const v = await verifyTesting({});
    assert.equal(v, null);
  });

  it("does not apply to other nodes", async () => {
    repoWithHumanTest();
    const v = await buildHandoffVerifier({ sandboxRoot: root })({
      configKey: "autofactory-metrics-author",
      tags: { flag_ready: "true", flag_key: "enable-x" },
    });
    assert.equal(v?.failures.some((f) => f.name === "tests-authored"), false);
  });
});

describe("isTestPath", () => {
  it("recognizes the common conventions across languages", () => {
    for (const p of [
      "src/a.test.ts",
      "src/a.spec.tsx",
      "client/src/x.test.jsx",
      "server/test_thing.py",
      "pkg/thing_test.go",
      "src/FooTest.java",
      "tests/anything.ts",
      "src/__tests__/a.ts",
    ]) {
      assert.equal(isTestPath(p), true, `expected ${p} to look like a test`);
    }
  });

  it("does not mistake production files for tests", () => {
    for (const p of ["src/app.ts", "src/latest.ts", "src/contest.py", "docs/testing.md", ".release-flags/pr-1.json"]) {
      assert.equal(isTestPath(p), false, `expected ${p} NOT to look like a test`);
    }
  });
});
