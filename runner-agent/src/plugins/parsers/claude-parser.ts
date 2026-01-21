/**
 * Claude Code CLI Parser
 * 
 * Handles parsing of Claude Code (claude-cli) output including:
 * - Readiness detection (> prompt)
 * - Permission prompt parsing
 * - Token/metadata extraction
 * - UI noise cleaning
 */

import type { CliParser, ParsedApproval, ParsedMetadata } from './index.js';
import type { ApprovalOption } from '../base.js';

// ============================================================================
// Detection Functions
// ============================================================================

/**
 * Detect if Claude Code is ready (showing > prompt)
 */
function detectReady(output: string): boolean {
    // Strip ANSI codes first
    const rawStripped = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
    return rawStripped.includes('>');
}

/**
 * Detect permission/approval prompt in Claude Code output
 */
function detectPermissionPrompt(output: string): ParsedApproval | null {
    const lines = output.split('\n');

    // Look for "Do you want to proceed?" or "Would you like to proceed?"
    let proceedLineIdx = -1;
    // Scan last 50 lines
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 50); i--) {
        if (/(Do you want|Would you like) to proceed/i.test(lines[i])) {
            proceedLineIdx = i;
            break;
        }
    }

    if (proceedLineIdx === -1) return null;

    // Verify this is a real prompt by checking for footer or selector
    let hasFooter = false;
    let hasSelector = false;
    for (let i = proceedLineIdx + 1; i < Math.min(lines.length, proceedLineIdx + 15); i++) {
        if (/Esc to cancel|ctrl-g to edit/i.test(lines[i])) {
            hasFooter = true;
            break;
        }
        if (/^\s*❯/.test(lines[i])) {
            hasSelector = true;
        }
    }

    if (!hasFooter && !hasSelector) return null;

    // Parse numbered options
    const options: ApprovalOption[] = [];
    for (let i = proceedLineIdx + 1; i < Math.min(lines.length, proceedLineIdx + 10); i++) {
        const line = lines[i];
        if (/Esc to cancel/i.test(line)) break;

        const optionMatch = line.match(/^\s*[❯>]?\s*(\d+)\.\s+(.+)$/);
        if (optionMatch) {
            options.push({
                number: optionMatch[1],
                label: optionMatch[2].trim()
            });
        }
    }

    if (options.length < 2) return null;

    // Find tool name
    let tool = 'Unknown';
    for (let i = proceedLineIdx; i >= Math.max(0, proceedLineIdx - 20); i--) {
        const toolMatch = lines[i].match(/[●◐·]\s*(\w+)\s*\(/);
        if (toolMatch) {
            tool = toolMatch[1];
            break;
        }
        const cmdMatch = lines[i].match(/^\s*(Bash|Read|Write|Edit|Grep|Glob|Task|WebFetch|WebSearch)\s+\w+/i);
        if (cmdMatch) {
            tool = cmdMatch[1];
            break;
        }
    }

    // Build context
    const contextStart = Math.max(0, proceedLineIdx - 10);
    const contextEnd = proceedLineIdx + 1 + options.length;
    const context = lines.slice(contextStart, contextEnd).join('\n').trim();

    return { tool, toolInput: context, options };
}

/**
 * Parse metadata from Claude Code output
 */
function parseMetadata(output: string): ParsedMetadata | null {
    const result: ParsedMetadata = {};

    // Parse tokens
    const tokens = parseTokensFromOutput(output);
    if (tokens !== null) {
        result.tokens = tokens;
    }

    // Parse activity
    const activity = parseActivity(output);
    if (activity) {
        result.activity = activity;
    }

    // Parse mode
    const mode = parseMode(output);
    if (mode) {
        result.mode = mode;
    }

    return Object.keys(result).length > 0 ? result : null;
}

/**
 * Parse token count from Claude Code output
 * Patterns: ↓ 879 tokens, ↓ 1,234 tokens, ↓ 12.5k tokens
 */
function parseTokensFromOutput(output: string): number | null {
    let maxTokens = 0;

    // Pattern 1: plain numbers (possibly with commas) - ↓ 879 tokens, ↓ 1,234 tokens
    const plainPattern = /↓\s*([0-9,]+)\s*tokens?/gi;
    const plainMatches = output.matchAll(plainPattern);
    for (const match of plainMatches) {
        const num = parseInt(match[1].replace(/,/g, ''), 10);
        if (num > maxTokens) maxTokens = num;
    }

    // Pattern 2: k suffix (thousands) - ↓ 12.5k tokens, ↓ 12k tokens
    const kPattern = /↓\s*([0-9.]+)k\s*tokens?/gi;
    const kMatches = output.matchAll(kPattern);
    for (const match of kMatches) {
        const num = Math.round(parseFloat(match[1]) * 1000);
        if (num > maxTokens) maxTokens = num;
    }

    return maxTokens > 0 ? maxTokens : null;
}

