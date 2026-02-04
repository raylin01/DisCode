/**
 * Button Interaction Handlers
 *
 * Handles all button clicks from Discord UI.
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import * as botState from '../state.js';
import { storage } from '../storage.js';
import { createErrorEmbed, createApprovalDecisionEmbed } from '../utils/embeds.js';
import { handlePermissionButton, rebuildPermissionButtons, handleTellClaudeModal } from './permission-buttons.js';

/**
 * Main button interaction dispatcher
 */
export async function handleButtonInteraction(interaction: any): Promise<void> {
    const customId = interaction.customId;
    const userId = interaction.user.id;

    // Handle prompt buttons (open modal)
    if (customId.startsWith('prompt_')) {
        await handlePromptButton(interaction, userId, customId);
        return;
    }

    // Handle create folder retry button
    if (customId.startsWith('create_folder_')) {
        await handleCreateFolderRetry(interaction, userId, customId);
        return;
    }

    // Handle multi-select toggle buttons
    if (customId.startsWith('multiselect_') && !customId.startsWith('multiselect_submit_')) {
        await handleMultiSelectToggle(interaction, userId, customId);
        return;
    }

    // Handle multi-select submit button
    if (customId.startsWith('multiselect_submit_')) {
        await handleMultiSelectSubmit(interaction, userId, customId);
        return;
    }

    // Handle Other button (open modal for custom input)
    if (customId.startsWith('other_')) {
        await handleOtherButton(interaction, userId, customId);
        return;
    }

    // Handle TmuxPlugin option buttons
    if (customId.startsWith('option_')) {
        await handleOptionButton(interaction, userId, customId);
        return;
    }

    // Handle NEW permission buttons (with scope support)
    if (customId.startsWith('perm_')) {
        await handlePermissionButton(interaction, userId, customId);
        return;
    }

    // Handle unified permission buttons (scope, tell)
    if (customId.startsWith('scope_')) {
        const requestId = customId.replace('scope_', '');
        await handleScopeButton(interaction, userId, requestId);
        return;
    }

    if (customId.startsWith('tell_')) {
        const requestId = customId.replace('tell_', '');
        await handleTellClaude(interaction, userId, requestId);
        return;
    }

    // Handle approval buttons
    if (customId.startsWith('allow_') || customId.startsWith('deny_')) {
        await handleApprovalButton(interaction, userId, customId);
        return;
    }

    // Handle session creation buttons
    if (customId.startsWith('session_runner_')) {
        await handleRunnerSelection(interaction, userId, customId);
        return;
    }

    if (customId.startsWith('session_cli_')) {
        await handleCliSelection(interaction, userId, customId);
        return;
    }

    if (customId.startsWith('session_plugin_')) {
        await handlePluginSelection(interaction, userId, customId);
        return;
    }

    if (customId === 'session_back_runners') {
        await handleBackToRunners(interaction, userId);
        return;
    }

    if (customId === 'session_back_cli') {
        await handleBackToCli(interaction, userId);
        return;
    }

    if (customId === 'session_back_plugin') {
        await handleBackToPlugin(interaction, userId);
        return;
    }

    if (customId === 'session_custom_folder') {
        await handleCustomFolder(interaction, userId);
        return;
    }

    if (customId === 'session_cancel') {
        await handleSessionCancel(interaction, userId);
        return;
    }

    if (customId === 'session_default_folder') {
        await handleDefaultFolder(interaction, userId);
        return;
    }

    // New Session Routes
    if (customId === 'session_start') {
        await handleStartSession(interaction, userId);
        return;
    }

    if (customId === 'session_customize') {
        await handleCustomizeSettings(interaction, userId);
        return;
    }

    if (customId.startsWith('session_settings_')) {
        await handleSessionSettings(interaction, userId, customId);
        return;
    }
}

/**
 * Handle prompt button - opens modal
 */
