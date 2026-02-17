/**
 * Register Handler
 *
 * Handles runner registration, heartbeat, and offline detection.
 */

import { EmbedBuilder } from 'discord.js';
import * as botState from '../../state.js';
import { storage } from '../../storage.js';
import { getConfig } from '../../config.js';
import { getCategoryManager } from '../../services/category-manager.js';
import { getSessionSyncService } from '../../services/session-sync.js';
import { createRunnerOfflineEmbed } from '../../utils/embeds.js';
import {
    OFFLINE_GRACE_MS,
    runnerOfflineTimers
} from './types.js';
import type { RunnerInfo } from '../../../../shared/types.ts';

const config = getConfig();

/**
 * Apply default configuration to runner
 */
export function applyDefaultRunnerConfig(runner: RunnerInfo): void {
    if (!runner.config) {
        runner.config = {
            threadArchiveDays: 3,
            autoSync: true,
            thinkingLevel: 'low',
            yoloMode: false,
            claudeDefaults: {},
            codexDefaults: {},
            geminiDefaults: {},
            presets: {}
        };
        return;
    }
    if (runner.config.threadArchiveDays === undefined) runner.config.threadArchiveDays = 3;
    if (runner.config.autoSync === undefined) runner.config.autoSync = true;
    if (runner.config.thinkingLevel === undefined) runner.config.thinkingLevel = 'low';
    if (runner.config.yoloMode === undefined) runner.config.yoloMode = false;
    if (runner.config.claudeDefaults === undefined) runner.config.claudeDefaults = {};
    if (runner.config.codexDefaults === undefined) runner.config.codexDefaults = {};
    if (runner.config.geminiDefaults === undefined) runner.config.geminiDefaults = {};
    if (runner.config.presets === undefined) runner.config.presets = {};
}

/**
 * Clear offline detection timer
 */
export function clearOfflineTimer(runnerId: string): void {
    const timer = runnerOfflineTimers.get(runnerId);
    if (timer) {
        clearTimeout(timer);
        runnerOfflineTimers.delete(runnerId);
    }
}

/**
 * Finalize runner offline state
 */
async function finalizeRunnerOffline(runnerId: string, closingWs: any): Promise<void> {
    runnerOfflineTimers.delete(runnerId);

    const currentWs = botState.runnerConnections.get(runnerId);
    if (currentWs && currentWs !== closingWs) {
        // Runner reconnected before grace period expired
        return;
    }

    storage.updateRunnerStatus(runnerId, 'offline');

    // Notify owner about runner going offline
    const runner = storage.getRunner(runnerId);
    if (runner) {
        await endAllRunnerSessions(runner);
        await notifyRunnerOffline(runner);
    }
}

/**
 * Schedule offline detection
 */
export function scheduleRunnerOffline(runnerId: string, closingWs: any): void {
    if (runnerOfflineTimers.has(runnerId)) return;
    const timer = setTimeout(() => {
        void finalizeRunnerOffline(runnerId, closingWs);
    }, OFFLINE_GRACE_MS);
    runnerOfflineTimers.set(runnerId, timer);
}

/**
 * End all sessions for a runner when it goes offline
 */
async function endAllRunnerSessions(runner: RunnerInfo): Promise<void> {
    const sessions = storage.getRunnerSessions(runner.runnerId);

    for (const session of sessions) {
        if (session.status === 'active') {
            // Mark session as ended
            session.status = 'ended';
            storage.updateSession(session.sessionId, session);

            // Archive the thread
            try {
                const thread = await botState.client.channels.fetch(session.threadId);
                if (thread && thread.isThread()) {
                    await thread.setArchived(true);
                }
            } catch (error) {
                console.error(`Failed to archive thread for session ${session.sessionId}:`, error);
            }
        }
    }
}

/**
 * Notify when a runner goes offline
 */
async function notifyRunnerOffline(runner: RunnerInfo): Promise<void> {
    if (!runner.ownerId) {
        console.error('Runner has no ownerId, cannot notify:', runner.runnerId);
        return;
    }

    // Only send notification if bot is ready
    if (!botState.isBotReady) {
        return;
    }

    // Try to send DM to owner (may fail if user has DMs disabled)
    try {
        const user = await botState.client.users.fetch(runner.ownerId);
        await user.send({
            embeds: [createRunnerOfflineEmbed(runner)]
        });
    } catch (error: any) {
        if (error.code === 50007) {
            console.log(`Could not send DM to user ${runner.ownerId} (DMs disabled or bot blocked)`);
        } else {
            console.error('Failed to send DM to runner owner:', error);
        }
    }

    // Send notification to the runner's private channel
    if (runner.privateChannelId) {
        try {
            const channel = await botState.client.channels.fetch(runner.privateChannelId);
            if (channel && 'send' in channel) {
                const sessions = storage.getRunnerSessions(runner.runnerId);
                const endedSessions = sessions.filter(s => s.status === 'ended');

                const embed = new EmbedBuilder()
                    .setColor(0xFF6600)
                    .setTitle('Runner Offline - Sessions Ended')
                    .setDescription(`The runner \`${runner.name}\` has gone offline.\n\n**${endedSessions.length} active session(s) automatically ended.**`)
                    .addFields(
                        { name: 'Status', value: '🔴 Offline', inline: true },
                        { name: 'Sessions Ended', value: `${endedSessions.length}`, inline: true },
                        { name: 'Action', value: 'Start a new session when the Runner Agent comes back online', inline: false }
                    )
                    .setTimestamp();

                await channel.send({ embeds: [embed] });
            }
        } catch (error) {
            console.error('Failed to send notification to runner channel:', error);
        }
    }

    // Update stats voice channel
    const categoryManager = getCategoryManager();
    if (categoryManager) {
        await categoryManager.updateRunnerStats(runner.runnerId);
    }
}

