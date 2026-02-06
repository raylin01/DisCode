/**
 * Resume Session Command Handler
 * 
 * Resumes a synced session from VS Code or a previously ended Discord session.
 */

import { ChatInputCommandInteraction, EmbedBuilder } from 'discord.js';
import { getSessionSyncService } from '../../services/session-sync.js';
import { storage } from '../../storage.js';
import * as botState from '../../state.js';
import { createErrorEmbed, createInfoEmbed, createSuccessEmbed } from '../../utils/embeds.js';
import type { Session } from '../../../../shared/types.js';

export async function handleResumeSession(interaction: ChatInputCommandInteraction, userId: string): Promise<void> {
    await interaction.deferReply();

    const explicitlyRequestedSessionId = interaction.options.getString('session');
    
    // Determine context (thread vs explicit ID)
    let targetSessionId = explicitlyRequestedSessionId;
    let targetThreadId = interaction.channel?.isThread() ? interaction.channelId : undefined;

    // Local Variables for Session Info
    let resumeSource: 'synced_thread' | 'ended_storage' | 'synced_explicit' | null = null;
    let runnerId: string | null = null;
    let projectPath: string | null = null;
    let resolvedSessionId: string | null = null;

    // 1. Check if we are in a thread and no explicit ID provided
    if (!targetSessionId && targetThreadId) {
        // A. Check if there's already an ACTIVE session in this thread
        const activeSession = Object.values(storage.data.sessions).find(s => 
            s.threadId === targetThreadId && s.status === 'active'
        );
        
        if (activeSession) {
            await interaction.editReply({
                embeds: [createInfoEmbed('Session Active', 'This thread already has an active session.')]
            });
            return;
        }

        // B. Check Session Sync Service (Synced Session)
        const sessionSync = getSessionSyncService();
        if (sessionSync) {
            const syncEntry = sessionSync.getSessionByThreadId(targetThreadId);
            if (syncEntry) {
                resumeSource = 'synced_thread';
                runnerId = syncEntry.runnerId;
                projectPath = syncEntry.projectPath;
                resolvedSessionId = syncEntry.session.claudeSessionId;
            }
        }

        // C. Check Storage (Ended Session)
        if (!resumeSource) {
            const sessionsInThread = storage.getSessionsByThreadId(targetThreadId);
            if (sessionsInThread.length > 0) {
                // Get most recent ended session
                const lastSession = sessionsInThread[0]; // storage usually sorts or returns list
                resumeSource = 'ended_storage';
                runnerId = lastSession.runnerId;
                resolvedSessionId = lastSession.sessionId;
                projectPath = lastSession.folderPath || null;
            }
        }
    } 
    // 2. Explicit Session ID handling
    else if (targetSessionId) {
        // A. Check Storage
        const storedSession = storage.getSession(targetSessionId);
        if (storedSession) {
            if (storedSession.status === 'active') {
                await interaction.editReply({
                     embeds: [createInfoEmbed('Session Active', `Session \`${targetSessionId}\` is already active in <#${storedSession.threadId}>.`)]
                });
                return;
            }
            resumeSource = 'ended_storage';
            runnerId = storedSession.runnerId;
            resolvedSessionId = storedSession.sessionId;
            projectPath = storedSession.folderPath || null;
        } else {
             // B. Check Sync Service (by finding it in all projects)
             // This is expensive if we don't have a lookup map, but let's assume valid ID
             // For now, we support resuming ONLY if we can find the context
             await interaction.editReply({
                 embeds: [createErrorEmbed('Not Found', 'Could not find session to resume. Make sure syncing is active or you are in a valid thread.')]
             });
             return;
        }
    } else {
        await interaction.editReply({
            embeds: [createErrorEmbed('Invalid Context', 'Please run this command inside a session thread or provide a session ID.')]
        });
        return;
    }

    if (!resumeSource || !runnerId || !resolvedSessionId) {
        await interaction.editReply({
            embeds: [createErrorEmbed('Not Found', 'Could not determine session to resume.')]
        });
        return;
    }

    // Verify Access
    const runner = storage.getRunner(runnerId);
    if (!runner) {
        await interaction.editReply({ embeds: [createErrorEmbed('Runner Missing', 'The runner for this session is not available.')] });
        return;
    }

    if (!storage.canUserAccessRunner(userId, runnerId)) {
        await interaction.editReply({ embeds: [createErrorEmbed('Access Denied', 'You do not have access to this runner.')] });
        return;
    }

    if (runner.status !== 'online') {
        await interaction.editReply({ embeds: [createErrorEmbed('Runner Offline', 'Runner is offline.')] });
        return;
    }

    // --- RESUME LOGIC ---

    const sessionSync = getSessionSyncService();
    // 1. Mark as owned to stop file watching sync (avoid double writes/loops)
    if (sessionSync) {
        sessionSync.markSessionAsOwned(resolvedSessionId);
    }

    // 2. Update/Create Storage Entry
    const now = new Date().toISOString();
    let sessionObj: Session | undefined = storage.getSession(resolvedSessionId);
    
    if (sessionObj) {
        // Reactivate existing ended session
        sessionObj.status = 'active';
        sessionObj.interactionToken = interaction.token;
        storage.updateSession(resolvedSessionId, sessionObj); // This saves to disk
    } else {
        // Create new entry for synced session we are taking over
        // If resuming a synced session, we should try to reuse the thread
        if (!targetThreadId && resumeSource === 'synced_thread') {
             // We should have threadId from context
        }
        
        sessionObj = {
            sessionId: resolvedSessionId,
            runnerId: runnerId,
            channelId: interaction.channelId, // usually same as thread
            threadId: targetThreadId || interaction.channelId, 
            createdAt: now,
            status: 'active',
            cliType: 'claude', // Assume Claude for synced sessions
            plugin: 'claude-sdk', // Default to SDK for control
            folderPath: projectPath || undefined,
            interactionToken: interaction.token,
            creatorId: userId
        };
        storage.createSession(sessionObj);
    }

    // 3. Send Start Command to Runner
    const ws = botState.runnerConnections.get(runnerId);
    if (ws) {
        ws.send(JSON.stringify({
            type: 'session_start',
            data: {
                sessionId: resolvedSessionId,
                runnerId: runnerId,
                cliType: 'claude',
                plugin: 'claude-sdk',
                folderPath: projectPath,
                resume: true // Explicitly flag as resume
            }
        }));

        await interaction.editReply({
            embeds: [createSuccessEmbed('Session Resumed', `Taking control of session \`${resolvedSessionId.slice(0, 8)}\`. Discord is now managing this session.`)]
        });
        
        // Ensure bot state tracks it
        botState.sessionStatuses.set(resolvedSessionId, 'working'); // Assume working until hear back
    } else {
         await interaction.editReply({
            embeds: [createErrorEmbed('Connection Error', 'Failed to send command to runner.')]
        });
    }
}
