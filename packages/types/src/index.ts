/**
 * AgentOS shared types.
 *
 * These mirror the Anthropic Managed Agents (CMA) API, beta `managed-agents-2026-04-01`,
 * so the official Anthropic SDKs work against AgentOS. AgentOS-only fields are
 * marked "AgentOS extension".
 */

export const CMA_BETA = "managed-agents-2026-04-01";
export const MEMORY_BETA = "agent-memory-2026-07-22";
export const API_VERSION = "2026-10-21";

/* ------------------------------------------------------------------ IDs */

export const ID_PREFIX = {
  agent: "agent_",
  environment: "env_",
  session: "sesn_",
  event: "sevt_",
  vault: "vlt_",
  credential: "vcrd_",
  memoryStore: "memstore_",
  memory: "mem_",
  memoryVersion: "memver_",
  deployment: "depl_",
  deploymentRun: "drun_",
  file: "file_",
  skill: "skill_",
  workflowRun: "wrun_",
  request: "req_",
  resource: "sesrsc_",
  apiKey: "aok_", // AgentOS extension
  worker: "wrk_", // AgentOS extension
  thread: "sthr_",
  workspace: "wrkspc_",
  workflow: "wf_", // AgentOS extension
  workflowExecution: "wfrun_", // AgentOS extension
  builderChat: "bchat_", // AgentOS extension
} as const;

export type IdKind = keyof typeof ID_PREFIX;

/* --------------------------------------------------------------- Errors */

export type ErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found_error"
  | "request_too_large"
  | "rate_limit_error"
  | "api_error"
  | "overloaded_error";

export interface ErrorResponse {
  type: "error";
  error: { type: ErrorType; message: string };
  request_id: string;
}

/* ----------------------------------------------------------- Pagination */

export interface Page<T> {
  data: T[];
  next_page: string | null;
  /** Only on GET /v1/sessions in CMA. */
  prev_page?: string | null;
}

export type Metadata = Record<string, string>;

/* ---------------------------------------------------------------- Model */

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/**
 * In AgentOS the model id is an OpenRouter model slug, e.g. "qwen/qwen3-coder".
 * CMA accepts a bare string or this object.
 */
export interface ModelConfig {
  id: string;
  effort?: EffortLevel | { type: EffortLevel };
  speed?: "standard" | "fast";
  /** AgentOS extension: ordered fallback OpenRouter slugs. */
  fallbacks?: string[];
  /** AgentOS extension: output-token cap per model request (default 8192). */
  max_tokens?: number;
  /** AgentOS extension: OpenRouter provider routing preferences. */
  provider?: {
    order?: string[];
    allow?: string[];
    deny?: string[];
    data_collection?: "allow" | "deny";
  };
}

/* ---------------------------------------------------------------- Tools */

export type PermissionPolicy =
  | { type: "always_allow" }
  | { type: "always_ask" }
  | { type: "auto" };

export const BUILTIN_TOOLS = [
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "web_fetch",
  "web_search",
] as const;
export type BuiltinToolName = (typeof BUILTIN_TOOLS)[number];

export interface AgentToolset {
  type: "agent_toolset_20260401";
  default_config?: { enabled?: boolean; permission_policy?: PermissionPolicy };
  configs?: Array<{ name: BuiltinToolName; enabled?: boolean; permission_policy?: PermissionPolicy }>;
}

export interface McpToolset {
  type: "mcp_toolset";
  mcp_server_name: string;
  default_config?: { enabled?: boolean; permission_policy?: PermissionPolicy };
  configs?: Array<{ name: string; enabled?: boolean; permission_policy?: PermissionPolicy }>;
}

