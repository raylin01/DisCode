/**
 * Button Utilities
 * 
 * Helpers for creating and parsing self-healing button customIds.
 * 
 * customId format: `<action>:<requestId>:<runnerId>:<sessionId>`
 * Max 100 chars. If the full ID exceeds 100 chars, components are truncated.
 * 
 * For simple buttons without approval context (session creation, dashboard, etc.),
 * the legacy format is preserved: `<prefix>_<value>`.
 */

/**
 * Parsed button ID with all recoverable context
 */
export interface ParsedButtonId {
    action: string;
    requestId: string;
    runnerId: string;
    sessionId: string;
}

const MAX_CUSTOM_ID_LENGTH = 100;
const SEPARATOR = ':';

/**
 * Build a self-healing button customId that encodes recovery context.
 * Format: `action:requestId:runnerId:sessionId`
 * 
 * If the full ID exceeds 100 chars, runnerId and sessionId are truncated.
 */
export function buildButtonId(
    action: string,
    requestId: string,
    runnerId: string,
    sessionId: string
): string {
    const full = [action, requestId, runnerId, sessionId].join(SEPARATOR);
    if (full.length <= MAX_CUSTOM_ID_LENGTH) {
        return full;
    }

    // Truncation strategy: action and requestId are essential, truncate runner/session IDs
    const fixedLen = action.length + requestId.length + 3; // 3 separators
    const remaining = MAX_CUSTOM_ID_LENGTH - fixedLen;
    const halfRemaining = Math.floor(remaining / 2);

    const truncRunner = runnerId.substring(0, halfRemaining);
    const truncSession = sessionId.substring(0, remaining - halfRemaining);

    return [action, requestId, truncRunner, truncSession].join(SEPARATOR);
}

/**
 * Parse a self-healing button customId.
 * Returns the decoded parts or null if it's not in the expected format.
 */
export function parseButtonId(customId: string): ParsedButtonId | null {
    const parts = customId.split(SEPARATOR);
    if (parts.length < 4) {
        return null;
    }
    return {
        action: parts[0],
        requestId: parts[1],
        runnerId: parts[2],
        sessionId: parts.slice(3).join(SEPARATOR) // sessionId might contain ':'
    };
}

/**
 * Check if a customId uses the new self-healing format (colon-separated with 4+ parts)
 */
export function isSelfHealingId(customId: string): boolean {
    const parts = customId.split(SEPARATOR);
    return parts.length >= 4;
}

/**
 * Extract the action from a customId, regardless of format.
 * For new format: returns the action part before first ':'
 * For legacy format: returns the part before first '_' 
 */
export function extractAction(customId: string): string {
    if (isSelfHealingId(customId)) {
        return customId.split(SEPARATOR)[0];
    }
    // Legacy format: action_restOfId
    const underscoreIdx = customId.indexOf('_');
    return underscoreIdx >= 0 ? customId.substring(0, underscoreIdx) : customId;
}

/**
 * Extract requestId from a customId, regardless of format.
 * For new format: returns the second colon-separated part
 * For legacy format: returns everything after the first '_'
 */
export function extractRequestId(customId: string): string {
    if (isSelfHealingId(customId)) {
        return customId.split(SEPARATOR)[1];
    }
    // Legacy format: action_requestId or prefix_action_requestId
    const underscoreIdx = customId.indexOf('_');
    return underscoreIdx >= 0 ? customId.substring(underscoreIdx + 1) : customId;
}

/**
 * Truncate a string for Discord embed display
 */
export function truncateForDiscord(value: string, max: number = 1024): string {
    if (value.length <= max) return value;
    return value.substring(0, max - 3) + '...';
}

/**
 * Check if a CLI type supports model selection
 */
export function isModelSelectableCli(cliType: string | undefined): cliType is 'claude' | 'codex' {
    return cliType === 'claude' || cliType === 'codex';
}

/**
 * Map CLI type to its corresponding SDK plugin
 */
export function cliToSdkPlugin(cliType: string): 'claude-sdk' | 'codex-sdk' | 'gemini-sdk' {
    switch (cliType) {
        case 'claude': return 'claude-sdk';
        case 'codex': return 'codex-sdk';
        case 'gemini': return 'gemini-sdk';
        default: return 'claude-sdk'; // fallback
    }
}

/**
 * Get human-readable label for a CLI type
 */
export function cliTypeLabel(cliType: string): string {
    switch (cliType) {
        case 'claude': return 'Claude';
        case 'codex': return 'Codex';
        case 'gemini': return 'Gemini';
        default: return cliType;
    }
}
