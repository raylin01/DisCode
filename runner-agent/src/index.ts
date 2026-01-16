/**
 * DisCode Runner Agent
 *
 * Connects to Discord bot via WebSocket and provides HTTP server for CLI plugins
 */

import WebSocket from 'ws';
import { Bun} from 'bun';
import type { ApprovalRequest, WebSocketMessage } from '../shared/types.js';

// Configuration
const BOT_WS_URL = process.env.DISCORDE_BOT_URL || 'ws://localhost:8080';
const TOKEN = process.env.DISCORDE_TOKEN;
const RUNNER_NAME = process.env.DISCORDE_RUNNER_NAME || 'local-runner';
const CLI_TYPE = (process.env.DISCORDE_CLI_TYPE || 'claude') as 'claude' | 'gemini';
const HTTP_PORT = parseInt(process.env.DISCORDE_HTTP_PORT || '3000');

if (!TOKEN) {
  console.error('Missing DISCORDE_TOKEN environment variable');
  process.exit(1);
}

// Generate runner ID
const RUNNER_ID = `runner_${RUNNER_NAME.replace(/\s+/g, '_').toLowerCase()}_${Date.now()}`;

// WebSocket connection to Discord bot
let ws: WebSocket | null = null;
let isConnected = false;

// Pending approval requests (requestId -> { resolve, reject })
const pendingApprovals = new Map<string, {
  resolve: (response: { allow: boolean; message?: string }) => void;
  reject: (error: Error) => void;
}>();

// Connect to Discord bot
function connect(): void {
  console.log(`Connecting to Discord bot at ${BOT_WS_URL}...`);

  ws = new WebSocket(BOT_WS_URL);

  ws.on('open', () => {
    console.log('Connected to Discord bot');
    isConnected = true;

    // Send heartbeat to register
    sendHeartbeat();
  });

  ws.on('message', (data: Buffer) => {
    try {
      const message: WebSocketMessage = JSON.parse(data.toString());
      handleWebSocketMessage(message);
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
        timestamp: new Date().toISOString()
      }
    }));
  }
}

function handleWebSocketMessage(message: WebSocketMessage): void {
  switch (message.type) {
    case 'approval_response': {
      const data = message.data as {
        requestId: string;
        allow: boolean;
        message?: string;
      };

      const pending = pendingApprovals.get(data.requestId);
      if (pending) {
        pending.resolve({
          allow: data.allow,
          message: data.message
        });
        pendingApprovals.delete(data.requestId);
      }
      break;
    }

    default:
      console.log('Unknown message type:', message.type);
  }
}

// HTTP server for CLI plugin approval requests
const server = Bun.serve({
  port: HTTP_PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // CORS headers
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (req.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Health check
    if (req.method === 'GET' && url.pathname === '/') {
      return Response.json({
        name: 'DisCode Runner Agent',
        version: '0.1.0',
        runnerId: RUNNER_ID,
        runnerName: RUNNER_NAME,
        cliType: CLI_TYPE,
        connected: isConnected
      }, { headers: corsHeaders });
    }

    // Approval request from CLI plugin
    if (req.method === 'POST' && url.pathname === '/approval') {
      try {
        const approvalReq: ApprovalRequest = await req.json();

        console.log(`Received approval request for tool: ${approvalReq.toolName}`);

        if (!isConnected) {
          return Response.json({
            allow: false,
            message: 'Not connected to Discord bot'
          }, { status: 503, headers: corsHeaders });
        }

        // Generate request ID
        const requestId = `req_${Date.now()}_${Math.random().toString(36).substring(7)}`;

        // Send approval request to Discord bot
        ws?.send(JSON.stringify({
          type: 'approval_request',
          data: {
            requestId,
            runnerId: RUNNER_ID,
            sessionId: approvalReq.sessionId,
            toolName: approvalReq.toolName,
            toolInput: approvalReq.toolInput,
            timestamp: approvalReq.timestamp
          }
        }));

        // Wait for response (with timeout)
        const response = await waitForApproval(requestId, 30000);

        return Response.json(response, { headers: corsHeaders });

      } catch (error) {
        console.error('Error handling approval request:', error);
        return Response.json({
          allow: false,
          message: 'Error processing approval request'
        }, { status: 500, headers: corsHeaders });
      }
    }

    // Session event from CLI plugin
    if (req.method === 'POST' && url.pathname === '/session-event') {
      try {
        const event = await req.json();

        console.log(`Session event: ${event.action}`);

        // TODO: Send to Discord bot
        // For now, just acknowledge
        return Response.json({ success: true }, { headers: corsHeaders });

      } catch (error) {
        console.error('Error handling session event:', error);
        return Response.json({
          error: 'Invalid request'
        }, { status: 400, headers: corsHeaders });
      }
    }

    // Output streaming from CLI
    if (req.method === 'POST' && url.pathname === '/output') {
      try {
        const data = await req.json();

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

        return Response.json({ success: true }, { headers: corsHeaders });

      } catch (error) {
        console.error('Error handling output:', error);
        return Response.json({
          error: 'Invalid request'
        }, { status: 400, headers: corsHeaders });
      }
    }

    return Response.json({
      error: 'Not found'
    }, { status: 404, headers: corsHeaders });
  },
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

console.log(`
╔════════════════════════════════════════════════════════════╗
║           DisCode Runner Agent v0.1.0                     ║
╠════════════════════════════════════════════════════════════╣
║  Runner ID: ${RUNNER_ID.padEnd(48)}║
║  Runner Name: ${RUNNER_NAME.padEnd(44)}║
║  CLI Type: ${CLI_TYPE.padEnd(48)}║
║  HTTP Server: http://localhost:${HTTP_PORT.toString().padEnd(39)}║
║  Bot WebSocket: ${BOT_WS_URL.padEnd(43)}║
╚════════════════════════════════════════════════════════════╝
`);

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down Runner Agent...');
  if (ws) {
    ws.close();
  }
  server.stop();
  process.exit(0);
});
