/**
 * Claude Code CLI Parser
 *
 * Handles parsing of Claude Code (claude-cli) output including:
 * - Readiness detection (> prompt)
 * - Permission prompt parsing
 * - Token/metadata extraction
 * - UI noise cleaning
 */
import type { CliParser } from './index.js';
export declare const claudeParser: CliParser;
