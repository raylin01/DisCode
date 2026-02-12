export interface ControlRequestMessage {
    type: "control_request";
    request_id: string;
    request: ControlRequest;
}
export type ControlRequest = CanUseToolRequest | SetPermissionModeRequest | SetModelRequest | InterruptRequest | HookCallbackRequest;
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
export interface SetPermissionModeRequest {
    subtype: "set_permission_mode";
    mode: "default" | "acceptEdits";
}
export interface SetModelRequest {
    subtype: "set_model";
    model: string;
}
export interface InterruptRequest {
    subtype: "interrupt";
}
export interface HookCallbackRequest {
    subtype: "hook_callback";
    callback_id: string;
    input: Record<string, any>;
    tool_use_id: string;
}
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
export type Suggestion = AddRulesSuggestion | AddDirectoriesSuggestion | SetModeSuggestion;
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
export interface PermissionRequest {
    requestId: string;
    toolName: string;
    inputs: Record<string, any>;
    suggestions: Suggestion[];
    toolUseId: string;
    agentId?: string;
    isPlanMode: boolean;
    isQuestion: boolean;
    blockedPath?: string;
    decisionReason?: string;
}
export interface PermissionDecision {
    requestId: string;
    behavior: "allow" | "deny";
    updatedInput?: Record<string, any>;
    updatedPermissions?: Suggestion[];
    customMessage?: string;
}
export type PermissionScope = "session" | "localSettings" | "userSettings" | "projectSettings";
export interface PermissionScopeInfo {
    scope: PermissionScope;
    label: string;
    description: string;
}
export declare const PERMISSION_SCOPES: Record<PermissionScope, PermissionScopeInfo>;
