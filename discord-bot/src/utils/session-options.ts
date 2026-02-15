import type { RunnerInfo } from '../../../shared/types.js';

export interface SessionStartOptions {
    approvalMode?: 'manual' | 'auto';
    skipPermissions?: boolean;
    thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'auto' | 'default_on';
    approvalPolicy?: 'untrusted' | 'on-failure' | 'on-request' | 'never';
    reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
    reasoningSummary?: 'auto' | 'concise' | 'detailed' | 'none';
    [key: string]: any;
}

export function buildSessionStartOptions(
    runner: RunnerInfo | undefined,
    stateOptions?: SessionStartOptions,
    overrides?: Record<string, any>,
    cliType?: 'claude' | 'gemini' | 'codex' | 'terminal' | 'generic'
): Record<string, any> {
    const options: Record<string, any> = {
        ...(cliType === 'claude' ? (runner?.config?.claudeDefaults || {}) : {}),
        ...(cliType === 'codex' ? (runner?.config?.codexDefaults || {}) : {}),
        ...(cliType === 'gemini' ? (runner?.config?.geminiDefaults || {}) : {}),
        ...(stateOptions || {}),
        ...(overrides || {})
    };

    // Map UI approval mode -> runner option
    if (options.approvalMode === 'auto') {
        options.skipPermissions = true;
    } else if (options.approvalMode === 'manual') {
        options.skipPermissions = false;
    }

    if (options.skipPermissions === undefined && runner?.config?.yoloMode) {
        options.skipPermissions = true;
    }

    if (options.thinkingLevel === undefined && runner?.config?.thinkingLevel) {
        options.thinkingLevel = runner.config.thinkingLevel;
    }

    delete options.approvalMode;

    return options;
}
