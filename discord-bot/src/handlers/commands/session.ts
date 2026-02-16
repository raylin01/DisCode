/**
 * Session Command Handlers
 * 
 * Handlers for session-related commands including create, end, and status.
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import * as botState from '../../state.js';
import { buildSessionStartOptions } from '../../utils/session-options.js';
import { storage } from '../../storage.js';
import { createErrorEmbed, createInfoEmbed, createSuccessEmbed } from '../../utils/embeds.js';
import { getCategoryManager } from '../../services/category-manager.js';
import { getSessionSyncService } from '../../services/session-sync.js';
import { permissionStateStore } from '../../permissions/state-store.js';
import type { RunnerInfo, Session } from '../../../../shared/types.ts';

/**
 * Helper to add timeout to async operations
 * Returns null if timeout is reached
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T | null> {
    return Promise.race([
        promise,
        new Promise<null>(resolve => setTimeout(() => {
            console.warn(`[end-session] Timeout (${ms}ms) reached for: ${label}`);
            resolve(null);
        }, ms))
    ]);
}

async function resolveRunnerIdFromChannelContext(interaction: any, sourceChannel?: any): Promise<string | undefined> {
    const categoryManager = getCategoryManager();
    if (!categoryManager) return undefined;

    let channel = sourceChannel ?? interaction?.channel;
    if (!channel && interaction?.channelId) {
        try {
            channel = await interaction.client.channels.fetch(interaction.channelId);
        } catch (e) {
            return undefined;
        }
    }

    if (channel?.isThread?.()) {
        try {
            channel = channel.parent || (channel.parentId ? await interaction.client.channels.fetch(channel.parentId) : channel);
        } catch (e) {
            return undefined;
        }
    }

    if (!channel) return undefined;

    const byChannel = categoryManager.getRunnerByChannelId(channel.id);
    if (byChannel) return byChannel;

    if (channel.parentId) {
        const byCategory = categoryManager.getRunnerByCategoryId(channel.parentId);
        if (byCategory) return byCategory;
    }

    if (channel.parentId) {
        const fallbackRunner = Object.values(storage.data.runners).find(r => r.discordState?.categoryId === channel.parentId);
        if (fallbackRunner) return fallbackRunner.runnerId;
    }

    return undefined;
}

async function resolveProjectContext(interaction: any): Promise<{
    runnerId?: string;
    projectPath?: string;
    projectChannelId?: string;
}> {
    const categoryManager = getCategoryManager();
    if (!categoryManager) return {};

    let channel = interaction.channel;
    if (!channel || !channel.parentId) {
        try {
            channel = await interaction.client.channels.fetch(interaction.channelId);
        } catch (e) {
            return {};
        }
    }

    if (channel?.isThread()) {
        try {
            channel = channel.parent || (channel.parentId ? await interaction.client.channels.fetch(channel.parentId) : channel);
        } catch (e) {
            return {};
        }
    }

    if (!channel) return {};

    const projectInfo = categoryManager.getProjectByChannelId(channel.id);
    if (projectInfo) {
        return {
            runnerId: projectInfo.runnerId,
            projectPath: projectInfo.projectPath,
            projectChannelId: channel.id
        };
    }

    const runnerId = await resolveRunnerIdFromChannelContext(interaction, channel);
    if (!runnerId) return {};

    const runner = storage.getRunner(runnerId);
    const projectPath = Object.entries(runner?.discordState?.projects || {}).find(([, data]) => data.channelId === channel.id)?.[0];

    return {
        runnerId,
        ...(projectPath ? { projectPath } : {}),
        projectChannelId: channel.id
    };
}

/**
 * Handle /create-session command
 */
