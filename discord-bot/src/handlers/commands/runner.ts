/**
 * Runner Command Handlers
 * 
 * Handlers for runner-related commands.
 */

import { EmbedBuilder } from 'discord.js';
import * as botState from '../../state.js';
import { storage } from '../../storage.js';
import { createInfoEmbed, createErrorEmbed } from '../../utils/embeds.js';
import { getSessionSyncService } from '../../services/session-sync.js';
import { updateRunnerChannelPermissions } from '../../utils/channels.js';

/**
 * Handle /list-runners command
 */
export async function handleListRunners(interaction: any, userId: string): Promise<void> {
    const runners = storage.getUserRunners(userId);

    if (runners.length === 0) {
        await interaction.reply({
            embeds: [createInfoEmbed('No Runners', "You don't have any runners yet. Connect a Runner Agent to get started.\n\n1. Run `/generate-token`\n2. Copy the token\n3. Start your Runner Agent with the token\n4. Run `/list-runners` again")],
            flags: 64
        });
        return;
    }

    const fields = runners.map(r => ({
        name: `${r.status === 'online' ? '🟢' : '🔴'} ${r.name}`,
        value: `ID: \`${r.runnerId}\`\nCLI: ${r.cliTypes.map(t => t.toUpperCase()).join(', ')}\nStatus: ${r.status}`,
        inline: true
    }));

    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('Your Runners')
        .addFields(...fields)
        .setTimestamp();

    await interaction.reply({
        embeds: [embed],
        flags: 64
    });
}

/**
 * Handle /my-access command
 */
export async function handleMyAccess(interaction: any, userId: string): Promise<void> {
    const allRunners = Object.values(storage.data.runners);
    const accessibleRunners = allRunners.filter(r =>
        storage.canUserAccessRunner(userId, r.runnerId)
    );

    if (accessibleRunners.length === 0) {
        await interaction.reply({
            embeds: [createInfoEmbed('No Access', "You don't have access to any runners.\n\nConnect your own runner with `/generate-token` or ask someone to share their runner with you.")],
            flags: 64
        });
        return;
    }

    const owned = accessibleRunners.filter(r => r.ownerId === userId);
    const shared = accessibleRunners.filter(r => r.ownerId !== userId);

    const fields: { name: string; value: string; inline: boolean }[] = [];

    if (owned.length > 0) {
        fields.push({
            name: 'Your Runners',
            value: owned.map(r => `• ${r.name} (${r.status === 'online' ? '🟢' : '🔴'} ${r.status})`).join('\n') || 'None',
            inline: false
        });
    }

    if (shared.length > 0) {
        fields.push({
            name: 'Shared with You',
            value: shared.map(r => `• ${r.name} (${r.status === 'online' ? '🟢' : '🔴'} ${r.status})`).join('\n') || 'None',
            inline: false
        });
    }

    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle('Your Runner Access')
        .addFields(...fields)
        .setTimestamp();

    await interaction.reply({
        embeds: [embed],
        flags: 64
    });
}

/**
 * Handle /list-access command
 */
export async function handleListAccess(interaction: any, userId: string): Promise<void> {
    const runnerId = interaction.options.getString('runner');

    if (!runnerId) {
        const runners = storage.getUserRunners(userId);

        if (runners.length === 0) {
            await interaction.reply({
                embeds: [createErrorEmbed('No runners found', "You don't have any runners yet.")],
                flags: 64
            });
            return;
        }

        const fields = runners.map(r => {
            const authorizedCount = r.authorizedUsers.length;
            const value = authorizedCount === 0
                ? 'No additional users'
                : `${authorizedCount} user(s) authorized`;

            return {
                name: r.name,
                value: value,
                inline: true
            };
        });

        const embed = new EmbedBuilder()
            .setColor(0x0099FF)
            .setTitle('Runner Access Overview')
            .addFields(...fields)
            .setTimestamp();

        await interaction.reply({
            embeds: [embed],
            flags: 64
        });
        return;
    }

    const runner = storage.getRunner(runnerId);
    if (!runner || runner.ownerId !== userId) {
        await interaction.reply({
            embeds: [createErrorEmbed('Access Denied', 'You can only view access for runners you own.')],
            flags: 64
        });
        return;
    }

    const authorizedUsers = runner.authorizedUsers;

    if (authorizedUsers.length === 0) {
        await interaction.reply({
            embeds: [createInfoEmbed('No Shared Access', 'This runner is not shared with anyone else.')],
            flags: 64
        });
        return;
    }

    const userList = await Promise.all(
        authorizedUsers.map(async (uid) => {
            try {
                const user = await botState.client.users.fetch(uid);
                return `• ${user.username} (${uid})`;
            } catch {
                return `• Unknown user (${uid})`;
            }
        })
    );

    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle(`Users with Access to ${runner.name}`)
        .setDescription(userList.join('\n'))
        .addFields(
            { name: 'Runner ID', value: `\`${runnerId}\``, inline: true },
            { name: 'Total Users', value: `${authorizedUsers.length}`, inline: true }
        )
        .setTimestamp();

    await interaction.reply({
        embeds: [embed],
        flags: 64
    });
}

