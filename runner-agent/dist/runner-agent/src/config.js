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
export function loadConfigFile() {
    const configPath = process.env.DISCODE_CONFIG_PATH || './config.json';
    try {
        if (fs.existsSync(configPath)) {
            const content = fs.readFileSync(configPath, 'utf-8');
            const parsed = JSON.parse(content);
            console.log(`Loaded config from ${configPath}`);
            return parsed;
        }
    }
    catch (error) {
        console.warn(`Warning: Could not load config file ${configPath}:`, error);
    }
    return {};
}
export function parseCliTypes(input) {
    if (!input)
        return ['claude'];
    const arr = Array.isArray(input) ? input : input.split(',');
    return arr
        .map((type) => type.trim().toLowerCase())
        .filter((type) => type === 'claude' || type === 'gemini');
}
export function parseSearchPaths(envInput, fileInput) {
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
export function loadConfig() {
    // Load file config first
    const fileConfig = loadConfigFile();
    // Token is always from env (security)
    const token = process.env.DISCODE_TOKEN;
    if (!token) {
        console.error('Missing DISCODE_TOKEN environment variable');
        process.exit(1);
    }
    // CLI types - env overrides file
    const cliTypes = parseCliTypes(process.env.DISCODE_CLI_TYPES || fileConfig.cliTypes);
    if (cliTypes.length === 0) {
        console.error('At least one valid CLI type must be specified (claude, gemini)');
        process.exit(1);
    }
    // Tmux config with defaults
    const tmuxDefaults = {
        pollInterval: 1000,
        healthCheckInterval: 5000,
        sessionDiscoveryInterval: 5000,
        discoveryEnabled: true,
    };
    const tmuxConfig = {
        ...tmuxDefaults,
        ...fileConfig.tmux,
    };
    // Override tmux discovery from env if set
    if (process.env.DISCODE_TMUX_POLLING === 'false') {
        tmuxConfig.discoveryEnabled = false;
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
        heartbeatInterval: parseInt(process.env.DISCODE_HEARTBEAT_INTERVAL ||
            String(fileConfig.heartbeatInterval || 30000)),
        reconnectDelay: parseInt(process.env.DISCODE_RECONNECT_DELAY ||
            String(fileConfig.reconnectDelay || 5000)),
        approvalTimeout: parseInt(process.env.DISCODE_APPROVAL_TIMEOUT ||
            String(fileConfig.approvalTimeout || 30000)),
        sessionReadyTimeout: parseInt(process.env.DISCODE_SESSION_READY_TIMEOUT ||
            String(fileConfig.sessionReadyTimeout || 10000)),
        // CLI search paths
        cliSearchPaths: parseSearchPaths(process.env.DISCODE_CLI_SEARCH_PATHS, fileConfig.cliSearchPaths),
        // Tmux config
        tmux: tmuxConfig,
        // Assistant config
        assistant: {
            enabled: process.env.DISCODE_ASSISTANT_ENABLED !== 'false' &&
                (fileConfig.assistant?.enabled !== false) &&
                cliTypes.length > 0,
            folder: process.env.DISCODE_ASSISTANT_FOLDER || fileConfig.assistant?.folder,
            plugin: fileConfig.assistant?.plugin || 'tmux',
        },
    };
}
// Singleton config instance
let configInstance = null;
export function getConfig() {
    if (!configInstance) {
        configInstance = loadConfig();
    }
    return configInstance;
}
// Reset config singleton (for testing)
export function resetConfig() {
    configInstance = null;
}
