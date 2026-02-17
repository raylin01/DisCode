import { ChatInputCommandInteraction } from 'discord.js';
import { storage } from '../../storage.js';
import { getCategoryManager } from '../../services/category-manager.js';
import { getSessionSyncService } from '../../services/session-sync.js';

export async function handleDeleteProject(
    interaction: ChatInputCommandInteraction,
    userId: string
): Promise<void> {
    const delay = Date.now() - interaction.createdTimestamp;
    console.log(`[DeleteProject] Interaction received. Delay: ${delay}ms`);

    try {
        await interaction.deferReply({ ephemeral: true });
    } catch (error) {
        console.error(`[DeleteProject] Failed to defer reply (Delay: ${delay}ms):`, error);
        return; // Cannot proceed if interaction is invalid
    }

    // Get parameters
    const projectPath = interaction.options.getString('path');
    const runnerId = interaction.options.getString('runner') || storage.getRunnerForUser(userId)?.runnerId;

    // Check for 'all' flag
    const deleteAll = interaction.options.getBoolean('all');

    if (deleteAll) {
        if (!runnerId) {
            await safeEditReply(interaction, '❌ Could not determine runner ID. Please specify it.');
            return;
        }
        await deleteAllProjects(interaction, runnerId, userId);
        return;
    }

    if (!projectPath && !runnerId) {
        // Try to infer from current channel
        // If we are in a project channel, we can delete it
        const currentChannelId = interaction.channelId;
        const manager = getCategoryManager();
        if (manager) {
            // Brute force check all runners/projects (inefficient but safe)
            for (const runner of Object.values(storage.data.runners) as any[]) {
                if (runner.discordState?.projects) {
                    for (const [path, projData] of Object.entries(runner.discordState.projects) as any[]) {
                         if (projData.channelId === currentChannelId) {
                             await deleteProject(interaction, runner.runnerId, path, userId);
                             return;
                         }
                    }
                }
            }
        }
    }

    if (!projectPath) {
         await safeEditReply(interaction, '❌ Please specify a project path, run inside a project channel, or use `all: true`.');
         return;
    }

    if (!runnerId) {
        await safeEditReply(interaction, '❌ Could not determine runner ID. Please specify it.');
        return;
    }

    await deleteProject(interaction, runnerId, projectPath.trim(), userId);
}

// Helper to safely reply/edit interaction
async function safeEditReply(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
    try {
        await interaction.editReply(content);
    } catch (error) {
        console.warn('[DeleteProject] Failed to edit reply:', error);
    }
}

async function deleteAllProjects(
    interaction: ChatInputCommandInteraction,
    runnerId: string,
    userId: string
): Promise<void> {
    const runner = storage.getRunner(runnerId);
    if (!runner) {
        await safeEditReply(interaction, `❌ Runner \`${runnerId}\` not found.`);
        return;
    }

    if (runner.ownerId !== userId) {
        await safeEditReply(interaction, '❌ Only the owner can delete projects.');
        return;
    }

    const discordState = runner.discordState;
    if (!discordState || !discordState.projects || Object.keys(discordState.projects).length === 0) {
        await safeEditReply(interaction, '⚠️ No projects found to delete.');
        return;
    }

    const projects = Object.keys(discordState.projects);
    await safeEditReply(interaction, `⚠️ Deleting ${projects.length} projects and their channels...`);

    let deletedCount = 0;
    // Stop syncing first
    const syncService = getSessionSyncService();
    if (syncService) {
         syncService.stopSyncingRunner(runnerId);
    }

    for (const projectPath of projects) {
        try {
            const channelId = discordState.projects[projectPath].channelId;
            if (channelId) {
                // If current channel, just delete it at the end or ignore error
                try {
                    const channel = await interaction.client.channels.fetch(channelId);
                    if (channel) {
                        await channel.delete('Delete All Projects command');
                    }
                } catch (e) {
                     console.warn(`[DeleteAll] Failed to delete channel ${channelId}:`, e);
                }
            }
            delete discordState.projects[projectPath];
            deletedCount++;
        } catch (e) {
            console.error(`[DeleteAll] Error deleting project ${projectPath}:`, e);
        }
    }

    // Explicitly clear CategoryManager cache
    const manager = getCategoryManager();
    if (manager) {
        const cat = manager.getRunnerCategory(runnerId);
        if (cat) {
            cat.projects.clear();
        }
    }

    // Cleanup sessions
    if (discordState.sessions) {
        discordState.sessions = {};
    }

    storage.updateRunner(runnerId, { discordState });
    
    // Restart sync (clean state)
    if (syncService) {
         await syncService.startSyncingRunner(runnerId);
    }

    try {
        if (interaction.channel) {
             await safeEditReply(interaction, `✅ Deleted ${deletedCount} projects.`);
        }
    } catch (e) { /* channel likely gone */ }
}

async function deleteProject(
    interaction: ChatInputCommandInteraction,
    runnerId: string,
    projectPath: string,
    userId: string
): Promise<void> {
    const runner = storage.getRunner(runnerId);
    if (!runner) {
        await safeEditReply(interaction, `❌ Runner \`${runnerId}\` not found.`);
        return;
    }

    // Check ownership/permissions
    if (runner.ownerId !== userId) {
        await safeEditReply(interaction, '❌ Only the owner can delete projects.');
        return;
    }

    const discordState = runner.discordState;
    if (!discordState || !discordState.projects || !discordState.projects[projectPath]) {
        await safeEditReply(interaction, `❌ Project \`${projectPath}\` is not registered.`);
        return;
    }

    try {
        const channelId = discordState.projects[projectPath].channelId;

        // 1. Delete Channel
        if (channelId) {
            try {
                // If we are deleting the channel we are running the command in, acknowledge FIRST
                if (interaction.channelId === channelId) {
                    await safeEditReply(interaction, `✅ Deleting project channel \`${projectPath}\`...`);
                }

                const channel = await interaction.client.channels.fetch(channelId);
                if (channel) {
                    await channel.delete('Project deleted by user');
                }
            } catch (e) {
                console.warn(`[DeleteProject] Failed to delete channel ${channelId}:`, e);
                // If we failed to delete (e.g. permissions), tell user
                 if (interaction.channelId !== channelId) {
                     await safeEditReply(interaction, `⚠️ Failed to delete Discord channel, but removing from sync state.`);
                 }
            }
        }

        // 2. Remove from Storage
        delete discordState.projects[projectPath];
        
        // Also cleanup sessions mapped to this project
        if (discordState.sessions) {
            for (const [sid, sess] of Object.entries(discordState.sessions)) {
                if (sess.projectPath === projectPath) {
                    delete discordState.sessions[sid];
                }
            }
        }

        storage.updateRunner(runnerId, { discordState });
        
        // Match CategoryManager state
        const manager = getCategoryManager();
        if (manager) {
            const cat = manager.getRunnerCategory(runnerId);
            if (cat) cat.projects.delete(projectPath);
        }

        // 3. Update SyncService
        const syncService = getSessionSyncService();
        if (syncService) {
             syncService.stopSyncingRunner(runnerId);
             await syncService.startSyncingRunner(runnerId);
        }

        // 4. Final reply (only if we didn't delete the current channel)
        if (interaction.channelId !== channelId) {
             await safeEditReply(interaction, `✅ Project \`${projectPath}\` deleted successfully.`);
        }

    } catch (error) {
        console.error('[DeleteProject] Error:', error);
        if (interaction.channelId) {
             await safeEditReply(interaction, '❌ Failed to delete project. Check logs.');
        }
    }
}
