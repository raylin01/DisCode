/**
 * Interrupt Handler
 *
 * Handles interrupt requests from Discord to stop CLI execution.
 */
export async function handleInterrupt(data, deps) {
    const { sessionId } = data;
    const { cliSessions } = deps;
    console.log(`[Interrupt] Received interrupt request for session ${sessionId}`);
    const session = cliSessions.get(sessionId);
    if (!session) {
        console.error(`[Interrupt] Session not found: ${sessionId}`);
        return;
    }
    try {
        // If the session has an interrupt method, use it
        if ('interrupt' in session && typeof session.interrupt === 'function') {
            await session.interrupt();
            console.log(`[Interrupt] Sent interrupt to session ${sessionId}`);
        }
        else {
            // Fallback: Send Escape key sequence to try to cancel
            // This works for many CLI tools
            session.sendMessage('\x03'); // Ctrl+C character
            console.log(`[Interrupt] Sent Ctrl+C fallback to session ${sessionId}`);
        }
    }
    catch (error) {
        console.error(`[Interrupt] Failed to interrupt session ${sessionId}:`, error);
    }
}
