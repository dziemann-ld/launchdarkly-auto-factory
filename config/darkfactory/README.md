# Dark Software Factory — demo config set

Source definitions for the **`dark-software-factory`** LaunchDarkly project: a
demo showing AgentControl as the control and measurement plane for a full,
"lights-out" AI SDLC — a much larger graph than the working `auto-factory`
prototype next door in `config/agentcontrol/`.

**This is display-plane only.** The agents here do no real work; the point is
the agent-graph monitoring view (invocations, avg duration, error rate, token
use) populated across a realistic factory topology. Synthetic metrics are
emitted through the real LD AI SDK trackers by
[`scripts/darkfactory-traffic.mjs`](../../scripts/darkfactory-traffic.mjs):

```sh
# DARKFACTORY_SDK_KEY = production SDK key of the dark-software-factory project
set -a && source .env && set +a
node scripts/darkfactory-traffic.mjs 120   # simulate 120 factory runs
```

## The graph (`graphs/dark-factory.json`)

25 nodes / 42 edges, root `df-signal-triage`:

- **Intake & research** — signal triage fans out to business-intent research +
  change-impact analysis, which fan back in to the research planner.
- **Build spine** — the existing AutoFactory prototype nodes, copied verbatim:
  research planner → manifest steward → flag implementer → metrics author →
  flag testing (plus the two judge configs, attached but not graph nodes).
- **Verification fan-out (8-way)** — code review, style review, synthetic
  scenario runner (holdout tests), QA verifier, bug scanner, security scanner,
  dependency/license auditor, sensitivity classifier.
- **Governance lane** — sensitivity classifier + security scanner feed the
  policy guardian (policy-as-code + evidence ledger).
- **Gate & ship** — everything fans in to the release approval gate, then
  release manager → canary analyst → experiment analyst → knowledge curator.
- **Loops** — tests-failed → implementer; findings → remediation agent →
  re-verify; release rejected → replan; canary regression → incident responder,
  whose escape analysis files a new work item back at signal triage (the macro
  loop that closes the factory).

Station roster informed by the dark-software-factory literature (StrongDM's
Software Factory, Factory.ai, the env.dev dark-factory playbook, iTmethods,
BrainGu).

## Provisioning

```sh
set -a && source .env && set +a
LD_PROJECT_KEY=dark-software-factory node packages/config-bridge/dist/cli.js provision \
  --ai-configs config/darkfactory/ai-configs \
  --graphs     config/darkfactory/graphs \
  --flags      config/darkfactory/flags \
  --tools      config/agentcontrol/tools
```

Tools are shared with the main prototype (`config/agentcontrol/tools/`); the
`flags/` dir is intentionally empty. The graph API accepts cyclic edges, so the
loop-back edges provision as-is.
