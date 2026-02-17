/**
 * Session Wizard Handlers
 *
 * Handles the session creation wizard flow:
 *   runner selection -> CLI type -> (auto-mapped SDK plugin) -> folder -> review/customize -> start
 *
 * This module contains all the handlers for the wizard steps including:
 * - Runner/Cli/Plugin selection
 * - Navigation (back buttons)
 * - Folder selection
 * - Review & customization
 * - Model picker
 * - Session start logic
 */

import {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    ModalBuilder, TextInputBuilder, TextInputStyle,
    StringSelectMenuBuilder, StringSelectMenuOptionBuilder
} from 'discord.js';
import * as botState from '../state.js';
import { storage } from '../storage.js';
import { buildSessionStartOptions } from '../utils/session-options.js';
import { createErrorEmbed } from '../utils/embeds.js';
import { fetchRunnerModels, AUTO_MODEL_VALUE } from '../utils/models.js';
import { getCategoryManager } from '../services/category-manager.js';
import { getSessionSyncService } from '../services/session-sync.js';
import { cliToSdkPlugin, cliTypeLabel } from './button-utils.js';
import {
    safeDeferUpdate,
    safeEditReply,
    safeImmediateUpdate,
    safeUpdate
} from './interaction-safety.js';
import {
    safeReplyOrEdit,
    truncateForDiscord,
    isModelSelectableCli,
    inferCliTypeFromInteraction,
    getRunnerIdFromContext,
    getProjectPathFromContext,
    getProjectChannelIdFromContext,
    resolveSessionCreationState,
    recoverSessionCreationState
} from './session-context.js';

// Re-export context helpers for use in other modules
export {
    getRunnerIdFromContext,
    getProjectPathFromContext,
    getProjectChannelIdFromContext,
    resolveSessionCreationState
};

// ---------------------------------------------------------------------------
// Runner Selection
// ---------------------------------------------------------------------------

/**
 * Runner selection handler
 */
export async function handleRunnerSelection(interaction: any, userId: string, customId: string): Promise<void> {
    const runnerId = customId.replace('session_runner_', '');
    const runner = storage.getRunner(runnerId);
    const existingState = botState.sessionCreationState.get(userId);

    if (!runner || !storage.canUserAccessRunner(userId, runnerId)) {
        await safeReplyOrEdit(interaction, {
            embeds: [createErrorEmbed('Runner Not Found', 'Selected runner is no longer available.')],
            flags: 64
        });
        return;
    }

    botState.sessionCreationState.set(userId, {
        step: 'select_cli',
        runnerId: runnerId,
        ...(existingState?.folderPath ? { folderPath: existingState.folderPath } : {}),
        ...(existingState?.projectChannelId ? { projectChannelId: existingState.projectChannelId } : {})
    });

    // CLI type buttons (+ Terminal option)
    const cliButtons = runner.cliTypes.map(cliType =>
        new ButtonBuilder()
            .setCustomId(`session_cli_${cliType}`)
            .setLabel(cliType.toUpperCase())
            .setStyle(ButtonStyle.Primary)
    );
    cliButtons.push(
        new ButtonBuilder()
            .setCustomId('session_cli_terminal')
            .setLabel('Terminal')
            .setStyle(ButtonStyle.Secondary)
    );

    const mainButtonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(...cliButtons);
    const navButtonRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder().setCustomId('session_back_runners').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('◀️'),
            new ButtonBuilder().setCustomId('session_cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger).setEmoji('❌')
        );

    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('Select CLI Type')
        .setDescription(`**Runner:** \`${runner.name}\`\n\nSelect the CLI tool to use:\n\n**Terminal** - Plain shell session (no AI CLI)`);

    await safeUpdate(interaction, { embeds: [embed], components: [mainButtonRow, navButtonRow] });
}

// ---------------------------------------------------------------------------
// CLI Type Selection
// ---------------------------------------------------------------------------

/**
 * CLI type selection - SDK-ONLY: skips plugin selection entirely, auto-maps to SDK plugin.
 */
