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
    geminiDefaults?: Record<string, any>;
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
    const hasGeminiDefaults = !!data.geminiDefaults && typeof data.geminiDefaults === 'object';
    if (!hasClaudeDefaults && !hasCodexDefaults && !hasGeminiDefaults) {
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
    if (hasGeminiDefaults) {
        deps.config.geminiDefaults = data.geminiDefaults || {};
    }

    saveConfigFile({
        ...(hasClaudeDefaults ? { claudeDefaults } : {}),
        ...(hasCodexDefaults ? { codexDefaults: data.codexDefaults } : {}),
        ...(hasGeminiDefaults ? { geminiDefaults: data.geminiDefaults } : {})
    });

    deps.wsManager.send({
        type: 'runner_config_updated',
        data: {
            runnerId: deps.wsManager.runnerId,
            ...(hasClaudeDefaults ? { claudeDefaults } : {}),
            ...(hasCodexDefaults ? { codexDefaults: data.codexDefaults } : {}),
            ...(hasGeminiDefaults ? { geminiDefaults: data.geminiDefaults } : {}),
            warnings,
            requestId: data.requestId
        }
    });
}
