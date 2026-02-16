/**
 * DisCode Discord Bot
 *
 * Entry point - orchestrates all modules.
 * Handler logic is in handlers/ directory.
 */

import fs from 'fs';
import path from 'path';
import { REST, Routes, SlashCommandBuilder, Events } from 'discord.js';
import { storage } from './storage.js';
import { getConfig } from './config.js';
import * as botState from './state.js';
import { initCategoryManager, getCategoryManager } from './services/category-manager.js';
import { initSessionSyncService } from './services/session-sync.js';
import { attachSyncedSessionControl } from './services/synced-session-control.js';
import { isAlreadyAcknowledged, isUnknownInteraction } from './handlers/interaction-safety.js';
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
  handleRunnerHealth,
  handleRunnerLogs,
  handleListClis,
  handleActionItems,
  handleStatus,
  handleEndSession,
  handleRespawnSession,
  handleTerminals,
  handleWatch,
  handleUnwatch,
  handleInterrupt,
  handleSetModel,
  handleSetPermissionMode,
  handleSetThinkingTokens,
  handleAssistantCommand,
  handleSyncProjects,
  handleSyncSession,
  handleResumeSession,
  handleRegisterProject,
  handleDeleteProject,
  handleCodexThreads,
  handleResumeCodex,
} from './handlers/index.js';

// Load configuration
const config = getConfig();
const DISCORD_TOKEN = config.discordToken;
const DISCORD_CLIENT_ID = config.discordClientId;
const WS_PORT = config.wsPort;
const STORAGE_PATH = process.env.DISCODE_STORAGE_PATH || './data';
const INTERACTION_LOCK_DIR = path.join(STORAGE_PATH, 'interaction-locks');
const INTERACTION_LOCK_TTL_MS = parseInt(process.env.DISCODE_INTERACTION_LOCK_TTL_MS || '900000');
let lastInteractionLockCleanup = 0;

function ensureInteractionLockDir(): void {
  if (!fs.existsSync(INTERACTION_LOCK_DIR)) {
    fs.mkdirSync(INTERACTION_LOCK_DIR, { recursive: true });
  }
}

function cleanupInteractionLocks(nowMs: number): void {
  if (nowMs - lastInteractionLockCleanup < 60000) return;
  lastInteractionLockCleanup = nowMs;

  try {
    ensureInteractionLockDir();
    const files = fs.readdirSync(INTERACTION_LOCK_DIR);
    for (const file of files) {
      if (!file.endsWith('.lock')) continue;
      const lockPath = path.join(INTERACTION_LOCK_DIR, file);
      try {
        const stat = fs.statSync(lockPath);
        if (nowMs - stat.mtimeMs > INTERACTION_LOCK_TTL_MS) {
          fs.unlinkSync(lockPath);
        }
      } catch {
        // Ignore per-file cleanup failures.
      }
    }
  } catch {
    // Ignore cleanup failures to avoid breaking interaction flow.
  }
}

function tryClaimInteraction(interactionId: string): boolean {
  const nowMs = Date.now();
  cleanupInteractionLocks(nowMs);

  try {
    ensureInteractionLockDir();
    const lockPath = path.join(INTERACTION_LOCK_DIR, `${interactionId}.lock`);
    fs.writeFileSync(lockPath, String(nowMs), { flag: 'wx' });
    return true;
  } catch (error: any) {
    if (error?.code === 'EEXIST') {
      return false;
    }
    console.error('[Interaction] Failed to claim interaction lock:', error);
    // Fail open so a lock issue doesn't block bot behavior.
    return true;
  }
}

// Create WebSocket server
createWebSocketServer(WS_PORT);

// Discord bot events
botState.client.once(Events.ClientReady, async () => {
  console.log(`Discord bot logged in as ${botState.client.user?.tag}`);
  botState.setBotReady(true);

  // Initialize CategoryManager now that we are logged in
  const categoryManager = getCategoryManager();
  if (categoryManager) {
      console.log('[Index] Initializing CategoryManager...');
      await categoryManager.initialize();
      await reconcileRunnerCategories();
  }

});

