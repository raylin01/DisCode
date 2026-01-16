/**
 * DisCode Discord Bot - Enhanced (Phase 2 & 3)
 *
 * Features:
 * - Multi-runner support with selection UI
 * - Rich embeds for tool use, output, errors
 * - Enhanced permission system
 * - Action item extraction
 * - Better error handling
 */

import { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder, ComponentType, EmbedBuilder } from 'discord.js';
import { WebSocketServer } from 'ws';
import { storage } from './storage.js';
import type { ApprovalRequest, RunnerInfo, WebSocketMessage, Session } from '../shared/types.js';

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

// Active WebSocket connections (runnerId -> ws)
const runnerConnections = new Map<string, any>();

// Pending approvals (requestId -> { userId, channelId, messageId, runnerId, toolName, toolInput })
const pendingApprovals = new Map<string, {
  userId: string;
  channelId: string;
  messageId: string;
  runnerId: string;
  toolName: string;
  toolInput: unknown;
}>();

// Action items extracted from sessions (sessionId -> actionItems)
const actionItems = new Map<string, string[]>();

// WebSocket server for runners
const wss = new WebSocketServer({ port: WS_PORT });

wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection');

  ws.on('message', async (data: Buffer) => {
    try {
      const message: WebSocketMessage = JSON.parse(data.toString());
      await handleWebSocketMessage(ws, message);
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
    // Remove connection
    for (const [runnerId, connection] of runnerConnections.entries()) {
      if (connection === ws) {
        runnerConnections.delete(runnerId);
        storage.updateRunnerStatus(runnerId, 'offline');

        // Notify owner about runner going offline
        const runner = storage.getRunner(runnerId);
        if (runner) {
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
  try {
    const user = await client.users.fetch(runner.ownerId);
    await user.send({
      embeds: [createRunnerOfflineEmbed(runner)]
    });
  } catch (error) {
    console.error('Failed to notify user about runner offline:', error);
  }
}

async function handleWebSocketMessage(ws: any, message: WebSocketMessage): Promise<void> {
  switch (message.type) {
    case 'heartbeat': {
      const data = message.data as {
        runnerId: string;
        timestamp: string;
        cpu?: number;
        memory?: number;
        activeSessions?: number;
      };

      storage.updateRunnerStatus(data.runnerId, 'online');

      // Register connection if not already
      if (!runnerConnections.has(data.runnerId)) {
        runnerConnections.set(data.runnerId, ws);
        console.log(`Runner ${data.runnerId} registered`);
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

    default:
      console.log('Unknown message type:', message.type);
  }
}

async function handleApprovalRequest(ws: any, data: {
  requestId: string;
  runnerId: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  timestamp: string;
}): Promise<void> {
  const runner = storage.getRunner(data.runnerId);
  if (!runner) {
    console.error('Unknown runner:', data.runnerId);
    return;
  }

  // Find the session
  const session = storage.getSession(data.sessionId);
  if (!session) {
    console.error('Unknown session:', data.sessionId);
    return;
  }

  const channel = await client.channels.fetch(session.channelId);
  if (!channel || !('send' in channel)) {
    console.error('Invalid channel');
    return;
  }

  // Create approval buttons
  const allowButton = new ButtonBuilder()
    .setCustomId(`allow_${data.requestId}`)
    .setLabel('✅ Allow')
    .setStyle(ButtonStyle.Success);

  const denyButton = new ButtonBuilder()
    .setCustomId(`deny_${data.requestId}`)
    .setLabel('❌ Deny')
    .setStyle(ButtonStyle.Danger);

  const row = new ActionRowBuilder<ButtonBuilder>()
    .addComponents(allowButton, denyButton);

  // Create rich embed
  const embed = createToolUseEmbed(runner, data.toolName, data.toolInput);

  // Send approval request
  const message = await channel.send({
    embeds: [embed],
    components: [row]
  });

  // Store pending approval
  pendingApprovals.set(data.requestId, {
    userId: runner.ownerId,
    channelId: session.channelId,
    messageId: message.id,
    runnerId: data.runnerId,
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

  const channel = await client.channels.fetch(session.channelId);
  if (!channel || !('send' in channel)) return;

  // Create embed based on output type
  const embed = createOutputEmbed(data.outputType || 'stdout', data.content);

  // Send output (chunk if too long)
  const maxLength = 4000;
  const content = data.content;

  if (content.length <= maxLength) {
    await channel.send({ embeds: [embed] });
  } else {
    // Split into chunks
    for (let i = 0; i < content.length; i += maxLength) {
      const chunk = content.substring(i, i + maxLength);
      const chunkEmbed = createOutputEmbed(data.outputType || 'stdout', chunk);
      await channel.send({ embeds: [chunkEmbed] });
    }
  }

  // Extract action items from output
  extractActionItems(session.sessionId, content);
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

// Discord bot events
client.once('ready', () => {
  console.log(`Discord bot logged in as ${client.user?.tag}`);
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) {
    // Handle button interactions
    if (interaction.isButton()) {
      await handleButtonInteraction(interaction);
    }
    return;
  }

  const { commandName, userId, guildId } = interaction;

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

      default:
        await interaction.reply({
          content: 'Unknown command',
          ephemeral: true
        });
    }
  } catch (error) {
    console.error(`Error handling command ${commandName}:`, error);
    await interaction.reply({
      content: `❌ Error executing command: ${error instanceof Error ? error.message : 'Unknown error'}`,
      ephemeral: true
    });
  }
});

// Command handlers
async function handleGenerateToken(interaction: any, userId: string, guildId: string): Promise<void> {
  const tokenInfo = storage.generateToken(userId, guildId);

  const embed = new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('✅ Token Generated')
    .setDescription('Use this token to connect your Runner Agent')
    .addFields(
      { name: 'Token', value: `\`\`\`${tokenInfo.token}\`\`\``, inline: false },
      { name: '⚠️ Warning', value: 'Keep this token secret! Anyone with this token can access your runners.', inline: false }
    )
    .setTimestamp()
    .setFooter({ text: `Created at ${new Date(tokenInfo.createdAt).toLocaleString()}` });

  await interaction.reply({
    embeds: [embed],
    ephemeral: true
  });
}

async function handleListRunners(interaction: any, userId: string): Promise<void> {
  const runners = storage.getUserRunners(userId);

  if (runners.length === 0) {
    await interaction.reply({
      embeds: [createInfoEmbed('No Runners', "You don't have any runners yet. Connect a Runner Agent to get started.\n\n1. Run `/generate-token`\n2. Copy the token\n3. Start your Runner Agent with the token\n4. Run `/list-runners` again")],
      ephemeral: true
    });
    return;
  }

  const fields = runners.map(r => ({
    name: `${r.status === 'online' ? '🟢' : '🔴'} ${r.name}`,
    value: `ID: \`${r.runnerId}\`\nCLI: ${r.cliType}\nStatus: ${r.status}`,
    inline: true
  }));

  const embed = new EmbedBuilder()
    .setColor(0x0099FF)
    .setTitle('🖥️ Your Runners')
    .addFields(...fields)
    .setTimestamp();

  await interaction.reply({
    embeds: [embed],
    ephemeral: true
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
      ephemeral: true
    });
    return;
  }

  const owned = accessibleRunners.filter(r => r.ownerId === userId);
  const shared = accessibleRunners.filter(r => r.ownerId !== userId);

  const fields: { name: string; value: string; inline: boolean }[] = [];

  if (owned.length > 0) {
    fields.push({
      name: '👑 Your Runners',
      value: owned.map(r => `• ${r.name} (${r.status === 'online' ? '🟢' : '🔴'} ${r.status})`).join('\n') || 'None',
      inline: false
    });
  }

  if (shared.length > 0) {
    fields.push({
      name: '🔓 Shared with You',
      value: shared.map(r => `• ${r.name} (${r.status === 'online' ? '🟢' : '🔴'} ${r.status})`).join('\n') || 'None',
      inline: false
    });
  }

  const embed = new EmbedBuilder()
    .setColor(0x0099FF)
    .setTitle('🔑 Your Runner Access')
    .addFields(...fields)
    .setTimestamp();

  await interaction.reply({
    embeds: [embed],
    ephemeral: true
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
        ephemeral: true
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
      .setTitle('👥 Runner Access Overview')
      .addFields(...fields)
      .setTimestamp();

    await interaction.reply({
      embeds: [embed],
      ephemeral: true
    });
    return;
  }

  // Check if user owns this runner
  const runner = storage.getRunner(runnerId);
  if (!runner || runner.ownerId !== userId) {
    await interaction.reply({
      embeds: [createErrorEmbed('Access Denied', 'You can only view access for runners you own.')],
      ephemeral: true
    });
    return;
  }

  // Get authorized users
  const authorizedUsers = runner.authorizedUsers;

  if (authorizedUsers.length === 0) {
    await interaction.reply({
      embeds: [createInfoEmbed('No Shared Access', 'This runner is not shared with anyone else.')],
      ephemeral: true
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
    .setTitle(`👥 Users with Access to ${runner.name}`)
    .setDescription(userList.join('\n'))
    .addFields(
      { name: 'Runner ID', value: `\`${runnerId}\``, inline: true },
      { name: 'Total Users', value: `${authorizedUsers.length}`, inline: true }
    )
    .setTimestamp();

  await interaction.reply({
    embeds: [embed],
    ephemeral: true
  });
}

async function handleCreateSession(interaction: any, userId: string): Promise<void> {
  const runnerId = interaction.options.getString('runner');
  const cliType = interaction.options.getString('cli') as 'claude' | 'gemini' | null;

  // Get accessible runners
  let runners: RunnerInfo[];

  if (runnerId) {
    const runner = storage.getRunner(runnerId);
    if (!runner || !storage.canUserAccessRunner(userId, runnerId)) {
      await interaction.reply({
        embeds: [createErrorEmbed('Invalid Runner', 'Runner not found or you do not have access to it.')],
        ephemeral: true
      });
      return;
    }
    runners = [runner];
  } else {
    runners = storage.getUserRunners(userId).filter(r => r.status === 'online');

    // Filter by CLI type if specified
    if (cliType) {
      runners = runners.filter(r => r.cliType === cliType);
    }
  }

  if (runners.length === 0) {
    await interaction.reply({
      embeds: [createErrorEmbed('No Online Runners', 'No online runners available. Make sure your Runner Agent is connected.')],
      ephemeral: true
    });
    return;
  }

  // For now, just use the first runner
  // TODO: Add runner selection UI when multiple available
  const runner = runners[0];

  // Create a private thread
  const channel = await interaction.channel?.fetch();
  if (!channel || !('threads' in channel)) {
    await interaction.reply({
      embeds: [createErrorEmbed('Cannot Create Thread', 'Cannot create thread in this channel type.')],
      ephemeral: true
    });
    return;
  }

  const thread = await channel.threads.create({
    name: `🚀 ${runner.name}-${Date.now()}`,
    type: 2 // Private thread
  });

  // Create session
  const session: Session = {
    sessionId: `session_${Date.now()}`,
    runnerId: runner.runnerId,
    channelId: thread.id,
    threadId: thread.id,
    createdAt: new Date().toISOString(),
    status: 'active'
  };

  storage.createSession(session);
  actionItems.set(session.sessionId, []);

  // Send session start embed
  const embed = createSessionStartEmbed(runner, session);
  await thread.send({ embeds: [embed] });

  await interaction.reply({
    content: `✅ Session created: ${thread}`,
    ephemeral: true
  });
}

async function handleShareRunner(interaction: any, userId: string): Promise<void> {
  const targetUser = interaction.options.getUser('user');
  const runnerId = interaction.options.getString('runner');

  if (!targetUser || !runnerId) {
    await interaction.reply({
      embeds: [createErrorEmbed('Missing Parameters', 'User and runner are required.')],
      ephemeral: true
    });
    return;
  }

  const success = storage.shareRunner(userId, runnerId, targetUser.id);

  if (success) {
    const runner = storage.getRunner(runnerId);
    await interaction.reply({
      embeds: [createSuccessEmbed('Runner Shared', `Successfully shared \`${runner?.name}\` with ${targetUser.username}`)],
      ephemeral: true
    });
  } else {
    await interaction.reply({
      embeds: [createErrorEmbed('Failed to Share', 'Make sure you own this runner.')],
      ephemeral: true
    });
  }
}

async function handleUnshareRunner(interaction: any, userId: string): Promise<void> {
  const targetUser = interaction.options.getUser('user');
  const runnerId = interaction.options.getString('runner');

  if (!targetUser || !runnerId) {
    await interaction.reply({
      embeds: [createErrorEmbed('Missing Parameters', 'User and runner are required.')],
      ephemeral: true
    });
    return;
  }

  const success = storage.unshareRunner(userId, runnerId, targetUser.id);

  if (success) {
    const runner = storage.getRunner(runnerId);
    await interaction.reply({
      embeds: [createSuccessEmbed('Access Revoked', `Successfully revoked ${targetUser.username}'s access to \`${runner?.name}\``)],
      ephemeral: true
    });
  } else {
    await interaction.reply({
      embeds: [createErrorEmbed('Failed to Revoke', 'Make sure you own this runner.')],
      ephemeral: true
    });
  }
}

async function handleRunnerStatus(interaction: any, userId: string): Promise<void> {
  const runnerId = interaction.options.getString('runner');

  if (!runnerId) {
    await interaction.reply({
      embeds: [createErrorEmbed('Missing Runner', 'Please specify a runner ID.')],
      ephemeral: true
    });
    return;
  }

  const runner = storage.getRunner(runnerId);

  if (!runner || !storage.canUserAccessRunner(userId, runnerId)) {
    await interaction.reply({
      embeds: [createErrorEmbed('Access Denied', 'Runner not found or you do not have access to it.')],
      ephemeral: true
    });
    return;
  }

  const sessions = storage.getRunnerSessions(runnerId);
  const activeSessions = sessions.filter(s => s.status === 'active').length;

  const embed = new EmbedBuilder()
    .setColor(runner.status === 'online' ? 0x00FF00 : 0xFF0000)
    .setTitle(`📊 ${runner.name} Status`)
    .addFields(
      { name: 'Status', value: runner.status === 'online' ? '🟢 Online' : '🔴 Offline', inline: true },
      { name: 'CLI Type', value: runner.cliType, inline: true },
      { name: 'Active Sessions', value: `${activeSessions}`, inline: true },
      { name: 'Last Heartbeat', value: new Date(runner.lastHeartbeat).toLocaleString(), inline: true },
      { name: 'Runner ID', value: `\`${runnerId}\``, inline: false },
      { name: 'Owner', value: `<@${runner.ownerId}>`, inline: true }
    )
    .setTimestamp();

  if (runner.authorizedUsers.length > 0) {
    embed.addFields({
      name: '🔓 Shared With',
      value: `${runner.authorizedUsers.length} user(s)`,
      inline: true
    });
  }

  await interaction.reply({
    embeds: [embed],
    ephemeral: true
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
        ephemeral: true
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
        ephemeral: true
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
      .setTitle('📝 Action Items')
      .setDescription(`Found ${allItems.reduce((sum, { items }) => sum + items.length, 0)} action item(s)`)
      .addFields(...fields)
      .setTimestamp();

    await interaction.reply({
      embeds: [embed],
      ephemeral: true
    });
    return;
  }

  // Show action items for specific session
  const items = actionItems.get(sessionId) || [];

  if (items.length === 0) {
    await interaction.reply({
      embeds: [createInfoEmbed('No Action Items', 'No action items found for this session.')],
      ephemeral: true
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
    .setTitle(`📝 Action Items - ${sessionId}`)
    .addFields(...fields)
    .setTimestamp();

  await interaction.reply({
    embeds: [embed],
    ephemeral: true
  });
}

async function handleButtonInteraction(interaction: any): Promise<void> {
  const customId = interaction.customId;

  if (!customId.startsWith('allow_') && !customId.startsWith('deny_')) {
    return;
  }

  const [action, requestId] = customId.split('_');

  const pending = pendingApprovals.get(requestId);
  if (!pending) {
    await interaction.reply({
      embeds: [createErrorEmbed('Expired', 'This approval request has expired.')],
      ephemeral: true
    });
    return;
  }

  // Check if user is authorized
  const userId = interaction.user.id;
  const runner = storage.getRunner(pending.runnerId);

  if (!runner || !storage.canUserAccessRunner(userId, pending.runnerId)) {
    await interaction.reply({
      embeds: [createErrorEmbed('Unauthorized', 'You are not authorized to approve this request.')],
      ephemeral: true
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
}

// Helper functions for creating embeds
function createToolUseEmbed(runner: RunnerInfo, toolName: string, toolInput: unknown): EmbedBuilder {
  const toolInputStr = JSON.stringify(toolInput, null, 2).substring(0, 1000);

  return new EmbedBuilder()
    .setColor(0xFFD700) // Gold for warning/pending
    .setTitle('🔔 Tool Use Approval Required')
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
    stdout: 0x0099FF,
    stderr: 0xFF6600,
    tool_use: 0xFFD700,
    tool_result: 0x00FF00,
    error: 0xFF0000
  };

  const icons: Record<string, string> = {
    stdout: '📤',
    stderr: '⚠️',
    tool_use: '🔧',
    tool_result: '✅',
    error: '❌'
  };

  const color = colors[outputType] || 0x999999;
  const icon = icons[outputType] || '📄';

  return new EmbedBuilder()
    .setColor(color)
    .setTitle(`${icon} ${outputType.toUpperCase()}`)
    .setDescription(content.substring(0, 4000))
    .setTimestamp();
}

function createActionItemEmbed(actionItem: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xFFD700)
    .setTitle('📝 Action Item Detected')
    .setDescription(actionItem)
    .setTimestamp();
}

function createSessionStartEmbed(runner: RunnerInfo, session: Session): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle('🚀 Session Started')
    .addFields(
      { name: 'Runner', value: `\`${runner.name}\``, inline: true },
      { name: 'CLI', value: runner.cliType, inline: true },
      { name: 'Session ID', value: `\`${session.sessionId}\``, inline: false }
    )
    .setTimestamp()
    .setFooter({ text: 'Type your prompt to start using the CLI' });
}

function createApprovalDecisionEmbed(allowed: boolean, toolName: string, username: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(allowed ? 0x00FF00 : 0xFF0000)
    .setTitle(allowed ? '✅ Allowed' : '❌ Denied')
    .setDescription(`Tool \`${toolName}\` was ${allowed ? 'allowed' : 'denied'} by ${username}`)
    .setTimestamp();
}

function createRunnerOfflineEmbed(runner: RunnerInfo): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0xFF0000)
    .setTitle('⚠️ Runner Offline')
    .setDescription(`Your runner \`${runner.name}\` has gone offline.\n\nCheck that the Runner Agent is still running.`)
    .addFields(
      { name: 'Runner ID', value: `\`${runner.runnerId}\``, inline: true },
      { name: 'Last Seen', value: new Date(runner.lastHeartbeat).toLocaleString(), inline: true }
    )
    .setTimestamp();
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
    .setTitle(`❌ ${title}`)
    .setDescription(description)
    .setTimestamp();
}

function createSuccessEmbed(title: string, description: string): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(0x00FF00)
    .setTitle(`✅ ${title}`)
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
      .setName('action-items')
      .setDescription('Show action items from CLI sessions')
      .addStringOption(option =>
        option.setName('session')
          .setDescription('Session ID (leave empty to see all)')
          .setRequired(false)
      )
  ];

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  try {
    console.log('Started refreshing application (/) commands.');

    await rest.put(
      Routes.applicationCommands(DISCORD_CLIENT_ID),
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
  await registerCommands();
  await client.login(DISCORD_TOKEN);
  console.log(`WebSocket server listening on port ${WS_PORT}`);
  console.log('Phase 2 & 3 features enabled:');
  console.log('  ✓ /my-access - Show accessible runners');
  console.log('  ✓ /list-access - Show authorized users');
  console.log('  ✓ /unshare-runner - Revoke runner access');
  console.log('  ✓ /runner-status - Detailed runner status');
  console.log('  ✓ /action-items - View action items');
  console.log('  ✓ Rich embeds for all interactions');
  console.log('  ✓ Enhanced error messages');
  console.log('  ✓ Runner offline notifications');
}

main().catch(console.error);
