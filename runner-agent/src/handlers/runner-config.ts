/**
 * Runner Config Handler
 *
 * Handles updates to runner configuration (claudeDefaults).
 */

import { normalizeClaudeOptions } from '../utils/session-options.js';
import { saveConfigFile } from '../config.js';
import type { RunnerConfig } from '../config.js';
import type { WebSocketManager } from '../websocket.js';

export interface RunnerConfigUpdateData {
    runnerId: string;
    claudeDefaults?: Record<string, any>;
    codexDefaults?: Record<string, any>;
    requestId?: string;
}

export async function handleRunnerConfigUpdate(
    data: RunnerConfigUpdateData,
    deps: { config: RunnerConfig; wsManager: WebSocketManager }
): Promise<void> {
    if (!data || data.runnerId !== deps.wsManager.runnerId) {
        console.warn('[RunnerConfig] Ignoring update for mismatched runnerId.');
        return;
    }

    const hasClaudeDefaults = !!data.claudeDefaults && typeof data.claudeDefaults === 'object';
    const hasCodexDefaults = !!data.codexDefaults && typeof data.codexDefaults === 'object';
    if (!hasClaudeDefaults && !hasCodexDefaults) {
        console.warn('[RunnerConfig] No defaults provided; ignoring update.');
        return;
    }

    let warnings: string[] = [];
    let claudeDefaults = deps.config.claudeDefaults;
    if (hasClaudeDefaults) {
        const normalized = normalizeClaudeOptions(data.claudeDefaults as any);
        if (normalized.warnings.length > 0) {
            console.warn(`[RunnerConfig] Ignored invalid claudeDefaults: ${normalized.warnings.join(' ')}`);
            warnings = normalized.warnings;
        }
        claudeDefaults = normalized.options;
        deps.config.claudeDefaults = normalized.options;
    }

    if (hasCodexDefaults) {
        deps.config.codexDefaults = data.codexDefaults || {};
    }

    saveConfigFile({
        ...(hasClaudeDefaults ? { claudeDefaults } : {}),
        ...(hasCodexDefaults ? { codexDefaults: data.codexDefaults } : {})
    });

    deps.wsManager.send({
        type: 'runner_config_updated',
        data: {
            runnerId: deps.wsManager.runnerId,
            ...(hasClaudeDefaults ? { claudeDefaults } : {}),
            ...(hasCodexDefaults ? { codexDefaults: data.codexDefaults } : {}),
            warnings,
            requestId: data.requestId
        }
    });
}
