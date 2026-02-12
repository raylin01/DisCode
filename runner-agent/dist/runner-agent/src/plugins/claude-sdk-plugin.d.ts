/**
 * Claude SDK Plugin for CLI Integration
 *
 * Uses the standalone @discode/claude-client library to manage the Claude Code CLI.
 * This plugin acts as a bridge between the generic DisCode runner-agent and the Claude Client.
 */
import { BasePlugin, PluginSession, SessionConfig, PluginType } from './base.js';
export declare class ClaudeSDKPlugin extends BasePlugin {
    readonly name = "claude-sdk";
    readonly type: PluginType;
    readonly version = "1.0.0";
    readonly description = "Claude Code CLI Integration (Libraries)";
    readonly isPersistent = true;
    constructor(runnerId?: string);
    createSession(config: SessionConfig): Promise<PluginSession>;
}
