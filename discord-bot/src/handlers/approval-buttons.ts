/**
 * Approval Button Handlers
 * 
 * Handles allow/deny/scope/tell/allowAll/option buttons.
 * Uses self-healing customIds and the unified permissionStateStore.
 * No dependency on legacy pendingApprovals Map.
 */

import { ButtonBuilder, ButtonStyle, ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import * as botState from '../state.js';
import { storage } from '../storage.js';
import { createErrorEmbed, createApprovalDecisionEmbed } from '../utils/embeds.js';
import { permissionStateStore, type PermissionRequest } from '../permissions/state-store.js';
import { attemptPermissionReissue } from '../permissions/reissue.js';
import { safeDeferUpdate, safeUpdate, safeEditReply } from './interaction-safety.js';
import { parseButtonId, type ParsedButtonId } from './button-utils.js';

/**
 * Resolve a pending approval state from either the permissionStateStore or 
 * from self-healing customId context. Returns the request data and runnerId.
 * 
 * This is the key function that makes buttons survive bot restarts:
 * 1. First tries the in-memory store (fast path)
 * 2. If not found, extracts runnerId/sessionId from the customId itself
 * 3. Validates the runner still exists in persistent storage
 */
async function resolveApprovalState(
    interaction: any,
    customId: string,
    requestId: string
): Promise<{ request: PermissionRequest; fromStore: boolean } | null> {
    // Fast path: in-memory store has it
    const state = permissionStateStore.get(requestId);
    if (state) {
        if (state.status === 'completed') {
            await safeUpdate(interaction, { components: [] }).catch(() => {});
            return null;
        }
        return { request: state.request, fromStore: true };
    }

    // Self-healing path: extract context from customId
    const parsed = parseButtonId(customId);
    if (parsed && parsed.runnerId && parsed.sessionId) {
        // Verify runner exists in persistent storage
        const runner = storage.getRunner(parsed.runnerId);
        if (runner) {
            // Reconstruct a minimal request from the customId data
            return {
                request: {
                    requestId,
                    runnerId: parsed.runnerId,
                    sessionId: parsed.sessionId,
                    toolName: 'unknown', // We don't have this from customId
                    toolInput: {},
                    suggestions: [],
                    isPlanMode: false,
                    isQuestion: false,
                    currentScope: 'session',
                    timestamp: new Date().toISOString()
                },
                fromStore: false
            };
        }
    }

    // Neither store nor customId could resolve — try reissue
    const { requested } = await attemptPermissionReissue({
        requestId,
        channelId: interaction?.channelId || interaction?.channel?.id,
        reason: 'missing_local_state'
    });
    await safeUpdate(interaction, {
        embeds: [createErrorEmbed('Expired', requested
            ? 'This approval request expired locally. I asked the runner to re-send it.'
            : 'This approval request has expired.')],
        components: []
    }).catch((e: any) => console.error('[ApprovalButtons] Failed to show expired:', e.message));
    return null;
}

/**
 * Handle allow/deny button clicks
 */
export async function handleApprovalButton(interaction: any, userId: string, customId: string): Promise<void> {
    // Determine action and requestId
    let action: string;
    let requestId: string;

    const parsed = parseButtonId(customId);
    if (parsed) {
        action = parsed.action;
        requestId = parsed.requestId;
    } else {
        // Legacy format: allow_<requestId> or deny_<requestId>
        action = customId.split('_')[0];
        requestId = customId.substring(action.length + 1);
    }

    console.log(`[ApprovalButtons] handleApprovalButton: action=${action} requestId=${requestId}`);

    const resolved = await resolveApprovalState(interaction, customId, requestId);
    if (!resolved) return;

    const { request, fromStore } = resolved;
    const runner = storage.getRunner(request.runnerId);
    if (!runner || !storage.canUserAccessRunner(userId, request.runnerId)) {
        await safeEditReply(interaction, {
            embeds: [createErrorEmbed('Unauthorized', 'You are not authorized to approve this request.')]
        });
        return;
    }

    const allow = action === 'allow';

    const ws = botState.runnerConnections.get(request.runnerId);
    if (ws) {
        ws.send(JSON.stringify({
            type: 'permission_decision',
            data: {
                requestId,
                sessionId: request.sessionId,
                behavior: allow ? 'allow' : 'deny'
            }
        }));
    }

    const resultButton = new ButtonBuilder()
        .setCustomId(`result_${requestId}`)
        .setLabel(allow ? '✅ Allowed' : '❌ Denied')
        .setStyle(allow ? ButtonStyle.Success : ButtonStyle.Danger)
        .setDisabled(true);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(resultButton);
    const embed = createApprovalDecisionEmbed(allow, request.toolName, interaction.user.username, undefined, request.toolInput as Record<string, any>);

    await safeUpdate(interaction, {
        embeds: [embed],
        components: [row]
    });

    // Clear streaming state
    if (request.sessionId.startsWith('assistant-')) {
        botState.assistantStreamingMessages.delete(request.runnerId);
    } else {
        botState.streamingMessages.delete(request.sessionId);
    }

    // Complete in store
    if (fromStore) {
        permissionStateStore.complete(requestId);
    }

    storage.logAudit({
        timestamp: new Date().toISOString(),
        type: 'permission_decision',
        runnerId: request.runnerId,
        sessionId: request.sessionId,
        userId,
        details: { tool: request.toolName, behavior: allow ? 'allow' : 'deny' }
    });
}

/**
 * Handle Allow All button
 */
export async function handleAllowAll(interaction: any, userId: string, customId: string): Promise<void> {
    let requestId: string;

    const parsed = parseButtonId(customId);
    if (parsed) {
        requestId = parsed.requestId;
    } else {
        // Legacy format: allow_all_<requestId>
        requestId = customId.replace('allow_all_', '');
    }

    const resolved = await resolveApprovalState(interaction, customId, requestId);
    if (!resolved) return;

    const { request, fromStore } = resolved;
    const runner = storage.getRunner(request.runnerId);
    if (!runner || !storage.canUserAccessRunner(userId, request.runnerId)) {
        await safeUpdate(interaction, {
            embeds: [createErrorEmbed('Unauthorized', 'You are not authorized to approve this request.')],
            components: []
        }).catch((e: any) => console.error('[ApprovalButtons] Failed:', e.message));
        return;
    }

    // Add to session-level auto-approved tools
    let sessionTools = botState.allowedTools.get(request.sessionId);
    if (!sessionTools) {
        sessionTools = new Set();
        botState.allowedTools.set(request.sessionId, sessionTools);
    }
    sessionTools.add(request.toolName);

    const ws = botState.runnerConnections.get(request.runnerId);
    if (ws) {
        ws.send(JSON.stringify({
            type: 'permission_decision',
            data: {
                requestId,
                sessionId: request.sessionId,
                behavior: 'allow',
                scope: 'session'
            }
        }));
    }

    const scope = botState.userScopePreferences.get(userId) || 'session';
    const scopeLabel = scope === 'global' ? 'Global' : scope.charAt(0).toUpperCase() + scope.slice(1);

    const resultButton = new ButtonBuilder()
        .setCustomId(`result_${requestId}`)
        .setLabel(`✅ Auto-Approved (${scopeLabel})`)
        .setStyle(ButtonStyle.Success)
        .setDisabled(true);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(resultButton);
    const embed = createApprovalDecisionEmbed(true, request.toolName, interaction.user.username, 'auto-approved for session');

    await safeUpdate(interaction, {
        embeds: [embed],
        components: [row]
    });

    // Clear streaming state
    if (request.sessionId.startsWith('assistant-')) {
        botState.assistantStreamingMessages.delete(request.runnerId);
    } else {
        botState.streamingMessages.delete(request.sessionId);
    }

    if (fromStore) {
        permissionStateStore.complete(requestId);
    }

    storage.logAudit({
        timestamp: new Date().toISOString(),
        type: 'permission_decision',
        runnerId: request.runnerId,
        sessionId: request.sessionId,
        userId,
        details: { tool: request.toolName, behavior: 'allow_all', scope }
    });
}

/**
 * Handle Scope toggle button
 */
export async function handleScopeButton(interaction: any, userId: string, customId: string): Promise<void> {
    let requestId: string;

    const parsed = parseButtonId(customId);
    if (parsed) {
        requestId = parsed.requestId;
    } else {
        requestId = customId.replace('scope_', '');
    }

    const currentScope = botState.userScopePreferences.get(userId) || 'session';
    let nextScope: botState.UserScope;

    switch (currentScope) {
        case 'session': nextScope = 'project'; break;
        case 'project': nextScope = 'global'; break;
        case 'global': nextScope = 'session'; break;
        default: nextScope = 'session';
    }

    botState.userScopePreferences.set(userId, nextScope);

    const scopeLabel = nextScope === 'global' ? 'Global' : nextScope.charAt(0).toUpperCase() + nextScope.slice(1);

    // Reconstruct the row with updated scope button label
    const oldComponents = interaction.message.components[0].components;
    const newComponents = oldComponents.map((comp: any) => {
        const builder = ButtonBuilder.from(comp);
        // Match both new format (scope:...) and legacy format (scope_...)
        if (comp.customId?.startsWith('scope:') || comp.customId?.startsWith('scope_')) {
            builder.setLabel(`Scope: ${scopeLabel} 🔄`);
        }
        return builder;
    });

    await safeUpdate(interaction, {
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(newComponents)]
    });
}

