/**
 * DisCode Discord Bot - Enhanced (Phase 2 & 3)
 *
 * Features:
 * - Multi-runner support with selection UI
 * - Rich embeds for tool use, output, errors
 * - Enhanced permission system
 * - Action item extraction
 * - Better error handling
 *
 * Note: Using flags: 64 for ephemeral responses (MessageFlags.Ephemeral)
 */

import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, WebhookClient } from 'discord.js';
import { WebSocketServer } from 'ws';
import { randomUUID } from 'crypto';
import { storage } from './storage.js';
import type { ApprovalRequest, RunnerInfo, WebSocketMessage, Session } from '../../shared/types.js';

// Configuration
const DISCORD_TOKEN = process.env.DISCORDE_DISCORD_TOKEN;
const DISCORD_CLIENT_ID = process.env.DISCORDE_DISCORD_CLIENT_ID;
const WS_PORT = parseInt(process.env.DISCORDE_WS_PORT || '8080');

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  console.error('Missing DISCORD_TOKEN or DISCORD_CLIENT_ID environment variables');
  process.exit(1);
}

// Discord bot client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// Track if bot is ready
let isBotReady = false;

// Active WebSocket connections (runnerId -> ws)
const runnerConnections = new Map<string, any>();

// Pending approvals (requestId -> { userId, channelId, messageId, runnerId, sessionId, toolName, toolInput })
const pendingApprovals = new Map<string, {
  userId: string;
  channelId: string;
  messageId: string;
  runnerId: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
}>();

// Allowed tools per session (sessionId -> Set of toolNames that are auto-approved)
const allowedTools = new Map<string, Set<string>>();

// Action items extracted from sessions (sessionId -> actionItems)
const actionItems = new Map<string, string[]>();

// Streaming message tracker (sessionId -> { messageId, lastUpdateTime, content })
const streamingMessages = new Map<string, {
  messageId: string;
  lastUpdateTime: number;
  content: string;
  outputType: string;
}>();

// Session creation state (userId -> { step, runnerId, cliType, plugin, folderPath, messageId })
const sessionCreationState = new Map<string, {
  step: 'select_runner' | 'select_cli' | 'select_plugin' | 'select_folder' | 'complete';
  runnerId?: string;
  cliType?: 'claude' | 'gemini';
  plugin?: 'tmux' | 'print';
  folderPath?: string;
  messageId?: string;
}>();

// Helper function to get or create the Runners category
async function getOrCreateRunnersCategory(guildId: string): Promise<string> {
  // Wait for bot to be ready
  if (!isBotReady) {
    await new Promise(resolve => {
      const checkInterval = setInterval(() => {
        if (isBotReady) {
          clearInterval(checkInterval);
          resolve(true);
        }
      }, 100);
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve(true);
      }, 5000);
    });
  }

  const guild = await client.guilds.fetch(guildId);

  // Try to find existing category
  const existingCategory = guild.channels.cache.find(channel =>
    channel.name === 'Runners' && channel.type === ChannelType.GuildCategory
  );

  if (existingCategory) {
    return existingCategory.id;
  }

  // Create new category
  const category = await guild.channels.create({
    name: 'Runners',
    type: ChannelType.GuildCategory
  });

  console.log(`Created runners category: ${category.id}`);
  return category.id;
}

// Helper function to get or create a private channel for a runner
async function getOrCreateRunnerChannel(runner: RunnerInfo, guildId: string): Promise<string> {
  // Wait for bot to be ready (max 5 seconds)
  if (!isBotReady) {
    console.log('Waiting for bot to be ready before creating channel...');
    await new Promise(resolve => {
      const checkInterval = setInterval(() => {
        if (isBotReady) {
          clearInterval(checkInterval);
          resolve(true);
        }
      }, 100);
      // Timeout after 5 seconds
      setTimeout(() => {
        clearInterval(checkInterval);
        resolve(true);
      }, 5000);
    });
  }

  // If runner already has a private channel, return it
  if (runner.privateChannelId) {
    try {
      const channel = await client.channels.fetch(runner.privateChannelId);
      if (channel) {
        return runner.privateChannelId;
      }
    } catch (error) {
      // Channel doesn't exist, continue to create new one
      console.error(`Error fetching runner channel: ${error}`);
    }
  }

  // Get or create runners category
  const categoryId = await getOrCreateRunnersCategory(guildId);

  // Create a new private channel for the runner
  const guild = await client.guilds.fetch(guildId);

  // Check if a channel with this runner's name already exists in the category
  const existingChannels = guild.channels.cache.filter(channel =>
    channel.name === runner.name &&
    channel.type === ChannelType.GuildText &&
    channel.parentId === categoryId
  );

  if (existingChannels.size > 0) {
    const existingChannel = existingChannels.first()!;
    console.log(`Found existing channel ${existingChannel.id} for runner ${runner.name}, reusing it`);
    runner.privateChannelId = existingChannel.id;
    storage.registerRunner(runner);
    return existingChannel.id;
  }

  // Build permission overwrites - deny everyone, allow owner + shared users
  const permissionOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: ['ViewChannel', 'ReadMessageHistory', 'SendMessages']
    }
  ];

  // Add owner permissions (validate ID is not null/undefined)
  if (runner.ownerId) {
    console.log(`Adding owner ${runner.ownerId} to permission overwrites for runner ${runner.name}`);
    permissionOverwrites.push({
      id: runner.ownerId,
      allow: ['ViewChannel', 'ReadMessageHistory', 'SendMessages', 'CreatePublicThreads', 'CreatePrivateThreads', 'ManageThreads', 'SendMessagesInThreads']
    });
  }

  // Add shared users (filter out null/undefined and owner)
  const sharedUsers = runner.authorizedUsers.filter(userId => userId && userId !== runner.ownerId);
  console.log(`Adding ${sharedUsers.length} shared users to permission overwrites for runner ${runner.name}`);
  sharedUsers.forEach(userId => {
    console.log(`  - Adding user ${userId}`);
    permissionOverwrites.push({
      id: userId,
      allow: ['ViewChannel', 'ReadMessageHistory', 'SendMessages', 'CreatePublicThreads', 'CreatePrivateThreads', 'SendMessagesInThreads']
    });
  });

  console.log(`Creating channel ${runner.name} with ${permissionOverwrites.length} permission overwrites`);

  const channel = await guild.channels.create({
    name: runner.name,
    type: ChannelType.GuildText,
    parent: categoryId, // Place in runners category
    permissionOverwrites
  });

  // Update runner with new channel ID
  runner.privateChannelId = channel.id;
  storage.registerRunner(runner);

  console.log(`Created private channel ${channel.id} for runner ${runner.name} in category ${categoryId} (shared with ${runner.authorizedUsers.length} users)`);
  return channel.id;
}

// Helper function to update channel permissions for a runner
async function updateRunnerChannelPermissions(runner: RunnerInfo): Promise<void> {
  if (!runner.privateChannelId) {
    return;
  }

  try {
    const channel = await client.channels.fetch(runner.privateChannelId);
    if (!channel || !('permissionOverwrites' in channel)) {
      return;
    }

    // Update permission overwrites for all authorized users
    for (const userId of runner.authorizedUsers) {
      const existingOverwrite = channel.permissionOverwrites.cache.get(userId);

      if (!existingOverwrite) {
        // Add permission for this user
        await channel.permissionOverwrites.create(userId, {
          ViewChannel: true,
          ReadMessageHistory: true,
          SendMessages: true,
          CreatePublicThreads: true,
          CreatePrivateThreads: true,
          SendMessagesInThreads: true
        });
        console.log(`Added permissions for user ${userId} in runner channel ${runner.privateChannelId}`);
      }
    }
  } catch (error) {
    console.error(`Error updating channel permissions: ${error}`);
  }
}

// WebSocket server for runners
const wss = new WebSocketServer({ port: WS_PORT, noServer: false })
  .on('listening', () => {
    console.log(`WebSocket server listening on port ${WS_PORT}`);
  })
  .on('error', (error: Error) => {
    if ((error as any).code === 'EADDRINUSE') {
      console.error(`Port ${WS_PORT} is already in use. Please stop the other process or change DISCORDE_WS_PORT.`);
      process.exit(1);
    } else {
      console.error('WebSocket server error:', error);
    }
  });

wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection');

  ws.on('message', async (data: Buffer) => {
    try {
      const message: WebSocketMessage = JSON.parse(data.toString());
      console.log(`[WS] Received message type: ${message.type}`);
      await handleWebSocketMessage(ws, message);
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  });

  ws.on('close', async () => {
    console.log('WebSocket connection closed');
    // Remove connection
    for (const [runnerId, connection] of runnerConnections.entries()) {
      if (connection === ws) {
        runnerConnections.delete(runnerId);
        storage.updateRunnerStatus(runnerId, 'offline');

        // Notify owner about runner going offline
        const runner = storage.getRunner(runnerId);
        if (runner) {
          // End all active sessions for this runner
          await endAllRunnerSessions(runner);
          notifyRunnerOffline(runner);
        }

        console.log(`Runner ${runnerId} went offline`);
        break;
      }
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

async function notifyRunnerOffline(runner: RunnerInfo): Promise<void> {
  if (!runner.ownerId) {
    console.error('Runner has no ownerId, cannot notify:', runner.runnerId);
    return;
  }

  // Only send notification if bot is ready
  if (!isBotReady) {
    console.log('Bot not ready yet, skipping runner offline notification');
    return;
  }

  // Try to send DM to owner (may fail if user has DMs disabled)
  try {
    const user = await client.users.fetch(runner.ownerId);
    await user.send({
      embeds: [createRunnerOfflineEmbed(runner)]
    });
  } catch (error: any) {
    // Error code 50007 = "Cannot send messages to this user" (DMs disabled)
    if (error.code === 50007) {
      console.log(`Could not send DM to user ${runner.ownerId} (DMs disabled or bot blocked)`);
    } else {
      console.error('Failed to send DM to runner owner:', error);
    }
    // Continue anyway - thread notifications are more important
  }

  // Send notification to the runner's private channel instead of individual threads
  if (runner.privateChannelId) {
    try {
      const channel = await client.channels.fetch(runner.privateChannelId);
      if (channel && 'send' in channel) {
        const sessions = storage.getRunnerSessions(runner.runnerId);
        const endedSessions = sessions.filter(s => s.status === 'ended');

        const embed = new EmbedBuilder()
          .setColor(0xFF6600)
          .setTitle('Runner Offline - Sessions Ended')
          .setDescription(`The runner \`${runner.name}\` has gone offline.\n\n**${endedSessions.length} active session(s) automatically ended.**`)
          .addFields(
            { name: 'Status', value: '🔴 Offline', inline: true },
            { name: 'Sessions Ended', value: `${endedSessions.length}`, inline: true },
            { name: 'Action', value: 'Start a new session when the Runner Agent comes back online', inline: false }
          )
          .setTimestamp();

        await channel.send({ embeds: [embed] });
        console.log(`Sent offline notification to runner channel ${runner.privateChannelId}`);
      }
    } catch (error) {
      console.error('Failed to send notification to runner channel:', error);
    }
  }

  // No need to notify individual threads since they're now archived
  console.log(`All sessions for runner ${runner.name} have been automatically ended and archived`);
}

async function handleWebSocketMessage(ws: any, message: WebSocketMessage): Promise<void> {
  switch (message.type) {
    case 'register': {
      const data = message.data as {
        runnerId: string;
        runnerName: string;
        token: string;
        cliTypes: ('claude' | 'gemini')[];
        defaultWorkspace?: string;
      };

      // Validate token
      const tokenInfo = storage.validateToken(data.token);

      if (!tokenInfo) {
        console.error(`Runner ${data.runnerId} attempted to register with invalid token`);
        ws.send(JSON.stringify({
          type: 'error',
          data: {
            message: 'Invalid token'
          }
        }));
        ws.close();
        return;
      }

      // Check if this token is already in use by a DIFFERENT runner
      const allRunners = Object.values(storage.data.runners);
      const tokenInUse = allRunners.find(r => r.token === data.token && r.runnerId !== data.runnerId);

      if (tokenInUse) {
        // If the existing runner is ONLINE, reject the new registration (prevent conflicts)
        if (tokenInUse.status === 'online') {
          console.error(`Token already in use by ONLINE runner ${tokenInUse.runnerId}, rejecting registration from ${data.runnerId}`);
          ws.send(JSON.stringify({
            type: 'error',
            data: {
              message: `Token already in use by online runner '${tokenInUse.name}'. Stop the other instance first or wait for it to go offline.`
            }
          }));
          ws.close();
          return;
        }

        // If the existing runner is OFFLINE, allow takeover (crash recovery)
        console.log(`Token used by OFFLINE runner ${tokenInUse.runnerId}, allowing takeover by ${data.runnerId}`);

        // Delete the old runner entry first (to prevent duplicates)
        const oldRunnerId = tokenInUse.runnerId;
        storage.deleteRunner(oldRunnerId);

        // Update the existing offline runner with new info
        tokenInUse.runnerId = data.runnerId;
        tokenInUse.name = data.runnerName;
        tokenInUse.status = 'online';
        tokenInUse.lastHeartbeat = new Date().toISOString();
        tokenInUse.cliTypes = data.cliTypes;
        tokenInUse.defaultWorkspace = data.defaultWorkspace;

        // Ensure private channel exists
        if (!tokenInUse.privateChannelId) {
          try {
            tokenInUse.privateChannelId = await getOrCreateRunnerChannel(tokenInUse, tokenInfo.guildId);
          } catch (error) {
            console.error(`Failed to create private channel for reclaimed runner: ${error}`);
          }
        }

        storage.registerRunner(tokenInUse);
        runnerConnections.set(data.runnerId, ws);
        console.log(`Reclaimed offline runner: ${data.runnerId} (old: ${oldRunnerId}, CLI types: ${data.cliTypes.join(', ')})`);

        ws.send(JSON.stringify({
          type: 'registered',
          data: {
            runnerId: data.runnerId,
            cliTypes: data.cliTypes,
            reclaimed: true
          }
        }));
        return;
      }

      // Check if runner already exists
      const existingRunner = storage.getRunner(data.runnerId);

      if (existingRunner) {
        // Update existing runner
        existingRunner.cliTypes = data.cliTypes;
        existingRunner.status = 'online';
        existingRunner.lastHeartbeat = new Date().toISOString();
        if (data.defaultWorkspace) existingRunner.defaultWorkspace = data.defaultWorkspace;

        // Ensure private channel exists
        if (!existingRunner.privateChannelId) {
          try {
            existingRunner.privateChannelId = await getOrCreateRunnerChannel(existingRunner, tokenInfo.guildId);
          } catch (error) {
            console.error(`Failed to create private channel for existing runner: ${error}`);
          }
        }

        storage.registerRunner(existingRunner);
        runnerConnections.set(data.runnerId, ws);
        console.log(`Runner ${data.runnerId} re-registered (CLI types: ${data.cliTypes.join(', ')})`);
      } else {
        // Validate token has userId
        if (!tokenInfo.userId) {
          console.error('Token does not have a valid userId, cannot register runner');
          ws.send(JSON.stringify({
            type: 'error',
            data: {
              message: 'Invalid token: missing user ID. Please regenerate your token with /generate-token'
            }
          }));
          ws.close();
          return;
        }

        // Create new runner
        const newRunner: RunnerInfo = {
          runnerId: data.runnerId,
          name: data.runnerName,
          ownerId: tokenInfo.userId,
          token: data.token,
          status: 'online',
          lastHeartbeat: new Date().toISOString(),
          authorizedUsers: [tokenInfo.userId],
          cliTypes: data.cliTypes,
          defaultWorkspace: data.defaultWorkspace
        };

        // Create private channel for the runner
        try {
          newRunner.privateChannelId = await getOrCreateRunnerChannel(newRunner, tokenInfo.guildId);
        } catch (error) {
          console.error(`Failed to create private channel for runner: ${error}`);
          // Continue anyway, channel creation is not critical
        }

        storage.registerRunner(newRunner);
        runnerConnections.set(data.runnerId, ws);
        console.log(`New runner registered: ${data.runnerId} (CLI types: ${data.cliTypes.join(', ')})`);
      }

      ws.send(JSON.stringify({
        type: 'registered',
        data: {
          runnerId: data.runnerId,
          cliTypes: data.cliTypes
        }
      }));
      break;
    }

    case 'heartbeat': {
      const data = message.data as {
        runnerId: string;
        runnerName?: string;
        cliTypes?: ('claude' | 'gemini')[];
        timestamp: string;
        cpu?: number;
        memory?: number;
        activeSessions?: number;
      };

      storage.updateRunnerStatus(data.runnerId, 'online');

      // Register connection if not already
      if (!runnerConnections.has(data.runnerId)) {
        runnerConnections.set(data.runnerId, ws);
        console.log(`Runner ${data.runnerId} heartbeat received`);
      }
      break;
    }

    case 'approval_request': {
      const data = message.data as {
        requestId: string;
        runnerId: string;
        sessionId: string;
        toolName: string;
        toolInput: unknown;
        timestamp: string;
        options?: string[];  // TmuxPlugin provides options array
      };

      await handleApprovalRequest(ws, data);
      break;
    }

    case 'output': {
      const data = message.data as {
        runnerId: string;
        sessionId: string;
        content: string;
        timestamp: string;
        outputType?: 'stdout' | 'stderr' | 'tool_use' | 'tool_result' | 'error';
      };

      await handleOutput(data);
      break;
    }

    case 'action_item': {
      const data = message.data as {
        sessionId: string;
        actionItem: string;
      };

      await handleActionItem(data);
      break;
    }

    case 'metadata': {
      const data = message.data as {
        runnerId: string;
        sessionId: string;
        tokens?: number;
        activity?: string;
        mode?: string;
      };

      await handleMetadata(data);
      break;
    }

    case 'session_ready': {
      const data = message.data as {
        runnerId: string;
        sessionId: string;
      };

      await handleSessionReady(data);
      break;
    }

    case 'status': {
      const data = message.data as {
        runnerId: string;
        sessionId: string;
        status: 'idle' | 'working' | 'waiting' | 'offline' | 'error';
        currentTool?: string;
      };
      await handleRunnerStatusUpdate(data);
      break;
    }

    case 'session_discovered': {
      const data = message.data as {
        runnerId: string;
        sessionId: string;
        exists: boolean;
      };
      await handleSessionDiscovered(data);
      break;
    }

    case 'terminal_list': {
      const data = message.data as {
        runnerId: string;
        terminals: string[];
      };
      await handleTerminalList(data);
      break;
    }

    default:
      console.log('Unknown message type:', message.type);
  }
}

async function handleSessionDiscovered(data: { runnerId: string; sessionId: string; exists: boolean }): Promise<void> {
  const { runnerId, sessionId, exists } = data;

  const runner = storage.getRunner(runnerId);
  if (!runner) return;
  if (!runner.privateChannelId) return;

  // Check if we already know about this session
  const existingSession = storage.getSession(sessionId);

  if (existingSession) {
    // If session is active, nothing to do
    if (existingSession.status === 'active') {
      return;
    }

    // If session was ended, try to reactivate the thread
    if (existingSession.status === 'ended') {
      try {
        const existingThread = await client.channels.fetch(existingSession.threadId);
        if (existingThread && 'setArchived' in existingThread) {
          // Unarchive the thread
          await existingThread.setArchived(false);

          // Update session status
          storage.updateSession(sessionId, { status: 'active' });
          sessionStatuses.set(sessionId, 'idle');

          // Ping owner in thread
          const embed = new EmbedBuilder()
            .setColor(0x00FF00) // Green
            .setTitle('Session Reactivated')
            .setDescription(`Runner restarted and found existing tmux session \`${sessionId}\`. Thread reactivated.`)
            .setTimestamp();

          await existingThread.send({
            content: runner.ownerId ? `<@${runner.ownerId}>` : '',
            embeds: [embed]
          });

          console.log(`Reactivated discovered session ${sessionId} for runner ${runner.name}`);
          return;
        }
      } catch (e) {
        console.log(`Could not reactivate thread for discovered session ${sessionId}:`, e);
        // Fall through to create new thread
      }
    }
  }

  // Create a new thread for this session
  try {
    const channel = await client.channels.fetch(runner.privateChannelId);
    if (!channel || !('threads' in channel)) return;

    // Create a thread for this session
    const thread = await channel.threads.create({
      name: `📺 ${sessionId}`,
      autoArchiveDuration: 60,
      reason: `Auto-discovered tmux session ${sessionId}`
    } as any);

    // Create session record
    const session: Session = {
      sessionId,
      runnerId,
      channelId: runner.privateChannelId,
      threadId: thread.id,
      createdAt: new Date().toISOString(),
      status: 'active',
      cliType: 'claude', // Default, we don't know for sure but tmux is generic
      // We don't have a folder path or interaction token for discovered sessions
    };

    storage.createSession(session);

    // add to sessionStatuses
    sessionStatuses.set(sessionId, 'idle');

    // Notify in the thread
    const embed = new EmbedBuilder()
      .setColor(0x5865F2) // Blurple
      .setTitle('Session Discovered')
      .setDescription(`Found existing tmux session \`${sessionId}\`. Attached Discord thread.`)
      .setTimestamp();

    await thread.send({
      content: runner.ownerId ? `<@${runner.ownerId}>` : '',
      embeds: [embed]
    });

    console.log(`Auto-discovered session ${sessionId} for runner ${runner.name}`);

  } catch (error) {
    console.error(`Failed to handle discovered session ${sessionId}:`, error);
  }
}

async function handleTerminalList(data: { runnerId: string; terminals: string[] }): Promise<void> {
  const { runnerId, terminals } = data;
  const runner = storage.getRunner(runnerId);
  if (!runner || !runner.privateChannelId) return;

  try {
    const channel = await client.channels.fetch(runner.privateChannelId);
    if (channel && 'send' in channel) {
      const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle(`Terminal List: ${runner.name}`)
        .setDescription(terminals.length > 0 ? terminals.map(t => `• \`${t}\``).join('\n') : 'No active tmux sessions found.')
        .setTimestamp();

      await channel.send({ embeds: [embed] });
    }
  } catch (e) {
    console.error('Failed to send terminal list:', e);
  }
}

async function handleSessionReady(data: { runnerId: string; sessionId: string }): Promise<void> {
  let session = storage.getSession(data.sessionId);
  const runner = storage.getRunner(data.runnerId);

  // If session doesn't exist (e.g. via /watch or auto-discovery), create it
  if (!session) {
    console.log(`[handleSessionReady] Session ${data.sessionId} not found in storage, creating new record (Watched Session)...`);

    if (!runner || !runner.privateChannelId) {
      console.error(`[handleSessionReady] Cannot create session: Runner ${data.runnerId} not found or no private channel`);
      return;
    }

    try {
      const channel = await client.channels.fetch(runner.privateChannelId);
      if (!channel || !('threads' in channel)) {
        console.error(`[handleSessionReady] Invalid runner channel`);
        return;
      }

      // Check if thread already exists? (Maybe looking by name?)
      // For now, create new thread
      const thread = await channel.threads.create({
        name: `📺 ${data.sessionId}`,
        autoArchiveDuration: 60,
        reason: `Watched session ${data.sessionId}`
      } as any);

      session = {
        sessionId: data.sessionId,
        runnerId: data.runnerId,
        channelId: runner.privateChannelId,
        threadId: thread.id,
        createdAt: new Date().toISOString(),
        status: 'active',
        cliType: 'claude', // Default
        folderPath: 'watched-session' // Placeholder
      };

      storage.createSession(session);
      sessionStatuses.set(data.sessionId, 'idle');

      // Notify availability
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('Session Connected')
        .setDescription(`Successfully connected to existing session \`${data.sessionId}\`.`)
        .setTimestamp();

      await thread.send({ embeds: [embed] });

    } catch (e) {
      console.error(`[handleSessionReady] Failed to create thread/session:`, e);
      return;
    }
  }

  // Double check session is valid now
  if (!session) return;

  // Update session status if needed (though it should be active)
  console.log(`[handleSessionReady] Session ${data.sessionId} is ready!`);

  // Notify user in the thread
  try {
    const thread = await client.channels.fetch(session.threadId);
    if (thread && thread.isThread()) {

      // If we didn't just create it (i.e. it was a "Pending" creation session), notify
      // Or just always notify to be safe?
      // For "Initializing..." sessions, we want to update the ephemeral message too.

      const readyEmbed = new EmbedBuilder()
        .setColor(0x00FF00) // Green
        .setTitle('Session Ready!')
        .setDescription(`Connected to \`${runner?.name}\`. You can now start typing commands.`)
        .addFields({
          name: 'Working Directory',
          value: `\`${session.folderPath}\``,
          inline: true
        })
        .setTimestamp();

      // Mention user
      const userMention = session.creatorId ? `<@${session.creatorId}>` : '';

      // Send thread notification
      await thread.send({
        content: `${userMention} Session is ready!`,
        embeds: [readyEmbed]
      });

      // Update the ephemeral "Initializing" message if we have the token
      if (session.interactionToken && client.application) {
        try {
          const webhook = new WebhookClient({ id: client.application.id, token: session.interactionToken });

          await webhook.editMessage('@original', {
            embeds: [readyEmbed],
            components: [] // Remove buttons
          });
          console.log(`Updated ephemeral message for session ${session.sessionId}`);
        } catch (error) {
          console.error('Failed to update ephemeral message:', error);
        }
      }
    }
  } catch (error) {
    console.error(`[handleSessionReady] Failed to notify thread:`, error);
  }
}

async function handleApprovalRequest(ws: any, data: {
  requestId: string;
  runnerId: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  timestamp: string;
  options?: string[];  // TmuxPlugin provides options array
}): Promise<void> {
  console.log('[Approval] Received request:', JSON.stringify(data, null, 2));
  console.log('[Approval] Looking up runner:', data.runnerId);
  console.log('[Approval] Looking up session:', data.sessionId);
  console.log('[Approval] Available runners:', Object.keys(storage.data.runners));
  console.log('[Approval] Available sessions:', Object.keys(storage.data.sessions));

  const runner = storage.getRunner(data.runnerId);
  if (!runner) {
    console.error('[Approval] Unknown runner:', data.runnerId);
    // Send denial response
    ws.send(JSON.stringify({
      type: 'approval_response',
      data: {
        requestId: data.requestId,
        allow: false,
        message: `Unknown runner: ${data.runnerId}`
      }
    }));
    return;
  }
  console.log('[Approval] Found runner:', runner.name);

  // Find the session
  const session = storage.getSession(data.sessionId);
  if (!session) {
    console.error('[Approval] Unknown session:', data.sessionId);
    console.error('[Approval] Available sessions:', Object.keys(storage.data.sessions));
    console.error('[Approval] Session details:', Object.entries(storage.data.sessions).map(([id, s]) => `${id}: status=${s.status}, threadId=${s.threadId}`).join('\n'));
    // Send denial response
    ws.send(JSON.stringify({
      type: 'approval_response',
      data: {
        requestId: data.requestId,
        allow: false,
        message: `Unknown session: ${data.sessionId}. Please start a new session in Discord.`
      }
    }));
    return;
  }
  console.log('[Approval] Found session:', session.sessionId, 'status:', session.status);

  // Check if this tool is auto-approved for this session
  const sessionAllowedTools = allowedTools.get(data.sessionId);
  if (sessionAllowedTools && sessionAllowedTools.has(data.toolName)) {
    console.log(`Tool ${data.toolName} is auto-approved for session ${data.sessionId}`);
    // Auto-approve without showing UI
    ws.send(JSON.stringify({
      type: 'approval_response',
      data: {
        requestId: data.requestId,
        allow: true,
        message: `Auto-approved (tool ${data.toolName} was previously allowed for all)`
      }
    }));
    return;
  }

  // Send to the thread where the conversation is happening
  const thread = await client.channels.fetch(session.threadId);
  if (!thread || !('send' in thread)) {
    console.error('Invalid thread');
    return;
  }

  // Create approval buttons
  // If TmuxPlugin provided options, use those; otherwise use default buttons
  let row: ActionRowBuilder<ButtonBuilder>;

  if (data.options && data.options.length > 0) {
    // Use options from TmuxPlugin (e.g., ["Yes", "Yes always", "No"])
    // Map option index to option number (1-based)
    const buttons = data.options.map((option, index) => {
      const optionNumber = index + 1;  // 1-based
      let style = ButtonStyle.Secondary;

      // Style first option (typically "Yes") as Success
      if (index === 0) style = ButtonStyle.Success;
      // Style last option (typically "No") as Danger
      else if (index === data.options!.length - 1) style = ButtonStyle.Danger;
      // Style middle options as Primary
      else style = ButtonStyle.Primary;

      return new ButtonBuilder()
        .setCustomId(`option_${data.requestId}_${optionNumber}`)
        .setLabel(option)
        .setStyle(style);
    });

    row = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
    console.log(`[Approval] Created ${buttons.length} buttons from TmuxPlugin options:`, data.options);
  } else {
    // Fall back to default buttons
    const allowButton = new ButtonBuilder()
      .setCustomId(`allow_${data.requestId}`)
      .setLabel('✅ Allow Once')
      .setStyle(ButtonStyle.Success);

    const allowAllButton = new ButtonBuilder()
      .setCustomId(`allow_all_${data.requestId}`)
      .setLabel('✅ Allow All (This Tool)')
      .setStyle(ButtonStyle.Primary);

    const modifyButton = new ButtonBuilder()
      .setCustomId(`modify_${data.requestId}`)
      .setLabel('✏️ Modify')
      .setStyle(ButtonStyle.Secondary);

    const denyButton = new ButtonBuilder()
      .setCustomId(`deny_${data.requestId}`)
      .setLabel('❌ Deny')
      .setStyle(ButtonStyle.Danger);

    row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(allowButton, allowAllButton, modifyButton, denyButton);
    console.log('[Approval] Created default approval buttons');
  }

  // Create rich embed
  const embed = createToolUseEmbed(runner, data.toolName, data.toolInput);

  // Ping user!
  const userMention = session.creatorId ? `<@${session.creatorId}>` : '';

  // Send approval request to thread
  const message = await thread.send({
    content: `${userMention} Approval needed!`,
    embeds: [embed],
    components: [row]
  });

  // Store pending approval
  pendingApprovals.set(data.requestId, {
    userId: runner.ownerId,
    channelId: session.threadId,
    messageId: message.id,
    runnerId: data.runnerId,
    sessionId: data.sessionId,
    toolName: data.toolName,
    toolInput: data.toolInput
  });

  console.log(`Approval request ${data.requestId} sent to Discord`);
}

async function handleOutput(data: {
  runnerId: string;
  sessionId: string;
  content: string;
  timestamp: string;
  outputType?: 'stdout' | 'stderr' | 'tool_use' | 'tool_result' | 'error';
}): Promise<void> {
  const session = storage.getSession(data.sessionId);
  if (!session) return;

  // Send to the thread, not the runner channel
  const thread = await client.channels.fetch(session.threadId);
  if (!thread || !('send' in thread)) return;

  const outputType = data.outputType || 'stdout';
  const now = Date.now();
  const STREAMING_TIMEOUT = 10000; // 10 seconds

  // Check if we should continue streaming or start a new message
  const streaming = streamingMessages.get(data.sessionId);
  const shouldStream = streaming &&
    (now - streaming.lastUpdateTime) < STREAMING_TIMEOUT &&
    streaming.outputType === outputType;

  const embed = createOutputEmbed(outputType, data.content);

  if (shouldStream) {
    // Edit the existing message
    try {
      const message = await thread.messages.fetch(streaming.messageId);
      await message.edit({ embeds: [embed] });

      // Update streaming tracker
      streamingMessages.set(data.sessionId, {
        messageId: streaming.messageId,
        lastUpdateTime: now,
        content: data.content,
        outputType: outputType
      });
    } catch (error) {
      console.error('Error editing message:', error);
      // If edit fails, send a new message
      const newMessage = await thread.send({ embeds: [embed] });
      streamingMessages.set(data.sessionId, {
        messageId: newMessage.id,
        lastUpdateTime: now,
        content: data.content,
        outputType: outputType
      });
    }
  } else {
    // Send a new message
    // Check for specific "folder missing" error (phase 6 enhancement)
    if (outputType === 'error' && data.content.includes('Folder') && data.content.includes('does not exist')) {
      const createFolderButton = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          new ButtonBuilder()
            .setCustomId(`create_folder_${data.sessionId}`)
            .setLabel('Create Folder & Retry')
            .setStyle(ButtonStyle.Success)
            .setEmoji('📁')
        );

      await thread.send({
        embeds: [embed],
        components: [createFolderButton]
      });
    } else {
      const sentMessage = await thread.send({ embeds: [embed] });

      // Update streaming tracker
      streamingMessages.set(data.sessionId, {
        messageId: sentMessage.id,
        lastUpdateTime: now,
        content: data.content,
        outputType: outputType
      });
    }
    // End of handleOutput logic for non-streaming messages
    return; // Function output return
  }
} // End of handleOutput

// Handler for create folder retry (moved outside handleOutput)
async function handleCreateFolderRetry(interaction: any, userId: string, customId: string): Promise<void> {
  const sessionId = customId.replace('create_folder_', '');
  const session = storage.getSession(sessionId);

  if (!session) {
    await interaction.reply({
      content: 'Session not found.',
      flags: 64,
      ephemeral: true
    });
    return;
  }

  const runner = storage.getRunner(session.runnerId);
  if (!runner) {
    await interaction.reply({
      content: 'Runner not found.',
      flags: 64,
      ephemeral: true
    });
    return;
  }

  // Send retry with create=true
  const ws = runnerConnections.get(runner.runnerId);
  if (ws) {
    ws.send(JSON.stringify({
      type: 'session_start',
      data: {
        sessionId: session.sessionId,
        runnerId: runner.runnerId,
        cliType: session.cliType,
        folderPath: session.folderPath,
        create: true // Request creation
      }
    }));

    await interaction.reply({
      content: `Creating folder \`${session.folderPath}\` and retrying...`,
      flags: 64,
      ephemeral: true
    });
  } else {
    await interaction.reply({
      content: 'Runner is offline.',
      flags: 64,
      ephemeral: true
    });
  }
}

async function handleActionItem(data: {
  sessionId: string;
  actionItem: string;
}): Promise<void> {
  const session = storage.getSession(data.sessionId);
  if (!session) return;

  const channel = await client.channels.fetch(session.channelId);
  if (!channel || !('send' in channel)) return;

  const items = actionItems.get(session.sessionId) || [];
  items.push(data.actionItem);
  actionItems.set(session.sessionId, items);

  // Send action item embed
  const embed = createActionItemEmbed(data.actionItem);
  await channel.send({ embeds: [embed] });
}

async function handleMetadata(data: {
  runnerId: string;
  sessionId: string;
  tokens?: number;
  activity?: string;
  mode?: string;
}): Promise<void> {
  // Update the current streaming message with activity status
  const streaming = streamingMessages.get(data.sessionId);
  if (!streaming || !data.activity) return;

  const session = storage.getSession(data.sessionId);
  if (!session) return;

  try {
    const thread = await client.channels.fetch(session.threadId);
    if (!thread || !('messages' in thread)) return;

    const message = await thread.messages.fetch(streaming.messageId);
    if (!message || message.embeds.length === 0) return;

    // Clone the embed and update footer
    const embed = EmbedBuilder.from(message.embeds[0]);
    embed.setFooter({ text: `Status: ${data.activity}` });

    await message.edit({ embeds: [embed] });
  } catch (error) {
    // Ignore errors (message might be deleted or not editable)
  }
}

// Discord bot events
client.once('clientReady', () => {
  console.log(`Discord bot logged in as ${client.user?.tag}`);
  isBotReady = true;
  console.log(`Bot is ready to handle runner connections`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    // Handle button interactions
    if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
      return;
    }
    // Handle modal submissions
    if (interaction.isModalSubmit()) {
      await handleModalSubmit(interaction);
      return;
    }
    return;
  }

  const { commandName, guildId } = interaction;
  const userId = interaction.user.id;

  if (!guildId) return;

  try {
    switch (commandName) {
      case 'generate-token':
        await handleGenerateToken(interaction, userId, guildId);
        break;

      case 'list-runners':
        await handleListRunners(interaction, userId);
        break;

      case 'my-access':
        await handleMyAccess(interaction, userId);
        break;

      case 'list-access':
        await handleListAccess(interaction, userId);
        break;

      case 'create-session':
        await handleCreateSession(interaction, userId);
        break;

      case 'share-runner':
        await handleShareRunner(interaction, userId);
        break;

      case 'unshare-runner':
        await handleUnshareRunner(interaction, userId);
        break;

      case 'runner-status':
        await handleRunnerStatus(interaction, userId);
        break;

      case 'action-items':
        await handleActionItems(interaction, userId);
        break;

      case 'status':
        await handleStatus(interaction, userId);
        break;

      case 'end-session':
        await handleEndSession(interaction, userId);
        break;

      case 'terminals':
        await handleTerminals(interaction, userId);
        break;

      case 'watch':
        await handleWatch(interaction, userId);
        break;

      case 'unwatch':
        await handleUnwatch(interaction, userId);
        break;

      default:
        await interaction.reply({
          content: 'Unknown command',
          flags: 64
        });
    }
  } catch (error) {
    console.error(`Error handling command ${commandName}:`, error);
    await interaction.reply({
      content: `❌ Error executing command: ${error instanceof Error ? error.message : 'Unknown error'}`,
      flags: 64
    });
  }
});

// Listen for messages in session threads and forward to CLI
client.on('messageCreate', async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  // Ignore messages not in threads
  if (!message.channel.isThread()) return;

  // Find the session for this thread
  const allSessions = Object.values(storage.data.sessions);
  const session = allSessions.find(s => s.threadId === message.channelId && s.status === 'active');

  if (!session) {
    // Not an active session thread, ignore
    return;
  }

  // Forward message to CLI via runner agent
  const runner = storage.getRunner(session.runnerId);
  if (!runner) {
    await message.reply({
      content: 'Runner not found for this session.',
      flags: 64
    });
    return;
  }

  const ws = runnerConnections.get(runner.runnerId);
  if (!ws) {
    await message.reply({
      content: 'Runner is offline. Please wait for it to come back online.',
      flags: 64
    });
    return;
  }

  // Send message to runner agent
  ws.send(JSON.stringify({
    type: 'user_message',
    data: {
      sessionId: session.sessionId,
      userId: message.author.id,
      username: message.author.username,
      content: message.content,
      timestamp: new Date().toISOString()
    }
  }));

  // Fix: Clear streaming message tracker so the next output starts a NEW message
  // This ensures that valid replies to the user's prompt are not just appended/edited into the old message
  streamingMessages.delete(session.sessionId);

  // Add a reaction to indicate the message was sent
  try {
    await message.react('✅');
  } catch (error) {
    // Ignore reaction errors
  }
});

// Command handlers
async function handleGenerateToken(interaction: any, userId: string, guildId: string): Promise<void> {
  const tokenInfo = storage.generateToken(userId, guildId);

  const embed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('Token Generated')
    .setDescription('Use this token to connect your Runner Agent')
    .addFields(
      { name: 'Token', value: `\`\`\`${tokenInfo.token}\`\`\``, inline: false },
      { name: 'Warning', value: 'Keep this token secret! Anyone with this token can access your runners.', inline: false }
    )
    .setTimestamp()
    .setFooter({ text: `Created at ${new Date(tokenInfo.createdAt).toLocaleString()}` });

  await interaction.reply({
    embeds: [embed],
    flags: 64
  });
}

async function handleListRunners(interaction: any, userId: string): Promise<void> {
  const runners = storage.getUserRunners(userId);

  if (runners.length === 0) {
    await interaction.reply({
      embeds: [createInfoEmbed('No Runners', "You don't have any runners yet. Connect a Runner Agent to get started.\n\n1. Run `/generate-token`\n2. Copy the token\n3. Start your Runner Agent with the token\n4. Run `/list-runners` again")],
      flags: 64
    });
    return;
  }

  const fields = runners.map(r => ({
    name: `${r.status === 'online' ? '🟢' : '🔴'} ${r.name}`,
    value: `ID: \`${r.runnerId}\`\nCLI: ${r.cliTypes.map(t => t.toUpperCase()).join(', ')}\nStatus: ${r.status}`,
    inline: true
  }));

  const embed = new EmbedBuilder()
    .setColor(0x0099FF)
    .setTitle('Your Runners')
    .addFields(...fields)
    .setTimestamp();

  await interaction.reply({
    embeds: [embed],
    flags: 64
  });
}

async function handleMyAccess(interaction: any, userId: string): Promise<void> {
  // Get all runners the user can access
  const allRunners = Object.values(storage.data.runners);
  const accessibleRunners = allRunners.filter(r =>
    storage.canUserAccessRunner(userId, r.runnerId)
  );

  if (accessibleRunners.length === 0) {
    await interaction.reply({
      embeds: [createInfoEmbed('No Access', "You don't have access to any runners.\n\nConnect your own runner with `/generate-token` or ask someone to share their runner with you.")],
      flags: 64
    });
    return;
  }

  const owned = accessibleRunners.filter(r => r.ownerId === userId);
  const shared = accessibleRunners.filter(r => r.ownerId !== userId);

  const fields: { name: string; value: string; inline: boolean }[] = [];

  if (owned.length > 0) {
    fields.push({
      name: 'Your Runners',
      value: owned.map(r => `• ${r.name} (${r.status === 'online' ? '🟢' : '🔴'} ${r.status})`).join('\n') || 'None',
      inline: false
    });
  }

  if (shared.length > 0) {
    fields.push({
      name: 'Shared with You',
      value: shared.map(r => `• ${r.name} (${r.status === 'online' ? '🟢' : '🔴'} ${r.status})`).join('\n') || 'None',
      inline: false
    });
  }

  const embed = new EmbedBuilder()
    .setColor(0x0099FF)
    .setTitle('Your Runner Access')
    .addFields(...fields)
    .setTimestamp();

  await interaction.reply({
    embeds: [embed],
    flags: 64
  });
}

async function handleListAccess(interaction: any, userId: string): Promise<void> {
  const runnerId = interaction.options.getString('runner');

  if (!runnerId) {
    // List all user's runners and their access
    const runners = storage.getUserRunners(userId);

    if (runners.length === 0) {
      await interaction.reply({
        embeds: [createErrorEmbed('No runners found', "You don't have any runners yet.")],
        flags: 64
      });
      return;
    }

    const fields = runners.map(r => {
      const authorizedCount = r.authorizedUsers.length;
      const value = authorizedCount === 0
        ? 'No additional users'
        : `${authorizedCount} user(s) authorized`;

      return {
        name: r.name,
        value: value,
        inline: true
      };
    });

    const embed = new EmbedBuilder()
      .setColor(0x0099FF)
      .setTitle('Runner Access Overview')
      .addFields(...fields)
      .setTimestamp();

    await interaction.reply({
      embeds: [embed],
      flags: 64
    });
    return;
  }

  // Check if user owns this runner
  const runner = storage.getRunner(runnerId);
  if (!runner || runner.ownerId !== userId) {
    await interaction.reply({
      embeds: [createErrorEmbed('Access Denied', 'You can only view access for runners you own.')],
      flags: 64
    });
    return;
  }

  // Get authorized users
  const authorizedUsers = runner.authorizedUsers;

  if (authorizedUsers.length === 0) {
    await interaction.reply({
      embeds: [createInfoEmbed('No Shared Access', 'This runner is not shared with anyone else.')],
      flags: 64
    });
    return;
  }

  // Fetch user information for each authorized user
  const userList = await Promise.all(
    authorizedUsers.map(async (uid) => {
      try {
        const user = await client.users.fetch(uid);
        return `• ${user.username} (${uid})`;
      } catch {
        return `• Unknown user (${uid})`;
      }
    })
  );

  const embed = new EmbedBuilder()
    .setColor(0x0099FF)
    .setTitle(`Users with Access to ${runner.name}`)
    .setDescription(userList.join('\n'))
    .addFields(
      { name: 'Runner ID', value: `\`${runnerId}\``, inline: true },
      { name: 'Total Users', value: `${authorizedUsers.length}`, inline: true }
    )
    .setTimestamp();

  await interaction.reply({
    embeds: [embed],
    flags: 64
  });
}

async function handleCreateSession(interaction: any, userId: string): Promise<void> {
  // Clean up any existing state for this user
  if (sessionCreationState.has(userId)) {
    sessionCreationState.delete(userId);
  }

  // Get accessible online runners
  const allRunners = storage.getUserRunners(userId).filter(r => r.status === 'online');

  // Deduplicate runners by runnerId
  const runnersMap = new Map<string, RunnerInfo>();
  allRunners.forEach(runner => {
    runnersMap.set(runner.runnerId, runner);
  });
  const runners = Array.from(runnersMap.values());

  if (runners.length === 0) {
    await interaction.reply({
      embeds: [createErrorEmbed('No Online Runners', 'No online runners available. Make sure your Runner Agent is connected.')],
      flags: 64
    });
    return;
  }

  // Check if we can auto-select the runner (Phase 6 Enhancement)
  if (runners.length === 1) {
    const runner = runners[0];

    // Auto-select this runner
    sessionCreationState.set(userId, {
      step: 'select_cli',
      runnerId: runner.runnerId
    });

    // Check if we can also auto-select the CLI type
    if (runner.cliTypes.length === 1) {
      const cliType = runner.cliTypes[0];
      const state = sessionCreationState.get(userId)!;
      state.cliType = cliType;
      state.step = 'select_plugin';
      sessionCreationState.set(userId, state);

      // Directly show plugin selection (skipping steps 1 and 2)
      const buttonRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
          new ButtonBuilder()
            .setCustomId('session_plugin_tmux')
            .setLabel('Interactive (Tmux)')
            .setStyle(ButtonStyle.Success)
            .setEmoji('🖥️'),
          new ButtonBuilder()
            .setCustomId('session_plugin_print')
            .setLabel('Basic (Print)')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('📄'),
          new ButtonBuilder()
            .setCustomId('session_cancel')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌')
        );

      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('Select Plugin Type')
        .setDescription(`Using runner \`${runner.name}\` and CLI \`${cliType.toUpperCase()}\`.`)
        .addFields(
          { name: 'Options', value: '• **Interactive (Tmux)**: Recommended. Supports persistence & approvals.\n• **Basic (Print)**: Simple request/response.', inline: false }
        )
        .setTimestamp()
        .setFooter({ text: 'Step 3 of 4: Select Plugin' }); // Corrected pagination

      await interaction.reply({
        embeds: [embed],
        components: [buttonRow],
        flags: 64
      });
      return;
    }

    // Single runner, multiple CLIs: Show CLI selection (skipping Step 1)
    const row = new ActionRowBuilder<ButtonBuilder>();
    runner.cliTypes.forEach(cliType => {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`session_cli_${cliType}`)
          .setLabel(cliType.toUpperCase())
          .setStyle(ButtonStyle.Primary)
      );
    });

    // Add cancel button (no back button since we skipped step 1)
    const navRow = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(
        new ButtonBuilder()
          .setCustomId('session_cancel')
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Danger)
          .setEmoji('❌')
      );

    const embed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle('Select CLI Type')
      .setDescription(`Runner \`${runner.name}\` selected. Choose CLI type:`)
      .addFields(
        { name: 'Selected Runner', value: runner.name, inline: true },
        { name: 'Available CLI Types', value: runner.cliTypes.map(t => t.toUpperCase()).join(', '), inline: true }
      )
      .setTimestamp()
      .setFooter({ text: 'Step 2 of 4: Select CLI Type' }); // Corrected pagination

    await interaction.reply({
      embeds: [embed],
      components: [row, navRow],
      flags: 64
    });
    return;
  }

  // Multiple runners logic (existing flow)
  // Initialize session creation state
  sessionCreationState.set(userId, {
    step: 'select_runner'
  });

  // Create runner selection buttons
  const buttonRows: ActionRowBuilder<ButtonBuilder>[] = [];

  // ... (rest of button creation logic)

  // Create buttons (max 5 per row)
  for (let i = 0; i < runners.length; i += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    const chunk = runners.slice(i, i + 5);

    chunk.forEach(runner => {
      // Use only the hash part to avoid double "runner_" prefix
      const hashPart = runner.runnerId.replace('runner_', '');
      const customId = `session_runner_${hashPart}`;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(customId)
          .setLabel(`${runner.name} (${runner.cliTypes.map(t => t.toUpperCase()).join(', ')})`)
          .setStyle(ButtonStyle.Primary)
          .setEmoji(runner.status === 'online' ? '🟢' : '🔴')
      );
    });

    buttonRows.push(row);
  }

  // Add cancel button
  const cancelRow = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('session_cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('❌')
    );

  const embed = new EmbedBuilder()
    .setColor(0x0099FF)
    .setTitle('Create New Session')
    .setDescription('Select a runner to use for this session:')
    .addFields(
      { name: 'Available Runners', value: `${runners.length} online`, inline: true }
    )
    .setTimestamp()
    .setFooter({ text: 'Step 1 of 4: Select Runner' }); // Corrected from 1 of 3

  await interaction.reply({
    embeds: [embed],
    components: [...buttonRows, cancelRow],
    flags: 64
  });
}

