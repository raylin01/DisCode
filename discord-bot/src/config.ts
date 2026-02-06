/**
 * Discord Bot Configuration
 * 
 * Loads configuration from:
 * 1. Config file (./config.json or DISCODE_CONFIG_PATH)
 * 2. Environment variables (override file values)
 * 
 * Secrets (DISCORD_TOKEN, DISCORD_CLIENT_ID) must always be in environment.
 */

import fs from 'fs';

export interface NotificationConfig {
    pingOnApproval: boolean;
    pingOnCompletion: boolean;
    useAtHere: boolean;
}

export interface SessionDefaults {
    autoArchiveDuration: number;
    inactivityTimeout: number;
}

export interface AssistantBotConfig {
    mode: 'all' | 'command';   // 'all' = forward all messages, 'command' = only /assistant
}

export interface BotConfig {
    // Discord credentials (env only)
    discordToken: string;
    discordClientId: string;
    guildId?: string; // Optional: for faster dev command registration

    // WebSocket server
    wsPort: number;

    // Notifications
    notifications: NotificationConfig;

    // Session defaults
    sessionDefaults: SessionDefaults;

    // Assistant settings
    assistant: AssistantBotConfig;
}

interface FileConfig {
    wsPort?: number;
    notifications?: Partial<NotificationConfig>;
    sessionDefaults?: Partial<SessionDefaults>;
    assistant?: Partial<AssistantBotConfig>;
}

function loadConfigFile(): FileConfig {
    const configPath = process.env.DISCODE_CONFIG_PATH || './config.json';

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

export function loadConfig(): BotConfig {
    // Load file config first
    const fileConfig = loadConfigFile();

    // Tokens are always from env (security)
    const discordToken = process.env.DISCODE_DISCORD_TOKEN;
    const discordClientId = process.env.DISCODE_DISCORD_CLIENT_ID;

    if (!discordToken || !discordClientId) {
        console.error('Missing DISCODE_DISCORD_TOKEN or DISCODE_DISCORD_CLIENT_ID environment variables');
        process.exit(1);
    }

    // Notification defaults
    const notificationDefaults: NotificationConfig = {
        pingOnApproval: true,
        pingOnCompletion: true,
        useAtHere: true,
    };

    // Session defaults
    const sessionDefaultsConfig: SessionDefaults = {
        autoArchiveDuration: 60,
        inactivityTimeout: 3600000, // 1 hour
    };

    return {
        discordToken,
        discordClientId,
        guildId: process.env.DISCODE_GUILD_ID,

        // WS port - env overrides file
        wsPort: parseInt(
            process.env.DISCODE_WS_PORT ||
            String(fileConfig.wsPort || 8080)
        ),

        // Notifications - merge file config with defaults
        notifications: {
            ...notificationDefaults,
            ...fileConfig.notifications,
        },

        // Session defaults - merge file config with defaults
        sessionDefaults: {
            ...sessionDefaultsConfig,
            ...fileConfig.sessionDefaults,
        },

        // Assistant - env overrides file
        assistant: {
            mode: (process.env.DISCODE_ASSISTANT_MODE as 'all' | 'command') ||
                fileConfig.assistant?.mode ||
                'all',
        },
    };
}

// Singleton config instance
let configInstance: BotConfig | null = null;

export function getConfig(): BotConfig {
    if (!configInstance) {
        configInstance = loadConfig();
    }
    return configInstance;
}
