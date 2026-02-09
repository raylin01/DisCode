export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type AskForApproval = 'untrusted' | 'on-failure' | 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type NetworkAccess = 'restricted' | 'enabled';
export type SandboxPolicy =
  | { type: 'dangerFullAccess' }
  | { type: 'readOnly' }
  | { type: 'externalSandbox'; networkAccess: NetworkAccess }
  | { type: 'workspaceWrite'; writableRoots: string[]; networkAccess: boolean; excludeTmpdirEnvVar: boolean; excludeSlashTmp: boolean };
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type ReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none';
export type InputModality = 'text' | 'image';
export type MergeStrategy = 'replace' | 'upsert';
export type SkillScope = 'user' | 'repo' | 'system' | 'admin';

export interface ReasoningEffortOption {
  reasoningEffort: ReasoningEffort;
  description: string;
}

export interface ClientInfo {
  name: string;
  title?: string;
  version?: string;
}

export interface InitializeParams {
  clientInfo: ClientInfo;
  capabilities: { experimentalApi: boolean } | null;
}

export type UserInput =
  | { type: 'text'; text: string; text_elements: Array<{ start?: number; end?: number; type?: string }> }
  | { type: 'image'; url: string }
  | { type: 'localImage'; path: string }
  | { type: 'skill'; name: string; path: string }
  | { type: 'mention'; name: string; path: string };

export interface Thread {
  id: string;
  preview?: string;
  cwd?: string;
  modelProvider?: string;
  createdAt?: number;
  updatedAt?: number;
  path?: string | null;
  cliVersion?: string;
  source?: SessionSource;
  gitInfo?: GitInfo | null;
  turns?: Turn[];
  [key: string]: any;
}

export type SubAgentSource =
  | 'review'
  | 'compact'
  | { thread_spawn: { parent_thread_id: string; depth: number } }
  | { other: string };

export type SessionSource =
  | 'cli'
  | 'vscode'
  | 'exec'
  | 'appServer'
  | { subAgent: SubAgentSource }
  | 'unknown';

export interface GitInfo {
  sha: string | null;
  branch: string | null;
  originUrl: string | null;
}

export interface Turn {
  id: string;
  status?: string;
  items?: any[];
  error?: any;
  [key: string]: any;
}

export interface ThreadStartParams {
  model?: string | null;
  modelProvider?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  config?: Record<string, JsonValue> | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: Record<string, any> | null;
  ephemeral?: boolean | null;
  experimentalRawEvents: boolean;
  dynamicTools?: any;
  [key: string]: any;
}

export interface ThreadStartResponse {
  thread: Thread;
  model: string;
  modelProvider: string;
  cwd: string;
  approvalPolicy: AskForApproval;
  sandbox: SandboxMode;
  reasoningEffort: ReasoningEffort | null;
}

export interface TurnStartParams {
  threadId: string;
  input: Array<UserInput>;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandboxPolicy?: SandboxPolicy | null;
  model?: string | null;
  effort?: ReasoningEffort | null;
  summary?: ReasoningSummary | null;
  personality?: Record<string, any> | null;
  outputSchema?: JsonValue | null;
  collaborationMode?: string | null;
}

export interface TurnStartResponse {
  turn: Turn;
}

export interface TurnInterruptParams {
  threadId: string;
  turnId: string;
}

export type TurnInterruptResponse = Record<string, never>;

export type ExecPolicyAmendment = string[];

export interface CommandExecutionRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  command?: string | null;
  cwd?: string | null;
  commandActions?: any[] | null;
  proposedExecpolicyAmendment?: ExecPolicyAmendment | null;
}

export type CommandExecutionApprovalDecision =
  | 'accept'
  | 'acceptForSession'
  | { acceptWithExecpolicyAmendment: { execpolicy_amendment: ExecPolicyAmendment } }
  | 'decline'
  | 'cancel';

export interface CommandExecutionRequestApprovalResponse {
  decision: CommandExecutionApprovalDecision;
}

export interface FileChangeRequestApprovalParams {
  threadId: string;
  turnId: string;
  itemId: string;
  reason?: string | null;
  grantRoot?: string | null;
}

export type FileChangeApprovalDecision = 'accept' | 'acceptForSession' | 'decline' | 'cancel';

export interface FileChangeRequestApprovalResponse {
  decision: FileChangeApprovalDecision;
}

export interface ToolRequestUserInputOption {
  label: string;
  description: string;
}

export interface ToolRequestUserInputQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: ToolRequestUserInputOption[] | null;
}

export interface ToolRequestUserInputParams {
  threadId: string;
  turnId: string;
  itemId: string;
  questions: ToolRequestUserInputQuestion[];
}

export interface ToolRequestUserInputAnswer {
  answers: string[];
}