/**
 * Handle Tell Claude button - opens modal for custom message
 */
export async function handleTellClaude(interaction: any, userId: string, customId: string): Promise<void> {
    let requestId: string;

    const parsed = parseButtonId(customId);
    if (parsed) {
        requestId = parsed.requestId;
    } else {
        requestId = customId.replace('tell_', '');
    }

    // Validate state exists (either store or runner)
    const state = permissionStateStore.get(requestId);
    if (!state) {
        const parsedId = parseButtonId(customId);
        if (!parsedId || !storage.getRunner(parsedId.runnerId)) {
            const { requested } = await attemptPermissionReissue({
                requestId,
                channelId: interaction?.channelId || interaction?.channel?.id,
                reason: 'missing_local_state'
            });
            await interaction.reply({
                embeds: [createErrorEmbed('Expired', requested
                    ? 'This approval request expired locally. I asked the runner to re-send it.'
                    : 'This approval request has expired.')],
                flags: 64
            });
            return;
        }
    }

    const modal = new ModalBuilder()
        .setCustomId(`tell_modal_${requestId}`)
        .setTitle('Tell Claude What To Do');

    const inputRow = new ActionRowBuilder<TextInputBuilder>()
        .addComponents(
            new TextInputBuilder()
                .setCustomId('tell_input')
                .setLabel('Instructions')
                .setPlaceholder('Tell Claude what to do instead...')
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
                .setMaxLength(1000)
        );

    modal.addComponents(inputRow);
    await interaction.showModal(modal);
}

