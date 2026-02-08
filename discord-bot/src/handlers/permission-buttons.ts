/**
 * ============================================================================
 * NEW PERMISSION SYSTEM HANDLERS
 * Supports scope selection, "Always" functionality, and "Tell Claude" modal
 * ============================================================================
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import * as botState from '../state.js';

console.log('[DEBUG] permission-buttons.ts LOADED - Unified UI Version');

import { storage } from '../storage.js';
import { createErrorEmbed, createApprovalDecisionEmbed } from '../utils/embeds.js';
import { permissionStateStore, type PermissionRequest } from '../permissions/state-store.js';
import { buildAlwaysButtonText } from '../permissions/ui-state.js';

/**
 * Create a "Processing..." embed
 */
export function createProcessingEmbed(toolName: string): EmbedBuilder {
    return new EmbedBuilder()
        .setTitle(`⏳ Processing Permission: ${toolName}`)
        .setDescription('Sending decision to runner...')
        .setColor('Yellow')
        .setTimestamp();
}

/**
 * Create a success embed for confirmed approval
 */
export function createConfirmedSuccessEmbed(toolName: string, username: string, scope?: string): EmbedBuilder {
    const description = scope
        ? `✅ **Permission approved by ${username}**\n\n**Scope:** ${scope}`
        : `✅ **Permission approved by ${username}**`;

    return new EmbedBuilder()
        .setTitle(`Permission Granted: ${toolName}`)
        .setDescription(description)
        .setColor('Green')
        .setTimestamp();
}

/**
 * Create a timeout embed
 */
export function createTimeoutEmbed(): EmbedBuilder {
    return new EmbedBuilder()
        .setTitle('⚠️ No Confirmation Received')
        .setDescription('The runner did not confirm. It may have still processed your request.')
        .setColor('Orange')
        .setTimestamp();
}


/**
 * Main permission button dispatcher
 * Routes to appropriate handler based on button action
 */
export async function handlePermissionButton(interaction: any, userId: string, customId: string): Promise<void> {
    const parts = customId.split('_');
    const action = parts[1]; // yes, always, no, scope, tell
    const requestId = parts.slice(2).join('_'); // Rejoin remaining parts
    
    // Defer immediately to prevent 3-second timeout, UNLESS it's a modal trigger
    // Modals must be the first response to an interaction
    if (action !== 'tell') {
        await interaction.deferUpdate().catch(() => {});
    }

    console.log(`[Permission] Button clicked: action=${action}, requestId=${requestId}`);

    switch (action) {
        case 'yes':
        case 'submit':
            await handlePermApprove(interaction, userId, requestId);
            break;
        case 'always':
            await handlePermAlways(interaction, userId, requestId);
            break;
        case 'no':
            await handlePermDeny(interaction, userId, requestId);
            break;
        case 'scope':
            await handlePermScope(interaction, userId, requestId);
            break;
        case 'tell':
            await handlePermTell(interaction, userId, requestId);
            break;
        default:
            console.error(`[Permission] Unknown action: ${action}`);
            await interaction.reply({
                content: 'Unknown permission action',
                flags: 64
            });
    }
}

/**
 * Handle Approve/Submit button
 */
