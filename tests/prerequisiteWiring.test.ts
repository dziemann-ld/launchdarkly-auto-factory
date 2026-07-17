import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { LdResourceWriter, SandboxToolExecutor, type LdClient } from "@auto-factory/shared";

interface Patch {
  flagKey: string;
  env: string;
  instructions: Array<Record<string, unknown>>;
}

function fakeLd(opts: {
  parentExists?: boolean;
  childEnvs?: Record<string, { on?: boolean; prerequisites?: Array<{ key: string }> }>;
} = {}) {
  const patches: Patch[] = [];
  const childEnvs = opts.childEnvs ?? { production: {}, test: {} };
  const ld = {
    projectKey: "app-proj",
    getFlag: async (flagKey: string) => {
      if (flagKey === "parent-flag") {
        if (opts.parentExists === false) throw new Error("404");
        return {
          status: 200,
          ok: true,
          data: {
            variations: [
              { _id: "pv-true", value: true },
              { _id: "pv-false", value: false },
            ],
          },
        };
      }
      return {
        status: 200,
        ok: true,
        data: {
          variations: [
            { _id: "cv-true", value: true },
            { _id: "cv-false", value: false },
          ],
          environments: childEnvs,
        },
      };
    },
    patchFlagSemantic: async (flagKey: string, env: string, instructions: Array<Record<string, unknown>>) => {
      patches.push({ flagKey, env, instructions });
      return { status: 200, ok: true, data: {} };
    },
  } as unknown as LdClient;
  return { ld, patches };
}

describe("addPrerequisite: on-behind-parent wiring", () => {
  it("attaches the prerequisite AND turns the child on serving treatment, per environment", async () => {
    const { ld, patches } = fakeLd();
    const note = await new LdResourceWriter(ld).addPrerequisite("child-flag", "parent-flag", "on");
    assert.equal(patches.length, 2);
    for (const p of patches) {
      assert.deepEqual(
        p.instructions.map((i) => i.kind),
        ["addPrerequisite", "turnFlagOn", "updateFallthroughVariationOrRollout"],
      );
      assert.equal(p.instructions[0]?.key, "parent-flag");
      assert.equal(p.instructions[0]?.variationId, "pv-true");
      assert.equal(p.instructions[2]?.variationId, "cv-true");
    }
    assert.match(note, /ON serving treatment behind 'parent-flag'=on/);
  });

  it("variation 'off' resolves the parent's false variation", async () => {
    const { ld, patches } = fakeLd();
    await new LdResourceWriter(ld).addPrerequisite("child-flag", "parent-flag", "off");
    assert.equal(patches[0]?.instructions[0]?.variationId, "pv-false");
  });

  it("is idempotent: fully-wired environments are skipped; partial ones are completed", async () => {
    const { ld, patches } = fakeLd({
      childEnvs: {
        production: { on: true, prerequisites: [{ key: "parent-flag" }] }, // fully wired
        test: { on: false, prerequisites: [{ key: "parent-flag" }] }, // prereq only
      },
    });
    await new LdResourceWriter(ld).addPrerequisite("child-flag", "parent-flag");
    assert.equal(patches.length, 1);
    assert.equal(patches[0]?.env, "test");
    assert.deepEqual(
      patches[0]?.instructions.map((i) => i.kind),
      ["turnFlagOn", "updateFallthroughVariationOrRollout"],
    );
  });

  it("throws a clean message when the parent flag is missing from the app project", async () => {
    const { ld } = fakeLd({ parentExists: false });
    await assert.rejects(
      () => new LdResourceWriter(ld).addPrerequisite("child-flag", "parent-flag"),
      /parent flag 'parent-flag' not found in project 'app-proj'/,
    );
  });

  it("a MET prerequisite (parent already released) attaches WITHOUT arming — the child stays dark", async () => {
    // Iterating on a released feature: arming would put the child live the
    // moment its code deploys, re-coupling deploy with release.
    const patches: Patch[] = [];
    const ld = {
      projectKey: "app-proj",
      getFlag: async (flagKey: string) => {
        if (flagKey === "parent-flag") {
          return {
            status: 200,
            ok: true,
            data: {
              variations: [
                { _id: "pv-true", value: true },
                { _id: "pv-false", value: false },
              ],
              environments: {
                production: { on: true, fallthrough: { variation: 0 }, offVariation: 1 }, // serving true
                test: { on: false, offVariation: 1 }, // dark here
              },
            },
          };
        }
        return {
          status: 200,
          ok: true,
          data: {
            variations: [
              { _id: "cv-true", value: true },
              { _id: "cv-false", value: false },
            ],
            environments: { production: {}, test: {} },
          },
        };
      },
      patchFlagSemantic: async (flagKey: string, env: string, instructions: Array<Record<string, unknown>>) => {
        patches.push({ flagKey, env, instructions });
        return { status: 200, ok: true, data: {} };
      },
    } as unknown as LdClient;

    const note = await new LdResourceWriter(ld).addPrerequisite("child-flag", "parent-flag", "on");
    const byEnv = Object.fromEntries(patches.map((p) => [p.env, p.instructions.map((i) => i.kind)]));
    // production: prereq met → attach only, NO turnFlagOn.
    assert.deepEqual(byEnv.production, ["addPrerequisite"]);
    // test: parent dark → unmet → full on-behind-parent arming.
    assert.deepEqual(byEnv.test, ["addPrerequisite", "turnFlagOn", "updateFallthroughVariationOrRollout"]);
    assert.match(note, /stays DARK/);
    assert.match(note, /armed in test/);
  });
});