export async function handleRunnerHealth(interaction: any, userId: string): Promise<void> {
    const runnerId = interaction.options.getString('runner', true);
    const runner = storage.getRunner(runnerId);
    if (!runner || !storage.canUserAccessRunner(userId, runnerId)) {
        await interaction.reply({
            embeds: [createErrorEmbed('Access Denied', 'You do not have access to this runner.')],
            flags: 64
        });
        return;
    }

    const ws = botState.runnerConnections.get(runnerId);
    if (!ws) {
        await interaction.reply({
            embeds: [createErrorEmbed('Runner Offline', 'Runner is not connected.')],
            flags: 64
        });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    const requestId = `runner_health_${runnerId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const data = await new Promise<any | null>((resolve) => {
        const timeout = setTimeout(() => {
            botState.pendingRunnerHealthRequests.delete(requestId);
            resolve(null);
        }, 8000);
        botState.pendingRunnerHealthRequests.set(requestId, { resolve, timeout });
        ws.send(JSON.stringify({
            type: 'runner_health_request',
            data: { runnerId, requestId }
        }));
    });

    if (!data) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Timeout', 'Runner did not respond in time.')]
        });
        return;
    }

    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle(`Runner Health: ${runner.name}`)
        .addFields(
            { name: 'Host', value: data.hostname || 'Unknown', inline: true },
            { name: 'Platform', value: `${data.platform || 'unknown'} (${data.arch || 'unknown'})`, inline: true },
            { name: 'CPU', value: `${data.cpuCount || 0} cores`, inline: true },
            { name: 'Load Avg', value: Array.isArray(data.loadAvg) ? data.loadAvg.map((n: number) => n.toFixed(2)).join(', ') : 'N/A', inline: true },
            { name: 'Memory', value: data.totalMem ? `${Math.round((data.totalMem - data.freeMem) / 1e6)}MB / ${Math.round(data.totalMem / 1e6)}MB` : 'N/A', inline: true },
            { name: 'Uptime', value: data.uptimeSec ? `${Math.round(data.uptimeSec)}s` : 'N/A', inline: true },
            { name: 'CLI Paths', value: `Claude: ${data.cliPaths?.claude || 'N/A'}\nGemini: ${data.cliPaths?.gemini || 'N/A'}\nCodex: ${data.cliPaths?.codex || 'N/A'}`, inline: false }
        )
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

export async function handleListClis(interaction: any, userId: string): Promise<void> {
    const runnerId = interaction.options.getString('runner');
    let runner = runnerId ? storage.getRunner(runnerId) : null;

    if (!runner) {
        const candidates = storage.getUserRunners(userId).filter(r => r.status === 'online');
        runner = candidates[0] || null;
    }

    if (!runner || !storage.canUserAccessRunner(userId, runner.runnerId)) {
        await interaction.reply({
            embeds: [createErrorEmbed('Access Denied', 'You do not have access to this runner.')],
            flags: 64
        });
        return;
    }

    const ws = botState.runnerConnections.get(runner.runnerId);
    if (!ws) {
        await interaction.reply({
            embeds: [createErrorEmbed('Runner Offline', 'Runner is not connected.')],
            flags: 64
        });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    const requestId = `runner_health_${runner.runnerId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const data = await new Promise<any | null>((resolve) => {
        const timeout = setTimeout(() => {
            botState.pendingRunnerHealthRequests.delete(requestId);
            resolve(null);
        }, 8000);
        botState.pendingRunnerHealthRequests.set(requestId, { resolve, timeout });
        ws.send(JSON.stringify({
            type: 'runner_health_request',
            data: { runnerId: runner.runnerId, requestId }
        }));
    });

    if (!data) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Timeout', 'Runner did not respond in time.')]
        });
        return;
    }

    const cliPaths = data.cliPaths || {};
    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle(`CLI Availability: ${runner.name}`)
        .addFields(
            { name: 'Claude', value: cliPaths.claude || 'Not detected', inline: false },
            { name: 'Gemini', value: cliPaths.gemini || 'Not detected', inline: false },
            { name: 'Codex', value: cliPaths.codex || 'Not detected', inline: false }
        )
        .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
}