async function handlePermApprove(interaction: any, userId: string, requestId: string): Promise<void> {
    const state = permissionStateStore.get(requestId);
    if (!state) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Expired', 'This permission request has expired.')],
            components: []
        }).catch((e: any) => console.error('[DEBUG] Failed to editReply:', e.message));
        return;
    }

    if (state.status === 'completed') {
        await interaction.editReply({ components: [] }).catch(() => {});
        return;
    }

    const { request } = state;
    const runner = storage.getRunner(request.runnerId);
    if (!runner || !storage.canUserAccessRunner(userId, runner.runnerId)) {
        await interaction.reply({
            embeds: [createErrorEmbed('Unauthorized', `You are not authorized to approve this request.\nRunner: ${runner ? runner.runnerId : 'Unknown'}\nUser: ${userId}`)],
            flags: 64
        });
        return;
    }

    // Update UI to "Processing..." FIRST
    await interaction.editReply({
        embeds: [createProcessingEmbed(request.toolName)],
        components: []
    }).catch((err: any) => console.error('[Permission] Failed to show processing:', err));

    // Send approval decision to runner-agent
    const ws = botState.runnerConnections.get(runner.runnerId);
    if (!ws) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Offline', 'Runner is offline')],
            components: []
        });
        return;
    }

    ws.send(JSON.stringify({
        type: 'permission_decision',
        data: {
            requestId,
            sessionId: request.sessionId,
            behavior: 'allow'
        }
    }));
    storage.logAudit({
        timestamp: new Date().toISOString(),
        type: 'permission_decision',
        runnerId: request.runnerId,
        sessionId: request.sessionId,
        userId,
        details: { tool: request.toolName, behavior: 'allow' }
    });

    // Set up timeout for confirmation (10 seconds)
    const timeout = setTimeout(async () => {
        const pending = botState.pendingPermissionConfirmations.get(requestId);
        if (!pending) return;

        console.log(`[Permission] Timeout waiting for confirmation for ${requestId}`);

        await interaction.editReply({
            embeds: [createTimeoutEmbed()],
            components: []
        }).catch((err: any) => console.error('[Permission] Failed to show timeout:', err));

        botState.pendingPermissionConfirmations.delete(requestId);
    }, 10000);

    // Store pending confirmation
    botState.pendingPermissionConfirmations.set(requestId, {
        requestId,
        interaction,
        userId,
        toolName: request.toolName,
        behavior: 'allow',
        timeout
    });
}

/**
 * Handle "Always" button with scope
 */
async function handlePermAlways(interaction: any, userId: string, requestId: string): Promise<void> {
    const state = permissionStateStore.get(requestId);
    if (!state) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Expired', 'This permission request has expired.')],
            components: []
        }).catch((e: any) => console.error('[DEBUG] Failed to editReply:', e.message));
        return;
    }

    if (state.status === 'completed') {
         await interaction.editReply({ components: [] }).catch(() => {});
         return;
    }

    const { request, uiState } = state;
    const scope = uiState.scope;

    const runner = storage.getRunner(request.runnerId);
    if (!runner || !storage.canUserAccessRunner(userId, runner.runnerId)) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Unauthorized', `You are not authorized to approve this request.\nRunner: ${runner ? runner.runnerId : 'Unknown'}\nUser: ${userId}`)],
            components: []
        }).catch((e: any) => console.error('[DEBUG] Failed to editReply:', e.message));
        return;
    }

    // Update UI to "Processing..." FIRST
    await interaction.editReply({
        embeds: [createProcessingEmbed(request.toolName)],
        components: []
    }).catch((err: any) => console.error('[Permission] Failed to show processing:', err));

    // Send approval with scope to runner-agent
    const ws = botState.runnerConnections.get(runner.runnerId);
    if (!ws) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Offline', 'Runner is offline')],
            components: []
        });
        return;
    }

    ws.send(JSON.stringify({
        type: 'permission_decision',
        data: {
            requestId,
            sessionId: request.sessionId,
            behavior: 'allow',
            scope,
            updatedPermissions: request.suggestions
        }
    }));
    storage.logAudit({
        timestamp: new Date().toISOString(),
        type: 'permission_decision',
        runnerId: request.runnerId,
        sessionId: request.sessionId,
        userId,
        details: { tool: request.toolName, behavior: 'allow_always', scope }
    });

    // Set up timeout for confirmation (10 seconds)
    const timeout = setTimeout(async () => {
        const pending = botState.pendingPermissionConfirmations.get(requestId);
        if (!pending) return;

        console.log(`[Permission] Timeout waiting for confirmation for ${requestId}`);

        // No confirmation received
        await interaction.editReply({
            embeds: [createTimeoutEmbed()],
            components: []
        }).catch((err: any) => console.error('[Permission] Failed to show timeout:', err));

        botState.pendingPermissionConfirmations.delete(requestId);
    }, 10000);

    // Store pending confirmation
    botState.pendingPermissionConfirmations.set(requestId, {
        requestId,
        interaction,
        userId,
        toolName: request.toolName,
        behavior: 'allow',
        scope: uiState.scopeLabel,
        timeout
    });
}

