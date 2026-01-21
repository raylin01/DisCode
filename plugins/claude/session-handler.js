#!/usr/bin/env bun
/**
 * DisCode Session Handler
 *
 * This script is called by Claude Code's SessionStart and SessionEnd hooks.
 * It notifies the Runner Agent about session lifecycle events.
 */

// Get the action from command line argument (start or end)
const action = process.argv[2];

if (!action || !['start', 'end'].includes(action)) {
  console.error('Usage: session-handler.js <start|end>');
  process.exit(1);
}

// Read hook input from stdin
const hookInput = await Bun.stdin.text();

let data;

try {
  data = JSON.parse(hookInput);
} catch (error) {
  console.error('Failed to parse hook input:', error);
  process.exit(1);
}

const { session_id, transcript_path } = data;

// Prepare session event
const event = {
  action,
  sessionId: session_id,
  timestamp: new Date().toISOString(),
  transcriptPath: transcript_path
};

// Get runner agent URL from environment or use default
const RUNNER_AGENT_URL = process.env.DISCODE_RUNNER_URL || 'http://localhost:3122';

// Send session event to runner agent
async function sendSessionEvent() {
  try {
    const response = await fetch(`${RUNNER_AGENT_URL}/session-event`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(5000), // 5 second timeout
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    // Session events are fire-and-forget, we don't need a response
    console.error(`DisCode: Session ${action} event sent successfully`);

  } catch (error) {
    // Log but don't fail - session events are optional
    console.error(`DisCode: Failed to send session ${action} event:`, error);
  }
}

// Send the event
await sendSessionEvent();

// Return empty response (Claude doesn't expect anything for session hooks)
console.log(JSON.stringify({}));
