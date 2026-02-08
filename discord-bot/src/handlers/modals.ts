/**
 * Modal Submit Handlers
 * 
 * Handles all modal submissions from Discord UI.
 */

import { EmbedBuilder, ChannelType, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { randomUUID } from 'crypto';
import * as botState from '../state.js';
import { storage } from '../storage.js';
import { createErrorEmbed } from '../utils/embeds.js';
import { getOrCreateRunnerChannel } from '../utils/channels.js';
import { handleSessionReview } from './buttons.js';
import { handleTellClaudeModal } from './permission-buttons.js';
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

    // Handle "Tell Claude" modal logic (unified)
    if (customId.startsWith('tell_modal_')) {
        await handleUnifiedTellClaudeModal(interaction, userId, customId);
        return;
    }

    // Handle "Other" modal for custom input
    if (customId.startsWith('other_modal_')) {
        await handleOtherModal(interaction, userId, customId);
        return;
    }

    // Handle "Tell Claude" modal for custom rejection message
    if (customId.startsWith('perm_tell_modal_')) {
        await handleTellClaudeModal(interaction);
        return;
    }

    // Handle folder modal
    if (customId === 'session_folder_modal') {
        await handleFolderModal(interaction, userId);
        return;
    }

    // Handle runner config modals
    if (customId.startsWith('config_modal:')) {
        await handleRunnerConfigModal(interaction, userId, customId);
        return;
    }

    // Handle session settings modals
    if (customId.startsWith('session_settings_modal_submit:')) {
        await handleSessionSettingsModalSubmit(interaction, userId, customId);
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

async function handleSessionSettingsModalSubmit(interaction: any, userId: string, customId: string): Promise<void> {
    const state = botState.sessionCreationState.get(userId);
    if (!state) {
        await interaction.reply({ content: 'Session setup expired. Please restart /create-session.', flags: 64 });
        return;
    }

    if (!state.options) state.options = {};

    const param = customId.split(':')[1];
    const getValue = (id: string) => interaction.fields.getTextInputValue(id).trim();

    if (param === 'model') {
        const value = getValue('model');
        if (value) state.options.model = value;
        else delete state.options.model;
    } else if (param === 'fallbackModel') {
        const value = getValue('fallbackModel');
        if (value) state.options.fallbackModel = value;
        else delete state.options.fallbackModel;
    } else if (param === 'maxTurns') {
        const value = getValue('maxTurns');
        if (!value) {
            delete state.options.maxTurns;
        } else {
            const num = parseInt(value, 10);
            if (!Number.isFinite(num) || num <= 0) {
                await interaction.reply({ content: 'Max turns must be a positive integer.', flags: 64 });
                return;
            }
            state.options.maxTurns = num;
        }
    } else if (param === 'maxThinkingTokens') {
        const value = getValue('maxThinkingTokens');
        if (!value) {
            delete state.options.maxThinkingTokens;
        } else {
            const num = parseInt(value, 10);
            if (!Number.isFinite(num) || num <= 0) {
                await interaction.reply({ content: 'Max thinking tokens must be a positive integer.', flags: 64 });
                return;
            }
            state.options.maxThinkingTokens = num;
        }
    } else if (param === 'maxBudgetUsd') {
        const value = getValue('maxBudgetUsd');
        if (!value) {
            delete state.options.maxBudgetUsd;
        } else {
            const num = parseFloat(value);
            if (!Number.isFinite(num) || num <= 0) {
                await interaction.reply({ content: 'Max budget must be a positive number.', flags: 64 });
                return;
            }
            state.options.maxBudgetUsd = num;
        }
    } else if (param === 'agent') {
        const value = getValue('agent');
        if (value) state.options.agent = value;
        else delete state.options.agent;
    } else if (param === 'allowedTools') {
        const value = getValue('allowedTools');
        state.options.allowedTools = value ? value.split(',').map(s => s.trim()).filter(Boolean) : [];
    } else if (param === 'disallowedTools') {
        const value = getValue('disallowedTools');
        state.options.disallowedTools = value ? value.split(',').map(s => s.trim()).filter(Boolean) : [];
    } else if (param === 'toolsList') {
        const value = getValue('toolsList');
        if (!value || value === 'default') {
            state.options.tools = 'default';
        } else {
            state.options.tools = value.split(',').map(s => s.trim()).filter(Boolean);
        }
    } else if (param === 'betas') {
        const value = getValue('betas');
        state.options.betas = value ? value.split(',').map(s => s.trim()).filter(Boolean) : [];
    } else if (param === 'settingSources') {
        const value = getValue('settingSources');
        state.options.settingSources = value ? value.split(',').map(s => s.trim()).filter(Boolean) : [];
    } else if (param === 'additionalDirectories') {
        const value = getValue('additionalDirectories');
        state.options.additionalDirectories = value ? value.split(',').map(s => s.trim()).filter(Boolean) : [];
    } else {
        await interaction.reply({ content: 'Unknown session setting.', flags: 64 });
        return;
    }

    botState.sessionCreationState.set(userId, state);
    await interaction.reply({ content: '✅ Session settings updated.', flags: 64 });
}

/**
 * Handle runner config modal submission
 */
async function handleRunnerConfigModal(interaction: any, userId: string, customId: string): Promise<void> {
    const parts = customId.split(':');
    if (parts.length < 3) {
        await interaction.reply({ content: 'Invalid configuration modal.', flags: 64 });
        return;
    }

    const runnerId = parts[1];
    const param = parts[2];

    const runner = storage.getRunner(runnerId);
    if (!runner) {
        await interaction.reply({
            embeds: [createErrorEmbed('Runner Not Found', 'This runner no longer exists.')],
            flags: 64
        });
        return;
    }

    if (!storage.canUserAccessRunner(userId, runnerId)) {
        await interaction.reply({
            embeds: [createErrorEmbed('Access Denied', 'You do not have permission to configure this runner.')],
            flags: 64
        });
        return;
    }

    if (!runner.config) runner.config = {};
    if (!runner.config.claudeDefaults) runner.config.claudeDefaults = {};

    if (param === 'setModel') {
        const model = interaction.fields.getTextInputValue('model').trim();
        if (!model) {
            await interaction.reply({ content: 'Model cannot be empty.', flags: 64 });
            return;
        }
        runner.config.claudeDefaults.model = model;
    } else if (param === 'setFallbackModel') {
        const fallbackModel = interaction.fields.getTextInputValue('fallbackModel').trim();
        if (!fallbackModel) {
            await interaction.reply({ content: 'Fallback model cannot be empty.', flags: 64 });
            return;
        }
        runner.config.claudeDefaults.fallbackModel = fallbackModel;
    } else if (param === 'setMaxTurns') {
        const raw = interaction.fields.getTextInputValue('maxTurns').trim();
        const value = parseInt(raw, 10);
        if (!Number.isFinite(value) || value <= 0) {
            await interaction.reply({ content: 'Max turns must be a positive integer.', flags: 64 });
            return;
        }
        runner.config.claudeDefaults.maxTurns = value;
    } else if (param === 'setMaxThinking') {
        const raw = interaction.fields.getTextInputValue('maxThinkingTokens').trim();
        const value = parseInt(raw, 10);
        if (!Number.isFinite(value) || value <= 0) {
            await interaction.reply({ content: 'Max thinking tokens must be a positive integer.', flags: 64 });
            return;
        }
        runner.config.claudeDefaults.maxThinkingTokens = value;
    } else if (param === 'setMaxBudget') {
        const raw = interaction.fields.getTextInputValue('maxBudgetUsd').trim();
        const value = parseFloat(raw);
        if (!Number.isFinite(value) || value <= 0) {
            await interaction.reply({ content: 'Max budget must be a positive number.', flags: 64 });
            return;
        }
        runner.config.claudeDefaults.maxBudgetUsd = value;
    } else if (param === 'setAgent') {
        const agent = interaction.fields.getTextInputValue('agent').trim();
        if (!agent) {
            await interaction.reply({ content: 'Agent cannot be empty.', flags: 64 });
            return;
        }
        runner.config.claudeDefaults.agent = agent;
    } else if (param === 'setAllowedTools') {
        const raw = interaction.fields.getTextInputValue('allowedTools').trim();
        runner.config.claudeDefaults.allowedTools = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
    } else if (param === 'setDisallowedTools') {
        const raw = interaction.fields.getTextInputValue('disallowedTools').trim();
        runner.config.claudeDefaults.disallowedTools = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
    } else if (param === 'setToolsList') {
        const raw = interaction.fields.getTextInputValue('toolsList').trim();
        if (!raw || raw === 'default') {
            runner.config.claudeDefaults.tools = 'default';
        } else {
            runner.config.claudeDefaults.tools = raw.split(',').map(s => s.trim()).filter(Boolean);
        }
    } else if (param === 'setBetas') {
        const raw = interaction.fields.getTextInputValue('betas').trim();
        runner.config.claudeDefaults.betas = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
    } else if (param === 'setSettingSources') {
        const raw = interaction.fields.getTextInputValue('settingSources').trim();
        runner.config.claudeDefaults.settingSources = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
    } else if (param === 'setAdditionalDirs') {
        const raw = interaction.fields.getTextInputValue('additionalDirectories').trim();
        runner.config.claudeDefaults.additionalDirectories = raw ? raw.split(',').map(s => s.trim()).filter(Boolean) : [];
    } else {
        await interaction.reply({ content: 'Unknown configuration option.', flags: 64 });
        return;
    }

    storage.updateRunner(runnerId, runner);

    if (runner.config?.claudeDefaults) {
        const ws = botState.runnerConnections.get(runnerId);
        if (ws) {
            ws.send(JSON.stringify({
                type: 'runner_config_update',
                data: {
                    runnerId,
                    claudeDefaults: runner.config.claudeDefaults
                }
            }));
        }
    }

    await interaction.reply({
        content: '✅ Claude defaults updated.',
        flags: 64
    });
}

/**
 * Handle "Tell Claude" modal submission (Unified)
 */
async function handleUnifiedTellClaudeModal(interaction: any, userId: string, customId: string): Promise<void> {
    const requestId = customId.replace('tell_modal_', '');
    const instructions = interaction.fields.getTextInputValue('tell_input');

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

    const ws = botState.runnerConnections.get(pending.runnerId);
    if (ws) {
        ws.send(JSON.stringify({
            type: 'approval_response',
            data: {
                requestId,
                sessionId: pending.sessionId,
                optionNumber: '2', // Deny
                allow: false,
                message: instructions // Send instructions as rejection message
            }
        }));
    }

    const resultButton = new ButtonBuilder()
        .setCustomId(`result_${requestId}`)
        .setLabel('❌ Denied')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(true);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(resultButton);

    const embed = new EmbedBuilder()
        .setColor(0xFF0000) // Red
        .setTitle('❌ Denied with Instructions')
        .setDescription(`**Instructions:** ${instructions}`)
        .addFields(
            { name: 'Tool', value: pending.toolName, inline: true },
            { name: 'User', value: interaction.user.username, inline: true }
        )
        .setTimestamp();

    await interaction.update({
        embeds: [embed],
        components: [row]
    });

    if (pending.sessionId.startsWith('assistant-')) {
        botState.assistantStreamingMessages.delete(pending.runnerId);
    } else {
        botState.streamingMessages.delete(pending.sessionId);
    }
    botState.pendingApprovals.delete(requestId);
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

/**
 * Handle "Other" modal submission for custom input
 */
async function handleOtherModal(interaction: any, userId: string, customId: string): Promise<void> {
    const requestId = customId.replace('other_modal_', '');
    const otherValue = interaction.fields.getTextInputValue('other_input');

    const multiSelect = botState.multiSelectState.get(requestId);
    const pending = botState.pendingApprovals.get(requestId);

    if (!multiSelect && !pending) {
        await interaction.reply({
            embeds: [createErrorEmbed('Expired', 'This question has expired.')],
            flags: 64
        });
        return;
    }

    if (pending && !storage.canUserAccessRunner(userId, pending.runnerId)) {
        await interaction.reply({
            embeds: [createErrorEmbed('Unauthorized', 'You are not authorized to respond to this request.')],
            flags: 64
        });
        return;
    }

    const runner = pending ? storage.getRunner(pending.runnerId) : null;

    // If this is a multi-select question, mark "Other" as selected and update UI
    if (multiSelect) {
        // Store the "Other" value
        (multiSelect as any).otherValue = otherValue;
        multiSelect.selectedOptions.add('other');
        botState.multiSelectState.set(requestId, multiSelect);

        // Update the button UI to show "Other" as selected
        const optionButtons = multiSelect.options.map((option: string, index: number) => {
            const optNum = String(index + 1);
            const isSelected = multiSelect.selectedOptions.has(optNum);
            return new ButtonBuilder()
                .setCustomId(`multiselect_${requestId}_${optNum}`)
                .setLabel(option)
                .setStyle(isSelected ? ButtonStyle.Success : ButtonStyle.Secondary);
        });

        // Add "Other" button as selected
        optionButtons.push(
            new ButtonBuilder()
                .setCustomId(`other_${requestId}`)
                .setLabel(`Other: ${otherValue.substring(0, 20)}...`)
                .setStyle(ButtonStyle.Success)
        );

        // Add Submit button
        const submitButton = new ButtonBuilder()
            .setCustomId(`multiselect_submit_${requestId}`)
            .setLabel(`✅ Submit (${multiSelect.selectedOptions.size} selected)`)
            .setStyle(ButtonStyle.Success);

        const rows: any[] = [
            new ActionRowBuilder<ButtonBuilder>().addComponents(...optionButtons),
            new ActionRowBuilder<ButtonBuilder>().addComponents(submitButton)
        ];

        await interaction.update({ components: rows });
        return;
    }

    // For single-select questions, immediately submit the custom answer
    if (runner && pending) {
        const ws = botState.runnerConnections.get(pending.runnerId);
        if (ws) {
            ws.send(JSON.stringify({
                type: 'approval_response',
                data: {
                    sessionId: pending.sessionId,
                    approved: true,
                    optionNumber: '0',  // Use '0' to indicate custom "Other" input
                    message: otherValue
                }
            }));
        }

        const resultButton = new ButtonBuilder()
            .setCustomId(`result_${requestId}`)
            .setLabel(`✅ Other: "${otherValue.substring(0, 30)}${otherValue.length > 30 ? '...' : ''}"`)
            .setStyle(ButtonStyle.Success)
            .setDisabled(true);

        const row = new ActionRowBuilder<ButtonBuilder>().addComponents(resultButton);

        await interaction.update({
            content: `✅ Custom answer submitted: "${otherValue}"`,
            components: [row]
        });

        // Clean up
        botState.pendingApprovals.delete(requestId);
        botState.streamingMessages.delete(pending.sessionId);
    }
}
