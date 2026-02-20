/**
 * Channel Factory Module
 *
 * Handles creation and management of Discord channels for runners and projects.
 * Includes category creation, stats channels, and project channels.
 */

import {
    Client,
    Guild,
    TextChannel,
    ChannelType,
    PermissionFlagsBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} from 'discord.js';
import { buildChannelPermissionOverwrites, RunnerPermissionInfo } from './permission-setup.js';
import { storage } from '../storage.js';
import { projectSettingsStore } from './project-settings.js';

// ============================================================================
// Types
// ============================================================================

export interface ProjectChannel {
    channelId: string;
    projectPath: string;
    dashboardMessageId?: string;
    lastSync?: Date;
}

export interface ProjectStats {
    totalSessions: number;
    activeSessions: number;
    pendingActions: number;
    lastActivity?: Date;
}

export interface RunnerCategory {
    runnerId: string;
    guildId: string;
    categoryId: string;
    controlChannelId: string;
    statsChannelIds: {
        sessions?: string;
        pending?: string;
        memory?: string;
    };
    projects: Map<string, ProjectChannel>;
}

export interface CategoryCreationResult {
    category: RunnerCategory;
    categoryChannel: any;
    sessionsChannel: any;
    pendingChannel: any;
    controlChannel: any;
}

// ============================================================================
// Channel Creation Functions
// ============================================================================

/**
 * Create a runner category with all associated channels
 */
export async function createRunnerCategoryStructure(
    client: Client,
    guildId: string,
    runnerId: string,
    runnerName: string,
    runner: RunnerPermissionInfo | null
): Promise<CategoryCreationResult | null> {
    const guild = await client.guilds.fetch(guildId);

    // Build permission overwrites - deny everyone, allow owner + authorized users
    const permissionOverwrites = buildChannelPermissionOverwrites(
        runner || { ownerId: '', authorizedUsers: [] },
        guild.roles.everyone.id
    );

    console.log(`[ChannelFactory] Creating category for ${runnerName} with ${permissionOverwrites.length} permission overwrites`);

    // Create the main category with restricted permissions
    const categoryChannel = await guild.channels.create({
        name: `🖥️ ${runnerName}`,
        type: ChannelType.GuildCategory,
        permissionOverwrites: permissionOverwrites as any
    });

    // Create stats channels with same permissions (inherits from category, but explicit for safety)
    const sessionsChannel = await guild.channels.create({
        name: '📊-0-active',
        type: ChannelType.GuildText,
        parent: categoryChannel.id,
        position: 0,
        permissionOverwrites: permissionOverwrites as any
    });

    const pendingChannel = await guild.channels.create({
        name: '⚠️-0-pending',
        type: ChannelType.GuildText,
        parent: categoryChannel.id,
        position: 1,
        permissionOverwrites: permissionOverwrites as any
    });

    // Create runner control channel with same permissions
    const controlChannel = await guild.channels.create({
        name: 'runner-control',
        type: ChannelType.GuildText,
        parent: categoryChannel.id,
        topic: `Control channel for ${runnerName}. Use /sync-projects to discover projects.`,
        permissionOverwrites: permissionOverwrites as any
    });

    const runnerCategory: RunnerCategory = {
        runnerId,
        guildId,
        categoryId: categoryChannel.id,
        controlChannelId: controlChannel.id,
        statsChannelIds: {
            sessions: sessionsChannel.id,
            pending: pendingChannel.id
        },
        projects: new Map()
    };

    return {
        category: runnerCategory,
        categoryChannel,
        sessionsChannel,
        pendingChannel,
        controlChannel
    };
}

/**
 * Create a project channel within a runner's category
 */
export async function createProjectChannel(
    client: Client,
    guild: Guild,
    runnerCategory: RunnerCategory,
    projectPath: string,
    runner: RunnerPermissionInfo | null
): Promise<ProjectChannel | null> {
    // Build permission overwrites - deny everyone, allow owner + authorized users
    const permissionOverwrites = buildChannelPermissionOverwrites(
        runner || { ownerId: '', authorizedUsers: [] },
        guild.roles.everyone.id
    );

    // Extract folder name from path
    const folderName = projectPath.split('/').pop() || 'unknown';

    const channel = await guild.channels.create({
        name: `project-${folderName.toLowerCase()}`,
        type: ChannelType.GuildText,
        parent: runnerCategory.categoryId,
        topic: `Project: ${projectPath}`,
        permissionOverwrites: permissionOverwrites as any
    });

    return {
        channelId: channel.id,
        projectPath,
        lastSync: new Date()
    };
}

