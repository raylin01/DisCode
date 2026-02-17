/**
 * Dashboard Button Handlers
 * 
 * Handles runner stats, project session listing, new session from dashboard,
 * and session sync buttons.
 */

import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import * as botState from '../state.js';
import { storage } from '../storage.js';
import { getCategoryManager } from '../services/category-manager.js';
import { getSessionSyncService } from '../services/session-sync.js';
import { listSessions } from '@raylin01/claude-client/sessions';
import { cliToSdkPlugin } from './button-utils.js';
import { getRunnerIdFromContext, getProjectPathFromContext, getProjectChannelIdFromContext } from './session-buttons.js';
import { safeDeferReply, safeEditReply } from './interaction-safety.js';

// ---------------------------------------------------------------------------
// Helpers (re-used from original buttons.ts)
// ---------------------------------------------------------------------------

function parseProjectDashboardContext(customId: string, prefix: string): { runnerIdHint?: string; projectPath: string } | null {
    const fullPrefix = `${prefix}:`;
    if (!customId.startsWith(fullPrefix)) return null;

    const payload = customId.slice(fullPrefix.length);
    const separator = payload.indexOf(':');

    if (separator === -1) {
        return { projectPath: decodeURIComponent(payload) };
    }

    const runnerIdHint = payload.slice(0, separator);
    const encodedProjectPath = payload.slice(separator + 1);

    return {
        runnerIdHint: runnerIdHint || undefined,
        projectPath: decodeURIComponent(encodedProjectPath)
    };
}