async function handlePromptButton(interaction: any, userId: string, customId: string): Promise<void> {
    const sessionId = customId.replace('prompt_', '');
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

/**
 * Handle create folder retry button
 */
async function handleCreateFolderRetry(interaction: any, userId: string, customId: string): Promise<void> {
    const sessionId = customId.replace('create_folder_', '');
    const session = storage.getSession(sessionId);

    if (!session) {
        await interaction.reply({
            content: 'Session not found.',
            flags: 64
        });
        return;
    }

    const runner = storage.getRunner(session.runnerId);
    if (!runner) {
        await interaction.reply({
            content: 'Runner not found.',
            flags: 64
        });
        return;
    }

    const ws = botState.runnerConnections.get(runner.runnerId);
    if (ws) {
        ws.send(JSON.stringify({
            type: 'session_start',
            data: {
                sessionId: session.sessionId,
                runnerId: runner.runnerId,
                cliType: session.cliType,
                folderPath: session.folderPath,
                create: true
            }
        }));

        await interaction.reply({
            content: `Creating folder \`${session.folderPath}\` and retrying...`,
            flags: 64
        });
    } else {
        await interaction.reply({
            content: 'Runner is offline.',
            flags: 64
        });
    }
}

/**
 * Handle TmuxPlugin option buttons
 */
async function handleOptionButton(interaction: any, userId: string, customId: string): Promise<void> {
    // Format: option_<requestId>_<optionNumber>
    // requestId may contain underscores (e.g. req_123_abc)

    // Find last underscore for option number
    const lastUnderscoreIndex = customId.lastIndexOf('_');
    const optionNumber = customId.substring(lastUnderscoreIndex + 1);

    // Extract requestId (everything between 'option_' and last underscore)
    const requestId = customId.substring('option_'.length, lastUnderscoreIndex);

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
            embeds: [createErrorEmbed('Unauthorized', 'You are not authorized to approve this request.')],
            flags: 64
        });
        return;
    }

    const ws = botState.runnerConnections.get(pending.runnerId);
    if (ws) {
        ws.send(JSON.stringify({
            type: 'approval_response',
            data: {
                sessionId: pending.sessionId,
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
    const embed = createApprovalDecisionEmbed(true, pending.toolName, interaction.user.username, `Option ${optionNumber}`);

    await interaction.update({
        embeds: [embed],
        components: [row]
    });

    botState.pendingApprovals.delete(requestId);
    botState.streamingMessages.delete(pending.sessionId);
}

/**
 * Handle approval buttons (allow/deny/modify/allow_all)
 */
async function handleApprovalButton(interaction: any, userId: string, customId: string): Promise<void> {
    if (customId.startsWith('allow_all_')) {
        const requestId = customId.replace('allow_all_', '');
        await handleAllowAll(interaction, userId, requestId);
        return;
    }

    if (customId.startsWith('allow_all_')) {
        const requestId = customId.replace('allow_all_', '');
        await handleAllowAll(interaction, userId, requestId);
        return;
    }

    const action = customId.split('_')[0];
    const requestId = customId.substring(action.length + 1);

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
            embeds: [createErrorEmbed('Unauthorized', 'You are not authorized to approve this request.')],
            flags: 64
        });
        return;
    }

    const allow = action === 'allow';

    const ws = botState.runnerConnections.get(pending.runnerId);
    if (ws) {
        ws.send(JSON.stringify({
            type: 'approval_response',
            data: {
                requestId,
                sessionId: pending.sessionId,
                optionNumber: allow ? '1' : '2',
                allow,
                message: allow ? 'Approved via Discord' : 'Denied via Discord'
            }
        }));
    }

    const resultButton = new ButtonBuilder()
        .setCustomId(`result_${requestId}`)
        .setLabel(allow ? '✅ Allowed' : '❌ Denied')
        .setStyle(allow ? ButtonStyle.Success : ButtonStyle.Danger)
        .setDisabled(true);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(resultButton);
    const embed = createApprovalDecisionEmbed(allow, pending.toolName, interaction.user.username, undefined, pending.toolInput as Record<string, any>);

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
 * Handle Allow All button
 */
async function handleAllowAll(interaction: any, userId: string, requestId: string): Promise<void> {
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
            embeds: [createErrorEmbed('Unauthorized', 'You are not authorized to approve this request.')],
            flags: 64
        });
        return;
    }

    // Add to allowed tools
    let sessionTools = botState.allowedTools.get(pending.sessionId);
    if (!sessionTools) {
        sessionTools = new Set();
        botState.allowedTools.set(pending.sessionId, sessionTools);
    }
    sessionTools.add(pending.toolName);

    const ws = botState.runnerConnections.get(pending.runnerId);
    if (ws) {
        ws.send(JSON.stringify({
            type: 'approval_response',
            data: {
                requestId,
                sessionId: pending.sessionId,
                optionNumber: '3',
                allow: true,
                message: `Approved. Tool ${pending.toolName} is now auto-approved for this session.`
            }
        }));
    }

    // Determine scope from user preference
    const scope = botState.userScopePreferences.get(userId) || 'session';
    const scopeLabel = scope === 'global' ? 'Global' : scope.charAt(0).toUpperCase() + scope.slice(1);

    const resultButton = new ButtonBuilder()
        .setCustomId(`result_${requestId}`)
        .setLabel(`✅ Auto-Approved (${scopeLabel})`)
        .setStyle(ButtonStyle.Success)
        .setDisabled(true);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(resultButton);
    const embed = createApprovalDecisionEmbed(true, pending.toolName, interaction.user.username, 'auto-approved for session');

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
 * Handle Scope button - cycles through scopes
 */
