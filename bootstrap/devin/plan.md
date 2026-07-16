# Plan: AutoFactory Phase 1 via Devin

**Status: plan, not built. No execution-mode decision has been made yet** —
this document lays out the candidate designs and their tradeoffs. It would
become a Phase 1 front end alongside the GitHub Action, the Cursor/VS Code
extension, and the native Cursor automation (and the planned Claude Code front
end — see `bootstrap/claude-code/plan.md`, which shares most of this analysis).

## Goal

A design partner asks Devin — in a session, via `!autofactory`, from Slack, or
through the Devin API — to run AutoFactory Phase 1 on a branch or PR, and gets
the standard result: a flag (targeting off) in the app project, the behavior
wired behind it, guarded-release metrics with instrumented events,
flag-on/flag-off tests, a `.release-flags/` manifest, and a review verdict.
Devin's native output motion is a pull request, so the closest existing
analogue is the **cloud** Cursor automation (chain runs remotely, commits, and
opens/updates a PR) rather than the local working-tree command.

## What Devin provides (verified against Devin docs, July 2026)

- **Playbooks** — reusable procedural prompts, invocable by `!macro`; the
  natural home for the sequencing + tool-translation content that lives in
  `rules/autofactory.mdc` for Cursor.
- **Custom MCP servers** — Settings → Connections → MCP servers; stdio, SSE,
  and HTTP transports. The LaunchDarkly MCP server (`@launchdarkly/mcp-server`,
  stdio via `npx`) fits. Org-level connections mean one setup covers every
  session.
- **Secrets** — org-level secret manager; Devin injects relevant secrets into
  sessions automatically (`LD_API_KEY`, and for Option B the full `.env` set).
- **Knowledge** — org-wide persistent notes; useful for the LaunchDarkly
  conventions and project keys so they survive across sessions.
- **Interactive sessions** — Devin can pause, ask the user a question, and
  wait; this is the approval surface.

One important *absence*: Devin does not expose a base-URL override for its
internal models, so the proxy-sidecar option from the Claude Code plan
(`claude-code-ld-proxy`) **does not transfer**. There is no middle option
here — Devin is either fetch-and-obey with no LaunchDarkly telemetry, or it
runs the real core in its VM.

## Option A — Native fetch-and-obey (playbook)

Port the Cursor automation artifacts to Devin:

| Artifact | Purpose |
|---|---|
| An `autofactory` **playbook** (macro `!autofactory`) | Sequencing, the five phases, short-circuit rule, LaunchDarkly conventions, tool translation — the content of `rules/autofactory.mdc` + the cloud-automation prompt's loop guard and PR-output override |
| **LaunchDarkly MCP** connection (org settings) | `get-ai-config` (fetch instructions from the factory project), `create-feature-flag`, metric creation (app project) |
| **Secrets**: `LD_API_KEY` | Consumed by the MCP server config |
| **Knowledge** entry (optional) | Factory/app project keys, flag & metric conventions, manifest schema — redundancy against playbook drift |

Devin fetches each phase's instructions from LaunchDarkly at run time,
translates tool names to its native abilities (file edits, terminal, MCP
calls), runs the tests itself in its VM, commits, and opens or updates a PR.

**Partner setup:** add the MCP connection + secret + playbook in their Devin
org. No Anthropic key, no checkout of this repo. Lightest setup of the two.

**What it gives up** — the same fetch-and-obey list as the Cursor automation
and Claude Code Option A:

- No **judges**, no **AI Config monitoring**, no **gen_ai spans** — nothing
  lands in the LaunchDarkly UI's quality/cost surfaces.
- No **per-agent models**: everything runs on Devin's own models. (Arguably
  interesting as a *provider comparison* data point, but unmeasured — without
  judges there's no score to compare.)
- No code-enforced **write ceiling** or **pre-execution gates**, and — unlike
  Claude Code — no repo-level permission/hook system to approximate them.
  Devin's guardrails are the playbook's instructions plus whatever repo/branch
  protections the partner has. This makes the approvals design (below) purely
  advisory in Option A.
- No **knowledge-graph / cross-repo tools**; Devin's own repo access is a
  partial substitute.
- **Fetch-and-obey reliability risk**, untested on Devin's models; fallback is
  baking instruction bodies into the playbook (synced from
  `config/agentcontrol/ai-configs/`).
- No **config-version skew warning**.

## Option B — CLI-in-VM (real Node core)

The thin `autofactory` CLI proposed in the Claude Code plan (Option C there —
a headless wrapper over the shared core, precedented by the extension's
`runChain.ts`) runs fine in Devin's VM. The playbook becomes a chauffeur
script:

1. Clone/`npx` this repo alongside the target checkout (Node 20+ in the VM).
2. Populate `.env` from Devin Secrets: `LD_SDK_KEY`, `LD_API_KEY`,
   `LD_PROJECT_KEY`, `LD_APP_PROJECT_KEY`, `ANTHROPIC_API_KEY`.
3. Run `autofactory run` against the target branch's working tree.
4. Relay progress; handle gates (below); push the branch / open the PR when
   the run completes.

**Full fidelity:** per-agent monitoring, diff-verified judges, gen_ai spans,
per-agent models from the AI configs, code-enforced gates and write ceiling,
KG/cross-repo tools, config-skew warning — all from `packages/shared`.

