import type { RunnerInfo } from '../../../shared/types.js';
import { projectSettingsStore } from '../services/project-settings.js';

export interface SessionStartOptions {
    approvalMode?: 'manual' | 'autoSafe' | 'auto';
    skipPermissions?: boolean;
    thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'auto' | 'default_on';
    approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
    reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    reasoningSummary?: 'auto' | 'concise' | 'detailed' | 'none';
    [key: string]: any;
}

type ApprovalModeSetting = 'manual' | 'autoSafe' | 'yolo';
type ApprovalModeSource = 'explicit' | 'project' | 'runner' | 'legacy_yolo' | 'none';
type EditPermissionMode = 'default' | 'acceptEdits';

const APPROVAL_MODE_VALUES = new Set<ApprovalModeSetting>(['manual', 'autoSafe', 'yolo']);
const EDIT_PERMISSION_MODE_VALUES = new Set<EditPermissionMode>(['default', 'acceptEdits']);
const UI_APPROVAL_MODE_VALUES = new Set(['manual', 'autoSafe', 'auto']);

function isApprovalMode(value: unknown): value is ApprovalModeSetting {
    return typeof value === 'string' && APPROVAL_MODE_VALUES.has(value as ApprovalModeSetting);
}

function isEditPermissionMode(value: unknown): value is EditPermissionMode {
    return typeof value === 'string' && EDIT_PERMISSION_MODE_VALUES.has(value as EditPermissionMode);
}

function resolveApprovalMode(
    options: Record<string, any>,
    projectApprovalMode: unknown,
    runnerApprovalMode: unknown,
    runnerYoloEnabled: boolean
): { mode: ApprovalModeSetting; source: ApprovalModeSource } {
    const explicitApproval = options.approvalMode === 'auto' ? 'yolo' : options.approvalMode;
    if (isApprovalMode(explicitApproval)) return { mode: explicitApproval, source: 'explicit' };

    if (isApprovalMode(options.permissionMode)) return { mode: options.permissionMode, source: 'explicit' };
    if (isApprovalMode(projectApprovalMode)) return { mode: projectApprovalMode, source: 'project' };
    if (isApprovalMode(runnerApprovalMode)) return { mode: runnerApprovalMode, source: 'runner' };
    if (runnerYoloEnabled) return { mode: 'yolo', source: 'legacy_yolo' };

    return { mode: 'manual', source: 'none' };
}

function resolveEditPermissionMode(
    options: Record<string, any>,
    projectEditMode: unknown,
    runnerEditMode: unknown
): EditPermissionMode | undefined {
    if (isEditPermissionMode(options.permissionMode)) return options.permissionMode;
    if (isEditPermissionMode(options.editAcceptMode)) return options.editAcceptMode;
    if (isEditPermissionMode(projectEditMode)) return projectEditMode;
    if (isEditPermissionMode(runnerEditMode)) return runnerEditMode;
    return undefined;
}

export function buildSessionStartOptions(
    runner: RunnerInfo | undefined,
    stateOptions?: SessionStartOptions,
    overrides?: Record<string, any>,
    cliType?: 'claude' | 'gemini' | 'codex' | 'terminal' | 'generic',
    projectPath?: string
): Record<string, any> {
    // Get project defaults if projectPath is provided
    const projectConfig = projectPath && runner?.runnerId
        ? projectSettingsStore.getConfig(runner.runnerId, projectPath)
        : {};
    const runnerClaudeDefaults = runner?.config?.claudeDefaults || {};
    const runnerApprovalMode = cliType === 'claude' ? runnerClaudeDefaults.permissionMode : undefined;
    const runnerEditMode = cliType === 'claude' ? runnerClaudeDefaults.editAcceptMode : undefined;
    const projectApprovalMode = projectConfig.permissionMode;
    const projectEditMode = projectConfig.editAcceptMode;

    // Merge in order of priority (lowest to highest):
    // 1. CLI-specific runner defaults
    // 2. Project defaults (override runner)
    // 3. State options (from wizard/UI)
    // 4. Explicit overrides
    const options: Record<string, any> = {
        // 1. CLI-specific runner defaults (lowest priority)
        ...(cliType === 'claude' ? (runner?.config?.claudeDefaults || {}) : {}),
        ...(cliType === 'codex' ? (runner?.config?.codexDefaults || {}) : {}),
        ...(cliType === 'gemini' ? (runner?.config?.geminiDefaults || {}) : {}),

        // 2. Project defaults (override runner defaults)
        ...(cliType === 'claude' ? (projectConfig.claudeDefaults || {}) : {}),
        ...(cliType === 'codex' ? (projectConfig.codexDefaults || {}) : {}),
        ...(cliType === 'gemini' ? (projectConfig.geminiDefaults || {}) : {}),
        // Apply top-level project settings
        ...(projectConfig.permissionMode ? { permissionMode: projectConfig.permissionMode } : {}),
        ...(projectConfig.editAcceptMode ? { editAcceptMode: projectConfig.editAcceptMode } : {}),
        ...(projectConfig.thinkingLevel ? { thinkingLevel: projectConfig.thinkingLevel } : {}),
        ...(projectConfig.model ? { model: projectConfig.model } : {}),
        ...(projectConfig.maxTurns ? { maxTurns: projectConfig.maxTurns } : {}),
        ...(projectConfig.maxThinkingTokens ? { maxThinkingTokens: projectConfig.maxThinkingTokens } : {}),

        // 3. State options (from session wizard)
        ...(stateOptions || {}),

        // 4. Explicit overrides (highest priority)
        ...(overrides || {})
    };

    // Resolve approval mode (manual/autoSafe/yolo) separately from edit mode (default/acceptEdits).
    const { mode: approvalMode, source: approvalSource } = resolveApprovalMode(
        options,
        projectApprovalMode,
        runnerApprovalMode,
        Boolean(runner?.config?.yoloMode)
    );
    const editPermissionMode = resolveEditPermissionMode(
        options,
        projectEditMode,
        runnerEditMode
    );

    // Map approval mode to runtime controls.
    if (approvalMode === 'yolo') {
        options.skipPermissions = true;
        delete options.autoApproveSafe;
    } else if (approvalMode === 'autoSafe') {
        // autoSafe mode: skip permissions for safe tools only
        options.skipPermissions = false;
        options.autoApproveSafe = true;
    } else {
        options.skipPermissions = false;
    }

    // Ensure CLI-specific approval options align with the selected approval mode when one is configured.
    if (approvalSource !== 'none') {
        if (cliType === 'codex') {
            options.approvalPolicy = approvalMode === 'yolo' ? 'never' : 'on-request';
        } else if (cliType === 'gemini') {
            options.approvalMode = approvalMode === 'yolo' ? 'yolo' : 'default';
        }
    }

    // Map edit-accept behavior to runtime permissionMode used by SDK plugins.
    if (editPermissionMode) {
        options.permissionMode = editPermissionMode;
    } else if (isApprovalMode(options.permissionMode)) {
        delete options.permissionMode;
    }

    if (options.thinkingLevel === undefined && runner?.config?.thinkingLevel) {
        options.thinkingLevel = runner.config.thinkingLevel;
    }

    if (typeof options.approvalMode === 'string' && UI_APPROVAL_MODE_VALUES.has(options.approvalMode)) {
        delete options.approvalMode;
    }
    delete options.editAcceptMode;

    return options;
}
