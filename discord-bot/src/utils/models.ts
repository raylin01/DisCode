import * as botState from '../state.js';
import { storage } from '../storage.js';

export type ModelCatalogCliType = 'claude' | 'codex';

export interface RunnerModelOption {
    id: string;
    label: string;
    description?: string;
    isDefault?: boolean;
}

export interface FetchRunnerModelsResult {
    models: RunnerModelOption[];
    defaultModel: string | null;
    nextCursor: string | null;
    error?: string;
}

const MODEL_CACHE_TTL_MS = 2 * 60 * 1000;
export const AUTO_MODEL_VALUE = '__auto__';

function normalizeModelList(models: any[]): RunnerModelOption[] {
    const normalized: RunnerModelOption[] = [];
    const seen = new Set<string>();

    for (const model of models) {
        if (!model || typeof model !== 'object') continue;
        const id = typeof model.id === 'string' ? model.id.trim() : '';
        if (!id || seen.has(id)) continue;
        const label = typeof model.label === 'string' && model.label.trim().length > 0
            ? model.label.trim()
            : id;
        const description = typeof model.description === 'string' && model.description.trim().length > 0
            ? model.description.trim()
            : undefined;
        seen.add(id);
        normalized.push({
            id,
            label,
            description,
            isDefault: Boolean(model.isDefault)
        });
    }

    normalized.sort((a, b) => {
        if (a.isDefault && !b.isDefault) return -1;
        if (!a.isDefault && b.isDefault) return 1;
        return a.label.localeCompare(b.label);
    });

    return normalized;
}

export async function fetchRunnerModels(
    runnerId: string,
    cliType: ModelCatalogCliType,
    options?: {
        forceRefresh?: boolean;
        limit?: number;
        cursor?: string | null;
        timeoutMs?: number;
    }
): Promise<FetchRunnerModelsResult> {
    const forceRefresh = options?.forceRefresh === true;
    const cacheKey = `${runnerId}:${cliType}`;
    const cache = botState.runnerModelCache.get(cacheKey);
    const now = Date.now();
    if (!forceRefresh && cache && now - cache.fetchedAt < MODEL_CACHE_TTL_MS) {
        return {
            models: cache.models,
            defaultModel: cache.defaultModel ?? null,
            nextCursor: cache.nextCursor ?? null
        };
    }

    const runner = storage.getRunner(runnerId);
    if (!runner) {
        return {
            models: [],
            defaultModel: null,
            nextCursor: null,
            error: 'Runner not found.'
        };
    }

    const ws = botState.runnerConnections.get(runnerId);
    if (!ws) {
        return {
            models: [],
            defaultModel: null,
            nextCursor: null,
            error: 'Runner is offline.'
        };
    }

    const requestId = `models_${runnerId}_${cliType}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timeoutMs = Math.max(3000, options?.timeoutMs || 12000);

    const data = await new Promise<any | null>((resolve) => {
        const timeout = setTimeout(() => {
            botState.pendingModelListRequests.delete(requestId);
            resolve(null);
        }, timeoutMs);

        botState.pendingModelListRequests.set(requestId, { resolve, timeout });
        ws.send(JSON.stringify({
            type: 'model_list_request',
            data: {
                runnerId,
                cliType,
                requestId,
                limit: options?.limit ?? 100,
                cursor: options?.cursor ?? null
            }
        }));
    });

    if (!data) {
        return {
            models: [],
            defaultModel: null,
            nextCursor: null,
            error: 'Runner timed out while fetching models.'
        };
    }

    if (data.error) {
        return {
            models: [],
            defaultModel: null,
            nextCursor: null,
            error: String(data.error)
        };
    }

    const models = normalizeModelList(Array.isArray(data.models) ? data.models : []);
    return {
        models,
        defaultModel: typeof data.defaultModel === 'string' ? data.defaultModel : null,
        nextCursor: typeof data.nextCursor === 'string' ? data.nextCursor : null
    };
}

