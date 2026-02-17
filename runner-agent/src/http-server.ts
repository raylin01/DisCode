/**
 * HTTP Server for Runner Agent
 *
 * Handles approval requests, session events, and hook events from CLI plugins.
 */

import http from 'http';
import type { ApprovalRequest } from '../../shared/types.js';
import type { HookEvent } from './plugins/base.js';
import type { PendingApproval, PendingMessage } from './types.js';
import type { WebSocketManager } from './websocket.js';
import type { PluginManager } from './plugins/index.js';

export interface HttpServerConfig {
    port: number;
    runnerId: string;
    runnerName: string;
    cliTypes: ('claude' | 'gemini' | 'codex')[];
    approvalTimeout: number;
}

export interface HttpServerDependencies {
    wsManager: WebSocketManager;
    pluginManager: PluginManager | null;
    pendingApprovals: Map<string, PendingApproval>;
    pendingMessages: Map<string, PendingMessage[]>;
}

interface RouteContext {
    req: http.IncomingMessage;
    res: http.ServerResponse;
    url: URL;
    config: HttpServerConfig;
    deps: HttpServerDependencies;
}

/**
 * Read JSON body from request
 */
function readRequestBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

/**
 * Send JSON response
 */
function sendJsonResponse(res: http.ServerResponse, data: any, statusCode: number = 200): void {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(JSON.stringify(data));
}

/**
 * Wait for approval response with timeout
 */
function waitForApproval(
    requestId: string,
    timeout: number,
    pendingApprovals: Map<string, PendingApproval>
): Promise<{ allow: boolean; message?: string }> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            pendingApprovals.delete(requestId);
            reject(new Error('Approval request timeout'));
        }, timeout);

        pendingApprovals.set(requestId, {
            resolve: (response) => {
                clearTimeout(timer);
                resolve(response);
            },
            reject: (error) => {
                clearTimeout(timer);
                reject(error);
            }
        });
    });
}

// Route handlers

async function handleHealthCheck(ctx: RouteContext): Promise<void> {
    sendJsonResponse(ctx.res, {
        name: 'DisCode Runner Agent',
        version: '0.1.0',
        runnerId: ctx.config.runnerId,
        runnerName: ctx.config.runnerName,
        cliTypes: ctx.config.cliTypes,
        connected: ctx.deps.wsManager.isConnected
    });
}

