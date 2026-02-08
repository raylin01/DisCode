/**
 * Runner Configuration Handler
 * 
 * Manages the interactive configuration menu for runners.
 */

import { 
    ButtonInteraction, 
    EmbedBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    StringSelectMenuBuilder, 
    StringSelectMenuOptionBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    Interaction
} from 'discord.js';
import { storage } from '../storage.js';
import { createErrorEmbed } from '../utils/embeds.js';
import type { RunnerConfig } from '../../../shared/types.js';

type ConfigSection = 'main' | 'projects' | 'threads' | 'claude' | 'advanced';

export async function handleRunnerConfig(
    interaction: ButtonInteraction, 
    userId: string, 
    runnerId: string,
    section: ConfigSection = 'main'
): Promise<void> {
    const runner = storage.getRunner(runnerId);
    if (!runner) {
        await interaction.reply({ 
            embeds: [createErrorEmbed('Runner Not Found', 'This runner no longer exists.')], 
            ephemeral: true 
        });
        return;
    }

    if (!storage.canUserAccessRunner(userId, runnerId)) {
        await interaction.reply({ 
            embeds: [createErrorEmbed('Access Denied', 'You do not have permission to configure this runner.')], 
            ephemeral: true 
        });
        return;
    }

    // Default config if missing
    const config: RunnerConfig = runner.config || {
        threadArchiveDays: 3,
        autoSync: true,
        thinkingLevel: 'low',
        yoloMode: false,
        claudeDefaults: {}
    };

    // Ensure config exists in runner object for updates
    if (!runner.config) {
        runner.config = config;
        storage.updateRunner(runnerId, runner);
    } else if (!runner.config.claudeDefaults) {
        runner.config.claudeDefaults = {};
        storage.updateRunner(runnerId, runner);
    }

    const embed = new EmbedBuilder()
        .setTitle(`⚙️ Configuration: ${runner.name}`)
        .setColor(0x5ca1e6);

    const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

    // --- Navigation Row (Top) ---
    const navRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
             new ButtonBuilder()
                .setCustomId(`config:${runnerId}:section:projects`)
                .setLabel('📁 Projects')
                .setStyle(section === 'projects' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`config:${runnerId}:section:threads`)
                .setLabel('🧵 Threads')
                .setStyle(section === 'threads' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`config:${runnerId}:section:claude`)
                .setLabel('🤖 Claude')
                .setStyle(section === 'claude' ? ButtonStyle.Primary : ButtonStyle.Secondary),
             new ButtonBuilder()
                .setCustomId(`config:${runnerId}:section:advanced`)
                .setLabel('🔧 Advanced')
                .setStyle(section === 'advanced' ? ButtonStyle.Primary : ButtonStyle.Secondary)
        );
    
    rows.push(navRow);

    // --- Section Content ---
    switch (section) {
        case 'main':
            embed.setDescription('Select a category above to configure runner settings.');
            
            // Overview fields
            embed.addFields(
                { name: 'Auto-Sync', value: config.autoSync ? '✅ Enabled' : '❌ Disabled', inline: true },
                { name: 'Thread Archive', value: `${config.threadArchiveDays} days`, inline: true },
                { name: 'Thinking', value: (config.thinkingLevel || 'low').toUpperCase(), inline: true },
                { name: 'YOLO Mode', value: config.yoloMode ? '✅ Enabled' : '❌ Disabled', inline: true }
            );
            break;

        case 'projects':
            embed.setDescription('**Project Settings**\n\nManage how projects are synced and displayed.');
            // Add project specific actions if needed (e.g., refresh list)
            embed.addFields({ name: 'Info', value: 'Use `/sync-projects` to refresh the project list.' });
            break;

        case 'threads':
            embed.setDescription('**Thread Settings**\n\nConfigure how session threads behave.');
            
            // Archive Duration Select
            const archiveSelect = new StringSelectMenuBuilder()
                .setCustomId(`config:${runnerId}:set:archiveDays`)
                .setPlaceholder('Archive threads after...')
                .addOptions(
                    new StringSelectMenuOptionBuilder().setLabel('1 Day').setValue('1').setDefault(config.threadArchiveDays === 1),
                    new StringSelectMenuOptionBuilder().setLabel('3 Days').setValue('3').setDefault(config.threadArchiveDays === 3),
                    new StringSelectMenuOptionBuilder().setLabel('7 Days').setValue('7').setDefault(config.threadArchiveDays === 7),
                    new StringSelectMenuOptionBuilder().setLabel('30 Days').setValue('30').setDefault(config.threadArchiveDays === 30),
                    new StringSelectMenuOptionBuilder().setLabel('Never').setValue('-1').setDefault(config.threadArchiveDays === -1)
                );
            rows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(archiveSelect));

            // Auto-Sync Toggle
            const syncToggle = new ButtonBuilder()
                .setCustomId(`config:${runnerId}:toggle:autoSync`)
                .setLabel(config.autoSync ? '✅ Auto-Sync Enabled' : '❌ Auto-Sync Disabled')
                .setStyle(config.autoSync ? ButtonStyle.Success : ButtonStyle.Danger);
            
            rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(syncToggle));
            break;

        case 'claude':
            embed.setDescription('**Claude Settings**\n\nConfigure AI behavior and capabilities.');
            const claudeDefaults = config.claudeDefaults || {};
            
            // Thinking Level
            const thinkingRow = new ActionRowBuilder<ButtonBuilder>();
            (['low', 'medium', 'high'] as const).forEach(level => {
                 thinkingRow.addComponents(
                    new ButtonBuilder()
                        .setCustomId(`config:${runnerId}:set:thinkingLevel:${level}`)
                        .setLabel(`${level.charAt(0).toUpperCase() + level.slice(1)} Thinking`)
                        .setStyle(config.thinkingLevel === level ? ButtonStyle.Primary : ButtonStyle.Secondary)
                );
            });
            rows.push(thinkingRow);

            // YOLO Mode Toggle
            const yoloToggle = new ButtonBuilder()
                .setCustomId(`config:${runnerId}:toggle:yoloMode`)
                .setLabel(config.yoloMode ? '⚠️ YOLO Mode Enabled' : '🛡️ YOLO Mode Disabled')
                .setStyle(config.yoloMode ? ButtonStyle.Danger : ButtonStyle.Success);
            
            rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(yoloToggle));

            embed.addFields(
                { name: 'Default Model', value: claudeDefaults.model || 'Auto', inline: true },
                { name: 'Max Turns', value: claudeDefaults.maxTurns ? String(claudeDefaults.maxTurns) : 'Default', inline: true },
                { name: 'Max Thinking Tokens', value: claudeDefaults.maxThinkingTokens ? String(claudeDefaults.maxThinkingTokens) : 'Default', inline: true },
                { name: 'Permission Mode', value: claudeDefaults.permissionMode || 'default', inline: true }
            );

            const claudeDefaultsRow = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`config:${runnerId}:modal:setModel`)
                        .setLabel('Set Model')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(`config:${runnerId}:modal:setMaxTurns`)
                        .setLabel('Set Max Turns')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(`config:${runnerId}:modal:setMaxThinking`)
                        .setLabel('Set Max Thinking')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(`config:${runnerId}:action:clearClaudeDefaults`)
                        .setLabel('Clear Defaults')
                        .setStyle(ButtonStyle.Danger)
                );

            rows.push(claudeDefaultsRow);

            const permissionModeRow = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`config:${runnerId}:set:permissionMode:default`)
                        .setLabel('Permission: Default')
                        .setStyle(claudeDefaults.permissionMode === 'default' || !claudeDefaults.permissionMode ? ButtonStyle.Primary : ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(`config:${runnerId}:set:permissionMode:acceptEdits`)
                        .setLabel('Permission: Accept Edits')
                        .setStyle(claudeDefaults.permissionMode === 'acceptEdits' ? ButtonStyle.Primary : ButtonStyle.Secondary)
                );

            rows.push(permissionModeRow);
            break;

        case 'advanced':
            embed.setDescription('**Advanced Settings**\n\nDangerous or technical configurations.');
            // Placeholders
            embed.addFields({ name: 'Version', value: 'v1.0.0', inline: true });
            break;
    }

    // Refresh interaction
    if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ embeds: [embed], components: rows });
    } else {
        await interaction.update({ embeds: [embed], components: rows });
    }
}

