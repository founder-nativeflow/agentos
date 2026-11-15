import type { Agent, Environment, InboundEvent, Session, SessionEvent, StopReason } from "@agentos/types";
import { newId, nowIso } from "../lib/ids.js";
import type { Store } from "../lib/store.js";
import { storeScope } from "../lib/scope.js";
import { bus } from "./bus.js";
import { callModel, ModelError, type ChatMessage } from "./model.js";
import { existsSync, readdirSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";
import { AGENTOS_HOME, mimeFor, SESSIONS_DIR, storageFile } from "../lib/paths.js";
import { SANDBOX_PROVIDER, sandboxFor, syncSandboxOutputs, type SandboxMount, type SandboxNetwork } from "./sandbox.js";
import { e2bNetworkFor, type E2BNetwork } from "./e2b.js";
import { egress, PACKAGE_MANAGER_HOSTS, SANDBOX_NETWORK, type EgressRules } from "../egress/manager.js";
import type { VaultCredential } from "@agentos/types";
import { TrueForgeEngine } from "./trueforge/engine.js";

/**
 * Agent loop: trueforge-core (default) or AgentOS's original loop below
 * (AGENTOS_RUNTIME=classic), kept as a fallback for one release.
 */
export const RUNTIME: "trueforge" | "classic" = process.env.AGENTOS_RUNTIME === "classic" ? "classic" : "trueforge";
import { evaluate, resolveTools, runBuiltin, type ResolvedTool } from "./tools.js";
import { callMcpTool, mcpToolName, mcpTools, normaliseUrl } from "./mcp.js";

const MAX_STEPS_PER_TURN = 50;

const SANDBOX_NOTE = `

You are running inside an AgentOS sandbox (Linux). Your working directory is /workspace.
Save any deliverable files to /mnt/session/outputs so the user can download them.`;

const text = (blocks: unknown): string =>
  Array.isArray(blocks)
    ? blocks.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "")).join("\n")
    : String(blocks ?? "");

/**
 * Runs sessions: one agent loop per session, driven by events.
 * Everything the loop does is recorded as CMA-compatible events, so the event
 * log is the source of truth and a session can resume after a restart.
 */
export class SessionRuntime {
  private active = new Map<string, AbortController>();
  private trueforge = RUNTIME === "trueforge" ? new TrueForgeEngine() : null;
  private again = new Set<string>();

  constructor(private base: Store) {}

  /** The request's (or session's) workspace-scoped store; the default store in local mode. */
  private get store(): Store {
    return storeScope.getStore() ?? this.base;
  }

  /* ------------------------------------------------------------ events */

  async emit(sessionId: string, fields: Record<string, unknown> & { type: string }): Promise<SessionEvent> {
    const event = { id: newId("event"), processed_at: nowIso(), ...fields } as SessionEvent;
    const seq = await this.store.events.append(sessionId, event);
    bus.publish(sessionId, seq, event);
    return event;
  }

  /** Stores inbound events (from the API) and wakes the loop. Returns the stored events. */
  async receive(session: Session, inbound: InboundEvent[]): Promise<SessionEvent[]> {
    const stored: SessionEvent[] = [];
    for (const ev of inbound) {
      const immediate = ev.type === "user.interrupt" || ev.type === "user.tool_confirmation" || ev.type === "user.custom_tool_result";
      const event = { id: newId("event"), processed_at: immediate ? nowIso() : null, ...ev } as SessionEvent;
      const seq = await this.store.events.append(session.id, event);
      bus.publish(session.id, seq, event);
      stored.push(event);
      if (ev.type === "user.interrupt") this.active.get(session.id)?.abort();
    }
    this.wake(session.id);
    return stored;
  }

  /** Starts the loop for a session, or asks a running loop to look again when it finishes. */
  wake(sessionId: string): void {
    if (this.active.has(sessionId)) {
      this.again.add(sessionId);
      return;
    }
    const controller = new AbortController();
    this.active.set(sessionId, controller);
    void (async () => {
      try {
        do {
          this.again.delete(sessionId);
          await this.turn(sessionId, controller);
        } while (this.again.has(sessionId) && !controller.signal.aborted);
      } catch (err) {
        console.error(`[runtime] session ${sessionId} crashed`, err);
        await this.fail(sessionId, "unknown_error", (err as Error).message).catch(() => {});
      } finally {
        this.active.delete(sessionId);
        // An interrupt aborts the controller; anything queued after it gets a fresh loop.
        if (this.again.has(sessionId)) {
          this.again.delete(sessionId);
          this.wake(sessionId);
        }
      }
    })();
  }

