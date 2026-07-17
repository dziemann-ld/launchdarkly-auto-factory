# ADR 0013 — Multivariate flags and iteration-aware flag actions

Date: 2026-07-17 · Status: accepted

## Context

The pipeline modeled flags as 0→1 events: `create_flag` made a boolean flag, and the
`flag-implementer → metrics-author` graph edge required the tool-owned
`flag_created=true` tag. A design partner hit the structural consequence: a follow-up
PR that iterated on already-flag-gated code stalled the chain forever — the
implementer *correctly* decided nothing needed creating, but nothing but a
`create_flag` success could set the gating tag. Every iteration PR failed by design.

The deeper problem is philosophical. Functionality rarely ships 0→1 and stays put; it
evolves v0 → v1 → v2. Changing code that lives under an already-**released** flag
silently re-couples deploy with release: the moment the merge deploys, released users
get the new behavior with no targeting decision ever made. Boolean flags cannot
express iteration — LaunchDarkly fixes a flag's kind at creation, so a boolean can
never take another variation.

## Decision

1. **Multivariate-only creation.** `create_flag` creates string multivariate flags:
   variation values are the fixed lineage `control` / `v1` / `v2` / … (semantics go in
   variation names/descriptions), `control` is the off-variation, flags are born dark.
   Code wires string comparisons with a fail-safe default of `"control"`.
2. **Research decides, one implementer executes, tools verify.** The research planner
   emits a **`flag_action`** — `create | extend_variation | ride_existing |
   child_flag | none` — decided from *targeting* evidence, not flag existence: a new
   read-only `get_flag_state` tool reports kind, variation lineage, and per-environment
   released-ness (production is the environment of record; individual QA targets don't
   count; an in-progress automated release counts as released). Unreleased treatment →
   the PR **rides** it (no LD change). Released or mid-release → **extend** with the
   next `vN` (multivariate) or a **child flag** behind the legacy boolean parent.
   Net-new functionality inside flagged code → child flag. Unknown targeting → treat
   as released (never silently ride something that might be live).
3. **The chain advances on verified outcomes, not claims.** A new tool-owned
   **`flag_ready`** tag replaces `flag_created` on the metrics-author edge, set only
   by: `create_flag` success (including 409 reuse), the new `add_variation` (append
   `vN`; idempotent per intended value; refuses booleans), or the new
   `use_existing_flag` — which checks LaunchDarkly directly that the ridden variation
   is genuinely unreleased and *refuses* otherwise. An honest "nothing to create" now
   completes the chain; a faked success remains impossible.
4. **Beacon releases variations.** Release manifests (schema 1.2) carry an optional
   `targetVariation`; the trigger resolves original = what the environment serves
   today, target = the named variation (booleans keep whole-flag semantics). Guarded
   iteration releases compare vN against vN−1 and roll back to vN−1 — not to off.
   Already-serving targets are an explicit `noop`.
5. **Prerequisite re-pointing.** LaunchDarkly prerequisites pin a parent *variationId*,
   so a parent iterating v1→v2 would silently darken children pinned on v1. After a
   variation release completes, Beacon re-points `auto-factory`-tagged children to the
   variation now served; human-built dependencies are surfaced, never rewritten.
   At wire time, prerequisites on multivariate parents pin what the parent's
   targeting points at per environment ("on"), or an explicit value.

## Consequences

- Iteration PRs get the full chain — metrics, tests, review verdict — instead of a
  guaranteed red check; metrics stay flag-scoped (the release attributes per
  variation), and testing covers control / vN−1 / vN on extensions.
- Legacy boolean flags (everything created before this ADR) iterate via child flags
  only; there is deliberately no replace-and-migrate path.
- The steward carries `hold`/`manual` release intent forward onto iteration PRs so a
  fresh manifest cannot silently re-arm a release a human held.
- Variations accumulate (v3, v4, …) on long-lived features; cleanup remains Phase 3,
  and LaunchDarkly refuses to delete a targeted variation, which bounds the risk.
