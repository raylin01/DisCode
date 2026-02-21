/**
 * Dashboard Command Handler
 *
 * Shows runner or project dashboard based on context.
 */

import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} from 'discord.js';
import { storage } from '../../storage.js';
import { getCategoryManager } from '../../services/category-manager.js';
import { projectSettingsStore } from '../../services/project-settings.js';
import { createErrorEmbed, createInfoEmbed } from '../../utils/embeds.js';

/**
 * Handle /dashboard command
 */
export async function handleDashboard(
    interaction: any,
    userId: string
): Promise<void> {
    const channelId = interaction.channelId;

    // Determine context: runner control channel or project channel
    const categoryManager = getCategoryManager();
    if (!categoryManager) {
        await interaction.reply({
            embeds: [createErrorEmbed('Error', 'Category manager not available')],
            flags: 64
        });
        return;
    }

    // Check if we're in a project channel
    const projectInfo = categoryManager.getProjectByChannelId(channelId);

    if (projectInfo) {
        // Project dashboard
        await showProjectDashboard(interaction, userId, projectInfo);
    } else {
        // Check if we're in a runner control channel
        const runnerId = categoryManager.getRunnerByChannelId(channelId);
        const runnerCategory = runnerId ? categoryManager.getRunnerCategory(runnerId) : null;

        // Verify it's the control channel, not just any channel in the category
        if (runnerCategory && runnerCategory.controlChannelId === channelId) {
            await showRunnerDashboard(interaction, userId, runnerId);
        } else {
            await interaction.reply({
                embeds: [createInfoEmbed(
                    'Dashboard',
                    'Run `/dashboard` from a **runner control channel** or **project channel** to see the dashboard.\n\n' +
                    'Runner control channels are named `runner-control` in each runner category. ' +
                    'Project channels start with `project-`.'
                )],
                flags: 64
            });
        }
    }
}

/**
 * Show runner dashboard with editable settings
 */
async function showRunnerDashboard(
    interaction: any,
    userId: string,
    runnerId: string
): Promise<void> {
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
            embeds: [createErrorEmbed('Access Denied', 'You do not have access to this runner.')],
            flags: 64
        });
        return;
    }

    const categoryManager = getCategoryManager();
    const runnerCategory = categoryManager?.getRunnerCategory(runnerId);

    const config = runner.config || {};

    // Build dashboard embed
    const embed = new EmbedBuilder()
        .setTitle(`Runner: ${runner.name}`)
        .setColor(runner.status === 'online' ? 0x00FF00 : 0x808080)
        .setTimestamp();

    // Status section
    let projectsSummary = '_No projects yet. Use `/sync-projects` to discover._';
    if (runnerCategory && runnerCategory.projects.size > 0) {
        const projectLines: string[] = [];
        for (const [path, project] of runnerCategory.projects) {
            const folderName = path.split('/').pop() || path;
            const hasOverrides = projectSettingsStore.hasOverrides(runnerId, path);
            projectLines.push(`- ${folderName}${hasOverrides ? ' *customized*' : ''}`);
        }
        projectsSummary = projectLines.join('\n');
    }

    embed.addFields(
        { name: 'Status', value: runner.status === 'online' ? 'Online' : 'Offline', inline: true },
        { name: 'CLI Types', value: runner.cliTypes.map(t => t.toUpperCase()).join(', ') || 'N/A', inline: true },
        { name: 'Projects', value: projectsSummary, inline: false }
    );

    // Settings section
    const claudeDefaults = config.claudeDefaults || {};
    const permMode = claudeDefaults.permissionMode || (config.yoloMode ? 'yolo' : 'manual');
    const editMode = claudeDefaults.editAcceptMode || 'default';

    embed.addFields(
        { name: '--- Default Settings ---', value: 'These apply to all sessions unless overridden at project level', inline: false },
        { name: 'Permission Mode', value: permMode, inline: true },
        { name: 'Edit Mode', value: editMode, inline: true },
        { name: 'Thinking Level', value: config.thinkingLevel || 'low', inline: true },
        { name: 'Thread Archive', value: `${config.threadArchiveDays || 3} days`, inline: true }
    );

    // Action buttons
    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`runner_config:${runnerId}`)
                .setLabel('Edit Settings')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`sync_projects:${runnerId}`)
                .setLabel('Sync Projects')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`runner_stats:${runnerId}`)
                .setLabel('Stats')
                .setStyle(ButtonStyle.Secondary)
        );

    const toolsRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`runner_health:${runnerId}`)
                .setLabel('Health')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`runner_logs:${runnerId}`)
                .setLabel('Logs')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`runner_clis:${runnerId}`)
                .setLabel('List CLIs')
                .setStyle(ButtonStyle.Secondary)
        );

    await interaction.reply({
        embeds: [embed],
        components: [row, toolsRow],
        flags: 64
    });
}

