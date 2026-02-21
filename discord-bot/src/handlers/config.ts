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
  TextInputStyle
} from 'discord.js';
import { storage } from '../storage.js';
import { createErrorEmbed } from '../utils/embeds.js';
import { fetchRunnerModels, AUTO_MODEL_VALUE } from '../utils/models.js';
import * as botState from '../state.js';
import type { RunnerConfig } from '../../../shared/types.js';

type ConfigSection =
    | 'main'
    | 'home'
    | 'projects'
    | 'threads'
    | 'claude'
    | 'claude-2'
    | 'claude-3'
    | 'codex'
    | 'codex-2'
    | 'gemini'
    | 'gemini-2'
    | 'advanced';

const TOP_NAV_PAGES: ReadonlyArray<ReadonlyArray<ConfigSection>> = [
    ['home', 'projects', 'threads', 'claude'],
    ['codex', 'gemini', 'advanced']
];

function normalizeSection(section: ConfigSection): ConfigSection {
    return section === 'main' ? 'home' : section;
}

function getBaseSection(section: ConfigSection): ConfigSection {
    const normalized = normalizeSection(section);
    if (normalized.startsWith('claude')) return 'claude';
    if (normalized.startsWith('codex')) return 'codex';
    if (normalized.startsWith('gemini')) return 'gemini';
    return normalized;
}

function getTopPageForSection(section: ConfigSection): 0 | 1 {
    const base = getBaseSection(section);
    const pageOne = TOP_NAV_PAGES[1].includes(base);
    return pageOne ? 1 : 0;
}

function getFirstSectionForTopPage(topPage: 0 | 1): ConfigSection {
    return TOP_NAV_PAGES[topPage][0] as ConfigSection;
}

function truncateForDiscord(value: string, max: number): string {
    if (value.length <= max) return value;
    return `${value.slice(0, Math.max(0, max - 1))}…`;
}

const defaultModelPickerRequests = new Map<string, string>();

function getDefaultModelPickerRequestKey(
    interaction: any,
    userId: string,
    runnerId: string,
    cliType: 'claude' | 'codex'
): string {
    const messageId = interaction?.message?.id || 'no-message';
    return `${userId}:${messageId}:${runnerId}:${cliType}`;
}

async function editOrUpdateInteraction(interaction: any, payload: any): Promise<void> {
    if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
    } else {
        await interaction.update(payload);
    }
}

