/**
 * Runner Agent Configuration
 * 
 * Loads configuration from:
 * 1. Config file (./config.json or DISCORDE_CONFIG_PATH)
 * 2. Environment variables (override file values)
 * 
 * Secrets (DISCORDE_TOKEN) must always be in environment.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';

export interface TmuxConfig {
    pollInterval: number;
    healthCheckInterval: number;
    sessionDiscoveryInterval: number;
    discoveryEnabled: boolean;
}

export interface RunnerConfig {
    // Core settings
    botWsUrl: string;
    token: string;
    runnerName: string;
    httpPort: number;
    defaultWorkspace?: string;
    cliTypes: ('claude' | 'gemini')[];

    // Timing options
    heartbeatInterval: number;
    reconnectDelay: number;
    approvalTimeout: number;
    sessionReadyTimeout: number;

    // CLI detection
    cliSearchPaths: string[];

    // Tmux settings
    tmux: TmuxConfig;
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
}

export function loadConfigFile(): FileConfig {
    const configPath = process.env.DISCORDE_CONFIG_PATH || './config.json';

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

export function parseCliTypes(input: string | string[] | undefined): ('claude' | 'gemini')[] {
    if (!input) return ['claude'];

    const arr = Array.isArray(input) ? input : input.split(',');
    return arr
        .map((type: string) => type.trim().toLowerCase())
        .filter((type: string): type is 'claude' | 'gemini' =>
            type === 'claude' || type === 'gemini'
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
    const token = process.env.DISCORDE_TOKEN;
    if (!token) {
        console.error('Missing DISCORDE_TOKEN environment variable');
        process.exit(1);
    }

    // CLI types - env overrides file
    const cliTypes = parseCliTypes(
        process.env.DISCORDE_CLI_TYPES || fileConfig.cliTypes
    );

    if (cliTypes.length === 0) {
        console.error('At least one valid CLI type must be specified (claude, gemini)');
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
    if (process.env.DISCORDE_TMUX_POLLING === 'false') {
        tmuxConfig.discoveryEnabled = false;
    }

    return {
        // Core - env overrides file
        botWsUrl: process.env.DISCORDE_BOT_URL || fileConfig.botWsUrl || 'ws://localhost:8080',
        token,
        runnerName: process.env.DISCORDE_RUNNER_NAME || fileConfig.runnerName || 'local-runner',
        httpPort: parseInt(process.env.DISCORDE_HTTP_PORT || String(fileConfig.httpPort || 3122)),
        defaultWorkspace: process.env.DISCORDE_DEFAULT_WORKSPACE || fileConfig.defaultWorkspace,
        cliTypes,

        // Timing - env overrides file
        heartbeatInterval: parseInt(
            process.env.DISCORDE_HEARTBEAT_INTERVAL ||
            String(fileConfig.heartbeatInterval || 30000)
        ),
        reconnectDelay: parseInt(
            process.env.DISCORDE_RECONNECT_DELAY ||
            String(fileConfig.reconnectDelay || 5000)
        ),
        approvalTimeout: parseInt(
            process.env.DISCORDE_APPROVAL_TIMEOUT ||
            String(fileConfig.approvalTimeout || 30000)
        ),
        sessionReadyTimeout: parseInt(
            process.env.DISCORDE_SESSION_READY_TIMEOUT ||
            String(fileConfig.sessionReadyTimeout || 10000)
        ),

        // CLI search paths
        cliSearchPaths: parseSearchPaths(
            process.env.DISCORDE_CLI_SEARCH_PATHS,
            fileConfig.cliSearchPaths
        ),

        // Tmux config
        tmux: tmuxConfig,
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
