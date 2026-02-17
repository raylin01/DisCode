/**
 * Session Context Recovery Helpers
 *
 * Provides utilities for recovering session creation state from Discord interactions.
 * These helpers infer runner, project, and CLI information from the interaction context
 * when the in-memory state is lost (e.g., bot restart or button expiration).
 */

import * as botState from '../state.js';
import { storage } from '../storage.js';
import { getCategoryManager } from '../services/category-manager.js';

// ---------------------------------------------------------------------------
// Utility Helpers
// ---------------------------------------------------------------------------

/** Reply or edit reply depending on interaction state (handles auto-defer) */
export async function safeReplyOrEdit(interaction: any, payload: any): Promise<void> {
    try {
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply(payload);
        } else {
            await interaction.reply(payload);
        }
    } catch (error: any) {
        // Fallback: try editReply if reply fails
        if (error?.code === 'InteractionAlreadyReplied') {
            await interaction.editReply(payload).catch(() => {});
        }
    }
}

export function truncateForDiscord(value: string, max: number): string {
    if (value.length <= max) return value;
    return `${value.slice(0, Math.max(0, max - 1))}...`;
}

export function isModelSelectableCli(cliType: string | undefined): cliType is 'claude' | 'codex' {
    return cliType === 'claude' || cliType === 'codex';
}

export function inferCliTypeFromInteraction(interaction: any, plugin: string): 'claude' | 'gemini' | 'codex' | 'terminal' | null {
    if (plugin === 'codex-sdk') return 'codex';
    if (plugin === 'claude-sdk') return 'claude';
    if (plugin === 'gemini-sdk') return 'gemini';
    if (plugin === 'stream') return 'gemini';

    const content = interaction?.message?.content ?? '';
    const description = interaction?.message?.embeds?.[0]?.description ?? '';
    const match = `${content}\n${description}`.match(/\*\*CLI:\*\*\s*([A-Za-z0-9_-]+)/i);
    if (!match) return null;

    const cli = match[1].toLowerCase();
    if (cli === 'claude' || cli === 'gemini' || cli === 'codex' || cli === 'terminal') {
        return cli;
    }
    return null;
}

