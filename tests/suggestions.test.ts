import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  commentableLines,
  parseUnifiedDiff,
  planSuggestions,
} from "../packages/phase1-resource-factory/src/suggestions.js";

/**
 * Suggestions are the "Apply button" path. The properties that matter: line numbers
 * must be exactly right (a wrong anchor silently rewrites the wrong code), and
 * anything that cannot be a suggestion must appear in `deferred` rather than
 * disappearing.
 */
describe("parseUnifiedDiff", () => {
  it("reads paths, new-file status, and hunk offsets", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -10,3 +10,4 @@ function f() {",
      " keep",
      "-old",
      "+new",
      "+extra",
      "diff --git a/src/new.ts b/src/new.ts",
      "new file mode 100644",
      "--- /dev/null",
      "+++ b/src/new.ts",
      "@@ -0,0 +1,2 @@",
      "+one",
      "+two",
    ].join("\n");
    const files = parseUnifiedDiff(diff);
    assert.deepEqual(
      files.map((f) => [f.path, f.isNew]),
      [
        ["src/a.ts", false],
        ["src/new.ts", true],
      ],
    );
    assert.equal(files[0]?.hunks[0]?.oldStart, 10);
    assert.deepEqual(files[0]?.hunks[0]?.lines, [" keep", "-old", "+new", "+extra"]);
  });

  it("ignores a header with no hunks rather than throwing", () => {
    assert.deepEqual(parseUnifiedDiff("diff --git a/x b/x\nindex 1..2 100644\n"), [
      { path: "x", isNew: false, isDelete: false, hunks: [] },
    ]);
  });
});

describe("commentableLines", () => {
  it("collects RIGHT-side line numbers from the PR's own patch", () => {
    // Added and context lines advance the new-side counter; removals do not.
    const patch = ["@@ -5,2 +5,3 @@", " ctx5", "-gone", "+added6", "+added7"].join("\n");
    const map = commentableLines([{ filename: "a.ts", patch }]);
    assert.deepEqual([...(map.get("a.ts") ?? [])].sort((x, y) => x - y), [5, 6, 7]);
  });

  it("yields an empty set for a file GitHub gives no patch for", () => {
    const map = commentableLines([{ filename: "big.json" }]);
    assert.equal(map.get("big.json")?.size, 0);
  });
});

describe("planSuggestions", () => {
  const diffReplacing = (path: string) =>
    parseUnifiedDiff(
      [
        `diff --git a/${path} b/${path}`,
        "--- a/" + path,
        "+++ b/" + path,
        "@@ -20,3 +20,3 @@",
        " context20",
        "-const on = isEnabled(k);",
        "+const on = await boolVariation(k, user);",
      ].join("\n"),
    );

  it("maps a replacement onto the exact line it replaces", () => {
    const commentable = new Map([["s.ts", new Set([20, 21, 22])]]);
    const plan = planSuggestions(diffReplacing("s.ts"), commentable);
    assert.equal(plan.deferred.length, 0);
    assert.equal(plan.comments.length, 1);
    const c = plan.comments[0];
    // The removed line is old-side 21 (20 was context).
    assert.equal(c?.line, 21);
    assert.equal(c?.start_line, undefined, "single-line replacement omits start_line");
    assert.equal(c?.side, "RIGHT");
    assert.match(c?.body ?? "", /```suggestion\nconst on = await boolVariation\(k, user\);\n```/);
  });

  it("uses start_line..line for a multi-line replacement", () => {
    const files = parseUnifiedDiff(
      ["diff --git a/s.ts b/s.ts", "@@ -8,4 +8,3 @@", " ctx", "-a", "-b", "+merged"].join("\n"),
    );
    const plan = planSuggestions(files, new Map([["s.ts", new Set([8, 9, 10, 11])]]));
    assert.equal(plan.comments[0]?.start_line, 9);
    assert.equal(plan.comments[0]?.line, 10);
  });

  it("anchors a pure insertion on the preceding line and re-emits it", () => {
    const files = parseUnifiedDiff(
      ["diff --git a/s.ts b/s.ts", "@@ -30,2 +30,3 @@", " const x = 1;", "+track('e', ctx);"].join("\n"),
    );
    const plan = planSuggestions(files, new Map([["s.ts", new Set([30, 31])]]));
    const c = plan.comments[0];
    assert.equal(c?.line, 30, "anchors on the context line, not the inserted one");
    // The anchor must be re-emitted or applying would delete it.
    assert.match(c?.body ?? "", /```suggestion\nconst x = 1;\ntrack\('e', ctx\);\n```/);
  });

  it("defers new files — a suggestion cannot create one", () => {
    const files = parseUnifiedDiff(
      ["diff --git a/t.test.ts b/t.test.ts", "new file mode 100644", "@@ -0,0 +1,1 @@", "+it('works', () => {});"].join("\n"),
    );
    const plan = planSuggestions(files, new Map());
    assert.equal(plan.comments.length, 0);
    assert.match(plan.deferred[0]?.reason ?? "", /new file/);
    assert.equal(plan.deferred[0]?.path, "t.test.ts");
  });

  it("defers a change outside the lines the PR's diff exposes", () => {
    // The PR only touched lines 100+; the agent edited line 21.
    const plan = planSuggestions(diffReplacing("s.ts"), new Map([["s.ts", new Set([100, 101])]]));
    assert.equal(plan.comments.length, 0);
    assert.match(plan.deferred[0]?.reason ?? "", /outside the lines/);
  });

  it("defers a file the PR never touched", () => {
    const plan = planSuggestions(diffReplacing("untouched.ts"), new Map([["other.ts", new Set([1])]]));
    assert.match(plan.deferred[0]?.reason ?? "", /not part of this PR's diff/);
  });

  it("defers a file GitHub exposes no diff for", () => {
    const plan = planSuggestions(diffReplacing("s.ts"), new Map([["s.ts", new Set<number>()]]));
    assert.match(plan.deferred[0]?.reason ?? "", /no diff for this file/);
  });

  it("splits a mixed patch: suggestions for edits, deferrals for new files", () => {
    const files = parseUnifiedDiff(
      [
        "diff --git a/s.ts b/s.ts",
        "@@ -5,2 +5,2 @@",
        " ctx",
        "-old",
        "+new",
        "diff --git a/n.test.ts b/n.test.ts",
        "new file mode 100644",
        "@@ -0,0 +1,1 @@",
        "+new test",
      ].join("\n"),
    );
    const plan = planSuggestions(files, new Map([["s.ts", new Set([5, 6])]]));
    assert.equal(plan.comments.length, 1);
    assert.equal(plan.comments[0]?.path, "s.ts");
    assert.equal(plan.deferred.length, 1);
    assert.equal(plan.deferred[0]?.path, "n.test.ts");
  });

  it("expresses a deletion as an empty suggestion block", () => {
    const files = parseUnifiedDiff(["diff --git a/s.ts b/s.ts", "@@ -3,2 +3,1 @@", " ctx", "-dead()"].join("\n"));
    const plan = planSuggestions(files, new Map([["s.ts", new Set([3, 4])]]));
    assert.match(plan.comments[0]?.body ?? "", /```suggestion\n```/);
  });
});
