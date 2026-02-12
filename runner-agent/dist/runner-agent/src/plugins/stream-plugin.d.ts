/**
 * Stream Plugin for CLI Integration
 *
 * Generic plugin for CLIs that support streaming JSON output (JSONL).
 * Currently supports Gemini CLI with `--output-format stream-json`.
 *
 * Each message spawns a new process with streaming output.
 * Events are parsed as JSONL and mapped to standard plugin events.
 */
import { BasePlugin, PluginSession, SessionConfig } from './base.js';
/** Configuration for stream-based CLI */
export interface StreamCliConfig {
    /** CLI identifier */
    cliType: 'gemini' | string;
    /** Args to enable streaming output */
    streamArgs: string[];
    /** Args for auto-approve mode */
    autoApproveArgs: string[];
    /** Session ID argument template (use {id} as placeholder) */
    sessionIdArg?: string;
    /** Prompt argument (use {prompt} as placeholder) */
    promptArg: string;
}
/** Pre-configured CLI configs */
export declare const CLI_STREAM_CONFIGS: Record<string, StreamCliConfig>;
export declare class StreamPlugin extends BasePlugin {
    readonly name = "StreamPlugin";
    readonly type: "stream";
    readonly isPersistent = false;
    initialize(): Promise<void>;
    createSession(config: SessionConfig): Promise<PluginSession>;
    log(message: string): void;
}
