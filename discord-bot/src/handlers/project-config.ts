/**
 * Project Configuration Handler
 *
 * Manages project-level settings UI, similar to config.ts for runners.
 */

import {
    ButtonInteraction,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} from 'discord.js';
import { storage } from '../storage.js';
import { projectSettingsStore } from '../services/project-settings.js';
import { createErrorEmbed } from '../utils/embeds.js';
import type { ProjectConfig } from '../../../shared/types.js';

type ConfigSection = 'main' | 'reset';

async function editOrUpdateInteraction(interaction: any, payload: any): Promise<void> {
    if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
    } else {
        await interaction.update(payload);
    }
}

/**
 * Handle project config button interactions
 * Custom ID format: project_config:{runnerId}:{projectPath}:{action}:{param}
 */
export async function handleProjectConfigButton(
    interaction: ButtonInteraction,
    userId: string,
    customId: string
): Promise<void> {
    // Parse custom ID
    const parts = customId.split(':');
    if (parts.length < 4) {
        await editOrUpdateInteraction(interaction, {
            embeds: [createErrorEmbed('Invalid Request', 'Malformed button ID.')]
        });
        return;
    }

    const runnerId = parts[1];
    const projectPath = decodeURIComponent(parts[2]);
    const action = parts[3];
    const param = parts.slice(4).join(':') || undefined;

    const runner = storage.getRunner(runnerId);
    if (!runner) {
        await editOrUpdateInteraction(interaction, {
            embeds: [createErrorEmbed('Runner Not Found', 'This runner no longer exists.')]
        });
        return;
    }

    if (!storage.canUserAccessRunner(userId, runnerId)) {
        await editOrUpdateInteraction(interaction, {
            embeds: [createErrorEmbed('Access Denied', 'You do not have access to this project.')]
        });
        return;
    }

    // Route to appropriate handler
    switch (action) {
        case 'section':
            await showProjectConfig(interaction, userId, runnerId, projectPath, (param as ConfigSection) || 'main');
            break;
        case 'set':
            if (!param) {
                await editOrUpdateInteraction(interaction, {
                    embeds: [createErrorEmbed('Invalid Request', 'Missing setting key/value.')]
                });
                return;
            }
            await handleSetProjectConfig(interaction, userId, runnerId, projectPath, param);
            break;
        case 'reset':
            await handleResetProjectConfig(interaction, userId, runnerId, projectPath);
            break;
        default:
            await editOrUpdateInteraction(interaction, {
                embeds: [createErrorEmbed('Unknown Action', `Unknown action: ${action}`)]
            });
    }
}

/**
 * Show project configuration UI
 */
