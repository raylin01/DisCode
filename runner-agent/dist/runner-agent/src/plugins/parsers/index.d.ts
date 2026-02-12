/**
 * CLI Parser Interface
 *
 * Defines the contract for CLI-specific output parsing.
 * Each CLI (Claude, Gemini, etc.) has its own parser implementation.
 */
import type { ApprovalOption } from '../base.js';
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
/**
 * Get the appropriate parser for a CLI type.
 */
export declare function getParser(cliType: string): CliParser;
/**
 * Get all available parsers.
 */
export declare function getAllParsers(): CliParser[];
export { claudeParser } from './claude-parser.js';
export { geminiParser } from './gemini-parser.js';
export { genericParser } from './generic-parser.js';
