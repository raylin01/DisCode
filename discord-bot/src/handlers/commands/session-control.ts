/**
 * Session Control Command Handlers
 *
 * Provides commands for per-session control (model, permission mode, thinking tokens).
 */

import { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import * as botState from '../../state.js';
import { storage } from '../../storage.js';
import { createErrorEmbed } from '../../utils/embeds.js';

async function resolveSession(interaction: ChatInputCommandInteraction) {
    const sessionIdOption = interaction.options.getString('session');
    const channelId = interaction.channelId;

    if (sessionIdOption) {
        return storage.getSession(sessionIdOption);
    }

    const allSessions = Object.values(storage.data.sessions);
    return allSessions.find(s => s.threadId === channelId && s.status === 'active');
}

async function sendSessionControl(
    interaction: ChatInputCommandInteraction,
    userId: string,
    action: 'set_model' | 'set_permission_mode' | 'set_max_thinking_tokens',
    value: string | number
): Promise<void> {
    const session = await resolveSession(interaction);
    if (!session) {
        await interaction.reply({
            embeds: [createErrorEmbed(
                'Session Not Found',
                'No active session found in this thread. Use `/set-model session:<id>` or `/set-permission-mode session:<id>`.'
            )],
            flags: 64
        });
        return;
    }

    const runner = storage.getRunner(session.runnerId);
    if (!runner || !storage.canUserAccessRunner(userId, session.runnerId)) {
        await interaction.reply({
            embeds: [createErrorEmbed('Unauthorized', 'You do not have access to this session.')],
            flags: 64
        });
        return;
    }

    const ws = botState.runnerConnections.get(session.runnerId);
    if (!ws) {
        await interaction.reply({
            embeds: [createErrorEmbed('Runner Offline', 'The runner is not connected.')],
            flags: 64
        });
        return;
    }

    ws.send(JSON.stringify({
        type: 'session_control',
        data: {
            runnerId: session.runnerId,
            sessionId: session.sessionId,
            action,
            value
        }
    }));

    const embed = new EmbedBuilder()
        .setColor(0x4C9AFF)
        .setTitle('Session Control Sent')
        .addFields(
            { name: 'Action', value: action, inline: true },
            { name: 'Value', value: String(value), inline: true },
            { name: 'Session', value: session.sessionId.slice(0, 8), inline: true }
        )
        .setTimestamp();

    if (session.plugin && session.plugin !== 'claude-sdk') {
        embed.setDescription('⚠️ This control is only supported on `claude-sdk` sessions. Other plugins may ignore it.');
    }

    await interaction.reply({
        embeds: [embed],
        flags: 64
    });
}

export async function handleSetModel(
    interaction: ChatInputCommandInteraction,
    userId: string
): Promise<void> {
    const model = interaction.options.getString('model', true);
    await sendSessionControl(interaction, userId, 'set_model', model);
}

export async function handleSetPermissionMode(
    interaction: ChatInputCommandInteraction,
    userId: string
): Promise<void> {
    const mode = interaction.options.getString('mode', true) as 'default' | 'acceptEdits';
    await sendSessionControl(interaction, userId, 'set_permission_mode', mode);
}

export async function handleSetThinkingTokens(
    interaction: ChatInputCommandInteraction,
    userId: string
): Promise<void> {
    const tokens = interaction.options.getInteger('max_tokens', true);
    await sendSessionControl(interaction, userId, 'set_max_thinking_tokens', tokens);
}