async function showDefaultModelPicker(
    interaction: any,
    userId: string,
    runnerId: string,
    cliType: 'claude' | 'codex',
    forceRefresh: boolean = false
): Promise<void> {
    const runner = storage.getRunner(runnerId);
    if (!runner) {
        const embeds = [createErrorEmbed('Runner Not Found', 'This runner no longer exists.')];
        if (interaction.deferred || interaction.replied) await interaction.editReply({ embeds });
        else await interaction.reply({ embeds, flags: 64 });
        return;
    }

    if (!storage.canUserAccessRunner(userId, runnerId)) {
        const embeds = [createErrorEmbed('Access Denied', 'You do not have permission to configure this runner.')];
        if (interaction.deferred || interaction.replied) await interaction.editReply({ embeds });
        else await interaction.reply({ embeds, flags: 64 });
        return;
    }

    const requestKey = getDefaultModelPickerRequestKey(interaction, userId, runnerId, cliType);
    const requestToken = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    defaultModelPickerRequests.set(requestKey, requestToken);

    try {
        const loadingEmbed = new EmbedBuilder()
            .setColor(0x5ca1e6)
            .setTitle(cliType === 'claude' ? 'Loading Claude Models' : 'Loading Codex Models')
            .setDescription(`Runner: \`${runner.name}\`\nFetching available models from this runner...`);

        await editOrUpdateInteraction(interaction, {
            embeds: [loadingEmbed],
            components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`config:${runnerId}:models:${cliType}:refresh`)
                        .setLabel('Fetching...')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(true),
                    new ButtonBuilder()
                        .setCustomId(`config:${runnerId}:section:${cliType === 'claude' ? 'claude' : 'codex'}`)
                        .setLabel('Back')
                        .setStyle(ButtonStyle.Secondary)
                )
            ]
        });

        const result = await fetchRunnerModels(runnerId, cliType, { forceRefresh, limit: 100 });
        if (defaultModelPickerRequests.get(requestKey) !== requestToken) {
            return;
        }

        if (result.error) {
            const errorText = result.error === 'Runner timed out while fetching models.'
                ? `${result.error} The CLI may still be warming up.`
                : result.error;
            await editOrUpdateInteraction(interaction, {
                embeds: [createErrorEmbed('Model Fetch Failed', errorText)],
                components: [
                    new ActionRowBuilder<ButtonBuilder>().addComponents(
                        new ButtonBuilder()
                            .setCustomId(`config:${runnerId}:models:${cliType}:refresh`)
                            .setLabel('Retry')
                            .setStyle(ButtonStyle.Secondary),
                        new ButtonBuilder()
                            .setCustomId(`config:${runnerId}:section:${cliType === 'claude' ? 'claude' : 'codex'}`)
                            .setLabel('Back')
                            .setStyle(ButtonStyle.Secondary)
                    )
                ]
            });
            return;
        }

        const currentModel = cliType === 'claude'
            ? runner.config?.claudeDefaults?.model
            : runner.config?.codexDefaults?.model;

        const options = [
            new StringSelectMenuOptionBuilder()
                .setLabel('Auto (CLI default)')
                .setValue(AUTO_MODEL_VALUE)
                .setDescription('Use the CLI default model when spawning sessions.')
                .setDefault(!currentModel),
            ...result.models.slice(0, 24).map(model => {
                const option = new StringSelectMenuOptionBuilder()
                    .setLabel(truncateForDiscord(model.label || model.id, 100))
                    .setValue(model.id)
                    .setDefault(currentModel === model.id);

                const description = model.description
                    ? truncateForDiscord(model.description, 100)
                    : (model.isDefault ? 'Marked as default by CLI.' : `Model ID: ${model.id}`);
                option.setDescription(description);
                return option;
            })
        ];

        if (currentModel && currentModel !== AUTO_MODEL_VALUE && !result.models.some(model => model.id === currentModel)) {
            const customLabel = truncateForDiscord(`Current: ${currentModel}`, 100);
            if (options.length >= 25) {
                options.pop();
            }
            options.push(
                new StringSelectMenuOptionBuilder()
                    .setLabel(customLabel)
                    .setValue(currentModel)
                    .setDescription('Current model is not in the fetched catalog.')
                    .setDefault(true)
            );
        }

        const embed = new EmbedBuilder()
            .setColor(0x5ca1e6)
            .setTitle(cliType === 'claude' ? 'Select Default Claude Model' : 'Select Default Codex Model')
            .setDescription(
                `Runner: \`${runner.name}\`\n` +
                `Current default: \`${currentModel || 'Auto'}\`\n` +
                `Available models: **${result.models.length}**${result.models.length > 24 ? ' (showing first 24)' : ''}`
            )
            .addFields({
                name: 'Spawn Behavior',
                value: 'This default model is used when new sessions are created unless overridden per-session.'
            });

        const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>()
            .addComponents(
                new StringSelectMenuBuilder()
                    .setCustomId(`config:${runnerId}:selectModel:${cliType}`)
                    .setPlaceholder('Choose default model…')
                    .addOptions(options)
            );

        const actionRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`config:${runnerId}:models:${cliType}:refresh`)
                    .setLabel('Refresh')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`config:${runnerId}:section:${cliType === 'claude' ? 'claude' : 'codex'}`)
                    .setLabel('Back')
                    .setStyle(ButtonStyle.Secondary)
            );

        await editOrUpdateInteraction(interaction, { embeds: [embed], components: [selectRow, actionRow] });
    } finally {
        if (defaultModelPickerRequests.get(requestKey) === requestToken) {
            defaultModelPickerRequests.delete(requestKey);
        }
    }
}