export async function handleCreateSession(interaction: any, userId: string): Promise<void> {
    // Clean up any existing state for this user
    if (botState.sessionCreationState.has(userId)) {
        botState.sessionCreationState.delete(userId);
    }

    const projectContext = await resolveProjectContext(interaction);

    // Get accessible online runners
    const allRunners = storage.getUserRunners(userId).filter(r => r.status === 'online');

    // Deduplicate runners by runnerId
    const runnersMap = new Map<string, RunnerInfo>();
    allRunners.forEach(runner => {
        runnersMap.set(runner.runnerId, runner);
    });

    let runners = Array.from(runnersMap.values());
    if (projectContext.runnerId) {
        const candidate = runnersMap.get(projectContext.runnerId);
        if (candidate && storage.canUserAccessRunner(userId, candidate.runnerId)) {
            runners = [candidate];
        }
    }

    if (runners.length === 0) {
        await interaction.reply({
            embeds: [createErrorEmbed('No Online Runners', 'No online runners available. Make sure your Runner Agent is connected.')],
            flags: 64
        });
        return;
    }

    // Check if we can auto-select the runner
    if (runners.length === 1) {
        const runner = runners[0];

        // Auto-select this runner
        botState.sessionCreationState.set(userId, {
            step: 'select_cli',
            runnerId: runner.runnerId,
            ...(projectContext.projectPath ? { folderPath: projectContext.projectPath } : {}),
            ...(projectContext.projectChannelId ? { projectChannelId: projectContext.projectChannelId } : {})
        });

        // Check if we can also auto-select the CLI type
        if (runner.cliTypes.length === 1) {
            const cliType = runner.cliTypes[0];
            const state = botState.sessionCreationState.get(userId)!;
            state.cliType = cliType;
            state.step = 'select_plugin';
            botState.sessionCreationState.set(userId, state);

            // Directly show plugin selection
            const pluginButtons: ButtonBuilder[] = [];
            if (cliType === 'claude') {
                pluginButtons.push(
                    new ButtonBuilder()
                        .setCustomId('session_plugin_claude-sdk')
                        .setLabel('Claude SDK')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('session_plugin_tmux')
                        .setLabel('Interactive (Tmux)')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('session_plugin_print')
                        .setLabel('Basic (Print)')
                        .setStyle(ButtonStyle.Secondary)
                );
            } else if (cliType === 'gemini') {
                pluginButtons.push(
                    new ButtonBuilder()
                        .setCustomId('session_plugin_gemini-sdk')
                        .setLabel('Gemini SDK')
                        .setStyle(ButtonStyle.Primary),
                    new ButtonBuilder()
                        .setCustomId('session_plugin_tmux')
                        .setLabel('Interactive (Tmux)')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('session_plugin_print')
                        .setLabel('Basic (Print)')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId('session_plugin_stream')
                        .setLabel('Stream Fallback')
                        .setStyle(ButtonStyle.Secondary)
                );
            } else if (cliType === 'codex') {
                pluginButtons.push(
                    new ButtonBuilder()
                        .setCustomId('session_plugin_codex-sdk')
                        .setLabel('Codex SDK')
                        .setStyle(ButtonStyle.Primary)
                );
            }

            const pluginButtonRow = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(...pluginButtons);

            // Row 2: Navigation buttons
            const navButtonRow = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('session_back_cli')
                        .setLabel('Back')
                        .setStyle(ButtonStyle.Secondary)
                        .setEmoji('◀️'),
                    new ButtonBuilder()
                        .setCustomId('session_cancel')
                        .setLabel('Cancel')
                        .setStyle(ButtonStyle.Danger)
                        .setEmoji('❌')
                );

            const embed = new EmbedBuilder()
                .setColor(0x00FF00)
                .setTitle('Select Plugin Type')
                .setDescription(`**Runner:** \`${runner.name}\`\n**CLI:** ${cliType.toUpperCase()}\n\nSelect how you want to interact with the CLI:`)
                .addFields(
                    { name: 'Interactive (Tmux)', value: 'Full terminal interaction with approval workflows', inline: false },
                    { name: 'Basic (Print)', value: 'Simple output logging, less interactive', inline: false },
                    {
                        name: cliType === 'gemini' ? 'Gemini SDK' : cliType === 'codex' ? 'Codex SDK' : 'Claude SDK',
                        value: 'Native SDK integration with persistent session resume support.',
                        inline: false
                    }
                );

            await interaction.reply({
                embeds: [embed],
                components: [pluginButtonRow, navButtonRow],
                flags: 64
            });
            return;
        }

        // Show CLI selection
        // Row 1: CLI type buttons + Terminal option
        const cliButtons = runner.cliTypes.map(cliType =>
            new ButtonBuilder()
                .setCustomId(`session_cli_${cliType}`)
                .setLabel(cliType.toUpperCase())
                .setStyle(ButtonStyle.Primary)
        );

        // Add Terminal option
        cliButtons.push(
            new ButtonBuilder()
                .setCustomId('session_cli_terminal')
                .setLabel('Terminal')
                .setStyle(ButtonStyle.Secondary)
        );

        const cliButtonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(...cliButtons);

        // Row 2: Navigation buttons
        const navButtonRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('session_back_runners')
                    .setLabel('Back')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('◀️'),
                new ButtonBuilder()
                    .setCustomId('session_cancel')
                    .setLabel('Cancel')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('❌')
            );

        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('Select CLI Type')
            .setDescription(`**Runner:** \`${runner.name}\`\n\nSelect the CLI tool to use:\n\n**Terminal** - Plain shell session (no AI CLI)`);

        await interaction.reply({
            embeds: [embed],
            components: [cliButtonRow, navButtonRow],
            flags: 64
        });
        return;
    }

    // Multiple runners - show selection
    botState.sessionCreationState.set(userId, {
        step: 'select_runner',
        ...(projectContext.projectPath ? { folderPath: projectContext.projectPath } : {}),
        ...(projectContext.projectChannelId ? { projectChannelId: projectContext.projectChannelId } : {})
    });

    // Row 1: Runner buttons
    const runnerButtons = runners.slice(0, 5).map(runner =>
        new ButtonBuilder()
            .setCustomId(`session_runner_${runner.runnerId}`)
            .setLabel(runner.name)
            .setStyle(ButtonStyle.Primary)
    );

    const runnerButtonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(...runnerButtons);

    // Row 2: Cancel button
    const navButtonRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('session_cancel')
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('❌')
        );

    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('Select a Runner')
        .setDescription('Which runner do you want to use for this session?');

    await interaction.reply({
        embeds: [embed],
        components: [runnerButtonRow, navButtonRow],
        flags: 64
    });
}

