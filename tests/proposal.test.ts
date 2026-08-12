import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { compareUrl, proposalCommitMessage, suppressesCi } from "../packages/phase1-resource-factory/src/proposal.js";

/**
 * Regression for a live production incident: the stacked-proposal commit carried
 * `[skip ci]`, GitHub composed the squash-merge message on `main` from the branch's
 * commit messages, and the resulting push to main skipped EVERY workflow — no CI, no
 * version tag, no release, no deploy (proj-launchpad f270c2f). A commit that can land
 * in someone's default branch must never disable their pipeline.
 */
describe("proposalCommitMessage", () => {
  it("carries no CI-skip directive", () => {
    const msg = proposalCommitMessage("107");
    assert.equal(suppressesCi(msg), false, `message must not suppress CI: ${msg}`);
    assert.doesNotMatch(msg, /\[skip ci\]/i);
  });

  it("is conventional and names the PR, so a squash bump stays accurate", () => {
    assert.equal(proposalCommitMessage("107"), "chore(auto-factory): proposed changes for #107");
  });
});

describe("suppressesCi", () => {
  it("recognizes every directive GitHub honors, anywhere in the message", () => {
    for (const m of [
      "fix: x\n\n[skip ci]",
      "[ci skip] fix",
      "chore: y [no ci]",
      "feat: z\n\n[skip actions]",
      "feat: z\n\n[actions skip]",
      "fix: q [SKIP CI]",
    ]) {
      assert.equal(suppressesCi(m), true, `expected ${JSON.stringify(m)} to suppress CI`);
    }
  });

  it("does not false-positive on ordinary prose", () => {
    for (const m of [
      "chore(auto-factory): proposed changes for #107",
      "fix(ci): make the skip logic explicit",
      "docs: describe how to skip a step",
    ]) {
      assert.equal(suppressesCi(m), false, `expected ${JSON.stringify(m)} NOT to suppress CI`);
    }
  });
});

describe("compareUrl", () => {
  it("url-encodes branch segments so slashes survive", () => {
    assert.equal(
      compareUrl("o/r", "feat/x", "autofactory/pr-107"),
      "https://github.com/o/r/compare/feat/x...autofactory/pr-107?expand=1",
    );
  });
});