export async function handleRunnerLogs(interaction: any, userId: string): Promise<void> {
    const runnerId = interaction.options.getString('runner', true);
    const runner = storage.getRunner(runnerId);
    if (!runner || !storage.canUserAccessRunner(userId, runnerId)) {
        await interaction.reply({
            embeds: [createErrorEmbed('Access Denied', 'You do not have access to this runner.')],
            flags: 64
        });
        return;
    }

    const ws = botState.runnerConnections.get(runnerId);
    if (!ws) {
        await interaction.reply({
            embeds: [createErrorEmbed('Runner Offline', 'Runner is not connected.')],
            flags: 64
        });
        return;
    }

    await interaction.deferReply({ ephemeral: true });

    const requestId = `runner_logs_${runnerId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const data = await new Promise<any | null>((resolve) => {
        const timeout = setTimeout(() => {
            botState.pendingRunnerLogsRequests.delete(requestId);
            resolve(null);
        }, 8000);
        botState.pendingRunnerLogsRequests.set(requestId, { resolve, timeout });
        ws.send(JSON.stringify({
            type: 'runner_logs_request',
            data: { runnerId, requestId, maxBytes: 20000 }
        }));
    });

    if (!data) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Timeout', 'Runner did not respond in time.')]
        });
        return;
    }

    if (data.error) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Logs Error', data.error)]
        });
        return;
    }

    const content = data.content ? data.content.slice(-1900) : 'No log content.';
    const embed = new EmbedBuilder()
        .setColor(0x0099FF)
        .setTitle(`Runner Logs: ${runner.name}`)
        .setDescription(`\`\`\`\n${content}\n\`\`\``)
        .setFooter({ text: data.logPath ? `Source: ${data.logPath}` : 'Source: unknown' });

    await interaction.editReply({ embeds: [embed] });
}

/**
 * Handle /share-runner command
 */
export async function handleShareRunner(interaction: any, userId: string): Promise<void> {
    const runnerId = interaction.options.getString('runner', true);
    const targetUser = interaction.options.getUser('user', true);

    const runner = storage.getRunner(runnerId);
    if (!runner || runner.ownerId !== userId) {
        await interaction.reply({
            embeds: [createErrorEmbed('Access Denied', 'You can only share runners you own.')],
            flags: 64
        });
        return;
    }

    if (runner.authorizedUsers.includes(targetUser.id)) {
        await interaction.reply({
            embeds: [createInfoEmbed('Already Shared', `${targetUser.username} already has access to this runner.`)],
            flags: 64
        });
        return;
    }

    runner.authorizedUsers.push(targetUser.id);
    storage.registerRunner(runner);

    // Update channel permissions
    await updateRunnerChannelPermissions(runner);

    await interaction.reply({
        embeds: [new EmbedBuilder()
            .setColor(0x00FF00)
            .setTitle('Runner Shared')
            .setDescription(`${targetUser.username} now has access to \`${runner.name}\`.`)
            .setTimestamp()
        ],
        flags: 64
    });
}

/**
 * Handle /unshare-runner command
 */
export async function handleUnshareRunner(interaction: any, userId: string): Promise<void> {
    const runnerId = interaction.options.getString('runner', true);
    const targetUser = interaction.options.getUser('user', true);

    const runner = storage.getRunner(runnerId);
    if (!runner || runner.ownerId !== userId) {
        await interaction.reply({
            embeds: [createErrorEmbed('Access Denied', 'You can only modify access for runners you own.')],
            flags: 64
        });
        return;
    }

    if (targetUser.id === runner.ownerId) {
        await interaction.reply({
            embeds: [createErrorEmbed('Cannot Remove Owner', 'You cannot remove your own access from a runner you own.')],
            flags: 64
        });
        return;
    }

    const index = runner.authorizedUsers.indexOf(targetUser.id);
    if (index === -1) {
        await interaction.reply({
            embeds: [createInfoEmbed('Not Shared', `${targetUser.username} does not have access to this runner.`)],
            flags: 64
        });
        return;
    }

    runner.authorizedUsers.splice(index, 1);
    storage.registerRunner(runner);

    await interaction.reply({
        embeds: [new EmbedBuilder()
            .setColor(0xFF9900)
            .setTitle('Access Removed')
            .setDescription(`${targetUser.username} no longer has access to \`${runner.name}\`.`)
            .setTimestamp()
        ],
        flags: 64
    });
}