// ============================================================================
// Stats Channel Management
// ============================================================================

/**
 * Update stats channel names and create/migrate them if needed
 */
export async function updateStatsChannels(
    client: Client,
    guild: Guild,
    runnerCategory: RunnerCategory,
    activeSessions: number,
    pendingActions: number,
    memoryMb?: number
): Promise<{ sessions?: string; pending?: string; memory?: string }> {
    const updatedIds = { ...runnerCategory.statsChannelIds };

    // --- Sessions Channel ---
    if (runnerCategory.statsChannelIds.sessions) {
        let sessionsChannel = await client.channels.fetch(
            runnerCategory.statsChannelIds.sessions
        ).catch(() => null);

        // Migration: If channel is not Text (e.g. it is Voice), delete it
        if (sessionsChannel && sessionsChannel.type !== ChannelType.GuildText) {
            try {
                await sessionsChannel.delete();
                sessionsChannel = null;
                console.log('[ChannelFactory] Deleted old Voice stats channel to migrate to Text');
            } catch (e) {
                console.error('[ChannelFactory] Failed to delete old stats channel', e);
            }
        }

        const name = `📊-${activeSessions}-active`;

        if (!sessionsChannel) {
            // Create new
            sessionsChannel = await guild.channels.create({
                name,
                type: ChannelType.GuildText,
                parent: runnerCategory.categoryId,
                position: 0,
                permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages] }]
            });

            updatedIds.sessions = sessionsChannel.id;
        } else {
            // Update existing
            if (sessionsChannel.name !== name) await sessionsChannel.setName(name);
            if (sessionsChannel.position !== 0) await sessionsChannel.setPosition(0);
        }
    }

    // --- Pending Channel ---
    if (runnerCategory.statsChannelIds.pending) {
        let pendingChannel = await client.channels.fetch(
            runnerCategory.statsChannelIds.pending
        ).catch(() => null);

        // Migration
        if (pendingChannel && pendingChannel.type !== ChannelType.GuildText) {
            try {
                await pendingChannel.delete();
                pendingChannel = null;
            } catch (e) { /* ignore */ }
        }

        const name = `⚠️-${pendingActions}-pending`;

        if (!pendingChannel) {
            // Create new
            pendingChannel = await guild.channels.create({
                name,
                type: ChannelType.GuildText,
                parent: runnerCategory.categoryId,
                position: 1,
                permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages] }]
            });

            updatedIds.pending = pendingChannel.id;
        } else {
            if (pendingChannel.name !== name) await pendingChannel.setName(name);
            if (pendingChannel.position !== 1) await pendingChannel.setPosition(1);
        }
    }

    // --- Memory Channel ---
    if (memoryMb !== undefined) {
        let memoryChannel = runnerCategory.statsChannelIds.memory
            ? await client.channels.fetch(runnerCategory.statsChannelIds.memory).catch(() => null)
            : null;

        // Migration: If channel is not Text, delete it
        if (memoryChannel && memoryChannel.type !== ChannelType.GuildText) {
            try {
                await memoryChannel.delete();
                memoryChannel = null;
            } catch (e) { /* ignore */ }
        }

        // Format memory nicely
        const memoryDisplay = memoryMb >= 1024
            ? `${(memoryMb / 1024).toFixed(1)}GB`
            : `${memoryMb}MB`;
        const name = `💾-${memoryDisplay}`;

        if (!memoryChannel) {
            // Create new
            memoryChannel = await guild.channels.create({
                name,
                type: ChannelType.GuildText,
                parent: runnerCategory.categoryId,
                position: 2,
                permissionOverwrites: [{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages] }]
            });

            updatedIds.memory = memoryChannel.id;
        } else {
            if (memoryChannel.name !== name) await memoryChannel.setName(name);
            if (memoryChannel.position !== 2) await memoryChannel.setPosition(2);
        }
    }

    return updatedIds;
}