/**
 * Handle Deny button
 */
async function handlePermDeny(interaction: any, userId: string, requestId: string): Promise<void> {
    const state = permissionStateStore.get(requestId);
    if (!state) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Expired', 'This permission request has expired.')],
            components: []
        }).catch((e: any) => console.error('[DEBUG] Failed to editReply:', e.message));
        return;
    }

    if (state.status === 'completed') {
         await interaction.editReply({ components: [] }).catch(() => {});
         return;
    }

    const { request } = state;
    const runner = storage.getRunner(request.runnerId);
    if (!runner || !storage.canUserAccessRunner(userId, runner.runnerId)) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Unauthorized', `You are not authorized to respond to this request.\nRunner: ${runner ? runner.runnerId : 'Unknown'}\nUser: ${userId}`)],
            components: []
        }).catch((e: any) => console.error('[DEBUG] Failed to editReply:', e.message));
        return;
    }

    // Update UI to "Processing..." FIRST
    await interaction.editReply({
        embeds: [createProcessingEmbed(request.toolName)],
        components: []
    }).catch((err: any) => console.error('[Permission] Failed to show processing:', err));

    // Send denial to runner-agent
    const ws = botState.runnerConnections.get(runner.runnerId);
    if (!ws) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Offline', 'Runner is offline')],
            components: []
        });
        return;
    }

    ws.send(JSON.stringify({
        type: 'permission_decision',
        data: {
            requestId,
            sessionId: request.sessionId,
            behavior: 'deny'
        }
    }));
    storage.logAudit({
        timestamp: new Date().toISOString(),
        type: 'permission_decision',
        runnerId: request.runnerId,
        sessionId: request.sessionId,
        userId,
        details: { tool: request.toolName, behavior: 'deny' }
    });

    // Set up timeout for confirmation (10 seconds)
    const timeout = setTimeout(async () => {
        const pending = botState.pendingPermissionConfirmations.get(requestId);
        if (!pending) return;

        console.log(`[Permission] Timeout waiting for confirmation for ${requestId}`);

        await interaction.editReply({
            embeds: [createTimeoutEmbed()],
            components: []
        }).catch((err: any) => console.error('[Permission] Failed to show timeout:', err));

        botState.pendingPermissionConfirmations.delete(requestId);
    }, 10000);

    // Store pending confirmation
    botState.pendingPermissionConfirmations.set(requestId, {
        requestId,
        interaction,
        userId,
        toolName: request.toolName,
        behavior: 'deny',
        timeout
    });
}

/**
 * Handle Scope toggle button
 * Cycles through: session → localSettings → userSettings → projectSettings
 */
async function handlePermScope(interaction: any, userId: string, requestId: string): Promise<void> {
    const state = permissionStateStore.get(requestId);
    if (!state) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Expired', 'This permission request has expired.')],
            components: []
        }).catch((e: any) => console.error('[DEBUG] Failed to editReply:', e.message));
        return;
    }

    const { request, uiState } = state;

    // Cycle to next scope
    const newScope = uiState.cycleScope();
    
    // Map PermissionScope to UserScope for persistence
    let userScope: 'session' | 'project' | 'global' = 'session';
    if (newScope === 'userSettings') userScope = 'global';
    else if (newScope === 'projectSettings' || newScope === 'localSettings') userScope = 'project';
    
    // Save to user preferences
    botState.userScopePreferences.set(userId, userScope);

    const scopeLabel = uiState.scopeLabel;
    const scopeDescription = uiState.scopeDescription;

    // Rebuild buttons with updated scope
    const components = rebuildPermissionButtons(request, uiState);

    // Update embed with scope info
    const embed = new EmbedBuilder()
        .setTitle(`Tool Permission: ${request.toolName}`)
        .setDescription(formatToolInput(request.toolInput))
        .addFields([
            { name: 'Current Scope', value: `**${scopeLabel}**\n${scopeDescription}`, inline: false }
        ])
        .setColor('Yellow')
        .setTimestamp(new Date(request.timestamp));

    await interaction.editReply({
        embeds: [embed],
        components
    });
}