/**
 * Handle /runner-status command
 */
export async function handleRunnerStatus(interaction: any, userId: string): Promise<void> {
    const runnerId = interaction.options.getString('runner', true);

    const runner = storage.getRunner(runnerId);
    if (!runner) {
        await interaction.reply({
            embeds: [createErrorEmbed('Not Found', 'Runner not found.')],
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

    const sessions = storage.getRunnerSessions(runnerId);
    const activeSessions = sessions.filter(s => s.status === 'active');

    let syncStatus: any = null;
    const sessionSync = getSessionSyncService();
    if (runner.status === 'online' && sessionSync) {
        syncStatus = await sessionSync.requestSyncStatus(runnerId, 3000);
    }

    const embed = new EmbedBuilder()
        .setColor(runner.status === 'online' ? 0x00FF00 : 0xFF0000)
        .setTitle(`Runner: ${runner.name}`)
        .addFields(
            { name: 'Status', value: runner.status === 'online' ? '🟢 Online' : '🔴 Offline', inline: true },
            { name: 'CLI Types', value: runner.cliTypes.join(', ').toUpperCase() || 'N/A', inline: true },
            { name: 'Active Sessions', value: `${activeSessions.length}`, inline: true },
            { name: 'Runner ID', value: `\`${runnerId}\``, inline: false }
        )
        .setTimestamp();

    if (syncStatus) {
        const lastSync = syncStatus.lastSyncAt ? syncStatus.lastSyncAt.toLocaleString() : 'N/A';
        embed.addFields({
            name: 'Sync Status',
            value: `${syncStatus.state.toUpperCase()} (Last: ${lastSync})`,
            inline: false
        });
    }

    if (runner.lastHeartbeat) {
        embed.setFooter({ text: `Last heartbeat: ${new Date(runner.lastHeartbeat).toLocaleString()}` });
    }

    await interaction.reply({
        embeds: [embed],
        flags: 64
    });
}

/**
 * Handle /action-items command
 */
export async function handleActionItems(interaction: any, userId: string): Promise<void> {
    const sessionId = interaction.options.getString('session');

    if (sessionId) {
        const session = storage.getSession(sessionId);
        if (!session) {
            await interaction.reply({
                embeds: [createErrorEmbed('Not Found', 'Session not found.')],
                flags: 64
            });
            return;
        }

        const runner = storage.getRunner(session.runnerId);
        if (!runner || !storage.canUserAccessRunner(userId, session.runnerId)) {
            await interaction.reply({
                embeds: [createErrorEmbed('Access Denied', 'You do not have access to this session.')],
                flags: 64
            });
            return;
        }

        const items = botState.actionItems.get(sessionId) || [];
        if (items.length === 0) {
            await interaction.reply({
                embeds: [createInfoEmbed('No Action Items', 'No action items have been extracted for this session yet.')],
                flags: 64
            });
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(0xFFAA00)
            .setTitle('Session Action Items')
            .setDescription(items.map((item, i) => `${i + 1}. ${item}`).join('\n'))
            .setTimestamp();

        await interaction.reply({
            embeds: [embed],
            flags: 64
        });
    } else {
        // Show all action items for user's sessions
        const runners = storage.getUserRunners(userId);
        const allItems: string[] = [];

        for (const runner of runners) {
            const sessions = storage.getRunnerSessions(runner.runnerId);
            for (const session of sessions) {
                const items = botState.actionItems.get(session.sessionId) || [];
                if (items.length > 0) {
                    allItems.push(`**${session.sessionId}:**\n${items.map(i => `  • ${i}`).join('\n')}`);
                }
            }
        }

        if (allItems.length === 0) {
            await interaction.reply({
                embeds: [createInfoEmbed('No Action Items', 'No action items found across your sessions.')],
                flags: 64
            });
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(0xFFAA00)
            .setTitle('All Action Items')
            .setDescription(allItems.join('\n\n'))
            .setTimestamp();

        await interaction.reply({
            embeds: [embed],
            flags: 64
        });
    }
}
