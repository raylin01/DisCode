/**
 * Handle /register-project command
 * 
 * Manually registers a project folder for a runner.
 */

import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import { storage } from '../../storage.js';
import { getCategoryManager } from '../../services/category-manager.js';
import { createErrorEmbed, createSuccessEmbed } from '../../utils/embeds.js';
import { SessionSyncService, getSessionSyncService } from '../../services/session-sync.js';

export async function handleRegisterProject(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    try {
        const path = interaction.options.getString('path', true);
        const runnerIdOption = interaction.options.getString('runner');

        // Determine runner
        let runnerId = runnerIdOption;
        if (!runnerId) {
            // Try to infer from channel context
            const allRunners = Object.values(storage.data.runners);
            const channelRunner = allRunners.find(r => 
                r.privateChannelId === interaction.channelId || 
                r.discordState?.controlChannelId === interaction.channelId ||
                Object.values(r.discordState?.projects || {}).some((p: any) => p.channelId === interaction.channelId)
            );
            
            if (channelRunner) {
                runnerId = channelRunner.runnerId;
            } else {
                // Try to find first online runner owned by user
                const userRunners = storage.getUserRunners(userId).filter(r => r.status === 'online');
                if (userRunners.length > 0) {
                    runnerId = userRunners[0].runnerId;
                }
            }
        }

        if (!runnerId) {
            await interaction.editReply({ 
                embeds: [createErrorEmbed('Runner Required', 'Please specify a runner ID or run this command in a runner channel.')] 
            });
            return;
        }

        const runner = storage.getRunner(runnerId);
        if (!runner) {
            await interaction.editReply({ 
                embeds: [createErrorEmbed('Runner Not Found', `Runner ${runnerId} does not exist.`)] 
            });
            return;
        }

        if (!storage.canUserAccessRunner(userId, runnerId)) {
            await interaction.editReply({ 
                embeds: [createErrorEmbed('Access Denied', 'You do not have permission to modify this runner.')] 
            });
            return;
        }

        // Register the project
        const categoryManager = getCategoryManager();
        if (!categoryManager) {
            await interaction.editReply({ 
                embeds: [createErrorEmbed('System Error', 'Category Manager is not initialized.')] 
            });
            return;
        }

        // Create the channel structure
        const projectChannel = await categoryManager.createProjectChannel(runnerId, path);
        if (!projectChannel) {
             await interaction.editReply({ 
                embeds: [createErrorEmbed('Registration Failed', 'Could not create project channel check permissions or path format.')] 
            });
            return;
        }

        // Trigger a sync for this project
        const sessionSync = getSessionSyncService();
        if (sessionSync) {
            await sessionSync.syncProjectSessions(runnerId, path);
        }

        await interaction.editReply({ 
            embeds: [createSuccessEmbed('Project Registered', `Successfully registered project **${path}** for runner **${runner.name}**.\nCheck the new channel: <#${projectChannel.channelId}>`)] 
        });

    } catch (error: any) {
        console.error('Error registering project:', error);
        await interaction.editReply({ 
            embeds: [createErrorEmbed('Registration Failed', error.message || 'Unknown error')] 
        });
    }
}