export async function handleRunnerConfig(
    interaction: ButtonInteraction,
    userId: string,
    runnerId: string,
    section: ConfigSection = 'home',
    topPageOverride?: 0 | 1
): Promise<void> {
    const runner = storage.getRunner(runnerId);
    if (!runner) {
        await editOrUpdateInteraction(interaction, {
            embeds: [createErrorEmbed('Runner Not Found', 'This runner no longer exists.')]
        });
        return;
    }

    if (!storage.canUserAccessRunner(userId, runnerId)) {
        await editOrUpdateInteraction(interaction, {
            embeds: [createErrorEmbed('Access Denied', 'You do not have permission to configure this runner.')]
        });
        return;
    }

    const activeSection = normalizeSection(section);

    // Default config if missing
    const config: RunnerConfig = runner.config || {
        threadArchiveDays: 3,
        autoSync: true,
        thinkingLevel: 'low',
        yoloMode: false,
        claudeDefaults: {},
        codexDefaults: {},
        geminiDefaults: {},
        presets: {}
    };

    // Ensure config exists in runner object for updates
    if (!runner.config) {
        runner.config = config;
        storage.updateRunner(runnerId, runner);
    }
    if (!runner.config.claudeDefaults) {
        runner.config.claudeDefaults = {};
        storage.updateRunner(runnerId, runner);
    }
    if (!runner.config.codexDefaults) {
        runner.config.codexDefaults = {};
        storage.updateRunner(runnerId, runner);
    }
    if (!runner.config.geminiDefaults) {
        runner.config.geminiDefaults = {};
        storage.updateRunner(runnerId, runner);
    }
    if (!runner.config.presets) {
        runner.config.presets = {};
        storage.updateRunner(runnerId, runner);
    }

    const effectiveTopPage = topPageOverride ?? getTopPageForSection(activeSection);
    const embed = new EmbedBuilder()
        .setTitle(`⚙️ Configuration: ${runner.name}`)
        .setColor(0x5ca1e6);

    const rows: ActionRowBuilder<ButtonBuilder | StringSelectMenuBuilder>[] = [];

    const headerButtons: ButtonBuilder[] = [];
    if (effectiveTopPage === 0) {
        for (const item of TOP_NAV_PAGES[0]) {
            headerButtons.push(
                new ButtonBuilder()
                    .setCustomId(`config:${runnerId}:section:${item}`)
                    .setLabel(item === 'home' ? 'Home' : item.charAt(0).toUpperCase() + item.slice(1))
                    .setStyle(getBaseSection(activeSection) === item ? ButtonStyle.Primary : ButtonStyle.Secondary)
            );
        }
        headerButtons.push(
            new ButtonBuilder()
                .setCustomId(`config:${runnerId}:topPage:1:${activeSection}`)
                .setLabel('>')
                .setStyle(ButtonStyle.Secondary)
        );
    } else {
        headerButtons.push(
            new ButtonBuilder()
                .setCustomId(`config:${runnerId}:topPage:0:${activeSection}`)
                .setLabel('<')
                .setStyle(ButtonStyle.Secondary)
        );
        for (const item of TOP_NAV_PAGES[1]) {
            headerButtons.push(
                new ButtonBuilder()
                    .setCustomId(`config:${runnerId}:section:${item}`)
                    .setLabel(item.charAt(0).toUpperCase() + item.slice(1))
                    .setStyle(getBaseSection(activeSection) === item ? ButtonStyle.Primary : ButtonStyle.Secondary)
            );
        }
    }
    rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...headerButtons));

    const closeRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`runner_dashboard:${runnerId}`)
                .setLabel('Back to Dashboard')
                .setStyle(ButtonStyle.Secondary)
        );
    switch (activeSection) {
        case 'home':
            embed.setDescription('Select a category above to configure runner settings.');
            embed.addFields(
                { name: 'Auto-Sync', value: config.autoSync ? '✅ Enabled' : '❌ Disabled', inline: true },
                { name: 'Thread Archive', value: `${config.threadArchiveDays} days`, inline: true },
                { name: 'Thinking', value: (config.thinkingLevel || 'low').toUpperCase(), inline: true },
                { name: 'Claude Approval', value: config.claudeDefaults?.permissionMode || 'manual', inline: true },
                { name: 'Claude Edit Mode', value: config.claudeDefaults?.editAcceptMode || 'default', inline: true },
                { name: 'Codex Approval', value: config.codexDefaults?.approvalPolicy || 'on-request', inline: true },
                { name: 'Gemini Approval', value: config.geminiDefaults?.approvalMode || 'default', inline: true }
            );
            break;

        case 'projects':
            embed.setDescription('**Project Settings**\n\nManage project-specific defaults that override runner settings.');
            const { getCategoryManager } = await import('../services/category-manager.js');
            const { projectSettingsStore } = await import('../services/project-settings.js');
            const categoryManager = getCategoryManager();
            const runnerCategory = categoryManager?.getRunnerCategory(runnerId);

            if (runnerCategory && runnerCategory.projects.size > 0) {
                const projectList: string[] = [];
                for (const [path, project] of runnerCategory.projects) {
                    const folderName = path.split('/').pop() || path;
                    const hasOverrides = projectSettingsStore.hasOverrides(runnerId, path);
                    projectList.push(`${hasOverrides ? '⚙️' : '📁'} ${folderName}`);
                }
                embed.addFields({
                    name: `Projects (${runnerCategory.projects.size})`,
                    value: projectList.slice(0, 15).join('\n') + (projectList.length > 15 ? '\n...' : ''),
                    inline: false
                });
            } else {
                embed.addFields({
                    name: 'No Projects',
                    value: 'Use `/sync-projects` to discover projects from this runner.',
                    inline: false
                });
            }

            // Sync button
            const syncProjectsBtn = new ButtonBuilder()
                .setCustomId(`sync_projects:${runnerId}`)
                .setLabel('Sync Projects')
                .setStyle(ButtonStyle.Primary);
            rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(syncProjectsBtn));
            break;

        case 'threads':
            embed.setDescription('**Thread Settings**\n\nConfigure how session threads behave.');
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
        case 'claude-2':
        case 'claude-3': {
            const claudeDefaults = config.claudeDefaults || {};
            const effectivePermMode = claudeDefaults.permissionMode || 'manual';
            const effectiveEditMode = claudeDefaults.editAcceptMode || 'default';

            embed.setDescription(
                `**Claude Settings (${activeSection === 'claude' ? '1/3' : activeSection === 'claude-2' ? '2/3' : '3/3'})**\n` +
                (activeSection === 'claude'
                    ? 'Core limits and model defaults for new Claude sessions.'
                    : activeSection === 'claude-2'
                    ? 'Approval controls tools; Edit Mode controls edit/write auto-accept.'
                    : 'Thinking level tunes depth; presets save/reuse Claude defaults.')
            );
            embed.addFields(
                { name: 'Model', value: claudeDefaults.model || 'Auto', inline: true },
                { name: 'Max Turns', value: claudeDefaults.maxTurns ? String(claudeDefaults.maxTurns) : 'Default', inline: true },
                { name: 'Max Thinking', value: claudeDefaults.maxThinkingTokens ? String(claudeDefaults.maxThinkingTokens) : 'Default', inline: true },
                { name: 'Max Budget', value: claudeDefaults.maxBudgetUsd ? `$${claudeDefaults.maxBudgetUsd}` : 'Default', inline: true },
                { name: 'Approval Mode', value: effectivePermMode, inline: true },
                { name: 'Edit Mode', value: effectiveEditMode, inline: true },
                { name: 'Thinking Level', value: (config.thinkingLevel || 'low').toUpperCase(), inline: true }
            );
            if (activeSection === 'claude-2') {
                embed.addFields({
                    name: 'Mode Guide',
                    value: [
                        '`Manual` = ask before tools',
                        '`Auto-Safe` = auto-allow only safe tools',
                        '`YOLO` = auto-allow all tools',
                        '`Edit: Default` = ask on edits',
                        '`Edit: Accept` = auto-accept edits'
                    ].join('\n'),
                    inline: false
                });
            }

            if (activeSection === 'claude') {
                rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`config:${runnerId}:models:claude`).setLabel('Model').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:modal:setMaxTurns`).setLabel('Max Turns').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:modal:setMaxThinking`).setLabel('Max Thinking').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:modal:setMaxBudget`).setLabel('Max Budget').setStyle(ButtonStyle.Secondary)
                ));
                rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`config:${runnerId}:subpage:claude-2`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary)
                ));
            } else if (activeSection === 'claude-2') {
                rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`config:${runnerId}:set:permissionMode:manual`).setLabel('Manual').setStyle(effectivePermMode === 'manual' ? ButtonStyle.Primary : ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:set:permissionMode:autoSafe`).setLabel('Auto-Safe').setStyle(effectivePermMode === 'autoSafe' ? ButtonStyle.Success : ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:set:permissionMode:yolo`).setLabel('YOLO').setStyle(effectivePermMode === 'yolo' ? ButtonStyle.Danger : ButtonStyle.Secondary)
                ));
                rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`config:${runnerId}:set:editAcceptMode:default`).setLabel('Edit: Default').setStyle(effectiveEditMode === 'default' ? ButtonStyle.Primary : ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:set:editAcceptMode:acceptEdits`).setLabel('Edit: Accept').setStyle(effectiveEditMode === 'acceptEdits' ? ButtonStyle.Success : ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:toggle:includePartialMessages`).setLabel(claudeDefaults.includePartialMessages === false ? 'Partials ON' : 'Partials OFF').setStyle(claudeDefaults.includePartialMessages === false ? ButtonStyle.Secondary : ButtonStyle.Success)
                ));
                rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`config:${runnerId}:subpage:claude`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:subpage:claude-3`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary)
                ));
            } else {
                rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`config:${runnerId}:set:thinkingLevel:low`).setLabel('Low').setStyle(config.thinkingLevel === 'low' ? ButtonStyle.Primary : ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:set:thinkingLevel:medium`).setLabel('Medium').setStyle(config.thinkingLevel === 'medium' ? ButtonStyle.Primary : ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:set:thinkingLevel:high`).setLabel('High').setStyle(config.thinkingLevel === 'high' ? ButtonStyle.Primary : ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:toggle:yoloMode`).setLabel(config.yoloMode ? 'YOLO ON' : 'YOLO OFF').setStyle(config.yoloMode ? ButtonStyle.Danger : ButtonStyle.Secondary)
                ));
                rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`config:${runnerId}:modal:savePreset`).setLabel('Save Preset').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:modal:applyPreset`).setLabel('Apply Preset').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:modal:deletePreset`).setLabel('Delete Preset').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:action:clearClaudeDefaults`).setLabel('Clear').setStyle(ButtonStyle.Danger)
                ));
                rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`config:${runnerId}:subpage:claude-2`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary)
                ));
            }
            break;
        }

        case 'codex':
        case 'codex-2': {
            const codexDefaults = config.codexDefaults || {};
            embed.setDescription(
                `**Codex Settings (${activeSection === 'codex' ? '1/2' : '2/2'})**\n` +
                (activeSection === 'codex'
                    ? 'Approval gates tool calls, reasoning sets depth, summary controls explanation detail.'
                    : 'Sandbox controls FS/network limits; instructions/schema shape assistant behavior.')
            );
            embed.addFields(
                { name: 'Model', value: codexDefaults.model || 'Auto', inline: true },
                { name: 'Approval', value: codexDefaults.approvalPolicy || 'on-request', inline: true },
                { name: 'Reasoning', value: codexDefaults.reasoningEffort || 'default', inline: true },
                { name: 'Summary', value: codexDefaults.reasoningSummary || 'auto', inline: true },
                { name: 'Sandbox', value: codexDefaults.sandbox || 'default', inline: true },
                { name: 'Base Instructions', value: codexDefaults.baseInstructions ? 'Set' : 'Default', inline: true },
                { name: 'Dev Instructions', value: codexDefaults.developerInstructions ? 'Set' : 'Default', inline: true },
                { name: 'Output Schema', value: codexDefaults.outputSchema ? 'Set' : 'Default', inline: true }
            );
            if (activeSection === 'codex') {
                embed.addFields({
                    name: 'Option Guide',
                    value: [
                        '`Approval` = when Codex asks before actions',
                        '`Reasoning` = depth/cost of reasoning',
                        '`Summary` = verbosity of reasoning summary'
                    ].join('\n'),
                    inline: false
                });
            }

            if (activeSection === 'codex') {
                rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`config:${runnerId}:models:codex`).setLabel('Model').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:modal:setCodexApproval`).setLabel('Approval').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:modal:setCodexReasoning`).setLabel('Reasoning').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:modal:setCodexSummary`).setLabel('Summary').setStyle(ButtonStyle.Secondary)
                ));
                rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`config:${runnerId}:action:clearCodexDefaults`).setLabel('Clear Defaults').setStyle(ButtonStyle.Danger)
                ));
                rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`config:${runnerId}:subpage:codex-2`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary)
                ));
            } else {
                rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`config:${runnerId}:modal:setCodexSandbox`).setLabel('Sandbox').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:modal:setCodexBase`).setLabel('Base Instr').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:modal:setCodexDev`).setLabel('Dev Instr').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:modal:setCodexSchema`).setLabel('Schema').setStyle(ButtonStyle.Secondary)
                ));
                rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`config:${runnerId}:action:clearCodexDefaults`).setLabel('Clear Defaults').setStyle(ButtonStyle.Danger)
                ));
                rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`config:${runnerId}:subpage:codex`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary)
                ));
            }
            break;
        }

        case 'gemini':
        case 'gemini-2': {
            const geminiDefaults = config.geminiDefaults || {};
            const approval = geminiDefaults.approvalMode || 'default';
            const includePartials = geminiDefaults.includePartialMessages === true;
            const extensions = Array.isArray(geminiDefaults.extensions) ? geminiDefaults.extensions : [];
            const allowedMcpServerNames = Array.isArray(geminiDefaults.allowedMcpServerNames)
                ? geminiDefaults.allowedMcpServerNames
                : [];

            embed.setDescription(`**Gemini Settings (${activeSection === 'gemini' ? '1/2' : '2/2'})**`);
            embed.addFields(
                { name: 'Model', value: geminiDefaults.model || 'Auto', inline: true },
                { name: 'Approval Mode', value: approval, inline: true },
                { name: 'Partials', value: includePartials ? 'Enabled' : 'Disabled', inline: true },
                { name: 'Extensions', value: extensions.length > 0 ? `${extensions.length} configured` : 'None', inline: true },
                { name: 'Allowed MCP Servers', value: allowedMcpServerNames.length > 0 ? `${allowedMcpServerNames.length} configured` : 'None', inline: true }
            );

            if (activeSection === 'gemini') {
                rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`config:${runnerId}:set:geminiApprovalMode:default`).setLabel('Default').setStyle(approval === 'default' ? ButtonStyle.Primary : ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:set:geminiApprovalMode:auto_edit`).setLabel('Auto Edit').setStyle(approval === 'auto_edit' ? ButtonStyle.Success : ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:set:geminiApprovalMode:yolo`).setLabel('YOLO').setStyle(approval === 'yolo' ? ButtonStyle.Danger : ButtonStyle.Secondary)
                ));
                rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`config:${runnerId}:modal:setGeminiModel`).setLabel('Set Model').setStyle(ButtonStyle.Primary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:toggle:geminiIncludePartialMessages`).setLabel(includePartials ? 'Partials ON' : 'Partials OFF').setStyle(includePartials ? ButtonStyle.Success : ButtonStyle.Secondary)
                ));
                rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`config:${runnerId}:subpage:gemini-2`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary)
                ));
            } else {
                rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`config:${runnerId}:modal:setGeminiExtensions`).setLabel('Extensions').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:modal:setGeminiAllowedMcpServerNames`).setLabel('Allowed MCP').setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder().setCustomId(`config:${runnerId}:action:clearGeminiDefaults`).setLabel('Clear Defaults').setStyle(ButtonStyle.Danger)
                ));
                rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId(`config:${runnerId}:subpage:gemini`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary)
                ));
            }
            break;
        }

        case 'advanced':
            embed.setDescription('**Advanced Settings**\n\nTechnical configurations and maintenance actions.');

            embed.addFields(
                { name: 'Runner ID', value: `\`${runnerId}\``, inline: true },
                { name: 'Status', value: runner.status || 'unknown', inline: true },
                { name: 'Owner', value: `<@${runner.ownerId}>`, inline: true }
            );

            // Clear all defaults button
            const clearAllBtn = new ButtonBuilder()
                .setCustomId(`config:${runnerId}:action:clearAllDefaults`)
                .setLabel('Clear All Defaults')
                .setStyle(ButtonStyle.Danger);
            rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(clearAllBtn));
            break;
    }

    if (rows.length < 5) {
        rows.push(closeRow);
    }

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
    const parts = customId.split(':');
    if (parts.length < 4) return;

    const runnerId = parts[1];
    const action = parts[2];
    const param = parts.slice(3).join(':');

    const runner = storage.getRunner(runnerId);
    if (!runner || !runner.config) return;

    if (!storage.canUserAccessRunner(userId, runnerId)) {
        await editOrUpdateInteraction(interaction, { content: 'Access Denied' });
        return;
    }

    if (action === 'topPage') {
        const [rawPage = '0', rawSection = 'home'] = param.split(':');
        const requestedPage = rawPage === '1' ? 1 : 0;
        const currentSection = normalizeSection(rawSection as ConfigSection);
        const allowedSections = TOP_NAV_PAGES[requestedPage];
        const nextSection = allowedSections.includes(getBaseSection(currentSection))
            ? currentSection
            : getFirstSectionForTopPage(requestedPage);
        await handleRunnerConfig(interaction as ButtonInteraction, userId, runnerId, nextSection, requestedPage);
        return;
    }

    if (action === 'section') {
        await handleRunnerConfig(interaction as ButtonInteraction, userId, runnerId, normalizeSection(param as ConfigSection));
        return;
    }

    if (action === 'subpage') {
        await handleRunnerConfig(interaction as ButtonInteraction, userId, runnerId, normalizeSection(param as ConfigSection));
        return;
    }

    if (action === 'modal') {
        await handleConfigModal(interaction as ButtonInteraction, runnerId, param);
        return;
    }

    if (action === 'models') {
        const [cliTypeRaw, refreshFlag] = param.split(':');
        const cliType = cliTypeRaw === 'codex' ? 'codex' : 'claude';
        await showDefaultModelPicker(interaction, userId, runnerId, cliType, refreshFlag === 'refresh');
        return;
    }

    if (action === 'selectModel') {
        const cliType = param === 'codex' ? 'codex' : 'claude';
        if (!interaction.isStringSelectMenu()) {
            await interaction.reply({ content: 'Model selection must use the dropdown menu.', flags: 64 });
            return;
        }

        const selected = interaction.values?.[0];
        const defaults = cliType === 'claude'
            ? (runner.config.claudeDefaults = runner.config.claudeDefaults || {})
            : (runner.config.codexDefaults = runner.config.codexDefaults || {});

        if (!selected || selected === AUTO_MODEL_VALUE) {
            delete defaults.model;
        } else {
            defaults.model = selected;
        }

        storage.updateRunner(runnerId, runner);
        storage.logAudit({
            timestamp: new Date().toISOString(),
            type: 'runner_config_update',
            runnerId,
            userId,
            details: { section: `${cliType}_defaults_model` }
        });

        sendRunnerConfigUpdate(runnerId, {
            claudeDefaults: runner.config?.claudeDefaults,
            codexDefaults: runner.config?.codexDefaults,
            geminiDefaults: runner.config?.geminiDefaults
        });

        await handleRunnerConfig(
            interaction as ButtonInteraction,
            userId,
            runnerId,
            cliType === 'claude' ? 'claude' : 'codex'
        );
        return;
    }

    // Update Config
    let updated = false;
    let sectionAfterUpdate: ConfigSection = 'home';

    if (action === 'toggle') {
        if (param === 'autoSync') {
            runner.config.autoSync = !runner.config.autoSync;
            updated = true;
            sectionAfterUpdate = 'threads';
        } else if (param === 'yoloMode') {
            runner.config.yoloMode = !runner.config.yoloMode;
            updated = true;
            sectionAfterUpdate = 'claude-3';
        } else if (param === 'includePartialMessages') {
            runner.config.claudeDefaults = runner.config.claudeDefaults || {};
            const current = runner.config.claudeDefaults.includePartialMessages;
            runner.config.claudeDefaults.includePartialMessages = current === false ? true : false;
            updated = true;
            sectionAfterUpdate = 'claude-2';
        } else if (param === 'strictMcpConfig') {
            runner.config.claudeDefaults = runner.config.claudeDefaults || {};
            runner.config.claudeDefaults.strictMcpConfig = !runner.config.claudeDefaults.strictMcpConfig;
            updated = true;
            sectionAfterUpdate = 'claude-3';
        } else if (param === 'geminiIncludePartialMessages') {
            runner.config.geminiDefaults = runner.config.geminiDefaults || {};
            const current = runner.config.geminiDefaults.includePartialMessages;
            runner.config.geminiDefaults.includePartialMessages = current === true ? false : true;
            updated = true;
            sectionAfterUpdate = 'gemini';
        }
    } else if (action === 'set') {
        if (param === 'archiveDays') {
            sectionAfterUpdate = 'threads';
        } else if (param.startsWith('thinkingLevel')) {
            const level = param.split(':')[1] as 'low'|'medium'|'high';
            runner.config.thinkingLevel = level;
            updated = true;
            sectionAfterUpdate = 'claude-3';
        } else if (param.startsWith('permissionMode')) {
            const mode = param.split(':')[1] as 'manual' | 'autoSafe' | 'yolo';
            runner.config.claudeDefaults = runner.config.claudeDefaults || {};
            runner.config.claudeDefaults.permissionMode = mode;
            updated = true;
            sectionAfterUpdate = 'claude-2';
        } else if (param.startsWith('editAcceptMode')) {
            const mode = param.split(':')[1] as 'default' | 'acceptEdits';
            runner.config.claudeDefaults = runner.config.claudeDefaults || {};
            runner.config.claudeDefaults.editAcceptMode = mode;
            updated = true;
            sectionAfterUpdate = 'claude-2';
        } else if (param.startsWith('geminiApprovalMode')) {
            const mode = param.split(':')[1] as 'default' | 'auto_edit' | 'yolo';
            runner.config.geminiDefaults = runner.config.geminiDefaults || {};
            runner.config.geminiDefaults.approvalMode = mode;
            updated = true;
            sectionAfterUpdate = 'gemini';
        }
    } else if (action === 'action') {
        if (param === 'clearClaudeDefaults') {
            runner.config.claudeDefaults = {};
            updated = true;
            sectionAfterUpdate = 'claude';
        } else if (param === 'clearCodexDefaults') {
            runner.config.codexDefaults = {};
            updated = true;
            sectionAfterUpdate = 'codex';
        } else if (param === 'clearGeminiDefaults') {
            runner.config.geminiDefaults = {};
            updated = true;
            sectionAfterUpdate = 'gemini';
        } else if (param === 'clearAllDefaults') {
            runner.config.claudeDefaults = {};
            runner.config.codexDefaults = {};
            runner.config.geminiDefaults = {};
            updated = true;
            sectionAfterUpdate = 'advanced';
        }
    }

    if (interaction.isStringSelectMenu() && action === 'set' && param === 'archiveDays') {
        const value = parseInt(interaction.values[0], 10);
        runner.config.threadArchiveDays = value;
        updated = true;
        sectionAfterUpdate = 'threads';
    }

    if (updated) {
        storage.updateRunner(runnerId, runner);
        storage.logAudit({
            timestamp: new Date().toISOString(),
            type: 'runner_config_update',
            runnerId,
            userId,
            details: { section: 'claude_defaults' }
        });

        sendRunnerConfigUpdate(runnerId, {
            claudeDefaults: runner.config?.claudeDefaults,
            codexDefaults: runner.config?.codexDefaults,
            geminiDefaults: runner.config?.geminiDefaults
        });

        await handleRunnerConfig(interaction as ButtonInteraction, userId, runnerId, sectionAfterUpdate);
    }
}