async function handleScopeButton(interaction: any, userId: string, requestId: string): Promise<void> {
    const currentScope = botState.userScopePreferences.get(userId) || 'session';
    let nextScope: botState.UserScope;

    switch (currentScope) {
        case 'session': nextScope = 'project'; break;
        case 'project': nextScope = 'global'; break;
        case 'global': nextScope = 'session'; break;
        default: nextScope = 'session';
    }

    // Save preference
    botState.userScopePreferences.set(userId, nextScope);

    // Update button label
    const scopeLabel = nextScope === 'global' ? 'Global' : nextScope.charAt(0).toUpperCase() + nextScope.slice(1);
    
    // Reconstruct the row with updated scope button
    // We need to fetch the message components and just update the scope button
    const oldComponents = interaction.message.components[0].components;
    
    // Map components to new builders
    const newComponents = oldComponents.map((comp: any) => {
        const builder = ButtonBuilder.from(comp);
        if (comp.customId === `scope_${requestId}`) {
            builder.setLabel(`Scope: ${scopeLabel} 🔄`);
        }
        return builder;
    });

    await interaction.update({
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(newComponents)]
    });
}

/**
 * Handle Tell Claude button - opens modal
 */
async function handleTellClaude(interaction: any, userId: string, requestId: string): Promise<void> {
    const pending = botState.pendingApprovals.get(requestId);
    if (!pending) {
        await interaction.reply({
            embeds: [createErrorEmbed('Expired', 'This approval request has expired.')],
            flags: 64
        });
        return;
    }

    // Use shared modal handler from permission-buttons logic if available, 
    // or create a new modal here. Currently we reuse the simpler logic.
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

// Session creation handlers
async function handleRunnerSelection(interaction: any, userId: string, customId: string): Promise<void> {
    const runnerId = customId.replace('session_runner_', '');
    const runner = storage.getRunner(runnerId);

    if (!runner || !storage.canUserAccessRunner(userId, runnerId)) {
        await interaction.reply({
            embeds: [createErrorEmbed('Runner Not Found', 'Selected runner is no longer available.')],
            flags: 64
        });
        return;
    }

    botState.sessionCreationState.set(userId, {
        step: 'select_cli',
        runnerId: runnerId
    });

    // Row 1: CLI type buttons + Terminal option
    const cliButtons = runner.cliTypes.map(cliType =>
        new ButtonBuilder()
            .setCustomId(`session_cli_${cliType}`)
            .setLabel(cliType.toUpperCase())
            .setStyle(ButtonStyle.Primary)
    );

    // Add Terminal option
    cliButtons.push(
        new ButtonBuilder()
            .setCustomId('session_cli_terminal')
            .setLabel('Terminal')
            .setStyle(ButtonStyle.Secondary)
    );

    const mainButtonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(...cliButtons);

    // Row 2: Navigation buttons
    const navButtonRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('session_back_runners')
                .setLabel('Back')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('◀️'),
            new ButtonBuilder()
                .setCustomId('session_cancel')
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('❌')
        );

    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('Select CLI Type')
        .setDescription(`**Runner:** \`${runner.name}\`\n\nSelect the CLI tool to use:\n\n**Terminal** - Plain shell session (no AI CLI)`);

    await interaction.update({
        embeds: [embed],
        components: [mainButtonRow, navButtonRow]
    });
}

