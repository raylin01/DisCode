/**
 * Discord Bot Configuration
 * 
 * Loads configuration from:
 * 1. Config file (./config.json or DISCORDE_CONFIG_PATH)
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

export interface BotConfig {
    // Discord credentials (env only)
    discordToken: string;
    discordClientId: string;

    // WebSocket server
    wsPort: number;

    // Notifications
    notifications: NotificationConfig;

    // Session defaults
    sessionDefaults: SessionDefaults;
}

interface FileConfig {
    wsPort?: number;
    notifications?: Partial<NotificationConfig>;
    sessionDefaults?: Partial<SessionDefaults>;
}

function loadConfigFile(): FileConfig {
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

export function loadConfig(): BotConfig {
    // Load file config first
    const fileConfig = loadConfigFile();

    // Tokens are always from env (security)
    const discordToken = process.env.DISCORDE_DISCORD_TOKEN;
    const discordClientId = process.env.DISCORDE_DISCORD_CLIENT_ID;

    if (!discordToken || !discordClientId) {
        console.error('Missing DISCORDE_DISCORD_TOKEN or DISCORDE_DISCORD_CLIENT_ID environment variables');
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

        // WS port - env overrides file
        wsPort: parseInt(
            process.env.DISCORDE_WS_PORT ||
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
