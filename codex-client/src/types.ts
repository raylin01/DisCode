export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export type AskForApproval = 'untrusted' | 'on-failure' | 'on-request' | 'never';
export type SandboxMode = 'read-only' | 'workspace-write' | 'danger-full-access';
export type ReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
export type ReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none';

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
  [key: string]: any;
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
  sandboxPolicy?: SandboxMode | null;
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
  | { method: 'turn/started'; params: { threadId: string; turn: Turn } }
  | { method: 'turn/completed'; params: { threadId: string; turn: Turn } }
  | { method: 'item/started'; params: { threadId: string; turnId: string; item: any } }
  | { method: 'item/completed'; params: { threadId: string; turnId: string; item: any } }
  | { method: 'item/agentMessage/delta'; params: { threadId: string; turnId: string; itemId: string; delta: string } }
  | { method: 'item/commandExecution/outputDelta'; params: { threadId: string; turnId: string; itemId: string; delta: string } }
  | { method: 'item/reasoning/textDelta'; params: { threadId: string; turnId: string; itemId: string; delta: string } }
  | { method: 'item/reasoning/summaryTextDelta'; params: { threadId: string; turnId: string; itemId: string; delta: string } }
  | { method: string; params?: any };

export interface CodexRpcResponse<T = any> {
  id: string | number;
  result?: T;
  error?: { message?: string; code?: number; data?: any } | any;
}
