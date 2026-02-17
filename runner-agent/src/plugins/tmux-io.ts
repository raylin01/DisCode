/**
 * Tmux I/O Utilities
 *
 * Helper functions for capturing and parsing tmux output,
 * detecting prompts, and cleaning output.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ApprovalOption } from './base.js';

const execFileAsync = promisify(execFile);

const EXEC_OPTIONS = {
    maxBuffer: 1024 * 1024,
    timeout: 30000
};

/**
 * Validate tmux session name to prevent injection
 */
export function validateTmuxSession(name: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        throw new Error(`Invalid tmux session name: ${name}`);
    }
}

/**
 * Capture tmux pane output
 */
export async function capturePane(tmuxSession: string, lines = 100, tmuxPath: string): Promise<string> {
    validateTmuxSession(tmuxSession);
    const { stdout } = await execFileAsync(
        tmuxPath,
        ['capture-pane', '-t', tmuxSession, '-p', '-S', `-${lines}`],
        { ...EXEC_OPTIONS, maxBuffer: 1024 * 1024 }
    );
    return stdout as string;
}

/**
 * Detect permission prompt in tmux output
 * Based on vibecraft's detection logic
 * Also detects startup prompts like Settings Error that block session
 */
export function detectPermissionPrompt(output: string): { tool: string; context: string; options: ApprovalOption[] } | null {
    const lines = output.split('\n');

    // Look for various prompt patterns
    let proceedLineIdx = -1;
    let promptType: 'permission' | 'settings' | 'selector' = 'permission';

    // Scan last 50 lines
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 50); i--) {
        // Standard permission prompts
        if (/(Do you want|Would you like) to (proceed|make this edit)/i.test(lines[i])) {
            proceedLineIdx = i;
            promptType = 'permission';
            break;
        }
        // Settings Error prompts
        if (/Settings Error/i.test(lines[i])) {
            proceedLineIdx = i;
            promptType = 'settings';
            break;
        }
    }

    // If no explicit prompt found, look for selector pattern (following by numbered options)
    if (proceedLineIdx === -1) {
        for (let i = lines.length - 1; i >= Math.max(0, lines.length - 20); i--) {
            if (/^\s*\u276F\s*\d+\./.test(lines[i])) {
                // Found a selector, look back for context
                proceedLineIdx = Math.max(0, i - 10);
                promptType = 'selector';
                break;
            }
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
        if (/^\s*\u276F/.test(lines[i])) {
            hasSelector = true;
        }
    }

    // For settings/selector prompts, we don't require footer verification
    if (!hasFooter && !hasSelector && promptType === 'permission') return null;

    // Parse numbered options
    const options: ApprovalOption[] = [];
    const searchStart = promptType === 'selector' ? Math.max(0, proceedLineIdx) : proceedLineIdx + 1;
    for (let i = searchStart; i < Math.min(lines.length, searchStart + 15); i++) {
        const line = lines[i];
        if (/Esc to cancel/i.test(line)) break;

        const optionMatch = line.match(/^\s*[\u276F>]?\s*(\d+)\.\s+(.+)$/);
        if (optionMatch) {
            options.push({
                number: optionMatch[1],
                label: optionMatch[2].trim()
            });
        }
    }

    // For selector prompts (like Settings Error), we may only have 1 option
    if (options.length < 1) return null;
    if (options.length < 2 && promptType === 'permission') return null;

    // Find tool name based on prompt type
    let tool = 'Unknown';

    if (promptType === 'settings') {
        tool = 'Settings';
    } else if (promptType === 'selector') {
        tool = 'Prompt';
    } else {
        // Standard permission prompt - look for tool indicators
        for (let i = proceedLineIdx; i >= Math.max(0, proceedLineIdx - 20); i--) {
            // Pattern for tool indicators
            const toolMatch = lines[i].match(/[\u25CF\u25D0\u00B7\u23FA]\s*(\w+)\s*\(/);
            if (toolMatch) {
                tool = toolMatch[1];
                break;
            }
            // Pattern for "Edit file .env" style
            const editMatch = lines[i].match(/^Edit file\s+(.+)$/i);
            if (editMatch) {
                tool = 'Edit';
                break;
            }
            const cmdMatch = lines[i].match(/^\s*(Bash|Read|Write|Edit|Update|Grep|Glob|Task|WebFetch|WebSearch)\s+\w+/i);
            if (cmdMatch) {
                tool = cmdMatch[1];
                break;
            }
        }
    }

    // Build context
    const contextStart = Math.max(0, proceedLineIdx - 10);
    const contextEnd = Math.min(lines.length, proceedLineIdx + 1 + options.length + 5);
    const context = lines.slice(contextStart, contextEnd).join('\n').trim();

    return { tool, context, options };
}

/**
 * Detect bypass permissions warning
 */
export function detectBypassWarning(output: string): boolean {
    return output.includes('WARNING') && output.includes('Bypass Permissions mode');
}

/**
 * Clean ANSI codes from output
 */
export function cleanOutput(str: string): string {
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
        .replace(/^[-]{3,}.*?$/gm, '') // Horizontal rules of any length
        .replace(/^\s*[>\u276F]\s*$/gm, '') // Empty prompt lines
        .replace(/.*?\? for shortcuts.*?$/gm, '') // Shortcut tips (match anywhere in line)
        .replace(/.*?Tip:.*?$/gm, '') // Usage tips (match anywhere in line)
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
        .replace(/.*Sonnet.*\u00B7.*/gi, '') // Model indicator line
        .replace(/.*Opus.*\u00B7.*/gi, '') // Model indicator line
        // Remove box drawing characters (welcome screen)
        .replace(/[\u256D\u2500\u256E\u2502\u256F\u2570\u2580\u2584\u2588\u258C\u2590\u2596\u2597\u2598\u2599\u259A\u259B\u259C\u259D\u259E\u259F]/g, '')
        // Remove logo/art characters
        .replace(/[\u2590\u259B\u259C\u258C\u259D\u2598]/g, '')
        .replace(/\*\s*\*\s*\*/g, '') // Stars from logo
        // Remove startup noise
        .replace(/ide visual studio code/gi, '')
        .replace(/starting up/gi, '')
        .replace(/connected to .*? server/gi, '')
        // Remove activity status lines (managed via metadata)
        .replace(/[*\u2731\u273B\u273B]\s*[A-Za-z]+(?:\u2026|\.\.\.)\s*(?:\(esc to interrupt\))?/gi, '')
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n') // Collapse excessive newlines
        .trim();
}

/**
 * Parse token count from Claude Code output
 * Patterns: 879 tokens, 1,234 tokens, 12.5k tokens
 */
export function parseTokensFromOutput(output: string): number | null {
    let maxTokens = 0;

    // Pattern 1: plain numbers (possibly with commas)
    const plainPattern = /\u2193\s*([0-9,]+)\s*tokens?/gi;
    const plainMatches = output.matchAll(plainPattern);
    for (const match of plainMatches) {
        const num = parseInt(match[1].replace(/,/g, ''), 10);
        if (num > maxTokens) maxTokens = num;
    }

    // Pattern 2: k suffix (thousands) - 12.5k tokens, 12k tokens
    const kPattern = /\u2193\s*([0-9.]+)k\s*tokens?/gi;
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
export function parseActivity(output: string): string | null {
    // Match: * ActivityName... (esc to interrupt)
    // Or: ActivityName... (esc to interrupt)
    // Support both unicode ellipsis and triple dots (...)
    const activityPattern = /[*\u2731\u273B]\s*([A-Za-z]+)(?:\u2026|\.\.\.)\s*(?:\(esc to interrupt\))?/gi;
    const matches = [...output.matchAll(activityPattern)];

    // Return the last activity found (most recent)
    if (matches.length > 0) {
        return matches[matches.length - 1][1];
    }
    return null;
}

/**
 * Parse current mode from Claude Code output
 * e.g., "bypass permissions on (shift+tab to cycle)"
 */
export function parseMode(output: string): string | null {
    // Bypass permissions mode
    if (output.includes('bypass permissions on')) {
        return 'bypass';
    }
    // Plan mode
    if (output.includes('plan mode')) {
        return 'plan';
    }
    return null;
}

/**
 * Detect if output ends with a shell prompt (terminal is idle/not running)
 * Returns true if a shell prompt is detected at the end of the output
 */
export function detectShellPrompt(output: string): boolean {
    // Get last few non-empty lines
    const lines = output.split('\n').filter(l => l.trim().length > 0);
    if (lines.length === 0) return true; // Empty = probably idle

    const lastLine = lines[lines.length - 1].trim();

    // Common shell prompt patterns:
    // Bash: "user@host:~$ " or "(base) MacBook-Pro-183:~ ray$"
    // Zsh: "~" or standard prompt characters
    // Generic: ends with $ or # or % or > with optional space

    // Pattern 1: Ends with common prompt characters
    if (/[$#%>\u276F\u2771]\s*$/.test(lastLine)) {
        return true;
    }

    // Pattern 2: Bash/conda style prompt (hostname:path user$)
    if (/^(\([^)]+\)\s+)?\S+:\S*\s+\w+\$$/.test(lastLine)) {
        return true;
    }

    // Pattern 3: Just a prompt symbol
    if (/^[\u276F\u2771>%$#]\s*$/.test(lastLine)) {
        return true;
    }

    return false;
}

/**
 * Calculate new content by comparing old and new output
 * Uses suffix-prefix overlap detection for streaming
 */
export function getNewContent(oldOutput: string, newOutput: string, isClaudeCode: boolean = true): string | null {
    if (!oldOutput) return newOutput;
    if (oldOutput === newOutput) return null;

    const oldLines = oldOutput.split('\n');
    const newLines = newOutput.split('\n');

    // Look for the largest overlap where the SUFFIX of old matching the PREFIX of new
    // This handles appending, scrolling, etc.
    const maxPossOverlap = Math.min(oldLines.length, newLines.length);
    let bestOverlap = 0;

    for (let len = maxPossOverlap; len > 0; len--) {
        // Check if suffix of old (length len) matches prefix of new (length len)
        let match = true;
        for (let i = 0; i < len; i++) {
            // Determine start indices
            // Old suffix starts at: oldLines.length - len
            // New prefix starts at: 0
            if (oldLines[oldLines.length - len + i] !== newLines[i]) {
                match = false;
                break;
            }
        }

        if (match) {
            bestOverlap = len;
            break;
        }
    }

    // If no overlap, assume completely new content (clear screen or fast scroll)
    if (bestOverlap === 0) {
        return newOutput;
    }

    const addedLines = newLines.slice(bestOverlap);

    if (addedLines.length === 0) return null;

    return addedLines.join('\n');
}
