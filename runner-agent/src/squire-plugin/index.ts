/**
 * Squire Plugin for runner-agent
 *
 * Integrates Squire personal AI assistant capabilities into runner-agent.
 * Provides memory, skills, and scheduling to DisCode sessions.
 */

import path from 'path';
import os from 'os';
import type { CliPlugin, CliPluginContext } from '../plugins/types.js';
import { Squire } from '../../../squire/squire/src/index.js';
import type { SquireConfig } from '../../../squire/squire/src/types.js';
import { SquireSession } from './squire-session.js';
import { getSquireTools } from './tools.js';
import { SquireBotClient } from './squirebot-client.js';

let squireInstance: Squire | null = null;
let squireBotClient: SquireBotClient | null = null;

export interface SquirePluginConfig {
  enabled: boolean;
  name?: string;
  dataDir?: string;
  daemonMode?: boolean;
  memory?: {
    enabled?: boolean;
    provider?: 'qmd' | 'openai' | 'voyage';
    retentionDays?: number;
  };
  skills?: {
    bundled?: string[];
    additional?: string[];
    autoInstall?: boolean;
  };
  permissions?: {
    mode?: 'trust' | 'confirm' | 'ask';
    allowedTools?: string[];
    blockedTools?: string[];
  };
  squireBot?: {
    enabled?: boolean;
    url?: string;
    token?: string;
  };
}

export const squirePlugin: CliPlugin = {
  name: 'squire',
  version: '1.0.0',

  async initialize(context: CliPluginContext): Promise<void> {
    const config = context.config as { squire?: SquirePluginConfig };

    // Only initialize if Squire is enabled
    if (!config.squire?.enabled) {
      console.log('[SquirePlugin] Squire is disabled');
      return;
    }

    console.log('[SquirePlugin] Initializing...');

    // Create Squire instance
    const squireConfig: Partial<SquireConfig> & { squireId: string } = {
      squireId: `squire-${context.runnerId}`,
      name: config.squire?.name || 'Squire',
      dataDir: config.squire?.dataDir || path.join(os.homedir(), '.squire', 'data'),
      daemonMode: config.squire?.daemonMode ?? true,
      memory: {
        enabled: config.squire?.memory?.enabled ?? true,
        provider: config.squire?.memory?.provider || 'qmd',
        retentionDays: config.squire?.memory?.retentionDays || 90,
      },
      skills: {
        bundled: config.squire?.skills?.bundled || ['memory', 'web'],
        additional: config.squire?.skills?.additional || [],
        autoInstall: config.squire?.skills?.autoInstall ?? true,
      },
      permissions: {
        mode: config.squire?.permissions?.mode || 'confirm',
        allowedTools: config.squire?.permissions?.allowedTools || [],
        blockedTools: config.squire?.permissions?.blockedTools || [],
      },
    };

    squireInstance = new Squire(squireConfig);
    await squireInstance.start();

    // Connect to SquireBot if configured
    if (config.squire?.squireBot?.enabled && config.squire?.squireBot?.url) {
      squireBotClient = new SquireBotClient(
        config.squire.squireBot.url,
        config.squire.squireBot.token || ''
      );
      await squireBotClient.connect();
      console.log('[SquirePlugin] Connected to SquireBot');
    }

    console.log('[SquirePlugin] Initialized');
  },

  async createSession(options: { threadId: string; projectPath: string }, baseSession: unknown): Promise<unknown> {
    if (!squireInstance) {
      return baseSession;
    }

    // Wrap session with Squire enhancements
    return new SquireSession(baseSession as never, squireInstance, options);
  },

  getAdditionalTools(): unknown[] {
    if (!squireInstance) {
      return [];
    }

    return getSquireTools(squireInstance, squireBotClient);
  },

  async shutdown(): Promise<void> {
    if (squireBotClient) {
      squireBotClient.disconnect();
      squireBotClient = null;
    }

    if (squireInstance) {
      await squireInstance.stop();
      squireInstance = null;
    }

    console.log('[SquirePlugin] Shutdown complete');
  },
};

export function getSquire(): Squire | null {
  return squireInstance;
}

export function getSquireBotClient(): SquireBotClient | null {
  return squireBotClient;
}
