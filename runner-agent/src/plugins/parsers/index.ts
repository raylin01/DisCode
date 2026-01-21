/**
 * CLI Parser Interface
 * 
 * Defines the contract for CLI-specific output parsing.
 * Each CLI (Claude, Gemini, etc.) has its own parser implementation.
 */

import type { ApprovalOption } from '../base.js';

// ============================================================================
// Types
// ============================================================================

export type CliType = 'claude' | 'gemini' | 'generic';

export interface ParsedApproval {
    /** Tool requesting approval (Bash, Write, Read, etc.) */
    tool: string;
    /** Context/description of what the tool wants to do */
    toolInput: string | Record<string, any>;
    /** Available options */
    options: ApprovalOption[];
}

export interface ParsedMetadata {
    /** Token count */
    tokens?: number;
    /** Current mode */
    mode?: string;
    /** Current activity (Thinking, Working, etc.) */
    activity?: string;
}

// ============================================================================
// Parser Interface
// ============================================================================

export interface CliParser {
    /** Parser name for logging */
    readonly name: string;

    /** CLI type this parser handles */
    readonly cliType: CliType;

    /**
     * Detect if session is ready to accept input.
     * Called during boot phase to determine when CLI is ready.
     */
    detectReady(output: string): boolean;

    /**
     * Parse permission/approval prompts from output.
     * Returns null if no approval prompt is detected.
     */
    detectPermissionPrompt(output: string): ParsedApproval | null;

    /**
     * Parse token/usage statistics and activity from output.
     * Returns null if no metadata is found.
     */
    parseMetadata(output: string): ParsedMetadata | null;

    /**
     * Clean output for Discord display.
     * Removes ANSI codes, UI noise, and CLI-specific decorations.
     */
    cleanOutput(output: string): string;

    /**
     * Detect bypass warning that needs auto-handling.
     * Some CLIs show a first-run warning when using skip-permissions.
     */
    detectBypassWarning(output: string): boolean;

    /**
     * Check if output indicates the CLI is actively working.
     * Used to detect idle vs working state.
     */
    detectWorking(output: string): boolean;

    /**
     * Check if output indicates the CLI is at an idle prompt.
     */
    detectIdle(output: string): boolean;
}

// ============================================================================
// Parser Factory
// ============================================================================

import { claudeParser } from './claude-parser.js';
import { geminiParser } from './gemini-parser.js';
import { genericParser } from './generic-parser.js';

const parsers: Record<CliType, CliParser> = {
    claude: claudeParser,
    gemini: geminiParser,
    generic: genericParser,
};

/**
 * Get the appropriate parser for a CLI type.
 */
export function getParser(cliType: string): CliParser {
    return parsers[cliType as CliType] || parsers.generic;
}

/**
 * Get all available parsers.
 */
export function getAllParsers(): CliParser[] {
    return Object.values(parsers);
}

// Re-export parsers for direct access if needed
export { claudeParser } from './claude-parser.js';
export { geminiParser } from './gemini-parser.js';
export { genericParser } from './generic-parser.js';
