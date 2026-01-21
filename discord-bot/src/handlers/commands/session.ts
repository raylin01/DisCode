/**
 * Session Command Handlers
 * 
 * Handlers for session-related commands including create, end, and status.
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import * as botState from '../../state.js';
import { storage } from '../../storage.js';
import { createErrorEmbed, createInfoEmbed, createSuccessEmbed } from '../../utils/embeds.js';
import type { RunnerInfo, Session } from '../../../../shared/types.ts';

/**
 * Handle /create-session command
 */
export async function handleCreateSession(interaction: any, userId: string): Promise<void> {
    // Clean up any existing state for this user
    if (botState.sessionCreationState.has(userId)) {
        botState.sessionCreationState.delete(userId);
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

    // Check if we can auto-select the runner
    if (runners.length === 1) {
        const runner = runners[0];

        // Auto-select this runner
        botState.sessionCreationState.set(userId, {
            step: 'select_cli',
            runnerId: runner.runnerId
        });

        // Check if we can also auto-select the CLI type
        if (runner.cliTypes.length === 1) {
            const cliType = runner.cliTypes[0];
            const state = botState.sessionCreationState.get(userId)!;
            state.cliType = cliType;
            state.step = 'select_plugin';
            botState.sessionCreationState.set(userId, state);

            // Directly show plugin selection
            // Row 1: Plugin buttons
            const pluginButtonRow = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId('session_plugin_tmux')
                        .setLabel('Interactive (Tmux)')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId('session_plugin_print')
                        .setLabel('Basic (Print)')
                        .setStyle(ButtonStyle.Secondary)
                );

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
                    { name: 'Basic (Print)', value: 'Simple output logging, less interactive', inline: false }
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
        step: 'select_runner'
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
        const isWaitingForApproval = Array.from(botState.pendingApprovals.values()).some(p => p.sessionId === session.sessionId);

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
    const sessionId = interaction.options.getString('session');
    let targetSessionId: string | null = null;

    if (!sessionId) {
        const channel = interaction.channel;
        if (channel && channel.isThread()) {
            const allSessions = Object.values(storage.data.sessions);
            const session = allSessions.find(s => s.threadId === channel.id && s.status === 'active');

            if (session) {
                targetSessionId = session.sessionId;
            }
        }

        if (!targetSessionId) {
            await interaction.reply({
                embeds: [createInfoEmbed('No Session Found', 'Please run this command from a session thread or specify a session ID.')],
                flags: 64
            });
            return;
        }
    } else {
        targetSessionId = sessionId;
    }

    const session = storage.getSession(targetSessionId);
    if (!session) {
        await interaction.reply({
            embeds: [createErrorEmbed('Session Not Found', `Session \`${targetSessionId}\` not found.`)],
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

    await endSession(targetSessionId, userId);

    await interaction.reply({
        embeds: [createSuccessEmbed('Session Ended', `Session \`${targetSessionId}\` has been ended and the thread archived.`)],
        flags: 64
    });
}

/**
 * End a session and cleanup
 */
export async function endSession(sessionId: string, userId: string): Promise<void> {
    const session = storage.getSession(sessionId);
    if (!session) return;

    // Notify runner to stop watching
    const ws = botState.runnerConnections.get(session.runnerId);
    if (ws) {
        ws.send(JSON.stringify({
            type: 'session_end',
            data: { sessionId }
        }));
    }

    // Update session status
    session.status = 'ended';
    storage.updateSession(session.sessionId, session);

    // Clean up state
    botState.sessionStatuses.delete(sessionId);
    botState.streamingMessages.delete(sessionId);
    botState.allowedTools.delete(sessionId);
    botState.actionItems.delete(sessionId);

    // Archive the thread
    try {
        const thread = await botState.client.channels.fetch(session.threadId);
        if (thread && thread.isThread()) {
            const embed = new EmbedBuilder()
                .setColor(0xFF6600)
                .setTitle('Session Ended')
                .setDescription(`Session ended by <@${userId}>`)
                .setTimestamp();

            await thread.send({ embeds: [embed] });
            await thread.setArchived(true);
        }
    } catch (error) {
        console.error(`Failed to archive thread for session ${sessionId}:`, error);
    }

    console.log(`Session ${sessionId} ended by ${userId}`);
}

/**
 * Handle /unwatch command (alias for end-session)
 */
export async function handleUnwatch(interaction: any, userId: string): Promise<void> {
    await handleEndSession(interaction, userId);
}