/**
 * Notify when a runner comes online
 */
export async function notifyRunnerOnline(runner: RunnerInfo, wasReclaimed: boolean = false): Promise<void> {
    if (!runner.privateChannelId) {
        return;
    }

    if (!botState.isBotReady) {
        return;
    }

    if (config.notifications.notifyRunnerOnline) {
        try {
            const channel = await botState.client.channels.fetch(runner.privateChannelId);
            if (channel && 'send' in channel) {
                const embed = new EmbedBuilder()
                    .setColor(0x00FF00)
                    .setTitle('🟢 Runner Online')
                    .setDescription(`Runner \`${runner.name}\` is now online and ready.`)
                    .addFields(
                        { name: 'Status', value: '🟢 Online', inline: true },
                        { name: 'CLI Types', value: runner.cliTypes.join(', ') || 'N/A', inline: true }
                    )
                    .setTimestamp();

                if (wasReclaimed) {
                    embed.addFields({
                        name: 'Note',
                        value: 'Runner was restarted and reclaimed from previous offline state.',
                        inline: false
                    });
                }

                await channel.send({ embeds: [embed] });
            }
        } catch (error) {
            console.error('Failed to send runner online notification:', error);
        }
    }

    // Update stats voice channel
    const categoryManager = getCategoryManager();
    if (categoryManager) {
        await categoryManager.updateRunnerStats(runner.runnerId);
    }

    // Start session sync
    const sessionSync = getSessionSyncService();
    if (sessionSync) {
        // Start syncing (idempotent)
        await sessionSync.startSyncingRunner(runner.runnerId);
    }
}

/**
 * Handle runner registration
 */
export async function handleRegister(ws: any, data: any): Promise<void> {
    const { runnerId, name, cliTypes, ownerToken, token, memoryMb } = data;

    // Support both 'ownerToken' (new) and 'token' (legacy)
    const effectiveToken = ownerToken || token;

    console.log(`[WebSocket] Registration request from ${name} (${runnerId})`);

    // Validate token
    if (effectiveToken) {
        const expectedToken = storage.getRunnerToken(runnerId);
        if (expectedToken && effectiveToken !== expectedToken) {
            console.error(`[WebSocket] Invalid token for runner ${runnerId}`);
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid token' }));
            ws.close();
            return;
        }
    }

    // Check if runner exists
    let runner = storage.getRunner(runnerId);
    let wasReclaimed = false;

    if (!runner) {
        // Create new runner
        runner = {
            runnerId,
            name,
            cliTypes: cliTypes || ['claude'],
            ownerId: '',
            status: 'online',
            lastHeartbeat: new Date().toISOString(),
            authorizedUsers: [],
            discordState: undefined,
            memoryMb
        };
        storage.createRunner(runner);
    } else {
        // Update existing runner
        wasReclaimed = runner.status === 'offline';
        storage.updateRunner(runnerId, {
            name,
            cliTypes: cliTypes || runner.cliTypes,
            status: 'online',
            lastHeartbeat: new Date().toISOString(),
            memoryMb
        });
    }

    // Apply default config
    applyDefaultRunnerConfig(runner);

    // Clear any pending offline timer
    clearOfflineTimer(runnerId);

    // Store connection
    (ws as any).runnerId = runnerId;
    botState.runnerConnections.set(runnerId, ws);
    botState.runnerMemoryUsage.set(runnerId, memoryMb);

    // Create runner category if needed
    const categoryManager = getCategoryManager();
    if (categoryManager) {
        const guildId = config.guildId;
        if (guildId) {
            try {
                await categoryManager.createRunnerCategory(runnerId, name, guildId);
            } catch (error) {
                console.error(`[WebSocket] Failed to create runner category:`, error);
            }
        }
    }

    // Send acknowledgment
    ws.send(JSON.stringify({
        type: 'register_ack',
        runnerId,
        config: runner.config
    }));

    // Notify about runner online
    await notifyRunnerOnline(storage.getRunner(runnerId)!, wasReclaimed);

    console.log(`[WebSocket] Runner ${name} registered successfully`);
}

/**
 * Handle runner heartbeat
 */
export async function handleHeartbeat(ws: any, data: any): Promise<void> {
    const { runnerId, memoryMb } = data;

    const runner = storage.getRunner(runnerId);
    if (!runner) {
        console.warn(`[WebSocket] Heartbeat from unknown runner ${runnerId}`);
        return;
    }

    // Update last heartbeat and memory
    storage.updateRunner(runnerId, {
        lastHeartbeat: new Date().toISOString(),
        memoryMb
    });

    botState.runnerMemoryUsage.set(runnerId, memoryMb);

    // Clear any pending offline timer
    clearOfflineTimer(runnerId);

    // Send acknowledgment
    ws.send(JSON.stringify({
        type: 'heartbeat_ack',
        runnerId,
        timestamp: new Date().toISOString()
    }));
}