export interface ToolRequestUserInputResponse {
  answers: Record<string, ToolRequestUserInputAnswer>;
}

export interface Model {
  id: string;
  model: string;
  upgrade: string | null;
  displayName: string;
  description: string;
  supportedReasoningEfforts: ReasoningEffortOption[];
  defaultReasoningEffort: ReasoningEffort;
  inputModalities: InputModality[];
  supportsPersonality: boolean;
  isDefault: boolean;
}

export interface ModelListParams {
  cursor?: string | null;
  limit?: number | null;
}

export interface ModelListResponse {
  data: Model[];
  nextCursor: string | null;
}

export interface SetDefaultModelParams {
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
}

export type SetDefaultModelResponse = Record<string, never>;

export interface AppInfo {
  id: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  logoUrlDark: string | null;
  distributionChannel: string | null;
  installUrl: string | null;
  isAccessible: boolean;
}

export interface AppsListParams {
  cursor?: string | null;
  limit?: number | null;
}

export interface AppsListResponse {
  data: AppInfo[];
  nextCursor: string | null;
}

export interface SkillsListParams {
  cwds?: string[];
  forceReload?: boolean;
}

export interface SkillInterface {
  displayName?: string;
  shortDescription?: string;
  iconSmall?: string;
  iconLarge?: string;
  brandColor?: string;
  defaultPrompt?: string;
}

export interface SkillToolDependency {
  type: string;
  value: string;
  description?: string;
  transport?: string;
  command?: string;
  url?: string;
}

export interface SkillDependencies {
  tools: SkillToolDependency[];
}

export interface SkillMetadata {
  name: string;
  description: string;
  shortDescription?: string;
  interface?: SkillInterface;
  dependencies?: SkillDependencies;
  path: string;
  scope: SkillScope;
  enabled: boolean;
}

export interface SkillErrorInfo {
  path: string;
  message: string;
}

export interface SkillsListEntry {
  cwd: string;
  skills: SkillMetadata[];
  errors: SkillErrorInfo[];
}

export interface SkillsListResponse {
  data: SkillsListEntry[];
}

export type SkillsRemoteReadParams = Record<string, never>;

export interface RemoteSkillSummary {
  id: string;
  name: string;
  description: string;
}

export interface SkillsRemoteReadResponse {
  data: RemoteSkillSummary[];
}

export interface SkillsRemoteWriteParams {
  hazelnutId: string;
  isPreload: boolean;
}

export interface SkillsRemoteWriteResponse {
  id: string;
  name: string;
  path: string;
}

export interface SkillsConfigWriteParams {
  path: string;
  enabled: boolean;
}

export interface SkillsConfigWriteResponse {
  effectiveEnabled: boolean;
}

export interface ConfigReadParams {
  includeLayers: boolean;
  cwd?: string | null;
}

export interface ConfigReadResponse {
  config: Record<string, JsonValue>;
  origins?: Record<string, any>;
  layers?: any[] | null;
}

export interface ConfigEdit {
  keyPath: string;
  value: JsonValue;
  mergeStrategy: MergeStrategy;
}

export interface ConfigBatchWriteParams {
  edits: ConfigEdit[];
  filePath?: string | null;
  expectedVersion?: string | null;
}

export interface ConfigValueWriteParams {
  keyPath: string;
  value: JsonValue;
  mergeStrategy: MergeStrategy;
  filePath?: string | null;
  expectedVersion?: string | null;
}

export interface ConfigRequirements {
  allowedApprovalPolicies: AskForApproval[] | null;
  allowedSandboxModes: SandboxMode[] | null;
  enforceResidency: string | null;
}

export type ThreadSortKey = 'created_at' | 'updated_at';
export type ThreadSourceKind =
  | 'cli'
  | 'vscode'
  | 'exec'
  | 'appServer'
  | 'subAgent'
  | 'subAgentReview'
  | 'subAgentCompact'
  | 'subAgentThreadSpawn'
  | 'subAgentOther'
  | 'unknown';

export interface ThreadListParams {
  cursor?: string | null;
  limit?: number | null;
  sortKey?: ThreadSortKey | null;
  modelProviders?: string[] | null;
  sourceKinds?: ThreadSourceKind[] | null;
  archived?: boolean | null;
}

export interface ThreadListResponse {
  data: Thread[];
  nextCursor: string | null;
}

export interface ThreadLoadedListParams {
  cursor?: string | null;
  limit?: number | null;
}

export interface ThreadLoadedListResponse {
  data: string[];
  nextCursor: string | null;
}

export interface ThreadReadParams {
  threadId: string;
  includeTurns: boolean;
}

export interface ThreadReadResponse {
  thread: Thread;
}

export interface ThreadResumeParams {
  threadId: string;
  history?: any[] | null;
  path?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  config?: Record<string, JsonValue> | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
  personality?: Record<string, any> | null;
}

