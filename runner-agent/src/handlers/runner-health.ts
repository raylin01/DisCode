import os from 'os';
import fs from 'fs';
import type { WebSocketManager } from '../websocket.js';
import type { RunnerConfig } from '../config.js';

export interface RunnerHealthRequestData {
    runnerId: string;
    requestId?: string;
}

export function handleRunnerHealthRequest(
    data: RunnerHealthRequestData,
    deps: { config: RunnerConfig; wsManager: WebSocketManager; cliPaths: Record<'claude' | 'gemini' | 'codex', string | null> }
): void {
    if (!data || data.runnerId !== deps.wsManager.runnerId) return;

    const uptimeSec = process.uptime();
    const freeMem = os.freemem();
    const totalMem = os.totalmem();
    const load = os.loadavg();

    deps.wsManager.send({
        type: 'runner_health_response',
        data: {
            runnerId: deps.wsManager.runnerId,
            requestId: data.requestId,
            info: {
                hostname: os.hostname(),
                platform: os.platform(),
                arch: os.arch(),
                cpuCount: os.cpus().length,
                loadAvg: load,
                uptimeSec,
                freeMem,
                totalMem,
                cliPaths: deps.cliPaths,
                assistantEnabled: deps.config.assistant.enabled
            }
        }
    });
}

export interface RunnerLogsRequestData {
    runnerId: string;
    requestId?: string;
    maxBytes?: number;
}

export function handleRunnerLogsRequest(
    data: RunnerLogsRequestData,
    deps: { wsManager: WebSocketManager }
): void {
    if (!data || data.runnerId !== deps.wsManager.runnerId) return;
    const logPath = process.env.DISCODE_RUNNER_LOG_PATH;
    const maxBytes = Math.min(Number(data.maxBytes || 20000), 200000);

    if (!logPath || !fs.existsSync(logPath)) {
        deps.wsManager.send({
            type: 'runner_logs_response',
            data: {
                runnerId: deps.wsManager.runnerId,
                requestId: data.requestId,
                error: 'DISCODE_RUNNER_LOG_PATH not set or file not found.'
            }
        });
        return;
    }

    try {
        const stats = fs.statSync(logPath);
        const start = Math.max(0, stats.size - maxBytes);
        const buffer = fs.readFileSync(logPath).slice(start).toString('utf-8');
        deps.wsManager.send({
            type: 'runner_logs_response',
            data: {
                runnerId: deps.wsManager.runnerId,
                requestId: data.requestId,
                logPath,
                content: buffer
            }
        });
    } catch (error) {
        deps.wsManager.send({
            type: 'runner_logs_response',
            data: {
                runnerId: deps.wsManager.runnerId,
                requestId: data.requestId,
                error: error instanceof Error ? error.message : String(error)
            }
        });
    }
}
