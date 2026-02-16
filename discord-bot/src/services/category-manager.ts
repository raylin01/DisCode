/**
 * Category Manager
 * 
 * Manages Discord categories and channels for runners and projects.
 * Each runner gets a category with:
 * - Stats voice channels (locked)
 * - Runner control channel (aggregate dashboard)
 * - Project channels (one per project folder)
 */

import {
    Client,
    Guild,
    CategoryChannel,
    TextChannel,
    VoiceChannel,
    ChannelType,
    PermissionFlagsBits,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder
} from 'discord.js';
import { storage } from '../storage.js';
import * as botState from '../state.js';
import { permissionStateStore } from '../permissions/state-store.js';

// ============================================================================
// Types
// ============================================================================

export interface RunnerCategory {
    runnerId: string;
    guildId: string;
    categoryId: string;
    controlChannelId: string;
    statsChannelIds: {
        sessions?: string;  // "📊 3 active"
        pending?: string;   // "⚠️ 5 pending"
        memory?: string;    // "💾 128MB"
    };
    projects: Map<string, ProjectChannel>;  // projectPath -> channel info
}

export interface ProjectChannel {
    channelId: string;
    projectPath: string;
    dashboardMessageId?: string;  // Latest dashboard message
    lastSync?: Date;
}

export interface ProjectStats {
    totalSessions: number;
    activeSessions: number;
    pendingActions: number;
    lastActivity?: Date;
}

// ============================================================================
// Category Manager
// ============================================================================

export class CategoryManager {
    private client: Client;
    private categories = new Map<string, RunnerCategory>();  // runnerId -> category
    private lastPublishedRunnerStats = new Map<string, { activeSessions: number; pendingActions: number; memoryMb?: number }>();
    
    constructor(client: Client) {
        this.client = client;
    }

    /**
     * Initialize categories from storage
     */
    async initialize(): Promise<void> {
        console.log('[CategoryManager] Initializing from storage...');
        const runners = storage.data.runners;
        
        for (const runnerId in runners) {
            const runner = runners[runnerId];
            if (runner.discordState && runner.discordState.categoryId) {
                try {
                    // Verify category still exists
                    const category = await this.client.channels.fetch(runner.discordState.categoryId).catch(() => null);
                    if (category && category.type === ChannelType.GuildCategory) {
                        // Reconstruct in-memory state
                        const projectsMap = new Map<string, ProjectChannel>();
                        if (runner.discordState.projects) {
                            Object.entries(runner.discordState.projects).forEach(([path, data]) => {
                                projectsMap.set(path, {
                                    channelId: data.channelId,
                                    projectPath: path,
                                    dashboardMessageId: data.dashboardMessageId,
                                    lastSync: data.lastSync ? new Date(data.lastSync) : undefined
                                });
                            });
                        }

                        const runnerCategory: RunnerCategory = {
                            runnerId,
                            guildId: category.guild.id,
                            categoryId: category.id,
                            controlChannelId: runner.discordState.controlChannelId || '',
                            statsChannelIds: runner.discordState.statsChannelIds || {},
                            projects: projectsMap
                        };
                        this.categories.set(runnerId, runnerCategory);
                        await this.ensureControlChannelLocked(runnerCategory);
                        console.log(`[CategoryManager] Restored category for runner ${runner.name} with ${projectsMap.size} projects`);
                    }
                } catch (error) {
                    console.error(`[CategoryManager] Failed to restore category for ${runner.name}:`, error);
                }
            }
        }
        console.log(`[CategoryManager] Initialization complete. Loaded ${this.categories.size} categories.`);
    }

    /**
     * List all project channels across runners
     */
    listProjects(): Array<{ runnerId: string; projectPath: string; channelId: string }> {
        const projects: Array<{ runnerId: string; projectPath: string; channelId: string }> = [];
        for (const [runnerId, category] of this.categories.entries()) {
            for (const [projectPath, project] of category.projects.entries()) {
                projects.push({ runnerId, projectPath, channelId: project.channelId });
            }
        }
        return projects;
    }