  isRunning(sessionId: string): boolean {
    return this.active.has(sessionId);
  }

  /** Sessions left "running" by a previous process are settled as idle. */
  async recover(): Promise<void> {
    for (const r of await this.base.runningSessionsAllWorkspaces()) {
      await storeScope.run(this.base.scoped(r.workspace_id), async () => {
        const s = await this.store.sessions.get(r.id);
        if (!s) return;
        await this.emit(s.id, { type: "session.error", error: { type: "unknown_error", message: "AgentOS restarted while this session was running" } });
        await this.setIdle(s, { type: "end_turn" });
      });
    }
  }


  /* -------------------------------------------------------------- state */

  private async setStatus(session: Session, status: Session["status"], stop: StopReason | null = session.stop_reason) {
    session.status = status;
    session.stop_reason = stop;
    session.updated_at = nowIso();
    session.stats.duration_seconds = Math.round((Date.now() - new Date(session.created_at).getTime()) / 1000);
    await this.store.sessions.update(session);
  }

  /** Registers the session's output files as session-scoped Files (CMA `scope_id`). */
  private async syncOutputs(sessionId: string) {
    await syncSandboxOutputs(sessionId).catch((err) => console.error(`Could not download outputs for ${sessionId}: ${(err as Error).message}`));
    const dir = resolve(SESSIONS_DIR, sessionId, "outputs");
    if (!existsSync(dir)) return;
    const walk = async (d: string): Promise<void> => {
      for (const name of readdirSync(d)) {
        const p = resolve(d, name);
        const st = statSync(p);
        if (st.isDirectory()) await walk(p);
        else
          await this.store.files.upsertOutput({
            type: "file",
            id: newId("file"),
            filename: relative(dir, p),
            mime_type: mimeFor(name),
            size_bytes: st.size,
            created_at: nowIso(),
            downloadable: true,
            expires_at: null,
            scope: { type: "session", id: sessionId },
            storage_path: relative(AGENTOS_HOME, p),
          });
      }
    };
    try {
      await walk(dir);
    } catch (err) {
      console.error(`Could not sync outputs for ${sessionId}: ${(err as Error).message}`);
    }
  }

  /**
   * Sandbox networking. Unrestricted environments without secrets go straight out
   * (bridge). Everything else goes through the egress proxy, which enforces the
   * allowed hosts and swaps secret placeholders for vault values.
   */
  private async networkFor(session: Session, env: Environment): Promise<E2BNetwork & { secretNames: string[]; allowed: string[] | null }> {
    const n = env.config.networking;
    const unrestricted = !n || n.type === "unrestricted";
    const chosen = new Map<string, VaultCredential>();
    if (session.vault_ids.length) {
      const creds = await this.store.credentials.list(session.vault_ids, false);
      for (const vid of session.vault_ids) {
        for (const c of creds) {
          if (c.vault_id === vid && c.auth.type === "environment_variable" && !chosen.has(c.auth.secret_name)) chosen.set(c.auth.secret_name, c);
        }
      }
    }
    const allowed = unrestricted
      ? null
      : [...new Set([...(n.allowed_hosts ?? []), ...(n.allow_package_managers ? PACKAGE_MANAGER_HOSTS : [])])];
    if (unrestricted && chosen.size === 0) {
      return { network: SANDBOX_PROVIDER === "e2b" ? "e2b" : "bridge", env: {}, secretNames: [], allowed: null };
    }
    // E2B without a reachable egress proxy: its own allow-list covers host rules, but not secrets.
    if (SANDBOX_PROVIDER === "e2b" && !egress.publicAddress()) {
      if (chosen.size > 0) {
        throw new Error("Vault secrets on E2B need the AgentOS egress proxy. Set AGENTOS_EGRESS_PUBLIC_ADDR (see docs/cloud-setup.md).");
      }
      return { network: "e2b", env: {}, e2b: e2bNetworkFor(allowed, null), secretNames: [], allowed };
    }
    const rules: EgressRules = { session_id: session.id, allowed, injections: [] };
    const envVars: Record<string, string> = {};
    for (const [name, c] of chosen) {
      if (c.auth.type !== "environment_variable") continue;
      const value = await this.store.credentials.secret(c.id);
      if (!value) continue;
      const placeholder = egress.placeholder(session.id, c.id);
      envVars[name] = placeholder;
      rules.injections.push({
        placeholder,
        value,
        hosts: c.auth.networking.type === "limited" ? c.auth.networking.allowed_hosts : null,
        header: c.auth.injection_location.header,
        body: c.auth.injection_location.body,
      });
      void this.store.credentials.touch(c.id);
    }
    await egress.push(session.id, rules);
    const proxy = egress.proxyUrl(session.id);
    const bundle = "/etc/ssl/certs/ca-certificates.crt";
    const publicAddr = SANDBOX_PROVIDER === "e2b" ? egress.publicAddress() : null;
    return {
      network: SANDBOX_PROVIDER === "e2b" ? "e2b" : SANDBOX_NETWORK,
      e2b: publicAddr ? e2bNetworkFor(null, publicAddr.split(":")[0]!) : undefined,
      env: {
        ...envVars,
        HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy,
        NO_PROXY: "localhost,127.0.0.1", no_proxy: "localhost,127.0.0.1",
        SSL_CERT_FILE: bundle, REQUESTS_CA_BUNDLE: bundle, CURL_CA_BUNDLE: bundle, PIP_CERT: bundle,
        NODE_EXTRA_CA_CERTS: "/usr/local/share/ca-certificates/agentos-egress.crt",
      },
      caPem: rules.injections.length ? egress.caPem() : undefined,
      secretNames: Object.keys(envVars),
      allowed,
    };
  }

