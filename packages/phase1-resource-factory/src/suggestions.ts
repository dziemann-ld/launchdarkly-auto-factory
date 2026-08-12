/**
 * Turn the agents' proposed patch into GitHub **suggested changes** — review
 * comments carrying ```suggestion blocks, which render an "Apply" button and can be
 * batched into a single commit.
 *
 * Why this exists: propose mode leaves the agents' edits uncommitted in a CI
 * checkout that is then destroyed, so the only surviving copy was diff text in a
 * comment and the instruction "apply with `git apply`". That means copy the text out
 * of a browser, save it to a file, and run git — for work a reviewer is meant to
 * accept in one click.
 *
 * GitHub imposes two hard limits, and both are handled by deferring rather than
 * failing:
 *
 *  1. A suggestion REPLACES existing lines. It cannot create a file. Every new file
 *     the agents write (test files, the release manifest) has to go elsewhere.
 *  2. The lines it replaces must lie inside the pull request's own diff. The agents
 *     routinely edit parts of a file the PR never touched, and GitHub rejects a
 *     comment anchored outside the diff.
 *
 * So this module produces a PLAN: the changes that can be suggestions, and the ones
 * that can't with the reason. The caller applies the first as a review and routes the
 * rest to a pushed branch, then says which is which — a silently dropped change would
 * be worse than the copy-paste it replaced.
 */

/** One `@@` hunk of a unified diff. */
export interface PatchHunk {
  oldStart: number;
  newStart: number;
  /** Raw body lines, each prefixed with " ", "-", "+", or "\\". */
  lines: string[];
}

export interface PatchFile {
  path: string;
  isNew: boolean;
  isDelete: boolean;
  hunks: PatchHunk[];
}

/** A review comment carrying a ```suggestion block. */
export interface SuggestionComment {
  path: string;
  /** Last line of the replaced range (GitHub's `line`). */
  line: number;
  /** First line of the replaced range; omitted when it equals `line`. */
  start_line?: number;
  side: "RIGHT";
  body: string;
}

/** A change that could not become a suggestion, and why. */
export interface DeferredChange {
  path: string;
  reason: string;
}

export interface SuggestionPlan {
  comments: SuggestionComment[];
  deferred: DeferredChange[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse a unified diff. Tolerant by design: anything it cannot interpret is simply
 * absent from the result, and the caller treats absence as "defer".
 */
export function parseUnifiedDiff(diff: string): PatchFile[] {
  const files: PatchFile[] = [];
  let current: PatchFile | undefined;
  let hunk: PatchHunk | undefined;

  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header) {
      current = { path: header[2] as string, isNew: false, isDelete: false, hunks: [] };
      files.push(current);
      hunk = undefined;
      continue;
    }
    if (!current) continue;
    if (line.startsWith("new file mode")) {
      current.isNew = true;
      continue;
    }
    if (line.startsWith("deleted file mode")) {
      current.isDelete = true;
      continue;
    }
    const h = HUNK_RE.exec(line);
    if (h) {
      hunk = { oldStart: Number(h[1]), newStart: Number(h[3]), lines: [] };
      current.hunks.push(hunk);
      continue;
    }
    // Skip the file-header noise between `diff --git` and the first hunk.
    if (!hunk) continue;
    if (line.startsWith(" ") || line.startsWith("-") || line.startsWith("+") || line.startsWith("\\")) {
      hunk.lines.push(line);
    }
  }
  return files;
}

/**
 * The RIGHT-side line numbers a pull request's diff exposes for comment, per file,
 * derived from the `patch` GitHub returns for each changed file.
 *
 * A file with no `patch` (GitHub omits it for very large or binary files) yields no
 * commentable lines, so every change to it defers — which is correct, not a bug.
 */
export function commentableLines(prFiles: ReadonlyArray<{ filename: string; patch?: string }>): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  for (const f of prFiles) {
    const lines = new Set<number>();
    if (f.patch) {
      let newLine = 0;
      for (const l of f.patch.split("\n")) {
        const h = HUNK_RE.exec(l);
        if (h) {
          newLine = Number(h[3]);
          continue;
        }
        if (l.startsWith("+") || l.startsWith(" ")) {
          lines.add(newLine);
          newLine += 1;
        }
        // "-" consumes an old line only; "\" is the no-newline marker.
      }
    }
    map.set(f.filename, lines);
  }
  return map;
}

