/**
 * CLI Parser Interface
 *
 * Defines the contract for CLI-specific output parsing.
 * Each CLI (Claude, Gemini, etc.) has its own parser implementation.
 */
// ============================================================================
// Parser Factory
// ============================================================================
import { claudeParser } from './claude-parser.js';
import { geminiParser } from './gemini-parser.js';
import { genericParser } from './generic-parser.js';
const parsers = {
    claude: claudeParser,
    gemini: geminiParser,
    generic: genericParser,
};
/**
 * Get the appropriate parser for a CLI type.
 */
export function getParser(cliType) {
    return parsers[cliType] || parsers.generic;
}
/**
 * Get all available parsers.
 */
export function getAllParsers() {
    return Object.values(parsers);
}
// Re-export parsers for direct access if needed
export { claudeParser } from './claude-parser.js';
export { geminiParser } from './gemini-parser.js';
export { genericParser } from './generic-parser.js';