  /** Tells the model what network access and secrets it has. */
  private networkNote(net: { secretNames: string[]; allowed: string[] | null; network: string }): string {
    if (net.network === "bridge") return "";
    const lines: string[] = [];
    if (net.allowed) {
      lines.push(net.allowed.length
        ? `Network access is limited to these hosts: ${net.allowed.join(", ")}. Requests to other hosts are blocked (HTTP 403).`
        : "The sandbox has no network access.");
    }
    if (net.secretNames.length) {
      const first = net.secretNames[0];
      lines.push(`Secrets are available as environment variables: ${net.secretNames.join(", ")}. Use them as usual `
        + `(for example an Authorization header built from ${first}); the platform supplies the real value when the request leaves the sandbox.`);
    }
    return lines.length ? "\n" + lines.join("\n") : "";
  }

  /** Bearer token for an MCP server URL from the session's vaults (first match wins, vault order). */
  private async bearerFor(session: Session, url: string): Promise<string | null> {
    if (!session.vault_ids.length) return null;
    const creds = await this.store.credentials.list(session.vault_ids, false);
    for (const vid of session.vault_ids) {
      const hit = creds.find((c) => c.vault_id === vid && c.auth.type === "static_bearer" && normaliseUrl(c.auth.mcp_server_url) === url);
      if (hit) {
        const secret = await this.store.credentials.secret(hit.id);
        if (secret) {
          void this.store.credentials.touch(hit.id);
          return secret;
        }
      }
    }
    return null;
  }

  /** Host paths of the session's file resources, for copying into the sandbox. */
  private async mountsFor(session: Session): Promise<SandboxMount[]> {
    const mounts: SandboxMount[] = [];
    for (const r of session.resources) {
      const f = await this.store.files.get(r.file_id);
      if (f) mounts.push({ hostPath: storageFile(f.storage_path), mountPath: r.mount_path });
    }
    return mounts;
  }

  private async setIdle(session: Session, stop: StopReason) {
    await this.syncOutputs(session.id);
    const wire: StopReason = stop.type === "interrupted" ? { type: "end_turn" } : stop;
    await this.emit(session.id, { type: "session.status_idle", stop_reason: wire, stop_details: null });
    await this.setStatus(session, "idle", stop);
  }

  private async fail(sessionId: string, kind: string, message: string) {
    const session = await this.store.sessions.get(sessionId);
    if (!session) return;
    await this.emit(sessionId, { type: "session.error", error: { type: kind, message } });
    await this.setIdle(session, { type: "retries_exhausted" });
  }

  /* --------------------------------------------------------------- loop */

