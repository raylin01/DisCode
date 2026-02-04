/**
 * Terminal Command Handlers
 * 
 * Handlers for terminal watch commands.
 */

import { EmbedBuilder } from 'discord.js';
import * as botState from '../../state.js';
import { storage } from '../../storage.js';
import { createErrorEmbed, createInfoEmbed } from '../../utils/embeds.js';
import type { RunnerInfo, Session } from '../../../../shared/types.ts';

/**
 * Handle /terminals command
 */
export async function handleTerminals(interaction: any, userId: string): Promise<void> {
    const runnerId = interaction.options.getString('runner');

    if (runnerId) {
        const runner = storage.getRunner(runnerId);
        if (!runner || !storage.canUserAccessRunner(userId, runnerId)) {
            await interaction.reply({
                embeds: [createErrorEmbed('Access Denied', 'Runner not found or you do not have permission.')],
                flags: 64
            });
            return;
        }

        const ws = botState.runnerConnections.get(runnerId);
        if (!ws) {
            await interaction.reply({
                embeds: [createErrorEmbed('Runner Offline', 'Runner is currently offline.')],
                flags: 64
            });
            return;
        }

        // Store request info to update response when we get terminal list
        botState.pendingTerminalListRequests.set(runnerId, {
            interactionToken: interaction.token,
            applicationId: interaction.applicationId,
            runnerName: runner.name,
            requestedAt: Date.now()
        });

        ws.send(JSON.stringify({
            type: 'list_terminals',
            data: { runnerId }
        }));

        await interaction.reply({
            content: `🔄 Requesting terminal list from \`${runner.name}\`...`,
            flags: 64
        });
        return;
    }

    const runners = storage.getUserRunners(userId).filter(r => r.status === 'online');

    if (runners.length === 0) {
        await interaction.reply({
            embeds: [createErrorEmbed('No Online Runners', 'No online runners found to list terminals from.')],
            flags: 64
        });
        return;
    }

    if (runners.length > 1) {
        await interaction.reply({
            embeds: [createInfoEmbed('Multiple Runners', 'Please specify a runner using the `runner` option.')],
            flags: 64
        });
        return;
    }

    const runner = runners[0];
    const ws = botState.runnerConnections.get(runner.runnerId);
    if (!ws) {
        await interaction.reply({
            embeds: [createErrorEmbed('Runner Offline', 'Runner is currently offline.')],
            flags: 64
        });
        return;
    }

    // Store request info to update response when we get terminal list
    botState.pendingTerminalListRequests.set(runner.runnerId, {
        interactionToken: interaction.token,
        applicationId: interaction.applicationId,
        runnerName: runner.name,
        requestedAt: Date.now()
    });

    ws.send(JSON.stringify({
        type: 'list_terminals',
        data: { runnerId: runner.runnerId }
    }));

    await interaction.reply({
        content: `🔄 Requesting terminal list from \`${runner.name}\`...`,
        flags: 64
    });
}

/**
 * Handle /watch command
 */