async function handleCliSelection(interaction: any, userId: string, customId: string): Promise<void> {
    const cliType = customId.replace('session_cli_', '') as 'claude' | 'gemini' | 'terminal';

    const state = botState.sessionCreationState.get(userId);
    if (!state || !state.runnerId) {
        await interaction.reply({
            embeds: [createErrorEmbed('Session Expired', 'Please start over with /create-session')],
            flags: 64
        });
        return;
    }

    state.cliType = cliType;

    const runner = storage.getRunner(state.runnerId);

    // For terminal type, skip plugin selection and go directly to folder selection with tmux
    if (cliType === 'terminal') {
        state.plugin = 'tmux';
        state.step = 'select_folder';
        botState.sessionCreationState.set(userId, state);

        // Row 1: Main action buttons
        const mainButtonRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('session_folder_default')
                    .setLabel('Use Default Folder')
                    .setStyle(ButtonStyle.Success)
                    .setEmoji('📁'),
                new ButtonBuilder()
                    .setCustomId('session_folder_custom')
                    .setLabel('Custom Folder')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('✏️')
            );

        // Row 2: Navigation buttons
        const navButtonRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId('session_back_cli')
                    .setLabel('Back')
                    .setStyle(ButtonStyle.Secondary)
                    .setEmoji('◀️'),
                new ButtonBuilder()
                    .setCustomId('session_cancel')
                    .setLabel('Cancel')
                    .setStyle(ButtonStyle.Danger)
                    .setEmoji('❌')
            );

        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('Select Working Folder')
            .setDescription(`**Runner:** \`${runner?.name}\`\n**Type:** Terminal (Shell)\n\nWhere should the terminal session start?`);

        if (runner?.defaultWorkspace) {
            embed.addFields({ name: 'Default Folder', value: `\`${runner.defaultWorkspace}\``, inline: false });
        }

        await interaction.update({
            embeds: [embed],
            components: [mainButtonRow, navButtonRow]
        });
        return;
    }

    // For AI CLI types, show plugin selection
    state.step = 'select_plugin';
    botState.sessionCreationState.set(userId, state);

    // Build plugin buttons based on CLI type
    const pluginButtons: ButtonBuilder[] = [
        new ButtonBuilder()
            .setCustomId('session_plugin_tmux')
            .setLabel('Interactive (Tmux)')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('session_plugin_print')
            .setLabel('Basic (Print)')
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId('session_plugin_claude-sdk')
            .setLabel('Claude SDK')
            .setStyle(ButtonStyle.Primary)
    ];

    // Add Streaming option for Gemini
    if (cliType === 'gemini') {
        pluginButtons.push(
            new ButtonBuilder()
                .setCustomId('session_plugin_stream')
                .setLabel('Streaming')
                .setStyle(ButtonStyle.Primary)
        );
    }

    // Row 1: Main action buttons
    const mainButtonRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(...pluginButtons);

    // Row 2: Navigation buttons
    const navButtonRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('session_back_cli')
                .setLabel('Back')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('◀️'),
            new ButtonBuilder()
                .setCustomId('session_cancel')
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('❌')
        );

    const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('Select Plugin Type')
        .setDescription(`**Runner:** \`${runner?.name}\`\n**CLI:** ${cliType.toUpperCase()}\n\nSelect how you want to interact:`);

    await interaction.update({
        embeds: [embed],
        components: [mainButtonRow, navButtonRow]
    });
}

async function handlePluginSelection(interaction: any, userId: string, customId: string): Promise<void> {
    const plugin = customId.replace('session_plugin_', '') as 'tmux' | 'print' | 'stream' | 'claude-sdk';

    const state = botState.sessionCreationState.get(userId);
    if (!state || !state.runnerId || !state.cliType) {
        await interaction.reply({
            embeds: [createErrorEmbed('Session Expired', 'Please start over with /create-session')],
            flags: 64
        });
        return;
    }

    state.plugin = plugin;
    state.step = 'select_folder';
    botState.sessionCreationState.set(userId, state);

    const runner = storage.getRunner(state.runnerId);

    // Row 1: Main action buttons
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

    // Row 2: Navigation buttons
    const navButtonRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('session_back_plugin')
                .setLabel('Back')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('◀️'),
            new ButtonBuilder()
                .setCustomId('session_cancel')
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('❌')
        );

    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('Select Working Folder')
        .setDescription(`**Runner:** \`${runner?.name}\`\n**CLI:** ${state.cliType.toUpperCase()}\n**Plugin:** ${plugin.toUpperCase()}\n\nWhere should the CLI run?`);

    await interaction.update({
        embeds: [embed],
        components: [mainButtonRow, navButtonRow]
    });
}

