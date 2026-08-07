import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { describeRepoProfile, loadRepoProfile } from "@auto-factory/shared";

/**
 * The profile is what stops the agents guessing at conventions the target repo
 * has already documented (see repoProfile.ts). These tests pin the discovery
 * order, the budget behavior, and — most importantly — that a repo documenting
 * nothing yields `undefined` so the pipeline is unchanged.
 */
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "af-profile-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.AUTOFACTORY_PROFILE;
  delete process.env.AUTOFACTORY_PROFILE_BUDGET;
});

const write = (rel: string, body: string) => {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
};

describe("loadRepoProfile", () => {
  it("returns undefined when the repo documents nothing", () => {
    assert.equal(loadRepoProfile(root), undefined);
  });

  it("reads CLAUDE.md and states that it outranks the agent's own instructions", () => {
    write("CLAUDE.md", "Use Chakra UI v3, never v2.");
    const p = loadRepoProfile(root);
    assert.ok(p);
    assert.match(p.text, /Chakra UI v3, never v2/);
    // The precedence rule is the whole point: without it an agent hitting a
    // conflict between its instructions and the repo has no basis to choose.
    assert.match(p.text, /outrank your own instructions/);
    assert.deepEqual(
      p.sources.map((s) => s.path),
      ["CLAUDE.md"],
    );
  });

  it("collects AGENTS.md, docs/TESTING.md and .cursor/rules/*, in a stable order", () => {
    write("CLAUDE.md", "claude rules");
    write("AGENTS.md", "agents rules");
    write("docs/TESTING.md", "pnpm --filter server test");
    write(".cursor/rules/server.mdc", "server rules");
    write(".cursor/rules/client.mdc", "client rules");
    const p = loadRepoProfile(root);
    assert.ok(p);
    // Sorted within the rules dir, so the prompt prefix is byte-stable per repo
    // (it is injected on every node — an unstable prefix would defeat caching).
    assert.deepEqual(
      p.sources.map((s) => s.path),
      ["CLAUDE.md", "AGENTS.md", "docs/TESTING.md", ".cursor/rules/client.mdc", ".cursor/rules/server.mdc"],
    );
    assert.match(p.text, /pnpm --filter server test/);
  });

  it("an explicit .autofactory/profile.md leads, and the repo's own docs still follow", () => {
    write("CLAUDE.md", "general repo docs");
    write(".autofactory/profile.md", "pipeline-specific addendum");
    const p = loadRepoProfile(root);
    assert.ok(p);
    // Addendum first (it wins the budget), CLAUDE.md still included — the repo
    // shouldn't have to choose between the two.
    assert.deepEqual(
      p.sources.map((s) => s.path),
      [".autofactory/profile.md", "CLAUDE.md"],
    );
    assert.ok(p.text.indexOf("pipeline-specific addendum") < p.text.indexOf("general repo docs"));
  });

  it("truncates to the budget on a line boundary and says so", () => {
    process.env.AUTOFACTORY_PROFILE_BUDGET = "120";
    write("CLAUDE.md", Array.from({ length: 50 }, (_, i) => `rule line number ${i}`).join("\n"));
    const p = loadRepoProfile(root);
    assert.ok(p);
    assert.equal(p.truncated, true);
    assert.match(p.text, /truncated to fit the context budget/);
    // Cut on a newline, so a rule is never quoted half-way: every line that
    // survived is a complete one.
    const kept = p.text
      .split("### CLAUDE.md\n\n")[1]
      ?.split("\n\n[…truncated")[0]
      ?.split("\n") as string[];
    assert.ok(kept.length > 1, "expected some lines to survive the budget");
    for (const line of kept) assert.match(line, /^rule line number \d+$/);
  });

  it("skips empty files rather than emitting an empty section", () => {
    write("CLAUDE.md", "   \n  \n");
    write("AGENTS.md", "real content");
    const p = loadRepoProfile(root);
    assert.ok(p);
    assert.deepEqual(
      p.sources.map((s) => s.path),
      ["AGENTS.md"],
    );
  });

  it("AUTOFACTORY_PROFILE=off disables injection entirely", () => {
    write("CLAUDE.md", "rules");
    process.env.AUTOFACTORY_PROFILE = "off";
    assert.equal(loadRepoProfile(root), undefined);
  });

  it("survives an unreadable checkout path", () => {
    assert.equal(loadRepoProfile(join(root, "does", "not", "exist")), undefined);
  });
});

describe("describeRepoProfile", () => {
  it("names the files and the total size", () => {
    write("CLAUDE.md", "abcde");
    const p = loadRepoProfile(root);
    assert.ok(p);
    assert.match(describeRepoProfile(p), /1 file\(s\), 5 chars: CLAUDE\.md/);
  });
});
