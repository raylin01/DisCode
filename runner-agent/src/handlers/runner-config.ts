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
}

export async function handleRunnerConfigUpdate(
    data: RunnerConfigUpdateData,
    deps: { config: RunnerConfig; wsManager: WebSocketManager }
): Promise<void> {
    if (!data || data.runnerId !== deps.wsManager.runnerId) {
        console.warn('[RunnerConfig] Ignoring update for mismatched runnerId.');
        return;
    }

    if (!data.claudeDefaults || typeof data.claudeDefaults !== 'object') {
        console.warn('[RunnerConfig] No claudeDefaults provided; ignoring update.');
        return;
    }

    const normalized = normalizeClaudeOptions(data.claudeDefaults as any);
    if (normalized.warnings.length > 0) {
        console.warn(`[RunnerConfig] Ignored invalid claudeDefaults: ${normalized.warnings.join(' ')}`);
    }

    deps.config.claudeDefaults = normalized.options;
    saveConfigFile({ claudeDefaults: normalized.options });

    deps.wsManager.send({
        type: 'runner_config_updated',
        data: {
            runnerId: deps.wsManager.runnerId,
            claudeDefaults: normalized.options,
            warnings: normalized.warnings
        }
    });
}