async function handleApproval(ctx: RouteContext): Promise<void> {
    const { res, config, deps } = ctx;
    const { wsManager, pluginManager, pendingApprovals } = deps;

    try {
        const rawData = await readRequestBody(ctx.req);

        // Handle both snake_case and camelCase
        const approvalReq: ApprovalRequest = {
            toolName: (rawData.tool_name || rawData.toolName) as string,
            toolInput: rawData.tool_input || rawData.toolInput,
            sessionId: rawData.session_id || rawData.sessionId,
            timestamp: rawData.timestamp || new Date().toISOString(),
            cli: rawData.cli,
            runnerId: rawData.runner_id || rawData.runnerId
        };

        console.log(`Received approval request for tool: ${approvalReq.toolName}`);
        console.log(`Session ID: ${approvalReq.sessionId}`);

        if (!wsManager.isConnected) {
            sendJsonResponse(res, { allow: false, message: 'Not connected to Discord bot' }, 503);
            return;
        }

        // SDK sessions handle approvals via plugin events
        if (pluginManager) {
            const pluginType = pluginManager.getSessionPluginType(approvalReq.sessionId);
            if (pluginType === 'claude-sdk' || pluginType === 'codex-sdk' || pluginType === 'gemini-sdk') {
                console.log(`[HttpServer] Skipping HTTP approval for SDK session ${approvalReq.sessionId}`);
                sendJsonResponse(res, { allow: true, message: 'Handled by SDK plugin' });
                return;
            }
        }

        const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(7)}`;
        console.log(`Sending approval request ${requestId} to Discord bot...`);

        const sent = wsManager.send({
            type: 'approval_request',
            data: {
                requestId,
                sessionId: approvalReq.sessionId,
                runnerId: wsManager.runnerId,
                toolName: approvalReq.toolName,
                toolInput: approvalReq.toolInput,
                cli: approvalReq.cli,
                timestamp: approvalReq.timestamp
            }
        });

        if (!sent) {
            sendJsonResponse(res, { allow: false, message: 'Not connected to Discord bot' }, 503);
            return;
        }

        console.log(`Approval request ${requestId} sent to Discord bot`);

        let responseSent = false;
        try {
            const timeoutPromise = new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Approval timeout')), config.approvalTimeout)
            );

            const approvalPromise = waitForApproval(requestId, config.approvalTimeout, pendingApprovals);
            const response = await Promise.race([approvalPromise, timeoutPromise]) as { allow: boolean; message?: string };

            sendJsonResponse(res, response);
            responseSent = true;

            if (!response.allow) {
                console.log(`Approval ${requestId} denied: ${response.message}`);
            }
        } catch (error: any) {
            console.error('Approval request error or timeout:', error.message);
            if (!responseSent) {
                sendJsonResponse(res, { allow: false, message: error.message || 'Approval request timeout' }, 500);
            }
        }
    } catch (error) {
        console.error('Error handling approval request:', error);
        if (!res.headersSent) {
            sendJsonResponse(res, { allow: false, message: 'Error processing approval request' }, 500);
        }
    }
}

async function handleSessionEvent(ctx: RouteContext): Promise<void> {
    const { res, deps } = ctx;

    try {
        const event = await readRequestBody(ctx.req);
        console.log(`Session event: ${event.type} - ${event.action}`);

        if (event.type === 'discord_action') {
            const sent = deps.wsManager.send({ type: 'discord_action', data: event });
            if (!sent) {
                sendJsonResponse(res, { error: 'Failed to send to Discord bot (not connected)' }, 503);
                return;
            }
        }

        sendJsonResponse(res, { success: true });
    } catch (error) {
        console.error('Error handling session event:', error);
        sendJsonResponse(res, { error: 'Invalid request' }, 400);
    }
}

async function handleGetMessages(ctx: RouteContext): Promise<void> {
    const { res, url, deps } = ctx;
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId) {
        sendJsonResponse(res, { error: 'sessionId parameter is required' }, 400);
        return;
    }

    const messages = deps.pendingMessages.get(sessionId) || [];
    deps.pendingMessages.set(sessionId, []);

    sendJsonResponse(res, { messages, count: messages.length });
}

async function handleOutput(ctx: RouteContext): Promise<void> {
    const { res, config, deps } = ctx;

    try {
        const data = await readRequestBody(ctx.req);

        deps.wsManager.send({
            type: 'output',
            data: {
                runnerId: config.runnerId,
                sessionId: data.sessionId,
                content: data.content,
                timestamp: new Date().toISOString()
            }
        });

        sendJsonResponse(res, { success: true });
    } catch (error) {
        console.error('Error handling output:', error);
        sendJsonResponse(res, { error: 'Invalid request' }, 400);
    }
}

async function handleHook(ctx: RouteContext): Promise<void> {
    const { res, deps } = ctx;

    try {
        const event = await readRequestBody(ctx.req) as HookEvent;
        console.log(`[Hook] Received ${event.type} for session ${event.sessionId || 'unknown'}`);

        if (deps.pluginManager) {
            deps.pluginManager.emit('hook_event', event);
        }

        sendJsonResponse(res, { success: true });
    } catch (error) {
        console.error('Error handling hook event:', error);
        sendJsonResponse(res, { error: 'Invalid request' }, 400);
    }
}

async function handleSpawnThread(ctx: RouteContext): Promise<void> {
    const { res, deps } = ctx;

    try {
        const data = await readRequestBody(ctx.req);
        const { folder, cliType, message } = data;

        if (!folder) {
            sendJsonResponse(res, { error: 'folder is required' }, 400);
            return;
        }

        if (!deps.wsManager.isConnected) {
            sendJsonResponse(res, { error: 'Not connected to Discord bot' }, 503);
            return;
        }

        console.log(`[SpawnThread] Spawning thread in folder: ${folder}, CLI: ${cliType || 'auto'}`);

        const sent = deps.wsManager.send({
            type: 'spawn_thread',
            data: {
                runnerId: deps.wsManager.runnerId,
                folder: folder,
                cliType: cliType || 'auto',
                initialMessage: message || undefined
            }
        });

        if (!sent) {
            sendJsonResponse(res, { error: 'Failed to send spawn request' }, 500);
            return;
        }

        sendJsonResponse(res, { success: true, message: 'Thread spawn request sent' });
    } catch (error) {
        console.error('Error handling spawn-thread:', error);
        sendJsonResponse(res, { error: 'Invalid request' }, 400);
    }
}

// Route table
type RouteHandler = (ctx: RouteContext) => Promise<void>;

interface Route {
    method: string;
    path: string;
    handler: RouteHandler;
}

const ROUTES: Route[] = [
    { method: 'GET', path: '/', handler: handleHealthCheck },
    { method: 'POST', path: '/approval', handler: handleApproval },
    { method: 'POST', path: '/session-event', handler: handleSessionEvent },
    { method: 'GET', path: '/messages', handler: handleGetMessages },
    { method: 'POST', path: '/output', handler: handleOutput },
    { method: 'POST', path: '/hook', handler: handleHook },
    { method: 'POST', path: '/spawn-thread', handler: handleSpawnThread },
];

export function createHttpServer(
    config: HttpServerConfig,
    deps: HttpServerDependencies
): http.Server {
    const server = http.createServer(async (req, res) => {
        // Handle CORS preflight
        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
            });
            res.end();
            return;
        }

        const url = new URL(req.url || '', `http://${req.headers.host}`);
        const ctx: RouteContext = { req, res, url, config, deps };

        // Find matching route
        const route = ROUTES.find(r => r.method === req.method && r.path === url.pathname);

        if (route) {
            await route.handler(ctx);
        } else {
            sendJsonResponse(res, { error: 'Not found' }, 404);
        }
    });

    return server;
}
