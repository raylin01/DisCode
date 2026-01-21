/**
 * Modal Submit Handlers
 * 
 * Handles all modal submissions from Discord UI.
 */

import { EmbedBuilder, ChannelType } from 'discord.js';
import { randomUUID } from 'crypto';
import * as botState from '../state.js';
import { storage } from '../storage.js';
import { createErrorEmbed } from '../utils/embeds.js';
import { getOrCreateRunnerChannel } from '../utils/channels.js';
import { handleSessionReview } from './buttons.js';
import type { Session } from '../../../shared/types.ts';

/**
 * Main modal submit dispatcher
 */
export async function handleModalSubmit(interaction: any): Promise<void> {
    const userId = interaction.user.id;
    const customId = interaction.customId;

    // Handle prompt modal
    if (customId.startsWith('prompt_modal_')) {
        await handlePromptModal(interaction, userId, customId);
        return;
    }

    // Handle modify approval modal
    if (customId.startsWith('modify_modal_')) {
        await handleModifyModal(interaction, userId, customId);
        return;
    }

    // Handle folder modal
    if (customId === 'session_folder_modal') {
        await handleFolderModal(interaction, userId);
        return;
    }
}

/**
 * Handle prompt modal submission
 */
async function handlePromptModal(interaction: any, userId: string, customId: string): Promise<void> {
    const sessionId = customId.replace('prompt_modal_', '');
    const prompt = interaction.fields.getTextInputValue('prompt_input');

    const session = storage.getSession(sessionId);
    if (!session || session.status !== 'active') {
        await interaction.reply({
            content: 'This session is no longer active.',
            flags: 64
        });
        return;
    }

    const runner = storage.getRunner(session.runnerId);
    if (!runner || !storage.canUserAccessRunner(userId, session.runnerId)) {
        await interaction.reply({
            content: 'You do not have permission to use this session.',
            flags: 64
        });
        return;
    }

    const ws = botState.runnerConnections.get(runner.runnerId);
    if (!ws) {
        await interaction.reply({
            content: 'Runner is not connected. Please wait for it to come back online.',
            flags: 64
        });
        return;
    }

    try {
        ws.send(JSON.stringify({
            type: 'user_message',
            data: {
                sessionId: session.sessionId,
                userId: userId,
                username: interaction.user.username,
                content: prompt,
                timestamp: new Date().toISOString()
            }
        }));

        await interaction.reply({
            content: '✅ Prompt sent to CLI! Check the thread for output.',
            flags: 64
        });

        // Send embed in thread
        const thread = await botState.client.channels.fetch(session.threadId);
        if (thread && 'send' in thread) {
            const userMessageEmbed = new EmbedBuilder()
                .setColor(0x0099FF)
                .setTitle(`💬 Message from ${interaction.user.username}`)
                .setDescription(prompt.substring(0, 4000))
                .addFields(
                    { name: 'User', value: `<@${userId}>`, inline: true },
                    { name: 'Time', value: new Date().toLocaleString(), inline: true }
                )
                .setTimestamp();

            await thread.send({ embeds: [userMessageEmbed] });
        }

        console.log(`Sent prompt from ${interaction.user.username} to runner ${runner.name}`);
    } catch (error) {
        console.error('Error sending prompt to runner:', error);
        await interaction.reply({
            content: 'Failed to send prompt to runner. Please try again.',
            flags: 64
        });
    }
}

/**
 * Handle modify approval modal submission
 */
async function handleModifyModal(interaction: any, userId: string, customId: string): Promise<void> {
    const requestId = customId.replace('modify_modal_', '');
    const modifiedInput = interaction.fields.getTextInputValue('modified_input');

    const pending = botState.pendingApprovals.get(requestId);
    if (!pending) {
        await interaction.reply({
            embeds: [createErrorEmbed('Expired', 'This approval request has expired.')],
            flags: 64
        });
        return;
    }

    const runner = storage.getRunner(pending.runnerId);
    if (!runner || !storage.canUserAccessRunner(userId, pending.runnerId)) {
        await interaction.reply({
            embeds: [createErrorEmbed('Unauthorized', 'You are not authorized.')],
            flags: 64
        });
        return;
    }

    let modifiedToolInput: unknown;
    try {
        modifiedToolInput = JSON.parse(modifiedInput);
    } catch (error) {
        await interaction.reply({
            embeds: [createErrorEmbed('Invalid JSON', 'The modified input is not valid JSON.')],
            flags: 64
        });
        return;
    }

    const ws = botState.runnerConnections.get(pending.runnerId);
    if (ws) {
        ws.send(JSON.stringify({
            type: 'approval_response',
            data: {
                requestId,
                allow: true,
                message: 'Approved with modifications',
                modifiedToolInput
            }
        }));
    }

    await interaction.reply({
        content: '✅ Tool use approved with modified input.',
        flags: 64
    });

    botState.pendingApprovals.delete(requestId);
    console.log(`Approval request ${requestId} modified and approved by user ${userId}`);
}

/**
 * Handle folder modal submission (custom folder for session creation)
 */
async function handleFolderModal(interaction: any, userId: string): Promise<void> {
    const folderPath = interaction.fields.getTextInputValue('folder_path');

    const state = botState.sessionCreationState.get(userId);
    if (!state || !state.runnerId || !state.cliType) {
        await interaction.reply({
            embeds: [createErrorEmbed('Session Expired', 'Please start over with /create-session')],
            flags: 64
        });
        return;
    }

    // Use the custom folder path
    state.folderPath = folderPath;
    state.step = 'complete';
    botState.sessionCreationState.set(userId, state);

    // Proceed to Review Step
    await handleSessionReview(interaction, userId);
}