async function handleShareRunner(interaction: any, userId: string): Promise<void> {
  const targetUser = interaction.options.getUser('user');
  const runnerId = interaction.options.getString('runner');

  if (!targetUser || !runnerId) {
    await interaction.reply({
      embeds: [createErrorEmbed('Missing Parameters', 'User and runner are required.')],
      flags: 64
    });
    return;
  }

  const success = storage.shareRunner(userId, runnerId, targetUser.id);

  if (success) {
    const runner = storage.getRunner(runnerId);

    // Update channel permissions for the shared user
    if (runner && runner.privateChannelId) {
      await updateRunnerChannelPermissions(runner);
    }

    await interaction.reply({
      embeds: [createSuccessEmbed('Runner Shared', `Successfully shared \`${runner?.name}\` with ${targetUser.username}`)],
      flags: 64
    });
  } else {
    await interaction.reply({
      embeds: [createErrorEmbed('Failed to Share', 'Make sure you own this runner.')],
      flags: 64
    });
  }
}

async function handleUnshareRunner(interaction: any, userId: string): Promise<void> {
  const targetUser = interaction.options.getUser('user');
  const runnerId = interaction.options.getString('runner');

  if (!targetUser || !runnerId) {
    await interaction.reply({
      embeds: [createErrorEmbed('Missing Parameters', 'User and runner are required.')],
      flags: 64
    });
    return;
  }

  const success = storage.unshareRunner(userId, runnerId, targetUser.id);

  if (success) {
    const runner = storage.getRunner(runnerId);

    // Remove channel permissions for the unshared user
    if (runner && runner.privateChannelId) {
      try {
        const channel = await client.channels.fetch(runner.privateChannelId);
        if (channel && 'permissionOverwrites' in channel) {
          await channel.permissionOverwrites.delete(targetUser.id);
          console.log(`Removed permissions for user ${targetUser.id} in runner channel ${runner.privateChannelId}`);
        }
      } catch (error) {
        console.error(`Error removing channel permissions: ${error}`);
      }
    }

    await interaction.reply({
      embeds: [createSuccessEmbed('Access Revoked', `Successfully revoked ${targetUser.username}'s access to \`${runner?.name}\``)],
      flags: 64
    });
  } else {
    await interaction.reply({
      embeds: [createErrorEmbed('Failed to Revoke', 'Make sure you own this runner.')],
      flags: 64
    });
  }
}

