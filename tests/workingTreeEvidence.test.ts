import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { createWorkingTreeEvidence } from "@auto-factory/shared";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A throwaway repo with one committed file, so HEAD exists. */
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "af-wt-evidence-"));
  git(dir, ["init", "-q"]);
  git(dir, ["config", "user.email", "test@example.com"]);
  git(dir, ["config", "user.name", "Test"]);
  writeFileSync(join(dir, "app.ts"), "export const x = 1;\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "base"]);
  return dir;
}

describe("createWorkingTreeEvidence", () => {
  const dirs: string[] = [];
  after(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("reports no changes when the tree is untouched", async () => {
    const repo = makeRepo();
    dirs.push(repo);
    const collect = createWorkingTreeEvidence(repo);
    const evidence = await collect("autofactory-flag-implementer");
    assert.match(evidence ?? "", /NO changes during this step/);
  });

  it("captures commits landed mid-run (agents that bypass workingTree mode)", async () => {
    const repo = makeRepo();
    dirs.push(repo);
    const collect = createWorkingTreeEvidence(repo);

    // Node commits its edit itself (the Cursor-local-agent failure mode).
    writeFileSync(join(repo, "app.ts"), "export const x = 5;\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-qm", "feat(auto-factory): wire flag"]);
    const first = await collect("autofactory-flag-implementer");
    assert.ok(first, "expected evidence for the committing node");
    assert.match(first, /Commits landed during this step/);
    assert.match(first, /wire flag/);
    assert.match(first, /\+export const x = 5;/);
    assert.doesNotMatch(first, /NO changes/);

    // Next node: uncommitted edit only — commit section absent, tree delta present.
    writeFileSync(join(repo, "app.ts"), "export const x = 6;\n");
    const second = await collect("autofactory-metrics-author");
    assert.ok(second);
    assert.doesNotMatch(second, /Commits landed/);
    assert.match(second, /Working-tree changes made by this step/);
    assert.match(second, /\+export const x = 6;/);
  });

  it("scopes evidence to each node's edits, including untracked files", async () => {
    const repo = makeRepo();
    dirs.push(repo);
    const collect = createWorkingTreeEvidence(repo);

    // Node 1: edit a tracked file + write an untracked manifest.
    writeFileSync(join(repo, "app.ts"), "export const x = 2;\n");
    mkdirSync(join(repo, ".release-flags"));
    writeFileSync(join(repo, ".release-flags", "pr-branch.json"), '{"flagKey":"enable-x"}\n');
    const first = await collect("autofactory-flag-implementer");
    assert.ok(first, "expected evidence for the first node");
    assert.match(first, /app\.ts/);
    assert.match(first, /-export const x = 1;/);
    assert.match(first, /\+export const x = 2;/);
    // Untracked file contents are included (git diff HEAD can't show them).
    assert.match(first, /new file: \.release-flags\/pr-branch\.json/);
    assert.match(first, /"flagKey":"enable-x"/);

    // Node 2: touches only a new test file — evidence must NOT re-include node 1's edits.
    writeFileSync(join(repo, "app.test.ts"), "it('flag on', () => {});\n");
    const second = await collect("autofactory-flag-testing");
    assert.ok(second);
    assert.match(second, /new file: app\.test\.ts/);
    assert.doesNotMatch(second, /export const x = 2;/);
    assert.doesNotMatch(second, /pr-branch\.json/);

    // Node 3: nothing changed.
    const third = await collect("autofactory-code-reviewer");
    assert.match(third ?? "", /NO changes during this step/);
  });

  it("notices a file reverted back to HEAD (change disappears from the dirty set)", async () => {
    const repo = makeRepo();
    dirs.push(repo);
    writeFileSync(join(repo, "app.ts"), "export const x = 3;\n");
    const collect = createWorkingTreeEvidence(repo); // snapshot includes the dirty file
    writeFileSync(join(repo, "app.ts"), "export const x = 1;\n"); // agent reverts it
    const evidence = await collect("autofactory-flag-implementer");
    assert.ok(evidence);
    assert.match(evidence, /app\.ts/); // named as changed this step
  });

  it("handles a deleted tracked file", async () => {
    const repo = makeRepo();
    dirs.push(repo);
    const collect = createWorkingTreeEvidence(repo);
    unlinkSync(join(repo, "app.ts"));
    const evidence = await collect("autofactory-flag-implementer");
    assert.ok(evidence);
    assert.match(evidence, /app\.ts/);
    assert.match(evidence, /-export const x = 1;/);
  });

  it("degrades to undefined outside a git checkout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "af-wt-notgit-"));
    dirs.push(dir);
    const collect = createWorkingTreeEvidence(dir);
    assert.equal(await collect("any"), undefined);
  });
});