/**
 * Show project dashboard with editable settings
 */
async function showProjectDashboard(
    interaction: any,
    userId: string,
    projectInfo: { runnerId: string; projectPath: string; project: any }
): Promise<void> {
    const { runnerId, projectPath } = projectInfo;

    const runner = storage.getRunner(runnerId);
    if (!runner) {
        await interaction.reply({
            embeds: [createErrorEmbed('Runner Not Found', 'Runner for this project no longer exists.')],
            flags: 64
        });
        return;
    }

    if (!storage.canUserAccessRunner(userId, runnerId)) {
        await interaction.reply({
            embeds: [createErrorEmbed('Access Denied', 'You do not have access to this project.')],
            flags: 64
        });
        return;
    }

    const folderName = projectPath.split('/').pop() || projectPath;
    const projectConfig = projectSettingsStore.getConfig(runnerId, projectPath);
    const runnerConfig = runner.config || {};

    // Get project stats from storage
    const sessions = storage.getRunnerSessions(runnerId);
    const projectSessions = sessions.filter(s => s.folderPath === projectPath);
    const activeSessions = projectSessions.filter(s => s.status === 'active').length;

    // Build dashboard embed
    const embed = new EmbedBuilder()
        .setTitle(`Project: ${folderName}`)
        .setDescription(`\`${projectPath}\``)
        .setColor(activeSessions > 0 ? 0x00FF00 : 0x808080)
        .setTimestamp();

    // Status section
    embed.addFields(
        { name: 'Active Sessions', value: String(activeSessions), inline: true },
        { name: 'Total Sessions', value: String(projectSessions.length), inline: true }
    );

    // Settings section with inheritance info
    const hasOverrides = Object.keys(projectConfig).length > 0;
    embed.addFields(
        { name: '--- Settings ---', value: hasOverrides ? '*Using project overrides*' : '*Inheriting from runner defaults*', inline: false }
    );

    // Show effective settings (project override or runner default)
    const runnerPermMode = runnerConfig.claudeDefaults?.permissionMode ||
        (runnerConfig.yoloMode ? 'yolo' : 'manual');
    const permMode = projectConfig.permissionMode || runnerPermMode;
    const thinkLevel = projectConfig.thinkingLevel || runnerConfig.thinkingLevel || 'low';
    const defaultCli = projectConfig.defaultCliType || runner.cliTypes[0] || 'claude';
    const autoSpawn = projectConfig.autoSpawnEnabled !== false ? 'Enabled' : 'Disabled';

    embed.addFields(
        { name: 'Permission Mode', value: permMode, inline: true },
        { name: 'Default CLI', value: defaultCli.toUpperCase(), inline: true },
        { name: 'Thinking Level', value: thinkLevel, inline: true },
        { name: 'Auto-Spawn', value: autoSpawn, inline: true }
    );

    // Action buttons - unified dashboard with all key actions
    const row1 = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`new_session:${runnerId}:${encodeURIComponent(projectPath)}`)
                .setLabel('New Session')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`list_sessions:${runnerId}:${encodeURIComponent(projectPath)}`)
                .setLabel('All Sessions')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`project_config:${runnerId}:${encodeURIComponent(projectPath)}:section:main`)
                .setLabel('Edit Settings')
                .setStyle(ButtonStyle.Primary)
        );

    const row2 = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`sync_sessions:${runnerId}:${encodeURIComponent(projectPath)}`)
                .setLabel('Sync Sessions')
                .setStyle(ButtonStyle.Secondary)
        );

    await interaction.reply({
        embeds: [embed],
        components: [row1, row2],
        flags: 64
    });
}

