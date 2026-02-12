# Implementation Plan: Permission UI for DisCode

This document outlines the plan to implement VS Code extension-style permission handling in the DisCode project (runner-agent + discord-bot).

## Overview

**Goal:** Replicate the VS Code extension's permission approval/deny/always behavior in DisCode

**Architecture:**
- **runner-agent:** Backend orchestrator that talks to Claude Code SDK - handles permission logic
- **discord-bot:** Frontend UI that displays permissions via Discord embeds - handles user interaction

**Key Difference from VS Code Extension:**
- VS Code extension uses a local webview with React components
- DisCode uses Discord embeds with buttons/modals for UI
- The permission flow and message structures remain the same

---

## Part 1: runner-agent Changes

### Current State

The runner-agent currently handles basic permissions via [approval.ts](runner-agent/src/handlers/approval.ts) but lacks:
1. `request_id` tracking
2. `permission_suggestions` support ("Always" functionality)
3. Proper control response format
4. Permission mode changes
5. Pending permission requests handling

### Required Changes

#### 1.1 Define TypeScript Interfaces

**File:** `runner-agent/src/types/permissions.ts` (NEW)

```typescript
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
```

#### 1.2 Update Approval Handler

**File:** `runner-agent/src/handlers/approval.ts`

**Changes:**

1. Import new types
2. Add `request_id` tracking
3. Handle `permission_suggestions`
4. Store pending requests with all data needed for UI
5. Format permission data for Discord bot

**New Method:**

```typescript
// In ApprovalSession class
async handleControlRequest(controlRequest: ControlRequestMessage): Promise<void> {
  const { request_id, request } = controlRequest;

  if (request.subtype === 'can_use_tool') {
    // Store request for UI
    const permissionRequest: PermissionRequest = {
      requestId: this.generateInternalId(),
      toolName: request.tool_name,
      inputs: request.input,
      suggestions: request.permission_suggestions || [],
      toolUseId: request.tool_use_id,
      agentId: request.agent_id,
      isPlanMode: request.tool_name === 'ExitPlanMode',
      isQuestion: request.tool_name === 'AskUserQuestion',
      blockedPath: request.blocked_path,
      decisionReason: request.decision_reason
    };

    // Map internal ID to SDK request_id
    this.requestIdMap.set(permissionRequest.requestId, request_id);

    // Send to Discord bot for UI
    await this.sendToDiscordBot({
      type: 'permission_request',
      data: permissionRequest
    });
  } else if (request.subtype === 'set_permission_mode') {
    // Handle mode change (could auto-accept or show UI)
    await this.sendPermissionModeResponse(request_id, request.mode);
  }
  // ... handle other subtypes
}
```

#### 1.3 Process Permission Decision from Discord

**File:** `runner-agent/src/handlers/approval.ts`

**New Method:**

```typescript
async processPermissionDecision(decision: PermissionDecision): Promise<void> {
  const { requestId, behavior, updatedInput, updatedPermissions, customMessage } = decision;

  // Get SDK request_id
  const sdkRequestId = this.requestIdMap.get(requestId);
  if (!sdkRequestId) {
    throw new Error(`Unknown request ID: ${requestId}`);
  }

  // Build permission response
  const permissionResponse: PermissionResponse = {
    behavior,
    toolUseID: this.pendingRequests.get(requestId)?.toolUseId
  };

  if (updatedInput) {
    permissionResponse.updatedInput = updatedInput;
  }

  if (updatedPermissions && updatedPermissions.length > 0) {
    permissionResponse.updatedPermissions = updatedPermissions;
  }

  if (behavior === 'deny' && customMessage) {
    permissionResponse.message = customMessage;
  }

  // Build control response message
  const controlResponse: ControlResponseMessage = {
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: sdkRequestId,
      response: permissionResponse
    }
  };

  // Send to SDK via websocket
  await this.sendToClaudeSDK(controlResponse);

  // Cleanup
  this.requestIdMap.delete(requestId);
  this.pendingRequests.delete(requestId);
}
```

#### 1.4 Store and Apply Permission Rules

**File:** `runner-agent/src/permissions/store.ts` (NEW)

