import type { RunnerInfo } from '../../../shared/types.js';

export interface SessionStartOptions {
    approvalMode?: 'manual' | 'auto';
    skipPermissions?: boolean;
    thinkingLevel?: 'off' | 'low' | 'medium' | 'high' | 'auto' | 'default_on';
    [key: string]: any;
}

export function buildSessionStartOptions(
    runner: RunnerInfo | undefined,
    stateOptions?: SessionStartOptions,
    overrides?: Record<string, any>
): Record<string, any> {
    const options: Record<string, any> = {
        ...(runner?.config?.claudeDefaults || {}),
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