export async function handleCliSelection(interaction: any, userId: string, customId: string): Promise<void> {
    const cliType = customId.replace('session_cli_', '') as 'claude' | 'gemini' | 'codex' | 'terminal';

    const acknowledged = await safeDeferUpdate(
        interaction,
        'Buttons expired. Please use the latest session prompt or run /create-session.'
    );
    if (!acknowledged) return;

    let state = botState.sessionCreationState.get(userId);
    if (!state || !state.runnerId) {
        state = await recoverSessionCreationState(interaction, userId);
    }
    if (!state || !state.runnerId) {
        await safeEditReply(interaction, {
            embeds: [createErrorEmbed('Session Expired', 'Please start over with /create-session')],
            flags: 64
        });
        return;
    }

    state.cliType = cliType;

    // SDK-ONLY: auto-map CLI type to plugin - no plugin selection step
    if (cliType === 'terminal') {
        state.plugin = 'tmux';
    } else {
        state.plugin = cliToSdkPlugin(cliType);
    }

    const hasFolder = !!state.folderPath;
    const runner = storage.getRunner(state.runnerId);

    if (hasFolder) {
        // Skip folder selection, proceed to review
        state.step = 'complete';
        botState.sessionCreationState.set(userId, state);
        await handleSessionReview(interaction, userId);
        return;
    }

    // Show folder selection
    state.step = 'select_folder';
    botState.sessionCreationState.set(userId, state);

    const mainButtonRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('session_default_folder')
                .setLabel(runner?.defaultWorkspace ? `Default (${runner.defaultWorkspace})` : 'Use Runner Default')
                .setStyle(ButtonStyle.Success)
                .setEmoji('📁'),
            new ButtonBuilder()
                .setCustomId('session_custom_folder')
                .setLabel('Custom Folder')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('✏️')
        );

    const navButtonRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder().setCustomId('session_back_cli').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('◀️'),
            new ButtonBuilder().setCustomId('session_cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger).setEmoji('❌')
        );

    const pluginLabel = cliType === 'terminal' ? 'Terminal (Shell)' : `${cliTypeLabel(cliType)} SDK`;
    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('Select Working Folder')
        .setDescription(`**Runner:** \`${runner?.name}\`\n**Type:** ${pluginLabel}\n\nWhere should the session start?`);

    if (runner?.defaultWorkspace) {
        embed.addFields({ name: 'Default Folder', value: `\`${runner.defaultWorkspace}\``, inline: false });
    }

    await safeEditReply(interaction, { embeds: [embed], components: [mainButtonRow, navButtonRow] });
}

// ---------------------------------------------------------------------------
// Legacy Plugin Selection (backward compat)
// ---------------------------------------------------------------------------

/**
 * Legacy plugin selection handler - kept for backward compat with buttons already rendered.
 * New flow auto-maps to SDK, so this just accepts the selection.
 */
export async function handlePluginSelection(interaction: any, userId: string, customId: string): Promise<void> {
    const plugin = customId.replace('session_plugin_', '') as 'tmux' | 'print' | 'stream' | 'claude-sdk' | 'codex-sdk' | 'gemini-sdk';

    const acknowledged = await safeDeferUpdate(
        interaction,
        'Buttons expired. Please use the latest session prompt or run /create-session.'
    );
    if (!acknowledged) return;

    let state = botState.sessionCreationState.get(userId);
    if (!state || !state.runnerId || !state.cliType) {
        await recoverSessionCreationState(interaction, userId);
        state = botState.sessionCreationState.get(userId) ?? state;

        const inferredCli = inferCliTypeFromInteraction(interaction, plugin);
        if (state && !state.cliType && inferredCli) {
            state.cliType = inferredCli;
        }
        if (state) {
            state.step = 'select_plugin';
            botState.sessionCreationState.set(userId, state);
        }
    }

    if (!state || !state.runnerId || !state.cliType) {
        await safeEditReply(interaction, {
            embeds: [createErrorEmbed('Session Expired', 'Please start over with /create-session')],
            flags: 64
        });
        return;
    }

    state.plugin = plugin;
    const hasFolder = !!state.folderPath;

    if (hasFolder) {
        state.step = 'complete';
        botState.sessionCreationState.set(userId, state);
        await handleSessionReview(interaction, userId);
        return;
    }

    // Show folder selection
    state.step = 'select_folder';
    botState.sessionCreationState.set(userId, state);

    const runner = storage.getRunner(state.runnerId);

    const mainButtonRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('session_default_folder')
                .setLabel(runner?.defaultWorkspace ? `Default (${runner.defaultWorkspace})` : 'Use Runner Default')
                .setStyle(ButtonStyle.Success)
                .setEmoji('📁'),
            new ButtonBuilder()
                .setCustomId('session_custom_folder')
                .setLabel('Custom Folder')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('✏️')
        );

    const navButtonRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder().setCustomId('session_back_cli').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('◀️'),
            new ButtonBuilder().setCustomId('session_cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger).setEmoji('❌')
        );

    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('Select Working Folder')
        .setDescription(`**Runner:** \`${runner?.name}\`\n**CLI:** ${state.cliType.toUpperCase()}\n**Plugin:** ${plugin.toUpperCase()}\n\nWhere should the CLI run?`);

    await safeUpdate(interaction, { embeds: [embed], components: [mainButtonRow, navButtonRow] });
}

// ---------------------------------------------------------------------------
// Navigation Handlers
// ---------------------------------------------------------------------------