```typescript
import { Suggestion, ToolRule } from '../types/permissions.js';

export class PermissionStore {
  private rules: Map<string, ToolRule[]> = new Map();
  private directories: Set<string> = new Set();
  private permissionMode: 'default' | 'acceptEdits' = 'default';

  applySuggestions(suggestions: Suggestion[]): void {
    for (const suggestion of suggestions) {
      switch (suggestion.type) {
        case 'addRules':
          for (const rule of suggestion.rules) {
            this.addRule(rule);
          }
          break;
        case 'addDirectories':
          for (const dir of suggestion.directories) {
            this.addDirectory(dir);
          }
          break;
        case 'setMode':
          this.setMode(suggestion.mode);
          break;
      }
    }
  }

  private addRule(rule: ToolRule): void {
    const existing = this.rules.get(rule.toolName) || [];
    existing.push(rule);
    this.rules.set(rule.toolName, existing);
  }

  private addDirectory(dir: string): void {
    this.directories.add(dir);
  }

  private setMode(mode: 'default' | 'acceptEdits'): void {
    this.permissionMode = mode;
  }

  // Check if tool is allowed
  isToolAllowed(toolName: string, input: any): boolean {
    // Check rules
    const toolRules = this.rules.get(toolName) || [];
    // Implement rule matching logic
    return true;
  }
}
```

---

## Part 2: discord-bot Changes

### Current State

The discord-bot currently shows basic approval embeds with buttons in [buttons.ts](discord-bot/src/handlers/buttons.ts).

### Required Changes

#### 2.1 Define UI State Machine

**File:** `discord-bot/src/permissions/ui-state.ts` (NEW)

```typescript
export enum PermissionScope {
  SESSION = 'session',
  LOCAL_SETTINGS = 'localSettings',
  USER_SETTINGS = 'userSettings',
  PROJECT_SETTINGS = 'projectSettings'
}

export interface PermissionUIState {
  scope: PermissionScope;
  // Scope labels match VS Code extension
  get scopeLabel(): string {
    switch (this.scope) {
      case PermissionScope.SESSION: return 'this session';
      case PermissionScope.LOCAL_SETTINGS: return 'this project (just you)';
      case PermissionScope.USER_SETTINGS: return 'all projects';
      case PermissionScope.PROJECT_SETTINGS: return 'this project (shared)';
    }
  }

  cycleScope(): void {
    const scopes = [
      PermissionScope.LOCAL_SETTINGS,
      PermissionScope.USER_SETTINGS,
      PermissionScope.PROJECT_SETTINGS,
      PermissionScope.SESSION
    ];
    const currentIndex = scopes.indexOf(this.scope);
    this.scope = scopes[(currentIndex + 1) % scopes.length];
  }
}
```

#### 2.2 Update Permission Embed Builder

**File:** `discord-bot/src/handlers/buttons.ts`

**Changes:**

1. Detect if tool is Plan Mode, AskUserQuestion, or normal tool
2. Render appropriate buttons based on tool type and suggestions
3. Add scope selector button if suggestions present

**Button Logic:**