async function handleRunnerStatus(interaction: any, userId: string): Promise<void> {
  const runnerId = interaction.options.getString('runner');

  if (!runnerId) {
    await interaction.reply({
      embeds: [createErrorEmbed('Missing Runner', 'Please specify a runner ID.')],
      flags: 64
    });
    return;
  }

  const runner = storage.getRunner(runnerId);

  if (!runner || !storage.canUserAccessRunner(userId, runnerId)) {
    await interaction.reply({
      embeds: [createErrorEmbed('Access Denied', 'Runner not found or you do not have access to it.')],
      flags: 64
    });
    return;
  }

  const sessions = storage.getRunnerSessions(runnerId);
  const activeSessions = sessions.filter(s => s.status === 'active').length;

  const embed = new EmbedBuilder()
    .setColor(runner.status === 'online' ? 0x00FF00 : 0xFF0000)
    .setTitle(`${runner.name} Status`)
    .addFields(
      { name: 'Status', value: runner.status === 'online' ? '🟢 Online' : '🔴 Offline', inline: true },
      { name: 'CLI Types', value: runner.cliTypes.map(t => t.toUpperCase()).join(', '), inline: true },
      { name: 'Active Sessions', value: `${activeSessions}`, inline: true },
      { name: 'Last Heartbeat', value: new Date(runner.lastHeartbeat).toLocaleString(), inline: true },
      { name: 'Runner ID', value: `\`${runnerId}\``, inline: false },
      { name: 'Owner', value: `<@${runner.ownerId}>`, inline: true }
    )
    .setTimestamp();

  if (runner.authorizedUsers.length > 0) {
    embed.addFields({
      name: 'Shared With',
      value: `${runner.authorizedUsers.length} user(s)`,
      inline: true
    });
  }

  await interaction.reply({
    embeds: [embed],
    flags: 64
  });
}

async function handleActionItems(interaction: any, userId: string): Promise<void> {
  const sessionId = interaction.options.getString('session');

  if (!sessionId) {
    // Show all action items across user's sessions
    const runners = storage.getUserRunners(userId);
    const allSessions = runners
      .flatMap(r => storage.getRunnerSessions(r.runnerId))
      .filter(s => s.status === 'active');

    if (allSessions.length === 0) {
      await interaction.reply({
        embeds: [createInfoEmbed('No Active Sessions', 'No active sessions with action items.')],
        flags: 64
      });
      return;
    }

    // Collect all action items
    const allItems: { sessionId: string; items: string[] }[] = [];
    for (const session of allSessions) {
      const items = actionItems.get(session.sessionId);
      if (items && items.length > 0) {
        allItems.push({ sessionId: session.sessionId, items });
      }
    }

    if (allItems.length === 0) {
      await interaction.reply({
        embeds: [createInfoEmbed('No Action Items', 'No action items found in active sessions.')],
        flags: 64
      });
      return;
    }

    const fields = allItems.flatMap(({ sessionId, items }) =>
      items.slice(0, 3).map(item => ({
        name: `✓ ${sessionId}`,
        value: item.substring(0, 100),
        inline: false
      }))
    );

    const embed = new EmbedBuilder()
      .setColor(0xFFD700)
      .setTitle('Action Items')
      .setDescription(`Found ${allItems.reduce((sum, { items }) => sum + items.length, 0)} action item(s)`)
      .addFields(...fields)
      .setTimestamp();

    await interaction.reply({
      embeds: [embed],
      flags: 64
    });
    return;
  }

  // Show action items for specific session
  const items = actionItems.get(sessionId) || [];

  if (items.length === 0) {
    await interaction.reply({
      embeds: [createInfoEmbed('No Action Items', 'No action items found for this session.')],
      flags: 64
    });
    return;
  }

  const fields = items.map((item, index) => ({
    name: `${index + 1}.`,
    value: item,
    inline: false
  }));

  const embed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle(`Action Items - ${sessionId}`)
    .addFields(...fields)
    .setTimestamp();

  await interaction.reply({
    embeds: [embed],
    flags: 64
  });
}


// Session status tracker (sessionId -> status)
const sessionStatuses = new Map<string, 'idle' | 'working' | 'waiting' | 'offline' | 'error'>();

async function handleRunnerStatusUpdate(data: {
  runnerId: string;
  sessionId: string;
  status: 'idle' | 'working' | 'waiting' | 'offline' | 'error';
  currentTool?: string;
}): Promise<void> {
  const session = storage.getSession(data.sessionId);
  if (!session) return;

  const previousStatus = sessionStatuses.get(data.sessionId) || 'idle';
  sessionStatuses.set(data.sessionId, data.status);

  // Ping on completion (transition to idle)
  // Only ping if transitioning from 'working' to 'idle'
  if (data.status === 'idle' && previousStatus === 'working') {
    const thread = await client.channels.fetch(session.threadId);
    if (thread && thread.isThread()) {
      const userMention = session.creatorId ? `<@${session.creatorId}>` : '';

      const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('✅ Execution Complete')
        .setDescription('Ready for next command.')
        .setTimestamp();

      await thread.send({
        content: `${userMention}`,
        embeds: [embed]
      });
    }
  }
}