async function handleBackToRunners(interaction: any, userId: string): Promise<void> {
    const runners = storage.getUserRunners(userId).filter(r => r.status === 'online');

    botState.sessionCreationState.set(userId, { step: 'select_runner' });

    const buttons = runners.slice(0, 5).map(runner =>
        new ButtonBuilder()
            .setCustomId(`session_runner_${runner.runnerId}`)
            .setLabel(runner.name)
            .setStyle(ButtonStyle.Primary)
    );
    buttons.push(
        new ButtonBuilder()
            .setCustomId('session_cancel')
            .setLabel('Cancel')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌')
    );

    const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons);

    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('Select a Runner')
        .setDescription('Which runner do you want to use?');

    await interaction.update({
        embeds: [embed],
        components: [buttonRow]
    });
}

async function handleBackToCli(interaction: any, userId: string): Promise<void> {
    const state = botState.sessionCreationState.get(userId);
    if (!state || !state.runnerId) {
        await interaction.reply({
            embeds: [createErrorEmbed('Session Expired', 'Please start over')],
            flags: 64
        });
        return;
    }

    state.step = 'select_cli';
    botState.sessionCreationState.set(userId, state);

    const runner = storage.getRunner(state.runnerId);
    if (!runner) return;

    // Row 1: CLI type buttons
    const cliButtons = runner.cliTypes.map(cliType =>
        new ButtonBuilder()
            .setCustomId(`session_cli_${cliType}`)
            .setLabel(cliType.toUpperCase())
            .setStyle(ButtonStyle.Primary)
    );
    const mainButtonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(...cliButtons);

    // Row 2: Navigation buttons
    const navButtonRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('session_back_runners')
                .setLabel('Back')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('◀️'),
            new ButtonBuilder()
                .setCustomId('session_cancel')
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('❌')
        );

    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('Select CLI Type')
        .setDescription(`**Runner:** \`${runner.name}\`\n\nSelect the CLI tool:`);

    await interaction.update({
        embeds: [embed],
        components: [mainButtonRow, navButtonRow]
    });
}

async function handleBackToPlugin(interaction: any, userId: string): Promise<void> {
    const state = botState.sessionCreationState.get(userId);
    if (!state || !state.runnerId || !state.cliType) {
        await interaction.reply({
            embeds: [createErrorEmbed('Session Expired', 'Please start over')],
            flags: 64
        });
        return;
    }

    state.step = 'select_plugin';
    botState.sessionCreationState.set(userId, state);

    const runner = storage.getRunner(state.runnerId);

    // Row 1: Main action buttons
    const mainButtonRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('session_plugin_tmux')
                .setLabel('Interactive (Tmux)')
                .setStyle(ButtonStyle.Success)
                .setEmoji('🖥️'),
            new ButtonBuilder()
                .setCustomId('session_plugin_print')
                .setLabel('Basic (Print)')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('📄'),
            new ButtonBuilder()
                .setCustomId('session_plugin_claude-sdk')
                .setLabel('Claude SDK')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('⚡')
        );

    // Row 2: Navigation buttons
    const navButtonRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('session_back_cli')
                .setLabel('Back')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('◀️'),
            new ButtonBuilder()
                .setCustomId('session_cancel')
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('❌')
        );

    const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('Select Plugin Type')
        .setDescription(`**Runner:** \`${runner?.name}\`\n**CLI:** ${state.cliType.toUpperCase()}`);

    await interaction.update({
        embeds: [embed],
        components: [mainButtonRow, navButtonRow]
    });
}

