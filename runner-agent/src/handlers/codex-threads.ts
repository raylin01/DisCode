/**
 * Codex Thread Listing Handler
 *
 * Lists codex threads via codex-client (app-server).
 */

import type { WebSocketManager } from '../websocket.js';
import type { CliPaths } from '../types.js';
import type { PluginManager } from '../plugins/index.js';
import type { CodexSDKPlugin } from '../plugins/codex-sdk-plugin.js';

export interface CodexThreadListRequestData {
    runnerId: string;
    requestId?: string;
    cursor?: string | null;
    limit?: number | null;
    sortKey?: 'created_at' | 'updated_at' | null;
    archived?: boolean | null;
}

export async function handleCodexThreadListRequest(
    data: CodexThreadListRequestData,
    deps: { wsManager: WebSocketManager; cliPaths: CliPaths; pluginManager: PluginManager | null }
): Promise<void> {
    if (!data || data.runnerId !== deps.wsManager.runnerId) return;

    const codexPath = deps.cliPaths.codex;
    if (!codexPath) {
        deps.wsManager.send({
            type: 'codex_thread_list_response',
            data: {
                runnerId: deps.wsManager.runnerId,
                requestId: data.requestId,
                error: 'Codex CLI path not detected.'
            }
        });
        return;
    }

    if (!deps.pluginManager) {
        deps.wsManager.send({
            type: 'codex_thread_list_response',
            data: {
                runnerId: deps.wsManager.runnerId,
                requestId: data.requestId,
                error: 'PluginManager is not available.'
            }
        });
        return;
    }

    const plugin = deps.pluginManager.getPlugin<CodexSDKPlugin>('codex-sdk');
    if (!plugin) {
        deps.wsManager.send({
            type: 'codex_thread_list_response',
            data: {
                runnerId: deps.wsManager.runnerId,
                requestId: data.requestId,
                error: 'Codex SDK plugin not available.'
            }
        });
        return;
    }

    try {
        const response = await plugin.listThreads(codexPath, {
            cursor: data.cursor ?? null,
            limit: data.limit ?? null,
            sortKey: data.sortKey ?? null,
            archived: data.archived ?? null
        });

        const threads = response.data.map(thread => ({
            id: thread.id,
            preview: thread.preview,
            cwd: thread.cwd,
            updatedAt: thread.updatedAt,
            createdAt: thread.createdAt,
            modelProvider: thread.modelProvider,
            path: thread.path ?? null
        }));

        deps.wsManager.send({
            type: 'codex_thread_list_response',
            data: {
                runnerId: deps.wsManager.runnerId,
                requestId: data.requestId,
                threads,
                nextCursor: response.nextCursor ?? null
            }
        });
    } catch (error) {
        deps.wsManager.send({
            type: 'codex_thread_list_response',
            data: {
                runnerId: deps.wsManager.runnerId,
                requestId: data.requestId,
                error: error instanceof Error ? error.message : String(error)
            }
        });
    }
}