/**
 * Handle /status command
 */
export async function handleStatus(interaction: any, userId: string): Promise<void> {
    const runnerIdFilter = interaction.options.getString('runner');

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

        let statusEmoji = '🟢';
        let statusText = 'Ready';

        const currentStatus = botState.sessionStatuses.get(session.sessionId);
        const isWaitingForApproval = permissionStateStore.getBySessionId(session.sessionId).length > 0;

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

/**
 * Handle /end-session command
 */
export async function handleEndSession(interaction: any, userId: string): Promise<void> {
    // Defer the interaction immediately to prevent timeout
    await interaction.deferReply({ flags: 64 });

    const sessionId = interaction.options.getString('session');
    let targetSessionId: string | null = null;

    if (!sessionId) {
        const channel = interaction.channel;
        if (channel && channel.isThread()) {
            const sessionsInThread = storage.getSessionsByThreadId(channel.id);
            const session = sessionsInThread.find(s => s.status === 'active');

            if (session) {
                targetSessionId = session.sessionId;
            } else if (sessionsInThread.length > 0) {
                const latestSession = sessionsInThread[0];
                await interaction.editReply({
                    embeds: [createInfoEmbed(
                        'Session Already Ended',
                        `The most recent session in this thread (\`${latestSession.sessionId}\`) is already ended.`
                    )]
                });
                return;
            }

            if (!targetSessionId) {
                const syncedEntry = getSessionSyncService()?.getSessionByThreadId(channel.id);
                if (syncedEntry) {
                    await interaction.editReply({
                        embeds: [createInfoEmbed(
                            'No Active Discord Session',
                            'This is a synced thread. Use `/resume` to take control before using `/end-session`.'
                        )]
                    });
                    return;
                }
            }
        }

        if (!targetSessionId) {
            await interaction.editReply({
                embeds: [createInfoEmbed('No Session Found', 'Please run this command from a session thread or specify a session ID.')]
            });
            return;
        }
    } else {
        targetSessionId = sessionId;
    }

    const session = storage.getSession(targetSessionId);
    if (!session) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Session Not Found', `Session \`${targetSessionId}\` not found.`)]
        });
        return;
    }

    let runner = storage.getRunner(session.runnerId);
    if (!runner) {
        const fallbackRunnerId = await resolveRunnerIdFromChannelContext(interaction, interaction.channel);
        if (fallbackRunnerId) {
            const fallbackRunner = storage.getRunner(fallbackRunnerId);
            if (fallbackRunner) {
                runner = fallbackRunner;
                session.runnerId = fallbackRunner.runnerId;
                storage.updateSession(session.sessionId, { runnerId: fallbackRunner.runnerId });
            }
        }
    }

    if (!runner || !storage.canUserAccessRunner(userId, session.runnerId)) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Access Denied', 'You do not have permission to end this session.')]
        });
        return;
    }

    if (session.status !== 'active') {
        await interaction.editReply({
            embeds: [createInfoEmbed('Session Already Ended', `Session \`${targetSessionId}\` is already ended.`)]
        });
        return;
    }

    // End the session
    const runnerNotified = await endSessionWithCleanup(targetSessionId, userId, interaction.user.id);

    await interaction.editReply({
        embeds: [createSuccessEmbed(
            'Session Ended',
            runnerNotified
                ? `Session \`${targetSessionId}\` has been ended and the thread archived.`
                : `Session \`${targetSessionId}\` was ended locally and the thread archived (runner was offline).`
        )]
    });
}

