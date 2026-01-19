/**
 * DisCode Runner Agent
 *
 * Connects to Discord bot via WebSocket and provides HTTP server for CLI plugins
 */

import WebSocket from 'ws';
import { spawn } from 'child_process';
import http from 'http';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ApprovalRequest, WebSocketMessage } from '../shared/types.js';
import { TerminalSession } from './terminal-session.js';
import { ClaudeSession } from './claude-session.js';
import { PluginManager, getPluginManager, type PluginSession } from './plugins/index.ts';
import { getHookServer } from './hooks/server.ts';

// Configuration
const BOT_WS_URL = process.env.DISCORDE_BOT_URL || 'ws://localhost:8080';
const TOKEN = process.env.DISCORDE_TOKEN;
const RUNNER_NAME = process.env.DISCORDE_RUNNER_NAME || 'local-runner';
const HTTP_PORT = parseInt(process.env.DISCORDE_HTTP_PORT || '3122');
const DEFAULT_WORKSPACE = process.env.DISCORDE_DEFAULT_WORKSPACE;

// Support multiple CLI types (comma-separated)
const CLI_TYPES = (process.env.DISCORDE_CLI_TYPES || 'claude')
  .split(',')
  .map((type: string) => type.trim().toLowerCase())
  .filter((type: string): type is 'claude' | 'gemini' =>
    type === 'claude' || type === 'gemini'
  );

if (!TOKEN) {
  console.error('Missing DISCORDE_TOKEN environment variable');
  process.exit(1);
}

if (CLI_TYPES.length === 0) {
  console.error('At least one valid CLI type must be specified in DISCORDE_CLI_TYPES (claude, gemini)');
  process.exit(1);
}

// Generate consistent runner ID from token (same token = same ID)
// This prevents duplicate runners on restart
function generateRunnerId(token: string): string {
  // Create hash of token to get consistent ID
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  // Use first 12 characters of hash as unique identifier
  const shortHash = hash.substring(0, 12);
  return `runner_${RUNNER_NAME.replace(/\s+/g, '_').toLowerCase()}_${shortHash}`;
}