**Costs:** the partner manages five secrets instead of one, pays Anthropic API
spend on top of Devin's compute, and Devin is supervising a process rather
than doing the work — the "watch the agent think" demo quality is Devin
narrating a CLI. Setup is still one-time org configuration (Devin Secrets +
a playbook), so the marginal per-run friction is low.

## Comparison

| Dimension | A: Native playbook | B: CLI-in-VM |
|---|---|---|
| Partner setup | MCP connection + 1 secret + playbook | playbook + 5 secrets (+ repo clone per run) |
| Anthropic API key | not needed | required |
| Models executing the chain | Devin's own | per-agent from AI configs |
| AI Config monitoring / judges / spans | ✗ | ✓ (full, per agent) |
| Approval gates | advisory (playbook-honored) | code-enforced |
| Write ceiling | ✗ (no hook/permission layer) | code-enforced |
| KG / cross-repo tools | ✗ | ✓ |
| Demo feel | Devin does the work | Devin narrates a process |

Recommendation on the table (not decided): because Devin has **no proxy-style
middle option and no enforcement layer**, the fidelity gap between A and B is
wider here than in Claude Code. If the partner's Devin usage is more than a
curiosity, **B is the safer default**; A is the quick demo.

---

## Approvals design

Today's surfaces: GitHub Action → PR label (`af-approve:<nodeKey>`) +
`action_required` check; extension → blocking modal; Cursor automation →
none. Devin's surface is **ask-in-session**: Devin pauses, messages the user
(web session or Slack thread), and waits for the answer.

**Semantics to preserve (ADR 0008):** the three factory-project flags compile
into **pre-execution** gates — pause *before* the gated step, nothing created
or pushed until a human approves, unknown risk **fails closed**.

- **Option B:** the core enforces the gates. The CLI halts with
  `pendingApproval` naming the node; the playbook tells Devin to relay the
  question to the user and, on approval, re-run with `--approve <nodeKey>`.
  Deterministic and enforced.
- **Option A:** the playbook instructs Devin to read the three flags via the
  MCP `get-feature-flag` tool, derive the served variation (the MCP exposes
  flag configuration, not an evaluation endpoint — fine for these simple
  operational flags), and pause-and-ask before any gated step, failing closed
  on anything unparsable. This is **advisory-strength only**: nothing stops a
  confused run from calling `create-feature-flag` early, and Devin has no
  hook layer to hard-block it. If the partner needs real gating in Option A,
  the honest answer is "use Option B" (or gate at the GitHub layer: Devin
  opens a draft PR and the existing GitHub Action + label flow takes over —
  see next section).
- A special case worth deciding: in an *interactive* Devin session the human
  is already present, so `always` mode is cheap; in an *API/Slack-triggered*
  unattended session, a gate means the session parks until someone answers —
  the playbook should say how long to wait and that timeout = not approved.

## Alternative worth keeping visible: Devin as author, not operator

There's a zero-build configuration that preserves full fidelity today: the
partner's repo installs the existing **GitHub Action** front end, and Devin is
just the engineer that opens PRs. The chain runs in CI exactly as designed —
judges, monitoring, gates via PR labels — and Devin's involvement needs no
AutoFactory awareness at all. This isn't "invoking AutoFactory through Devin,"
so it may not be what the partner is asking for, but it should be offered:
if their actual goal is "our Devin-authored changes get flagged and released
safely," this is the strongest answer with the least machinery.

## Trigger and output

- **Triggers:** interactive ("run autofactory on branch X" / `!autofactory`),
  Slack mention, or the Devin API for automation. If a partner wires an
  automated PR-opened trigger, port the cloud Cursor automation's **loop
  guard** (skip when the change set already carries a `.release-flags/`
  manifest) — Devin's own output PR must not re-trigger the chain.
- **Output:** commits on the branch + an opened/updated PR (Devin's native
  motion), plus a summary comment: flag + metric links, manifest path, review
  verdict as the standard fenced JSON block. Short-circuit (no flag needed) =
  comment and stop, no PR.

## Gaps & follow-ups

1. **Decision needed:** A (native playbook) vs B (CLI-in-VM) — and whether the
   "Devin as author + GitHub Action" configuration answers the partner's real
   need before we build either.
2. **Build (A):** the `autofactory` playbook (port `autofactory.mdc` + the
   cloud-prompt overrides + the approval-flag pause-and-ask procedure, which
   the Cursor rule doesn't have); org MCP connection instructions; Knowledge
   entry.
3. **Build (B):** depends on the `autofactory` CLI from the Claude Code plan
   (shared deliverable — build once, both hosts use it); plus the chauffeur
   playbook with `--approve <nodeKey>` re-run semantics.
4. **Validate:** fetch-and-obey reliability on Devin's models (Option A), and
   whether Devin's session-pause behaves acceptably for gates in unattended
   (API/Slack) sessions.
5. **Unresolved fidelity gaps in Option A:** no telemetry/judges/spans, no
   enforcement layer at all (weakest of any front end), no per-agent models,
   no KG/cross-repo tools, no config-skew warning.
6. **README:** add to the Phase 1 front-ends table once built.