export async function handleBackToRunners(interaction: any, userId: string): Promise<void> {
    const runners = storage.getUserRunners(userId).filter(r => r.status === 'online');

    botState.sessionCreationState.set(userId, { step: 'select_runner' });

    const buttons = runners.slice(0, 5).map(runner =>
        new ButtonBuilder()
            .setCustomId(`session_runner_${runner.runnerId}`)
            .setLabel(runner.name)
            .setStyle(ButtonStyle.Primary)
    );
    buttons.push(
        new ButtonBuilder().setCustomId('session_cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger).setEmoji('❌')
    );

    const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);
    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('Select a Runner')
        .setDescription('Which runner do you want to use?');

    await safeUpdate(interaction, { embeds: [embed], components: [buttonRow] });
}

export async function handleBackToCli(interaction: any, userId: string): Promise<void> {
    const state = botState.sessionCreationState.get(userId);
    if (!state || !state.runnerId) {
        await safeReplyOrEdit(interaction, {
            embeds: [createErrorEmbed('Session Expired', 'Please start over')],
            flags: 64
        });
        return;
    }

    state.step = 'select_cli';
    botState.sessionCreationState.set(userId, state);

    const runner = storage.getRunner(state.runnerId);
    if (!runner) return;

    const cliButtons = runner.cliTypes.map(cliType =>
        new ButtonBuilder()
            .setCustomId(`session_cli_${cliType}`)
            .setLabel(cliType.toUpperCase())
            .setStyle(ButtonStyle.Primary)
    );
    const mainButtonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(...cliButtons);

    const navButtonRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder().setCustomId('session_back_runners').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('◀️'),
            new ButtonBuilder().setCustomId('session_cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger).setEmoji('❌')
        );

    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('Select CLI Type')
        .setDescription(`**Runner:** \`${runner.name}\`\n\nSelect the CLI tool:`);

    await safeUpdate(interaction, { embeds: [embed], components: [mainButtonRow, navButtonRow] });
}

export async function handleBackToPlugin(interaction: any, userId: string): Promise<void> {
    // With SDK-only, "back to plugin" just goes back to CLI selection
    await handleBackToCli(interaction, userId);
}

// ---------------------------------------------------------------------------
// Folder Selection
// ---------------------------------------------------------------------------

export async function handleCustomFolder(interaction: any, userId: string): Promise<void> {
    const modal = new ModalBuilder()
        .setCustomId('session_folder_modal')
        .setTitle('Enter Working Folder')
        .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                    .setCustomId('folder_path')
                    .setLabel('Folder Path')
                    .setStyle(TextInputStyle.Short)
                    .setPlaceholder('/path/to/project')
                    .setRequired(true)
                    .setMinLength(1)
                    .setMaxLength(500)
            )
        );

    await interaction.showModal(modal);
}

export async function handleDefaultFolder(interaction: any, userId: string): Promise<void> {
    const state = botState.sessionCreationState.get(userId);
    if (!state || !state.runnerId || !state.cliType) {
        await safeReplyOrEdit(interaction, {
            embeds: [createErrorEmbed('Session Expired', 'Please start over')],
            flags: 64
        });
        return;
    }

    const runner = storage.getRunner(state.runnerId);
    if (!runner) {
        await safeReplyOrEdit(interaction, {
            embeds: [createErrorEmbed('Runner Not Found', 'Runner no longer exists')],
            flags: 64
        });
        return;
    }

    const folderPath = runner.defaultWorkspace;
    if (!folderPath || folderPath === '~' || folderPath === './' || folderPath === '.') {
        await safeReplyOrEdit(interaction, {
            embeds: [createErrorEmbed('No Default Folder', 'Runner has no default workspace configured. Please use Custom Folder instead.')],
            flags: 64
        });
        return;
    }

    state.folderPath = folderPath;
    state.step = 'complete';
    botState.sessionCreationState.set(userId, state);

    await handleSessionReview(interaction, userId);
}

export async function handleSessionCancel(interaction: any, userId: string): Promise<void> {
    botState.sessionCreationState.delete(userId);

    const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('Session Creation Cancelled')
        .setDescription('You can start again with `/create-session`');

    await safeUpdate(interaction, { embeds: [embed], components: [] });
}

// ---------------------------------------------------------------------------
// Review & Customization
// ---------------------------------------------------------------------------