async function handleCustomFolder(interaction: any, userId: string): Promise<void> {
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

async function handleDefaultFolder(interaction: any, userId: string): Promise<void> {
    const state = botState.sessionCreationState.get(userId);
    if (!state || !state.runnerId || !state.cliType) {
        await interaction.reply({
            embeds: [createErrorEmbed('Session Expired', 'Please start over')],
            flags: 64
        });
        return;
    }

    const runner = storage.getRunner(state.runnerId);
    if (!runner) {
        await interaction.reply({
            embeds: [createErrorEmbed('Runner Not Found', 'Runner no longer exists')],
            flags: 64
        });
        return;
    }

    // Use the runner's default workspace - must be set, not just '~' or './'
    const folderPath = runner.defaultWorkspace;
    if (!folderPath || folderPath === '~' || folderPath === './' || folderPath === '.') {
        await interaction.reply({
            embeds: [createErrorEmbed('No Default Folder', 'Runner has no default workspace configured. Please use Custom Folder instead.')],
            flags: 64
        });
        return;
    }

    // Update state with folder path
    state.folderPath = folderPath;
    state.step = 'complete';
    botState.sessionCreationState.set(userId, state);

    // Proceed to Review Step instead of immediate creation
    await handleSessionReview(interaction, userId);
}

async function handleSessionCancel(interaction: any, userId: string): Promise<void> {
    botState.sessionCreationState.delete(userId);

    const embed = new EmbedBuilder()
        .setColor(0xFF0000)
        .setTitle('Session Creation Cancelled')
        .setDescription('You can start again with `/create-session`');

    await interaction.update({
        embeds: [embed],
        components: []
    });
}

// ===================================
// Session Customization
// ===================================

export async function handleSessionReview(interaction: any, userId: string): Promise<void> {
    const state = botState.sessionCreationState.get(userId);
    if (!state || !state.runnerId || !state.cliType || !state.folderPath) {
        await interaction.reply({
            embeds: [createErrorEmbed('Session Error', 'Missing required session information.')],
            flags: 64
        });
        return;
    }

    const runner = storage.getRunner(state.runnerId);

    // Determine start button implementation
    let startLabel = 'Start Session';
    let approvalText = state.options?.approvalMode === 'auto' ? 'Auto-Approve (YOLO)' : 'Require Approval';

    // For Gemini Stream, auto-approve is standard/implied unless we explicitly support interactive stream later
    if (state.plugin === 'stream') {
        approvalText = 'Auto-Approve (Stream Mode)';
    }

    const embed = new EmbedBuilder()
        .setColor(0x00FF00)
        .setTitle('Review & Start Session')
        .setDescription(`**Runner:** \`${runner?.name}\`\n**CLI:** ${state.cliType.toUpperCase()}\n**Plugin:** ${state.plugin?.toUpperCase()}\n**Folder:** \`${state.folderPath}\`\n\n**Settings:**\nApproval Mode: \`${approvalText}\``);

    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('session_start')
                .setLabel(startLabel)
                .setStyle(ButtonStyle.Success)
                .setEmoji('🚀'),
            new ButtonBuilder()
                .setCustomId('session_customize')
                .setLabel('Customize Settings')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('⚙️'),
            new ButtonBuilder()
                .setCustomId('session_cancel')
                .setLabel('Cancel')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('❌')
        );

    if (interaction.isButton()) {
        await interaction.update({
            embeds: [embed],
            components: [row]
        });
    } else {
        // From modal or other source
        await interaction.reply({
            embeds: [embed],
            components: [row]
        });
    }
}

async function handleCustomizeSettings(interaction: any, userId: string): Promise<void> {
    const state = botState.sessionCreationState.get(userId);
    if (!state) return;

    const currentMode = state.options?.approvalMode || 'manual';

    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('Customize Session Settings')
        .setDescription('Configure how the CLI session behaves.');

    const modeRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('session_settings_approval_manual')
                .setLabel('Require Approval (Default)')
                .setStyle(currentMode === 'manual' ? ButtonStyle.Success : ButtonStyle.Secondary)
                .setEmoji('🛡️'),
            new ButtonBuilder()
                .setCustomId('session_settings_approval_auto')
                .setLabel('Auto-Approve (YOLO)')
                .setStyle(currentMode === 'auto' ? ButtonStyle.Danger : ButtonStyle.Secondary)
                .setEmoji('⚡')
        );

    const navRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId('session_settings_back')
                .setLabel('Back to Review')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('↩️')
        );

    await interaction.update({
        embeds: [embed],
        components: [modeRow, navRow]
    });
}