export interface ThreadResumeResponse {
  thread: Thread;
  model: string;
  modelProvider: string;
  cwd: string;
  approvalPolicy: AskForApproval;
  sandbox: SandboxPolicy;
  reasoningEffort: ReasoningEffort | null;
}

export interface ThreadForkParams {
  threadId: string;
  path?: string | null;
  model?: string | null;
  modelProvider?: string | null;
  cwd?: string | null;
  approvalPolicy?: AskForApproval | null;
  sandbox?: SandboxMode | null;
  config?: Record<string, JsonValue> | null;
  baseInstructions?: string | null;
  developerInstructions?: string | null;
}

export interface ThreadForkResponse {
  thread: Thread;
  model: string;
  modelProvider: string;
  cwd: string;
  approvalPolicy: AskForApproval;
  sandbox: SandboxPolicy;
  reasoningEffort: ReasoningEffort | null;
}

export interface ThreadArchiveParams {
  threadId: string;
}

export type ThreadArchiveResponse = Record<string, never>;

export interface ThreadUnarchiveParams {
  threadId: string;
}

export interface ThreadUnarchiveResponse {
  thread: Thread;
}

export interface ThreadSetNameParams {
  threadId: string;
  name: string;
}

export type ThreadSetNameResponse = Record<string, never>;

export interface ThreadCompactStartParams {
  threadId: string;
}

export type ThreadCompactStartResponse = Record<string, never>;

export interface ThreadRollbackParams {
  threadId: string;
  numTurns: number;
}

export interface ThreadRollbackResponse {
  thread: Thread;
}

export interface DynamicToolCallParams {
  threadId: string;
  turnId: string;
  callId: string;
  tool: string;
  arguments: JsonValue;
}

export type DynamicToolCallOutputContentItem =
  | { type: 'inputText'; text: string }
  | { type: 'inputImage'; imageUrl: string };

export interface DynamicToolCallResponse {
  contentItems: DynamicToolCallOutputContentItem[];
  success: boolean;
}

export type CodexServerRequest =
  | { id: string | number; method: 'item/commandExecution/requestApproval'; params: CommandExecutionRequestApprovalParams }
  | { id: string | number; method: 'item/fileChange/requestApproval'; params: FileChangeRequestApprovalParams }
  | { id: string | number; method: 'item/tool/requestUserInput'; params: ToolRequestUserInputParams }
  | { id: string | number; method: 'item/tool/call'; params: DynamicToolCallParams }
  | { id: string | number; method: string; params?: any };

export type CodexServerNotification =
  | { method: 'thread/started'; params: { thread: Thread } }
  | { method: 'thread/name/updated'; params: { threadId: string; name: string } }
  | { method: 'thread/tokenUsage/updated'; params: { threadId: string; tokenUsage: any } }
  | { method: 'thread/compacted'; params: { threadId: string } }
  | { method: 'turn/started'; params: { threadId: string; turn: Turn } }
  | { method: 'turn/completed'; params: { threadId: string; turn: Turn } }
  | { method: 'turn/diff/updated'; params: { threadId: string; turnId: string; diff: any } }
  | { method: 'turn/plan/updated'; params: { threadId: string; turnId: string; plan: string; explanation?: string | null } }
  | { method: 'item/started'; params: { threadId: string; turnId: string; item: any } }
  | { method: 'item/completed'; params: { threadId: string; turnId: string; item: any } }
  | { method: 'item/agentMessage/delta'; params: { threadId: string; turnId: string; itemId: string; delta: string } }
  | { method: 'item/plan/delta'; params: { threadId: string; turnId: string; itemId: string; delta: string } }
  | { method: 'item/commandExecution/outputDelta'; params: { threadId: string; turnId: string; itemId: string; delta: string } }
  | { method: 'item/commandExecution/terminalInteraction'; params: any }
  | { method: 'item/fileChange/outputDelta'; params: { threadId: string; turnId: string; itemId: string; delta: string } }
  | { method: 'item/mcpToolCall/progress'; params: { threadId: string; turnId: string; itemId: string; message: string } }
  | { method: 'item/reasoning/textDelta'; params: { threadId: string; turnId: string; itemId: string; delta: string } }
  | { method: 'item/reasoning/summaryTextDelta'; params: { threadId: string; turnId: string; itemId: string; delta: string } }
  | { method: 'item/reasoning/summaryPartAdded'; params: any }
  | { method: 'error'; params: { error: any; willRetry?: boolean; threadId?: string; turnId?: string } }
  | { method: string; params?: any };

export interface CodexRpcResponse<T = any> {
  id: string | number;
  result?: T;
  error?: { message?: string; code?: number; data?: any } | any;
}
