/**
 * Assistant Command Handler
 * 
 * Handles the /assistant slash command to send messages to the runner assistant.
 */

import type { ChatInputCommandInteraction } from 'discord.js';
import * as botState from '../../state.js';
import { storage } from '../../storage.js';

/**
 * Handle /assistant command
 */
export async function handleAssistantCommand(
    interaction: ChatInputCommandInteraction,
    userId: string
): Promise<void> {
    const messageContent = interaction.options.getString('message', true);
    const runnerIdArg = interaction.options.getString('runner');

    // Defer reply for processing
    await interaction.deferReply({ flags: 64 });

    // Find the runner - either specified or from current channel
    let runner;
    if (runnerIdArg) {
        runner = storage.getRunner(runnerIdArg);
    } else {
        // Try to find runner from current channel
        const allRunners = Object.values(storage.data.runners);
        runner = allRunners.find(r =>
            r.privateChannelId === interaction.channelId &&
            r.status === 'online'
        );
    }

    if (!runner) {
        await interaction.editReply({
            content: '❌ No runner found. Please specify a runner ID or use this command in a runner channel.'
        });
        return;
    }

    if (runner.status !== 'online') {
        await interaction.editReply({
            content: `❌ Runner \`${runner.name}\` is offline.`
        });
        return;
    }

    // Check access
    if (!storage.canUserAccessRunner(userId, runner.runnerId)) {
        await interaction.editReply({
            content: '❌ You do not have access to this runner.'
        });
        return;
    }

    // Check if assistant is enabled
    if (!runner.assistantEnabled) {
        await interaction.editReply({
            content: '❌ Assistant is not enabled for this runner.'
        });
        return;
    }

    // Get WebSocket connection
    const ws = botState.runnerConnections.get(runner.runnerId);
    if (!ws) {
        await interaction.editReply({
            content: '❌ Runner is not connected.'
        });
        return;
    }

    // Send message to assistant
    ws.send(JSON.stringify({
        type: 'assistant_message',
        data: {
            runnerId: runner.runnerId,
            userId: userId,
            username: interaction.user.username,
            content: messageContent,
            timestamp: new Date().toISOString()
        }
    }));

    // Clear streaming message state so next output is a new message
    botState.assistantStreamingMessages.delete(runner.runnerId);

    await interaction.editReply({
        content: `✅ Message sent to assistant on \`${runner.name}\`. Check the channel for the response.`
    });
}
