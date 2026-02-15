/**
 * Model Catalog Handler
 *
 * Fetches available models from Claude/Codex clients for Discord UI selection.
 */

import type { WebSocketManager } from '../websocket.js';
import type { RunnerConfig } from '../config.js';
import type { CliPaths } from '../types.js';
import type { PluginManager } from '../plugins/index.js';
import type { CodexSDKPlugin } from '../plugins/codex-sdk-plugin.js';
import type { ClaudeSDKPlugin } from '../plugins/claude-sdk-plugin.js';

export interface ModelListRequestData {
    runnerId: string;
    cliType: 'claude' | 'codex';
    requestId?: string;
    cursor?: string | null;
    limit?: number | null;
}

function clampLimit(limit: number | null | undefined): number {
    if (!Number.isFinite(limit as number)) return 100;
    return Math.max(1, Math.min(200, Number(limit)));
}

interface ModelListFetchResult {
    models?: Array<{ id: string; label: string; description?: string; isDefault?: boolean }>;
    defaultModel?: string | null;
    nextCursor?: string | null;
    error?: string;
}

const inFlightModelListFetches = new Map<string, Promise<ModelListFetchResult>>();

function getModelListFetchKey(
    runnerId: string,
    cliType: 'claude' | 'codex',
    cursor: string | null,
    limit: number
): string {
    return `${runnerId}:${cliType}:${cursor ?? ''}:${limit}`;
}

export async function handleModelListRequest(
    data: ModelListRequestData,
    deps: {
        wsManager: WebSocketManager;
        config: RunnerConfig;
        cliPaths: CliPaths;
        pluginManager: PluginManager | null;
    }
): Promise<void> {
    if (!data || data.runnerId !== deps.wsManager.runnerId) return;

    if (!deps.pluginManager) {
        deps.wsManager.send({
            type: 'model_list_response',
            data: {
                runnerId: deps.wsManager.runnerId,
                cliType: data.cliType,
                requestId: data.requestId,
                error: 'PluginManager is not available.'
            }
        });
        return;
    }

    const cursor = data.cursor ?? null;
    const limit = clampLimit(data.limit);
    const fetchKey = getModelListFetchKey(deps.wsManager.runnerId, data.cliType, cursor, limit);

    let fetchPromise = inFlightModelListFetches.get(fetchKey);
    if (!fetchPromise) {
        fetchPromise = (async (): Promise<ModelListFetchResult> => {
            try {
                if (data.cliType === 'codex') {
                    const codexPath = deps.cliPaths.codex;
                    if (!codexPath) {
                        throw new Error('Codex CLI path not detected.');
                    }

                    const plugin = deps.pluginManager!.getPlugin<CodexSDKPlugin>('codex-sdk');
                    if (!plugin) {
                        throw new Error('Codex SDK plugin not available.');
                    }

                    const response = await plugin.listModels(codexPath, { cursor, limit });
                    const models = response.data
                        .map(model => {
                            const id = model.model || model.id;
                            if (!id) return null;
                            return {
                                id,
                                label: model.displayName || id,
                                description: model.description || undefined,
                                isDefault: Boolean(model.isDefault)
                            };
                        })
                        .filter((model): model is NonNullable<typeof model> => model !== null);

                    return {
                        models,
                        defaultModel: models.find(model => model.isDefault)?.id || null,
                        nextCursor: response.nextCursor ?? null
                    };
                }

                const claudePath = deps.cliPaths.claude;
                if (!claudePath) {
                    throw new Error('Claude CLI path not detected.');
                }

                const plugin = deps.pluginManager!.getPlugin<ClaudeSDKPlugin>('claude-sdk');
                if (!plugin) {
                    throw new Error('Claude SDK plugin not available.');
                }

                const cwd = deps.config.defaultWorkspace || process.cwd();
                const response = await plugin.listModels(claudePath, cwd);

                return {
                    models: response.models,
                    defaultModel: response.defaultModel ?? null,
                    nextCursor: null
                };
            } catch (error) {
                return {
                    error: error instanceof Error ? error.message : String(error)
                };
            }
        })();

        inFlightModelListFetches.set(fetchKey, fetchPromise);
        fetchPromise.finally(() => {
            if (inFlightModelListFetches.get(fetchKey) === fetchPromise) {
                inFlightModelListFetches.delete(fetchKey);
            }
        });
    }

    const result = await fetchPromise;
    deps.wsManager.send({
        type: 'model_list_response',
        data: {
            runnerId: deps.wsManager.runnerId,
            cliType: data.cliType,
            requestId: data.requestId,
            models: result.models,
            defaultModel: result.defaultModel ?? null,
            nextCursor: result.nextCursor ?? null,
            error: result.error
        }
    });
}
