# The factory

> This topic explains what the factory is and the design decisions behind it.

The LaunchDarkly factory is a prototype that performs safe, autonomous software releases.
A chain of LaunchDarkly-defined AI agents turns a plain pull request into a
feature-flagged, metric-instrumented, tested change, and a release orchestrator turns the
eventual deploy into a guarded rollout that monitors itself.

The factory is not yet generally available. Aspects of this feature may change without
notice or become deprecated in favor of other features.

> **A note on tooling.** This topic describes the factory's *design*. The reference
> implementation runs in a particular CI system, executes agents on particular model
> providers, and receives deploy notifications from a particular CD platform — but each of
> those is a swappable seam, and the implementation can be extended to other platforms and
> providers as needed. Where this page names a concrete tool, treat it as an example of the
> seam, not a requirement of the design. Setup instructions for the current reference
> implementation live in the repository README.

## How the factory works

The factory works in two phases:

1. **At change time**, the factory identifies a relevant change in a pull request and
   creates a flag (targeting off), wires the new behavior behind it, creates guarded
   release metrics and instruments their signals, writes flag-on/flag-off tests, and
   produces an independent review verdict. A release manifest records the flag, metrics,
   and rollout parameters alongside the change.
2. **At deploy time**, a release orchestrator receives a deploy notification, discovers
   which manifests are new in the deployed code, and starts a
   [guarded release](/home/releases/guarded-rollouts) for each one. LaunchDarkly then runs
   the release server-side — traffic shifting, metric monitoring, automatic rollback —
   until it completes, a guardrail metric reverts it, or a human stops it.

The separation is deliberate: **the deploy is not the release.** Code merges and deploys
with every flag off, so deployment always ships the control path. Turning the feature on
is a flag operation, governed by metrics, that no longer has anything to do with shipping
binaries.

## Design principles

### Agent behavior is LaunchDarkly configuration, not code

Everything that defines an agent lives in LaunchDarkly AgentControl and is resolved at run
time:

* **Instructions** — each agent's prompt is an AI Config variation, editable in the
  LaunchDarkly UI; changes take effect on the next run without redeploying anything.
* **Models** — each agent's model comes from its AI Config, so reasoning agents and coding
  agents can run different models, and per-agent model comparisons are a targeting rule.
* **The graph** — the chain's order, routing conditions, and per-agent permissions are an
  agent graph resolved live.
* **Tools** — each agent's tool definitions (descriptions and schemas) live in the
  AgentControl tools library, attached per variation. Tool descriptions steer agent
  behavior as much as instructions do, so they are versioned, editable, per-variation
  configuration too.
* **Operational behavior** — which execution provider runs the agents, whether human
  approvals gate the chain, and whether optional context enrichment is active are all
  feature flags in the factory's own project.

The runtime keeps exactly two things: tool *execution* (what a tool actually does when
called) and the *write ceiling* (which agents may create flags, edit code, or push).
Configuration can narrow or re-describe an agent's powers; it can never broaden them past
what the runtime grants. That split is the prototype's security model.

### Two projects: control plane and data plane

The factory reads its agent configuration from one LaunchDarkly project (the **factory**
project) and writes flags and metrics into another (the **app** project). Agents can never
touch the project that defines them, and a run's impact radius is confined to
the app project.

### Safety is structural

* Flags are created targeting **off** in every environment; the agents must preserve the
  control path exactly, so merge and deploy are always safe.
* Write permissions are granted per agent on the graph's edges, and destructive
  capabilities are additionally gated by global toggles.
* Human approvals, when enabled, compile into **pre-execution gates**: the chain halts
  *before* a gated step runs, so nothing is created or pushed until a person approves.
  Approval policy is three flags — whether to gate, how risk-sensitive to be, and which
  steps — and the risk signal is a numeric score the research agent emits on every run.
  Unknown risk fails closed.
* Side-effect claims are tool-owned: routing signals like "a flag was created" are set
  only by the tool that actually performed the action, never by agent assertion.

### Every claim is measured

Each agent run records duration, tokens, tool usage, and success or error to LaunchDarkly
AI Config monitoring, and emits OpenTelemetry spans to LLM observability. LaunchDarkly
**judges** attached to the coding agents score each output against *verified evidence* —
the git diff of what the agent committed, gathered by the pipeline rather than
claimed by the agent. Judge scores are sampled and non-blocking (the reviewer agent
remains the gate), and they are the instrument for every comparison the factory makes:
model A/Bs and enrichment experiments alike must move the scores to earn their keep.

## Phase 1: from pull request to release resources

Phase 1 resolves the agent graph and walks a chain of six roles:

1. **Research and planning** — classify the change, assess blast radius, emit a risk
   score, and create the release manifest. Changes that don't warrant a flag (docs,
   dependency bumps, configuration) end the chain here.
2. **Intent stewardship** — normalize anything a human wrote into the manifest's release
   intent (see below), sitting exactly where approval-gate edits land.
3. **Flag implementation** — create the flag and wire the new behavior behind it, with the
   control path preserved.