export async function handleSessionReview(interaction: any, userId: string): Promise<void> {
    const state = await resolveSessionCreationState(interaction, userId);
    if (!state || !state.runnerId || !state.cliType || !state.folderPath) {
        const missing: string[] = [];
        if (!state?.runnerId) missing.push('runner');
        if (!state?.cliType) missing.push('cli');
        if (!state?.folderPath) missing.push('folder');
        await safeReplyOrEdit(interaction, {
            embeds: [createErrorEmbed('Session Error', `Missing required session information${missing.length ? `: ${missing.join(', ')}` : ''}.`)],
            flags: 64
        });
        return;
    }

    const runner = storage.getRunner(state.runnerId);
    const isCodex = state.cliType === 'codex';
    const defaults = isCodex ? runner?.config?.codexDefaults : runner?.config?.claudeDefaults;

    let approvalText = state.options?.approvalMode === 'auto' ? 'Auto-Approve (YOLO)' :
                        state.options?.approvalMode === 'autoSafe' ? 'Auto-Safe (Read-Only)' :
                        'Require Approval';
    if (state.plugin === 'stream') {
        approvalText = 'Auto-Approve (Stream Mode)';
    }

    const modelText = state.options?.model || (defaults as any)?.model || 'Auto';
    const maxTurnsText = state.options?.maxTurns || (defaults as any)?.maxTurns || 'Default';
    const maxThinkingText = state.options?.maxThinkingTokens || (defaults as any)?.maxThinkingTokens || 'Default';
    const maxBudgetText = state.options?.maxBudgetUsd || (defaults as any)?.maxBudgetUsd || 'Default';
    const permissionModeText = state.options?.permissionMode || (defaults as any)?.permissionMode || 'default';

    const pluginLabel = state.cliType === 'terminal'
        ? 'Terminal (Tmux)'
        : `${cliTypeLabel(state.cliType)} SDK`;

    const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('Review & Start Session')
        .setDescription(
            `**Runner:** \`${runner?.name}\`\n` +
            `**CLI:** ${state.cliType.toUpperCase()}\n` +
            `**Plugin:** ${pluginLabel}\n` +
            `**Folder:** \`${state.folderPath}\`\n\n` +
            `**Settings:**\n` +
            `Approval Mode: \`${approvalText}\`\n` +
            `Model: \`${modelText}\`\n` +
            `Max Turns: \`${maxTurnsText}\`\n` +
            `Max Thinking: \`${maxThinkingText}\`\n` +
            `Max Budget: \`${maxBudgetText}\`\n` +
            `Permission Mode: \`${permissionModeText}\``
        );

    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder().setCustomId('session_start').setLabel('Start Session').setStyle(ButtonStyle.Success).setEmoji('🚀'),
            new ButtonBuilder().setCustomId('session_customize').setLabel('Customize Settings').setStyle(ButtonStyle.Secondary).setEmoji('⚙️'),
            new ButtonBuilder().setCustomId('session_cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger).setEmoji('❌')
        );

    const modelRows: ActionRowBuilder<ButtonBuilder>[] = [];
    if (isModelSelectableCli(state.cliType)) {
        modelRows.push(
            new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('session_pick_model').setLabel('Pick Model').setStyle(ButtonStyle.Secondary).setEmoji('🧠')
            )
        );
    }

    const components = [row, ...modelRows];

    await safeUpdate(interaction, { embeds: [embed], components });
}

export async function handleCustomizeSettings(interaction: any, userId: string): Promise<void> {
    const state = botState.sessionCreationState.get(userId);
    if (!state) return;

    const currentMode = state.options?.approvalMode || 'manual';
    const permissionMode = state.options?.permissionMode || 'default';
    const includePartials = state.options?.includePartialMessages !== false;
    const modelText = state.options?.model || 'Auto';

    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('Customize Session Settings')
        .setDescription(
            `Configure how the CLI session behaves.\n\n` +
            `**Current:**\n` +
            `Approval: \`${currentMode}\`\n` +
            `Permission Mode: \`${permissionMode}\`\n` +
            `Partials: \`${includePartials ? 'Enabled' : 'Disabled'}\`\n` +
            `Model: \`${modelText}\``
        );

    const modeRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('session_settings_approval_manual')
                .setLabel('Manual')
                .setStyle(currentMode === 'manual' ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setEmoji('🛡️'),
            new ButtonBuilder()
                .setCustomId('session_settings_approval_autosafe')
                .setLabel('Auto-Safe')
                .setStyle(currentMode === 'autoSafe' ? ButtonStyle.Primary : ButtonStyle.Secondary)
                .setEmoji('✅'),
            new ButtonBuilder()
                .setCustomId('session_settings_approval_auto')
                .setLabel('YOLO')
                .setStyle(currentMode === 'auto' ? ButtonStyle.Danger : ButtonStyle.Secondary)
                .setEmoji('⚡')
        );

    const permissionRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('session_settings_permission_default')
                .setLabel('Permission: Default')
                .setStyle(permissionMode === 'default' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('session_settings_permission_accept')
                .setLabel('Permission: Accept Edits')
                .setStyle(permissionMode === 'acceptEdits' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('session_settings_partials_toggle')
                .setLabel(includePartials ? 'Disable Partials' : 'Enable Partials')
                .setStyle(includePartials ? ButtonStyle.Secondary : ButtonStyle.Success)
        );

    const limitsRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder().setCustomId('session_settings_modal:model').setLabel('Set Model').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('session_settings_modal:maxTurns').setLabel('Set Max Turns').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('session_settings_modal:maxThinkingTokens').setLabel('Set Max Thinking').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('session_settings_modal:maxBudgetUsd').setLabel('Set Max Budget').setStyle(ButtonStyle.Secondary)
        );

    const navRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder().setCustomId('session_settings_modal:agent').setLabel('Set Agent').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId('session_settings_back')
                .setLabel('Back to Review')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('↩️')
        );

    await safeUpdate(interaction, {
        embeds: [embed],
        components: [modeRow, permissionRow, limitsRow, navRow]
    });
}