    /**
     * Create category structure for a new runner
     */
    async createRunnerCategory(
        runnerId: string,
        runnerName: string,
        guildId: string
    ): Promise<RunnerCategory> {
        // Check if we already have it in storage but not in memory
        const runner = storage.getRunner(runnerId);
        if (runner?.discordState?.categoryId) {
             const existingCategory = await this.client.channels.fetch(runner.discordState.categoryId).catch(() => null);
             if (existingCategory) {
                 // It exists, so we should have loaded it on init.
             // If not, load it now.
             
             // Restore projects from storage
             const projectsMap = new Map<string, ProjectChannel>();
             if (runner.discordState.projects) {
                 Object.entries(runner.discordState.projects).forEach(([path, data]) => {
                     projectsMap.set(path, {
                         channelId: data.channelId,
                         projectPath: path,
                         dashboardMessageId: data.dashboardMessageId,
                         lastSync: data.lastSync ? new Date(data.lastSync) : undefined
                     });
                 });
             }

             const restoredCategory: RunnerCategory = {
                runnerId,
                guildId,
                categoryId: runner.discordState.categoryId,
                controlChannelId: runner.discordState.controlChannelId || '',
                statsChannelIds: runner.discordState.statsChannelIds || {},
                projects: projectsMap
             };
             this.categories.set(runnerId, restoredCategory);
             await this.ensureControlChannelLocked(restoredCategory);
             return restoredCategory;
             }
        }

        const guild = await this.client.guilds.fetch(guildId);
        
        // Create the main category
        const category = await guild.channels.create({
            name: `🖥️ ${runnerName}`,
            type: ChannelType.GuildCategory
        });

        // Create stats voice channels (locked - no one can join)
        const sessionsChannel = await guild.channels.create({
            name: '📊-0-active',
            type: ChannelType.GuildText,
            parent: category.id,
            position: 0,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone.id,
                    deny: [PermissionFlagsBits.SendMessages]  // Read-only
                }
            ]
        });

        const pendingChannel = await guild.channels.create({
            name: '⚠️-0-pending',
            type: ChannelType.GuildText,
            parent: category.id,
            position: 1,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone.id,
                    deny: [PermissionFlagsBits.SendMessages]
                }
            ]
        });

        // Create runner control channel
        const controlChannel = await guild.channels.create({
            name: 'runner-control',
            type: ChannelType.GuildText,
            parent: category.id,
            topic: `Control channel for ${runnerName}. Use /sync-projects to discover projects.`,
            permissionOverwrites: [
                {
                    id: guild.roles.everyone.id,
                    deny: [PermissionFlagsBits.SendMessages]
                }
            ]
        });

        const runnerCategory: RunnerCategory = {
            runnerId,
            guildId,
            categoryId: category.id,
            controlChannelId: controlChannel.id,
            statsChannelIds: {
                sessions: sessionsChannel.id,
                pending: pendingChannel.id
            },
            projects: new Map()
        };

        this.categories.set(runnerId, runnerCategory);
        
        // Persist to storage
        // Persist to storage - safe merge
        const runnerInfo = storage.getRunner(runnerId);
        const existingState = runnerInfo?.discordState || {};

        storage.updateRunner(runnerId, {
            discordState: {
                ...existingState,
                categoryId: category.id,
                controlChannelId: controlChannel.id,
                statsChannelIds: {
                    sessions: sessionsChannel.id,
                    pending: pendingChannel.id
                }
            },
            privateChannelId: controlChannel.id // Backward compatibility
        });
        
        // Post initial dashboard in control channel
        await this.postRunnerDashboard(runnerCategory);
        
        return runnerCategory;
    }

    /**
     * Create a project channel within a runner's category
     */
    async createProjectChannel(
        runnerId: string,
        projectPath: string
    ): Promise<ProjectChannel | null> {
        const runnerCategory = this.categories.get(runnerId);
        if (!runnerCategory) {
            console.error(`[CategoryManager] Runner category not found: ${runnerId}`);
            return null;
        }

        // Check if already exists
        if (runnerCategory.projects.has(projectPath)) {
            return runnerCategory.projects.get(projectPath)!;
        }

        const guild = await this.client.guilds.fetch(runnerCategory.guildId);
        
        // Extract folder name from path
        const folderName = projectPath.split('/').pop() || 'unknown';
        
        const channel = await guild.channels.create({
            name: `project-${folderName.toLowerCase()}`,
            type: ChannelType.GuildText,
            parent: runnerCategory.categoryId,
            topic: `Project: ${projectPath}`
        });

        const projectChannel: ProjectChannel = {
            channelId: channel.id,
            projectPath,
            lastSync: new Date()
        };

        runnerCategory.projects.set(projectPath, projectChannel);
        
        // Persist to storage
        // Convert Map to Record for storage
        const projectsRecord: Record<string, { channelId: string; lastSync?: string; dashboardMessageId?: string }> = {};
        runnerCategory.projects.forEach((val, key) => {
            projectsRecord[key] = {
                channelId: val.channelId,
                lastSync: val.lastSync?.toISOString(),
                dashboardMessageId: val.dashboardMessageId
            };
        });
        
        const runnerInfo = storage.getRunner(runnerId);
        const existingState = runnerInfo?.discordState || {};

        storage.updateRunner(runnerId, {
            discordState: {
                ...existingState,
                categoryId: runnerCategory.categoryId,
                controlChannelId: runnerCategory.controlChannelId,
                statsChannelIds: runnerCategory.statsChannelIds,
                projects: projectsRecord
            }
        });

        // Post project dashboard
        const dashboardMessageId = await this.postProjectDashboard(channel, runnerId, projectPath, {
            totalSessions: 0,
            activeSessions: 0,
            pendingActions: 0
        });
        if (dashboardMessageId) {
            projectChannel.dashboardMessageId = dashboardMessageId;
            runnerCategory.projects.set(projectPath, projectChannel);
            this.persistProjects(runnerCategory);
        }
        
        return projectChannel;
    }

    /**
     * Get or create project channel
     */
    async getOrCreateProjectChannel(
        runnerId: string,
        projectPath: string
    ): Promise<ProjectChannel | null> {
        const runnerCategory = this.categories.get(runnerId);
        if (!runnerCategory) {
            return null;
        }

        const existing = runnerCategory.projects.get(projectPath);
        if (existing) {
            return existing;
        }

        return this.createProjectChannel(runnerId, projectPath);
    }

    /**
     * Get project by Discord channel ID
     */
    getProjectByChannelId(channelId: string): { runnerId: string; projectPath: string; project: ProjectChannel } | null {
        for (const [runnerId, category] of this.categories.entries()) {
            for (const [projectPath, project] of category.projects.entries()) {
                if (project.channelId === channelId) {
                    return { runnerId, projectPath, project };
                }
            }
        }

        // Storage fallback in case in-memory category cache is stale.
        for (const [runnerId, runner] of Object.entries(storage.data.runners)) {
            const projects = runner.discordState?.projects;
            if (!projects) continue;
            for (const [projectPath, data] of Object.entries(projects)) {
                if (data.channelId === channelId) {
                    return {
                        runnerId,
                        projectPath,
                        project: {
                            channelId: data.channelId,
                            projectPath,
                            dashboardMessageId: data.dashboardMessageId,
                            lastSync: data.lastSync ? new Date(data.lastSync) : undefined
                        }
                    };
                }
            }
        }
        return null;
    }

    /**
     * Ensure project channel exists on Discord (self-healing)
     */
    async ensureProjectChannel(
        runnerId: string,
        projectPath: string
    ): Promise<string | null> {
        const project = await this.getOrCreateProjectChannel(runnerId, projectPath);
        if (!project) return null;

        try {
            await this.client.channels.fetch(project.channelId);
            return project.channelId;
        } catch (error: any) {
            if (error.code === 10003 || error.status === 404) {
                console.log(`[CategoryManager] Channel ${project.channelId} for ${projectPath} is missing. Creating new...`);
                // Remove from memory
                const cat = this.categories.get(runnerId);
                if (cat) {
                    cat.projects.delete(projectPath);
                }
                // Create new
                const newProject = await this.createProjectChannel(runnerId, projectPath);
                return newProject ? newProject.channelId : null;
            }
            return null;
        }
    }

    /**
     * Get runner ID from category ID
     */
    getRunnerByCategoryId(categoryId: string): string | undefined {
        console.log(`[DEBUG] getRunnerByCategoryId: Looking for ${categoryId}`);
        for (const [runnerId, category] of this.categories) {
            if (category.categoryId === categoryId) {
                console.log(`[DEBUG] Found runner ${runnerId} for category ${categoryId}`);
                return runnerId;
            }
        }
        const fallbackRunner = Object.values(storage.data.runners).find(r => r.discordState?.categoryId === categoryId);
        if (fallbackRunner) {
            console.log(`[DEBUG] Found runner ${fallbackRunner.runnerId} for category ${categoryId} via storage fallback`);
            return fallbackRunner.runnerId;
        }
        console.log(`[DEBUG] No runner found for category ${categoryId}. Available: ${Array.from(this.categories.values()).map(c => `${c.runnerId}:${c.categoryId}`)}`);
        return undefined;
    }

    /**
     * Get runner category
     */
    getRunnerCategory(runnerId: string): RunnerCategory | undefined {
        return this.categories.get(runnerId);
    }

    /**
     * Get runner ID by project path
     */
    getRunnerByProjectPath(projectPath: string): string | undefined {
        console.log(`[DEBUG] getRunnerByProjectPath: Looking for ${projectPath}`);
        const matches = new Set<string>();

        for (const [runnerId, category] of this.categories) {
            if (category.projects.has(projectPath)) {
                matches.add(runnerId);
            }
        }

        // Include persisted state as fallback.
        for (const [runnerId, runner] of Object.entries(storage.data.runners)) {
            if (runner.discordState?.projects?.[projectPath]) {
                matches.add(runnerId);
            }
        }

        if (matches.size === 1) {
            const [runnerId] = Array.from(matches);
            console.log(`[DEBUG] Found runner ${runnerId} for project ${projectPath}`);
            return runnerId;
        }

        if (matches.size > 1) {
            console.warn(`[DEBUG] Ambiguous runner for project ${projectPath}: ${Array.from(matches).join(', ')}`);
            return undefined;
        }

        console.log(`[DEBUG] No runner found for project ${projectPath}`);
        this.categories.forEach((cat, rid) => {
            console.log(`[DEBUG] Runner ${rid} projects: ${Array.from(cat.projects.keys()).join(', ')}`);
        });
        return undefined;
    }

    /**
     * Get runner ID by channel ID (for any channel in the runner's category)
     */
    getRunnerByChannelId(channelId: string): string | undefined {
        for (const [runnerId, category] of this.categories) {
            // Check if it's the control channel
            if (category.controlChannelId === channelId) {
                return runnerId;
            }

            // Check if it's a project channel
            for (const project of category.projects.values()) {
                if (project.channelId === channelId) {
                    return runnerId;
                }
            }
        }

        // Storage fallback in case category cache is stale.
        for (const [runnerId, runner] of Object.entries(storage.data.runners)) {
            const state = runner.discordState;
            if (!state) continue;
            if (state.controlChannelId === channelId) return runnerId;
            const projects = state.projects || {};
            if (Object.values(projects).some(project => project.channelId === channelId)) {
                return runnerId;
            }
        }
        return undefined;
    }

    /**
     * Post/Update runner aggregate dashboard
     */
    async postRunnerDashboard(
        runnerCategory: RunnerCategory,
        runnerInfo?: { status: string; cliVersion?: string }
    ): Promise<void> {
        try {
            const channel = await this.client.channels.fetch(runnerCategory.controlChannelId) as TextChannel;
            if (!channel) return;

            const runner = storage.getRunner(runnerCategory.runnerId);
            const status = runnerInfo?.status || runner?.status || 'offline';
            const statusEmoji = status === 'online' ? '🟢' : '⚫';

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
                .setTitle(`🖥️ ${runner?.name || 'Runner'}`)
                .setDescription(`${statusEmoji} **${status.toUpperCase()}**`)
                .addFields(
                    { name: 'Projects', value: projectsSummary, inline: false }
                )
                .setColor(status === 'online' ? 0x00FF00 : 0x808080)
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
        } catch (error) {
            console.error('[CategoryManager] Error posting runner dashboard:', error);
        }
    }

    /**
     * Post/Update project action center dashboard
     */
    async postProjectDashboard(
        channel: TextChannel,
        runnerId: string,
        projectPath: string,
        stats: ProjectStats
    ): Promise<string | null> {
        try {
            const folderName = projectPath.split('/').pop() || projectPath;
            
            // Status indicators
            let statusLine = '';
            if (stats.pendingActions > 0) {
                statusLine += `🟠 ${stats.pendingActions} pending │ `;
            }
            if (stats.activeSessions > 0) {
                statusLine += `🟢 ${stats.activeSessions} running`;
            } else {
                statusLine += '⚫ Idle';
            }

            const embed = new EmbedBuilder()
                .setTitle(`📂 ${folderName}`)
                .setDescription(`\`${projectPath}\`\n${statusLine}`)
                .setColor(stats.pendingActions > 0 ? 0xFFA500 : (stats.activeSessions > 0 ? 0x00FF00 : 0x808080))
                .setTimestamp();

            // Add action required section if any
            if (stats.pendingActions > 0) {
                embed.addFields({
                    name: '⚠️ ACTION REQUIRED',
                    value: '_Sessions needing input will appear here_',
                    inline: false
                });
            }

            // Add recent sessions section
            embed.addFields({
                name: '📋 Recent Sessions',
                value: '_No sessions yet_',
                inline: false
            });

            const row = new ActionRowBuilder<ButtonBuilder>()
                .addComponents(
                    new ButtonBuilder()
                        .setCustomId(`list_sessions:${runnerId}:${encodeURIComponent(projectPath)}`)
                        .setLabel('📋 All Sessions')
                        .setStyle(ButtonStyle.Secondary),
                    new ButtonBuilder()
                        .setCustomId(`new_session:${runnerId}:${encodeURIComponent(projectPath)}`)
                        .setLabel('➕ New Session')
                        .setStyle(ButtonStyle.Success),
                    new ButtonBuilder()
                        .setCustomId(`sync_sessions:${runnerId}:${encodeURIComponent(projectPath)}`)
                        .setLabel('🔄 Sync')
                        .setStyle(ButtonStyle.Secondary)
                );

            const message = await channel.send({ embeds: [embed], components: [row] });

            return message.id;
        } catch (error) {
            console.error('[CategoryManager] Error posting project dashboard:', error);
            return null;
        }
    }

    /**
     * Bump project dashboard to bottom and update stored message id
     */
    async bumpProjectDashboard(
        runnerId: string,
        projectPath: string,
        stats: ProjectStats,
        channel?: TextChannel
    ): Promise<string | null> {
        const runnerCategory = this.categories.get(runnerId);
        if (!runnerCategory) return null;

        const project = runnerCategory.projects.get(projectPath);
        if (!project) return null;

        let targetChannel = channel;
        if (!targetChannel) {
            const fetched = await this.client.channels.fetch(project.channelId).catch(() => null);
            if (fetched && fetched.isTextBased() && !fetched.isThread()) {
                targetChannel = fetched as TextChannel;
            }
        }
        if (!targetChannel) return null;

        // Post new dashboard
        const newMessageId = await this.postProjectDashboard(targetChannel, runnerId, projectPath, stats);
        if (!newMessageId) return null;

        // Delete previous dashboard (if any)
        if (project.dashboardMessageId && project.dashboardMessageId !== newMessageId) {
            try {
                const previous = await targetChannel.messages.fetch(project.dashboardMessageId).catch(() => null);
                if (previous) await previous.delete().catch(() => {});
            } catch (e) {
                // ignore
            }
        }

        project.dashboardMessageId = newMessageId;
        runnerCategory.projects.set(projectPath, project);
        this.persistProjects(runnerCategory);
        return newMessageId;
    }

    /**
     * Update stats voice channel names
     */
    async updateStatsChannels(
        runnerId: string,
        activeSessions: number,
        pendingActions: number,
        memoryMb?: number
    ): Promise<void> {
        const runnerCategory = this.categories.get(runnerId);
        if (!runnerCategory) return;

        try {
            const guild = await this.client.guilds.fetch(runnerCategory.guildId);

            // --- Sessions Channel ---
            if (runnerCategory.statsChannelIds.sessions) {
                let sessionsChannel = await this.client.channels.fetch(
                    runnerCategory.statsChannelIds.sessions
                ).catch(() => null);

                // Migration: If channel is not Text (e.g. it is Voice), delete it
                if (sessionsChannel && sessionsChannel.type !== ChannelType.GuildText) {
                    try {
                        await sessionsChannel.delete();
                        sessionsChannel = null;
                        console.log('[CategoryManager] Deleted old Voice stats channel to migrate to Text');
                    } catch (e) {
                         console.error('[CategoryManager] Failed to delete old stats channel', e);
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

                    // Update ID
                    runnerCategory.statsChannelIds.sessions = sessionsChannel.id;
                    this.persistStatsChannelIds(runnerId, runnerCategory.statsChannelIds);
                } else {
                    // Update existing
                    if (sessionsChannel.name !== name) await sessionsChannel.setName(name);
                    if (sessionsChannel.position !== 0) await sessionsChannel.setPosition(0);
                }
            }

            // --- Pending Channel ---
            if (runnerCategory.statsChannelIds.pending) {
                let pendingChannel = await this.client.channels.fetch(
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

                    // Update ID
                    runnerCategory.statsChannelIds.pending = pendingChannel.id;
                    this.persistStatsChannelIds(runnerId, runnerCategory.statsChannelIds);
                } else {
                     if (pendingChannel.name !== name) await pendingChannel.setName(name);
                     if (pendingChannel.position !== 1) await pendingChannel.setPosition(1);
                }
            }

            // --- Memory Channel ---
            if (memoryMb !== undefined) {
                let memoryChannel = runnerCategory.statsChannelIds.memory
                    ? await this.client.channels.fetch(runnerCategory.statsChannelIds.memory).catch(() => null)
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

                    // Update ID
                    runnerCategory.statsChannelIds.memory = memoryChannel.id;
                    this.persistStatsChannelIds(runnerId, runnerCategory.statsChannelIds);
                } else {
                    if (memoryChannel.name !== name) await memoryChannel.setName(name);
                    if (memoryChannel.position !== 2) await memoryChannel.setPosition(2);
                }
            }
        } catch (error) {
            console.error('[CategoryManager] Error updating stats channels:', error);
        }
    }

    private persistStatsChannelIds(runnerId: string, statsChannelIds: { sessions?: string; pending?: string; memory?: string }) {
        const runner = storage.getRunner(runnerId);
        if (runner) {
             storage.updateRunner(runnerId, {
                discordState: {
                    ...(runner.discordState || {}),
                    statsChannelIds
                }
            });
        }
    }

    private persistProjects(runnerCategory: RunnerCategory): void {
        const projectsRecord: Record<string, { channelId: string; lastSync?: string; dashboardMessageId?: string }> = {};
        runnerCategory.projects.forEach((val, key) => {
            projectsRecord[key] = {
                channelId: val.channelId,
                lastSync: val.lastSync?.toISOString(),
                dashboardMessageId: val.dashboardMessageId
            };
        });

        const runnerInfo = storage.getRunner(runnerCategory.runnerId);
        const existingState = runnerInfo?.discordState || {};
        storage.updateRunner(runnerCategory.runnerId, {
            discordState: {
                ...existingState,
                projects: projectsRecord
            }
        });
    }

    private async ensureControlChannelLocked(runnerCategory: RunnerCategory): Promise<void> {
        try {
            const channel = await this.client.channels.fetch(runnerCategory.controlChannelId).catch(() => null);
            if (!channel || !('permissionOverwrites' in channel)) return;

            const guild = await this.client.guilds.fetch(runnerCategory.guildId).catch(() => null);
            if (!guild) return;

            await channel.permissionOverwrites.edit(guild.roles.everyone.id, {
                SendMessages: false
            }).catch(() => {});
        } catch (error) {
            console.error('[CategoryManager] Failed to lock runner control channel:', error);
        }
    }

    /**
     * Calculate and update all stats for a runner
     */
    async updateRunnerStats(runnerId: string): Promise<void> {
        try {
            const runner = storage.getRunner(runnerId);
            if (!runner) return;

            const sessions = storage.getRunnerSessions(runnerId);
            const activeSessions = sessions.filter(s => s.status === 'active').length;
            const pendingActions = permissionStateStore.getByRunnerId(runnerId).length;

            // Get memory from botState (updated via heartbeat)
            const memoryMb = botState.runnerMemoryUsage.get(runnerId);

            const previous = this.lastPublishedRunnerStats.get(runnerId);
            if (
                previous &&
                previous.activeSessions === activeSessions &&
                previous.pendingActions === pendingActions &&
                previous.memoryMb === memoryMb
            ) {
                return;
            }

            await this.updateStatsChannels(runnerId, activeSessions, pendingActions, memoryMb);
            this.lastPublishedRunnerStats.set(runnerId, { activeSessions, pendingActions, memoryMb });
        } catch (error) {
            console.error('[CategoryManager] Error updating runner stats:', error);
        }
    }

    /**
     * Delete runner category and all channels
     */
    async deleteRunnerCategory(runnerId: string): Promise<boolean> {
        const runnerCategory = this.categories.get(runnerId);
        if (!runnerCategory) return false;

        try {
            const guild = await this.client.guilds.fetch(runnerCategory.guildId);
            
            // Delete all project channels
            for (const [_, project] of runnerCategory.projects) {
                const channel = await this.client.channels.fetch(project.channelId).catch(() => null);
                if (channel) await channel.delete().catch(() => {});
            }

            // Delete control channel
            const controlChannel = await this.client.channels.fetch(runnerCategory.controlChannelId).catch(() => null);
            if (controlChannel) await controlChannel.delete().catch(() => {});

            // Delete stats channels
            for (const channelId of Object.values(runnerCategory.statsChannelIds)) {
                if (channelId) {
                    const channel = await this.client.channels.fetch(channelId).catch(() => null);
                    if (channel) await channel.delete().catch(() => {});
                }
            }

            // Delete the category itself
            const category = await this.client.channels.fetch(runnerCategory.categoryId).catch(() => null);
            if (category) await category.delete().catch(() => {});

            this.categories.delete(runnerId);
            this.lastPublishedRunnerStats.delete(runnerId);
            
            // Clear from storage
            storage.updateRunner(runnerId, {
                discordState: undefined
            });

            return true;
        } catch (error) {
            console.error('[CategoryManager] Error deleting runner category:', error);
            return false;
        }
    }
}

// Singleton export
let categoryManagerInstance: CategoryManager | null = null;

export function initCategoryManager(client: Client): CategoryManager {
    categoryManagerInstance = new CategoryManager(client);
    return categoryManagerInstance;
}

export function getCategoryManager(): CategoryManager | null {
    return categoryManagerInstance;
}