/**
 * Parse current activity indicator from Claude Code output
 * Claude shows: * Thinking..., * Wrangling..., * Honking..., * Vibing..., etc.
 */
function parseActivity(output: string): string | null {
    const activityPattern = /[*✱✻]\s*([A-Za-z]+)(?:…|\.\.\.)\s*(?:\(esc to interrupt\))?/gi;
    const matches = [...output.matchAll(activityPattern)];

    // Return the last activity found (most recent)
    if (matches.length > 0) {
        return matches[matches.length - 1][1];
    }
    return null;
}

/**
 * Parse current mode from Claude Code output
 */
function parseMode(output: string): string | null {
    if (output.includes('bypass permissions on')) {
        return 'bypass';
    }
    if (output.includes('plan mode')) {
        return 'plan';
    }
    return null;
}

/**
 * Clean Claude Code output for Discord display
 */
function cleanOutput(str: string): string {
    return str
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
        .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '')
        .replace(/[\x00-\x1F]/g, (c) => c === '\n' || c === '\r' ? c : '')
        .replace(/warn: CPU lacks AVX support.*?\.zip\s*/gs, '')
        // Remove shell prompts that appear before/after Claude
        .replace(/^\(base\).*?\$.*$/gm, '') // Conda/bash prompts
        .replace(/^The default interactive shell is now zsh\.$/gm, '')
        .replace(/^To update your account to use zsh.*$/gm, '')
        .replace(/^For more details.*HT\d+\.$/gm, '')
        // Remove Claude Code UI noise - Aggressive cleanup
        .replace(/^[─-]{3,}.*?$/gm, '') // Horizontal rules of any length
        .replace(/^\s*[>❯]\s*$/gm, '') // Empty prompt lines
        .replace(/.*?\? for shortcuts.*?$/gm, '') // Shortcut tips
        .replace(/.*?Tip:.*?$/gm, '') // Usage tips
        .replace(/bypass permissions on \(shift\+tab to cycle\)/gi, '')
        .replace(/plan mode \(shift\+tab to cycle\)/gi, '')
        .replace(/Type \/help to see available commands/gi, '')
        .replace(/Claude Code/gi, '') // Welcome message part
        .replace(/Welcome to Claude/gi, '') // Welcome message part
        .replace(/Welcome back!/gi, '') // Welcome back message
        .replace(/.*\/ide for Visual Studio Code.*/gi, '') // VS Code promotion
        .replace(/.*\/model to try.*/gi, '') // Model promotion
        .replace(/.*Tips for getting started.*/gi, '') // Tips header
        .replace(/.*Run \/init to create a CLAUDE\.md.*/gi, '') // Init tip
        .replace(/.*Note: You have launched claude in your.*/gi, '') // Launch note
        .replace(/.*Recent activity.*/gi, '') // Recent activity header
        .replace(/.*No recent activity.*/gi, '') // No recent activity
        .replace(/.*API Usage Billing.*/gi, '') // Billing note
        .replace(/.*Sonnet.*·.*/gi, '') // Model indicator line
        .replace(/.*Opus.*·.*/gi, '') // Model indicator line
        // Remove box drawing characters (welcome screen)
        .replace(/[╭─╮│╯╰▀▄█▌▐▖▗▘▙▚▛▜▝▞▟]/g, '')
        // Remove logo/art characters
        .replace(/[▐▛▜▌▝▘]/g, '')
        .replace(/\*\s*\*\s*\*/g, '') // Stars from logo
        // Remove startup noise
        .replace(/ide visual studio code/gi, '')
        .replace(/starting up/gi, '')
        .replace(/connected to .*? server/gi, '')
        // Remove activity status lines (managed via metadata)
        .replace(/[*✱✻]\s*[A-Za-z]+(?:…|\.\.\.)\s*(?:\(esc to interrupt\))?/gi, '')
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n') // Collapse excessive newlines
        .trim();
}

/**
 * Detect bypass permissions warning
 */
function detectBypassWarning(output: string): boolean {
    return output.includes('WARNING') && output.includes('Bypass Permissions mode');
}

/**
 * Detect if Claude is actively working (showing activity indicator)
 */
function detectWorking(output: string): boolean {
    return parseActivity(output) !== null;
}

/**
 * Detect if Claude is idle (showing prompt)
 */
function detectIdle(output: string): boolean {
    const cleaned = output.trim();
    const lastLine = cleaned.split('\n').pop() || '';
    return /^[>❯]\s*$/.test(lastLine) || cleaned.endsWith('>') || cleaned.endsWith('❯');
}

// ============================================================================
// Parser Export
// ============================================================================

export const claudeParser: CliParser = {
    name: 'ClaudeParser',
    cliType: 'claude',
    detectReady,
    detectPermissionPrompt,
    parseMetadata,
    cleanOutput,
    detectBypassWarning,
    detectWorking,
    detectIdle,
};