/**
 * Handle "Tell Claude what to do" button
 * Shows a modal for custom rejection message
 */
async function handlePermTell(interaction: any, userId: string, requestId: string): Promise<void> {
    const state = permissionStateStore.get(requestId);
    if (!state) {
        await interaction.reply({
            embeds: [createErrorEmbed('Expired', 'This permission request has expired.')],
            flags: 64
        });
        return;
    }

    // Create modal for custom message
    const modal = new ModalBuilder()
        .setCustomId(`perm_tell_modal_${requestId}`)
        .setTitle('Tell Claude What to Do Instead');

    const input = new TextInputBuilder()
        .setCustomId('perm_tell_input')
        .setLabel('Your instructions')
        .setStyle(TextInputStyle.Paragraph)
        .setPlaceholder('Tell Claude what to do instead...')
        .setRequired(true)
        .setMinLength(1)
        .setMaxLength(1000);

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input);
    modal.addComponents(row);

    await interaction.showModal(modal);
}

/**
 * Handle "Tell Claude" modal submit
 */
export async function handleTellClaudeModal(interaction: any): Promise<void> {
    // Defer immediately to prevent timeout
    await interaction.deferUpdate().catch(() => {});
    
    const customId = interaction.customId;
    const parts = customId.split('_');
    const requestId = parts[3]; // perm_tell_modal_<requestId>

    const customMessage = interaction.fields.getTextInputValue('perm_tell_input');

    const state = permissionStateStore.get(requestId);
    if (!state) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Expired', 'This permission request has expired.')],
            components: []
        }).catch((e: any) => console.error('[DEBUG] Failed to editReply:', e.message));
        return;
    }

    if (state.status === 'completed') {
        await interaction.editReply({ components: [] }).catch(() => {});
        return;
    }

    const { request } = state;
    const runner = storage.getRunner(request.runnerId);
    if (!runner || !storage.canUserAccessRunner(interaction.user.id, runner.runnerId)) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Unauthorized', `You are not authorized to respond to this request.\nRunner: ${runner ? runner.runnerId : 'Unknown'}\nUser: ${interaction.user.id}`)],
            components: []
        }).catch((e: any) => console.error('[DEBUG] Failed to editReply:', e.message));
        return;
    }

    // Send denial with custom message to runner-agent
    const ws = botState.runnerConnections.get(runner.runnerId);
    if (ws) {
        ws.send(JSON.stringify({
            type: 'permission_decision',
            data: {
                requestId,
                sessionId: request.sessionId,
                behavior: 'deny',
                customMessage
            }
        }));
    }

    // Update UI to show denied with message
    const resultButton = new ButtonBuilder()
        .setCustomId(`result_${requestId}`)
        .setLabel('❌ Denied')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(true);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(resultButton);
    const embed = new EmbedBuilder()
        .setTitle(`Permission Decision: ${request.toolName}`)
        .setDescription('❌ Denied with custom message')
        .addFields([
            { name: 'Message', value: customMessage.slice(0, 200), inline: false }
        ])
        .setColor('Red')
        .setTimestamp();

    // Add tool input field
    if (request.toolInput && Object.keys(request.toolInput).length > 0) {
        embed.addFields({
            name: 'Tool Input',
            value: formatToolInput(request.toolInput),
            inline: false
        });
    }

    await interaction.editReply({
        embeds: [embed],
        components: [row]
    });

    // Mark as completed
    permissionStateStore.complete(requestId);
}

