/**
 * Gemini CLI Parser
 *
 * Handles parsing of Gemini CLI output.
 * Based on research of Gemini CLI version 0.24.0
 *
 * Note: Some patterns may need adjustment based on actual Gemini interactive output.
 * The streaming JSON mode (`--output-format stream-json`) is preferred for automation.
 */
import type { CliParser } from './index.js';
export declare const geminiParser: CliParser;