// Strip ANSI escape sequences from text
function stripAnsi(text: string): string {
  // Remove ANSI escape sequences
  return text.replace(/\x1b\[[0-9;]*[mGKH]/g, '')
    .replace(/\x1b\[[0-9;]*[0-9;]*[mGKH]/g, '')
    .replace(/\x1b\[\?[0-9;]*[hl]/g, '')
    .replace(/\x1b\][0-9];[^\x07]*\x07/g, '')
    .replace(/\x1b\][0-9];[^\x1b]*\x1b\\/g, '');
}

const RUNNER_ID = generateRunnerId(TOKEN);

// Detect CLI paths
async function findCliPath(cliType: 'claude' | 'gemini'): Promise<string | null> {
  const commonPaths = [
    '/Users/ray/.local/bin',
    '/usr/local/bin',
    '/opt/homebrew/bin',
    '/home/linuxbrew/.linuxbrew/bin',
  ];

  // Search common paths
  for (const dir of commonPaths) {
    const fullPath = `${dir}/${cliType}`;
    try {
      if (fs.existsSync(fullPath)) {
        console.log(`Found ${cliType} at ${fullPath} (manual search)`);
        return fullPath;
      }
    } catch (error) {
      // Path doesn't exist or isn't accessible
    }
  }

  return null;
}

// CLI paths (will be detected on startup)
let CLI_PATHS: Record<'claude' | 'gemini', string | null> = {
  claude: null,
  gemini: null
};

// WebSocket connection to Discord bot
let ws: WebSocket | null = null;
let isConnected = false;

// Pending approval requests (requestId -> { resolve, reject })
const pendingApprovals = new Map<string, {
  resolve: (response: { allow: boolean; message?: string }) => void;
  reject: (error: Error) => void;
}>();

// Pending user messages (sessionId -> messages array)
// This acts as a message queue for CLI plugins to poll
const pendingMessages = new Map<string, Array<{
  userId: string;
  username: string;
  content: string;
  timestamp: string;
}>>();

// Active CLI sessions (sessionId -> PluginSession)
// Using new plugin system for tmux-based interaction
const cliSessions = new Map<string, PluginSession>();

// PluginManager instance (initialized on startup)
let pluginManager: PluginManager | null = null;

// Session metadata
interface SessionMetadata {
  sessionId: string;
  cliType: 'claude' | 'gemini';
  folderPath?: string;
  runnerId: string;
}
const sessionMetadata = new Map<string, SessionMetadata>();

// Connect to Discord bot
function connect(): void {
  console.log(`Connecting to Discord bot at ${BOT_WS_URL}...`);

  ws = new WebSocket(BOT_WS_URL);

  ws.on('open', () => {
    console.log('Connected to Discord bot');
    isConnected = true;

    // Send registration message
    ws.send(JSON.stringify({
      type: 'register',
      data: {
        runnerId: RUNNER_ID,
        runnerName: RUNNER_NAME,
        token: TOKEN,
        cliTypes: CLI_TYPES,
        defaultWorkspace: DEFAULT_WORKSPACE
      }
    }));

    // Start heartbeat interval
    sendHeartbeat();
  });

  ws.on('message', async (rawData: Buffer) => {
    try {
      const message: WebSocketMessage = JSON.parse(rawData.toString());
      console.log(`[WebSocket] Received message type: ${message.type}`);
      if (message.type === 'approval_response') {
        console.log(`[WebSocket] Payload:`, JSON.stringify(message.data, null, 2));
      }
      await handleWebSocketMessage(message);
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  });

  ws.on('close', () => {
    console.log('Disconnected from Discord bot');
    isConnected = false;

    // Reconnect after 5 seconds
    setTimeout(() => {
      console.log('Attempting to reconnect...');
      connect();
    }, 5000);
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
    isConnected = false;
  });
}

function sendHeartbeat(): void {
  if (ws && isConnected) {
    ws.send(JSON.stringify({
      type: 'heartbeat',
      data: {
        runnerId: RUNNER_ID,
        runnerName: RUNNER_NAME,
        cliTypes: CLI_TYPES,
        defaultWorkspace: DEFAULT_WORKSPACE,
        timestamp: new Date().toISOString()
      }
    }));
  }
}

async function handleWebSocketMessage(message: WebSocketMessage): Promise<void> {
  console.log(`[handleWebSocketMessage] Processing type: '${message.type}' (length: ${message.type.length})`);
  const type = message.type.trim(); // Trim just in case
  const handlerStartTime = Date.now();
  switch (type) {
    case 'error': {
      const data = message.data as {
        message: string;
      };
      console.error(`❌ Error from Discord bot: ${data.message}`);
      console.error('   Runner agent will exit. Please fix the issue and restart.');
      process.exit(1);
    }

    case 'registered': {
      const data = message.data as {
        runnerId: string;
        cliTypes: ('claude' | 'gemini')[];
        reclaimed?: boolean;
      };

      if (data.reclaimed) {
        console.log(`✅ Runner reclaimed token successfully: ${data.runnerId}`);
        console.log(`   (Previous offline runner was replaced)`);
      } else {
        console.log(`✅ Runner registered successfully: ${data.runnerId}`);
      }

      console.log(`   Supported CLI types: ${data.cliTypes.join(', ')}`);
      break;
    }

    case 'approval_response': {
      // Handle approval responses from Discord
      // Two flows: 1) HTTP approval (has requestId), 2) TmuxPlugin (has sessionId + optionNumber)
      const data = message.data as {
        requestId?: string;
        sessionId?: string;
        allow?: boolean;
        approved?: boolean;
        optionNumber?: string;
        message?: string;
      };

      // Flow 1: HTTP approval (legacy, for PrintPlugin)
      if (data.requestId) {
        const pending = pendingApprovals.get(data.requestId);
        if (pending) {
          pending.resolve({
            allow: data.allow ?? false,
            message: data.message
          });
          pendingApprovals.delete(data.requestId);
        }
      }

      // Flow 2: TmuxPlugin approval (Discord buttons)
      if (data.sessionId) {
        console.log(`[Approval] Received approval response for session ${data.sessionId}: ${data.approved ? 'APPROVED' : 'DENIED'}`);
        const approvalSession = cliSessions.get(data.sessionId);
        if (approvalSession) {
          // Map boolean to option number if not provided
          // 1 = Yes (approve), 3 = No (deny)
          const option = data.optionNumber || (data.approved ? '1' : '3');
          try {
            await approvalSession.sendApproval(option);
            console.log(`[Approval] Sent option ${option} to session ${data.sessionId}`);
          } catch (error) {
            console.error(`[Approval] Failed to send option ${option} to session ${data.sessionId}:`, error);
          }
        } else {
          console.error(`Session ${data.sessionId} not found for approval response`);
        }
      }

      break;
    }

    case 'session_start': {
      const data = message.data as {
        sessionId: string;
        runnerId: string;
        cliType: 'claude' | 'gemini';
        plugin?: 'tmux' | 'print';
        folderPath?: string;
      };

      console.log(`Starting session ${data.sessionId} (CLI: ${data.cliType}, Plugin: ${data.plugin || 'default'})`);

      // Detect CLI path
      let cliPath = CLI_PATHS[data.cliType];

      if (!cliPath) {
        // Try fallback detection if not found initially
        try {
          const detected = await findCliPath(data.cliType);
          if (detected) {
            CLI_PATHS[data.cliType] = detected;
            cliPath = detected;
          }
        } catch (e) {
          console.error('Failed to detect CLI paths:', e);
        }
      }

      if (!cliPath) {
        console.error(`${data.cliType} CLI not found on runner`);
        // We should send an error back, but for now just log
        break;
      }

      // Create session via PluginManager
      let rawPath = data.folderPath || process.cwd();

      // Resolve path
      let cwd = rawPath;

      // Handle ~ expansion
      if (cwd.startsWith('~')) {
        cwd = cwd.replace(/^~/, os.homedir());
      }
      // Handle relative paths (if not absolute and not starting with ~)
      else if (!path.isAbsolute(cwd)) {
        if (DEFAULT_WORKSPACE) {
          cwd = path.join(DEFAULT_WORKSPACE, cwd);
        } else {
          // Default to resolving against home if no default workspace set (safer than process.cwd)
          // Or should we stick to process.cwd? User expectation is likely "relative to my projects root"
          // but if no root is set, process.cwd is technical correct but maybe confusing.
          // Let's use process.cwd() as fallback but log it.
          cwd = path.resolve(process.cwd(), cwd);
        }
      }

      // Validate folder
      if (!fs.existsSync(cwd)) {
        if ((data as any).create) {
          console.log(`Creating folder ${cwd}...`);
          try {
            fs.mkdirSync(cwd, { recursive: true });
          } catch (e) {
            console.error(`Failed to create folder ${cwd}:`, e);
            if (isConnected && ws) {
              ws.send(JSON.stringify({
                type: 'output',
                data: {
                  runnerId: RUNNER_ID,
                  sessionId: data.sessionId,
                  content: `❌ Error: Failed to create folder ${cwd}: ${e}`,
                  outputType: 'error',
                  timestamp: new Date().toISOString()
                }
              }));
            }
            break;
          }
        } else {
          console.error(`Folder ${cwd} does not exist`);
          if (isConnected && ws) {
            // Send specific error message that bot checks for
            ws.send(JSON.stringify({
              type: 'output',
              data: {
                runnerId: RUNNER_ID,
                sessionId: data.sessionId,
                content: `❌ Error: Folder ${cwd} does not exist.`, // Special string
                outputType: 'error',
                timestamp: new Date().toISOString()
              }
            }));
            // Also send a specific event if possible, but output parsing is easier for now with current bot architecture
            // Actually, let's stick to output error for now, but we might want a specific error type later
            // Wait, the bot handles "output" type messages. 
            // We can signal this better by sending a specialized message if valid
          }
          break;
        }
      }

      try {
        if (!pluginManager) {
          console.error('PluginManager not initialized!');
          break;
        }

        const session = await pluginManager.createSession({
          cliPath,
          cwd,
          sessionId: data.sessionId,
          cliType: data.cliType,
          options: {
            skipPermissions: false, // Require manual approval via Discord
            continueConversation: true
          }
        }, data.plugin);

        console.log(`Session ${data.sessionId} created with ${data.plugin || 'default'} plugin`);

        // Store session and metadata
        cliSessions.set(data.sessionId, session);
        sessionMetadata.set(data.sessionId, {
          sessionId: data.sessionId,
          cliType: data.cliType,
          folderPath: data.folderPath,
          runnerId: data.runnerId
        });

      } catch (error) {
        console.error('Error sending message:', error);

        // Report error to Discord
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({
            type: 'output',
            data: {
              runnerId: RUNNER_ID,
              sessionId: data.sessionId,
              content: `Error: ${error instanceof Error ? error.message : String(error)}`,
              timestamp: new Date().toISOString(),
              outputType: 'error'
            }
          }));
        }
      }

      break;
    }

    case 'session_end': {
      const data = message.data as {
        sessionId: string;
      };

      console.log(`Session ended: ${data.sessionId}`);

      // Close CLI session properly
      const sessionToClose = cliSessions.get(data.sessionId);
      if (sessionToClose) {
        await sessionToClose.close();
      }

      cliSessions.delete(data.sessionId);
      sessionMetadata.delete(data.sessionId);
      pendingMessages.delete(data.sessionId);

      console.log(`Session ${data.sessionId} cleaned up`);

      break;
    }

    case 'user_message': {
      const data = message.data as {
        sessionId: string;
        userId: string;
        username: string;
        content: string;
        timestamp: string;
      };

      console.log(`Received message from ${data.username} for session ${data.sessionId}`);
      console.log(`  Content: ${data.content}`);

      // Get CLI session
      const session = cliSessions.get(data.sessionId);
      if (!session) {
        console.error(`Session ${data.sessionId} not found in CLI sessions`);
        break;
      }

      const sendMessage = async () => {
        try {
          console.log(`Sending message to Claude via TmuxPlugin...`);
          await session.sendMessage(data.content);
          console.log(`Message sent successfully to session ${data.sessionId}`);
          // Output will be emitted via PluginManager 'output' event
        } catch (error) {
          console.error(`Error sending message to CLI:`, error);
          if (isConnected && ws) {
            ws.send(JSON.stringify({
              type: 'output',
              data: {
                runnerId: RUNNER_ID,
                sessionId: data.sessionId,
                content: `❌ Error: ${error}`,
                timestamp: new Date().toISOString(),
                outputType: 'stderr'
              }
            }));
          }
        }
      };

      if (session.isReady) {
        await sendMessage();
      } else {
        console.log(`Session ${data.sessionId} NOT READY. Queuing message...`);
        // Wait for ready event
        session.once('ready', async () => {
          console.log(`Session ${data.sessionId} is now READY. Sending queued message.`);
          await sendMessage();
        });
      }

      break;
    }



    default:
      console.log('Unknown message type:', message.type);
  }
}