```typescript
import { PermissionScope } from '../permissions/ui-state.js';
import type { PermissionRequest } from '../../../runner-agent/src/types/permissions.js';

async function handlePermissionRequest(
  request: PermissionRequest,
  interaction: ButtonInteraction
): Promise<void> {
  const { toolName, suggestions, isPlanMode, isQuestion } = request;

  // Determine button layout
  const showAlwaysButton = isPlanMode || (suggestions && suggestions.length > 0);
  const showNoButton = !isQuestion;
  const showTellInput = !isQuestion;

  // Build embed
  const embed = new EmbedBuilder()
    .setTitle(`Tool Permission: ${toolName}`)
    .setDescription(formatToolInputs(request.inputs))
    .setColor('Yellow');

  // Build action rows
  const rows: ActionRowBuilder<ButtonBuilder>[] = [];

  // Row 1: Yes / Always / Submit
  const row1 = new ActionRowBuilder<ButtonBuilder>();

  if (isQuestion) {
    row1.addComponents(
      new ButtonBuilder()
        .setCustomId(`perm-submit-${request.requestId}`)
        .setLabel('Submit Answers')
        .setStyle(ButtonStyle.Success)
    );
  } else if (isPlanMode) {
    row1.addComponents(
      new ButtonBuilder()
        .setCustomId(`perm-auto-accept-${request.requestId}`)
        .setLabel('Yes, and auto-accept')
        .setStyle(ButtonStyle.Success)
    );
  } else {
    row1.addComponents(
      new ButtonBuilder()
        .setCustomId(`perm-yes-${request.requestId}`)
        .setLabel('Yes')
        .setStyle(ButtonStyle.Success)
    );
  }

  // Add "Always" button if applicable
  if (showAlwaysButton) {
    if (isPlanMode) {
      row1.addComponents(
        new ButtonBuilder()
          .setCustomId(`perm-manual-${request.requestId}`)
          .setLabel('Yes, and manually approve edits')
          .setStyle(ButtonStyle.Primary)
      );
    } else {
      // Get scope label and build button text
      const scope = PermissionScope.LOCAL_SETTINGS; // Default
      const buttonText = buildAlwaysButtonText(suggestions, scope);

      row1.addComponents(
        new ButtonBuilder()
          .setCustomId(`perm-always-${request.requestId}`)
          .setLabel(buttonText)
          .setStyle(ButtonStyle.Primary)
      );
    }
  }

  rows.push(row1);

  // Row 2: No button (if not AskUserQuestion)
  if (showNoButton) {
    const row2 = new ActionRowBuilder<ButtonBuilder>();
    const noLabel = isPlanMode ? 'No, keep planning' : 'No';

    row2.addComponents(
      new ButtonBuilder()
        .setCustomId(`perm-no-${request.requestId}`)
        .setLabel(noLabel)
        .setStyle(ButtonStyle.Danger)
    );

    // Add scope toggle button if has suggestions
    if (!isPlanMode && suggestions && suggestions.length > 0) {
      row2.addComponents(
        new ButtonBuilder()
          .setCustomId(`perm-scope-${request.requestId}`)
          .setLabel(`🔄 Scope: ${scope.scopeLabel}`)
          .setStyle(ButtonStyle.Secondary)
      );
    }

    rows.push(row2);
  }

  // Row 3: Tell Claude button
  if (showTellInput) {
    const row3 = new ActionRowBuilder<ButtonBuilder>();
    row3.addComponents(
      new ButtonBuilder()
        .setCustomId(`perm-tell-${request.requestId}`)
        .setLabel('Tell Claude what to do instead')
        .setStyle(ButtonStyle.Secondary)
    );
    rows.push(row3);
  }

  // Send embed with buttons
  await interaction.reply({
    embeds: [embed],
    components: rows,
    ephemeral: true
  });
}

function buildAlwaysButtonText(
  suggestions: Suggestion[],
  scope: PermissionScope
): string {
  // Parse suggestions to build button text
  // Examples:
  // - "Yes, allow <Bash> for <scope>"
  // - "Yes, allow <Bash> and <Write> for <scope>"
  // - "Yes, allow <Bash> and <N> more for <scope>"
  // - "Yes, allow access to <N> directories for <scope>"

  const scopeLabel = scope === PermissionScope.SESSION ? 'this session' :
    scope === PermissionScope.LOCAL_SETTINGS ? 'this project (just you)' :
    scope === PermissionScope.USER_SETTINGS ? 'all projects' :
    'this project (shared)';

  // Count tools and directories
  const tools = new Set<string>();
  let directoryCount = 0;

  for (const suggestion of suggestions) {
    if (suggestion.type === 'addRules') {
      for (const rule of suggestion.rules) {
        tools.add(rule.toolName);
      }
    } else if (suggestion.type === 'addDirectories') {
      directoryCount += suggestion.directories.length;
    }
  }

  if (directoryCount > 0) {
    return `Yes, allow access to ${directoryCount} director${directoryCount === 1 ? 'y' : 'ies'} for ${scopeLabel}`;
  }

  const toolList = Array.from(tools);
  if (toolList.length === 0) {
    return `Yes, always allow for ${scopeLabel}`;
  } else if (toolList.length === 1) {
    return `Yes, allow <${toolList[0]}> for ${scopeLabel}`;
  } else if (toolList.length === 2) {
    return `Yes, allow <${toolList[0]}> and <${toolList[1]}> for ${scopeLabel}`;
  } else {
    return `Yes, allow <${toolList[0]}> and ${toolList.length - 1} more for ${scopeLabel}`;
  }
}
```

#### 2.3 Handle Button Interactions

**File:** `discord-bot/src/handlers/buttons.ts`

**New Handlers:**