// --- Status Command Handler ---
async function handleStatus(interaction: any, userId: string): Promise<void> {
  const runnerIdFilter = interaction.options.getString('runner');

  // Get all active sessions
  const sessions = Object.values(storage.data.sessions).filter(s => s.status === 'active');

  if (sessions.length === 0) {
    await interaction.reply({
      content: 'No active sessions found.',
      flags: 64
    });
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle('Active Sessions Status')
    .setColor(0x0099FF)
    .setTimestamp();

  for (const session of sessions) {
    if (runnerIdFilter && session.runnerId !== runnerIdFilter) continue;

    const runner = storage.getRunner(session.runnerId);
    const runnerName = runner ? runner.name : 'Unknown Runner';

    // Determine status
    let statusEmoji = '🟢'; // Ready (default)
    let statusText = 'Ready';

    // Check real-time status from map
    const currentStatus = sessionStatuses.get(session.sessionId);

    // Check for pending approvals (override other statuses)
    const isWaitingForApproval = Array.from(pendingApprovals.values()).some(p => p.sessionId === session.sessionId);

    if (isWaitingForApproval || currentStatus === 'waiting') {
      statusEmoji = '🟡';
      statusText = 'Waiting for Approval';
    } else if (currentStatus === 'working') {
      statusEmoji = '🔴';
      statusText = 'Running...';
    } else if (currentStatus === 'offline') {
      statusEmoji = '⚫';
      statusText = 'Runner Offline';
    } else if (currentStatus === 'error') {
      statusEmoji = '❌';
      statusText = 'Error State';
    }

    embed.addFields({
      name: `${statusEmoji} ${session.sessionId.substring(0, 8)}...`,
      value: `**Runner:** \`${runnerName}\`\n**Type:** ${session.cliType.toUpperCase()}\n**Status:** ${statusText}\n**Thread:** <#${session.threadId}>`,
      inline: false
    });
  }

  await interaction.reply({
    embeds: [embed],
    flags: 64
  });
}

// --- End Session Handler ---
async function handleEndSession(interaction: any, userId: string): Promise<void> {
  const sessionId = interaction.options.getString('session');
  let targetSessionId: string | null = null;

  // If no session ID provided, try to auto-detect from current channel
  if (!sessionId) {
    // Check if user is in a thread
    const channel = interaction.channel;
    if (channel && channel.isThread()) {
      // Find session for this thread
      const allSessions = Object.values(storage.data.sessions);
      const session = allSessions.find(s => s.threadId === channel.id && s.status === 'active');

      if (session) {
        targetSessionId = session.sessionId;
      }
    } else if (channel) {
      // User is in a runner channel, find oldest active session for this runner
      const allRunners = storage.getUserRunners(userId);
      const runner = allRunners.find(r => r.privateChannelId === channel.id);

      if (runner) {
        const runnerSessions = storage.getRunnerSessions(runner.runnerId)
          .filter(s => s.status === 'active')
          .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

        if (runnerSessions.length > 0) {
          targetSessionId = runnerSessions[0].sessionId;
        }
      }
    }

    // If still no session found, fall back to oldest across all runners
    if (!targetSessionId) {
      const runners = storage.getUserRunners(userId);
      const allSessions = runners
        .flatMap(r => storage.getRunnerSessions(r.runnerId))
        .filter(s => s.status === 'active')
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());

      if (allSessions.length === 0) {
        await interaction.reply({
          embeds: [createInfoEmbed('No Active Sessions', 'You have no active sessions to end.')],
          flags: 64
        });
        return;
      }

      targetSessionId = allSessions[0].sessionId;
    }

    await endSession(targetSessionId, userId);

    await interaction.reply({
      embeds: [createSuccessEmbed('Session Ended', `Ended session \`${targetSessionId}\``)],
      flags: 64
    });
    return;
  }

  // End specific session by ID
  const session = storage.getSession(sessionId);
  if (!session) {
    await interaction.reply({
      embeds: [createErrorEmbed('Session Not Found', 'This session does not exist.')],
      flags: 64
    });
    return;
  }

  const runner = storage.getRunner(session.runnerId);
  if (!runner || !storage.canUserAccessRunner(userId, session.runnerId)) {
    await interaction.reply({
      embeds: [createErrorEmbed('Access Denied', 'You do not have permission to end this session.')],
      flags: 64
    });
    return;
  }

  await endSession(sessionId, userId);

  await interaction.reply({
    embeds: [createSuccessEmbed('Session Ended', `Session \`${sessionId}\` has been ended.`)],
    flags: 64
  });
}

// --- Terminal Watch Commands ---

async function handleTerminals(interaction: any, userId: string): Promise<void> {
  const runnerId = interaction.options.getString('runner');

  // If specific runner requested
  if (runnerId) {
    const runner = storage.getRunner(runnerId);
    if (!runner || !storage.canUserAccessRunner(userId, runnerId)) {
      await interaction.reply({
        embeds: [createErrorEmbed('Access Denied', 'Runner not found or you do not have permission.')],
        flags: 64
      });
      return;
    }

    const ws = runnerConnections.get(runnerId);
    if (!ws) {
      await interaction.reply({
        embeds: [createErrorEmbed('Runner Offline', 'Runner is currently offline.')],
        flags: 64
      });
      return;
    }

    // Request terminal list from runner
    ws.send(JSON.stringify({
      type: 'list_terminals',
      data: {}
    }));

    await interaction.reply({
      content: `Requesting terminal list from \`${runner.name}\`...`,
      flags: 64
    });
    return;
  }

  // List all runners to select from
  const runners = storage.getUserRunners(userId).filter(r => r.status === 'online');

  if (runners.length === 0) {
    await interaction.reply({
      embeds: [createErrorEmbed('No Online Runners', 'No online runners found to list terminals from.')],
      flags: 64
    });
    return;
  }

  // TODO: Add UI to select runner if multiple. For now, just error if multiple or pick first if single?
  // Let's just ask user to specify runner if multiple
  if (runners.length > 1) {
    await interaction.reply({
      embeds: [createInfoEmbed('Multiple Runners', 'Please specify a runner using the `runner` option.')],
      flags: 64
    });
    return;
  }

  // Single runner case
  const runner = runners[0];
  const ws = runnerConnections.get(runner.runnerId);
  if (!ws) { // Should not happen given filter above
    await interaction.reply({
      embeds: [createErrorEmbed('Runner Offline', 'Runner is currently offline.')],
      flags: 64
    });
    return;
  }

  ws.send(JSON.stringify({
    type: 'list_terminals',
    data: {}
  }));

  await interaction.reply({
    content: `Requesting terminal list from \`${runner.name}\`...`,
    flags: 64
  });
}

async function handleWatch(interaction: any, userId: string): Promise<void> {
  const sessionId = interaction.options.getString('session');
  // Optional runner ID - if not provided, we must find a runner that HAS this session, 
  // or just pick the first online one and hope? 
  // Ideally we should ask runners "who has session X?" but that's slow.
  // We'll rely on the user providing it or picking the first online one.
  const runnerId = interaction.options.getString('runner');

  if (!sessionId) {
    await interaction.reply({
      embeds: [createErrorEmbed('Missing Session', 'Please specify the session ID (e.g., tmux session name).')],
      flags: 64
    });
    return;
  }

  // Determine target runner
  let targetRunner: RunnerInfo | undefined;

  if (runnerId) {
    targetRunner = storage.getRunner(runnerId);
    if (!targetRunner || !storage.canUserAccessRunner(userId, runnerId)) {
      await interaction.reply({
        embeds: [createErrorEmbed('Access Denied', 'Runner not found or access denied.')],
        flags: 64
      });
      return;
    }
  } else {
    // Pick first online runner
    const runners = storage.getUserRunners(userId).filter(r => r.status === 'online');
    if (runners.length === 1) {
      targetRunner = runners[0];
    } else if (runners.length === 0) {
      await interaction.reply({
        embeds: [createErrorEmbed('No Runners online', 'You need an online runner to watch sessions.')],
        flags: 64
      });
      return;
    } else {
      await interaction.reply({
        embeds: [createInfoEmbed('Multiple Runners', 'Please specify which runner to use with the `runner` option.')],
        flags: 64
      });
      return;
    }
  }

  if (!targetRunner) return;

  // Check if runner is online
  const ws = runnerConnections.get(targetRunner.runnerId);
  if (!ws) {
    await interaction.reply({
      embeds: [createErrorEmbed('Runner Offline', 'Runner is currently offline.')],
      flags: 64
    });
    return;
  }

  // Check if already watching AND active
  const existingSession = storage.getSession(sessionId);
  if (existingSession && existingSession.status === 'active') {
    await interaction.reply({
      embeds: [createErrorEmbed('Already Watching', `Session \`${sessionId}\` is already being watched/active. check /status or the existing thread.`)],
      flags: 64
    });
    return;
  }

  // Check if there's an ended/archived session we can reactivate
  if (existingSession && existingSession.status === 'ended') {
    // Reactivate the existing thread instead of creating a new one
    try {
      const existingThread = await client.channels.fetch(existingSession.threadId);
      if (existingThread && 'setArchived' in existingThread) {
        // Unarchive the thread
        await existingThread.setArchived(false);

        // Update session status
        existingSession.status = 'active';
        storage.updateSession(existingSession.sessionId, { status: 'active' });
        sessionStatuses.set(sessionId, 'idle');

        // Add user to thread (in case they were removed)
        if ('members' in existingThread) {
          await existingThread.members.add(userId);
        }

        // Ping user in thread
        const embed = new EmbedBuilder()
          .setColor(0x00FF00) // Green = reconnected
          .setTitle('Session Reactivated')
          .setDescription(`Reconnected to tmux session \`${sessionId}\` on \`${targetRunner.name}\``)
          .setTimestamp();

        await existingThread.send({
          content: `<@${userId}>`,
          embeds: [embed]
        });

        // Send watch request to runner
        const ws = runnerConnections.get(targetRunner.runnerId);
        if (ws) {
          ws.send(JSON.stringify({
            type: 'watch_terminal',
            data: { sessionId: sessionId }
          }));
        }

        await interaction.reply({
          content: `Reactivated watch on \`${sessionId}\`. Check <#${existingSession.threadId}>`,
          flags: 64
        });

        console.log(`Reactivated session ${sessionId} for user ${userId}`);
        return;
      }
    } catch (e) {
      console.log(`Could not reactivate thread for ${sessionId}, will create new one:`, e);
      // Fall through to create new thread
    }
  }

  // 1. Create Thread first
  let threadId: string;
  let channelId = targetRunner.privateChannelId;

  if (!channelId) {
    // Try to get headers? Just error for now.
    await interaction.reply({
      embeds: [createErrorEmbed('Setup Error', 'Runner has no private channel.')],
      flags: 64
    });
    return;
  }

  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !('threads' in channel)) {
      throw new Error("Invalid runner channel");
    }

    const thread = await channel.threads.create({
      name: `📺 ${sessionId}`,
      autoArchiveDuration: 60,
      reason: `Watching tmux session ${sessionId}`
    } as any);

    threadId = thread.id;

    // 2. Register Session
    const session: Session = {
      sessionId: sessionId,
      runnerId: targetRunner.runnerId,
      channelId: channelId,
      threadId: threadId,
      createdAt: new Date().toISOString(),
      status: 'active', // Mark active so we accept messages immediately
      cliType: 'claude', // Default
      folderPath: 'watched-session'
    };

    storage.createSession(session);
    sessionStatuses.set(sessionId, 'idle');

    // Add user to thread
    await thread.members.add(userId);

    // Notify thread
    const embed = new EmbedBuilder()
      .setColor(0xFFFF00) // Yellow = connecting
      .setTitle('Connecting to Session...')
      .setDescription(`Requesting attachment to tmux session \`${sessionId}\` on \`${targetRunner.name}\`...`)
      .setTimestamp();

    await thread.send({ embeds: [embed] });

    // 3. Send Request to Runner
    ws.send(JSON.stringify({
      type: 'watch_terminal',
      data: {
        sessionId: sessionId
      }
    }));

    // 4. Reply to interaction
    await interaction.reply({
      content: `Transmitter set to \`${sessionId}\`. check <#${threadId}>`,
      flags: 64
    });

  } catch (e: any) {
    console.error("Failed to setup watch:", e);
    await interaction.reply({
      embeds: [createErrorEmbed('Watch Failed', e.message)],
      flags: 64
    });
  }
}

async function handleUnwatch(interaction: any, userId: string): Promise<void> {
  // Same as end-session for now, as "unwatch" implies stopping the discord integration
  await handleEndSession(interaction, userId);
}

async function endSession(sessionId: string, userId: string): Promise<void> {
  const session = storage.getSession(sessionId);
  if (!session || session.status === 'ended') {
    return;
  }

  // Mark session as ended
  storage.endSession(sessionId);

  // Archive the thread
  try {
    const thread = await client.channels.fetch(session.threadId);
    if (thread && 'setArchived' in thread) {
      await thread.setArchived(true);
      console.log(`Archived thread for session ${sessionId}`);
    }
  } catch (error) {
    console.error(`Failed to archive thread for session ${sessionId}:`, error);
  }

  // Kill the CLI process on runner agent
  const runner = storage.getRunner(session.runnerId);
  if (runner) {
    const ws = runnerConnections.get(runner.runnerId);
    if (ws) {
      ws.send(JSON.stringify({
        type: 'session_end',
        data: {
          sessionId: sessionId
        }
      }));
      console.log(`Sent session_end to runner ${runner.name} for session ${sessionId}`);
    }
  }

  // Clean up allowed tools for this session
  allowedTools.delete(sessionId);
  console.log(`Cleaned up allowed tools for session ${sessionId}`);
}

async function endAllRunnerSessions(runner: RunnerInfo): Promise<void> {
  const allSessions = storage.getRunnerSessions(runner.runnerId);
  console.log(`[DEBUG] All sessions for runner ${runner.name}:`, allSessions.map(s => ({ id: s.sessionId, status: s.status })));

  const activeSessions = allSessions.filter(s => s.status === 'active');

  if (activeSessions.length === 0) {
    console.log(`[DEBUG] No active sessions to end for runner ${runner.name}`);
    return;
  }

  console.log(`Ending ${activeSessions.length} active sessions for runner ${runner.name}...`);

  for (const session of activeSessions) {
    try {
      console.log(`[DEBUG] Ending session ${session.sessionId} with status ${session.status}`);
      await endSession(session.sessionId, runner.ownerId);
      console.log(`Ended session ${session.sessionId}`);
    } catch (error) {
      console.error(`Error ending session ${session.sessionId}:`, error);
    }
  }

  console.log(`All sessions ended for runner ${runner.name}`);
}