/**
 * Handle configuration actions
 */
export async function handleConfigAction(interaction: any, userId: string, customId: string): Promise<void> {
    // Parse customId: config:{runnerId}:{action}:{param}
    // Actions: section, toggle, set, cycle, modal, action
    const parts = customId.split(':');
    if (parts.length < 4) return;
    
    const runnerId = parts[1];
    const action = parts[2];
    const param = parts.slice(3).join(':');

    const runner = storage.getRunner(runnerId);
    if (!runner || !runner.config) return;

    if (!storage.canUserAccessRunner(userId, runnerId)) {
        await interaction.reply({ content: 'Access Denied', ephemeral: true });
        return;
    }

    // Handle Sections (Navigation)
    if (action === 'section') {
        await handleRunnerConfig(interaction as ButtonInteraction, userId, runnerId, param as ConfigSection);
        return;
    }

    if (action === 'modal') {
        await handleConfigModal(interaction as ButtonInteraction, runnerId, param);
        return;
    }

    // Update Config
    let updated = false;

    if (action === 'toggle') {
        if (param === 'autoSync') {
            runner.config.autoSync = !runner.config.autoSync;
            updated = true;
        } else if (param === 'yoloMode') {
            runner.config.yoloMode = !runner.config.yoloMode;
            updated = true;
        }
    } else if (action === 'set') {
        if (param === 'archiveDays') {
            // Handled by Select Menu? Select menu interaction is different.
            // If this is a button click (e.g. thinkingLevel:high), it works.
            // If select menu, values are in interaction.values
        } else if (param.startsWith('thinkingLevel')) {
            const level = param.split(':')[1] as 'low'|'medium'|'high';
            runner.config.thinkingLevel = level;
            updated = true;
        } else if (param.startsWith('permissionMode')) {
            const mode = param.split(':')[1] as 'default' | 'acceptEdits';
            runner.config.claudeDefaults = runner.config.claudeDefaults || {};
            runner.config.claudeDefaults.permissionMode = mode;
            updated = true;
        }
    } else if (action === 'action') {
        if (param === 'clearClaudeDefaults') {
            runner.config.claudeDefaults = {};
            updated = true;
        }
    }

    // Handle Select Menus (values come from interaction, not just customId)
    if (interaction.isStringSelectMenu() && action === 'set' && param === 'archiveDays') {
        const value = parseInt(interaction.values[0], 10);
        runner.config.threadArchiveDays = value;
        updated = true;
    }

    if (updated) {
        storage.updateRunner(runnerId, runner);
        
        // Determine current section to stay on
        // We can check the customId or infer likely section
        let section: ConfigSection = 'main';
        if (param.startsWith('thinkingLevel') || param === 'yoloMode' || param.startsWith('permissionMode') || param === 'clearClaudeDefaults') section = 'claude';
        if (param === 'autoSync' || param === 'archiveDays') section = 'threads';

        await handleRunnerConfig(interaction as ButtonInteraction, userId, runnerId, section);
    }
}

async function handleConfigModal(
    interaction: ButtonInteraction,
    runnerId: string,
    param: string
): Promise<void> {
    const modal = new ModalBuilder()
        .setCustomId(`config_modal:${runnerId}:${param}`)
        .setTitle('Update Claude Defaults');

    const input = new TextInputBuilder()
        .setRequired(true)
        .setStyle(TextInputStyle.Short);

    if (param === 'setModel') {
        input.setCustomId('model').setLabel('Model (e.g., claude-sonnet-4-5)');
    } else if (param === 'setMaxTurns') {
        input.setCustomId('maxTurns').setLabel('Max Turns (number)');
    } else if (param === 'setMaxThinking') {
        input.setCustomId('maxThinkingTokens').setLabel('Max Thinking Tokens (number)');
    } else {
        await interaction.reply({ content: 'Unknown configuration option.', ephemeral: true });
        return;
    }

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input);
    modal.addComponents(row);
    await interaction.showModal(modal);
}