```typescript
// In button interaction handler
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isButton()) return;

  const customId = interaction.customId;

  // Permission button handlers
  if (customId.startsWith('perm-')) {
    await handlePermissionButton(interaction);
  }
});

async function handlePermissionButton(interaction: ButtonInteraction): Promise<void> {
  const customId = interaction.customId;
  const parts = customId.split('-');
  const action = parts[1];
  const requestId = parts[2];

  switch (action) {
    case 'yes':
    case 'submit':
    case 'auto-accept':
      await handleApprove(interaction, requestId);
      break;

    case 'always':
    case 'manual':
      await handleAlways(interaction, requestId);
      break;

    case 'no':
      await handleDeny(interaction, requestId);
      break;

    case 'scope':
      await handleScopeToggle(interaction, requestId);
      break;

    case 'tell':
      await handleTellClaude(interaction, requestId);
      break;
  }
}

async function handleApprove(
  interaction: ButtonInteraction,
  requestId: string
): Promise<void> {
  // Get pending request from store
  const request = await getPendingRequest(requestId);

  // Send approval to runner-agent
  await runnerAgent.send({
    type: 'permission_decision',
    data: {
      requestId,
      behavior: 'allow'
    }
  });

  await interaction.update({
    content: '✅ Approved',
    components: []
  });
}

async function handleAlways(
  interaction: ButtonInteraction,
  requestId: string
): Promise<void> {
  // Get pending request and current scope
  const request = await getPendingRequest(requestId);
  const scope = getCurrentScope(requestId);

  // Build updatedPermissions with scope
  const updatedPermissions = request.suggestions.map(s => ({
    ...s,
    destination: s.type === 'setMode' ? s.destination : scope
  }));

  // Send to runner-agent
  await runnerAgent.send({
    type: 'permission_decision',
    data: {
      requestId,
      behavior: 'allow',
      updatedPermissions
    }
  });

  await interaction.update({
    content: `✅ Approved for ${scope.scopeLabel}`,
    components: []
  });
}

async function handleScopeToggle(
  interaction: ButtonInteraction,
  requestId: string
): Promise<void> {
  // Cycle scope
  const newState = cycleScope(requestId);

  // Get pending request
  const request = await getPendingRequest(requestId);

  // Rebuild embed with new scope
  const newButtonText = buildAlwaysButtonText(request.suggestions, newState.scope);

  // Update button labels
  await interaction.update({
    components: rebuildButtonsWithScope(request, newState.scope)
  });
}

async function handleDeny(
  interaction: ButtonInteraction,
  requestId: string
): Promise<void> {
  // Send denial to runner-agent
  await runnerAgent.send({
    type: 'permission_decision',
    data: {
      requestId,
      behavior: 'deny'
    }
  });

  await interaction.update({
    content: '❌ Denied',
    components: []
  });
}

async function handleTellClaude(
  interaction: ButtonInteraction,
  requestId: string
): Promise<void> {
  // Show modal for custom message
  const modal = new ModalBuilder()
    .setCustomId(`perm-tell-modal-${requestId}`)
    .setTitle('Tell Claude what to do instead');

  const input = new TextInputBuilder()
    .setCustomId('custom-message')
    .setLabel('Your instructions')
    .setStyle(TextInputStyle.Paragraph)
    .setPlaceholder('Tell Claude what to do instead...')
    .setRequired(true);

  const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input);
  modal.addComponents(row);

  await interaction.showModal(modal);
}

// Handle modal submit
async function handleTellModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  const customId = interaction.customId;
  const requestId = customId.split('-')[3];
  const customMessage = interaction.fields.getTextInputValue('custom-message');

  // Send denial with custom message to runner-agent
  await runnerAgent.send({
    type: 'permission_decision',
    data: {
      requestId,
      behavior: 'deny',
      customMessage
    }
  });

  await interaction.reply({
    content: '❌ Denied with custom message',
    ephemeral: true
  });
}
```

#### 2.4 Store Permission UI State

**File:** `discord-bot/src/permissions/state-store.ts` (NEW)