async function handleSessionSettings(interaction: any, userId: string, customId: string): Promise<void> {
    const state = botState.sessionCreationState.get(userId);
    if (!state) return;

    if (!state.options) state.options = {};

    if (customId === 'session_settings_approval_manual') {
        state.options.approvalMode = 'manual';
    } else if (customId === 'session_settings_approval_auto') {
        state.options.approvalMode = 'auto';
    } else if (customId === 'session_settings_back') {
        await handleSessionReview(interaction, userId);
        return;
    }

    botState.sessionCreationState.set(userId, state);

    // Refresh the settings UI
    await handleCustomizeSettings(interaction, userId);
}

async function handleStartSession(interaction: any, userId: string): Promise<void> {
    const state = botState.sessionCreationState.get(userId);
    if (!state || !state.runnerId || !state.cliType || !state.folderPath) {
        await interaction.reply({
            embeds: [createErrorEmbed('Session Error', 'Missing required session information.')],
            flags: 64
        });
        return;
    }

    const runner = storage.getRunner(state.runnerId);
    if (!runner) {
        await interaction.reply({
            embeds: [createErrorEmbed('Runner Not Found', 'Runner no longer exists')],
            flags: 64
        });
        return;
    }

    const folderPath = state.folderPath;

    // Import required items for session creation
    const { getOrCreateRunnerChannel } = await import('../utils/channels.js');
    const { ChannelType } = await import('discord.js');
    const { randomUUID } = await import('crypto');

    // Get or create runner's private channel
    let channelId: string;
    if (!runner.privateChannelId) {
        const guildId = interaction.guildId;
        if (!guildId) {
            await interaction.reply({
                embeds: [createErrorEmbed('Cannot Create Session', 'Cannot determine guild ID.')],
                flags: 64
            });
            return;
        }
        channelId = await getOrCreateRunnerChannel(runner, guildId);
    } else {
        channelId = runner.privateChannelId;
    }

    try {
        const channel = await botState.client.channels.fetch(channelId);
        if (!channel || !('threads' in channel)) {
            await interaction.reply({
                embeds: [createErrorEmbed('Cannot Create Thread', 'Cannot access runner channel.')],
                flags: 64
            });
            return;
        }

        // Cast channel to TextChannel
        const textChannel = channel as any;

        // Create a private thread
        const thread = await textChannel.threads.create({
            name: `${state.cliType.toUpperCase()}-${Date.now()}`,
            type: ChannelType.PrivateThread,
            invitable: false,
            reason: `CLI session for ${state.cliType}`
        });

        // Convert 'terminal' to 'generic' for storage (terminal is just a UI selection)
        const storageCLIType = state.cliType === 'terminal' ? 'generic' : state.cliType;

        const session = {
            sessionId: randomUUID(),
            runnerId: runner.runnerId,
            channelId: channel.id,
            threadId: thread.id,
            createdAt: new Date().toISOString(),
            status: 'active' as const,
            cliType: storageCLIType as 'claude' | 'gemini' | 'generic',
            plugin: state.plugin as 'tmux' | 'print' | 'stream' | 'claude-sdk' | undefined,
            folderPath: folderPath,
            interactionToken: interaction.token,
            creatorId: interaction.user.id
        };

        storage.createSession(session);
        botState.actionItems.set(session.sessionId, []);

        // Add user to thread
        await thread.members.add(interaction.user.id, 'Session owner');

        // Add shared users
        for (const authUserId of runner.authorizedUsers) {
            if (authUserId && authUserId !== interaction.user.id) {
                try {
                    await thread.members.add(authUserId, 'Authorized user');
                } catch (error) {
                    console.error(`Failed to add user ${authUserId} to thread:`, error);
                }
            }
        }

        // Send session start to runner
        const ws = botState.runnerConnections.get(runner.runnerId);
        if (ws) {
            const startData: any = {
                sessionId: session.sessionId,
                runnerId: runner.runnerId,
                cliType: state.cliType,
                folderPath: folderPath,
                plugin: state.plugin, // Pass plugin type
                options: { ...state.options }
            };

            // Map frontend options to runner options behavior
            if (!startData.options) startData.options = {};

            if (state.options?.approvalMode === 'auto') {
                startData.options.skipPermissions = true;
            } else {
                startData.options.skipPermissions = false;
            }

            ws.send(JSON.stringify({
                type: 'session_start',
                data: startData
            }));

            const initializingEmbed = new EmbedBuilder()
                .setColor(0xFFFF00)
                .setTitle('Initializing Session...')
                .setDescription('Request sent to runner. Waiting for confirmation...')
                .addFields(
                    { name: 'Runner', value: runner.name, inline: true },
                    { name: 'CLI Type', value: state.cliType.toUpperCase(), inline: true },
                    { name: 'Plugin', value: (state.plugin || 'Tmux').toUpperCase(), inline: true },
                    { name: 'Approval', value: state.options?.approvalMode === 'auto' ? 'Auto-Approve' : 'Manual', inline: true },
                    { name: 'Working Folder', value: `\`\`\`${folderPath}\`\`\``, inline: false }
                )
                .setTimestamp();

            await interaction.update({
                embeds: [initializingEmbed],
                components: []
            });

            botState.sessionCreationState.delete(userId);
            console.log(`Session ${session.sessionId} created with options:`, startData.options);
        } else {
            await interaction.reply({
                embeds: [createErrorEmbed('Runner Offline', 'Runner disconnected while creating session.')],
                flags: 64
            });
        }
    } catch (error) {
        console.error('Error creating session:', error);
        await interaction.reply({
            embeds: [createErrorEmbed('Internal Error', 'Failed to create session')],
            flags: 64
        });
        return;
    }
}