export async function handleWatch(interaction: any, userId: string): Promise<void> {
    const sessionId = interaction.options.getString('session');
    const runnerId = interaction.options.getString('runner');

    if (!sessionId) {
        await interaction.reply({
            embeds: [createErrorEmbed('Missing Session', 'Please specify the session ID (e.g., tmux session name).')],
            flags: 64
        });
        return;
    }

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
        // 1. Try to detect runner from current channel
        const allRunners = storage.getUserRunners(userId);
        const channelRunner = allRunners.find(r => r.privateChannelId === interaction.channelId);

        if (channelRunner && channelRunner.status === 'online') {
            targetRunner = channelRunner;
        } else {
            // 2. Fallback to default logic
            const onlineRunners = allRunners.filter(r => r.status === 'online');
            if (onlineRunners.length === 1) {
                targetRunner = onlineRunners[0];
            } else if (onlineRunners.length === 0) {
                await interaction.reply({
                    embeds: [createErrorEmbed('No Runners online', 'You need an online runner to watch sessions.')],
                    flags: 64
                });
                return;
            } else {
                await interaction.reply({
                    embeds: [createInfoEmbed('Multiple Runners', 'Please specify which runner to use with the `runner` option, or run this command in a runner\'s channel.')],
                    flags: 64
                });
                return;
            }
        }
    }

    if (!targetRunner) return;

    const ws = botState.runnerConnections.get(targetRunner.runnerId);
    if (!ws) {
        await interaction.reply({
            embeds: [createErrorEmbed('Runner Offline', 'Runner is currently offline.')],
            flags: 64
        });
        return;
    }

    // Check if already watching
    const existingSession = storage.getSession(sessionId);
    if (existingSession && existingSession.status === 'active') {
        await interaction.reply({
            embeds: [createErrorEmbed('Already Watching', `Session \`${sessionId}\` is already being watched/active.`)],
            flags: 64
        });
        return;
    }

    // Check if there's an ended session we can reactivate
    if (existingSession && existingSession.status === 'ended') {
        try {
            const existingThread = await botState.client.channels.fetch(existingSession.threadId);
            if (existingThread && 'setArchived' in existingThread) {
                await existingThread.setArchived(false);

                existingSession.status = 'active';
                storage.updateSession(existingSession.sessionId, { status: 'active' });
                botState.sessionStatuses.set(sessionId, 'idle');

                if ('members' in existingThread) {
                    await existingThread.members.add(userId);
                }

                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle('Session Reactivated')
                    .setDescription(`Reconnected to tmux session \`${sessionId}\` on \`${targetRunner.name}\``)
                    .setTimestamp();

                await existingThread.send({
                    content: `<@${userId}>`,
                    embeds: [embed]
                });

                ws.send(JSON.stringify({
                    type: 'watch_terminal',
                    data: { sessionId: sessionId }
                }));

                await interaction.reply({
                    content: `Reactivated watch on \`${sessionId}\`. Check <#${existingSession.threadId}>`,
                    flags: 64
                });

                return;
            }
        } catch (e) {
            console.log(`Could not reactivate thread for ${sessionId}, will create new one:`, e);
        }
    }

    // Create new thread
    let channelId = targetRunner.privateChannelId;

    if (!channelId) {
        await interaction.reply({
            embeds: [createErrorEmbed('Setup Error', 'Runner has no private channel.')],
            flags: 64
        });
        return;
    }

    try {
        const channel = await botState.client.channels.fetch(channelId);
        if (!channel || !('threads' in channel)) {
            throw new Error("Invalid runner channel");
        }

        const thread = await channel.threads.create({
            name: `📺 ${sessionId}`,
            autoArchiveDuration: 60,
            reason: `Watching tmux session ${sessionId}`
        } as any);

        const session: Session = {
            sessionId: sessionId,
            runnerId: targetRunner.runnerId,
            channelId: channelId,
            threadId: thread.id,
            createdAt: new Date().toISOString(),
            status: 'active',
            cliType: 'claude',
            plugin: 'tmux',  // Watched sessions use tmux plugin
            folderPath: 'watched-session'
        };

        storage.createSession(session);
        botState.sessionStatuses.set(sessionId, 'idle');

        await thread.members.add(userId);

        const embed = new EmbedBuilder()
            .setColor(0xFFFF00)
            .setTitle('Connecting to Session...')
            .setDescription(`Requesting attachment to tmux session \`${sessionId}\` on \`${targetRunner.name}\`...`)
            .setTimestamp();

        await thread.send({ embeds: [embed] });

        ws.send(JSON.stringify({
            type: 'watch_terminal',
            data: { sessionId: sessionId }
        }));

        await interaction.reply({
            content: `Started watching \`${sessionId}\`. Check <#${thread.id}>`,
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