/**
 * End a session with full cleanup: notify runner, remove user, archive thread
 */
async function endSessionWithCleanup(sessionId: string, userId: string, discordUserId: string): Promise<boolean> {
    const session = storage.getSession(sessionId);
    if (!session) return false;

    // 1. Notify runner to stop watching
    let runnerNotified = false;
    const ws = botState.runnerConnections.get(session.runnerId);
    if (ws) {
        ws.send(JSON.stringify({
            type: 'session_end',
            data: { sessionId }
        }));
        runnerNotified = true;
    }

    // 2. Update session status
    session.status = 'ended';
    storage.updateSession(session.sessionId, session);

    // 3. Clean up bot state
    botState.sessionStatuses.delete(sessionId);
    botState.streamingMessages.delete(sessionId);
    botState.allowedTools.delete(sessionId);
    botState.actionItems.delete(sessionId);

    // Update stats non-blocking (fire and forget) to avoid slowing down the command
    getCategoryManager()?.updateRunnerStats(session.runnerId).catch(err => {
        console.warn(`[end-session] Failed to update runner stats:`, err.message);
    });

    console.log(`Session ${sessionId} ended by ${userId}`);

    // 4. Archive the thread (with user removal and final message)
    // Use timeouts to prevent hanging on slow Discord API calls
    const THREAD_OP_TIMEOUT = 5000; // 5 seconds per operation

    try {
        const thread = await withTimeout(
            botState.client.channels.fetch(session.threadId),
            THREAD_OP_TIMEOUT,
            'fetch thread'
        );

        if (thread && thread.isThread()) {
            // Send final message
            const embed = new EmbedBuilder()
                .setColor(0xFF6600)
                .setTitle('Session Ended')
                .setDescription(`Session ended by <@${discordUserId}>`)
                .setTimestamp();

            const sendResult = await withTimeout(
                thread.send({ embeds: [embed] }),
                THREAD_OP_TIMEOUT,
                'send end message'
            );

            if (sendResult) {
                console.log(`Sent end message to thread ${session.threadId}`);
            }

            // Remove the user from the thread
            try {
                await withTimeout(
                    thread.members.remove(discordUserId) as Promise<any>,
                    THREAD_OP_TIMEOUT,
                    'remove user from thread'
                );
                console.log(`Removed user ${discordUserId} from thread ${session.threadId}`);
            } catch (removeError: any) {
                // This may fail if user isn't in the thread, which is fine
                console.log(`Could not remove user from thread: ${removeError?.message || removeError}`);
            }

            // Archive the thread
            const archiveResult = await withTimeout(
                thread.setArchived(true) as Promise<any>,
                THREAD_OP_TIMEOUT,
                'archive thread'
            );

            if (archiveResult) {
                console.log(`Archived thread ${session.threadId}`);
            }
        } else if (thread === null) {
            console.warn(`[end-session] Timed out fetching thread ${session.threadId}`);
        }
    } catch (error) {
        console.error(`Failed to cleanup thread for session ${sessionId}:`, error);
    }

    return runnerNotified;
}

/**
 * End a session and cleanup (legacy function for backward compatibility)
 */
export async function endSession(sessionId: string, userId: string): Promise<boolean> {
    return endSessionWithCleanup(sessionId, userId, userId);
}

/**
 * Handle /unwatch command (alias for end-session)
 */
export async function handleUnwatch(interaction: any, userId: string): Promise<void> {
    await handleEndSession(interaction, userId);
}

/**
 * Handle /respawn-session command
 * Respawns a session in a dead thread using the same settings
 */