4. **Metrics authoring** — create guarded release metrics (error, latency, business) and
   ensure each has a real, per-unit-attributable signal: a custom event instrumented on
   the flagged path, or — where the service emits traces and the flag is evaluated inside
   them — a trace-based metric that needs no added instrumentation. The metric's
   randomization unit must match the flag rollout's unit.
5. **Testing** — paired tests asserting the new behavior with the flag on and the prior
   behavior with the flag off, executed and fixed until green.
6. **Review** — an independent, read-only verdict over the full diff, including the other
   agents' commits. A rejection is a review verdict, not a pipeline failure.

The agents commit their work to the PR branch and post a summary. The whole run is
idempotent: re-runs reuse existing flags and metrics rather than duplicating them.

### Optional context enrichment

Two flag-gated enrichments give agents context beyond the checkout, and both are designed
to fail soft — a missing source becomes a visible warning and a coverage gap the agents
are told to treat as *unknown*, never as low risk:

* **A knowledge graph** composed from LaunchDarkly-native sources: service-to-service
  dependencies derived from observability traces, flag-to-code locations from code
  references, and a small service registry committed in the application repo. The research
  agent uses it for blast-radius analysis.
* **Documentation access** — agents can read LaunchDarkly documentation pages when
  uncertain about SDK semantics, instead of guessing syntax for languages the repository
  doesn't demonstrate.

Because both are flags, enriched and un-enriched runs can be compared with the same judge
scores as everything else.

## Phase 2: from deploy to guarded release

The **release manifest** is the contract between the phases: a small JSON file on the
default branch recording the flag, its metrics, rollout parameters, and scope. Phase 2 is
an orchestrator (called Beacon in the reference implementation) that:

1. Receives a deploy notification — a small webhook carrying the service and deployed
   SHA. Any CD system that can send one (directly or via a thin adapter) can drive it.
2. Discovers new manifests by diffing the manifest directory between the deployed SHA and
   the previous one, resolving the previous SHA from its own deploy-state store when the
   notification doesn't carry it. Handling is idempotent because CD systems retry.
3. Honors **human release intent first**: a hold, a not-before date, or flag
   prerequisites recorded in the manifest take precedence over any automation, and
   unintelligible intent fails closed to hold. Then it applies method precedence —
   manifest overrides, the flag's release policy, else guarded-if-metrics — and starts the
   release, turning the flag on and starting the guarded rollout atomically.
4. **Observes only.** The rollout itself — stage progression, metric comparison against
   control on live traffic, automatic rollback — runs server-side in LaunchDarkly. The
   orchestrator polls purely to record the outcome.

The orchestrator is deliberately a *translator to LaunchDarkly primitives*, not a
scheduler: staging and multi-phase release logic belong to the platform, not the
prototype.

## The release manifest and human intent

The manifest carries two blocks with different owners. `releasePlan` is the agents'
proposal of release mechanics. `releaseIntent` is the human's stated intent — hold, a
date, prerequisites, a segment — pre-filled as a blank form by the agents so approvers can
see what's expressible, structurally protected so no agent re-run can overwrite what a
person typed, and normalized by the stewardship role so free-text notes become structured
fields. Approvers gain a middle option between approve and reject: approve *with intent*.

## Extension seams

The reference implementation is one instantiation of four seams:

* **Where Phase 1 runs** — any environment that can check out the change, run the chain,
  and write back (the reference implementation includes a CI action and an editor
  extension over the same core).
* **Which models execute the agents** — the execution provider is selected per run by a
  flag; the graph, instructions, and per-agent models are the same across providers, so
  only the model brain changes.
* **Which CD system drives Phase 2** — anything that can deliver a deploy webhook.
* **What the agents know** — instructions, tools, routing, and enrichments are all
  LaunchDarkly configuration, adjustable per project without touching code.

## Prerequisites, in design terms

* A LaunchDarkly account with two projects (factory and app), a server SDK key for the
  factory project, and an API token with write access to both.
* Credentials for at least one agent execution provider.
* A repository whose CI can run the chain on pull requests, and (for Phase 2) a CD system
  that can send a deploy webhook.

Provisioning is one command from the repository: it creates the agent configs, judges,
graph, tools, and operational flags in the factory project, idempotently, with everything
off-by-default so nothing changes behavior until you flip it. An upgrade command brings an
already-provisioned project up to date with a newer repository version without touching
your targeting or live customizations. See the repository README for the current setup
steps.

## Known limitations

These may change as development progresses:

1. The factory supports boolean flags only.
2. Phase 2 is not yet a self-serve installation; expect to read code. Its deploy-state
   store is a single-instance local file (mount a volume to survive redeploys).
3. Fullstack (cross-service) release coordination is the least-exercised path.
4. Trace-based metrics depend on Early Access observability features and on the
   application services emitting telemetry to LaunchDarkly. Any
   OpenTelemetry-compliant instrumentation works — the LaunchDarkly observability
   SDKs, other OTel-based observability tooling, or the bare OTel SDKs — as long
   as the data is routed to LaunchDarkly. For a trace metric to attribute to a
   flag, the flag evaluation must be recorded on the trace: the LaunchDarkly SDK
   plugins do this automatically via the flag evaluation hook; other OTel setups
   add the equivalent span attributes themselves.