export async function handleSessionSettings(interaction: any, userId: string, customId: string): Promise<void> {
    const state = botState.sessionCreationState.get(userId);
    if (!state) return;

    if (!state.options) state.options = {};

    if (customId === 'session_settings_approval_manual') {
        state.options.approvalMode = 'manual';
    } else if (customId === 'session_settings_approval_autosafe') {
        state.options.approvalMode = 'autoSafe';
    } else if (customId === 'session_settings_approval_auto') {
        state.options.approvalMode = 'auto';
    } else if (customId === 'session_settings_permission_default') {
        state.options.permissionMode = 'default';
    } else if (customId === 'session_settings_permission_accept') {
        state.options.permissionMode = 'acceptEdits';
    } else if (customId === 'session_settings_partials_toggle') {
        state.options.includePartialMessages = state.options.includePartialMessages === false ? true : false;
    } else if (customId === 'session_settings_toggle:strictMcpConfig') {
        state.options.strictMcpConfig = !state.options.strictMcpConfig;
    } else if (customId === 'session_settings_back') {
        await handleSessionReview(interaction, userId);
        return;
    }

    botState.sessionCreationState.set(userId, state);
    await handleCustomizeSettings(interaction, userId);
}

export async function handleSessionSettingsModal(interaction: any, userId: string, customId: string): Promise<void> {
    const state = botState.sessionCreationState.get(userId);
    if (!state) return;

    const param = customId.split(':')[1];
    const modal = new ModalBuilder()
        .setCustomId(`session_settings_modal_submit:${param}`)
        .setTitle('Update Session Setting');

    const input = new TextInputBuilder()
        .setRequired(false)
        .setStyle(TextInputStyle.Short);

    const labelMap: Record<string, { id: string; label: string }> = {
        model: { id: 'model', label: 'Model (blank to clear)' },
        fallbackModel: { id: 'fallbackModel', label: 'Fallback Model (blank to clear)' },
        maxTurns: { id: 'maxTurns', label: 'Max Turns (blank to clear)' },
        maxThinkingTokens: { id: 'maxThinkingTokens', label: 'Max Thinking Tokens (blank to clear)' },
        maxBudgetUsd: { id: 'maxBudgetUsd', label: 'Max Budget USD (blank to clear)' },
        agent: { id: 'agent', label: 'Agent Name (blank to clear)' },
        allowedTools: { id: 'allowedTools', label: 'Allowed Tools (comma-separated)' },
        disallowedTools: { id: 'disallowedTools', label: 'Disallowed Tools (comma-separated)' },
        toolsList: { id: 'toolsList', label: 'Tools List (comma-separated or "default")' },
        betas: { id: 'betas', label: 'Betas (comma-separated)' },
        settingSources: { id: 'settingSources', label: 'Setting Sources (comma-separated)' },
        additionalDirectories: { id: 'additionalDirectories', label: 'Additional Dirs (comma-separated)' },
        jsonSchema: { id: 'jsonSchema', label: 'JSON Schema (JSON)' },
        mcpServers: { id: 'mcpServers', label: 'MCP Servers (JSON)' },
        plugins: { id: 'plugins', label: 'Plugins (JSON array)' },
        extraArgs: { id: 'extraArgs', label: 'Extra Args (JSON object)' },
        sandbox: { id: 'sandbox', label: 'Sandbox (string)' }
    };

    const mapping = labelMap[param];
    if (!mapping) {
        await safeReplyOrEdit(interaction, { content: 'Unknown session setting.', flags: 64 });
        return;
    }

    input.setCustomId(mapping.id).setLabel(mapping.label);

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input);
    modal.addComponents(row);
    await interaction.showModal(modal);
}

// ---------------------------------------------------------------------------
// Model Picker
// ---------------------------------------------------------------------------

const sessionModelPickerRequests = new Map<string, string>();