export async function handleRespawnSession(interaction: any, userId: string): Promise<void> {
    const channel = interaction.channel;

    // Must be in a thread
    if (!channel || !channel.isThread()) {
        await interaction.reply({
            embeds: [createErrorEmbed('Not in Thread', 'This command must be run inside a session thread.')],
            flags: 64
        });
        return;
    }

    // Find previous sessions for this thread
    const previousSessions = storage.getSessionsByThreadId(channel.id);

    if (previousSessions.length === 0) {
        await interaction.reply({
            embeds: [createErrorEmbed('No Previous Session', 'No previous session found for this thread. This thread was not created by DisCode.')],
            flags: 64
        });
        return;
    }

    // Get the most recent session
    const lastSession = previousSessions[0];

    // Check if there's already an active session
    if (lastSession.status === 'active') {
        await interaction.reply({
            embeds: [createInfoEmbed('Session Already Active', `This thread already has an active session. Use \`/end-session\` first if you want to restart.`)],
            flags: 64
        });
        return;
    }

    // Get the runner
    let runner = storage.getRunner(lastSession.runnerId);
    if (!runner) {
        const fallbackRunnerId = await resolveRunnerIdFromChannelContext(interaction, channel);
        if (fallbackRunnerId) {
            const fallbackRunner = storage.getRunner(fallbackRunnerId);
            if (fallbackRunner) {
                runner = fallbackRunner;
                lastSession.runnerId = fallbackRunner.runnerId;
                storage.updateSession(lastSession.sessionId, { runnerId: fallbackRunner.runnerId });
            }
        }
    }

    if (!runner) {
        await interaction.reply({
            embeds: [createErrorEmbed('Runner Not Found', `The runner used for this session (${lastSession.runnerId}) no longer exists.`)],
            flags: 64
        });
        return;
    }

    // Check runner is online
    if (runner.status !== 'online') {
        await interaction.reply({
            embeds: [createErrorEmbed('Runner Offline', `Runner \`${runner.name}\` is currently offline. Please wait for it to reconnect.`)],
            flags: 64
        });
        return;
    }

    // Check user has access
    if (!storage.canUserAccessRunner(userId, runner.runnerId)) {
        await interaction.reply({
            embeds: [createErrorEmbed('Access Denied', 'You do not have access to this runner.')],
            flags: 64
        });
        return;
    }

    // Get websocket connection
    const ws = botState.runnerConnections.get(runner.runnerId);
    if (!ws) {
        await interaction.reply({
            embeds: [createErrorEmbed('Connection Error', 'Could not connect to runner. Please try again.')],
            flags: 64
        });
        return;
    }

    // Create new session with same settings
    const crypto = await import('crypto');
    const newSessionId = crypto.randomUUID();

    const newSession: Session = {
        sessionId: newSessionId,
        runnerId: runner.runnerId,
        channelId: lastSession.channelId,
        threadId: channel.id,  // Reuse existing thread
        createdAt: new Date().toISOString(),
        status: 'active',
        cliType: lastSession.cliType,
        plugin: lastSession.plugin,  // Preserve plugin type from original session
        folderPath: lastSession.folderPath,
        interactionToken: interaction.token,
        creatorId: userId
    };

    storage.createSession(newSession);

    if (lastSession.cliType === 'claude' || lastSession.cliType === 'codex') {
        getSessionSyncService()?.markSessionAsOwned(newSessionId, lastSession.cliType);
        console.log(`[Respawn] Marked session as owned for sync suppression: ${lastSession.cliType}:${newSessionId}`);
    }

    // Send initializing message
    await interaction.reply({
        embeds: [createInfoEmbed(
            '🔄 Respawning Session...',
            `**Runner:** \`${runner.name}\`\n**CLI:** ${lastSession.cliType.toUpperCase()}\n**Folder:** \`${lastSession.folderPath || runner.defaultWorkspace || '~'}\`\n\nInitializing...`
        )]
    });

    // Notify runner to start session
    const startOptions = buildSessionStartOptions(runner, undefined, undefined, lastSession.cliType);
    newSession.options = startOptions;
    storage.updateSession(newSessionId, newSession);

    ws.send(JSON.stringify({
        type: 'session_start',
        data: {
            sessionId: newSessionId,
            runnerId: runner.runnerId,
            cliType: lastSession.cliType,
            plugin: lastSession.plugin,  // Include plugin type from original session
            folderPath: lastSession.folderPath,
            options: startOptions
        }
    }));

    console.log(`Respawned session ${newSessionId} in thread ${channel.id} (previous: ${lastSession.sessionId})`);
}
