/**
 * Generic CLI Parser
 *
 * Fallback parser for unknown CLIs.
 * Provides basic functionality with minimal assumptions.
 */
// ============================================================================
// Detection Functions
// ============================================================================
/**
 * Detect if CLI is ready (generic prompt detection)
 */
function detectReady(output) {
    // Strip ANSI codes
    const rawStripped = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    const lines = rawStripped.split('\n').filter(l => l.trim());
    if (lines.length === 0)
        return false;
    const lastLine = lines[lines.length - 1].trim();
    // Common prompt patterns
    return /^[>❯$#%?]\s*$/.test(lastLine) || /[>❯$#%]\s*$/.test(lastLine);
}
/**
 * Detect permission prompt (generic - very conservative)
 * Returns null since we can't reliably detect prompts for unknown CLIs
 */
function detectPermissionPrompt(_output) {
    // For unknown CLIs, we don't attempt to detect prompts
    // Users should configure the CLI to auto-approve or handle via other means
    return null;
}
/**
 * Parse metadata (generic - basic patterns only)
 */
function parseMetadata(output) {
    const result = {};
    // Very generic token patterns
    const tokenMatch = output.match(/(\d+(?:,\d+)?)\s*tokens?/i);
    if (tokenMatch) {
        result.tokens = parseInt(tokenMatch[1].replace(/,/g, ''), 10);
    }
    return Object.keys(result).length > 0 ? result : null;
}
/**
 * Clean output (generic - ANSI stripping only)
 */
function cleanOutput(str) {
    return str
        // Basic ANSI stripping
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
        .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '')
        // Remove control characters except newlines
        .replace(/[\x00-\x1F]/g, (c) => c === '\n' || c === '\r' ? c : '')
        // Normalize newlines
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
/**
 * Detect bypass warning (generic - disabled)
 */
function detectBypassWarning(_output) {
    return false;
}
/**
 * Detect if CLI is working (generic - very basic)
 */
function detectWorking(output) {
    // Look for common activity indicators
    return /\.\.\.\s*$/.test(output) || /processing|loading|working/i.test(output);
}
/**
 * Detect if CLI is idle (generic - prompt detection)
 */
function detectIdle(output) {
    return detectReady(output);
}
// ============================================================================
// Parser Export
// ============================================================================
export const genericParser = {
    name: 'GenericParser',
    cliType: 'generic',
    detectReady,
    detectPermissionPrompt,
    parseMetadata,
    cleanOutput,
    detectBypassWarning,
    detectWorking,
    detectIdle,
};