/**
 * Helper to update or edit reply based on interaction state
 */
async function editOrUpdateInteraction(interaction: any, payload: any): Promise<void> {
    if (interaction.deferred || interaction.replied) {
        await interaction.editReply(payload);
    } else {
        await interaction.update(payload);
    }
}

/**
 * Handle runner dashboard button (from config close button)
 */
export async function handleRunnerDashboardButton(
    interaction: any,
    userId: string,
    runnerId: string
): Promise<void> {
    const runner = storage.getRunner(runnerId);
    if (!runner) {
        await editOrUpdateInteraction(interaction, {
            embeds: [createErrorEmbed('Runner Not Found', 'This runner no longer exists.')],
            components: []
        });
        return;
    }

    if (!storage.canUserAccessRunner(userId, runnerId)) {
        await editOrUpdateInteraction(interaction, {
            embeds: [createErrorEmbed('Access Denied', 'You do not have access to this runner.')],
            components: []
        });
        return;
    }

    const categoryManager = getCategoryManager();
    const runnerCategory = categoryManager?.getRunnerCategory(runnerId);
    const config = runner.config || {};

    const embed = new EmbedBuilder()
        .setTitle(`Runner: ${runner.name}`)
        .setColor(runner.status === 'online' ? 0x00FF00 : 0x808080)
        .setTimestamp();

    let projectsSummary = '_No projects yet. Use `/sync-projects` to discover._';
    if (runnerCategory && runnerCategory.projects.size > 0) {
        const projectLines: string[] = [];
        for (const [path, project] of runnerCategory.projects) {
            const folderName = path.split('/').pop() || path;
            const hasOverrides = projectSettingsStore.hasOverrides(runnerId, path);
            projectLines.push(`- ${folderName}${hasOverrides ? ' *customized*' : ''}`);
        }
        projectsSummary = projectLines.join('\n');
    }

    embed.addFields(
        { name: 'Status', value: runner.status === 'online' ? 'Online' : 'Offline', inline: true },
        { name: 'CLI Types', value: runner.cliTypes.map(t => t.toUpperCase()).join(', ') || 'N/A', inline: true },
        { name: 'Projects', value: projectsSummary, inline: false }
    );

    const claudeDefaults = config.claudeDefaults || {};
    const permMode = claudeDefaults.permissionMode || (config.yoloMode ? 'yolo' : 'manual');
    const editMode = claudeDefaults.editAcceptMode || 'default';

    embed.addFields(
        { name: '--- Default Settings ---', value: 'These apply to all sessions unless overridden at project level', inline: false },
        { name: 'Permission Mode', value: permMode, inline: true },
        { name: 'Edit Mode', value: editMode, inline: true },
        { name: 'Thinking Level', value: config.thinkingLevel || 'low', inline: true },
        { name: 'Thread Archive', value: `${config.threadArchiveDays || 3} days`, inline: true }
    );

    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`runner_config:${runnerId}`)
                .setLabel('Edit Settings')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`sync_projects:${runnerId}`)
                .setLabel('Sync Projects')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`runner_stats:${runnerId}`)
                .setLabel('Stats')
                .setStyle(ButtonStyle.Secondary)
        );

    const toolsRow = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`runner_health:${runnerId}`)
                .setLabel('Health')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`runner_logs:${runnerId}`)
                .setLabel('Logs')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`runner_clis:${runnerId}`)
                .setLabel('List CLIs')
                .setStyle(ButtonStyle.Secondary)
        );

    await editOrUpdateInteraction(interaction, {
        embeds: [embed],
        components: [row, toolsRow]
    });
}