function getSessionModelPickerRequestKey(interaction: any, userId: string, runnerId: string, cliType: 'claude' | 'codex'): string {
    const messageId = interaction?.message?.id || 'no-message';
    return `${userId}:${messageId}:${runnerId}:${cliType}`;
}

export async function handleSessionModelPicker(interaction: any, userId: string, forceRefresh: boolean = false): Promise<void> {
    const state = await resolveSessionCreationState(interaction, userId);
    if (!state || !state.runnerId || !state.cliType) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Session Expired', 'Please restart with /create-session.')],
            components: []
        });
        return;
    }

    if (!isModelSelectableCli(state.cliType)) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Model Selection Unavailable', `Model picker is only available for Claude and Codex sessions.`)],
            components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId('session_review').setLabel('Back').setStyle(ButtonStyle.Secondary)
                )
            ]
        });
        return;
    }

    const runner = storage.getRunner(state.runnerId);
    if (!runner) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Runner Not Found', 'Runner no longer exists.')],
            components: []
        });
        return;
    }

    const requestKey = getSessionModelPickerRequestKey(interaction, userId, state.runnerId, state.cliType);
    const requestToken = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    sessionModelPickerRequests.set(requestKey, requestToken);

    try {
        const loadingEmbed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle(`Loading ${state.cliType.toUpperCase()} Models`)
            .setDescription(`Runner: \`${runner.name}\`\nFetching available models from the runner...`);

        await safeEditReply(interaction, {
            embeds: [loadingEmbed],
            components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId('session_pick_model_refresh').setLabel('Fetching...').setStyle(ButtonStyle.Secondary).setDisabled(true),
                    new ButtonBuilder().setCustomId('session_review').setLabel('Back to Review').setStyle(ButtonStyle.Secondary)
                )
            ]
        });

        const result = await fetchRunnerModels(state.runnerId, state.cliType, { forceRefresh, limit: 100 });
        if (sessionModelPickerRequests.get(requestKey) !== requestToken) return;

        if (result.error) {
            const errorText = result.error === 'Runner timed out while fetching models.'
                ? `${result.error} The CLI may still be warming up.`
                : result.error;
            await safeEditReply(interaction, {
                embeds: [createErrorEmbed('Model Fetch Failed', errorText)],
                components: [
                    new ActionRowBuilder<ButtonBuilder>().addComponents(
                        new ButtonBuilder().setCustomId('session_pick_model_refresh').setLabel('Retry').setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder().setCustomId('session_review').setLabel('Back').setStyle(ButtonStyle.Secondary)
                    )
                ]
            });
            return;
        }

        const currentOverride = state.options?.model;
        const runnerDefault = state.cliType === 'claude'
            ? runner.config?.claudeDefaults?.model
            : runner.config?.codexDefaults?.model;

        const options = [
            new StringSelectMenuOptionBuilder()
                .setLabel('Auto (use runner default)')
                .setValue(AUTO_MODEL_VALUE)
                .setDescription('Do not set a per-session model override.')
                .setDefault(!currentOverride),
            ...result.models.slice(0, 24).map(model => {
                const option = new StringSelectMenuOptionBuilder()
                    .setLabel(truncateForDiscord(model.label || model.id, 100))
                    .setValue(model.id)
                    .setDefault(currentOverride === model.id);
                const description = model.description
                    ? truncateForDiscord(model.description, 100)
                    : (model.isDefault ? 'Marked default by CLI.' : `Model ID: ${model.id}`);
                option.setDescription(description);
                return option;
            })
        ];

        if (currentOverride && !result.models.some(model => model.id === currentOverride)) {
            if (options.length >= 25) options.pop();
            options.push(
                new StringSelectMenuOptionBuilder()
                    .setLabel(truncateForDiscord(`Current override: ${currentOverride}`, 100))
                    .setValue(currentOverride)
                    .setDescription('Current override is not in the fetched catalog.')
                    .setDefault(true)
            );
        }

        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle(`Select ${state.cliType.toUpperCase()} Model`)
            .setDescription(
                `Runner: \`${runner.name}\`\n` +
                `Override: \`${currentOverride || 'Auto'}\`\n` +
                `Runner default: \`${runnerDefault || 'Auto'}\`\n` +
                `Available models: **${result.models.length}**${result.models.length > 24 ? ' (showing first 24)' : ''}`
            );

        const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>()
            .addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId('session_select_model')
                    .setPlaceholder('Choose model override...')
                    .addOptions(options)
            );

        const actionsRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder().setCustomId('session_pick_model_refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary),
                new ButtonBuilder().setCustomId('session_review').setLabel('Back to Review').setStyle(ButtonStyle.Primary)
            );

        await safeEditReply(interaction, { embeds: [embed], components: [selectRow, actionsRow] });
    } finally {
        if (sessionModelPickerRequests.get(requestKey) === requestToken) {
            sessionModelPickerRequests.delete(requestKey);
        }
    }
}

