/**
 * DisCode Discord Bot
 *
 * Entry point - orchestrates all modules.
 * Handler logic is in handlers/ directory.
 */

import { storage } from './storage.js';
import { getConfig } from './config.js';
import * as botState from './state.js';
import { initCategoryManager, getCategoryManager } from './services/category-manager.js';
import { initSessionSyncService } from './services/session-sync.js';
import { createWebSocketServer } from './handlers/index.js';
import { setupAllEventHandlers } from './event-handlers.js';
import { registerCommands } from './commands.js';
import { setupGlobalErrorHandlers } from './shutdown.js';

// Load configuration
const config = getConfig();
const DISCORD_TOKEN = config.discordToken;
const WS_PORT = config.wsPort;

// Create WebSocket server
createWebSocketServer(WS_PORT);

// Setup event handlers
setupAllEventHandlers(reconcileRunnerCategories);

// Start the bot
async function main(): Promise<void> {
  // Clean up old ended sessions on startup
  const cleanedCount = await storage.cleanupOldSessions();
  if (cleanedCount > 0) {
    // Sessions cleaned up
  }

  // Initialize services
  initCategoryManager(botState.client);
  const sessionSync = initSessionSyncService(botState.client);

  // Wire up stats updates
  sessionSync.on('session_new', ({ runnerId }) => {
    getCategoryManager()?.updateRunnerStats(runnerId);
  });
  sessionSync.on('session_updated', ({ runnerId }) => {
    getCategoryManager()?.updateRunnerStats(runnerId);
  });

  // Setup global error handlers
  setupGlobalErrorHandlers();

  await registerCommands();
  await botState.client.login(DISCORD_TOKEN!);
}

async function reconcileRunnerCategories(): Promise<void> {
  const categoryManager = getCategoryManager();
  if (!categoryManager) return;

  const runners = Object.values(storage.data.runners);
  for (const runner of runners) {
    if (runner.discordState?.categoryId && runner.discordState?.controlChannelId) {
      continue;
    }

    const tokenInfo = storage.findTokenInfoByToken(runner.token);
    if (!tokenInfo?.guildId) {
      console.warn(`[Reconcile] Missing guildId for runner ${runner.runnerId}, cannot create category`);
      continue;
    }

    try {
      await categoryManager.createRunnerCategory(runner.runnerId, runner.name, tokenInfo.guildId);
      console.log(`[Reconcile] Created category for runner ${runner.runnerId}`);
    } catch (error) {
      console.error(`[Reconcile] Failed to create category for runner ${runner.runnerId}:`, error);
    }
  }
}

main().catch(console.error);
