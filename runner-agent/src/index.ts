/**
 * DisCode Runner Agent
 *
 * Connects to Discord bot via WebSocket and provides HTTP server for CLI plugins.
 * 
 * This is the main entry point - orchestrates all components.
 */

import type { WebSocketMessage } from '../../shared/types.js';
import type { PluginSession } from './plugins/index.js';
import { getPluginManager } from './plugins/index.js';

import { getConfig } from './config.js';
import { findCliPath } from './utils.js';
import { createWebSocketManager } from './websocket.js';
import { createHttpServer } from './http-server.js';
import { handleWebSocketMessage } from './handlers/index.js';
import { wirePluginEvents } from './plugin-events.js';
import type { SessionMetadata, PendingApproval, PendingMessage, CliPaths } from './types.js';

// Load configuration
const config = getConfig();

// CLI paths (will be detected on startup)
const cliPaths: CliPaths = {
  claude: null,
  gemini: null
};

// State stores
const pendingApprovals = new Map<string, PendingApproval>();
const pendingMessages = new Map<string, PendingMessage[]>();
const cliSessions = new Map<string, PluginSession>();
const sessionMetadata = new Map<string, SessionMetadata>();

// Initialize WebSocket manager
const wsManager = createWebSocketManager(config);

// PluginManager instance (initialized asynchronously)
let pluginManager = getPluginManager();

// Wire WebSocket messages to handlers
wsManager.on('message', async (message: WebSocketMessage) => {
  try {
    await handleWebSocketMessage(message, {
      config,
      wsManager,
      pluginManager,
      cliSessions,
      sessionMetadata,
      pendingApprovals,
      pendingMessages,
      cliPaths
    });
  } catch (error) {
    console.error('Error handling WebSocket message:', error);
  }
});

// Create HTTP server
const server = createHttpServer(
  {
    port: config.httpPort,
    runnerId: wsManager.runnerId,
    runnerName: config.runnerName,
    cliTypes: config.cliTypes,
    approvalTimeout: config.approvalTimeout
  },
  {
    wsManager,
    pluginManager,
    pendingApprovals,
    pendingMessages
  }
);

server.listen(config.httpPort, () => {
  console.log(`HTTP server listening on port ${config.httpPort}`);
});

// Startup sequence
async function startup(): Promise<void> {
  console.log('Detecting CLI installations...');

  for (const cliType of config.cliTypes) {
    const path = await findCliPath(cliType, config.cliSearchPaths);
    cliPaths[cliType] = path;

    if (!path) {
      console.error(`  ERROR: ${cliType.toUpperCase()} CLI not found!`);
      console.error(`  Searched in:`);
      config.cliSearchPaths.forEach(p => console.error(`    - ${p}`));
      console.error(`\n  Please install ${cliType} CLI or add it to your PATH`);
    } else {
      console.log(`  ✓ ${cliType.toUpperCase()}: ${path}`);
    }
  }

  // Initialize PluginManager
  console.log('\nInitializing PluginManager...');
  try {
    await pluginManager.initialize();
    console.log('  ✓ PluginManager initialized');

    // Wire plugin events to WebSocket
    wirePluginEvents(pluginManager, wsManager);
  } catch (error) {
    console.error(`  ✗ PluginManager initialization failed:`, error);
  }

  console.log('');
}

// Start everything
startup();

// Connect to Discord bot
wsManager.connect();

// Startup banner
console.log(`
╔════════════════════════════════════════════════════════════╗
║           DisCode Runner Agent v0.1.0                     ║
╠════════════════════════════════════════════════════════════╣
║  Runner ID: ${wsManager.runnerId.padEnd(48)}║
║  Runner Name: ${config.runnerName.padEnd(44)}║
║  CLI Types: ${config.cliTypes.join(', ').padEnd(47)}║
║  HTTP Server: http://localhost:${config.httpPort.toString().padEnd(39)}║
║  Bot WebSocket: ${config.botWsUrl.padEnd(43)}║
╚════════════════════════════════════════════════════════════╝
`);

// Handle graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down Runner Agent...');

  wsManager.close();

  if (pluginManager) {
    console.log('Shutting down plugins...');
    await pluginManager.shutdown();
  }

  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});