export async function showProjectConfig(
    interaction: any,
    userId: string,
    runnerId: string,
    projectPath: string,
    section: ConfigSection = 'main'
): Promise<void> {
    const runner = storage.getRunner(runnerId);
    if (!runner || !storage.canUserAccessRunner(userId, runnerId)) {
        const embeds = [createErrorEmbed('Access Denied', 'You do not have access to this project.')];
        await editOrUpdateInteraction(interaction, { embeds });
        return;
    }

    const folderName = projectPath.split('/').pop() || projectPath;
    const projectConfig = projectSettingsStore.getConfig(runnerId, projectPath);
    const runnerConfig = runner.config || {};

    const embed = new EmbedBuilder()
        .setTitle(`Project Settings: ${folderName}`)
        .setDescription(`\`${projectPath}\`\n\nConfigure project-specific defaults that override runner settings.`)
        .setColor(0x5ca1e6);

    const rows: ActionRowBuilder<ButtonBuilder>[] = [];

    // Navigation tabs
    const navRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`project_config:${runnerId}:${encodeURIComponent(projectPath)}:section:main`)
                .setLabel('Main')
                .setStyle(section === 'main' ? ButtonStyle.Primary : ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`project_config:${runnerId}:${encodeURIComponent(projectPath)}:section:reset`)
                .setLabel('Reset')
                .setStyle(ButtonStyle.Danger)
        );
    rows.push(navRow);

    if (section === 'main') {
        // Permission Mode
        const runnerPermMode = runnerConfig.claudeDefaults?.permissionMode ||
            (runnerConfig.yoloMode ? 'yolo' : 'manual');
        const effectivePermMode = projectConfig.permissionMode || runnerPermMode;
        const permRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`project_config:${runnerId}:${encodeURIComponent(projectPath)}:set:permissionMode:manual`)
                    .setLabel('Manual')
                    .setStyle(effectivePermMode === 'manual' ? ButtonStyle.Success : ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`project_config:${runnerId}:${encodeURIComponent(projectPath)}:set:permissionMode:autoSafe`)
                    .setLabel('Auto-Safe')
                    .setStyle(effectivePermMode === 'autoSafe' ? ButtonStyle.Primary : ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`project_config:${runnerId}:${encodeURIComponent(projectPath)}:set:permissionMode:yolo`)
                    .setLabel('YOLO')
                    .setStyle(effectivePermMode === 'yolo' ? ButtonStyle.Danger : ButtonStyle.Secondary)
            );
        rows.push(permRow);

        // Default CLI Type
        const cliRow = new ActionRowBuilder<ButtonBuilder>();
        const effectiveCli = projectConfig.defaultCliType || runner.cliTypes[0] || 'claude';
        for (const cli of runner.cliTypes) {
            cliRow.addComponents(
                new ButtonBuilder()
                    .setCustomId(`project_config:${runnerId}:${encodeURIComponent(projectPath)}:set:defaultCliType:${cli}`)
                    .setLabel(cli.toUpperCase())
                    .setStyle(effectiveCli === cli ? ButtonStyle.Primary : ButtonStyle.Secondary)
            );
        }
        if (cliRow.components.length > 0) {
            rows.push(cliRow);
        }

        // Thinking Level
        const thinkingRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                ...(['low', 'medium', 'high'] as const).map(level =>
                    new ButtonBuilder()
                        .setCustomId(`project_config:${runnerId}:${encodeURIComponent(projectPath)}:set:thinkingLevel:${level}`)
                        .setLabel(level.charAt(0).toUpperCase() + level.slice(1))
                        .setStyle((projectConfig.thinkingLevel || runnerConfig.thinkingLevel || 'low') === level ? ButtonStyle.Primary : ButtonStyle.Secondary)
                )
            );
        rows.push(thinkingRow);

        // Auto-Spawn
        const autoSpawnEnabled = projectConfig.autoSpawnEnabled !== false; // Default true
        const autoSpawnRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`project_config:${runnerId}:${encodeURIComponent(projectPath)}:set:autoSpawnEnabled:true`)
                    .setLabel('Auto-Spawn ON')
                    .setStyle(autoSpawnEnabled ? ButtonStyle.Success : ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`project_config:${runnerId}:${encodeURIComponent(projectPath)}:set:autoSpawnEnabled:false`)
                    .setLabel('Auto-Spawn OFF')
                    .setStyle(!autoSpawnEnabled ? ButtonStyle.Danger : ButtonStyle.Secondary)
            );
        rows.push(autoSpawnRow);

        // Show current settings
        const hasOverrides = Object.keys(projectConfig).length > 0;
        embed.addFields(
            { name: 'Permission Mode', value: effectivePermMode + (projectConfig.permissionMode ? '' : ' _inherited_'), inline: true },
            { name: 'Default CLI', value: effectiveCli.toUpperCase() + (projectConfig.defaultCliType ? '' : ' _inherited_'), inline: true },
            { name: 'Thinking Level', value: (projectConfig.thinkingLevel || runnerConfig.thinkingLevel || 'low') + (projectConfig.thinkingLevel ? '' : ' _inherited_'), inline: true },
            { name: 'Auto-Spawn', value: autoSpawnEnabled ? 'Enabled' : 'Disabled', inline: true },
            { name: 'Status', value: hasOverrides ? 'Using project overrides' : 'Inheriting from runner', inline: false }
        );
    } else if (section === 'reset') {
        embed.setDescription('**Reset Project Settings**\n\nClear all project-specific overrides and inherit from runner defaults.');
        embed.addFields({
            name: 'Warning',
            value: 'This will remove all custom settings for this project.',
            inline: false
        });

        const resetRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`project_config:${runnerId}:${encodeURIComponent(projectPath)}:reset:confirm`)
                    .setLabel('Reset to Runner Defaults')
                    .setStyle(ButtonStyle.Danger)
            );
        rows.push(resetRow);
    }

    // Add close button row (if we have room - Discord max is 5 rows)
    if (rows.length < 5) {
        const closeRow = new ActionRowBuilder<ButtonBuilder>()
            .addComponents(
                new ButtonBuilder()
                    .setCustomId(`project_dashboard:${runnerId}:${encodeURIComponent(projectPath)}`)
                    .setLabel('Back to Dashboard')
                    .setStyle(ButtonStyle.Secondary)
            );
        rows.push(closeRow);
    }

    await editOrUpdateInteraction(interaction, { embeds: [embed], components: rows });
}

/**
 * Handle setting a project config value
 */
async function handleSetProjectConfig(
    interaction: any,
    userId: string,
    runnerId: string,
    projectPath: string,
    param: string
): Promise<void> {
    // Parse key:value from param
    const colonIndex = param.indexOf(':');
    if (colonIndex === -1) {
        await editOrUpdateInteraction(interaction, {
            embeds: [createErrorEmbed('Invalid Setting', 'Expected key:value format.')]
        });
        return;
    }

    const key = param.slice(0, colonIndex);
    let value: any = param.slice(colonIndex + 1);

    // Parse value types
    if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (/^\d+$/.test(value)) value = parseInt(value, 10);

    // Update config
    projectSettingsStore.update(runnerId, projectPath, { [key]: value });

    // Show updated config
    await showProjectConfig(interaction, userId, runnerId, projectPath, 'main');
}

/**
 * Handle resetting project config
 */
async function handleResetProjectConfig(
    interaction: any,
    userId: string,
    runnerId: string,
    projectPath: string
): Promise<void> {
    projectSettingsStore.delete(runnerId, projectPath);

    // Show main section after reset
    await showProjectConfig(interaction, userId, runnerId, projectPath, 'main');
}
