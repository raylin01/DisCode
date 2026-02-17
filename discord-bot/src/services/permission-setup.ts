/**
 * Permission Setup Module
 *
 * Handles permission configuration and synchronization for runner channels.
 * Ensures channels are properly isolated to authorized users only.
 */

import { OverwriteType } from 'discord.js';

// ============================================================================
// Types
// ============================================================================

export interface RunnerPermissionInfo {
    ownerId: string;
    authorizedUsers: string[];
}

export interface PermissionOverwriteData {
    id: string;
    deny?: string[];
    allow?: string[];
}

// ============================================================================
// Permission Overwrite Builders
// ============================================================================

/**
 * Build permission overwrites for a runner's channels
 * - Denies ViewChannel to @everyone
 * - Allows full access to owner and authorized users
 */
export function buildChannelPermissionOverwrites(
    runner: RunnerPermissionInfo,
    everyoneRoleId: string
): PermissionOverwriteData[] {
    const overwrites: PermissionOverwriteData[] = [
        {
            id: everyoneRoleId,
            deny: ['ViewChannel', 'ReadMessageHistory', 'SendMessages']
        }
    ];

    // Add owner permissions
    if (runner.ownerId) {
        overwrites.push({
            id: runner.ownerId,
            allow: ['ViewChannel', 'ReadMessageHistory', 'SendMessages', 'CreatePublicThreads', 'CreatePrivateThreads', 'ManageThreads', 'SendMessagesInThreads']
        });
    }

    // Add authorized users (excluding owner)
    for (const userId of runner.authorizedUsers) {
        if (userId && userId !== runner.ownerId) {
            overwrites.push({
                id: userId,
                allow: ['ViewChannel', 'ReadMessageHistory', 'SendMessages', 'CreatePublicThreads', 'CreatePrivateThreads', 'SendMessagesInThreads']
            });
        }
    }

    return overwrites;
}

// ============================================================================
// Permission Application
// ============================================================================

/**
 * Check if a channel already has the correct permissions
 * Returns true if permissions are already correct (no migration needed)
 */
export function channelHasCorrectPermissions(
    channel: any,
    runner: RunnerPermissionInfo,
    everyoneRoleId: string
): boolean {
    if (!channel || !channel.permissionOverwrites) return false;

    const cache = channel.permissionOverwrites.cache;

    // Check @everyone is denied ViewChannel
    const everyoneOverwrite = cache.get(everyoneRoleId);
    if (!everyoneOverwrite || !everyoneOverwrite.deny.has('ViewChannel')) {
        return false;
    }

    // Check owner has ViewChannel
    if (runner.ownerId) {
        const ownerOverwrite = cache.get(runner.ownerId);
        if (!ownerOverwrite || !ownerOverwrite.allow.has('ViewChannel')) {
            return false;
        }
    }

    return true;
}

/**
 * Apply permission overwrites to a channel using create() for each user/role
 * Only modifies if permissions are not already correct
 */
export async function applyPermissionsToChannel(
    channel: any,
    runner: RunnerPermissionInfo,
    guild: any,
    channelName: string,
    forceUpdate: boolean = false
): Promise<void> {
    if (!channel) {
        console.log(`[PermissionSetup] Channel ${channelName} not found, skipping`);
        return;
    }

    const everyoneRoleId = guild.roles.everyone.id;

    // Check if already correct (skip unless forced)
    if (!forceUpdate && channelHasCorrectPermissions(channel, runner, everyoneRoleId)) {
        console.log(`[PermissionSetup] ✓ ${channelName} already has correct permissions, skipping`);
        return;
    }

    try {
        // Clear existing overwrites first
        const existingIds = [...channel.permissionOverwrites.cache.keys()];
        for (const id of existingIds) {
            await channel.permissionOverwrites.delete(id).catch(() => {});
        }

        // Create overwrite for @everyone (deny all)
        await channel.permissionOverwrites.create(everyoneRoleId, {
            ViewChannel: false,
            ReadMessageHistory: false,
            SendMessages: false
        }, { type: OverwriteType.Role });

        // Create overwrite for owner (allow all)
        if (runner.ownerId) {
            await channel.permissionOverwrites.create(runner.ownerId, {
                ViewChannel: true,
                ReadMessageHistory: true,
                SendMessages: true,
                CreatePublicThreads: true,
                CreatePrivateThreads: true,
                ManageThreads: true,
                SendMessagesInThreads: true
            }, { type: OverwriteType.Member });
        }

        // Create overwrites for authorized users
        for (const userId of runner.authorizedUsers) {
            if (userId && userId !== runner.ownerId) {
                await channel.permissionOverwrites.create(userId, {
                    ViewChannel: true,
                    ReadMessageHistory: true,
                    SendMessages: true,
                    CreatePublicThreads: true,
                    CreatePrivateThreads: true,
                    SendMessagesInThreads: true
                }, { type: OverwriteType.Member });
            }
        }

        console.log(`[PermissionSetup] ✓ Migrated permissions for ${channelName}`);
    } catch (error) {
        console.error(`[PermissionSetup] ✗ Error applying permissions to ${channelName}:`, error);
    }
}
