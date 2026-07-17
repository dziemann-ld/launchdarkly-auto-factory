/**
 * Prerequisite re-pointing after a variation release.
 *
 * LaunchDarkly prerequisites pin a specific parent VARIATION (by id). When a
 * multivariate parent iterates (release moves fallthrough v1 → v2), any child
 * flag prerequisite'd on v1 silently goes dark — wrong, since vN is the same
 * capability the child depends on. After a release completes, this module
 * re-points auto-factory children of the released flag to the variation the
 * environment now serves.
 *
 * Scope guards: only children tagged `auto-factory` (we never rewrite a
 * human's hand-built dependency), only the released environment, and only
 * prerequisites on THIS flag. Boolean parents never need re-pointing (their
 * "on" variation id never changes), so callers may skip them. By contract this
 * NEVER throws — like release monitoring, a re-point failure is loudly logged,
 * not fatal.
 */

import type { LdClient } from "@auto-factory/shared";

interface ParentFlag {
  variations?: Array<{ _id: string; value: unknown }>;
  environments?: Record<
    string,
    { on?: boolean; fallthrough?: { variation?: number; rollout?: { variations?: Array<{ variation?: number; weight?: number }> } } }
  >;
}

interface ChildFlag {
  tags?: string[];
  environments?: Record<string, { prerequisites?: Array<{ key?: string; variation?: number }> }>;
}

export interface RepointOutcome {
  childKey: string;
  action: "repointed" | "skipped" | "error";
  detail: string;
}

/**
 * Re-point auto-factory children of `flagKey` in `environmentKey` to the
 * variation the parent's fallthrough now serves. Returns per-child outcomes
 * (empty when the parent is boolean, off, or has no dependents).
 */
export async function repointDependentPrerequisites(
  ld: LdClient,
  flagKey: string,
  environmentKey: string,
): Promise<RepointOutcome[]> {
  const tag = `[beacon] repoint ${flagKey}/${environmentKey}`;
  try {
    const { data: parent } = await ld.getFlag<ParentFlag>(flagKey, `?env=${encodeURIComponent(environmentKey)}`);
    const variations = parent.variations ?? [];
    if (variations.some((v) => typeof v.value === "boolean")) return []; // boolean parents can't drift
    const cfg = parent.environments?.[environmentKey];
    if (cfg?.on !== true) return []; // nothing is being served; nothing to re-point to

    const at = (idx: number | undefined) => (idx === undefined ? undefined : variations[idx]);
    const arms = [...(cfg.fallthrough?.rollout?.variations ?? [])].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    const serving = at(cfg.fallthrough?.variation) ?? at(arms[0]?.variation);
    if (!serving) return [];

    const deps = await ld.getDependentFlags<{ items?: Array<{ key?: string }> }>(flagKey);
    const childKeys = (deps.data.items ?? []).map((i) => i.key).filter((k): k is string => Boolean(k));
    if (childKeys.length === 0) return [];

    const outcomes: RepointOutcome[] = [];
    for (const childKey of childKeys) {
      try {
        const { data: child } = await ld.getFlag<ChildFlag>(childKey, `?env=${encodeURIComponent(environmentKey)}`);
        const prereq = (child.environments?.[environmentKey]?.prerequisites ?? []).find((p) => p?.key === flagKey);
        if (!prereq) {
          outcomes.push({ childKey, action: "skipped", detail: `no prerequisite on '${flagKey}' in '${environmentKey}'` });
          continue;
        }
        const pinned = at(prereq.variation);
        if (pinned?._id === serving._id) {
          outcomes.push({ childKey, action: "skipped", detail: `already pinned to '${String(serving.value)}'` });
          continue;
        }
        if (!(child.tags ?? []).includes("auto-factory")) {
          // A human's hand-built dependency: surface the drift, never rewrite it.
          outcomes.push({
            childKey,
            action: "skipped",
            detail: `pinned to '${String(pinned?.value)}' but not auto-factory-tagged — re-point it manually if it should follow '${String(serving.value)}'`,
          });
          continue;
        }
        await ld.patchFlagSemantic(
          childKey,
          environmentKey,
          [
            { kind: "removePrerequisite", key: flagKey },
            { kind: "addPrerequisite", key: flagKey, variationId: serving._id },
          ],
          `auto-factory: re-point prerequisite ${flagKey} to released variation ${String(serving.value)}`,
        );
        outcomes.push({ childKey, action: "repointed", detail: `'${String(pinned?.value)}' → '${String(serving.value)}'` });
      } catch (e) {
        outcomes.push({ childKey, action: "error", detail: e instanceof Error ? e.message : String(e) });
      }
    }
    for (const o of outcomes) console.log(`${tag}: ${o.childKey} ${o.action} (${o.detail})`);
    return outcomes;
  } catch (e) {
    console.warn(`${tag}: failed (children may be pinned to a stale variation): ${e instanceof Error ? e.message : e}`);
    return [];
  }
}
