# ADR 0012 — Cross-repo research (`query_related_repos`) and agent-recommended prerequisite flags

Date: 2026-07-14 · Status: accepted

## Context

Distributed teams split one product across repositories: a mobile app consuming a
backend's API, a platform library several services depend on, sibling services in
separate repos. Phase 1 runs in a single checkout, so the research planner's impact
analysis stopped at the repo boundary — the knowledge graph (ADR 0010) sees
cross-*service* edges from telemetry, but cross-*repo* consumers of a changed
endpoint, event, or shared type were invisible. That blind spot also hid a class of
release-coordination need: a feature in repo A that must not go live before a
flag-gated capability from repo B is released — exactly what LaunchDarkly
**prerequisite flags** express.

## Decision

1. **The app repo declares its estate.** `.autofactory/services.yaml` gains a
   `relatedRepos:` section — key → `{repo: owner/name, relationship:
   upstream|downstream|sibling, description}`. Repo topology is code-adjacent
   config; it belongs in git, not LaunchDarkly.

2. **A new planner tool, `query_related_repos`**, reads those repos over the GitHub
   REST API (`list` / code `search` / `read_file` / `list_dir`), capability
   `query_repos`. Same posture as the knowledge graph: registry present + token
   present = tool offered; every failure degrades to an error the model reads;
   budgeted (15 fetches/run); Vega skips it (server-side tools). The Actions-default
   `GITHUB_TOKEN` reads the current repo + public repos; private sibling repos need
   `AUTOFACTORY_REPOS_TOKEN`.

3. **Findings ride the existing brief channel.** The planner emits
   `cross_repo_impact` (per repo: relationship, affected surfaces, repo+path
   evidence) and a `prerequisite_flag_recommendation` (parent flag key + variation +
   evidence, or 'none') in its Flag Implementation Brief — no new payload channel;
   the brief is already the implementer's entire prompt.

4. **The implementer can wire the dependency at creation time.** `create_flag`
   gains an optional `prerequisite` input; the writer applies LaunchDarkly's
   `addPrerequisite` semantic patch in every environment. The flag is created
   dark (targeting off), so a creation-time prerequisite changes nothing until
   release — it just makes the dependency structural instead of tribal. Same-project
   only (an LD constraint); cross-project recommendations are recorded as advisory.
   The manifest's agent-owned side gains `releasePlan.prerequisites` so the
   dependency survives to Phase 2 and humans — distinct from the human-owned
   `releaseIntent.prerequisites` that Beacon applies at release (ADR 0009).

## Consequences

- Split-repo estates get blast-radius analysis with evidence, and flag dependencies
  get a path from research into LaunchDarkly structure.
- Prerequisite failures never fail flag creation (fail-soft, reported into the brief).
- GitHub code search covers each repo's default branch and can lag pushes — the tool
  and instructions both frame "no hits" as weak evidence, never proof of no impact.
- Two prerequisite records exist (agent `releasePlan.prerequisites`, human
  `releaseIntent.prerequisites`); Beacon applies only the human's at release today.
  Unifying them is deliberately deferred until the pattern proves out.