async function handleConfigModal(
    interaction: ButtonInteraction,
    runnerId: string,
    param: string
): Promise<void> {
    const modalTitle = param.startsWith('setCodex')
        ? 'Update Codex Defaults'
        : param.startsWith('setGemini')
        ? 'Update Gemini Defaults'
        : 'Update Claude Defaults';
    const modal = new ModalBuilder()
        .setCustomId(`config_modal:${runnerId}:${param}`)
        .setTitle(modalTitle);

    const input = new TextInputBuilder()
        .setRequired(true)
        .setStyle(TextInputStyle.Short);

    if (param === 'setModel') {
        input.setCustomId('model').setLabel('Model (e.g., claude-sonnet-4-5)');
    } else if (param === 'setMaxTurns') {
        input.setCustomId('maxTurns').setLabel('Max Turns (number)');
    } else if (param === 'setMaxThinking') {
        input.setCustomId('maxThinkingTokens').setLabel('Max Thinking Tokens (number)');
    } else if (param === 'setFallbackModel') {
        input.setCustomId('fallbackModel').setLabel('Fallback Model (optional)');
    } else if (param === 'setMaxBudget') {
        input.setCustomId('maxBudgetUsd').setLabel('Max Budget USD (number)');
    } else if (param === 'setAgent') {
        input.setCustomId('agent').setLabel('Agent Name');
    } else if (param === 'setAllowedTools') {
        input.setCustomId('allowedTools').setLabel('Allowed Tools (comma-separated)');
    } else if (param === 'setDisallowedTools') {
        input.setCustomId('disallowedTools').setLabel('Disallowed Tools (comma-separated)');
    } else if (param === 'setToolsList') {
        input.setCustomId('toolsList').setLabel('Tools List (comma-separated or "default")');
    } else if (param === 'setBetas') {
        input.setCustomId('betas').setLabel('Betas (comma-separated)');
    } else if (param === 'setSettingSources') {
        input.setCustomId('settingSources').setLabel('Setting Sources (comma-separated)');
    } else if (param === 'setAdditionalDirs') {
        input.setCustomId('additionalDirectories').setLabel('Additional Dirs (comma-separated)');
    } else if (param === 'setJsonSchema') {
        input.setCustomId('jsonSchema').setLabel('JSON Schema (JSON string)');
    } else if (param === 'setMcpServers') {
        input.setCustomId('mcpServers').setLabel('MCP Servers (JSON)');
    } else if (param === 'setPlugins') {
        input.setCustomId('plugins').setLabel('Plugins (JSON array)');
    } else if (param === 'setExtraArgs') {
        input.setCustomId('extraArgs').setLabel('Extra Args (JSON object)');
    } else if (param === 'setSandbox') {
        input.setCustomId('sandbox').setLabel('Sandbox (string)');
    } else if (param === 'setCodexModel') {
        input.setCustomId('codexModel').setLabel('Model (e.g., gpt-5.1)');
    } else if (param === 'setCodexApproval') {
        input.setCustomId('codexApproval').setLabel('Approval (untrusted/on-fail/on-req/never)');
    } else if (param === 'setCodexReasoning') {
        input.setCustomId('codexReasoning').setLabel('Reasoning (none/min/low/med/high/xhigh)');
    } else if (param === 'setCodexSummary') {
        input.setCustomId('codexSummary').setLabel('Summary (auto/concise/detailed/none)');
    } else if (param === 'setCodexSandbox') {
        input.setCustomId('codexSandbox').setLabel('Sandbox (ro/workspace-write/full-access)');
    } else if (param === 'setCodexBase') {
        input.setCustomId('codexBase').setLabel('Base Instructions');
        input.setStyle(TextInputStyle.Paragraph);
    } else if (param === 'setCodexDev') {
        input.setCustomId('codexDev').setLabel('Developer Instructions');
        input.setStyle(TextInputStyle.Paragraph);
    } else if (param === 'setCodexSchema') {
        input.setCustomId('codexSchema').setLabel('Output Schema (JSON)');
        input.setStyle(TextInputStyle.Paragraph);
    } else if (param === 'setGeminiModel') {
        input.setCustomId('geminiModel').setLabel('Model (e.g., gemini-2.5-pro)');
    } else if (param === 'setGeminiExtensions') {
        input.setCustomId('geminiExtensions').setLabel('Extensions (comma-separated)');
    } else if (param === 'setGeminiAllowedMcpServerNames') {
        input.setCustomId('geminiAllowedMcpServerNames').setLabel('Allowed MCP Servers (comma-separated)');
    } else if (param === 'savePreset') {
        input.setCustomId('presetName').setLabel('Preset Name');
    } else if (param === 'applyPreset') {
        input.setCustomId('presetName').setLabel('Preset Name to Apply');
    } else if (param === 'deletePreset') {
        input.setCustomId('presetName').setLabel('Preset Name to Delete');
    } else {
        await interaction.reply({ content: 'Unknown configuration option.', flags: 64 });
        return;
    }

    const row = new ActionRowBuilder<TextInputBuilder>().addComponents(input);
    modal.addComponents(row);
    await interaction.showModal(modal);
}