/** Consecutive run of removals/additions within a hunk. */
interface ChangeGroup {
  /** Old-side line numbers removed (empty for a pure insertion). */
  removed: number[];
  /** New content lines, without their "+" prefix. */
  added: string[];
  /** Old-side line number and text of the nearest preceding context line. */
  anchor?: { line: number; text: string };
}

/** Split a hunk into independent change groups, tracking old-side line numbers. */
function changeGroups(hunk: PatchHunk): ChangeGroup[] {
  const groups: ChangeGroup[] = [];
  let oldLine = hunk.oldStart;
  let lastContext: { line: number; text: string } | undefined;
  let open: ChangeGroup | undefined;

  const close = () => {
    if (open) groups.push(open);
    open = undefined;
  };

  for (const raw of hunk.lines) {
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    const kind = raw[0];
    const text = raw.slice(1);
    if (kind === " ") {
      close();
      lastContext = { line: oldLine, text };
      oldLine += 1;
      continue;
    }
    if (!open) open = { removed: [], added: [], ...(lastContext ? { anchor: lastContext } : {}) };
    if (kind === "-") {
      open.removed.push(oldLine);
      oldLine += 1;
    } else if (kind === "+") {
      open.added.push(text);
    }
  }
  close();
  return groups;
}

/** Every integer in [a, b] is present in `set`. */
function rangeIsCommentable(set: Set<number> | undefined, a: number, b: number): boolean {
  if (!set) return false;
  for (let i = a; i <= b; i++) if (!set.has(i)) return false;
  return true;
}

function suggestionBody(explanation: string, content: string[]): string {
  // An empty suggestion block is how GitHub expresses "delete these lines".
  return [explanation, "", "```suggestion", ...content, "```"].join("\n");
}

/**
 * Plan which parts of the agents' patch can become suggestions.
 *
 * `explanation` is the one-liner shown above each Apply button; keep it short, the
 * reviewer is looking at the code.
 */
export function planSuggestions(
  files: readonly PatchFile[],
  commentable: Map<string, Set<number>>,
  explanation = "AutoFactory proposes this change.",
): SuggestionPlan {
  const comments: SuggestionComment[] = [];
  const deferred: DeferredChange[] = [];

  for (const file of files) {
    if (file.isNew) {
      deferred.push({ path: file.path, reason: "new file — a suggestion can only replace existing lines" });
      continue;
    }
    if (file.isDelete) {
      deferred.push({ path: file.path, reason: "file deletion — cannot be expressed as a suggestion" });
      continue;
    }
    if (!commentable.has(file.path)) {
      deferred.push({ path: file.path, reason: "file is not part of this PR's diff" });
      continue;
    }
    const set = commentable.get(file.path);
    if (set && set.size === 0) {
      deferred.push({ path: file.path, reason: "GitHub exposes no diff for this file (too large or binary)" });
      continue;
    }

    let deferredHere = 0;
    for (const hunk of file.hunks) {
      for (const g of changeGroups(hunk)) {
        if (g.removed.length > 0) {
          const start = g.removed[0] as number;
          const end = g.removed[g.removed.length - 1] as number;
          if (!rangeIsCommentable(set, start, end)) {
            deferredHere += 1;
            continue;
          }
          comments.push({
            path: file.path,
            ...(start !== end ? { start_line: start } : {}),
            line: end,
            side: "RIGHT",
            body: suggestionBody(explanation, g.added),
          });
          continue;
        }
        // Pure insertion: a suggestion must replace something, so anchor on the
        // preceding context line and re-emit it ahead of the new lines.
        if (!g.anchor) {
          deferredHere += 1;
          continue;
        }
        if (!rangeIsCommentable(set, g.anchor.line, g.anchor.line)) {
          deferredHere += 1;
          continue;
        }
        comments.push({
          path: file.path,
          line: g.anchor.line,
          side: "RIGHT",
          body: suggestionBody(explanation, [g.anchor.text, ...g.added]),
        });
      }
    }
    if (deferredHere > 0) {
      deferred.push({
        path: file.path,
        reason: `${deferredHere} change${deferredHere === 1 ? "" : "s"} fall outside the lines this PR's diff exposes`,
      });
    }
  }

  return { comments, deferred };
}