export interface CustomTool {
  type: "custom";
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export type AgentTool = AgentToolset | McpToolset | CustomTool;

export interface McpServer {
  type: "url";
  name: string;
  url: string;
}

export type SkillRef =
  | { type: "anthropic"; skill_id: string }
  | { type: "custom"; skill_id: string; version?: string };

/* ----------------------------------------------------------- Multiagent */

export type AgentRef = string | { type: "agent"; id: string; version?: number } | { type: "self" };

export interface MultiagentMember {
  type: "enabled" | "disabled";
  inline_agents?: { type: "enabled" | "disabled" };
  predefined_agents?: AgentRef[];
}

export interface Multiagent {
  type: "multiagent_20261001";
  workflows?: MultiagentMember;
  subagents?: MultiagentMember;
  advisor?: { type: "enabled"; model: string } | { type: "disabled" };
}

/* ------------------------------------------------------------ Deployments */

export interface CronSchedule {
  type: "cron";
  expression: string;
  timezone: string;
  last_run_at?: string | null;
  upcoming_runs_at?: string[];
}

export type DeploymentPausedReason =
  | { type: "manual" }
  | { type: "error"; error: { type: string; message?: string } };

/** CMA `BetaManagedAgentsDeployment`: an agent version bound to everything it needs to run autonomously. */
export interface Deployment {
  type: "deployment";
  id: string;
  name: string;
  description: string | null;
  agent: { type: "agent"; id: string; version: number };
  environment_id: string;
  vault_ids: string[];
  resources: Array<{ type: "file"; file_id: string; mount_path?: string | null }>;
  initial_events: Array<{ type: "user.message" | "system.message"; content: TextBlock[] }>;
  budget: Budget | null;
  schedule: CronSchedule | null;
  status: "active" | "paused";
  paused_reason: DeploymentPausedReason | null;
  metadata: Metadata;
  /** AgentOS extension: whether a webhook token is set (POST /v1/x/hooks/deployments/{id}). */
  x_webhook: { enabled: boolean };
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export type DeploymentTrigger =
  | { type: "manual" }
  | { type: "schedule"; scheduled_at: string }
  | { type: "webhook" }; // AgentOS extension

/** CMA `BetaManagedAgentsDeploymentRun`: append-only record of one execution (session created or error). */
export interface DeploymentRun {
  type: "deployment_run";
  id: string;
  deployment_id: string;
  agent: { type: "agent"; id: string; version: number };
  trigger_context: DeploymentTrigger;
  session_id: string | null;
  error: { type: string; message: string } | null;
  created_at: string;
}

/* ------------------------------------------------------- Session threads */

/** CMA `BetaManagedAgentsSessionThread` (a sub-agent thread inside a session). */
export interface SessionThread {
  type: "session_thread";
  id: string;
  session_id: string;
  parent_thread_id: string | null;
  workflow_run_id: string | null;
  agent: {
    type: "inline";
    name: string;
    description: string | null;
    system: string | null;
    model: ModelConfig;
    tools: unknown[];
    mcp_servers: unknown[];
    skills: unknown[];
  };
  status: "running" | "idle" | "rescheduling" | "terminated";
  /** AgentOS extension: why the thread last stopped. */
  stop_reason: StopReason | null;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cost_usd: string;
    active_seconds: number;
  };
  stats: { duration_seconds?: number; active_seconds?: number };
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/* ---------------------------------------------------------------- Agent */

export interface CreateAgentParams {
  name: string;
  model: string | ModelConfig;
  description?: string;
  system?: string;
  tools?: AgentTool[];
  mcp_servers?: McpServer[];
  skills?: SkillRef[];
  multiagent?: Multiagent;
  metadata?: Metadata;
}

export interface UpdateAgentParams extends Partial<CreateAgentParams> {
  /** Optimistic concurrency: mismatch returns 409. */
  version?: number;
}

export interface Agent {
  type: "agent";
  id: string;
  version: number;
  name: string;
  model: ModelConfig;
  description: string | null;
  system: string | null;
  tools: AgentTool[];
  mcp_servers: McpServer[];
  skills: SkillRef[];
  multiagent: Multiagent | null;
  metadata: Metadata;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/* ---------------------------------------------------------- Environment */

export type Networking =
  | { type: "unrestricted" }
  | {
      type: "limited";
      allowed_hosts?: string[];
      allow_package_managers?: boolean;
      allow_mcp_servers?: boolean;
    };

export interface EnvironmentConfig {
  /** "local" is an AgentOS extension: Docker on the machine running AgentOS. */
  type: "cloud" | "self_hosted" | "local";
  networking?: Networking;
  packages?: Partial<Record<"pip" | "npm" | "apt" | "cargo" | "gem" | "go", string[]>>;
}

export interface Environment {
  type: "environment";
  id: string;
  name: string;
  description: string | null;
  config: EnvironmentConfig;
  metadata: Metadata;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/* -------------------------------------------------------------- Session */

export type SessionStatus = "idle" | "running" | "rescheduling" | "terminated";

export type RunsOn = "local" | "cloud" | `worker:${string}`; // AgentOS extension

export interface Budget {
  type: "limit";
  /** Integer string in cents, e.g. "2500" = $25.00. */
  max_list_cost: { amount: string; currency: "USD" };
}

export interface SessionUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  /** AgentOS extension: list cost so far, in USD (string to avoid float drift). */
  cost_usd: string;
  active_seconds: number;
}

export type StopReason =
  | { type: "end_turn" }
  | { type: "requires_action"; event_ids: string[] }
  | { type: "retries_exhausted" }
  | { type: "budget_reached" }
  | { type: "interrupted" }; // AgentOS: shown in the UI; the event still uses end_turn semantics for SDKs

export interface Session {
  type: "session";
  id: string;
  title: string | null;
  status: SessionStatus;
  /** Snapshot of the agent version this session runs (CMA `session.agent`). */
  agent: Agent;
  environment_id: string;
  vault_ids: string[];
  budget: Budget | null;
  usage: SessionUsage;
  stats: { active_seconds: number; duration_seconds: number };
  resources: SessionResource[];
  outcome_evaluations: unknown[];
  metadata: Metadata;
  deployment_id: string | null;
  runs_on: RunsOn; // AgentOS extension
  stop_reason: StopReason | null; // AgentOS extension: last stop reason
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/** CMA `BetaManagedAgentsFileResource`: an uploaded file copied into the sandbox. */
export interface SessionFileResource {
  id: string;
  type: "file";
  file_id: string;
  mount_path: string;
  created_at: string;
  updated_at: string;
}
export type SessionResource = SessionFileResource;

/* --------------------------------------------------------------- Vaults */

export interface Vault {
  type: "vault";
  id: string;
  display_name: string;
  metadata: Metadata;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export type CredentialNetworking = { type: "unrestricted" } | { type: "limited"; allowed_hosts: string[] };

/** What the API returns about a credential's auth. Secret values are never returned. */
export type CredentialAuth =
  | { type: "static_bearer"; mcp_server_url: string }
  | {
      type: "environment_variable";
      secret_name: string;
      networking: CredentialNetworking;
      injection_location: { header: boolean; body: boolean };
    };

export interface VaultCredential {
  type: "vault_credential";
  id: string;
  vault_id: string;
  display_name: string | null;
  auth: CredentialAuth;
  metadata: Metadata;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

/* ---------------------------------------------------------------- Files */

/** CMA `BetaFileMetadata`. */
export interface FileMetadata {
  type: "file";
  id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  created_at: string;
  downloadable: boolean;
  expires_at: string | null;
  scope: { type: "session"; id: string } | null;
}

export interface CreateSessionParams {
  agent: string | { type: "agent"; id: string; version?: number };
  environment_id: string;
  title?: string;
  vault_ids?: string[];
  budget?: Budget;
  metadata?: Metadata;
  initial_events?: InboundEvent[];
  runs_on?: RunsOn;
  resources?: Array<{ type: "file"; file_id: string; mount_path?: string | null }>;
}

/* --------------------------------------------------------------- Events */

export type TextBlock = { type: "text"; text: string };

export type InboundEvent =
  | { type: "user.message"; content: TextBlock[] }
  | { type: "user.custom_tool_result"; custom_tool_use_id: string; content: TextBlock[]; is_error?: boolean }
  | { type: "user.tool_confirmation"; tool_use_id: string; result: "allow" | "deny"; deny_message?: string }
  | { type: "user.interrupt" }
  | {
      type: "user.define_outcome";
      description: string;
      rubric: { type: "text"; content: string } | { type: "file"; file_id: string };
      max_iterations?: number;
    }
  | { type: "system.message"; content: TextBlock[] };

export type OutboundEventType =
  | "session.status_running"
  | "session.status_idle"
  | "session.status_rescheduled"
  | "session.status_terminated"
  | "session.thread_status_running"
  | "session.thread_status_idle"
  | "session.usage"
  | "session.error"
  | "span.model_request_start"
  | "span.model_request_end"
  | "span.outcome_evaluation_start"
  | "span.outcome_evaluation_end"
  | "agent.message"
  | "agent.thinking"
  | "agent.tool_use"
  | "agent.tool_result"
  | "agent.mcp_tool_use"
  | "agent.mcp_tool_result"
  | "agent.custom_tool_use"
  | "agent.thread_message_sent"
  | "agent.thread_message_received"
  | "agent.thread_context_compacted"
  | "session.thread_created"
  | "session.thread_status_running"
  | "session.thread_status_idle"
  | "session.thread_status_terminated"
  | "workflow_run.created"
  | "workflow_run.status_ended";

/**
 * A stored session event. Like CMA, events are flat: `id`, `type`,
 * `processed_at` plus the type's own fields (content, name, input, …).
 */
export type SessionEvent = {
  id: string;
  type: OutboundEventType | InboundEvent["type"];
  processed_at: string | null;
  session_thread_id?: string | null;
} & Record<string, unknown>;

/** Permission decision recorded on agent.tool_use (CMA). */
export type EvaluatedPermission = "allow" | "ask" | "deny";

/* ---------------------------------------------- AgentOS extensions /v1/x */

export interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  context_length: number | null;
  pricing: { prompt: string; completion: string; input_cache_read?: string };
  supported_parameters: string[];
  input_modalities: string[];
  supports_tools: boolean;
}

export interface ProviderSettings {
  provider: "openrouter";
  configured: boolean;
  key_hint: string | null; // e.g. "sk-or-…a1b2"
  last_checked_at: string | null;
  status: "unknown" | "valid" | "invalid";
  /** "workspace": this workspace's own key (cloud mode). "local": the instance key. "platform": none set; the operator's key is used. */
  scope?: "workspace" | "local" | "platform";
}

/* ------------------------------------------------- Workflows (AgentOS extension) */

/**
 * A workflow is a graph of steps. Agent steps run as ordinary sessions; later steps read
 * earlier outputs with templates: {{input}} and {{nodes.<id>.output}}.
 * A step runs once every *active* incoming connection has finished: branches a Condition or
 * Router didn't take are skipped, and independent branches run in parallel.
 */
export interface WorkflowPosition { x: number; y: number }
interface WorkflowNodeBase { id: string; label: string; position?: WorkflowPosition | null }
export interface WorkflowStartNode extends WorkflowNodeBase {
  type: "start";
  /** What the run's input should contain (shown in the Run dialog). */
  input_description?: string | null;
}
export interface WorkflowAgentNode extends WorkflowNodeBase {
  type: "agent";
  /** version null = the agent's latest version when the run starts. */
  agent: { id: string; version?: number | null };
  /** The task sent to the agent; a template. */
  prompt: string;
}
export interface WorkflowConditionNode extends WorkflowNodeBase {
  type: "condition";
  /** Template evaluated at run time, usually {{nodes.<id>.output}}. */
  source: string;
  operator: "contains" | "not_contains" | "equals" | "matches";
  value: string;
}
export interface WorkflowRouterNode extends WorkflowNodeBase {
  type: "router";
  /** Template the model reads to choose a route. */
  source: string;
  routes: Array<{ key: string; description: string }>;
  /** Model that chooses the route (default: the workspace's builder model). */
  model?: string | null;
}
export interface WorkflowOutputNode extends WorkflowNodeBase {
  type: "output";
  /** Template for the run's result. */
  template: string;
}
export type WorkflowNode = WorkflowStartNode | WorkflowAgentNode | WorkflowConditionNode | WorkflowRouterNode | WorkflowOutputNode;
export type WorkflowNodeType = WorkflowNode["type"];

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  /** Condition: "true" | "false". Router: a route key. Otherwise omitted. */
  branch?: string | null;
}

export interface Workflow {
  type: "workflow";
  id: string;
  version: number;
  name: string;
  description: string | null;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  /** Environment for agent steps' sessions. */
  environment_id: string;
  vault_ids: string[];
  metadata: Record<string, string>;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

export type WorkflowStepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";
export interface WorkflowStepState {
  status: WorkflowStepStatus;
  session_id?: string | null;
  output?: string | null;
  /** Condition / Router: the branch taken. */
  branch?: string | null;
  error?: string | null;
  cost_usd?: string | null;
  started_at?: string | null;
  ended_at?: string | null;
}
export interface WorkflowRun {
  type: "workflow_run";
  id: string;
  workflow_id: string;
  workflow_version: number;
  status: "running" | "succeeded" | "failed" | "cancelled";
  input: string;
  output: string | null;
  error: { type: string; message: string } | null;
  steps: Record<string, WorkflowStepState>;
  cost_usd: string;
  trigger: { type: "manual" | "builder_test" };
  created_at: string;
  ended_at: string | null;
}

/* ------------------------------------------------- Builder (AgentOS extension) */

/**
 * The structured plan the builder keeps behind a chat. A short prompt is expanded into this,
 * then applied: agents (and an environment) are created and, for "workflow", the workflow.
 */
export interface BuilderAgentDraft {
  key: string;
  name: string;
  description: string;
  model: string;
  system: string;
  /** Built-in toolset on/off, plus allow sub-agents for "team". */
  toolset: boolean;
  subagents: boolean;
  mcp_servers: Array<{ name: string; url: string }>;
}
export type BuilderWorkflowNode = Exclude<WorkflowNode, WorkflowAgentNode> | (Omit<WorkflowAgentNode, "agent"> & { agent_key: string });
export interface BuilderPlan {
  kind: "agent" | "team" | "workflow";
  title: string;
  summary: string;
  /** The reasoning outline: what the builder decided and why, step by step. */
  steps: Array<{ title: string; detail: string }>;
  assumptions: string[];
  open_questions: string[];
  agents: BuilderAgentDraft[];
  environment: { name: string; networking: "unrestricted" | "limited"; allowed_hosts: string[]; pip: string[]; npm: string[] };
  /** For kind "workflow": nodes reference agents by `agent_key` instead of an id. */
  workflow: null | {
    name: string;
    description: string;
    nodes: BuilderWorkflowNode[];
    edges: WorkflowEdge[];
  };
  test_input: string;
}
export interface BuilderMessage {
  role: "user" | "assistant";
  content: string;
  created_at: string;
  /** assistant: what changed in the plan this turn. */
  changes?: string[];
}
export interface BuilderChat {
  type: "builder_chat";
  id: string;
  title: string;
  model: string;
  messages: BuilderMessage[];
  plan: BuilderPlan | null;
  /** Set after "Create": the ids of what was created. */
  applied: null | {
    /** draft agent key → created agent id */
    agents: Record<string, string>;
    environment_id: string;
    workflow_id: string | null;
    applied_at: string;
  };
  created_at: string;
  updated_at: string;
}