describe("addPrerequisite: multivariate parents and children", () => {
  /** Multivariate parent (control/v1/v2) + multivariate child (control/v1). */
  function fakeMultivariateLd(parentEnvs: Record<string, unknown>) {
    const patches: Patch[] = [];
    const ld = {
      projectKey: "app-proj",
      getFlag: async (flagKey: string) => {
        if (flagKey === "parent-flag") {
          return {
            status: 200,
            ok: true,
            data: {
              variations: [
                { _id: "pv-control", value: "control" },
                { _id: "pv-v1", value: "v1" },
                { _id: "pv-v2", value: "v2" },
              ],
              defaults: { onVariation: 1, offVariation: 0 },
              environments: parentEnvs,
            },
          };
        }
        return {
          status: 200,
          ok: true,
          data: {
            variations: [
              { _id: "cv-control", value: "control" },
              { _id: "cv-v1", value: "v1" },
            ],
            environments: { production: {}, test: {} },
          },
        };
      },
      patchFlagSemantic: async (flagKey: string, env: string, instructions: Array<Record<string, unknown>>) => {
        patches.push({ flagKey, env, instructions });
        return { status: 200, ok: true, data: {} };
      },
    } as unknown as LdClient;
    return { ld, patches };
  }

  it("'on' pins what each environment's fallthrough serves (per-env resolution)", async () => {
    const { ld, patches } = fakeMultivariateLd({
      production: { fallthrough: { variation: 1 } }, // serves v1
      test: { fallthrough: { variation: 2 } }, // serves v2
    });
    await new LdResourceWriter(ld).addPrerequisite("child-flag", "parent-flag", "on");
    const byEnv = Object.fromEntries(patches.map((p) => [p.env, p.instructions[0]]));
    assert.equal(byEnv.production?.variationId, "pv-v1");
    assert.equal(byEnv.test?.variationId, "pv-v2");
    // Child fallthrough points at its multivariate treatment (lineage tip v1).
    assert.equal(patches[0]?.instructions[2]?.variationId, "cv-v1");
  });

  it("an explicit parent variation value ('v2') pins exactly that in every env", async () => {
    const { ld, patches } = fakeMultivariateLd({
      production: { fallthrough: { variation: 1 } },
      test: { fallthrough: { variation: 1 } },
    });
    await new LdResourceWriter(ld).addPrerequisite("child-flag", "parent-flag", "v2");
    for (const p of patches) assert.equal(p.instructions[0]?.variationId, "pv-v2");
  });

  it("'on' falls back to the heaviest rollout arm, then the default on-variation", async () => {
    const { ld, patches } = fakeMultivariateLd({
      production: { fallthrough: { rollout: { variations: [{ variation: 1, weight: 30000 }, { variation: 2, weight: 70000 }] } } },
      test: {}, // no fallthrough at all → defaults.onVariation (v1)
    });
    await new LdResourceWriter(ld).addPrerequisite("child-flag", "parent-flag", "on");
    const byEnv = Object.fromEntries(patches.map((p) => [p.env, p.instructions[0]]));
    assert.equal(byEnv.production?.variationId, "pv-v2");
    assert.equal(byEnv.test?.variationId, "pv-v1");
  });

  it("an explicit childVariation selects which child variation goes live behind the parent", async () => {
    const { ld, patches } = fakeMultivariateLd({
      production: { fallthrough: { variation: 1 } },
      test: { fallthrough: { variation: 1 } },
    });
    await new LdResourceWriter(ld).addPrerequisite("child-flag", "parent-flag", "on", "control");
    for (const p of patches) assert.equal(p.instructions[2]?.variationId, "cv-control");
  });

  it("throws when a multivariate parent lacks the requested explicit variation", async () => {
    const { ld } = fakeMultivariateLd({ production: { fallthrough: { variation: 1 } } });
    await assert.rejects(
      () => new LdResourceWriter(ld).addPrerequisite("child-flag", "parent-flag", "v9"),
      /could not be applied/,
    );
  });
});

describe("write_manifest: releasePlan.prerequisites is a machine field", () => {
  const root = mkdtempSync(join(tmpdir(), "af-manifest-prereq-"));
  after(() => rmSync(root, { recursive: true, force: true }));
  const executor = () =>
    new SandboxToolExecutor(root, undefined, false, undefined, undefined, "workingTree", true);

  it("accepts real flag keys with on/off variations", async () => {
    const r = await executor().execute("write_manifest", {
      path: ".release-flags/pr-1.json",
      manifest: {
        flagKey: "child-flag",
        releasePlan: { prerequisites: [{ flagKey: "enable-payment-intents", variation: "on" }] },
      },
    });
    assert.notEqual(r.isError, true, r.content);
  });

  it("rejects prose stuffed into flagKey (live failure mode, PR #11)", async () => {
    const r = await executor().execute("write_manifest", {
      path: ".release-flags/pr-2.json",
      manifest: {
        releasePlan: {
          prerequisites: [
            { flagKey: "ADVISORY: togglemart-payments intents-api gate (key unknown)", variation: "on" },
          ],
        },
      },
    });
    assert.equal(r.isError, true);
    assert.match(r.content, /machine field/);
  });

  it("rejects invalid variations and non-object entries", async () => {
    const bad = await executor().execute("write_manifest", {
      path: ".release-flags/pr-3.json",
      manifest: { releasePlan: { prerequisites: [{ flagKey: "ok-key", variation: "maybe" }] } },
    });
    assert.equal(bad.isError, true);
    const alsoBad = await executor().execute("write_manifest", {
      path: ".release-flags/pr-4.json",
      manifest: { releasePlan: { prerequisites: ["enable-x"] } },
    });
    assert.equal(alsoBad.isError, true);
  });
});
