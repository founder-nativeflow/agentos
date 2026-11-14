# Spike: trueforge-core as the AgentOS agent loop

**Date:** 2026-11-14 · **Version tested:** `@truefoundry/trueforge-core@0.182.0` (pinned; released 2026-10-30) · **Verdict: GO, with conditions** · **Status: adopted (default runtime)**

## Adoption status (2026-11-14)

| Plan item | Status |
|---|---|
| 1. Persist and restore thread snapshots | ✅ `sessions.runtime_state`, saved after every model call / tool result; verified across an API restart |
| 2. Exact cost | ✅ loopback OpenRouter proxy (`runtime/trueforge/openrouter-proxy.ts`) maps `usage.cost` → the field trueforge-core sums; also restores OpenRouter `fallbacks` and `provider` routing |
| 3. Compaction on by default | ✅ threshold from the model's context length; emits CMA `agent.thread_context_compacted`; `AGENTOS_COMPACTION=off` to disable |
| 4. Subagents → CMA threads | ✅ CMA `multiagent_20261001` inline sub-agents via `AgentThreadOrchestrator`: `session.thread_created`, `agent.thread_message_sent/received`, `session.thread_status_*`, events tagged `session_thread_id`, `/v1/sessions/{id}/threads` (+ events, stream, archive); approvals inside sub-agents; state of all live threads saved (survives restarts). Not yet: predefined agents, advisor, workflow runs (rejected with a clear 400) |
| 5. TrueForge sandbox interface over Docker/E2B (large-result offloading, Code Mode) | ⏳ later |
| 6. Default runtime switched; classic kept as fallback | ✅ `AGENTOS_RUNTIME=classic` selects the original loop |

Also added: crash recovery (tool calls that were running when the API stopped get an error result and are closed in the thread), budget resume (raising the budget continues the work, as in CMA), and `tests/conformance/runtime-scenarios.sh` (restart, budget resume, compaction).

Verified: conformance 26/26 on both runtimes; runtime scenarios 7/7; real OpenRouter run correct, with exact per-call cost (including a cache-write call the catalog estimate under-priced).

## Question

Can AgentOS keep its CMA-compatible API, Console, sandboxes, egress, vaults, files and
budgets, and swap only its agent loop for TrueForge's `AgentThread`, to get TrueForge's
harness features (compaction, subagents, Code Mode, memory, skills, …) without building them?

## What was built (behind a flag)

- `apps/api/src/runtime/trueforge/engine.ts` (~400 lines): an adapter that runs a session on
  `AgentThread` and translates both ways.
  - In: `user.message`, `user.tool_confirmation`, `user.custom_tool_result` → `user.message`,
    `user.tool_approval`, `user.tool_response`.
  - Out: `model.message`, `tool.response`, `tool.approval_required`, `tool.response_required`,
    `internal.agent.done` → CMA `span.*`, `session.usage`, `agent.thinking`, `agent.message`,
    `agent.(custom_|mcp_)tool_use`, `agent.(mcp_)tool_result`, idle stop reasons.
- AgentOS tools (built-ins, custom tools, MCP tools) are exposed to TrueForge as one `IToolSet`,
  with the same tool names and the AgentOS permission policy (`allow` / `ask`).
- Enabled with `AGENTOS_RUNTIME=trueforge`. **The default runtime is unchanged.**

## Results

| Check | Result |
|---|---|
| Conformance suite (official Anthropic SDK), TrueForge runtime | **26 / 26 pass** (24 on the first run; fixes below) |
| Conformance suite, default runtime (regression) | 26 / 26 pass |
| Approvals, deny, custom tools, interrupt, budget, bad tool JSON | ✅ all mapped |
| MCP (vault bearer, ask by default, errors), egress proxy, files | ✅ unchanged; they sit outside the loop |
| Real model (OpenRouter `qwen/qwen3-coder`, sales-report task) | ✅ correct answer; $0.0045 (estimated) vs $0.0051 on our runtime |
| Context compaction capability | ✅ works with no extra infrastructure |

Fixes needed during the spike:
1. TrueForge always streams. Our mock model learned to stream (SSE).
2. `cancel()` is only for subagent threads; the main thread uses `closeAllOpenToolCalls()`.
3. Cost: see below.

## Findings

**Good**
- The event model maps cleanly onto CMA; approvals and client-side tools behave like CMA's
  `requires_action` flow.
- Our own tool set, sandbox (Docker/E2B), egress proxy, MCP client, vaults and budgets keep
  working unchanged around it.
- It has an SSRF guard (blocks private/loopback model URLs by default), which is a sensible default.
- Compaction plugged in with three lines.

**Costs and risks**
1. **No API stability.** The README says there are no backward-compatibility guarantees; releases
   ship almost daily (0.182 → 0.185 in two weeks). Pin an exact version, keep everything behind
   `engine.ts`, and upgrade deliberately with the conformance suite as the gate.
2. **Cost reporting.** It only reads TrueFoundry-gateway cost (`costInUSD`), not OpenRouter's
   `usage.cost`, and the per-message event drops cost entirely. The adapter estimates cost from
   our OpenRouter catalog prices. That's fine for display, but budgets become estimates. Fix
   options: a small upstream PR to read `usage.cost`, or a custom `ILLM` wrapper.
3. **State lives in memory.** The thread holds the conversation, and after compaction that is
   no longer derivable from our event log. Production needs `toSnapshot()` persisted per
   session (e.g. a `sessions.runtime_state` column) and restored on wake / after restart. Not built.
4. **Dependency weight.** +221 packages (Vercel AI SDK v7, zod v4, Daytona SDK, NATS, OpenTelemetry,
   winston); Redis is a peer dependency. Nothing needed Redis or NATS for the core loop or compaction.
5. **Lost from our runner:** OpenRouter model `fallbacks` (the `models` routing field) and
   `provider` routing preferences aren't expressible through its `custom` provider; custom-tool
   `is_error` is folded into the content text.
6. **Not yet mapped:** subagents (need `AgentThreadOrchestrator` and threads → CMA
   `session_thread_id`), large-tool-response offloading and Code Mode (need TrueForge's
   `HarnessSandbox` interface, i.e. our own Docker/E2B provider for it), skills, memory.

## Recommendation

**Go**, adopting it incrementally behind the adapter:

1. Persist and restore thread snapshots (required before any default switch).
2. Fix cost: PR upstream to read OpenRouter `usage.cost`, or wrap the `ILLM`.
3. Turn on compaction by default (threshold from the model's context length).
4. Map subagents → CMA threads (`session_thread_id`); this is the Phase 3 multi-agent work, mostly done for us.
5. Implement TrueForge's sandbox interface over our Docker/E2B sandbox to unlock large-result offloading and Code Mode.
6. Switch the default runtime only when 1–2 are done and both runtimes pass the suite; keep ours as a fallback for one release.

**No-go triggers:** a breaking upstream change we can't absorb in the adapter within a day, or
any regression in the conformance suite we can't map.

## How to try it

```bash
AGENTOS_RUNTIME=trueforge pnpm --filter @agentos/api dev      # API on the TrueForge loop
AGENTOS_RUNTIME=trueforge bash tests/conformance/run.sh        # conformance on the TrueForge loop
```

Spike probe (prints raw `AgentThread` events against the mock model): `apps/api/scripts/tf-probe.ts`.

Licence: MIT (TrueFoundry). Keep their copyright notice when shipping.