```typescript
import { PermissionUIState, PermissionScope } from './ui-state.js';

interface RequestState {
  request: PermissionRequest;
  uiState: PermissionUIState;
  timestamp: number;
}

export class PermissionStateStore {
  private states: Map<string, RequestState> = new Map();
  private readonly TTL = 1000 * 60 * 15; // 15 minutes

  save(requestId: string, request: PermissionRequest): void {
    this.states.set(requestId, {
      request,
      uiState: new PermissionUIState(),
      timestamp: Date.now()
    });
  }

  get(requestId: string): RequestState | undefined {
    return this.states.get(requestId);
  }

  cycleScope(requestId: string): PermissionUIState {
    const state = this.states.get(requestId);
    if (!state) {
      throw new Error(`No state for request: ${requestId}`);
    }

    state.uiState.cycleScope();
    return state.uiState;
  }

  delete(requestId: string): void {
    this.states.delete(requestId);
  }

  // Cleanup expired states
  cleanup(): void {
    const now = Date.now();
    for (const [id, state] of this.states.entries()) {
      if (now - state.timestamp > this.TTL) {
        this.states.delete(id);
      }
    }
  }
}
```

---

## Part 3: Communication Between runner-agent and discord-bot

### Message Flow

```
Claude SDK → runner-agent → discord-bot → User → discord-bot → runner-agent → Claude SDK
```

### WebSocket/IPC Protocol

**File:** Shared types package or direct import

```typescript
// runner-agent → discord-bot
export interface ToDiscordBotMessage {
  type: 'permission_request';
  data: PermissionRequest;
}

// discord-bot → runner-agent
export interface ToRunnerAgentMessage {
  type: 'permission_decision';
  data: PermissionDecision;
}
```

---

## Implementation Steps

### Phase 1: Foundation (High Priority)

1. **runner-agent:**
   - [ ] Create `types/permissions.ts` with all interfaces
   - [ ] Update `approval.ts` to handle control requests properly
   - [ ] Add `request_id` tracking
   - [ ] Implement `processPermissionDecision` method
   - [ ] Create `permissions/store.ts` for permission rules

2. **discord-bot:**
   - [ ] Create `permissions/ui-state.ts`
   - [ ] Create `permissions/state-store.ts`
   - [ ] Update button handlers to support new permission flow
   - [ ] Implement basic approve/deny buttons

### Phase 2: "Always" Functionality (Medium Priority)

3. **runner-agent:**
   - [ ] Implement permission rule storage
   - [ ] Apply suggestions when received
   - [ ] Persist rules to file/database

4. **discord-bot:**
   - [ ] Implement scope toggle button
   - [ ] Build "Always" button text based on suggestions
   - [ ] Handle "Always" button click with scope

### Phase 3: Advanced Features (Low Priority)

5. **runner-agent:**
   - [ ] Handle `set_permission_mode` control requests
   - [ ] Handle `set_model` control requests
   - [ ] Handle `interrupt` control requests
   - [ ] Handle pending permission requests

6. **discord-bot:**
   - [ ] Implement "Tell Claude what to do" modal
   - [ ] Add permission mode indicators
   - [ ] Show current permission rules

---

## Testing Checklist

- [ ] Basic approve/deny works
- [ ] "Always" button saves permissions
- [ ] Scope toggle cycles correctly
- [ ] "Tell Claude" modal submits custom message
- [ ] Plan Mode permissions work correctly
- [ ] AskUserQuestion shows correct UI
- [ ] Multiple permission requests queue properly
- [ ] Permission rules persist across sessions
- [ ] Error handling for timeout/stale requests

---

## Open Questions

1. **Permission Persistence:** Where should permission rules be stored?
   - Options: JSON file, SQLite database, in-memory only
   - Recommendation: Start with JSON file, migrate to DB later

2. **Scope Implementation:**
   - VS Code extension saves to different files based on scope
   - For DisCode, should we:
     - Use Discord channel/guild as "project"?
     - Use Discord user ID as "user settings"?
     - Keep session-only permissions in memory?

3. **Suggestion Generation:**
   - VS Code extension's SDK generates suggestions
   - Does Claude Code SDK provide suggestions to runner-agent?
   - If not, we may need to generate them ourselves

4. **Permission Rule Format:**
   - Should we match VS Code extension's `.claude/settings.json` format?
   - Or create our own format optimized for Discord?

---

## References

- VS Code Extension Permission Flow: [PERMISSION_UI_FLOW.md](claude-code-ext/PERMISSION_UI_FLOW.md)
- Current runner-agent approval: [runner-agent/src/handlers/approval.ts](runner-agent/src/handlers/approval.ts)
- Current discord-bot buttons: [discord-bot/src/handlers/buttons.ts](discord-bot/src/handlers/buttons.ts)
- Current discord-bot modals: [discord-bot/src/handlers/modals.ts](discord-bot/src/handlers/modals.ts)