export async function handleSessionModelSelected(interaction: any, userId: string): Promise<void> {
    const state = await resolveSessionCreationState(interaction, userId);
    if (!state) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Session Expired', 'Please restart with /create-session.')],
            components: []
        });
        return;
    }

    if (!state.options) state.options = {};

    const selected = interaction.values?.[0];
    if (!selected || selected === AUTO_MODEL_VALUE) {
        delete state.options.model;
    } else {
        state.options.model = selected;
    }

    botState.sessionCreationState.set(userId, state);
    await handleSessionReview(interaction, userId);
}

// ---------------------------------------------------------------------------
// Start Session
// ---------------------------------------------------------------------------

export async function handleStartSession(interaction: any, userId: string): Promise<void> {
    const state = await resolveSessionCreationState(interaction, userId);

    if (!state || !state.runnerId || !state.cliType || !state.folderPath) {
        const missing: string[] = [];
        if (!state?.runnerId) missing.push('runner');
        if (!state?.cliType) missing.push('cli');
        if (!state?.folderPath) missing.push('folder');
        await safeReplyOrEdit(interaction, {
            embeds: [createErrorEmbed('Session Error', `Missing required session information${missing.length ? `: ${missing.join(', ')}` : ''}.`)],
            flags: 64
        });
        return;
    }

    const runner = storage.getRunner(state.runnerId);
    if (!runner) {
        await safeReplyOrEdit(interaction, {
            embeds: [createErrorEmbed('Runner Not Found', 'Runner no longer exists')],
            flags: 64
        });
        return;
    }

    const pluginLabel = state.cliType === 'terminal' ? 'Terminal' : `${cliTypeLabel(state.cliType)} SDK`;

    const initializingEmbed = new EmbedBuilder()
        .setColor(0xFFFF00)
        .setTitle('Initializing Session...')
        .setDescription('Request sent to runner. Waiting for confirmation...')
        .addFields(
            { name: 'Runner', value: runner.name, inline: true },
            { name: 'CLI Type', value: state.cliType.toUpperCase(), inline: true },
            { name: 'Plugin', value: pluginLabel, inline: true },
            { name: 'Approval', value: state.options?.approvalMode === 'auto' ? 'YOLO' :
                                    state.options?.approvalMode === 'autoSafe' ? 'Auto-Safe' : 'Manual', inline: true },
            { name: 'Working Folder', value: `\`\`\`${state.folderPath}\`\`\``, inline: false }
        )
        .setTimestamp();

    const updated = await safeImmediateUpdate(
        interaction,
        { embeds: [initializingEmbed], components: [] },
        'Buttons expired. Please start the session again.'
    );
    if (!updated) return;

    const folderPath = state.folderPath;

    const { getOrCreateRunnerChannel } = await import('../utils/channels.js');
    const { ChannelType } = await import('discord.js');
    const { randomUUID } = await import('crypto');

    let channelId: string | undefined = state.projectChannelId;
    if (!channelId) {
        const categoryManager = getCategoryManager();
        if (categoryManager) {
            try {
                channelId = await categoryManager.ensureProjectChannel(runner.runnerId, folderPath);
            } catch (error) {
                console.warn('[SessionButtons] Failed to resolve project channel, falling back:', error);
            }
        }
    }

    if (!channelId) {
        if (!runner.privateChannelId) {
            const guildId = interaction.guildId;
            if (!guildId) {
                await safeReplyOrEdit(interaction, {
                    embeds: [createErrorEmbed('Cannot Create Session', 'Cannot determine guild ID.')],
                    flags: 64
                });
                return;
            }
            channelId = await getOrCreateRunnerChannel(runner, guildId);
        } else {
            channelId = runner.privateChannelId;
        }
    }

    try {
        const channel = await botState.client.channels.fetch(channelId);
        if (!channel || !('threads' in channel)) {
            await safeReplyOrEdit(interaction, {
                embeds: [createErrorEmbed('Cannot Create Thread', 'Cannot access runner channel.')],
                flags: 64
            });
            return;
        }

        const textChannel = channel as any;
        const threadType = channelId === runner.privateChannelId
            ? ChannelType.PrivateThread
            : ChannelType.PublicThread;

        const thread = await textChannel.threads.create({
            name: `${state.cliType.toUpperCase()}-${Date.now()}`,
            type: threadType,
            invitable: threadType === ChannelType.PrivateThread ? false : undefined,
            reason: `CLI session for ${state.cliType}`
        });

        const storageCLIType = state.cliType === 'terminal' ? 'generic' : state.cliType;

        const session = {
            sessionId: randomUUID(),
            runnerId: runner.runnerId,
            channelId: channel.id,
            threadId: thread.id,
            createdAt: new Date().toISOString(),
            status: 'active' as const,
            cliType: storageCLIType as 'claude' | 'gemini' | 'codex' | 'generic',
            plugin: state.plugin as 'tmux' | 'print' | 'stream' | 'claude-sdk' | 'codex-sdk' | 'gemini-sdk' | undefined,
            folderPath: folderPath,
            interactionToken: interaction.token,
            creatorId: interaction.user.id
        };

        storage.createSession(session);
        botState.actionItems.set(session.sessionId, []);

        if (state.cliType === 'claude' || state.cliType === 'codex') {
            const sessionSync = getSessionSyncService();
            sessionSync?.markSessionAsOwned(session.sessionId, state.cliType);
        }

        await thread.members.add(interaction.user.id);

        for (const authUserId of runner.authorizedUsers) {
            if (authUserId && authUserId !== interaction.user.id) {
                try {
                    await thread.members.add(authUserId);
                } catch (error) {
                    console.error(`Failed to add user ${authUserId} to thread:`, error);
                }
            }
        }

        const ws = botState.runnerConnections.get(runner.runnerId);
        if (ws) {
            const startOptions = buildSessionStartOptions(runner, state.options, undefined, state.cliType);
            storage.updateSession(session.sessionId, { options: startOptions } as any);

            ws.send(JSON.stringify({
                type: 'session_start',
                data: {
                    sessionId: session.sessionId,
                    runnerId: runner.runnerId,
                    cliType: state.cliType,
                    folderPath: folderPath,
                    plugin: state.plugin,
                    options: startOptions
                }
            }));

            botState.sessionCreationState.delete(userId);
            console.log(`[SessionButtons] Session ${session.sessionId} created with plugin=${state.plugin}`);
        } else {
            await safeReplyOrEdit(interaction, {
                embeds: [createErrorEmbed('Runner Offline', 'Runner disconnected while creating session.')],
                flags: 64
            });
        }
    } catch (error) {
        console.error('[SessionButtons] Error creating session:', error);
        await safeReplyOrEdit(interaction, {
            embeds: [createErrorEmbed('Internal Error', 'Failed to create session')],
            flags: 64
        });
    }
}

