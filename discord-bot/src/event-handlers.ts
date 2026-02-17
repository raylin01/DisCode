/**
 * Discord Event Handlers
 *
 * Contains all Discord.js event handlers for the bot.
 */

import { Events, Client } from 'discord.js';
import * as botState from './state.js';
import { storage } from './storage.js';
import { getConfig } from './config.js';
import { getCategoryManager } from './services/category-manager.js';
import { attachSyncedSessionControl } from './services/synced-session-control.js';
import { isAlreadyAcknowledged, isUnknownInteraction } from './handlers/interaction-safety.js';
import { tryClaimInteraction } from './utils/interaction-lock.js';
import {
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

const config = getConfig();

/**
 * Sets up the ClientReady event handler
 */
export function setupReadyHandler(reconcileRunnerCategories: () => Promise<void>): void {
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
}

/**
 * Sets up the InteractionCreate event handler
 */
export function setupInteractionHandler(): void {
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
      await handleChatInputCommand(interaction, commandName, userId, guildId);
    } catch (error) {
      await handleCommandError(interaction, commandName, error);
    }
  });
}

/**
 * Routes chat input commands to their handlers
 */
async function handleChatInputCommand(
  interaction: any,
  commandName: string,
  userId: string,
  guildId: string
): Promise<void> {
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
}

/**
 * Handles errors that occur during command execution
 */
async function handleCommandError(
  interaction: any,
  commandName: string,
  error: unknown
): Promise<void> {
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

/**
 * Sets up the MessageCreate event handler
 */
export function setupMessageHandler(): void {
  botState.client.on(Events.MessageCreate, async (message) => {
    // Ignore bot messages
    if (message.author.bot) return;

    // Handle thread messages (existing logic)
    if (message.channel.isThread()) {
      await handleThreadMessage(message);
      return;
    }

    // Handle messages in project channels — bump the project dashboard
    const categoryManager = getCategoryManager();
    if (categoryManager) {
      const projectInfo = categoryManager.getProjectByChannelId(message.channel.id);
      if (projectInfo) {
        await handleProjectChannelMessage(message, projectInfo, categoryManager);
        return;
      }
    }

    // Handle main channel messages for assistant (new logic)
    // Check if assistant mode is 'all' (forward all messages) vs 'command' (only /assistant)
    if (config.assistant.mode !== 'all') return;

    await handleAssistantChannelMessage(message);
  });
}

/**
 * Handles messages in session threads
 */
async function handleThreadMessage(message: any): Promise<void> {
  // Find the session for this thread
  const allSessions = Object.values(storage.data.sessions);
  const session = allSessions.find(s => s.threadId === message.channel.id && s.status === 'active');

  if (!session) {
    const attachments = message.attachments.map((att: any) => ({
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
  const attachments = message.attachments.map((att: any) => ({
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
}

/**
 * Handles messages in project channels
 */
async function handleProjectChannelMessage(
  message: any,
  projectInfo: { runnerId: string; projectPath: string },
  categoryManager: any
): Promise<void> {
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
}

/**
 * Handles messages in assistant-enabled channels
 */
async function handleAssistantChannelMessage(message: any): Promise<void> {
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
}

/**
 * Sets up all event handlers at once
 */
export function setupAllEventHandlers(reconcileRunnerCategories: () => Promise<void>): void {
  setupReadyHandler(reconcileRunnerCategories);
  setupInteractionHandler();
  setupMessageHandler();
}