botState.client.on(Events.InteractionCreate, async (interaction) => {
  if (!tryClaimInteraction(interaction.id)) {
    console.warn(`[Interaction] Duplicate interaction detected, skipping ${interaction.id}`);
    return;
  }

  try {
    if (!interaction.isChatInputCommand()) {
      // Handle button interactions
      if (interaction.isButton()) {
        await handleButtonInteraction(interaction);
        return;
      }
      // Handle string select menu interactions through the same router
      if (interaction.isStringSelectMenu()) {
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
  } catch (error) {
    if (isUnknownInteraction(error)) {
      return;
    }
    if (isAlreadyAcknowledged(error)) {
      console.warn('[Interaction] Non-command interaction was already acknowledged. Skipping duplicate response.');
      return;
    }
    console.error('Error handling interaction:', error);
    try {
        if ((interaction as any).replied || (interaction as any).deferred) {
            await (interaction as any).followUp({ content: '❌ Interaction failed.', flags: 64 });
        } else {
            await (interaction as any).reply({ content: '❌ Interaction failed.', flags: 64 });
        }
    } catch (e) {
        // Ignore secondary error
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

      case 'runner-health':
        await handleRunnerHealth(interaction, userId);
        break;

      case 'list-clis':
        await handleListClis(interaction, userId);
        break;

      case 'runner-logs':
        await handleRunnerLogs(interaction, userId);
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

      case 'set-model':
        await handleSetModel(interaction, userId);
        break;

      case 'set-permission-mode':
        await handleSetPermissionMode(interaction, userId);
        break;

      case 'set-thinking-tokens':
        await handleSetThinkingTokens(interaction, userId);
        break;

      case 'respawn-session':
        await handleRespawnSession(interaction, userId);
        break;

      case 'assistant':
        await handleAssistantCommand(interaction, userId);
        break;

      case 'sync-projects':
        await handleSyncProjects(interaction, userId);
        break;

      case 'sync-session':
        await handleSyncSession(interaction, userId);
        break;

      case 'register-project':
        await handleRegisterProject(interaction, userId);
        break;

      case 'resume':
        await handleResumeSession(interaction, userId);
        break;

      case 'codex-threads':
        await handleCodexThreads(interaction, userId);
        break;

      case 'resume-codex':
        await handleResumeCodex(interaction, userId);
        break;

      case 'delete-project':
        await handleDeleteProject(interaction, userId);
        break;

      default:
        await interaction.reply({
          content: 'Unknown command',
          flags: 64
        });
    }
  } catch (error) {
    if (isUnknownInteraction(error)) {
      return;
    }
    if (isAlreadyAcknowledged(error)) {
      console.warn(`[Interaction] Command ${commandName} was already acknowledged. Possible duplicate handler or bot instance.`);
      return;
    }
    console.error(`Error handling command ${commandName}:`, error);
    
    // Check if we can still reply
    if (interaction.replied || interaction.deferred) {
        try {
            await interaction.followUp({
                content: `❌ Error executing command: ${error instanceof Error ? error.message : 'Unknown error'}`,
                flags: 64
            });
        } catch (followUpError) {
             if (isUnknownInteraction(followUpError) || isAlreadyAcknowledged(followUpError)) {
                return;
             }
             console.error('Failed to follow up with error:', followUpError);
        }
    } else {
        try {
            await interaction.reply({
                content: `❌ Error executing command: ${error instanceof Error ? error.message : 'Unknown error'}`,
                flags: 64
            });
        } catch (replyError) {
             if (isUnknownInteraction(replyError) || isAlreadyAcknowledged(replyError)) {
                return;
             }
             console.error('Failed to reply with error:', replyError);
        }
    }
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

    if (!session) {
      const attachments = message.attachments.map(att => ({
        name: att.name,
        url: att.url,
        contentType: att.contentType || 'application/octet-stream',
        size: att.size
      }));

      const attachResult = await attachSyncedSessionControl({
        threadId: message.channel.id,
        userId: message.author.id,
        initialMessage: {
          content: message.content,
          username: message.author.username,
          attachments
        }
      });

      if (attachResult.ok) {
        try { await message.react('🔄'); } catch (e) { /* ignore */ }
        return;
      }

      if (attachResult.reason === 'runner_offline') {
        try {
          await message.reply({ content: '❌ **Runner Offline**: Cannot resume this synced session because the runner is offline.' });
        } catch (e) { /* ignore */ }
        return;
      }

      if (attachResult.reason === 'runner_unavailable') {
        try {
          await message.reply({ content: '❌ Runner connection unavailable. Please try again in a moment.' });
        } catch (e) { /* ignore */ }
        return;
      }

      return;
    }

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
    const attachments = message.attachments.map(att => ({
      name: att.name,
      url: att.url,
      contentType: att.contentType || 'application/octet-stream',
      size: att.size
    }));

    ws.send(JSON.stringify({
      type: 'user_message',
      data: {
        sessionId: session.sessionId,
        userId: message.author.id,
        username: message.author.username,
        content: message.content,
        attachments: attachments.length > 0 ? attachments : undefined,
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

  // Handle messages in project channels — bump the project dashboard
  const categoryManager = getCategoryManager();
  if (categoryManager) {
    const projectInfo = categoryManager.getProjectByChannelId(message.channel.id);
    if (projectInfo) {
      const { runnerId, projectPath } = projectInfo;
      const sessions = storage.getRunnerSessions(runnerId);
      const projectSessions = sessions.filter(s => s.folderPath === projectPath);
      const activeSessions = projectSessions.filter(s => s.status === 'active').length;
      const { permissionStateStore } = await import('./permissions/state-store.js');
      const pendingActions = permissionStateStore.getByRunnerId(runnerId)
        .filter(s => {
          const session = storage.getSession(s.request.sessionId);
          return session?.folderPath === projectPath;
        }).length;

      await categoryManager.bumpProjectDashboard(runnerId, projectPath, {
        totalSessions: projectSessions.length,
        activeSessions,
        pendingActions
      }, message.channel as any);
      return;
    }
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
            { name: 'Gemini CLI', value: 'gemini' },
            { name: 'Codex CLI', value: 'codex' }
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
      .setName('runner-health')
      .setDescription('Get health info for a runner')
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('list-clis')
      .setDescription('List detected CLI paths for a runner')
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID (optional)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('runner-logs')
      .setDescription('Fetch recent runner logs (requires DISCODE_RUNNER_LOG_PATH)')
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
      .setName('set-model')
      .setDescription('Set model for an SDK session')
      .addStringOption(option =>
        option.setName('model')
          .setDescription('Model name (e.g. claude-sonnet-4-5)')
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName('session')
          .setDescription('Session ID (optional - auto-detects from current thread)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('set-permission-mode')
      .setDescription('Set permission mode for an SDK session')
      .addStringOption(option =>
        option.setName('mode')
          .setDescription('Permission mode')
          .addChoices(
            { name: 'Default', value: 'default' },
            { name: 'Accept Edits', value: 'acceptEdits' }
          )
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName('session')
          .setDescription('Session ID (optional - auto-detects from current thread)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('set-thinking-tokens')
      .setDescription('Set max thinking tokens for a session (Claude SDK)')
      .addIntegerOption(option =>
        option.setName('max_tokens')
          .setDescription('Maximum thinking tokens')
          .setRequired(true)
      )
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
      ),

    new SlashCommandBuilder()
      .setName('respawn-session')
      .setDescription('Respawn a dead session in this thread with the same settings'),

    new SlashCommandBuilder()
      .setName('sync-projects')
      .setDescription('Sync projects from ~/.claude/projects/ to Discord')
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID to sync (optional)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('sync-session')
      .setDescription('Sync full message history for a session')
      .addStringOption(option =>
        option.setName('session')
          .setDescription('Session ID (optional - auto-detects from current thread)')
          .setRequired(false)
      )
      .addStringOption(option =>
        option.setName('project')
          .setDescription('Project path (required if not in thread)')
          .setRequired(false)
      )
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID (required if not in thread)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('register-project')
      .setDescription('Manually register a project')
      .addStringOption(option =>
        option.setName('path')
          .setDescription('Full path to project folder')
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID (optional)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('resume')
      .setDescription('Resume a synced session or restart a previous session')
      .addStringOption(option =>
        option.setName('session')
          .setDescription('Session ID to resume (optional if in thread)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('codex-threads')
      .setDescription('List Codex threads available on a runner')
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID (optional)')
          .setRequired(false)
      )
      .addBooleanOption(option =>
        option.setName('archived')
          .setDescription('Include archived threads')
          .setRequired(false)
      )
      .addIntegerOption(option =>
        option.setName('limit')
          .setDescription('Max threads to display (default 10)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('resume-codex')
      .setDescription('Resume a Codex thread')
      .addStringOption(option =>
        option.setName('thread')
          .setDescription('Codex thread ID to resume')
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID (optional)')
          .setRequired(false)
      )
      .addStringOption(option =>
        option.setName('cwd')
          .setDescription('Working directory override (optional)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('delete-project')
      .setDescription('Delete a project and its channel')
      .addStringOption(option =>
        option.setName('path')
          .setDescription('Project path (optional if in project channel)')
          .setRequired(false)
      )
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID (optional)')
          .setRequired(false)
      )
      .addBooleanOption(option =>
        option.setName('all')
          .setDescription('Delete ALL projects for this runner')
          .setRequired(false)
      ),
  ];

  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  try {


    if (config.guildId) {
      console.log(`Registering guild commands for ${config.guildId}...`);
      await rest.put(
        Routes.applicationGuildCommands(DISCORD_CLIENT_ID!, config.guildId),
        { body: commands }
      );
    } else {
      console.log('Registering global commands...');
      await rest.put(
        Routes.applicationCommands(DISCORD_CLIENT_ID!),
        { body: commands }
      );
    }


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

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

main().catch(console.error);