/**
 * Handle option selection buttons (single-select for AskUserQuestion)
 */
export async function handleOptionButton(interaction: any, userId: string, customId: string): Promise<void> {
    let requestId: string;
    let optionNumber: string;

    const parsed = parseButtonId(customId);
    if (parsed) {
        // New format: option:<requestId>:<runnerId>:<sessionId> with optionNumber encoded differently
        // Actually for options we use: option_<requestId>_<optionNumber> or option:<requestId>:<optionNumber>:<runnerId>:<sessionId>
        requestId = parsed.requestId;
        // For option buttons in new format, the action contains the option number
        // We handle this via the legacy format for now
        const lastUnderscoreIndex = customId.lastIndexOf('_');
        optionNumber = customId.substring(lastUnderscoreIndex + 1);
        requestId = customId.substring('option_'.length, lastUnderscoreIndex);
    } else {
        // Legacy format: option_<requestId>_<optionNumber>
        const lastUnderscoreIndex = customId.lastIndexOf('_');
        optionNumber = customId.substring(lastUnderscoreIndex + 1);
        requestId = customId.substring('option_'.length, lastUnderscoreIndex);
    }

    // Try unified store
    const state = permissionStateStore.get(requestId);
    let runnerId: string | undefined;
    let sessionId: string | undefined;
    let toolName: string = 'unknown';

    if (state) {
        if (state.status === 'completed') {
            await safeUpdate(interaction, { components: [] }).catch(() => {});
            return;
        }
        runnerId = state.request.runnerId;
        sessionId = state.request.sessionId;
        toolName = state.request.toolName;
    } else {
        // Try self-healing from customId
        const parsedId = parseButtonId(customId);
        if (parsedId) {
            runnerId = parsedId.runnerId;
            sessionId = parsedId.sessionId;
        }
    }

    if (!runnerId || !sessionId) {
        const { requested } = await attemptPermissionReissue({
            requestId,
            channelId: interaction?.channelId || interaction?.channel?.id,
            reason: 'missing_local_state'
        });
        await safeEditReply(interaction, {
            embeds: [createErrorEmbed('Expired', requested
                ? 'This approval request expired locally. I asked the runner to re-send it.'
                : 'This approval request has expired.')]
        });
        return;
    }

    const runner = storage.getRunner(runnerId);
    if (!runner || !storage.canUserAccessRunner(userId, runnerId)) {
        await safeEditReply(interaction, {
            embeds: [createErrorEmbed('Unauthorized', 'You are not authorized to approve this request.')]
        });
        return;
    }

    const ws = botState.runnerConnections.get(runnerId);
    if (ws) {
        ws.send(JSON.stringify({
            type: 'approval_response',
            data: {
                sessionId,
                approved: true,
                optionNumber
            }
        }));
    }

    const selectedButton = new ButtonBuilder()
        .setCustomId(`selected_${requestId}`)
        .setLabel(`✅ Option ${optionNumber} Selected`)
        .setStyle(ButtonStyle.Success)
        .setDisabled(true);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(selectedButton);
    const embed = createApprovalDecisionEmbed(true, toolName, interaction.user.username, `Option ${optionNumber}`);

    await safeUpdate(interaction, {
        embeds: [embed],
        components: [row]
    });

    if (state) {
        permissionStateStore.complete(requestId);
    }
    botState.streamingMessages.delete(sessionId);
}