  private async turn(sessionId: string, controller: AbortController): Promise<void> {
    const session = await this.store.sessions.get(sessionId);
    if (!session || session.archived_at || session.status === "terminated") return;
    const env = await this.store.environments.get(session.environment_id);
    if (!env) return this.fail(sessionId, "unknown_error", "The session's environment no longer exists");
    const agent = session.agent;
    const tools = resolveTools(agent);
    let net: SandboxNetwork & { secretNames: string[]; allowed: string[] | null };
    try {
      net = await this.networkFor(session, env);
    } catch (err) {
      return this.fail(sessionId, "egress_proxy_error", `Could not set up sandbox networking: ${(err as Error).message}`);
    }
    const sandbox = sandboxFor(sessionId, env, await this.mountsFor(session), net);
    const netNote = this.networkNote(net);
    const signal = controller.signal;
    const allowedHosts = env.config.networking?.type === "limited" ? env.config.networking.allowed_hosts ?? [] : null;

    let events = (await this.store.events.list(sessionId)).map((r) => r.event);

    // MCP servers: connect (or reuse) and add their tools. Failures are reported, not fatal.
    if (agent.tools.some((t) => t.type === "mcp_toolset")) {
      const mcp = await mcpTools(sessionId, agent, (url) => this.bearerFor(session, url));
      tools.push(...mcp.tools);
      for (const f of mcp.failures) {
        const already = events.some((e) => e.type === "session.error" && (e.error as { message?: string })?.message === f.message);
        if (!already) await this.emit(sessionId, { type: "session.error", error: { type: "mcp_connection_failed_error", message: f.message } });
      }
    }

    // 1. Settle tool calls that were waiting for a person or for the client.
    let pending = this.pendingToolUses(events);

    // An interrupt sent while the session waits on approvals cancels those tool calls.
    const lastInterrupt = events.map((e) => e.type).lastIndexOf("user.interrupt");
    const stale = pending.waiting.filter((id) => events.findIndex((e) => e.id === id) < lastInterrupt);
    if (stale.length > 0) {
      for (const id of stale) {
        const ev = events.find((e) => e.id === id)!;
        if (ev.type === "agent.custom_tool_use") {
          await this.emit(sessionId, { type: "user.custom_tool_result", custom_tool_use_id: id, is_error: true,
            content: [{ type: "text", text: "Interrupted by the user" }], x_interrupted: true });
        } else if (ev.type === "agent.mcp_tool_use") {
          await this.emit(sessionId, { type: "agent.mcp_tool_result", mcp_tool_use_id: id, is_error: true,
            content: [{ type: "text", text: "Interrupted by the user" }], x_interrupted: true });
        } else {
          await this.emit(sessionId, { type: "agent.tool_result", tool_use_id: id, is_error: true,
            content: [{ type: "text", text: "Interrupted by the user" }], x_interrupted: true });
        }
      }
      return this.setIdle(session, { type: "interrupted" });
    }
    if (pending.waiting.length > 0) return; // still waiting on approvals / custom results

    if (this.trueforge) {
      return this.trueforge.turn({
        session, agent, tools, sandbox, allowedHosts, signal, events,
        instruction: this.systemPrompt(agent, session, netNote),
        emit: (fields) => this.emit(sessionId, fields),
        setRunning: () => this.setStatus(session, "running", null),
        setIdle: (stop) => this.setIdle(session, stop),
        saveSession: () => this.store.sessions.update(session),
        overBudget: () => this.overBudget(session),
        interrupted: async () => this.interrupted(session, await this.allEvents(sessionId)),
        markProcessed: (id) => this.store.events.markProcessed(sessionId, id, nowIso()),
        loadState: () => this.store.sessions.getRuntimeState(sessionId),
        saveState: (state) => this.store.sessions.saveRuntimeState(sessionId, state),
        threadStore: this.store.threads,
      });
    }
    pending = this.pendingToolUses(events);
    for (const p of pending.resolved) {
      if (signal.aborted) break;
      if (p.decision === "deny") {
        const content = [{ type: "text", text: `The user denied this tool call.${p.denyMessage ? ` Reason: ${p.denyMessage}` : ""}` }];
        if (p.event.type === "agent.mcp_tool_use") {
          await this.emit(sessionId, { type: "agent.mcp_tool_result", mcp_tool_use_id: p.event.id, is_error: true, content });
        } else {
          await this.emit(sessionId, { type: "agent.tool_result", tool_use_id: p.event.id, is_error: true, content });
        }
      } else {
        await this.execTool(session, p.event, tools, sandbox, signal, allowedHosts);
      }
    }

    // 2. Mark new user messages as processed.
    events = (await this.store.events.list(sessionId)).map((r) => r.event);
    for (const e of events) {
      if (e.type === "user.message" && !e.processed_at) await this.store.events.markProcessed(sessionId, e.id, nowIso());
    }
    if (signal.aborted) return this.interrupted(session, events);
    if (!this.needsModel(events)) return;

    if (session.stop_reason?.type === "budget_reached") return; // paused until the budget is raised

    await this.emit(sessionId, { type: "session.status_running" });
    await this.setStatus(session, "running", null);

    for (let step = 0; step < MAX_STEPS_PER_TURN; step++) {
      if (signal.aborted) return this.interrupted(session, await this.allEvents(sessionId));
      if (this.overBudget(session)) return this.setIdle(session, { type: "budget_reached" });

      const history = await this.allEvents(sessionId);
      const messages = this.buildMessages(agent, history, session, netNote);
      const start = await this.emit(sessionId, { type: "span.model_request_start" });
      const t0 = Date.now();
      let result;
      try {
        result = await callModel(agent.model, messages, tools.map((t) => t.def), signal);
      } catch (err) {
        if ((err as Error).name === "AbortError" || signal.aborted) return this.interrupted(session, await this.allEvents(sessionId));
        const e = err as ModelError;
        await this.emit(sessionId, { type: "span.model_request_end", model_request_start_id: start.id, is_error: true,
          model_usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
        await this.emit(sessionId, { type: "session.error", error: { type: e.kind ?? "unknown_error", message: e.message } });
        return this.setIdle(session, { type: "retries_exhausted" });
      }

      // Usage + cost.
      const u = result.usage;
      session.usage.input_tokens += u.input_tokens;
      session.usage.output_tokens += u.output_tokens;
      session.usage.cache_read_input_tokens += u.cache_read_input_tokens;
      session.usage.cache_creation_input_tokens += u.cache_creation_input_tokens;
      session.usage.cost_usd = (Number(session.usage.cost_usd) + u.cost_usd).toFixed(6);
      session.usage.active_seconds += (Date.now() - t0) / 1000;
      await this.emit(sessionId, { type: "span.model_request_end", model_request_start_id: start.id, is_error: false, model: result.model,
        model_usage: { input_tokens: u.input_tokens, output_tokens: u.output_tokens, cache_read_input_tokens: u.cache_read_input_tokens,
          cache_creation_input_tokens: u.cache_creation_input_tokens, cost_usd: u.cost_usd } });
      await this.emit(sessionId, { type: "session.usage", usage: session.usage, budget: session.budget });
      await this.store.sessions.update(session);

      if (result.reasoning) await this.emit(sessionId, { type: "agent.thinking", thinking: result.reasoning });
      if (result.text) await this.emit(sessionId, { type: "agent.message", content: [{ type: "text", text: result.text }] });

      if (result.toolCalls.length === 0) return this.setIdle(session, { type: "end_turn" });

      // Record every tool call first (one assistant turn), then run the allowed ones.
      const toRun: SessionEvent[] = [];
      const waitFor: string[] = [];
      for (const call of result.toolCalls) {
        let input: Record<string, unknown> = {};
        let parseError: string | null = null;
        try {
          input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          parseError = "The tool arguments were not valid JSON. Retry with valid JSON.";
        }
        const tool = tools.find((t) => t.name === call.function.name);
        if (tool?.kind === "custom" && !parseError) {
          const ev = await this.emit(sessionId, { type: "agent.custom_tool_use", name: tool.name, input });
          waitFor.push(ev.id);
          continue;
        }
        if (tool?.kind === "mcp" && !parseError) {
          const decision = evaluate(tool);
          const ev = await this.emit(sessionId, { type: "agent.mcp_tool_use", name: tool.mcp!.tool, mcp_server_name: tool.mcp!.server,
            input, evaluated_permission: decision });
          if (decision === "ask") waitFor.push(ev.id);
          else toRun.push(ev);
          continue;
        }
        const decision = !tool || parseError ? "deny" : evaluate(tool);
        const ev = await this.emit(sessionId, { type: "agent.tool_use", name: call.function.name, input,
          evaluated_permission: decision, ...(tool ? {} : { x_unknown_tool: true }) });
        if (!tool || parseError) {
          await this.emit(sessionId, { type: "agent.tool_result", tool_use_id: ev.id, is_error: true,
            content: [{ type: "text", text: parseError ?? `Unknown tool: ${call.function.name}` }] });
        } else if (decision === "ask") {
          waitFor.push(ev.id);
        } else {
          toRun.push(ev);
        }
      }
      for (const ev of toRun) {
        if (signal.aborted) break;
        await this.execTool(session, ev, tools, sandbox, signal, allowedHosts);
      }
      if (signal.aborted) return this.interrupted(session, await this.allEvents(sessionId));
      if (waitFor.length) return this.setIdle(session, { type: "requires_action", event_ids: waitFor });
    }
    await this.emit(sessionId, { type: "session.error", error: { type: "unknown_error", message: `Stopped after ${MAX_STEPS_PER_TURN} model calls in one turn` } });
    return this.setIdle(session, { type: "end_turn" });
  }

  private async allEvents(sessionId: string) {
    return (await this.store.events.list(sessionId)).map((r) => r.event);
  }

  private overBudget(session: Session): boolean {
    if (!session.budget) return false;
    return Number(session.usage.cost_usd) * 100 >= Number(session.budget.max_list_cost.amount);
  }

  private async execTool(session: Session, ev: SessionEvent, tools: ResolvedTool[], sandbox: ReturnType<typeof sandboxFor>,
    signal: AbortSignal, allowedHosts: string[] | null) {
    const t0 = Date.now();
    if (ev.type === "agent.mcp_tool_use") {
      const res = await callMcpTool(session.id, String(ev.mcp_server_name), String(ev.name), (ev.input as Record<string, unknown>) ?? {}, signal);
      session.usage.active_seconds += (Date.now() - t0) / 1000;
      await this.emit(session.id, { type: "agent.mcp_tool_result", mcp_tool_use_id: ev.id, is_error: res.isError,
        content: [{ type: "text", text: res.text }], x_duration_ms: Date.now() - t0 });
      return;
    }
    let out;
    try {
      out = await runBuiltin(String(ev.name), (ev.input as Record<string, unknown>) ?? {}, sandbox, { signal, allowedHosts });
    } catch (err) {
      out = { text: signal.aborted ? "Interrupted" : `Tool failed: ${(err as Error).message}`, isError: true };
    }
    session.usage.active_seconds += (Date.now() - t0) / 1000;
    await this.emit(session.id, { type: "agent.tool_result", tool_use_id: ev.id, is_error: out.isError,
      content: [{ type: "text", text: out.text }], x_duration_ms: Date.now() - t0 });
    void tools;
  }

  /** Close any unanswered tool calls and settle the session after an interrupt. */
  private async interrupted(session: Session, events: SessionEvent[]) {
    const answered = new Set(events.filter((e) => e.type === "agent.tool_result").map((e) => String(e.tool_use_id)));
    const mcpAnswered = new Set(events.filter((e) => e.type === "agent.mcp_tool_result").map((e) => String(e.mcp_tool_use_id)));
    for (const e of events) {
      if (e.type === "agent.tool_use" && !answered.has(e.id)) {
        await this.emit(session.id, { type: "agent.tool_result", tool_use_id: e.id, is_error: true,
          content: [{ type: "text", text: "Interrupted by the user" }], x_interrupted: true });
      }
      if (e.type === "agent.mcp_tool_use" && !mcpAnswered.has(e.id)) {
        await this.emit(session.id, { type: "agent.mcp_tool_result", mcp_tool_use_id: e.id, is_error: true,
          content: [{ type: "text", text: "Interrupted by the user" }], x_interrupted: true });
      }
    }
    await this.store.sessions.update(session);
    return this.setIdle(session, { type: "interrupted" });
  }

  /** Tool calls still waiting on a person (approval) or on the client (custom tool result). */
  private pendingToolUses(events: SessionEvent[]) {
    const results = new Set(events.filter((e) => e.type === "agent.tool_result").map((e) => String(e.tool_use_id)));
    const customResults = new Set(events.filter((e) => e.type === "user.custom_tool_result").map((e) => String(e.custom_tool_use_id)));
    for (const e of events) if (e.type === "agent.mcp_tool_result") results.add(String(e.mcp_tool_use_id));
    const confirmations = new Map(
      events.filter((e) => e.type === "user.tool_confirmation").map((e) => [String(e.tool_use_id), e] as const),
    );
    const waiting: string[] = [];
    const resolved: Array<{ event: SessionEvent; decision: "allow" | "deny"; denyMessage?: string }> = [];
    for (const e of events) {
      if (e.type === "agent.custom_tool_use" && !customResults.has(e.id)) waiting.push(e.id);
      if ((e.type === "agent.tool_use" || e.type === "agent.mcp_tool_use") && e.evaluated_permission === "ask" && !results.has(e.id)) {
        const c = confirmations.get(e.id);
        if (!c) waiting.push(e.id);
        else resolved.push({ event: e, decision: c.result === "deny" ? "deny" : "allow", denyMessage: c.deny_message as string | undefined });
      }
    }
    return { waiting, resolved };
  }

  /** The model should run if the conversation ends with something it hasn't answered yet. */
  private needsModel(events: SessionEvent[]): boolean {
    const conv = events.filter((e) =>
      ["user.message", "agent.message", "agent.tool_result", "agent.mcp_tool_result", "user.custom_tool_result", "session.status_idle"].includes(e.type));
    const last = conv[conv.length - 1];
    if (!last) return false;
    return ["user.message", "agent.tool_result", "agent.mcp_tool_result", "user.custom_tool_result"].includes(last.type);
  }

  /** Rebuilds the model conversation from the event log (stable prefix → prompt caching). */
  /** System prompt: the agent's instructions plus what the sandbox provides. */
  private systemPrompt(agent: Agent, session?: Session, netNote = ""): string {
    const files = session?.resources.length
      ? `\nFiles provided for this session:\n${session.resources.map((r) => `- ${r.mount_path}`).join("\n")}`
      : "";
    return (agent.system ?? "You are a helpful agent.") + SANDBOX_NOTE + files + netNote;
  }

  private buildMessages(agent: Agent, events: SessionEvent[], session?: Session, netNote = ""): ChatMessage[] {
    const messages: ChatMessage[] = [{ role: "system", content: this.systemPrompt(agent, session, netNote) }];
    let assistant: Extract<ChatMessage, { role: "assistant" }> | null = null;
    const flush = () => {
      if (assistant) messages.push(assistant);
      assistant = null;
    };
    for (const e of events) {
      switch (e.type) {
        case "user.message":
          flush();
          messages.push({ role: "user", content: text(e.content) });
          break;
        case "system.message":
          flush();
          messages.push({ role: "system", content: text(e.content) });
          break;
        case "agent.message":
          if (assistant && (assistant as { tool_calls?: unknown[] }).tool_calls?.length) flush();
          assistant ??= { role: "assistant", content: null };
          assistant.content = [assistant.content, text(e.content)].filter(Boolean).join("\n") || null;
          break;
        case "agent.tool_use":
        case "agent.custom_tool_use":
          assistant ??= { role: "assistant", content: null };
          (assistant.tool_calls ??= []).push({ id: e.id, type: "function", function: { name: String(e.name), arguments: JSON.stringify(e.input ?? {}) } });
          break;
        case "agent.mcp_tool_use":
          assistant ??= { role: "assistant", content: null };
          (assistant.tool_calls ??= []).push({ id: e.id, type: "function",
            function: { name: mcpToolName(String(e.mcp_server_name), String(e.name)), arguments: JSON.stringify(e.input ?? {}) } });
          break;
        case "agent.tool_result":
          flush();
          messages.push({ role: "tool", tool_call_id: String(e.tool_use_id), content: text(e.content) || "(no output)" });
          break;
        case "agent.mcp_tool_result":
          flush();
          messages.push({ role: "tool", tool_call_id: String(e.mcp_tool_use_id), content: text(e.content) || "(no output)" });
          break;
        case "user.custom_tool_result":
          flush();
          messages.push({ role: "tool", tool_call_id: String(e.custom_tool_use_id), content: text(e.content) || "(no output)" });
          break;
        case "session.status_idle":
        case "span.model_request_start":
          flush();
          break;
      }
    }
    flush();
    return messages;
  }
}

export type { Environment };