async function handleButtonInteraction(interaction: any): Promise<void> {
  const customId = interaction.customId;
  const userId = interaction.user.id;

  // Handle prompt buttons (open modal)
  if (customId.startsWith('prompt_')) {
    await handlePromptButton(interaction, userId, customId);
    return;
  }

  // Handle create folder retry button (Phase 6)
  if (customId.startsWith('create_folder_')) {
    await handleCreateFolderRetry(interaction, userId, customId);
    return;
  }

  // Handle TmuxPlugin option buttons (format: option_{requestId}_{optionNumber})
  if (customId.startsWith('option_')) {
    const parts = customId.split('_');
    if (parts.length >= 3) {
      const requestId = parts[1];
      const optionNumber = parts[2];  // 1-based option number from TmuxPlugin

      const pending = pendingApprovals.get(requestId);
      if (!pending) {
        await interaction.reply({
          embeds: [createErrorEmbed('Expired', 'This approval request has expired.')],
          flags: 64
        });
        return;
      }

      // Check if user is authorized
      const runner = storage.getRunner(pending.runnerId);
      if (!runner || !storage.canUserAccessRunner(userId, pending.runnerId)) {
        await interaction.reply({
          embeds: [createErrorEmbed('Unauthorized', 'You are not authorized to approve this request.')],
          flags: 64
        });
        return;
      }

      // Send option number to runner (TmuxPlugin expects option number)
      const ws = runnerConnections.get(pending.runnerId);
      if (ws) {
        ws.send(JSON.stringify({
          type: 'approval_response',
          data: {
            sessionId: pending.sessionId,
            approved: true,  // All options from TmuxPlugin are approvals
            optionNumber  // Send the option number (e.g., "1", "2", "3")
          }
        }));
        console.log(`[Approval] Sent option ${optionNumber} for request ${requestId}`);
      }

      // Update buttons to show selected option
      const selectedButton = new ButtonBuilder()
        .setCustomId(`selected_${requestId}`)
        .setLabel(`✅ Option ${optionNumber} Selected`)
        .setStyle(ButtonStyle.Success)
        .setDisabled(true);

      const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(selectedButton);

      const embed = createApprovalDecisionEmbed(true, pending.toolName, interaction.user.username, `Option ${optionNumber}`);

      await interaction.update({
        embeds: [embed],
        components: [row]
      });

      // Remove from pending
      pendingApprovals.delete(requestId);

      // CRITICAL: Clear streaming message state for this session
      // This ensures that the NEXT output received from the runner (the result of the approval)
      // starts a FRESH message instead of editing the previous one.
      streamingMessages.delete(pending.sessionId);

      console.log(`Approval request ${requestId} approved with option ${optionNumber} by user ${userId}`);
      return;
    }
  }

  // Handle approval buttons (legacy format)
  if (customId.startsWith('allow_') || customId.startsWith('deny_') || customId.startsWith('modify_')) {
    // Parse the custom ID
    if (customId.startsWith('allow_all_')) {
      const requestId = customId.replace('allow_all_', '');
      await handleAllowAll(interaction, userId, requestId);
      return;
    }

    if (customId.startsWith('modify_')) {
      const requestId = customId.replace('modify_', '');
      await handleModify(interaction, userId, requestId);
      return;
    }

    const [action, requestId] = customId.split('_');

    const pending = pendingApprovals.get(requestId);
    if (!pending) {
      await interaction.reply({
        embeds: [createErrorEmbed('Expired', 'This approval request has expired.')],
        flags: 64
      });
      return;
    }

    // Check if user is authorized
    const runner = storage.getRunner(pending.runnerId);

    if (!runner || !storage.canUserAccessRunner(userId, pending.runnerId)) {
      await interaction.reply({
        embeds: [createErrorEmbed('Unauthorized', 'You are not authorized to approve this request.')],
        flags: 64
      });
      return;
    }

    const allow = action === 'allow';

    // Send response to runner
    const ws = runnerConnections.get(pending.runnerId);
    if (ws) {
      ws.send(JSON.stringify({
        type: 'approval_response',
        data: {
          requestId,
          allow,
          message: allow ? 'Approved via Discord' : 'Denied via Discord'
        }
      }));
    }

    // Update buttons
    const allowedButton = new ButtonBuilder()
      .setCustomId(`allowed_${requestId}`)
      .setLabel('✅ Allowed')
      .setStyle(ButtonStyle.Success)
      .setDisabled(true);

    const deniedButton = new ButtonBuilder()
      .setCustomId(`denied_${requestId}`)
      .setLabel('❌ Denied')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(true);

    const row = new ActionRowBuilder<ButtonBuilder>()
      .addComponents(allow ? allowedButton : deniedButton);

    const embed = createApprovalDecisionEmbed(allow, pending.toolName, interaction.user.username);

    await interaction.update({
      embeds: [embed],
      components: [row]
    });

    // Remove from pending
    pendingApprovals.delete(requestId);

    console.log(`Approval request ${requestId} ${action}ed by user ${userId}`);
    return;
  }

  // Handle session creation buttons
  if (customId.startsWith('session_runner_')) {
    await handleRunnerSelection(interaction, userId, customId);
    return;
  }

  if (customId.startsWith('session_cli_')) {
    await handleCliSelection(interaction, userId, customId);
    return;
  }

  if (customId.startsWith('session_plugin_')) {
    await handlePluginSelection(interaction, userId, customId);
    return;
  }

  if (customId === 'session_back_runners') {
    await handleBackToRunners(interaction, userId);
    return;
  }

  if (customId === 'session_back_cli') {
    await handleBackToCli(interaction, userId);
    return;
  }

  if (customId === 'session_back_plugin') {
    await handleBackToPlugin(interaction, userId);
    return;
  }

  if (customId === 'session_custom_folder') {
    await handleCustomFolder(interaction, userId);
    return;
  }

  if (customId === 'session_cancel') {
    await handleSessionCancel(interaction, userId);
    return;
  }

  if (customId === 'session_default_folder') {
    await handleDefaultFolder(interaction, userId);
    return;
  }
}

async function handleAllowAll(interaction: any, userId: string, requestId: string): Promise<void> {
  const pending = pendingApprovals.get(requestId);
  if (!pending) {
    await interaction.reply({
      embeds: [createErrorEmbed('Expired', 'This approval request has expired.')],
      flags: 64
    });
    return;
  }

  // Check if user is authorized
  const runner = storage.getRunner(pending.runnerId);
  if (!runner || !storage.canUserAccessRunner(userId, pending.runnerId)) {
    await interaction.reply({
      embeds: [createErrorEmbed('Unauthorized', 'You are not authorized to approve this request.')],
      flags: 64
    });
    return;
  }

  // Add tool to allowed set for this session
  if (!allowedTools.has(pending.sessionId)) {
    allowedTools.set(pending.sessionId, new Set());
  }
  allowedTools.get(pending.sessionId)!.add(pending.toolName);

  // Send approval response
  const ws = runnerConnections.get(pending.runnerId);
  if (ws) {
    ws.send(JSON.stringify({
      type: 'approval_response',
      data: {
        requestId,
        allow: true,
        message: `Approved (all ${pending.toolName} operations auto-approved for this session)`
      }
    }));
  }

  // Update UI
  const allowedAllButton = new ButtonBuilder()
    .setCustomId(`allowed_all_${requestId}`)
    .setLabel('✅ Allowed All')
    .setStyle(ButtonStyle.Primary)
    .setDisabled(true);

  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(allowedAllButton);

  const embed = createApprovalDecisionEmbed(true, `${pending.toolName} (all)`, interaction.user.username);

  await interaction.update({
    embeds: [embed],
    components: [row]
  });

  pendingApprovals.delete(requestId);
  console.log(`Tool ${pending.toolName} auto-approved for session ${pending.sessionId} by user ${userId}`);
}

async function handleModify(interaction: any, userId: string, requestId: string): Promise<void> {
  const pending = pendingApprovals.get(requestId);
  if (!pending) {
    await interaction.reply({
      embeds: [createErrorEmbed('Expired', 'This approval request has expired.')],
      flags: 64
    });
    return;
  }

  // Check if user is authorized
  const runner = storage.getRunner(pending.runnerId);
  if (!runner || !storage.canUserAccessRunner(userId, pending.runnerId)) {
    await interaction.reply({
      embeds: [createErrorEmbed('Unauthorized', 'You are not authorized to approve this request.')],
      flags: 64
    });
    return;
  }

  // Show a modal to modify the tool input
  const modal = new ModalBuilder()
    .setCustomId(`modify_modal_${requestId}`)
    .setTitle('Modify Tool Input');

  // Convert toolInput to string for editing
  const inputString = JSON.stringify(pending.toolInput, null, 2);

  const inputRow = new ActionRowBuilder<TextInputBuilder>()
    .addComponents(
      new TextInputBuilder()
        .setCustomId('modified_input')
        .setLabel('Modified Tool Input (JSON)')
        .setValue(inputString.substring(0, 4000))
        .setStyle(TextInputStyle.Paragraph)
        .setRequired(true)
        .setMaxLength(4000)
    );

  modal.addComponents(inputRow);

  await interaction.showModal(modal);
}

async function handlePromptButton(interaction: any, userId: string, customId: string): Promise<void> {
  const sessionId = customId.replace('prompt_', '');
  const session = storage.getSession(sessionId);

  if (!session || session.status !== 'active') {
    await interaction.reply({
      content: 'This session is no longer active.',
      flags: 64,
      ephemeral: true
    });
    return;
  }

  const runner = storage.getRunner(session.runnerId);
  if (!runner || !storage.canUserAccessRunner(userId, session.runnerId)) {
    await interaction.reply({
      content: 'You do not have permission to use this session.',
      flags: 64,
      ephemeral: true
    });
    return;
  }

  // Show modal to enter prompt
  const modal = new ModalBuilder()
    .setCustomId(`prompt_modal_${sessionId}`)
    .setTitle('Send Prompt to CLI')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId('prompt_input')
          .setLabel('Your prompt')
          .setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Enter your prompt for the CLI...')
          .setRequired(true)
          .setMinLength(1)
          .setMaxLength(4000)
      )
    );

  await interaction.showModal(modal);
}

// Handle modal submit handler
async function handleModalSubmit(interaction: any): Promise<void> {
  const userId = interaction.user.id;
  const customId = interaction.customId;

  // Handle prompt modal
  if (customId.startsWith('prompt_modal_')) {
    const sessionId = customId.replace('prompt_modal_', '');
    const prompt = interaction.fields.getTextInputValue('prompt_input');

    const session = storage.getSession(sessionId);
    if (!session || session.status !== 'active') {
      await interaction.reply({
        content: 'This session is no longer active.',
        flags: 64,
        ephemeral: true
      });
      return;
    }

    const runner = storage.getRunner(session.runnerId);
    if (!runner || !storage.canUserAccessRunner(userId, session.runnerId)) {
      await interaction.reply({
        content: 'You do not have permission to use this session.',
        flags: 64,
        ephemeral: true
      });
      return;
    }

    // Get the WebSocket connection for this runner
    const ws = runnerConnections.get(runner.runnerId);
    if (!ws) {
      await interaction.reply({
        content: 'Runner is not connected. Please wait for it to come back online.',
        flags: 64,
        ephemeral: true
      });
      return;
    }

    // Send the prompt to the runner
    try {
      ws.send(JSON.stringify({
        type: 'user_message',
        data: {
          sessionId: session.sessionId,
          userId: userId,
          username: interaction.user.username,
          content: prompt,
          timestamp: new Date().toISOString()
        }
      }));

      // Send ephemeral confirmation
      await interaction.reply({
        content: '✅ Prompt sent to CLI! Check the thread for output.',
        flags: 64,
        ephemeral: true
      });

      // Send an embed in the thread showing the user's message
      const thread = await client.channels.fetch(session.threadId);
      if (thread && 'send' in thread) {
        const userMessageEmbed = new EmbedBuilder()
          .setColor(0x0099FF)
          .setTitle(`💬 Message from ${interaction.user.username}`)
          .setDescription(prompt.substring(0, 4000))
          .addFields(
            { name: 'User', value: `<@${userId}>`, inline: true },
            { name: 'Time', value: new Date().toLocaleString(), inline: true }
          )
          .setTimestamp();

        await thread.send({ embeds: [userMessageEmbed] });
      }

      console.log(`Sent prompt from ${interaction.user.username} to runner ${runner.name} for session ${session.sessionId}`);
    } catch (error) {
      console.error('Error sending prompt to runner:', error);
      await interaction.reply({
        content: 'Failed to send prompt to runner. Please try again.',
        flags: 64,
        ephemeral: true
      });
    }

    return;
  }

  // Handle modify approval modal
  if (customId.startsWith('modify_modal_')) {
    const requestId = customId.replace('modify_modal_', '');
    const modifiedInput = interaction.fields.getTextInputValue('modified_input');

    const pending = pendingApprovals.get(requestId);
    if (!pending) {
      await interaction.reply({
        embeds: [createErrorEmbed('Expired', 'This approval request has expired.')],
        flags: 64
      });
      return;
    }

    // Check if user is authorized
    const runner = storage.getRunner(pending.runnerId);
    if (!runner || !storage.canUserAccessRunner(userId, pending.runnerId)) {
      await interaction.reply({
        embeds: [createErrorEmbed('Unauthorized', 'You are not authorized to approve this request.')],
        flags: 64
      });
      return;
    }

    // Parse the modified input
    let modifiedToolInput: unknown;
    try {
      modifiedToolInput = JSON.parse(modifiedInput);
    } catch (error) {
      await interaction.reply({
        embeds: [createErrorEmbed('Invalid JSON', 'The modified input is not valid JSON.')],
        flags: 64
      });
      return;
    }

    // Send approval with modified input
    const ws = runnerConnections.get(pending.runnerId);
    if (ws) {
      ws.send(JSON.stringify({
        type: 'approval_response',
        data: {
          requestId,
          allow: true,
          message: 'Approved with modifications',
          modifiedToolInput
        }
      }));
    }

    // Update original approval message
    const channel = await client.channels.fetch(pending.channelId);
    if (channel && 'messages' in channel) {
      try {
        const msg = await channel.messages.fetch(pending.messageId);
        await msg.update({
          content: '✏️ **Modified and Approved**',
          embeds: [],
          components: []
        });
      } catch (error) {
        console.error('Error updating approval message:', error);
      }
    }

    await interaction.reply({
      content: '✅ Tool use approved with modified input.',
      flags: 64,
      ephemeral: true
    });

    pendingApprovals.delete(requestId);
    console.log(`Approval request ${requestId} modified and approved by user ${userId}`);
    return;
  }

  // Handle folder modal (existing code)
  if (customId === 'session_folder_modal') {
    const folderPath = interaction.fields.getTextInputValue('folder_path');

    const state = sessionCreationState.get(userId);
    if (!state || !state.runnerId || !state.cliType) {
      await interaction.reply({
        embeds: [createErrorEmbed('Session Expired', 'Please start over with /create-session')],
        flags: 64
      });
      return;
    }

    const runner = storage.getRunner(state.runnerId);
    if (!runner) {
      await interaction.reply({
        embeds: [createErrorEmbed('Runner Not Found', 'Selected runner no longer exists.')],
        flags: 64
      });
      return;
    }

    // Get or create runner's private channel
    let channelId: string;
    if (!runner.privateChannelId) {
      // Need guild ID - get it from interaction
      const guildId = interaction.guildId;
      if (!guildId) {
        await interaction.reply({
          embeds: [createErrorEmbed('Cannot Create Session', 'Cannot determine guild ID.')],
          flags: 64
        });
        return;
      }
      channelId = await getOrCreateRunnerChannel(runner, guildId);
    } else {
      channelId = runner.privateChannelId;
    }

    // Create the session with custom folder
    try {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !('threads' in channel)) {
        await interaction.reply({
          embeds: [createErrorEmbed('Cannot Create Thread', 'Cannot access runner channel.')],
          flags: 64
        });
        return;
      }

      // Create a private thread
      const thread = await channel.threads.create({
        name: `${state.cliType.toUpperCase()}-${Date.now()}`,
        type: ChannelType.PrivateThread,
        invitable: false,
        reason: `CLI session for ${state.cliType}`
      });

      // Create session first (so we have the sessionId)
      const session: Session = {
        sessionId: randomUUID(),
        runnerId: runner.runnerId,
        channelId: channel.id,
        threadId: thread.id,
        createdAt: new Date().toISOString(),
        status: 'active',
        cliType: state.cliType,
        folderPath: folderPath,
        interactionToken: interaction.token
      };

      // Set up thread permissions (allow users to send messages)
      const guild = await client.guilds.fetch(interaction.guildId);
      const permissionOverwrites = [];

      // Add owner permissions (allow viewing and sending)
      permissionOverwrites.push({
        id: interaction.user.id,
        allow: ['ViewChannel', 'ReadMessageHistory', 'SendMessages', 'SendMessagesInThreads']
      });

      // Add shared users (allow viewing and sending)
      runner.authorizedUsers
        .filter(userId => userId && userId !== interaction.user.id)
        .forEach(userId => {
          permissionOverwrites.push({
            id: userId,
            allow: ['ViewChannel', 'ReadMessageHistory', 'SendMessages', 'SendMessagesInThreads']
          });
        });

      storage.createSession(session);
      actionItems.set(session.sessionId, []);

      // Add users to the thread (gives them access to private thread)
      await thread.members.add(interaction.user.id, 'Session owner');

      // Add shared users to the thread
      for (const userId of runner.authorizedUsers) {
        if (userId && userId !== interaction.user.id) {
          try {
            await thread.members.add(userId, 'Authorized user');
          } catch (error) {
            console.error(`Failed to add user ${userId} to thread:`, error);
          }
        }
      }

      // Send session start message to runner
      const ws = runnerConnections.get(runner.runnerId);
      if (ws) {
        ws.send(JSON.stringify({
          type: 'session_start',
          data: {
            sessionId: session.sessionId,
            runnerId: runner.runnerId,
            cliType: state.cliType,
            folderPath: folderPath
          }
        }));
        console.log(`Sent session_start to runner ${runner.name} for session ${session.sessionId}`);

        // We do NOT send the "Session Ready" message here anymore.
        // We wait for the 'session_ready' event from the runner.

        // Update original message to show "Initializing..." state
        const initializingEmbed = new EmbedBuilder()
          .setColor(0xFFFF00) // Yellow
          .setTitle('Initializing Session...')
          .setDescription(`Request sent to runner. Waiting for confirmation...`)
          .addFields(
            { name: 'Runner', value: runner.name, inline: true },
            { name: 'CLI Type', value: state.cliType.toUpperCase(), inline: true },
            { name: 'Working Folder', value: `\`\`\`${folderPath}\`\`\``, inline: false }
          )
          .setTimestamp();

        await interaction.reply({
          embeds: [initializingEmbed],
          flags: 64
        });

        // Clear state
        sessionCreationState.delete(userId);

        // Store interaction message ID if needed? 
        // Actually we replied ephemerally. The 'session_ready' handler will post to the thread.
        // But we want to update the original interaction reply if possible? 
        // Interaction tokens expire. It's safer to post to the thread.

      } else {
        // Runner not connected logic
      }

      console.log(`Session ${session.sessionId} created for user ${userId} with custom folder: ${folderPath}`);
    } catch (error) {
      console.error('Error creating session:', error);
      await interaction.reply({
        embeds: [createErrorEmbed('Session Creation Failed', error instanceof Error ? error.message : 'Unknown error')],
        flags: 64
      });
    }
  }
}