async function refreshProjectDashboardIfOutdated(
    interaction: any,
    projectPathHint: string,
    runnerIdHint?: string
): Promise<boolean> {
    const categoryManager = getCategoryManager();
    if (!categoryManager) return false;

    const clickedMessageId = interaction?.message?.id;
    if (!clickedMessageId) return false;

    let channel = interaction.channel;
    if (!channel || !channel.id) {
        try {
            channel = await interaction.client.channels.fetch(interaction.channelId);
        } catch (error) {
            console.error('[DashboardButtons] Failed to fetch channel:', error);
            return false;
        }
    }

    if (channel?.isThread()) {
        try {
            channel = channel.parent || (channel.parentId ? await interaction.client.channels.fetch(channel.parentId) : null);
        } catch (error) {
            console.error('[DashboardButtons] Failed to fetch parent channel:', error);
            return false;
        }
    }

    if (!channel || channel.isThread?.()) return false;

    const projectInfo = categoryManager.getProjectByChannelId(channel.id);
    const resolvedProjectPath = projectInfo?.projectPath || projectPathHint;
    let resolvedRunnerId = projectInfo?.runnerId || runnerIdHint;
    if (!resolvedRunnerId && resolvedProjectPath) {
        resolvedRunnerId = categoryManager.getRunnerByProjectPath(resolvedProjectPath);
    }

    if (!resolvedRunnerId || !resolvedProjectPath) return false;

    const latestDashboardId = projectInfo?.project.dashboardMessageId;
    if (!latestDashboardId || latestDashboardId === clickedMessageId) return false;

    const sessionSync = getSessionSyncService();
    const stats = sessionSync?.getProjectStats(resolvedRunnerId, resolvedProjectPath) || {
        totalSessions: 0,
        activeSessions: 0,
        pendingActions: 0
    };

    try {
        await categoryManager.bumpProjectDashboard(
            resolvedRunnerId,
            resolvedProjectPath,
            stats,
            channel as any
        );
        await safeEditReply(interaction, {
            content: '⚠️ That dashboard message is outdated. I posted a fresh one with active buttons.'
        });
        return true;
    } catch (error) {
        console.error('[DashboardButtons] Failed to refresh dashboard:', error);
        return false;
    }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleRunnerStats(interaction: any, userId: string, runnerId: string): Promise<void> {
    const runner = storage.getRunner(runnerId);
    if (!runner) {
        await safeEditReply(interaction, { content: '❌ Runner not found.' });
        return;
    }

    if (!storage.canUserAccessRunner(userId, runnerId)) {
        await safeEditReply(interaction, { content: '❌ Access denied.' });
        return;
    }

    const embed = new EmbedBuilder()
        .setTitle(`📊 Stats for ${runner.name}`)
        .addFields(
            { name: 'Platform', value: `${runner.platform || 'Unknown'} (${runner.arch || '?'})`, inline: true },
            { name: 'Hostname', value: runner.hostname || 'Unknown', inline: true },
            { name: 'Status', value: runner.status, inline: true },
            { name: 'Last Seen', value: runner.lastHeartbeat ? new Date(runner.lastHeartbeat).toLocaleString() : 'Never', inline: false }
        )
        .setColor(0x0099FF);

    await safeEditReply(interaction, { embeds: [embed] });
}

export async function handleListSessionsButton(interaction: any, userId: string, projectPath: string): Promise<void> {
    const acknowledged = await safeDeferReply(interaction);
    if (!acknowledged) return;

    if (await refreshProjectDashboardIfOutdated(interaction, projectPath)) return;

    try {
        const contextProjectPath = await getProjectPathFromContext(interaction);
        const resolvedProjectPath = contextProjectPath || projectPath;
        const sessions = await listSessions(resolvedProjectPath);

        if (sessions.length === 0) {
            await safeEditReply(interaction, { content: 'No sessions found for this project.' });
            return;
        }

        const embed = new EmbedBuilder()
            .setTitle(`📋 Sessions for ${resolvedProjectPath.split('/').pop()}`)
            .setDescription(
                sessions.slice(0, 10).map(s => {
                    const statusIcon = s.isSidechain ? '🔓' : '🔒';
                    const time = new Date(s.modified).toLocaleDateString();
                    return `**${s.sessionId.slice(0, 8)}** (${time})\n> ${s.firstPrompt.slice(0, 50)}...`;
                }).join('\n\n') + (sessions.length > 10 ? `\n\n_...and ${sessions.length - 10} more_` : '')
            )
            .setColor(0x0099FF);

        await safeEditReply(interaction, { embeds: [embed] });
    } catch (error) {
        console.error('[DashboardButtons] Error listing sessions:', error);
        await safeEditReply(interaction, { content: '❌ Error listing sessions.' });
    }
}

export async function handleNewSessionButton(interaction: any, userId: string, projectPath: string, runnerIdHint?: string): Promise<void> {
    let useChannelFallback = false;
    if (!interaction.deferred && !interaction.replied) {
        try {
            const acknowledged = await safeDeferReply(interaction);
            if (!acknowledged) useChannelFallback = true;
        } catch (error) {
            console.warn('[DashboardButtons] Failed to defer, falling back to channel message:', error);
            useChannelFallback = true;
        }
    }

    if (!useChannelFallback && await refreshProjectDashboardIfOutdated(interaction, projectPath, runnerIdHint)) return;

    const categoryManager = getCategoryManager();
    const contextRunnerId = await getRunnerIdFromContext(interaction);
    const contextProjectPath = await getProjectPathFromContext(interaction);
    const resolvedProjectPath = contextProjectPath || projectPath;

    if (contextRunnerId && runnerIdHint && contextRunnerId !== runnerIdHint) {
        console.warn(`[DashboardButtons] Runner hint (${runnerIdHint}) differs from channel runner (${contextRunnerId}); using channel runner.`);
    }

    let runnerId = contextRunnerId || runnerIdHint;
    if (!runnerId) {
        runnerId = categoryManager?.getRunnerByProjectPath(resolvedProjectPath);
    }
    if (!runnerId) {
        const runners = Object.values(storage.data.runners);
        const match = runners.find(r => r.discordState?.projects?.[resolvedProjectPath]);
        if (match) runnerId = match.runnerId;
    }

    if (!runnerId) {
        console.error(`[DashboardButtons] Could not identify runner. contextRunnerId=${contextRunnerId}, runnerIdHint=${runnerIdHint}, resolvedProjectPath=${resolvedProjectPath}`);
        const payload = { content: '❌ Could not identify runner. Try running this from the Project Channel.' };
        if (useChannelFallback) {
            if (interaction.channel?.isTextBased()) await interaction.channel.send(payload);
            return;
        }
        await safeEditReply(interaction, payload);
        return;
    }

    const runner = storage.getRunner(runnerId);
    if (!runner) {
        const payload = { content: '❌ Runner not found.' };
        if (useChannelFallback) {
            if (interaction.channel?.isTextBased()) await interaction.channel.send(payload);
            return;
        }
        await safeEditReply(interaction, payload);
        return;
    }

    // Initialize session creation state with pre-filled values
    const projectChannelId = await getProjectChannelIdFromContext(interaction);
    botState.sessionCreationState.set(userId, {
        step: 'select_cli',
        runnerId: runnerId,
        folderPath: resolvedProjectPath,
        projectChannelId
    });

    // SDK-ONLY: If single CLI type, auto-map to SDK plugin and go to review
    if (runner.cliTypes.length === 1) {
        const cliType = runner.cliTypes[0];
        const plugin = cliToSdkPlugin(cliType);

        botState.sessionCreationState.set(userId, {
            step: 'complete',
            runnerId: runnerId,
            cliType: cliType as 'claude' | 'gemini' | 'codex' | 'terminal',
            plugin,
            folderPath: resolvedProjectPath,
            projectChannelId
        });

        // Go directly to review since we have CLI, plugin, and folder
        const payload = {
            content: `**New Session for ${resolvedProjectPath}**\n\nCLI: **${cliType.toUpperCase()}** (SDK)\nReady to start!`,
            components: [
                new ActionRowBuilder<ButtonBuilder>().addComponents(
                    new ButtonBuilder().setCustomId('session_start').setLabel('Start Session').setStyle(ButtonStyle.Success).setEmoji('🚀'),
                    new ButtonBuilder().setCustomId('session_customize').setLabel('Customize').setStyle(ButtonStyle.Secondary).setEmoji('⚙️'),
                    new ButtonBuilder().setCustomId('session_cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger).setEmoji('❌')
                )
            ]
        };
        if (useChannelFallback) {
            if (interaction.channel?.isTextBased()) await interaction.channel.send(payload);
            return;
        }
        await safeEditReply(interaction, payload);
        return;
    }

    // Multiple CLI types — show CLI selection
    const cliButtons = runner.cliTypes.map(cliType =>
        new ButtonBuilder()
            .setCustomId(`session_cli_${cliType}`)
            .setLabel(cliType.toUpperCase())
            .setStyle(ButtonStyle.Primary)
    );

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(...cliButtons);

    const payload = {
        content: `**New Session for ${resolvedProjectPath}**\n\nSelect CLI tool:`,
        components: [row]
    };
    if (useChannelFallback) {
        if (interaction.channel?.isTextBased()) await interaction.channel.send(payload);
        return;
    }
    await safeEditReply(interaction, payload);
}

export async function handleSyncSessionsButton(interaction: any, userId: string, projectPath: string, runnerIdHint?: string): Promise<void> {
    const acknowledged = await safeDeferReply(
        interaction,
        'Buttons expired. Please use the latest project dashboard to sync sessions.'
    );
    if (!acknowledged) return;

    if (await refreshProjectDashboardIfOutdated(interaction, projectPath, runnerIdHint)) return;

    const contextRunnerId = await getRunnerIdFromContext(interaction);
    const contextProjectPath = await getProjectPathFromContext(interaction);
    const resolvedProjectPath = contextProjectPath || projectPath;
    if (contextRunnerId && runnerIdHint && contextRunnerId !== runnerIdHint) {
        console.warn(`[DashboardButtons] Sync runner hint differs; using channel runner.`);
    }

    let syncRid = contextRunnerId || runnerIdHint;
    if (!syncRid) {
        const categoryManager = getCategoryManager();
        syncRid = categoryManager?.getRunnerByProjectPath(resolvedProjectPath);
    }
    if (!syncRid) {
        const runners = Object.values(storage.data.runners);
        const match = runners.find(r => r.discordState?.projects?.[resolvedProjectPath]);
        if (match) syncRid = match.runnerId;
    }

    if (!syncRid) {
        console.error(`[DashboardButtons] Sync could not identify runner. contextRunnerId=${contextRunnerId}, runnerIdHint=${runnerIdHint}, resolvedProjectPath=${resolvedProjectPath}`);
        await safeEditReply(interaction, { content: '❌ Could not identify runner. Try running this from the Project Channel.' });
        return;
    }

    const sessionSync = getSessionSyncService();
    if (!sessionSync) {
        await safeEditReply(interaction, { content: '❌ Session sync service not available.' });
        return;
    }

    try {
        await sessionSync.syncProjectSessions(syncRid, resolvedProjectPath);
        await safeEditReply(interaction, { content: '✅ Sync complete!' });
    } catch (error) {
        console.error('[DashboardButtons] Sync failed:', error);
        try {
            await safeEditReply(interaction, { content: '❌ Sync failed.' });
        } catch (e) {
            console.error('[DashboardButtons] Failed to send failure message:', e);
        }
    }
}

// Re-export helpers for the dispatcher
export { parseProjectDashboardContext, refreshProjectDashboardIfOutdated };