// ===================================
// Multi-select and Other Option Handlers
// ===================================

/**
 * Handle multi-select toggle button
 */
async function handleMultiSelectToggle(interaction: any, userId: string, customId: string): Promise<void> {
    // Format: multiselect_<requestId>_<optionNumber>
    const parts = customId.split('_');
    const requestId = parts[1];
    const optionNumber = parts[2];

    const multiSelect = botState.multiSelectState.get(requestId);
    if (!multiSelect) {
        console.error(`[MultiSelectToggle] No multiSelectState found for requestId=${requestId}`);
        await interaction.reply({
            embeds: [createErrorEmbed('Expired', 'This question has expired.')],
            flags: 64
        });
        return;
    }

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
            embeds: [createErrorEmbed('Unauthorized', 'You are not authorized to respond to this request.')],
            flags: 64
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

    await interaction.update({ components: rows });
}

/**
 * Handle multi-select submit button
 */
async function handleMultiSelectSubmit(interaction: any, userId: string, customId: string): Promise<void> {
    // Format: multiselect_submit_<requestId>
    const requestId = customId.replace('multiselect_submit_', '');

    const multiSelect = botState.multiSelectState.get(requestId);
    if (!multiSelect) {
        await interaction.reply({
            embeds: [createErrorEmbed('Expired', 'This question has expired.')],
            flags: 64
        });
        return;
    }

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
            embeds: [createErrorEmbed('Unauthorized', 'You are not authorized to respond to this request.')],
            flags: 64
        });
        return;
    }

    // Send the selected options to the runner
    const ws = botState.runnerConnections.get(pending.runnerId);
    if (ws) {
        // Convert selected option numbers to option numbers (1-indexed)
        const selectedNumbers = Array.from(multiSelect.selectedOptions)
            .filter(opt => opt !== 'other')
            .sort((a, b) => parseInt(a, 10) - parseInt(b, 10));

        // For multi-select, send all selected options together as a comma-separated string
        // The SDK plugin will parse this and handle it correctly
        if (selectedNumbers.length > 0) {
            ws.send(JSON.stringify({
                type: 'approval_response',
                data: {
                    sessionId: pending.sessionId,
                    approved: true,
                    optionNumber: selectedNumbers.join(',')  // Send all options as comma-separated
                }
            }));
        }

        // If "Other" was selected, include that in the response
        if (multiSelect.selectedOptions.has('other')) {
            const otherValue = (multiSelect as any).otherValue || '';
            ws.send(JSON.stringify({
                type: 'approval_response',
                data: {
                    sessionId: pending.sessionId,
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
    const embed = createApprovalDecisionEmbed(true, pending.toolName, interaction.user.username, `Selected: ${selectedLabels}`);

    await interaction.update({
        embeds: [embed],
        components: [row]
    });

    // Clean up
    botState.multiSelectState.delete(requestId);
    botState.pendingApprovals.delete(requestId);
    botState.streamingMessages.delete(pending.sessionId);
}

/**
 * Handle "Other" button - opens modal for custom input
 */
async function handleOtherButton(interaction: any, userId: string, customId: string): Promise<void> {
    // Format: other_<requestId>
    const requestId = customId.replace('other_', '');

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

    // Create modal for custom input
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
