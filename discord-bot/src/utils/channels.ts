/**
 * Channel Utilities
 * 
 * Helper functions for managing Discord channels, categories, and permissions.
 */

import { ChannelType } from 'discord.js';
import * as botState from '../state.js';
import { storage } from '../storage.js';
import type { RunnerInfo } from '../../../shared/types.ts';

/**
 * Wait for the bot to be ready before performing channel operations
 */
async function waitForBotReady(): Promise<void> {
    if (botState.isBotReady) return;

    console.log('Waiting for bot to be ready...');
    await new Promise<void>(resolve => {
        const checkInterval = setInterval(() => {
            if (botState.isBotReady) {
                clearInterval(checkInterval);
                resolve();
            }
        }, 100);
        // Timeout after 5 seconds
        setTimeout(() => {
            clearInterval(checkInterval);
            resolve();
        }, 5000);
    });
}

/**
 * Get or create the Runners category for organizing runner channels
 */
export async function getOrCreateRunnersCategory(guildId: string): Promise<string> {
    await waitForBotReady();

    const guild = await botState.client.guilds.fetch(guildId);

    // Try to find existing category
    const existingCategory = guild.channels.cache.find((channel: any) =>
        channel.name === 'Runners' && channel.type === ChannelType.GuildCategory
    );

    if (existingCategory) {
        return existingCategory.id;
    }

    // Create new category
    const category = await guild.channels.create({
        name: 'Runners',
        type: ChannelType.GuildCategory
    });

    console.log(`Created runners category: ${category.id}`);
    return category.id;
}

/**
 * Get or create a private channel for a runner
 */
export async function getOrCreateRunnerChannel(runner: RunnerInfo, guildId: string): Promise<string> {
    await waitForBotReady();

    // If runner already has a private channel, return it
    if (runner.privateChannelId) {
        try {
            const channel = await botState.client.channels.fetch(runner.privateChannelId);
            if (channel) {
                return runner.privateChannelId;
            }
        } catch (error) {
            // Channel doesn't exist, continue to create new one
            console.error(`Error fetching runner channel: ${error}`);
        }
    }

    // Get or create runners category
    const categoryId = await getOrCreateRunnersCategory(guildId);

    // Create a new private channel for the runner
    const guild = await botState.client.guilds.fetch(guildId);

    // Check if a channel with this runner's name already exists in the category
    const existingChannels = guild.channels.cache.filter((channel: any) =>
        channel.name === runner.name &&
        channel.type === ChannelType.GuildText &&
        channel.parentId === categoryId
    );

    if (existingChannels.size > 0) {
        const existingChannel = existingChannels.first()!;
        console.log(`Found existing channel ${existingChannel.id} for runner ${runner.name}, reusing it`);
        runner.privateChannelId = existingChannel.id;
        storage.registerRunner(runner);
        return existingChannel.id;
    }

    // Build permission overwrites - deny everyone, allow owner + shared users
    const permissionOverwrites: Array<{ id: string; deny?: string[]; allow?: string[] }> = [
        {
            id: guild.roles.everyone.id,
            deny: ['ViewChannel', 'ReadMessageHistory', 'SendMessages']
        }
    ];

    // Add owner permissions (validate ID is not null/undefined)
    if (runner.ownerId) {
        console.log(`Adding owner ${runner.ownerId} to permission overwrites for runner ${runner.name}`);
        permissionOverwrites.push({
            id: runner.ownerId,
            allow: ['ViewChannel', 'ReadMessageHistory', 'SendMessages', 'CreatePublicThreads', 'CreatePrivateThreads', 'ManageThreads', 'SendMessagesInThreads']
        });
    }

    // Add shared users (filter out null/undefined and owner)
    const sharedUsers = runner.authorizedUsers.filter(userId => userId && userId !== runner.ownerId);
    console.log(`Adding ${sharedUsers.length} shared users to permission overwrites for runner ${runner.name}`);
    sharedUsers.forEach(userId => {
        console.log(`  - Adding user ${userId}`);
        permissionOverwrites.push({
            id: userId,
            allow: ['ViewChannel', 'ReadMessageHistory', 'SendMessages', 'CreatePublicThreads', 'CreatePrivateThreads', 'SendMessagesInThreads']
        });
    });

    console.log(`Creating channel ${runner.name} with ${permissionOverwrites.length} permission overwrites`);

    const channel = await guild.channels.create({
        name: runner.name,
        type: ChannelType.GuildText,
        parent: categoryId, // Place in runners category
        permissionOverwrites: permissionOverwrites as any // Type assertion needed due to permission string representation
    });

    // Update runner with new channel ID
    runner.privateChannelId = channel.id;
    storage.registerRunner(runner);

    console.log(`Created private channel ${channel.id} for runner ${runner.name} in category ${categoryId} (shared with ${runner.authorizedUsers.length} users)`);
    return channel.id;
}

/**
 * Update channel permissions for a runner when users are added/removed
 */
export async function updateRunnerChannelPermissions(runner: RunnerInfo): Promise<void> {
    if (!runner.privateChannelId) {
        return;
    }

    try {
        const channel = await botState.client.channels.fetch(runner.privateChannelId);
        if (!channel || !('permissionOverwrites' in channel)) {
            return;
        }

        // Update permission overwrites for all authorized users
        for (const userId of runner.authorizedUsers) {
            const existingOverwrite = channel.permissionOverwrites.cache.get(userId);

            if (!existingOverwrite) {
                // Add permission for this user
                await channel.permissionOverwrites.create(userId, {
                    ViewChannel: true,
                    ReadMessageHistory: true,
                    SendMessages: true,
                    CreatePublicThreads: true,
                    CreatePrivateThreads: true,
                    SendMessagesInThreads: true
                });
                console.log(`Added permissions for user ${userId} in runner channel ${runner.privateChannelId}`);
            }
        }
    } catch (error) {
        console.error(`Error updating channel permissions: ${error}`);
    }
}