// HTTP server for CLI plugin approval requests
// Helper function to read request body
function readRequestBody(req: http.IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

// Helper function to send JSON response
function sendJsonResponse(res: http.ServerResponse, data: any, statusCode: number = 200): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(JSON.stringify(data));
}

// HTTP server for CLI plugin approval requests
const server = http.createServer(async (req, res) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  const url = new URL(req.url || '', `http://${req.headers.host}`);

  // Health check
  if (req.method === 'GET' && url.pathname === '/') {
    sendJsonResponse(res, {
      name: 'DisCode Runner Agent',
      version: '0.1.0',
      runnerId: RUNNER_ID,
      runnerName: RUNNER_NAME,
      cliTypes: CLI_TYPES,
      connected: isConnected
    });
    return;
  }

  // Approval request from CLI plugin
  if (req.method === 'POST' && url.pathname === '/approval') {
    try {
      let rawData = await readRequestBody(req);

      // Handle both snake_case (from Claude hooks) and camelCase (our API)
      const approvalReq: ApprovalRequest = {
        toolName: (rawData.tool_name || rawData.toolName) as string,
        toolInput: rawData.tool_input || rawData.toolInput,
        sessionId: rawData.session_id || rawData.sessionId,
        timestamp: rawData.timestamp || new Date().toISOString(),
        cli: rawData.cli,
        runnerId: rawData.runner_id || rawData.runnerId
      };

      console.log(`Received approval request for tool: ${approvalReq.toolName}`);
      console.log(`Session ID: ${approvalReq.sessionId}`);

      if (!isConnected) {
        sendJsonResponse(res, {
          allow: false,
          message: 'Not connected to Discord bot'
        }, 503);
        return;
      }

      // Generate request ID
      const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(7)}`;

      console.log(`Sending approval request ${requestId} to Discord bot...`);

      // Send approval request to Discord bot via WebSocket
      if (isConnected && ws) {
        ws.send(JSON.stringify({
          type: 'approval_request',
          data: {
            requestId: requestId,
            sessionId: approvalReq.sessionId,
            runnerId: approvalReq.runnerId,
            toolName: approvalReq.toolName,
            toolInput: approvalReq.toolInput,
            cli: approvalReq.cli,
            timestamp: approvalReq.timestamp
          }
        }));
        console.log(`Approval request ${requestId} sent to Discord bot`);
      } else {
        console.error(`Cannot send approval request - WebSocket not connected`);
        sendJsonResponse(res, {
          allow: false,
          message: 'Not connected to Discord bot'
        }, 503);
        return;
      }

      // Wait for response with timeout protection
      let responseSent = false;
      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Approval timeout')), 30000)
        );

        const approvalPromise = (async () => {
          // Wait for response
          const response = await waitForApproval(requestId, 30000);
          return response;
        })();

        const response = await Promise.race([approvalPromise, timeoutPromise]) as { allow: boolean; message?: string };

        sendJsonResponse(res, response);
        responseSent = true;

        if (!response.allow) {
          console.log(`Approval ${requestId} denied: ${response.message}`);
        }
      } catch (error: any) {
        console.error('Approval request error or timeout:', error.message);

        // On timeout or error, deny the operation for safety but don't crash
        if (!responseSent) {
          sendJsonResponse(res, {
            allow: false,
            message: error.message || 'Approval request timeout'
          }, 500);
        }
      }

    } catch (error) {
      console.error('Error handling approval request:', error);
      if (!res.headersSent) {
        sendJsonResponse(res, {
          allow: false,
          message: 'Error processing approval request'
        }, 500);
      }
    }
    return;
  }

  // Session event from CLI plugin
  if (req.method === 'POST' && url.pathname === '/session-event') {
    try {
      const event = await readRequestBody(req);
      console.log(`Session event: ${event.action}`);
      // TODO: Send to Discord bot
      sendJsonResponse(res, { success: true });
    } catch (error) {
      console.error('Error handling session event:', error);
      sendJsonResponse(res, { error: 'Invalid request' }, 400);
    }
    return;
  }

  // Get pending messages for a session
  if (req.method === 'GET' && url.pathname === '/messages') {
    const sessionId = url.searchParams.get('sessionId');

    if (!sessionId) {
      sendJsonResponse(res, { error: 'sessionId parameter is required' }, 400);
      return;
    }

    const messages = pendingMessages.get(sessionId) || [];
    pendingMessages.set(sessionId, []);

    sendJsonResponse(res, {
      messages,
      count: messages.length
    });
    return;
  }

  // Output streaming from CLI
  if (req.method === 'POST' && url.pathname === '/output') {
    try {
      const data = await readRequestBody(req);

      if (isConnected && ws) {
        ws.send(JSON.stringify({
          type: 'output',
          data: {
            runnerId: RUNNER_ID,
            sessionId: data.sessionId,
            content: data.content,
            timestamp: new Date().toISOString()
          }
        }));
      }

      sendJsonResponse(res, { success: true });

    } catch (error) {
      console.error('Error handling output:', error);
      sendJsonResponse(res, { error: 'Invalid request' }, 400);
    }
    return;
  }

  // 404
  sendJsonResponse(res, { error: 'Not found' }, 404);
});

server.listen(HTTP_PORT, () => {
  console.log(`HTTP server listening on port ${HTTP_PORT}`);
});

function waitForApproval(requestId: string, timeout: number): Promise<{ allow: boolean; message?: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingApprovals.delete(requestId);
      reject(new Error('Approval request timeout'));
    }, timeout);

    pendingApprovals.set(requestId, {
      resolve: (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      }
    });
  });
}

// Heartbeat interval (every 30 seconds)
setInterval(() => {
  sendHeartbeat();
}, 30000);

// Start connection
connect();

// Start Hook Server
try {
  const hookServer = getHookServer();
  hookServer.start();
  console.log('HookServer started');
} catch (error) {
  console.error('Failed to start HookServer:', error);
}

// Detect CLI paths and initialize PluginManager
(async () => {
  console.log('Detecting CLI installations...');

  for (const cliType of CLI_TYPES) {
    const path = await findCliPath(cliType);
    CLI_PATHS[cliType] = path;

    if (!path) {
      console.error(`  ERROR: ${cliType.toUpperCase()} CLI not found!`);
      console.error(`  Searched in:`);
      console.error(`    - System PATH`);
      console.error(`    - ~/.local/bin`);
      console.error(`    - /usr/local/bin`);
      console.error(`    - /opt/homebrew/bin`);
      console.error(`\n  Please install ${cliType} CLI or add it to your PATH`);
    } else {
      console.log(`  ✓ ${cliType.toUpperCase()}: ${path}`);
    }
  }

  // Initialize PluginManager (uses TmuxPlugin by default)
  console.log('\nInitializing PluginManager...');
  try {
    pluginManager = getPluginManager();
    await pluginManager.initialize();
    console.log('  ✓ PluginManager initialized');

    // Wire PluginManager events to Discord WebSocket
    pluginManager.on('output', (data) => {
      if (isConnected && ws) {
        ws.send(JSON.stringify({
          type: 'output',
          data: {
            runnerId: RUNNER_ID,
            sessionId: data.sessionId,
            content: data.content,
            timestamp: data.timestamp.toISOString(),
            outputType: data.outputType
          }
        }));
      }
    });

    pluginManager.on('approval', (data) => {
      console.log(`[PluginManager] Approval detected for session ${data.sessionId}: ${data.tool}`);
      if (isConnected && ws) {
        // Generate requestId for tracking
        const requestId = `${data.sessionId}-${Date.now()}`;
        ws.send(JSON.stringify({
          type: 'approval_request',
          data: {
            runnerId: RUNNER_ID,
            sessionId: data.sessionId,
            requestId,
            toolName: data.tool,
            toolInput: data.context,
            options: data.options?.map((o: any) => o.label || o), // Flatten options to strings for Discord
            timestamp: data.detectedAt.toISOString()
          }
        }));
      }
    });

    pluginManager.on('status', (data) => {
      console.log(`[PluginManager] Status change for ${data.sessionId}: ${data.status}`);
      if (isConnected && ws) {
        ws.send(JSON.stringify({
          type: 'status',
          data: {
            runnerId: RUNNER_ID,
            sessionId: data.sessionId,
            status: data.status,
            currentTool: data.currentTool
          }
        }));
      }
    });

    pluginManager.on('metadata', (data) => {
      console.log(`[PluginManager] Metadata for ${data.sessionId}: tokens=${data.tokens} activity=${data.activity} mode=${data.mode}`);
      if (isConnected && ws) {
        ws.send(JSON.stringify({
          type: 'metadata',
          data: {
            runnerId: RUNNER_ID,
            sessionId: data.sessionId,
            tokens: data.tokens,
            cumulativeTokens: data.cumulativeTokens,
            activity: data.activity,
            mode: data.mode
          }
        }));
      }
    });

    pluginManager.on('error', (data) => {
      console.error(`[PluginManager] Error for ${data.sessionId}: ${data.error}`);
      if (isConnected && ws) {
        ws.send(JSON.stringify({
          type: 'output',
          data: {
            runnerId: RUNNER_ID,
            sessionId: data.sessionId,
            content: `Error: ${data.error}`,
            timestamp: new Date().toISOString(),
            outputType: 'error'
          }
        }));
      }
    });

    pluginManager.on('error', (data) => {
      console.error(`[PluginManager] Error for ${data.sessionId}: ${data.error}`);
      if (isConnected && ws) {
        ws.send(JSON.stringify({
          type: 'output',
          data: {
            runnerId: RUNNER_ID,
            sessionId: data.sessionId,
            content: `❌ Error: ${data.error}`,
            timestamp: new Date().toISOString(),
            outputType: 'stderr'
          }
        }));
      }
    });

  } catch (error) {
    console.error(`  ✗ PluginManager initialization failed:`, error);
  }

  console.log('');
})();

console.log(`
╔════════════════════════════════════════════════════════════╗
║           DisCode Runner Agent v0.1.0                     ║
╠════════════════════════════════════════════════════════════╣
║  Runner ID: ${RUNNER_ID.padEnd(48)}║
║  Runner Name: ${RUNNER_NAME.padEnd(44)}║
║  CLI Types: ${CLI_TYPES.join(', ').padEnd(47)}║
║  HTTP Server: http://localhost:${HTTP_PORT.toString().padEnd(39)}║
║  Bot WebSocket: ${BOT_WS_URL.padEnd(43)}║
╚════════════════════════════════════════════════════════════╝
`);

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down Runner Agent...');
  if (ws) {
    ws.close();
  }
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
});
