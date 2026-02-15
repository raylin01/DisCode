/**
 * Runner Agent Configuration
 * 
 * Loads configuration from:
 * 1. Config file (./config.json or DISCODE_CONFIG_PATH)
 * 2. Environment variables (override file values)
 * 
 * Secrets (DISCODE_TOKEN) must always be in environment.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import type { PluginOptions } from './plugins/base.js';
import { normalizeClaudeOptions } from './utils/session-options.js';

export interface TmuxConfig {
    pollInterval: number;
    healthCheckInterval: number;
    sessionDiscoveryInterval: number;
    discoveryEnabled: boolean;
}

export interface AssistantConfig {
    enabled: boolean;           // Whether assistant is enabled (default: true if cliTypes has entries)
    folder?: string;            // Working folder for assistant (default: defaultWorkspace)
    plugin: 'tmux' | 'print';   // Plugin to use for assistant session
}

export interface RunnerConfig {
    // Core settings
    botWsUrl: string;
    token: string;
    runnerName: string;
    httpPort: number;
    defaultWorkspace?: string;
    cliTypes: ('claude' | 'gemini' | 'codex')[];

    // Timing options
    heartbeatInterval: number;
    reconnectDelay: number;
    approvalTimeout: number;
    sessionReadyTimeout: number;

    // CLI detection
    cliSearchPaths: string[];

    // Tmux settings
    tmux: TmuxConfig;

    // Assistant settings
    assistant: AssistantConfig;

    // Claude default session options
    claudeDefaults?: Partial<PluginOptions>;
    // Codex default session options
    codexDefaults?: Partial<PluginOptions>;
    // Gemini default session options
    geminiDefaults?: Partial<PluginOptions>;
}

interface FileConfig {
    botWsUrl?: string;
    runnerName?: string;
    httpPort?: number;
    defaultWorkspace?: string;
    cliTypes?: string[];
    heartbeatInterval?: number;
    reconnectDelay?: number;
    approvalTimeout?: number;
    sessionReadyTimeout?: number;
    cliSearchPaths?: string[];
    tmux?: Partial<TmuxConfig>;
    assistant?: Partial<AssistantConfig>;
    claudeDefaults?: Partial<PluginOptions>;
    codexDefaults?: Partial<PluginOptions>;
    geminiDefaults?: Partial<PluginOptions>;
}

export function loadConfigFile(): FileConfig {
    const configPath = getConfigPath();

    try {
        if (fs.existsSync(configPath)) {
            const content = fs.readFileSync(configPath, 'utf-8');
            const parsed = JSON.parse(content);
            console.log(`Loaded config from ${configPath}`);
            return parsed;
        }
    } catch (error) {
        console.warn(`Warning: Could not load config file ${configPath}:`, error);
    }

    return {};
}

export function getConfigPath(): string {
    return process.env.DISCODE_CONFIG_PATH || './config.json';
}

export function saveConfigFile(update: Partial<FileConfig>): void {
    const configPath = getConfigPath();
    let existing: FileConfig = {};
    try {
        if (fs.existsSync(configPath)) {
            const content = fs.readFileSync(configPath, 'utf-8');
            existing = JSON.parse(content);
        }
    } catch (error) {
        console.warn(`Warning: Could not read config file ${configPath} for update:`, error);
    }

    const merged: FileConfig = {
        ...existing,
        ...update
    };

    try {
        fs.writeFileSync(configPath, JSON.stringify(merged, null, 2));
        console.log(`Saved config updates to ${configPath}`);
    } catch (error) {
        console.error(`Failed to write config file ${configPath}:`, error);
        throw error;
    }
}

export function parseCliTypes(input: string | string[] | undefined): ('claude' | 'gemini' | 'codex')[] {
    if (!input) return ['claude'];

    const arr = Array.isArray(input) ? input : input.split(',');
    return arr
        .map((type: string) => type.trim().toLowerCase())
        .filter((type: string): type is 'claude' | 'gemini' | 'codex' =>
            type === 'claude' || type === 'gemini' || type === 'codex'
        );
}

export function parseSearchPaths(envInput: string | undefined, fileInput: string[] | undefined): string[] {
    const defaultPaths = [
        `${os.homedir()}/.local/bin`,
        '/usr/local/bin',
        '/opt/homebrew/bin',
        '/home/linuxbrew/.linuxbrew/bin',
    ];

    // Env takes priority
    if (envInput) {
        const customPaths = envInput.split(',').map(p => p.trim()).filter(Boolean);
        return [...customPaths, ...defaultPaths];
    }

    // File config
    if (fileInput && fileInput.length > 0) {
        return [...fileInput, ...defaultPaths];
    }

    return defaultPaths;
}

export function loadConfig(): RunnerConfig {
    // Load file config first
    const fileConfig = loadConfigFile();

    // Token is always from env (security)
    const token = process.env.DISCODE_TOKEN;
    if (!token) {
        console.error('Missing DISCODE_TOKEN environment variable');
        process.exit(1);
    }

    // CLI types - env overrides file
    const cliTypes = parseCliTypes(
        process.env.DISCODE_CLI_TYPES || fileConfig.cliTypes
    );

    if (cliTypes.length === 0) {
        console.error('At least one valid CLI type must be specified (claude, gemini, codex)');
        process.exit(1);
    }

    // Tmux config with defaults
    const tmuxDefaults: TmuxConfig = {
        pollInterval: 1000,
        healthCheckInterval: 5000,
        sessionDiscoveryInterval: 5000,
        discoveryEnabled: true,
    };

    const tmuxConfig: TmuxConfig = {
        ...tmuxDefaults,
        ...fileConfig.tmux,
    };

    // Override tmux discovery from env if set
    if (process.env.DISCODE_TMUX_POLLING === 'false') {
        tmuxConfig.discoveryEnabled = false;
    }

    const normalizedDefaults = normalizeClaudeOptions(fileConfig.claudeDefaults || {});
    if (normalizedDefaults.warnings.length > 0) {
        console.warn(`[Config] Ignored invalid claudeDefaults: ${normalizedDefaults.warnings.join(' ')}`);
    }

    return {
        // Core - env overrides file
        botWsUrl: process.env.DISCODE_BOT_URL || fileConfig.botWsUrl || 'ws://localhost:8080',
        token,
        runnerName: process.env.DISCODE_RUNNER_NAME || fileConfig.runnerName || 'local-runner',
        httpPort: parseInt(process.env.DISCODE_HTTP_PORT || String(fileConfig.httpPort || 3122)),
        defaultWorkspace: process.env.DISCODE_DEFAULT_WORKSPACE || fileConfig.defaultWorkspace,
        cliTypes,

        // Timing - env overrides file
        heartbeatInterval: parseInt(
            process.env.DISCODE_HEARTBEAT_INTERVAL ||
            String(fileConfig.heartbeatInterval || 30000)
        ),
        reconnectDelay: parseInt(
            process.env.DISCODE_RECONNECT_DELAY ||
            String(fileConfig.reconnectDelay || 5000)
        ),
        approvalTimeout: parseInt(
            process.env.DISCODE_APPROVAL_TIMEOUT ||
            String(fileConfig.approvalTimeout || 30000)
        ),
        sessionReadyTimeout: parseInt(
            process.env.DISCODE_SESSION_READY_TIMEOUT ||
            String(fileConfig.sessionReadyTimeout || 10000)
        ),

        // CLI search paths
        cliSearchPaths: parseSearchPaths(
            process.env.DISCODE_CLI_SEARCH_PATHS,
            fileConfig.cliSearchPaths
        ),

        // Tmux config
        tmux: tmuxConfig,

        // Assistant config
        assistant: {
            enabled: process.env.DISCODE_ASSISTANT_ENABLED !== 'false' &&
                (fileConfig.assistant?.enabled !== false) &&
                cliTypes.length > 0,
            folder: process.env.DISCODE_ASSISTANT_FOLDER || fileConfig.assistant?.folder,
            plugin: (fileConfig.assistant?.plugin as 'tmux' | 'print') || 'tmux',
        },

        // Claude defaults (session options)
        claudeDefaults: normalizedDefaults.options,
        codexDefaults: fileConfig.codexDefaults || {},
        geminiDefaults: fileConfig.geminiDefaults || {}
    };
}

// Singleton config instance
let configInstance: RunnerConfig | null = null;

export function getConfig(): RunnerConfig {
    if (!configInstance) {
        configInstance = loadConfig();
    }
    return configInstance;
}

// Reset config singleton (for testing)
export function resetConfig(): void {
    configInstance = null;
}
