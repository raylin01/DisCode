/**
 * Gemini CLI Parser
 * 
 * Handles parsing of Gemini CLI output.
 * Based on research of Gemini CLI version 0.24.0
 * 
 * Note: Some patterns may need adjustment based on actual Gemini interactive output.
 * The streaming JSON mode (`--output-format stream-json`) is preferred for automation.
 */

import type { CliParser, ParsedApproval, ParsedMetadata } from './index.js';

// ============================================================================
// Detection Functions
// ============================================================================

/**
 * Detect if Gemini CLI is ready
 * Gemini's interactive UI shows a box-style prompt with status bar at bottom
 * Example: │ >  with status line showing "no sandbox" and "/model"
 */
function detectReady(output: string): boolean {
    // Strip ANSI codes
    const rawStripped = output.replace(/\\x1b\\[[0-9;]*[A-Za-z]/g, '');

    // Gemini CLI ready patterns based on actual output:
    // 1. The prompt box: │ > or │ > /command
    // 2. Status bar at bottom with /model indicator

    const readyPatterns = [
        /│\s*>\s*/,                    // Box-style prompt: │ >
        /╰─+╯.*?\/model/s,             // Box end with /model in status
        /no sandbox.*?\/model/i,       // Status bar indicators
        /Auto \(Gemini.*?\).*?\/model/i, // Model selector in status
    ];

    for (const pattern of readyPatterns) {
        if (pattern.test(rawStripped)) {
            return true;
        }
    }

    // Also check for Tips section completion followed by prompt
    if (rawStripped.includes('Tips for getting started') &&
        (rawStripped.includes('│ >') || rawStripped.includes('/model'))) {
        return true;
    }

    return false;
}

/**
 * Detect permission/approval prompt in Gemini output
 * 
 * Gemini's approval mode is typically configured via flags:
 * - --yolo: Auto-approve all
 * - --approval-mode auto_edit: Auto-approve edits only
 * 
 * Interactive approval prompts may look different from Claude.
 * This is a placeholder - needs real output samples to implement.
 */
function detectPermissionPrompt(output: string): ParsedApproval | null {
    const lines = output.split('\n');

    // Look for common approval patterns
    // Note: These are educated guesses based on common CLI patterns
    // May need adjustment based on actual Gemini output

    // Pattern 1: "Do you want to..." style
    let promptLineIdx = -1;
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 30); i--) {
        if (/(Do you want|Would you like|Allow|Permit|Approve)/i.test(lines[i])) {
            promptLineIdx = i;
            break;
        }
    }

    if (promptLineIdx === -1) return null;

    // Look for Yes/No options
    const options: { number: string; label: string }[] = [];
    for (let i = promptLineIdx + 1; i < Math.min(lines.length, promptLineIdx + 10); i++) {
        const line = lines[i];

        // Pattern: [Y/n] or [y/N] or (yes/no)
        if (/\[(Y\/n|y\/N|yes\/no)\]/i.test(line)) {
            options.push({ number: 'y', label: 'Yes' });
            options.push({ number: 'n', label: 'No' });
            break;
        }

        // Pattern: 1. Yes  2. No
        const optionMatch = line.match(/^\s*(\d+)[.)]\s*(.+)$/);
        if (optionMatch) {
            options.push({
                number: optionMatch[1],
                label: optionMatch[2].trim()
            });
        }
    }

    if (options.length < 2) return null;

    // Extract tool name if possible
    let tool = 'Action';
    const toolPatterns = [
        /\b(Bash|Shell|Execute|Run|Write|Read|Edit|Delete|Create)\b/i,
        /tool[:\s]+(\w+)/i,
    ];

    for (const pattern of toolPatterns) {
        for (let i = promptLineIdx; i >= Math.max(0, promptLineIdx - 10); i--) {
            const match = lines[i].match(pattern);
            if (match) {
                tool = match[1];
                break;
            }
        }
    }

    const context = lines.slice(Math.max(0, promptLineIdx - 5), promptLineIdx + 1).join('\n');

    return { tool, toolInput: context, options };
}

/**
 * Parse metadata from Gemini output
 * Token counts, model info, etc.
 */
function parseMetadata(output: string): ParsedMetadata | null {
    const result: ParsedMetadata = {};

    // Token patterns - Gemini may show these differently
    // Example patterns to look for:
    // - "tokens: 1234"
    // - "1.2k tokens used"
    // - Stats JSON in stream mode

    const tokenPatterns = [
        /(\d+(?:,\d+)?)\s*tokens?/i,
        /tokens?[:\s]+(\d+(?:,\d+)?)/i,
        /([0-9.]+)k\s*tokens?/i,
    ];

    for (const pattern of tokenPatterns) {
        const match = output.match(pattern);
        if (match) {
            let tokens = match[1].includes('k')
                ? Math.round(parseFloat(match[1]) * 1000)
                : parseInt(match[1].replace(/,/g, ''), 10);
            result.tokens = tokens;
            break;
        }
    }

    // Activity detection
    const activityPatterns = [
        /\b(Thinking|Processing|Generating|Working)\b\.{0,3}/i,
        /⏳\s*(\w+)/,
        /\.\.\.\s*(\w+ing)/i,
    ];

    for (const pattern of activityPatterns) {
        const match = output.match(pattern);
        if (match) {
            result.activity = match[1];
            break;
        }
    }

    return Object.keys(result).length > 0 ? result : null;
}

/**
 * Clean Gemini output for Discord display
 * Basic ANSI stripping with minimal content changes
 */
function cleanOutput(str: string): string {
    return str
        // ANSI code removal
        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
        .replace(/\x1b\[\?[0-9;]*[a-zA-Z]/g, '')
        .replace(/[\x00-\x1F]/g, (c) => c === '\n' || c === '\r' ? c : '')
        // Gemini-specific noise (adjust based on actual output)
        .replace(/Loaded cached credentials\./g, '')
        .replace(/Loading\.\.\./g, '')
        // Shell prompts
        .replace(/^\(base\).*?\$.*$/gm, '')
        // Empty prompt lines
        .replace(/^\s*[>❯]\s*$/gm, '')
        // Normalize newlines
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Detect bypass warning
 * Gemini may not have the same warning pattern as Claude
 */
function detectBypassWarning(output: string): boolean {
    // Gemini with --yolo probably doesn't show warnings
    // But check for common patterns just in case
    return output.includes('WARNING') &&
        (output.includes('auto-approve') || output.includes('yolo'));
}

/**
 * Detect if Gemini is actively working
 */
function detectWorking(output: string): boolean {
    const workingPatterns = [
        /\bThinking\b/i,
        /\bProcessing\b/i,
        /\bGenerating\b/i,
        /⏳/,
        /\.\.\.\s*$/,
    ];

    return workingPatterns.some(p => p.test(output));
}

/**
 * Detect if Gemini is idle (at prompt)
 */
function detectIdle(output: string): boolean {
    // Check for box-style prompt that Gemini uses
    if (/│\s*>\s*$/.test(output) || /│\s*>\s*[^│]*$/.test(output)) {
        return true;
    }

    // Also check status bar pattern
    if (output.includes('/model') && !output.includes('Thinking') && !output.includes('Working')) {
        return true;
    }

    return false;
}

// ============================================================================
// Parser Export
// ============================================================================

export const geminiParser: CliParser = {
    name: 'GeminiParser',
    cliType: 'gemini',
    detectReady,
    detectPermissionPrompt,
    parseMetadata,
    cleanOutput,
    detectBypassWarning,
    detectWorking,
    detectIdle,
};