// ============================================================================
// Dashboard Posting
// ============================================================================

/**
 * Post/Update runner aggregate dashboard
 */
export async function postRunnerDashboard(
    channel: TextChannel,
    runnerCategory: RunnerCategory,
    runnerName: string,
    runnerStatus: string
): Promise<void> {
    const statusEmoji = runnerStatus === 'online' ? '🟢' : '⚫';

    // Build projects summary
    let projectsSummary = '';
    for (const [path, project] of runnerCategory.projects) {
        const folderName = path.split('/').pop() || path;
        projectsSummary += `📂 ${folderName}\n`;
    }

    if (!projectsSummary) {
        projectsSummary = '_No projects registered. Use /sync-projects to discover._';
    }

    const embed = new EmbedBuilder()
        .setTitle(`🖥️ ${runnerName}`)
        .setDescription(`${statusEmoji} **${runnerStatus.toUpperCase()}**`)
        .addFields(
            { name: 'Projects', value: projectsSummary, inline: false }
        )
        .setColor(runnerStatus === 'online' ? 0x00FF00 : 0x808080)
        .setTimestamp();

    const row = new ActionRowBuilder<ButtonBuilder>()
        .addComponents(
            new ButtonBuilder()
                .setCustomId(`runner_config:${runnerCategory.runnerId}`)
                .setLabel('⚙️ Config')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`sync_projects:${runnerCategory.runnerId}`)
                .setLabel('🔄 Sync Projects')
                .setStyle(ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`runner_stats:${runnerCategory.runnerId}`)
                .setLabel('📊 Stats')
                .setStyle(ButtonStyle.Secondary)
        );

    await channel.send({ embeds: [embed], components: [row] });
}

/**
 * Post/Update project action center dashboard
 * Unified with /dashboard command format
 */
export async function postProjectDashboard(
    channel: TextChannel,
    runnerId: string,
    projectPath: string,
    stats: ProjectStats
): Promise<string | null> {
    try {
        const folderName = projectPath.split('/').pop() || projectPath;
        const runner = storage.getRunner(runnerId);

        // Get project and runner config for settings display
        const projectConfig = projectSettingsStore.getConfig(runnerId, projectPath);
        const runnerConfig = runner?.config || {};

        const embed = new EmbedBuilder()
            .setTitle(`Project: ${folderName}`)
            .setDescription(`\`${projectPath}\``)
            .setColor(stats.activeSessions > 0 ? 0x00FF00 : 0x808080)
            .setTimestamp();

        // Session stats
        embed.addFields(
            { name: 'Active Sessions', value: String(stats.activeSessions), inline: true },
            { name: 'Total Sessions', value: String(stats.totalSessions), inline: true }
        );

        // Settings section with inheritance info
        const hasOverrides = Object.keys(projectConfig).length > 0;
        embed.addFields(
            { name: '--- Settings ---', value: hasOverrides ? '*Using project overrides*' : '*Inheriting from runner defaults*', inline: false }
        );

        // Show effective settings
        const runnerPermMode = runnerConfig.claudeDefaults?.permissionMode ||
            (runnerConfig.yoloMode ? 'yolo' : 'manual');
        const permMode = projectConfig.permissionMode || runnerPermMode;
        const thinkLevel = projectConfig.thinkingLevel || runnerConfig.thinkingLevel || 'low';
        const defaultCli = projectConfig.defaultCliType || runner?.cliTypes?.[0] || 'claude';
        const autoSpawn = projectConfig.autoSpawnEnabled !== false ? 'Enabled' : 'Disabled';

        embed.addFields(
            { name: 'Permission Mode', value: permMode, inline: true },
            { name: 'Default CLI', value: defaultCli.toUpperCase(), inline: true },
            { name: 'Thinking Level', value: thinkLevel, inline: true },
            { name: 'Auto-Spawn', value: autoSpawn, inline: true }
        );

        // Unified buttons matching /dashboard command
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

        const message = await channel.send({ embeds: [embed], components: [row1, row2] });

        return message.id;
    } catch (error) {
        console.error('[ChannelFactory] Error posting project dashboard:', error);
        return null;
    }
}