// ---------------------------------------------------------------------------
// Prompt & Create Folder
// ---------------------------------------------------------------------------

export async function handlePromptButton(interaction: any, userId: string, customId: string): Promise<void> {
    const sessionId = customId.replace('prompt_', '');
    const session = storage.getSession(sessionId);

    if (!session || session.status !== 'active') {
        await safeReplyOrEdit(interaction, { content: 'This session is no longer active.', flags: 64 });
        return;
    }

    const runner = storage.getRunner(session.runnerId);
    if (!runner || !storage.canUserAccessRunner(userId, session.runnerId)) {
        await safeReplyOrEdit(interaction, { content: 'You do not have permission to use this session.', flags: 64 });
        return;
    }

    const modal = new ModalBuilder()
        .setCustomId(`prompt_modal_${sessionId}`)
        .setTitle('Send Prompt to CLI')
        .addComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
                new TextInputBuilder()
                    .setCustomId('prompt_input')
                    .setLabel('Your prompt')
                    .setStyle(TextInputStyle.Paragraph)
                    .setPlaceholder('Enter your prompt for the CLI...')
                    .setRequired(true)
                    .setMinLength(1)
                    .setMaxLength(4000)
            )
        );

    await interaction.showModal(modal);
}

export async function handleCreateFolderRetry(interaction: any, userId: string, customId: string): Promise<void> {
    const sessionId = customId.replace('create_folder_', '');
    const session = storage.getSession(sessionId);

    if (!session) {
        await safeReplyOrEdit(interaction, { content: 'Session not found.', flags: 64 });
        return;
    }

    const runner = storage.getRunner(session.runnerId);
    if (!runner) {
        await safeReplyOrEdit(interaction, { content: 'Runner not found.', flags: 64 });
        return;
    }

    const ws = botState.runnerConnections.get(runner.runnerId);
    if (ws) {
        const startOptions = buildSessionStartOptions(runner, undefined, undefined, session.cliType);
        ws.send(JSON.stringify({
            type: 'session_start',
            data: {
                sessionId: session.sessionId,
                runnerId: runner.runnerId,
                cliType: session.cliType,
                folderPath: session.folderPath,
                create: true,
                options: startOptions
            }
        }));

        await safeReplyOrEdit(interaction, {
            content: `Creating folder \`${session.folderPath}\` and retrying...`,
            flags: 64
        });
    } else {
        await safeReplyOrEdit(interaction, { content: 'Runner is offline.', flags: 64 });
    }
}
