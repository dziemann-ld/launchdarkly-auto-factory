# Plan: AutoFactory Phase 1 in a Claude Code session

**Status: plan, not built. No execution-mode decision has been made yet** — this
document lays out the candidate designs and their tradeoffs so we (and the
design partner) can choose deliberately. It would become Phase 1 front end #4,
alongside the GitHub Action, the Cursor/VS Code extension, and the native
Cursor automation.

## Goal

A design partner working in a Claude Code session says "run AutoFactory on my
changes" (or `/autofactory`) and gets the Phase 1 result on their current
change set: a flag (targeting off) in the app project, the new behavior wired
behind it, guarded-release metrics with instrumented events, flag-on/flag-off
tests, a release manifest under `.release-flags/`, and a review verdict.

## Where this sits

All existing front ends share one property: the six agents' instructions,
models, tools, and graph live in LaunchDarkly and are resolved at run time.
The front ends differ in *what executes the chain*:

- The **GitHub Action** and the **extension** run the real Node core
  (`packages/shared`) — graph walker, provider seam, judges, AI Config
  monitoring, gen_ai spans, and approval gates all enforced in code.
- The **native Cursor automation** (`bootstrap/cursor-automation/`) is
  *fetch-and-obey*: Cursor's own agent fetches each phase's instructions from
  LaunchDarkly via the MCP `get-ai-config` tool and carries them out with
  native tools, guided by a rule that owns sequencing, conventions, and a
  tool-translation table. No Node core — and therefore no judges, no
  monitoring metrics, no code-enforced gates.

Claude Code can take either shape, plus a third hybrid unique to it. These are
the three candidate modes.

---

## Option A — Native fetch-and-obey (Cursor-automation pattern)

Claude Code's own model runs the chain. The artifacts are a direct port of
`bootstrap/cursor-automation/dot-cursor/`:

