// Control Request Message (from SDK)
export interface ControlRequestMessage {
  type: "control_request";
  request_id: string;
  request: ControlRequest;
}

export type ControlRequest =
  | CanUseToolRequest
  | SetPermissionModeRequest
  | SetModelRequest
  | InterruptRequest
  | HookCallbackRequest;

// can_use_tool request
export interface CanUseToolRequest {
  subtype: "can_use_tool";
  tool_name: string;
  input: Record<string, any>;
  permission_suggestions?: Suggestion[];
  blocked_path?: string;
  decision_reason?: string;
  tool_use_id: string;
  agent_id?: string;
}

// set_permission_mode request
export interface SetPermissionModeRequest {
  subtype: "set_permission_mode";
  mode: "default" | "acceptEdits";
}

// set_model request
export interface SetModelRequest {
  subtype: "set_model";
  model: string;
}

// interrupt request
export interface InterruptRequest {
  subtype: "interrupt";
}

// hook_callback request
export interface HookCallbackRequest {
  subtype: "hook_callback";
  callback_id: string;
  input: Record<string, any>;
  tool_use_id: string;
}

// Control Response Message (to SDK)
export interface ControlResponseMessage {
  type: "control_response";
  response: ControlResponse;
}

export interface ControlResponse {
  subtype: "success" | "error";
  request_id: string;
  response?: PermissionResponse;
  error?: string;
  pending_permission_requests?: ControlRequestMessage[];
}

export interface PermissionResponse {
  behavior: "allow" | "deny";
  updatedInput?: Record<string, any>;
  updatedPermissions?: Suggestion[];
  message?: string;
  toolUseID?: string;
}

// Suggestion Types
export type Suggestion =
  | AddRulesSuggestion
  | AddDirectoriesSuggestion
  | SetModeSuggestion;

export interface AddRulesSuggestion {
  type: "addRules";
  rules: ToolRule[];
}

export interface ToolRule {
  toolName: string;
  ruleContent: string;
}

export interface AddDirectoriesSuggestion {
  type: "addDirectories";
  directories: string[];
}

export interface SetModeSuggestion {
  type: "setMode";
  mode: "acceptEdits" | "default";
  destination: "session" | "localSettings" | "userSettings" | "projectSettings";
}

// Permission Request for Discord UI
export interface PermissionRequest {
  requestId: string;  // Internal tracking ID
  toolName: string;
  inputs: Record<string, any>;
  suggestions: Suggestion[];
  toolUseId: string;
  agentId?: string;
  isPlanMode: boolean;  // toolName === "ExitPlanMode"
  isQuestion: boolean;   // toolName === "AskUserQuestion"
  blockedPath?: string;
  decisionReason?: string;
}

// Permission Response from Discord UI
export interface PermissionDecision {
  requestId: string;
  behavior: "allow" | "deny";
  updatedInput?: Record<string, any>;
  updatedPermissions?: Suggestion[];
  customMessage?: string;  // For "Tell Claude what to do"
}

// Permission scope for "Always" button
export type PermissionScope =
  | "session"
  | "localSettings"
  | "userSettings"
  | "projectSettings";

export interface PermissionScopeInfo {
  scope: PermissionScope;
  label: string;
  description: string;
}

export const PERMISSION_SCOPES: Record<PermissionScope, PermissionScopeInfo> = {
  session: {
    scope: "session",
    label: "this session",
    description: "Permission lasts for this session only"
  },
  localSettings: {
    scope: "localSettings",
    label: "this project (just you)",
    description: "Saves to .claude/settings.local.json (gitignored)"
  },
  userSettings: {
    scope: "userSettings",
    label: "all projects",
    description: "Saves to ~/.claude/settings.json (global)"
  },
  projectSettings: {
    scope: "projectSettings",
    label: "this project (shared)",
    description: "Saves to .claude/settings.json (not gitignored)"
  }
};