/**
 * Format tool input for display in embed
 */
function formatToolInput(input: Record<string, any>): string {
    if (!input || Object.keys(input).length === 0) {
        return 'No input parameters';
    }

    const lines: string[] = [];
    for (const [key, value] of Object.entries(input)) {
        const strValue = typeof value === 'string' ? value : JSON.stringify(value);
        lines.push(`**${key}**: ${strValue.slice(0, 100)}${strValue.length > 100 ? '...' : ''}`);
    }

    return lines.join('\n');
}

/**
 * Rebuild permission buttons with updated scope
 */
export function rebuildPermissionButtons(request: PermissionRequest, uiState: any): any[] {
    console.log(`[DEBUG] rebuildPermissionButtons called for ${request.toolName} (isQuestion: ${request.isQuestion}, isPlan: ${request.isPlanMode})`);
    const rows: any[] = [];
    const { isPlanMode, isQuestion, suggestions } = request;

    // Row 1: Unified 5-button layout
    const row1 = new ActionRowBuilder<ButtonBuilder>();

    // 1. Allow Button (Success)
    // For Plan Mode/Question mode, we might need specific labels/actions, but trying to unify where possible.
    if (isQuestion) {
        row1.addComponents(
             new ButtonBuilder()
                .setCustomId(`perm_yes_${request.requestId}`)
                .setLabel('Submit Answers')
                .setStyle(ButtonStyle.Success)
        );
        rows.push(row1);
        return rows;
    } 
    
    if (isPlanMode) {
        // Plan mode has specific 3-button layout logic in legacy code, preserving but styling close to unified
        row1.addComponents(
            new ButtonBuilder()
                .setCustomId(`perm_yes_${request.requestId}`)
                .setLabel('Yes, and auto-accept')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`perm_always_${request.requestId}`)
                .setLabel('Yes, and manually approve edits')
                .setStyle(ButtonStyle.Primary),
             new ButtonBuilder()
                .setCustomId(`perm_no_${request.requestId}`)
                .setLabel('No, keep planning')
                .setStyle(ButtonStyle.Secondary)
        );
         rows.push(row1);
         return rows;
    }

    // Standard Tool Permission Layout
    
    // 1. Allow
    row1.addComponents(
        new ButtonBuilder()
            .setCustomId(`perm_yes_${request.requestId}`)
            .setLabel('Allow')
            .setStyle(ButtonStyle.Success)
    );

    // 2. Allow All (with Scope)
    // Determine scope label
    const scope = uiState.scope; // 'session' | 'localSettings' | 'userSettings' | 'projectSettings'
    let scopeLabel = 'Session';
    if (scope === 'userSettings') scopeLabel = 'Global';
    else if (scope === 'projectSettings') scopeLabel = 'Project';
    else if (scope === 'localSettings') scopeLabel = 'Local';
    
    row1.addComponents(
        new ButtonBuilder()
            .setCustomId(`perm_always_${request.requestId}`)
            .setLabel(`Allow All`)
            .setStyle(ButtonStyle.Primary)
    );

    // 3. Scope Button
    row1.addComponents(
        new ButtonBuilder()
            .setCustomId(`perm_scope_${request.requestId}`)
            .setLabel(`Scope: ${scopeLabel} 🔄`)
            .setStyle(ButtonStyle.Secondary)
    );

    // 4. Tell Claude
    row1.addComponents(
        new ButtonBuilder()
            .setCustomId(`perm_tell_${request.requestId}`)
            .setLabel('Tell Claude')
            .setStyle(ButtonStyle.Secondary)
    );

    // 5. Deny
    row1.addComponents(
        new ButtonBuilder()
            .setCustomId(`perm_no_${request.requestId}`)
            .setLabel('Deny')
            .setStyle(ButtonStyle.Danger)
    );

    rows.push(row1);

    return rows;
}