| Artifact | Purpose |
|---|---|
| `.claude/skills/autofactory/SKILL.md` | The `/autofactory` skill: sequencing, the five phases, LaunchDarkly conventions (flag/metric shapes, manifest schema), and the tool-translation table — ported from `rules/autofactory.mdc` |
| `.mcp.json` | LaunchDarkly MCP server (`@launchdarkly/mcp-server` via `npx`), providing `get-ai-config`, `create-feature-flag`, metric creation |
| `.claude/settings.json` (optional) | Permission rules approximating the write ceiling — see [Enforcement](#enforcement-claude-codes-partial-answer-to-the-write-ceiling) |

The skill fetches each phase's instructions from the **factory** project at
run time (`get-ai-config`), translates runtime tool names
(`create_flag` → MCP `create-feature-flag` against the **app** project,
`commit_and_push` → leave edits in the working tree, `run_tests` → the repo's
test command, …), and reports flag/metric links, the manifest path, and the
review verdict at the end.

**Partner setup:** copy the artifacts into their repo, put an LD API token in
the MCP config (or env), done. No Anthropic API key — the chain runs on the
partner's existing Claude Code subscription. This is the lightest possible
setup.

**What it gives up** (same list the Cursor automation documents):

- No **judges** and no **AI Config monitoring** — nothing lands in the
  LaunchDarkly UI's quality/cost surfaces, which is the demo-visible half of
  "every claim is measured."
- No **gen_ai spans** to LLM Observability.
- No **per-agent models**: every phase runs on whatever model the Claude Code
  session runs, so the per-agent model A/B story is gone.
- No code-enforced **write ceiling** or **pre-execution gates** (partially
  recoverable — see [Enforcement](#enforcement-claude-codes-partial-answer-to-the-write-ceiling)
  and [Approvals](#approvals-design-common-to-all-options)).
- No **knowledge-graph / cross-repo tools** (`query_dependencies`,
  `query_related_repos` are code tools in the Node runtime). Claude Code's
  native `gh`/web access is a partial substitute, not an equivalent.
- **Fetch-and-obey reliability risk**: whether the agent reliably pulls and
  follows LD-hosted instructions is exactly what the Cursor prototype tests;
  the fallback is baking instruction bodies into the skill (synced from
  `config/agentcontrol/ai-configs/`).
- The **config-version skew warning** (`[cfg:…]` stamp check) is code; native
  runs won't warn when the partner's LD project falls behind the repo.

## Option B — Native + LaunchDarkly proxy sidecar

Option A plus [`claude-code-ld-proxy`](https://github.com/EricDarkly/claude-code-ld-proxy):
a local sidecar on `localhost:9911` that Claude Code points at via
`ANTHROPIC_BASE_URL`. Per request it evaluates an LD AI Config (model
selection + system-prompt injection), forwards the request byte-for-byte,
records tokens / duration / tool usage to **AI Config monitoring**, and runs
**judge** configs asynchronously (sampled, zero added latency).

**What it restores over Option A:**

- Monitoring metrics flow into the LaunchDarkly UI again.
- Judges run and record scores.
- LaunchDarkly can swap the session's model out from under Claude Code.

**What it still doesn't restore — be precise with the partner about these:**

- **Per-agent attribution.** The proxy evaluates *one* AI Config for the whole
  session, and Claude Code can't vary headers per request. Every request in a
  run — all six phases plus every intermediate tool-loop turn — lands on one
  config. The per-agent cost-vs-quality comparison does not come back.
- **Verified-evidence judging.** ADR 0007's judges score the node-scoped git
  diff the *pipeline* gathered. The proxy's judges see conversation +
  response, at per-request granularity — a sampled judge is as likely to score
  a mid-loop tool turn as an agent's final output.
- **Enforcement** — no gates, no write ceiling (same as Option A).
- **The zero-key advantage.** The proxy requires `ANTHROPIC_API_KEY` and
  forwards to the API, so the partner's *entire session* is API-billed while
  the proxy is in the loop, and they're running a Python sidecar
  (`uv run main.py`). The setup-simplicity edge over Option C mostly
  evaporates; what survives is the demo feel — the partner watches Claude Code
  itself do the work, steerable mid-run.

**Highest-leverage follow-up if we pick B:** stamp each phase's requests with
a marker (e.g. `[af-agent:autofactory-flag-implementer]` injected by the
skill), and fork the proxy to key the AI Config per request off it. That
restores per-agent attribution and makes judge sampling target the right
config — and is plausibly upstreamable.

The proxy is a colleague's prototype repo, not a supported component; pin a
commit if a partner depends on it.

## Option C — Thin CLI over the real Node core

Build a headless CLI front end and have Claude Code shell out to it. The
extension's `runChain.ts` is already this in all but packaging: shared-core
orchestration against a working tree (`gitMode: "workingTree"`), no editor
imports, an injected `confirmGate` callback. The CLI is that plus argument
parsing and an exit-code surface.

```
npx autofactory run [--graph gha-auto-factory] [--approve <nodeKey>] [--dry-run]
```

**Full fidelity:** judges (diff-verified evidence), AI Config monitoring,
gen_ai spans, per-agent models, policy gates compiled from the three approval
flags, knowledge-graph and cross-repo tools, the code-owned write ceiling —
all come along because they live in `packages/shared`.

**Partner setup:** the same five secrets the GitHub Action path already
requires (`LD_SDK_KEY`, `LD_API_KEY`, `LD_PROJECT_KEY`, `LD_APP_PROJECT_KEY`,
`ANTHROPIC_API_KEY`) in a `.env`, Node 20+, and a checkout/`npx` of this repo.
A partner who has bootstrapped already holds those keys. Claude Code's role
becomes chauffeur: run the CLI, relay progress, relay gate questions
(see [Approvals](#approvals-design-common-to-all-options)).

**Costs:** Anthropic API spend separate from the Claude Code subscription, and
the run is a process the partner watches rather than an agent they steer.

## Comparison

| Dimension | A: Native | B: Native + proxy | C: CLI |
|---|---|---|---|
| Partner setup | MCP config + skill | A + sidecar + `ANTHROPIC_BASE_URL` + API key | `.env` (5 secrets) + Node + checkout |
| Anthropic API key | not needed | required (whole session API-billed) | required (run only) |
| Demo feel | native, steerable | native, steerable | watching a process |
| AI Config monitoring | ✗ | ✓ (session-level, one config) | ✓ (per agent) |
| Judges | ✗ | ✓ (conversation-scored, per-request sampling) | ✓ (diff-verified, per agent) |
| Per-agent models / A-B | ✗ | ✗ (one config; fork could fix) | ✓ |
| gen_ai spans / LLM Obs | ✗ | ✗ (metrics only, as of writing) | ✓ |
| Approval gates | skill-honored (advisory-strength) | skill-honored | code-enforced |
| Write ceiling | permission rules only | permission rules only | code-enforced |
| KG / cross-repo tools | ✗ (native substitutes) | ✗ | ✓ |
| Cfg-version skew warning | ✗ | ✗ | ✓ |

Recommendation on the table (not decided): **B as the primary partner path**
— native feel with LaunchDarkly's monitoring and judges visibly lit, caveats
documented — **with C available as the full-fidelity option** and the
phase-marker proxy fork as the follow-up that closes the attribution gap.

---

## Approvals design (common to all options)

Today's gate surfaces: the GitHub Action halts and waits for a PR label
(`af-approve:<nodeKey>`); the extension shows a blocking modal; the Cursor
automation has none (advisory). Claude Code needs its own surface — this is
the override the design partner should expect.

**Semantics to preserve (ADR 0008):** the three factory-project flags
(`auto-factory-approval-mode`, `auto-factory-risk-threshold`,
`auto-factory-approval-gates`) compile into **pre-execution** gates — the
chain pauses *before* a gated step, so nothing is created or pushed until a
human approves. Unknown or unparsable risk **fails closed**.

- **Option C (CLI):** the core already enforces this. The CLI surface mirrors
  the Action: halt with `pendingApproval` (distinct exit code + message naming
  the node), Claude Code relays the question to the human in-session, and on a
  yes re-runs with `--approve <nodeKey>`. No stdin blocking inside an agent
  session.
- **Options A/B (native):** the skill enforces it by instruction. Before the
  flag-implementer step (and any other configured gate), the skill reads the
  three flags via the MCP `get-feature-flag` tool and derives the served
  variation. Mechanism caveat: the MCP exposes flag *configuration*, not an
  evaluation endpoint, so the skill must derive the served value from the
  environment's fallthrough/off state — fine for these simple operational
  flags, but the skill must be told to **fail closed** on anything it can't
  parse (mode unreadable → treat as `always`; risk score missing → gate). When
  a gate applies, Claude Code stops and asks the human in the session before
  proceeding. This is advisory-strength (the model could misread the flag),
  which is exactly the fidelity gap Option C closes.
- Env overrides (`APPROVAL_MODE`, `RISK_THRESHOLD`, `APPROVAL_GATES`) remain
  CLI-only escape hatches. Known gotcha: a stale `APPROVAL_MODE` in the
  environment silently overrides the flags — the core now logs the source
  loudly; the skill should never set it.

## Enforcement: Claude Code's partial answer to the write ceiling

Unique among the native hosts, Claude Code has configurable permission rules
and hooks, which can restore *some* of the runtime security model even in
Options A/B:

- `.claude/settings.json` deny rules: block `git push`, block the LD MCP
  delete/update-targeting tools (the chain only ever needs create + read),
  restrict writes outside the repo.
- A `PreToolUse` hook could hard-block flag creation until an approval marker
  exists — upgrading the native gate from advisory to enforced. Worth
  prototyping if A/B is chosen.

This narrows agent powers the way the graph's write capabilities do, but it is
configuration in the partner's repo, not a ceiling the factory owns.

## Trigger and output

- **Trigger:** the `/autofactory` skill, or "run AutoFactory on my changes."
  Work from the diff of the current branch against its base (committed +
  uncommitted), like the Cursor local command. A headless variant
  (`claude -p`) exists for CI-ish use but overlaps the GitHub Action — not a
  target for this plan.
- **Output:** edits stay in the working tree for the partner to review and
  commit (Options A/B and Option C's `workingTree` mode alike). Nothing is
  pushed. Final summary: flag + metric links, manifest path, review verdict as
  the standard fenced JSON block.

## Gaps & follow-ups

Open items regardless of, or depending on, the mode chosen:

1. **Decision needed:** primary mode (A / B / C) for the design partner.
2. **Build (A/B):** port `autofactory.mdc` → `.claude/skills/autofactory/SKILL.md`
   including the approval-flag reading + fail-closed gate procedure (new —
   the Cursor rule doesn't have it); `.mcp.json`; suggested
   `.claude/settings.json` deny rules.
3. **Build (B):** proxy setup docs; pin a proxy commit; decide who runs the
   sidecar and where the `ANTHROPIC_API_KEY` lives.
4. **Build (B follow-up):** phase-marker fork of the proxy for per-agent
   attribution + judge targeting; try upstreaming.
5. **Build (C):** the `autofactory` CLI package (thin wrapper over the
   extension's `runChain` shape) with `--approve <nodeKey>` re-run semantics
   and a `pendingApproval` exit code.
6. **Prototype (A/B):** `PreToolUse` hook that hard-blocks `create-feature-flag`
   until a gate is satisfied — upgrades native approvals from advisory to
   enforced.
7. **Unresolved fidelity gaps in any native mode:** no gen_ai spans, no
   diff-verified judge evidence, no per-agent model selection (unless the
   proxy fork lands), no config-skew warning, no KG/cross-repo tools.
8. **README:** add the front end to the Phase 1 front-ends table once built.
