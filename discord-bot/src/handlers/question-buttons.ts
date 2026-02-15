/**
 * Question Button Handlers
 * 
 * Handles multi-select toggle, multi-select submit, and "Other" custom input buttons.
 * Uses unified permissionStateStore instead of legacy pendingApprovals.
 */

import { ButtonBuilder, ButtonStyle, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import * as botState from '../state.js';
import { storage } from '../storage.js';
import { createErrorEmbed, createApprovalDecisionEmbed } from '../utils/embeds.js';
import { permissionStateStore } from '../permissions/state-store.js';
import { attemptPermissionReissue } from '../permissions/reissue.js';
import { safeEditReply, safeUpdate } from './interaction-safety.js';

/**
 * Resolve runner/session from either permissionStateStore or multiSelectState
 */
function resolveQuestionContext(requestId: string): { runnerId: string; sessionId: string; toolName: string } | null {
    const state = permissionStateStore.get(requestId);
    if (state) {
        return {
            runnerId: state.request.runnerId,
            sessionId: state.request.sessionId,
            toolName: state.request.toolName
        };
    }
    const multi = botState.multiSelectState.get(requestId);
    if (multi) {
        return {
            runnerId: multi.runnerId,
            sessionId: multi.sessionId,
            toolName: multi.toolName
        };
    }
    return null;
}

/**
 * Handle multi-select toggle button
 */
export async function handleMultiSelectToggle(interaction: any, userId: string, customId: string): Promise<void> {
    const prefix = 'multiselect_';
    const lastUnderscoreIndex = customId.lastIndexOf('_');
    if (!customId.startsWith(prefix) || lastUnderscoreIndex <= prefix.length) {
        await safeEditReply(interaction, {
            embeds: [createErrorEmbed('Invalid Action', 'Could not parse multi-select response.')]
        });
        return;
    }
    const requestId = customId.substring(prefix.length, lastUnderscoreIndex);
    const optionNumber = customId.substring(lastUnderscoreIndex + 1);

    const multiSelect = botState.multiSelectState.get(requestId);
    if (!multiSelect) {
        console.error(`[QuestionButtons] No multiSelectState found for requestId=${requestId}`);
        await safeEditReply(interaction, {
            embeds: [createErrorEmbed('Expired', 'This question has expired.')]
        });
        return;
    }

    const ctx = resolveQuestionContext(requestId);
    if (!ctx) {
        const { requested } = await attemptPermissionReissue({
            requestId,
            channelId: interaction?.channelId || interaction?.channel?.id,
            reason: 'missing_local_state'
        });
        await safeEditReply(interaction, {
            embeds: [createErrorEmbed('Expired', requested
                ? 'This request expired locally. I asked the runner to re-send it.'
                : 'This request has expired.')]
        });
        return;
    }

    if (!storage.canUserAccessRunner(userId, ctx.runnerId)) {
        await safeEditReply(interaction, {
            embeds: [createErrorEmbed('Unauthorized', 'You are not authorized to respond to this request.')]
        });
        return;
    }

    // Toggle the option
    if (multiSelect.selectedOptions.has(optionNumber)) {
        multiSelect.selectedOptions.delete(optionNumber);
    } else {
        multiSelect.selectedOptions.add(optionNumber);
    }
    botState.multiSelectState.set(requestId, multiSelect);

    // Update button styles to reflect selection state
    const optionButtons = multiSelect.options.map((option: string, index: number) => {
        const optNum = String(index + 1);
        const isSelected = multiSelect.selectedOptions.has(optNum);
        return new ButtonBuilder()
            .setCustomId(`multiselect_${requestId}_${optNum}`)
            .setLabel(option)
            .setStyle(isSelected ? ButtonStyle.Success : ButtonStyle.Secondary);
    });

    // Add "Other" button if hasOther is true
    if (multiSelect.hasOther) {
        const isOtherSelected = multiSelect.selectedOptions.has('other');
        optionButtons.push(
            new ButtonBuilder()
                .setCustomId(`other_${requestId}`)
                .setLabel('Other...')
                .setStyle(isOtherSelected ? ButtonStyle.Success : ButtonStyle.Secondary)
        );
    }

    // Add Submit button
    const submitButton = new ButtonBuilder()
        .setCustomId(`multiselect_submit_${requestId}`)
        .setLabel(`✅ Submit (${multiSelect.selectedOptions.size} selected)`)
        .setStyle(multiSelect.selectedOptions.size > 0 ? ButtonStyle.Success : ButtonStyle.Secondary)
        .setDisabled(multiSelect.selectedOptions.size === 0);

    const rows: ActionRowBuilder<ButtonBuilder>[] = [
        new ActionRowBuilder<ButtonBuilder>().addComponents(...optionButtons),
        new ActionRowBuilder<ButtonBuilder>().addComponents(submitButton)
    ];

    await safeUpdate(interaction, { components: rows });
}

/**
 * Handle multi-select submit button
 */
export async function handleMultiSelectSubmit(interaction: any, userId: string, customId: string): Promise<void> {
    const requestId = customId.replace('multiselect_submit_', '');

    const multiSelect = botState.multiSelectState.get(requestId);
    if (!multiSelect) {
        await safeEditReply(interaction, {
            embeds: [createErrorEmbed('Expired', 'This question has expired.')]
        });
        return;
    }

    const ctx = resolveQuestionContext(requestId);
    if (!ctx) {
        const { requested } = await attemptPermissionReissue({
            requestId,
            channelId: interaction?.channelId || interaction?.channel?.id,
            reason: 'missing_local_state'
        });
        await safeEditReply(interaction, {
            embeds: [createErrorEmbed('Expired', requested
                ? 'This request expired locally. I asked the runner to re-send it.'
                : 'This request has expired.')]
        });
        return;
    }

    if (!storage.canUserAccessRunner(userId, ctx.runnerId)) {
        await safeEditReply(interaction, {
            embeds: [createErrorEmbed('Unauthorized', 'You are not authorized to respond to this request.')]
        });
        return;
    }

    // Send the selected options to the runner
    const ws = botState.runnerConnections.get(ctx.runnerId);
    if (ws) {
        const selectedNumbers = Array.from(multiSelect.selectedOptions)
            .filter(opt => opt !== 'other')
            .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

        if (selectedNumbers.length > 0) {
            ws.send(JSON.stringify({
                type: 'approval_response',
                data: {
                    sessionId: ctx.sessionId,
                    approved: true,
                    optionNumber: selectedNumbers.join(',')
                }
            }));
        }

        if (multiSelect.selectedOptions.has('other')) {
            const otherValue = (multiSelect as any).otherValue || '';
            ws.send(JSON.stringify({
                type: 'approval_response',
                data: {
                    sessionId: ctx.sessionId,
                    approved: true,
                    optionNumber: '0',
                    message: otherValue
                }
            }));
        }
    }

    // Show success message
    const selectedLabels = Array.from(multiSelect.selectedOptions)
        .map(optNum => {
            if (optNum === 'other') return 'Other';
            const idx = parseInt(optNum, 10) - 1;
            return multiSelect.options[idx] || optNum;
        })
        .join(', ');

    const resultButton = new ButtonBuilder()
        .setCustomId(`result_${requestId}`)
        .setLabel(`✅ Submitted: ${selectedLabels}`)
        .setStyle(ButtonStyle.Success)
        .setDisabled(true);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(resultButton);
    const embed = createApprovalDecisionEmbed(true, ctx.toolName, interaction.user.username, `Selected: ${selectedLabels}`);

    await safeUpdate(interaction, {
        embeds: [embed],
        components: [row]
    });

    // Clean up
    botState.multiSelectState.delete(requestId);
    permissionStateStore.complete(requestId);
    botState.streamingMessages.delete(ctx.sessionId);
}

/**
 * Handle "Other" button - opens modal for custom input
 */
export async function handleOtherButton(interaction: any, userId: string, customId: string): Promise<void> {
    const requestId = customId.replace('other_', '');

    const ctx = resolveQuestionContext(requestId);
    if (!ctx) {
        const { requested } = await attemptPermissionReissue({
            requestId,
            channelId: interaction?.channelId || interaction?.channel?.id,
            reason: 'missing_local_state'
        });
        await interaction.reply({
            embeds: [createErrorEmbed('Expired', requested
                ? 'This question expired locally. I asked the runner to re-send it.'
                : 'This question has expired.')],
            flags: 64
        });
        return;
    }

    if (!storage.canUserAccessRunner(userId, ctx.runnerId)) {
        await interaction.reply({
            embeds: [createErrorEmbed('Unauthorized', 'You are not authorized to respond to this request.')],
            flags: 64
        });
        return;
    }

    const modal = new ModalBuilder()
        .setCustomId(`other_modal_${requestId}`)
        .setTitle('Custom Answer')
        .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                    .setCustomId('other_input')
                    .setLabel('Your answer')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('Enter your custom answer...')
                    .setRequired(true)
                    .setMinLength(1)
                    .setMaxLength(1000)
            )
        );

    await interaction.showModal(modal);
}
