/**
 * DisCode Discord Bot
 *
 * Entry point - orchestrates all modules.
 * Handler logic is in handlers/ directory.
 */

import { REST, Routes, SlashCommandBuilder, Events } from 'discord.js';
import { storage } from './storage.js';
import { getConfig } from './config.js';
import * as botState from './state.js';
import {
  createWebSocketServer,
  handleButtonInteraction,
  handleModalSubmit,
  handleGenerateToken,
  handleListRunners,
  handleMyAccess,
  handleListAccess,
  handleCreateSession,
  handleShareRunner,
  handleUnshareRunner,
  handleRunnerStatus,
  handleActionItems,
  handleStatus,
  handleEndSession,
  handleTerminals,
  handleWatch,
  handleUnwatch,
  handleInterrupt,
  handleAssistantCommand,
} from './handlers/index.js';

// Load configuration
const config = getConfig();
const DISCORD_TOKEN = config.discordToken;
const DISCORD_CLIENT_ID = config.discordClientId;
const WS_PORT = config.wsPort;

// Create WebSocket server
createWebSocketServer(WS_PORT);

// Discord bot events
botState.client.once(Events.ClientReady, () => {
  console.log(`Discord bot logged in as ${botState.client.user?.tag}`);
  botState.setBotReady(true);

});

botState.client.on(Events.InteractionCreate, async (interaction) => {
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

      case 'interrupt':
        await handleInterrupt(interaction, userId);
        break;

      case 'assistant':
        await handleAssistantCommand(interaction, userId);
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
botState.client.on(Events.MessageCreate, async (message) => {
  // Ignore bot messages
  if (message.author.bot) return;

  // Handle thread messages (existing logic)
  if (message.channel.isThread()) {
    // Find the session for this thread
    const allSessions = Object.values(storage.data.sessions);
    const session = allSessions.find(s => s.threadId === message.channel.id && s.status === 'active');

    if (!session) return;

    // Check if user has access
    const runner = storage.getRunner(session.runnerId);
    if (!runner || !storage.canUserAccessRunner(message.author.id, session.runnerId)) {
      return;
    }

    // Get the WebSocket connection for this runner
    const ws = botState.runnerConnections.get(runner.runnerId);
    if (!ws) {

      return;
    }

    // Forward the message to the runner
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



    // Clear streaming message state so next output is a new message
    botState.streamingMessages.delete(session.sessionId);

    // Add a reaction to indicate the message was sent
    try {
      await message.react('✅');
    } catch (error) {
      // Ignore reaction errors
    }
    return;
  }

  // Handle main channel messages for assistant (new logic)
  // Check if assistant mode is 'all' (forward all messages) vs 'command' (only /assistant)

  if (config.assistant.mode !== 'all') return;

  // Check if this is a runner's private channel
  const allRunners = Object.values(storage.data.runners);
  const runner = allRunners.find(r => r.privateChannelId === message.channel.id && r.status === 'online');

  if (!runner) {

    return;
  }

  // Check if user has access to this runner
  if (!storage.canUserAccessRunner(message.author.id, runner.runnerId)) {
    return;
  }

  // Check if assistant is enabled for this runner
  if (!runner.assistantEnabled) {

    return;
  }

  // Get the WebSocket connection for this runner
  const ws = botState.runnerConnections.get(runner.runnerId);
  if (!ws) {

    return;
  }

  // Forward the message to the runner's assistant
  ws.send(JSON.stringify({
    type: 'assistant_message',
    data: {
      runnerId: runner.runnerId,
      userId: message.author.id,
      username: message.author.username,
      content: message.content,
      timestamp: new Date().toISOString()
    }
  }));



  // Clear assistant streaming message state so next output is a new message
  botState.assistantStreamingMessages.delete(runner.runnerId);

  // Add a reaction to indicate the message was sent
  try {
    await message.react('✅');
  } catch (error) {
    // Ignore reaction errors
  }
});

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
      ),

    new SlashCommandBuilder()
      .setName('interrupt')
      .setDescription('Interrupt the current CLI execution (send Ctrl+C)')
      .addStringOption(option =>
        option.setName('session')
          .setDescription('Session ID (optional - auto-detects from current thread)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('assistant')
      .setDescription('Send a message to the runner assistant')
      .addStringOption(option =>
        option.setName('message')
          .setDescription('Message to send to the assistant')
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID (optional - uses current channel runner)')
          .setRequired(false)
      )
  ];

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  try {


    await rest.put(
      Routes.applicationCommands(DISCORD_CLIENT_ID!),
      { body: commands }
    );


  } catch (error) {
    console.error('Error registering commands:', error);
  }
}

// Start the bot
async function main(): Promise<void> {


  // Clean up old ended sessions on startup
  const cleanedCount = await storage.cleanupOldSessions();
  if (cleanedCount > 0) {

  }

  await registerCommands();
  await botState.client.login(DISCORD_TOKEN!);
}

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

main().catch(console.error);
