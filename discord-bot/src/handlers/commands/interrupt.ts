/**
 * Interrupt Command Handler
 * 
 * Sends an interrupt signal (Ctrl+C) to the CLI session.
 */

import { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import * as botState from '../../state.js';
import { storage } from '../../storage.js';
import { createErrorEmbed } from '../../utils/embeds.js';

/**
 * Handle /interrupt command
 * Sends interrupt signal to the CLI session
 */
export async function handleInterrupt(
    interaction: ChatInputCommandInteraction,
    userId: string
): Promise<void> {
    const sessionIdOption = interaction.options.getString('session');
    const channelId = interaction.channelId;

    let session;

    if (sessionIdOption) {
        // Use specified session
        session = storage.getSession(sessionIdOption);
    } else {
        // Try to auto-detect from current thread
        const allSessions = Object.values(storage.data.sessions);
        session = allSessions.find(s =>
            s.threadId === channelId && s.status === 'active'
        );
    }

    if (!session) {
        await interaction.reply({
            embeds: [createErrorEmbed(
                'Session Not Found',
                sessionIdOption
                    ? `No active session found with ID: ${sessionIdOption}`
                    : 'No active session found in this thread. Use `/interrupt session:<id>` to specify.'
            )],
            flags: 64
        });
        return;
    }

    // Check access
    const runner = storage.getRunner(session.runnerId);
    if (!runner || !storage.canUserAccessRunner(userId, session.runnerId)) {
        await interaction.reply({
            embeds: [createErrorEmbed('Unauthorized', 'You do not have access to this session.')],
            flags: 64
        });
        return;
    }

    // Get WebSocket connection
    const ws = botState.runnerConnections.get(session.runnerId);
    if (!ws) {
        await interaction.reply({
            embeds: [createErrorEmbed('Runner Offline', 'The runner is not connected.')],
            flags: 64
        });
        return;
    }

    // Send interrupt command to runner
    ws.send(JSON.stringify({
        type: 'interrupt',
        data: {
            sessionId: session.sessionId,
            runnerId: session.runnerId
        }
    }));

    const embed = new EmbedBuilder()
        .setColor(0xFFA500)
        .setTitle('⚡ Interrupt Sent')
        .setDescription('Sent interrupt signal (Ctrl+C) to the CLI session.')
        .addFields(
            { name: 'Session', value: session.sessionId.slice(0, 8), inline: true },
            { name: 'Runner', value: runner.name, inline: true }
        )
        .setTimestamp();

    await interaction.reply({
        embeds: [embed],
        flags: 64
    });

    console.log(`[Interrupt] Sent interrupt to session ${session.sessionId}`);
}
