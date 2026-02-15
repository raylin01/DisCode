/**
 * Codex Commands
 *
 * List and resume Codex CLI threads.
 */

import { ChatInputCommandInteraction, EmbedBuilder, ChannelType } from 'discord.js';
import { randomUUID } from 'crypto';
import { storage } from '../../storage.js';
import * as botState from '../../state.js';
import { createErrorEmbed, createInfoEmbed, createSuccessEmbed } from '../../utils/embeds.js';
import { buildSessionStartOptions } from '../../utils/session-options.js';
import { getOrCreateRunnerChannel } from '../../utils/channels.js';
import type { RunnerInfo } from '../../../../shared/types.js';

function resolveCodexRunner(userId: string, runnerId?: string | null): RunnerInfo | null {
    if (runnerId) {
        const runner = storage.getRunner(runnerId);
        if (!runner || !storage.canUserAccessRunner(userId, runnerId)) return null;
        return runner;
    }

    const candidates = storage.getUserRunners(userId)
        .filter(r => r.status === 'online' && r.cliTypes.includes('codex'));
    return candidates[0] || null;
}

export async function handleCodexThreads(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
    const runnerId = interaction.options.getString('runner');
    const archived = interaction.options.getBoolean('archived') ?? null;
    const limit = interaction.options.getInteger('limit') ?? 10;

    const runner = resolveCodexRunner(userId, runnerId);
    if (!runner) {
        await interaction.reply({
            embeds: [createErrorEmbed('Runner Not Found', 'No accessible online Codex runner found.')],
            flags: 64
        });
        return;
    }

    if (!runner.cliTypes.includes('codex')) {
        await interaction.reply({
            embeds: [createErrorEmbed('Unsupported', 'Selected runner does not support Codex CLI.')],
            flags: 64
        });
        return;
    }

    const ws = botState.runnerConnections.get(runner.runnerId);
    if (!ws) {
        await interaction.reply({
            embeds: [createErrorEmbed('Runner Offline', 'Runner is not connected.')],
            flags: 64
        });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    const requestId = `codex_threads_${runner.runnerId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const data = await new Promise<any | null>((resolve) => {
        const timeout = setTimeout(() => {
            botState.pendingCodexThreadListRequests.delete(requestId);
            resolve(null);
        }, 10000);
        botState.pendingCodexThreadListRequests.set(requestId, { resolve, timeout });
        ws.send(JSON.stringify({
            type: 'codex_thread_list_request',
            data: {
                runnerId: runner.runnerId,
                requestId,
                limit,
                archived
            }
        }));
    });

    if (!data) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Timeout', 'Runner did not respond in time.')]
        });
        return;
    }

    if (data.error) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Codex Error', data.error)]
        });
        return;
    }

    const threads = Array.isArray(data.threads) ? data.threads : [];
    if (threads.length === 0) {
        await interaction.editReply({
            embeds: [createInfoEmbed('No Threads', 'No Codex threads found on this runner.')]
        });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle(`Codex Threads (${runner.name})`)
        .setDescription('Use `/resume-codex thread:<id>` to resume a thread.');

    threads.slice(0, 10).forEach((thread: any, index: number) => {
        const preview = typeof thread.preview === 'string' ? thread.preview : '';
        const cwd = typeof thread.cwd === 'string' ? thread.cwd : 'Unknown';
        const updated = thread.updatedAt ? new Date(thread.updatedAt * 1000).toLocaleString() : 'Unknown';
        embed.addFields({
            name: `Thread ${index + 1}`,
            value: `ID: \`${thread.id}\`\nUpdated: ${updated}\nCWD: \`${cwd}\`\nPreview: ${preview.substring(0, 120) || 'N/A'}`,
            inline: false
        });
    });

    await interaction.editReply({ embeds: [embed] });
}

export async function handleResumeCodex(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
    const threadId = interaction.options.getString('thread', true);
    const runnerId = interaction.options.getString('runner');
    const customCwd = interaction.options.getString('cwd');

    const cached = botState.codexThreadCache.get(threadId);
    const resolvedRunner = resolveCodexRunner(userId, runnerId || cached?.runnerId || null);

    if (!resolvedRunner) {
        await interaction.reply({
            embeds: [createErrorEmbed('Runner Not Found', 'No accessible online Codex runner found.')],
            flags: 64
        });
        return;
    }

    if (!resolvedRunner.cliTypes.includes('codex')) {
        await interaction.reply({
            embeds: [createErrorEmbed('Unsupported', 'Selected runner does not support Codex CLI.')],
            flags: 64
        });
        return;
    }

    const ws = botState.runnerConnections.get(resolvedRunner.runnerId);
    if (!ws) {
        await interaction.reply({
            embeds: [createErrorEmbed('Runner Offline', 'Runner is not connected.')],
            flags: 64
        });
        return;
    }

    const folderPath = customCwd || cached?.cwd || resolvedRunner.defaultWorkspace;
    if (!folderPath) {
        await interaction.reply({
            embeds: [createErrorEmbed('Missing CWD', 'Please provide a working directory with the `cwd` option.')],
            flags: 64
        });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId;
    if (!guildId) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Missing Guild', 'Cannot determine guild ID for this command.')]
        });
        return;
    }

    const channelId = resolvedRunner.privateChannelId
        ? resolvedRunner.privateChannelId
        : await getOrCreateRunnerChannel(resolvedRunner, guildId);

    const channel = await botState.client.channels.fetch(channelId);
    if (!channel || !('threads' in channel)) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Cannot Create Thread', 'Cannot access runner channel.')],
            flags: 64
        });
        return;
    }

    const thread = await (channel as any).threads.create({
        name: `CODEX-${Date.now()}`,
        type: ChannelType.PrivateThread,
        invitable: false,
        reason: 'Resume Codex thread'
    });

    await thread.members.add(interaction.user.id);
    for (const authUserId of resolvedRunner.authorizedUsers) {
        if (authUserId && authUserId !== interaction.user.id) {
            try {
                await thread.members.add(authUserId);
            } catch {
                // ignore
            }
        }
    }

    const sessionId = randomUUID();
    const session = {
        sessionId,
        runnerId: resolvedRunner.runnerId,
        channelId: channel.id,
        threadId: thread.id,
        createdAt: new Date().toISOString(),
        status: 'active' as const,
        cliType: 'codex' as const,
        plugin: 'codex-sdk' as const,
        folderPath,
        interactionToken: interaction.token,
        creatorId: interaction.user.id
    };

    storage.createSession(session);
    botState.actionItems.set(session.sessionId, []);

    const startOptions = buildSessionStartOptions(
        resolvedRunner,
        undefined,
        { resumeSessionId: threadId },
        'codex'
    );
    session.options = startOptions;
    storage.updateSession(session.sessionId, session);

    ws.send(JSON.stringify({
        type: 'session_start',
        data: {
            sessionId: session.sessionId,
            runnerId: resolvedRunner.runnerId,
            cliType: 'codex',
            plugin: 'codex-sdk',
            folderPath,
            resume: true,
            options: startOptions
        }
    }));

    await interaction.editReply({
        embeds: [createSuccessEmbed('Codex Session Started', `Resuming Codex thread \`${threadId}\` in <#${thread.id}>.`)]
    });
}