// Session creation step handlers
async function handleRunnerSelection(interaction: any, userId: string, customId: string): Promise<void> {
  // Extract the hash part and reconstruct the full runner ID
  const hashPart = customId.replace('session_runner_', '');
  const runnerId = `runner_${hashPart}`;
  const runner = storage.getRunner(runnerId);

  if (!runner || !storage.canUserAccessRunner(userId, runnerId)) {
    await interaction.reply({
      embeds: [createErrorEmbed('Invalid Runner', 'Runner not found or access denied.')],
      flags: 64
    });
    return;
  }

  // Update state
  const state = sessionCreationState.get(userId);
  if (!state) {
    await interaction.reply({
      embeds: [createErrorEmbed('Session Expired', 'Please start over with /create-session')],
      flags: 64
    });
    return;
  }

  state.runnerId = runnerId;
  state.step = 'select_cli';
  sessionCreationState.set(userId, state);

  // Create CLI type selection buttons
  const row = new ActionRowBuilder<ButtonBuilder>();

  runner.cliTypes.forEach(cliType => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`session_cli_${cliType}`)
        .setLabel(cliType.toUpperCase())
        .setStyle(ButtonStyle.Primary)
    );
  });

  // Add back and cancel buttons
  const navRow = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('session_back_runners')
        .setLabel('← Back to Runners')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('session_cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('❌')
    );

  const embed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle('Select CLI Type')
    .setDescription(`Runner \`${runner.name}\` supports the following CLI types:`)
    .addFields(
      { name: 'Selected Runner', value: runner.name, inline: true },
      { name: 'Available CLI Types', value: runner.cliTypes.map(t => t.toUpperCase()).join(', '), inline: true }
    )
    .setTimestamp()
    .setFooter({ text: 'Step 2 of 3: Select CLI Type' });

  await interaction.update({
    embeds: [embed],
    components: [row, navRow]
  });
}

async function handleCliSelection(interaction: any, userId: string, customId: string): Promise<void> {
  const cliType = customId.replace('session_cli_', '') as 'claude' | 'gemini';
  const state = sessionCreationState.get(userId);

  if (!state || !state.runnerId) {
    await interaction.reply({
      embeds: [createErrorEmbed('Session Expired', 'Please start over with /create-session')],
      flags: 64
    });
    return;
  }

  const runner = storage.getRunner(state.runnerId);
  if (!runner || !runner.cliTypes.includes(cliType)) {
    await interaction.reply({
      embeds: [createErrorEmbed('Invalid CLI Type', 'This runner does not support the selected CLI type.')],
      flags: 64
    });
    return;
  }

  // Update state
  state.cliType = cliType;
  state.step = 'select_plugin';
  sessionCreationState.set(userId, state);

  // Create plugin selection buttons
  const buttonRow = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('session_plugin_tmux')
        .setLabel('Interactive (Tmux)')
        .setStyle(ButtonStyle.Success)
        .setEmoji('🖥️'),
      new ButtonBuilder()
        .setCustomId('session_plugin_print')
        .setLabel('Basic (Print)')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('📄'),
      new ButtonBuilder()
        .setCustomId('session_back_runners') // Go back to runners
        .setLabel('← Go Back')
        .setStyle(ButtonStyle.Secondary)
    );

  const embed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('Select Plugin Type')
    .setDescription(`Run \`${runner.name}\` with which plugin?`)
    .addFields(
      { name: 'Current Selection', value: `Runner: ${runner.name}\nCLI: ${cliType.toUpperCase()}`, inline: false },
      { name: 'Options', value: '• **Interactive (Tmux)**: Recommended. Supports session persistence, approvals, and rich interaction.\n• **Basic (Print)**: Stateless fallback. Simple request/response.', inline: false }
    )
    .setTimestamp()
    .setFooter({ text: 'Step 3 of 4: Select Plugin' });

  await interaction.update({
    embeds: [embed],
    components: [buttonRow]
  });
}

async function handlePluginSelection(interaction: any, userId: string, customId: string): Promise<void> {
  const plugin = customId.replace('session_plugin_', '') as 'tmux' | 'print';
  const state = sessionCreationState.get(userId);

  if (!state || !state.runnerId || !state.cliType) {
    await interaction.reply({
      embeds: [createErrorEmbed('Session Expired', 'Please start over with /create-session')],
      flags: 64
    });
    return;
  }

  // Update state
  state.plugin = plugin;
  state.step = 'select_folder';
  sessionCreationState.set(userId, state);

  const runner = storage.getRunner(state.runnerId);
  if (!runner) return;

  // Create folder selection buttons
  const buttonRow = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('session_default_folder')
        .setLabel(`Use Default (${runner.defaultWorkspace || '~'})`)
        .setStyle(ButtonStyle.Success)
        .setEmoji('🏠'),
      new ButtonBuilder()
        .setCustomId('session_custom_folder')
        .setLabel('Select Custom Folder')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('📂')
    );

  // Add back and cancel buttons
  const navRow = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('session_back_plugin')
        .setLabel('← Go Back')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('session_cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('❌')
    );

  const embed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('Select Working Directory')
    .setDescription(`Almost done! Where should this session start?`)
    .addFields(
      { name: 'Summary', value: `**Runner:** ${runner.name}\n**CLI:** ${state.cliType.toUpperCase()}\n**Plugin:** ${plugin === 'tmux' ? 'Interactive (Tmux)' : 'Basic (Print)'}`, inline: false }
    )
    .setTimestamp()
    .setFooter({ text: 'Step 4 of 4: Select Folder' });

  await interaction.update({
    embeds: [embed],
    components: [buttonRow, navRow]
  });
}

// ... handleBackToPlugin ...



async function handleBackToPlugin(interaction: any, userId: string): Promise<void> {
  const state = sessionCreationState.get(userId);
  if (!state || !state.cliType) {
    // If state lost, restart
    await handleCreateSession(interaction, userId);
    return;
  }
  // Re-render plugin selection (using handleCliSelection logic effectively)
  // We need to construct a customId to reuse handleCliSelection? No, just replicate logic.
  // Actually simpler: just call handleCliSelection with reconstructed ID
  await handleCliSelection(interaction, userId, `session_cli_${state.cliType}`);
}


async function handleDefaultFolder(interaction: any, userId: string): Promise<void> {
  const state = sessionCreationState.get(userId);

  if (!state || !state.runnerId || !state.cliType) {
    await interaction.reply({
      embeds: [createErrorEmbed('Session Expired', 'Please start over with /create-session')],
      flags: 64
    });
    return;
  }

  const runner = storage.getRunner(state.runnerId);
  if (!runner) {
    await interaction.reply({
      embeds: [createErrorEmbed('Runner Not Found', 'Selected runner no longer exists.')],
      flags: 64
    });
    return;
  }

  // Get or create runner's private channel
  let channelId: string;
  if (!runner.privateChannelId) {
    // Need guild ID - get it from interaction
    const guildId = interaction.guildId;
    if (!guildId) {
      await interaction.reply({
        embeds: [createErrorEmbed('Cannot Create Session', 'Cannot determine guild ID.')],
        flags: 64
      });
      return;
    }
    channelId = await getOrCreateRunnerChannel(runner, guildId);
  } else {
    channelId = runner.privateChannelId;
  }

  // Create the session
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !('threads' in channel)) {
      await interaction.reply({
        embeds: [createErrorEmbed('Cannot Create Thread', 'Cannot access runner channel.')],
        flags: 64
      });
      return;
    }

    // Create a private thread
    const thread = await channel.threads.create({
      name: `${state.cliType.toUpperCase()}-${Date.now()}`,
      type: ChannelType.PrivateThread,
      invitable: false,
      reason: `CLI session for ${state.cliType}`
    });

    // Create session first (so we have the sessionId)
    const session: Session = {
      sessionId: randomUUID(),
      runnerId: runner.runnerId,
      channelId: channel.id,
      threadId: thread.id,
      createdAt: new Date().toISOString(),
      status: 'active',
      cliType: state.cliType,
      folderPath: runner.defaultWorkspace || '~', // Use runner default or home
      interactionToken: interaction.token
    };

    // Set up thread permissions (allow users to send messages)
    const guild = await client.guilds.fetch(interaction.guildId);
    const permissionOverwrites = [];

    // Add owner permissions (allow viewing and sending)
    permissionOverwrites.push({
      id: interaction.user.id,
      allow: ['ViewChannel', 'ReadMessageHistory', 'SendMessages', 'SendMessagesInThreads']
    });

    // Add shared users (allow viewing and sending)
    runner.authorizedUsers
      .filter(userId => userId && userId !== interaction.user.id)
      .forEach(userId => {
        permissionOverwrites.push({
          id: userId,
          allow: ['ViewChannel', 'ReadMessageHistory', 'SendMessages', 'SendMessagesInThreads']
        });
      });

    storage.createSession(session);
    actionItems.set(session.sessionId, []);

    // Add users to the thread (gives them access to private thread)
    await thread.members.add(interaction.user.id, 'Session owner');

    // Add shared users to the thread
    for (const userId of runner.authorizedUsers) {
      if (userId && userId !== interaction.user.id) {
        try {
          await thread.members.add(userId, 'Authorized user');
        } catch (error) {
          console.error(`Failed to add user ${userId} to thread:`, error);
        }
      }
    }

    // Send session start message to runner
    const ws = runnerConnections.get(runner.runnerId);
    if (ws) {
      ws.send(JSON.stringify({
        type: 'session_start',
        data: {
          sessionId: session.sessionId,
          runnerId: runner.runnerId,
          cliType: state.cliType,
          plugin: state.plugin, // Pass plugin type
          folderPath: undefined // default folder
        }
      }));
      console.log(`Sent session_start to runner ${runner.name} for session ${session.sessionId}`);

      // We do NOT send the "Session Ready" message here anymore.
      // We wait for the 'session_ready' event from the runner.

      // Update original message to show "Initializing..." state
      const initializingEmbed = new EmbedBuilder()
        .setColor(0xFFFF00) // Yellow
        .setTitle('Initializing Session...')
        .setDescription(`Request sent to runner. You will be notified in this thread when the session is ready.`)
        .addFields(
          { name: 'Runner', value: runner.name, inline: true },
          { name: 'CLI Type', value: state.cliType.toUpperCase(), inline: true },
          { name: 'Working Folder', value: `\`\`\`${runner.defaultWorkspace || '~'}\`\`\``, inline: false }
        )
        .setTimestamp();

      await interaction.update({
        embeds: [initializingEmbed],
        components: [] // Remove buttons while waiting
      });

      // Clear state
      sessionCreationState.delete(userId);

    } else {
      // Runner not connected
    }

    console.log(`Session ${session.sessionId} created for user ${userId}`);
  } catch (error) {
    console.error('Error creating session:', error);
    await interaction.reply({
      embeds: [createErrorEmbed('Session Creation Failed', error instanceof Error ? error.message : 'Unknown error')],
      flags: 64
    });
  }
}