/**
 * Handle project dashboard button (from project config close button)
 */
export async function handleProjectDashboardButton(
    interaction: any,
    userId: string,
    runnerId: string,
    projectPath: string
): Promise<void> {
    const runner = storage.getRunner(runnerId);
    if (!runner) {
        await editOrUpdateInteraction(interaction, {
            embeds: [createErrorEmbed('Runner Not Found', 'Runner for this project no longer exists.')],
            components: []
        });
        return;
    }

    if (!storage.canUserAccessRunner(userId, runnerId)) {
        await editOrUpdateInteraction(interaction, {
            embeds: [createErrorEmbed('Access Denied', 'You do not have access to this project.')],
            components: []
        });
        return;
    }

    const folderName = projectPath.split('/').pop() || projectPath;
    const projectConfig = projectSettingsStore.getConfig(runnerId, projectPath);
    const runnerConfig = runner.config || {};

    const sessions = storage.getRunnerSessions(runnerId);
    const projectSessions = sessions.filter(s => s.folderPath === projectPath);
    const activeSessions = projectSessions.filter(s => s.status === 'active').length;

    const embed = new EmbedBuilder()
        .setTitle(`Project: ${folderName}`)
        .setDescription(`\`${projectPath}\``)
        .setColor(activeSessions > 0 ? 0x00FF00 : 0x808080)
        .setTimestamp();

    embed.addFields(
        { name: 'Active Sessions', value: String(activeSessions), inline: true },
        { name: 'Total Sessions', value: String(projectSessions.length), inline: true }
    );

    const hasOverrides = Object.keys(projectConfig).length > 0;
    embed.addFields(
        { name: '--- Settings ---', value: hasOverrides ? '*Using project overrides*' : '*Inheriting from runner defaults*', inline: false }
    );

    const runnerPermMode = runnerConfig.claudeDefaults?.permissionMode ||
        (runnerConfig.yoloMode ? 'yolo' : 'manual');
    const permMode = projectConfig.permissionMode || runnerPermMode;
    const thinkLevel = projectConfig.thinkingLevel || runnerConfig.thinkingLevel || 'low';
    const defaultCli = projectConfig.defaultCliType || runner.cliTypes[0] || 'claude';
    const autoSpawn = projectConfig.autoSpawnEnabled !== false ? 'Enabled' : 'Disabled';

    embed.addFields(
        { name: 'Permission Mode', value: permMode, inline: true },
        { name: 'Default CLI', value: defaultCli.toUpperCase(), inline: true },
        { name: 'Thinking Level', value: thinkLevel, inline: true },
        { name: 'Auto-Spawn', value: autoSpawn, inline: true }
    );

    const row1 = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`new_session:${runnerId}:${encodeURIComponent(projectPath)}`)
                .setLabel('New Session')
                .setStyle(ButtonStyle.Success),
            new ButtonBuilder()
                .setCustomId(`list_sessions:${runnerId}:${encodeURIComponent(projectPath)}`)
                .setLabel('All Sessions')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`project_config:${runnerId}:${encodeURIComponent(projectPath)}:section:main`)
                .setLabel('Edit Settings')
                .setStyle(ButtonStyle.Primary)
        );

    const row2 = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`sync_sessions:${runnerId}:${encodeURIComponent(projectPath)}`)
                .setLabel('Sync Sessions')
                .setStyle(ButtonStyle.Secondary)
        );

    await editOrUpdateInteraction(interaction, {
        embeds: [embed],
        components: [row1, row2]
    });
}