function sendRunnerConfigUpdate(
    runnerId: string,
    defaults: { claudeDefaults?: Record<string, any>; codexDefaults?: Record<string, any>; geminiDefaults?: Record<string, any> }
): void {
    const ws = botState.runnerConnections.get(runnerId);
    if (!ws) {
        console.warn(`[RunnerConfig] Runner ${runnerId} not connected; cannot update defaults.`);
        return;
    }
    if (!defaults.claudeDefaults && !defaults.codexDefaults && !defaults.geminiDefaults) {
        console.warn(`[RunnerConfig] No defaults to update for ${runnerId}`);
        return;
    }

    // Sanitize claudeDefaults before sending to runner-agent
    // Discord-bot uses permissionMode: 'manual' | 'autoSafe' | 'yolo' for tool permissions
    // Runner-agent uses permissionMode: 'default' | 'acceptEdits' for edit acceptance
    // These are different concepts, so we strip permissionMode from what we send
    const sanitizedClaudeDefaults = defaults.claudeDefaults ? { ...defaults.claudeDefaults } : undefined;
    if (sanitizedClaudeDefaults) {
        // Remove discord-bot specific permissionMode (mapped to skipPermissions/autoApproveSafe at session start)
        delete sanitizedClaudeDefaults.permissionMode;
    }

    const requestId = `runner_config_${runnerId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const timeout = setTimeout(() => {
        botState.pendingRunnerConfigUpdates.delete(requestId);
        console.warn(`[RunnerConfig] No ack for config update ${requestId}`);
    }, 10000);
    botState.pendingRunnerConfigUpdates.set(requestId, timeout);
    ws.send(JSON.stringify({
        type: 'runner_config_update',
        data: {
            runnerId,
            ...(sanitizedClaudeDefaults && Object.keys(sanitizedClaudeDefaults).length > 0 ? { claudeDefaults: sanitizedClaudeDefaults } : {}),
            ...(defaults.codexDefaults ? { codexDefaults: defaults.codexDefaults } : {}),
            ...(defaults.geminiDefaults ? { geminiDefaults: defaults.geminiDefaults } : {}),
            requestId
        }
    }));
}