async function handleCustomFolder(interaction: any, userId: string): Promise<void> {
  const state = sessionCreationState.get(userId);

  if (!state || !state.runnerId || !state.cliType) {
    await interaction.reply({
      embeds: [createErrorEmbed('Session Expired', 'Please start over with /create-session')],
      flags: 64
    });
    return;
  }

  // Create modal for folder input
  const modal = new ModalBuilder()
    .setCustomId('session_folder_modal')
    .setTitle('Specify Working Folder');

  const folderInput = new TextInputBuilder()
    .setCustomId('folder_path')
    .setLabel('Enter the working folder path')
    .setPlaceholder('/Users/yourname/projects or C:\\Projects')
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(500);

  const actionRow = new ActionRowBuilder<TextInputBuilder>().addComponents(folderInput);
  modal.addComponents(actionRow);

  await interaction.showModal(modal);
}

async function handleBackToCli(interaction: any, userId: string): Promise<void> {
  const state = sessionCreationState.get(userId);

  if (!state || !state.runnerId) {
    await interaction.update({
      embeds: [createErrorEmbed('Session Expired', 'Please start over with /create-session')],
      components: []
    });
    return;
  }

  const runner = storage.getRunner(state.runnerId);
  if (!runner) {
    await interaction.update({
      embeds: [createErrorEmbed('Runner Not Found', 'Selected runner no longer exists.')],
      components: []
    });
    return;
  }

  // Go back to CLI selection
  state.step = 'select_cli';
  state.cliType = undefined;
  sessionCreationState.set(userId, state);

  // Create CLI type selection buttons
  const row = new ActionRowBuilder<ButtonBuilder>();

  runner.cliTypes.forEach(cliType => {
    row.addComponents(
      new ButtonBuilder()
        .setCustomId(`session_cli_${cliType}`)
        .setLabel(cliType.toUpperCase())
        .setStyle(ButtonStyle.Primary)
    );
  });

  // Add back and cancel buttons
  const navRow = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('session_back_runners')
        .setLabel('← Back to Runners')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('session_cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('❌')
    );

  const embed = new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle('Select CLI Type')
    .setDescription(`Runner \`${runner.name}\` supports the following CLI types:`)
    .addFields(
      { name: 'Selected Runner', value: runner.name, inline: true },
      { name: 'Available CLI Types', value: runner.cliTypes.map(t => t.toUpperCase()).join(', '), inline: true }
    )
    .setTimestamp()
    .setFooter({ text: 'Step 2 of 3: Select CLI Type' });

  await interaction.update({
    embeds: [embed],
    components: [row, navRow]
  });
}

async function handleBackToRunners(interaction: any, userId: string): Promise<void> {
  // Get accessible online runners
  const allRunners = storage.getUserRunners(userId).filter(r => r.status === 'online');

  // Deduplicate runners by runnerId
  const runnersMap = new Map<string, RunnerInfo>();
  allRunners.forEach(runner => {
    runnersMap.set(runner.runnerId, runner);
  });
  const runners = Array.from(runnersMap.values());

  if (runners.length === 0) {
    await interaction.update({
      embeds: [createErrorEmbed('No Online Runners', 'No online runners available.')],
      components: []
    });
    return;
  }

  // Reset state
  sessionCreationState.set(userId, {
    step: 'select_runner'
  });

  // Recreate runner selection buttons
  const buttonRows: ActionRowBuilder<ButtonBuilder>[] = [];

  for (let i = 0; i < runners.length; i += 5) {
    const row = new ActionRowBuilder<ButtonBuilder>();
    const chunk = runners.slice(i, i + 5);

    chunk.forEach(runner => {
      const hashPart = runner.runnerId.replace('runner_', '');
      const customId = `session_runner_${hashPart}`;
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(customId)
          .setLabel(`${runner.name} (${runner.cliTypes.map(t => t.toUpperCase()).join(', ')})`)
          .setStyle(ButtonStyle.Primary)
          .setEmoji(runner.status === 'online' ? '🟢' : '🔴')
      );
    });

    buttonRows.push(row);
  }

  // Add cancel button
  const cancelRow = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setCustomId('session_cancel')
        .setLabel('Cancel')
        .setStyle(ButtonStyle.Danger)
        .setEmoji('❌')
    );

  const embed = new EmbedBuilder()
    .setColor(0x0099FF)
    .setTitle('Create New Session')
    .setDescription('Select a runner to use for this session:')
    .addFields(
      { name: 'Available Runners', value: `${runners.length} online`, inline: true }
    )
    .setTimestamp()
    .setFooter({ text: 'Step 1 of 3: Select Runner' });

  await interaction.update({
    embeds: [embed],
    components: [...buttonRows, cancelRow]
  });
}

async function handleSessionCancel(interaction: any, userId: string): Promise<void> {
  sessionCreationState.delete(userId);

  const cancelEmbed = new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('Session Creation Cancelled')
    .setDescription('Session creation has been cancelled. You can start over with `/create-session`.')
    .setTimestamp();

  await interaction.update({
    embeds: [cancelEmbed],
    components: []
  });
}

// Helper functions for creating embeds
function createToolUseEmbed(runner: RunnerInfo, toolName: string, toolInput: unknown): EmbedBuilder {
  const toolInputStr = JSON.stringify(toolInput, null, 2).substring(0, 1000);

  return new EmbedBuilder()
    .setColor(0xFFD700) // Gold for warning/pending
    .setTitle('Tool Use Approval Required')
    .addFields(
      { name: 'Runner', value: `\`${runner.name}\``, inline: true },
      { name: 'Tool', value: `\`${toolName}\``, inline: true },
      { name: 'Input', value: `\`\`\`json\n${toolInputStr}\n\`\`\``, inline: false }
    )
    .setTimestamp()
    .setFooter({ text: `Runner ID: ${runner.runnerId}` });
}

function createOutputEmbed(outputType: string, content: string): EmbedBuilder {
  const colors: Record<string, number> = {
    stdout: 0x2B2D31, // Dark grey background for standard output
    stderr: 0xFF6600,
    tool_use: 0xFFD700,
    tool_result: 0x00FF00,
    error: 0xFF0000
  };

  const icons: Record<string, string> = {
    stdout: '💻', // Changed to computer icon
    stderr: '⚠️',
    tool_use: '🔧',
    tool_result: '✅',
    error: '❌'
  };

  const titles: Record<string, string> = {
    stdout: 'CLI Output',
    stderr: 'Error Output',
    tool_use: 'Tool Request',
    tool_result: 'Tool Result',
    error: 'System Error'
  };

  const color = colors[outputType] || 0x2B2D31;
  const icon = icons[outputType] || '📄';
  const title = titles[outputType] || outputType.toUpperCase();

  // For stdout, we often want a cleaner look without a heavy title if it's just streaming logs
  // But for now, let's keep it consistent but cleaner
  const embed = new EmbedBuilder()
    .setColor(color)
    .setDescription(content.substring(0, 4096)); // Max description length

  // Only add title if it's not just a standard output chunk? 
  // User asked for "nicer", maybe just header "CLI Output" is enough.
  // Let's stick to the requested "CLI Output" header.
  embed.setTitle(`${icon} ${title}`);

  // Remove timestamp footer for cleaner look on rapid updates? 
  // User didn't ask to remove it, but "nicer" might mean less clutter.
  // I'll keep it simple.
  embed.setTimestamp();

  return embed;
}

function createActionItemEmbed(actionItem: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle('Action Item Detected')
    .setDescription(actionItem)
    .setTimestamp();
}

function createSessionStartEmbed(runner: RunnerInfo, session: Session): EmbedBuilder {
  const fields = [
    { name: 'Runner', value: `\`${runner.name}\``, inline: true },
    { name: 'CLI', value: session.cliType.toUpperCase(), inline: true },
    { name: 'Session ID', value: `\`${session.sessionId}\``, inline: false }
  ];

  // Add folder path if specified
  if (session.folderPath) {
    fields.push({ name: 'Working Folder', value: `\`\`\`${session.folderPath}\`\`\``, inline: false });
  }

  return new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('Session Started')
    .addFields(...fields)
    .setTimestamp()
    .setFooter({ text: 'Type your prompt to start using the CLI' });
}

function createApprovalDecisionEmbed(allowed: boolean, toolName: string, username: string, detail?: string): EmbedBuilder {
  const description = detail
    ? `Tool \`${toolName}\` was ${allowed ? 'allowed' : 'denied'} by ${username}\n\n**Choice:** ${detail}`
    : `Tool \`${toolName}\` was ${allowed ? 'allowed' : 'denied'} by ${username}`;

  return new EmbedBuilder()
    .setColor(allowed ? 0x00FF00 : 0xFF0000)
    .setTitle(allowed ? '✅ Allowed' : '❌ Denied')
    .setDescription(description)
    .setTimestamp();
}

function createRunnerOfflineEmbed(runner: RunnerInfo): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('Runner Offline')
    .setDescription(`Your runner \`${runner.name}\` has gone offline.\n\nCheck that the Runner Agent is still running.`)
    .addFields(
      { name: 'Runner ID', value: `\`${runner.runnerId}\``, inline: true },
      { name: 'Last Seen', value: new Date(runner.lastHeartbeat).toLocaleString(), inline: true }
    )
    .setTimestamp();
}

function createSessionInactiveEmbed(runner: RunnerInfo, session: Session): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xFF6600)
    .setTitle('Session Inactive - Runner Offline')
    .setDescription(`The runner for this session (\`${runner.name}\`) has gone offline.\n\n**This session is paused until the runner comes back online.**\n\nMessages sent will be queued and delivered when the runner reconnects.`)
    .addFields(
      { name: 'Runner Status', value: '🔴 Offline', inline: true },
      { name: 'Session ID', value: `\`${session.sessionId}\``, inline: true },
      { name: 'CLI Type', value: session.cliType.toUpperCase(), inline: true }
    )
    .setTimestamp()
    .setFooter({ text: 'The Runner Agent needs to be restarted to resume this session' });
}

function createInfoEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x0099FF)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
}

function createErrorEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
}

// Create "Send Prompt" button for continuing conversation
function createSendPromptButton(sessionId: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>()
    .addComponents(
      new ButtonBuilder()
        .setLabel('Send Prompt')
        .setStyle(ButtonStyle.Primary)
        .setCustomId(`prompt_${sessionId}`)
        .setEmoji('💬')
    );
}

function createSuccessEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle(title)
    .setDescription(description)
    .setTimestamp();
}

function extractActionItems(sessionId: string, content: string): void {
  // Simple action item extraction - looks for patterns like:
  // - TODO: ...
  // - [ ] ... (checkboxes)
  // - ACTION: ...
  // - FIXME: ...

  const patterns = [
    /TODO:\s*(.+)/gi,
    /\[\s*\]\s*(.+)/g,
    /ACTION:\s*(.+)/gi,
    /FIXME:\s*(.+)/gi,
    /XXX:\s*(.+)/gi
  ];

  const items = actionItems.get(sessionId) || [];

  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      const item = match[1]?.trim();
      if (item && !items.includes(item)) {
        items.push(item);
      }
    }
  }

  if (items.length > 0) {
    actionItems.set(sessionId, items);
  }
}

// Register slash commands
async function registerCommands(): Promise<void> {
  const commands = [
    new SlashCommandBuilder()
      .setName('generate-token')
      .setDescription('Generate a token for Runner Agent authentication'),

    new SlashCommandBuilder()
      .setName('list-runners')
      .setDescription('List all your runners'),



    new SlashCommandBuilder()
      .setName('my-access')
      .setDescription('Show all runners you can access (owned + shared)'),

    new SlashCommandBuilder()
      .setName('list-access')
      .setDescription('Show users who have access to your runners')
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID to check (leave empty to see all)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('create-session')
      .setDescription('Create a new CLI session')
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID (leave empty to use first online)')
          .setRequired(false)
      )
      .addStringOption(option =>
        option.setName('cli')
          .setDescription('CLI type')
          .addChoices(
            { name: 'Claude Code', value: 'claude' },
            { name: 'Gemini CLI', value: 'gemini' }
          )
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('share-runner')
      .setDescription('Share a runner with another user')
      .addUserOption(option =>
        option.setName('user')
          .setDescription('User to share with')
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID to share')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('unshare-runner')
      .setDescription('Revoke access to a runner')
      .addUserOption(option =>
        option.setName('user')
          .setDescription('User to revoke from')
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('runner-status')
      .setDescription('Show detailed status of a runner')
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('status')
      .setDescription('List all active sessions and their status')
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Filter by runner ID (optional)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('action-items')
      .setDescription('Show action items from CLI sessions')
      .addStringOption(option =>
        option.setName('session')
          .setDescription('Session ID (leave empty to see all)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('end-session')
      .setDescription('End an active session (auto-detects from current thread/channel)')
      .addStringOption(option =>
        option.setName('session')
          .setDescription('Session ID (optional - auto-detects from current context if not provided)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('terminals')
      .setDescription('List available tmux terminals on a runner')
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID (optional)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('watch')
      .setDescription('Watch an existing tmux session')
      .addStringOption(option =>
        option.setName('session')
          .setDescription('Session ID to watch')
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID (optional)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('unwatch')
      .setDescription('Stop watching a tmux session')
      .addStringOption(option =>
        option.setName('session')
          .setDescription('Session ID (optional - auto-detects)')
          .setRequired(false)
      )
  ];

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  try {
    console.log('Started refreshing application (/) commands.');

    await rest.put(
      Routes.applicationCommands(DISCORD_CLIENT_ID!),
      { body: commands }
    );

    console.log('Successfully reloaded application (/) commands.');
    console.log(`Registered ${commands.length} commands`);
  } catch (error) {
    console.error('Error registering commands:', error);
  }
}

// Start the bot
async function main(): Promise<void> {
  console.log('Starting DisCode Discord Bot...');
  console.log('Phase 2 & 3 features enabled:');
  console.log('  - /my-access - Show accessible runners');
  console.log('  - /list-access - Show authorized users');
  console.log('  - /unshare-runner - Revoke runner access');
  console.log('  - /runner-status - Detailed runner status');
  console.log('  - /action-items - View action items');
  console.log('  - Rich embeds for all interactions');
  console.log('  - Enhanced error messages');
  console.log('  - Runner offline notifications');
  console.log('');

  // Clean up old ended sessions on startup (async, non-blocking)
  const cleanedCount = await storage.cleanupOldSessions();
  if (cleanedCount > 0) {
    console.log(`✅ Cleaned up ${cleanedCount} old ended sessions from storage`);
  }

  await registerCommands();
  await client.login(DISCORD_TOKEN!);
}

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

main().catch(console.error);
