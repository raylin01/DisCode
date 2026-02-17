/**
 * Shared types and constants for WebSocket handlers
 */

export const OFFLINE_GRACE_MS = parseInt(process.env.DISCODE_OFFLINE_GRACE_MS || '45000');
export const WS_PING_INTERVAL_MS = parseInt(process.env.DISCODE_WS_PING_INTERVAL || '30000');
export const WS_PING_TIMEOUT_MS = parseInt(process.env.DISCODE_WS_PING_TIMEOUT || '90000');

// Runner offline timers (exported for use across handlers)
export const runnerOfflineTimers = new Map<string, NodeJS.Timeout>();

/**
 * Check if an error is an invalid webhook token error
 */
export function isInvalidWebhookTokenError(error: any): boolean {
    return (
        error?.code === 50027 ||
        error?.rawError?.code === 50027 ||
        error?.code === 10015 ||
        error?.rawError?.code === 10015
    );
}
