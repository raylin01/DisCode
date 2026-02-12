/**
 * Session Handlers
 *
 * Handles session_start and session_end WebSocket messages.
 */
import { expandPath, findCliPath, validateOrCreateFolder } from '../utils.js';
export async function handleSessionStart(data, deps) {
    const { config, wsManager, pluginManager, cliSessions, sessionMetadata, cliPaths } = deps;
    console.log(`Starting session ${data.sessionId} (CLI: ${data.cliType}, Plugin: ${data.plugin || 'default'})`);
    let cliPath;
    // Handle terminal/generic type - just use the default shell
    if (data.cliType === 'terminal' || data.cliType === 'generic') {
        // Use the user's default shell or fallback to bash
        cliPath = process.env.SHELL || '/bin/bash';
        console.log(`[SessionStart] Using shell: ${cliPath}`);
    }
    else {
        // Detect AI CLI path
        cliPath = cliPaths[data.cliType];
        if (!cliPath) {
            // Try fallback detection
            try {
                const detected = await findCliPath(data.cliType, config.cliSearchPaths);
                if (detected) {
                    cliPaths[data.cliType] = detected;
                    cliPath = detected;
                }
            }
            catch (e) {
                console.error('Failed to detect CLI paths:', e);
            }
        }
        if (!cliPath) {
            console.error(`${data.cliType} CLI not found on runner`);
            return;
        }
    }
    // Resolve working directory
    const rawPath = data.folderPath || process.cwd();
    const cwd = expandPath(rawPath, config.defaultWorkspace);
    console.log(`[SessionStart] Received request for session ${data.sessionId}`);
    console.log(`[SessionStart] CWD: ${cwd}`);
    // Validate folder
    const validation = validateOrCreateFolder(cwd, data.create);
    if (!validation.exists) {
        console.error(`[SessionStart] ${validation.error}`);
        wsManager.send({
            type: 'output',
            data: {
                runnerId: wsManager.runnerId,
                sessionId: data.sessionId,
                content: `❌ Error: ${validation.error}`,
                outputType: 'error',
                timestamp: new Date().toISOString()
            }
        });
        return;
    }
    console.log(`[SessionStart] Folder exists! Proceeding...`);
    try {
        console.log(`[SessionStart] Initializing PluginManager...`);
        if (!pluginManager) {
            console.error('PluginManager not initialized!');
            return;
        }
        const session = await pluginManager.createSession({
            cliPath,
            cwd,
            sessionId: data.sessionId,
            cliType: data.cliType,
            options: {
                skipPermissions: false,
                continueConversation: true
            }
        }, data.plugin);
        console.log(`Session ${data.sessionId} created with ${data.plugin || 'default'} plugin`);
        // Store session and metadata
        cliSessions.set(data.sessionId, session);
        sessionMetadata.set(data.sessionId, {
            sessionId: data.sessionId,
            cliType: data.cliType,
            plugin: data.plugin,
            folderPath: data.folderPath,
            runnerId: data.runnerId
        });
        // Notify when ready
        let sentReady = false;
        const notifyReady = () => {
            if (sentReady)
                return;
            sentReady = true;
            wsManager.send({
                type: 'session_ready',
                data: {
                    runnerId: wsManager.runnerId,
                    sessionId: data.sessionId
                }
            });
            console.log(`Sent session_ready for ${data.sessionId}`);
        };
        if (session.isReady) {
            notifyReady();
        }
        else {
            console.log(`Waiting for session ${data.sessionId} to be ready...`);
            session.once('ready', () => {
                console.log(`Session ${data.sessionId} is now ready (event detected)!`);
                notifyReady();
            });
            // Fallback timeout
            setTimeout(() => {
                if (!sentReady) {
                    console.log(`Session readiness timeout for ${data.sessionId}. Sending ready signal anyway.`);
                    notifyReady();
                }
            }, config.sessionReadyTimeout);
        }
    }
    catch (error) {
        console.error('Error creating session:', error);
        wsManager.send({
            type: 'output',
            data: {
                runnerId: wsManager.runnerId,
                sessionId: data.sessionId,
                content: `Error: ${error instanceof Error ? error.message : String(error)}`,
                timestamp: new Date().toISOString(),
                outputType: 'error'
            }
        });
    }
}
export async function handleSessionEnd(data, deps) {
    const { cliSessions, sessionMetadata, pendingMessages } = deps;
    console.log(`Session ended: ${data.sessionId}`);
    // Close CLI session properly
    const sessionToClose = cliSessions.get(data.sessionId);
    if (sessionToClose) {
        await sessionToClose.close();
    }
    cliSessions.delete(data.sessionId);
    sessionMetadata.delete(data.sessionId);
    pendingMessages.delete(data.sessionId);
    console.log(`Session ${data.sessionId} cleaned up`);
}
