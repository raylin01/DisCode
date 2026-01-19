#!/usr/bin/env bun
/**
 * DisCode Approval Handler
 *
 * This script is called by Claude Code's PreToolUse hook.
 * It receives tool usage info via stdin and sends an approval
 * request to the local Runner Agent, which then forwards it
 * to the Discord bot for user approval.
 */

// Read hook input from stdin (Claude Code provides JSON via stdin)
const hookInput = await Bun.stdin.text();

let data;

try {
  data = JSON.parse(hookInput);
} catch (error) {
  console.error('Failed to parse hook input:', error);
  // If we can't parse input, deny by default for safety
  console.log(JSON.stringify({
    permissionDecision: 'deny',
    systemMessage: 'DisCode: Failed to parse hook input'
  }));
  process.exit(1);
}

const { tool_name, tool_input, session_id } = data;

// Prepare approval request
const request = {
  toolName: tool_name,
  toolInput: tool_input,
  sessionId: session_id,
  timestamp: new Date().toISOString()
};

// Get runner agent URL from environment or use default
const RUNNER_AGENT_URL = process.env.DISCORDE_RUNNER_URL || 'http://localhost:3122';

// Send approval request to runner agent
async function requestApproval() {
  try {
    const response = await fetch(`${RUNNER_AGENT_URL}/approval`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request),
      // Add timeout - approval shouldn't take forever
      signal: AbortSignal.timeout(30000), // 30 second timeout
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const result = await response.json();

    return {
      permissionDecision: result.allow ? 'allow' : 'deny',
      systemMessage: result.message || '',
      modifiedToolInput: result.modifiedToolInput
    };

  } catch (error) {
    // If we can't reach the runner agent, we need to decide what to do
    console.error('DisCode: Failed to contact runner agent:', error);

    // For now, deny if we can't reach the agent (safe default)
    // In production, this could be configurable
    return {
      permissionDecision: 'deny',
      systemMessage: `DisCode: Cannot reach runner agent at ${RUNNER_AGENT_URL}. Is the DisCode runner running?`
    };
  }
}

// Request approval and output decision
const response = await requestApproval();

// Output the decision to Claude Code (via stdout)
console.log(JSON.stringify(response));