export function inferSessionFromReviewEmbed(interaction: any): Partial<any> | null {
    const description = interaction?.message?.embeds?.[0]?.description;
    if (!description || typeof description !== 'string') return null;

    const cliMatch = description.match(/\*\*CLI:\*\*\s*([A-Za-z0-9_-]+)/i);
    const pluginMatch = description.match(/\*\*Plugin:\*\*\s*([A-Za-z0-9 _()-]+)/i);
    const folderMatch = description.match(/\*\*Folder:\*\*\s*`([^`]+)`/i);

    const inferred: Partial<any> = {};

    if (cliMatch) {
        const cli = cliMatch[1].toLowerCase();
        if (cli === 'claude' || cli === 'gemini' || cli === 'codex' || cli === 'terminal') {
            inferred.cliType = cli;
        }
    }

    if (pluginMatch) {
        const pluginRaw = pluginMatch[1].toLowerCase();
        if (pluginRaw.includes('claude') && pluginRaw.includes('sdk')) inferred.plugin = 'claude-sdk';
        else if (pluginRaw.includes('gemini') && pluginRaw.includes('sdk')) inferred.plugin = 'gemini-sdk';
        else if (pluginRaw.includes('codex') && pluginRaw.includes('sdk')) inferred.plugin = 'codex-sdk';
        else if (pluginRaw.includes('stream')) inferred.plugin = 'stream';
        else if (pluginRaw.includes('print')) inferred.plugin = 'print';
        else if (pluginRaw.includes('tmux') || pluginRaw.includes('interactive')) inferred.plugin = 'tmux';
    }

    if (folderMatch) {
        inferred.folderPath = folderMatch[1];
    }

    return Object.keys(inferred).length > 0 ? inferred : null;
}

// ---------------------------------------------------------------------------
// Context Recovery Functions
// ---------------------------------------------------------------------------

export async function getRunnerIdFromContext(interaction: any): Promise<string | undefined> {
    const syncCm = getCategoryManager();
    if (!syncCm) return undefined;

    let channel = interaction.channel;
    if (!channel || !channel.parentId) {
        try {
            channel = await interaction.client.channels.fetch(interaction.channelId);
        } catch (e) {
            console.error('[SessionButtons] Failed to fetch channel:', e);
            return undefined;
        }
    }

    if (channel?.isThread()) {
        try {
            channel = channel.parent || (channel.parentId ? await interaction.client.channels.fetch(channel.parentId) : null);
        } catch (e) {
            console.error('[SessionButtons] Failed to fetch parent channel:', e);
            return undefined;
        }
    }

    if (channel?.id) {
        const directRunnerId = syncCm.getRunnerByChannelId(channel.id);
        if (directRunnerId) return directRunnerId;
    }

    const categoryId = channel?.parentId;
    if (!categoryId) return undefined;

    const runnerId = syncCm.getRunnerByCategoryId(categoryId);
    if (runnerId) return runnerId;

    const fallbackRunner = Object.values(storage.data.runners).find(r => r.discordState?.categoryId === categoryId);
    return fallbackRunner?.runnerId;
}

export async function getProjectChannelIdFromContext(interaction: any): Promise<string | undefined> {
    let channel = interaction.channel;
    if (!channel || !channel.parentId) {
        try {
            channel = await interaction.client.channels.fetch(interaction.channelId);
        } catch (e) { return undefined; }
    }

    if (channel?.isThread()) {
        try {
            channel = channel.parent || (channel.parentId ? await interaction.client.channels.fetch(channel.parentId) : null);
        } catch (e) { return undefined; }
    }

    return channel?.id;
}

export async function getProjectPathFromContext(interaction: any): Promise<string | undefined> {
    const syncCm = getCategoryManager();
    if (!syncCm) return undefined;

    let channel = interaction.channel;
    if (!channel || !channel.parentId) {
        try {
            channel = await interaction.client.channels.fetch(interaction.channelId);
        } catch (e) { return undefined; }
    }

    if (channel?.isThread()) {
        try {
            channel = channel.parent || (channel.parentId ? await interaction.client.channels.fetch(channel.parentId) : null);
        } catch (e) { return undefined; }
    }

    const projectInfo = syncCm.getProjectByChannelId(channel.id);
    return projectInfo?.projectPath;
}

export async function recoverSessionCreationState(interaction: any, userId: string) {
    const runnerId = await getRunnerIdFromContext(interaction);
    if (!runnerId) return null;

    const projectPath = await getProjectPathFromContext(interaction);
    const projectChannelId = await getProjectChannelIdFromContext(interaction);
    const state = {
        step: 'select_cli' as const,
        runnerId,
        folderPath: projectPath,
        projectChannelId
    };
    botState.sessionCreationState.set(userId, state);
    return state;
}

export async function resolveSessionCreationState(interaction: any, userId: string): Promise<any | null> {
    let state = botState.sessionCreationState.get(userId) as any;

    if (!state || !state.runnerId) {
        state = await recoverSessionCreationState(interaction, userId);
    }
    if (!state) return null;

    const inferred = inferSessionFromReviewEmbed(interaction);
    if (inferred) {
        state = { ...state, ...inferred };
    }

    if (!state.runnerId) {
        const runnerId = await getRunnerIdFromContext(interaction);
        if (runnerId) state.runnerId = runnerId;
    }

    if (!state.folderPath) {
        const projectPath = await getProjectPathFromContext(interaction);
        if (projectPath) state.folderPath = projectPath;
    }

    if (!state.cliType && state.plugin) {
        const inferredCli = inferCliTypeFromInteraction(interaction, state.plugin);
        if (inferredCli) state.cliType = inferredCli;
    }

    if (!state.projectChannelId) {
        const projectChannelId = await getProjectChannelIdFromContext(interaction);
        if (projectChannelId) state.projectChannelId = projectChannelId;
    }

    botState.sessionCreationState.set(userId, state);
    return state;
}
