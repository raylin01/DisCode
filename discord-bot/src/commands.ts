/**
 * Slash Command Definitions
 *
 * Contains all Discord slash command builders and registration logic.
 */

import { REST, Routes, SlashCommandBuilder, SlashCommandOptionsOnlyBuilder } from 'discord.js';
import { getConfig } from './config.js';

const config = getConfig();
const DISCORD_TOKEN = config.discordToken;
const DISCORD_CLIENT_ID = config.discordClientId;

/**
 * Returns an array of all slash command definitions
 */
export function getCommandDefinitions(): (SlashCommandBuilder | SlashCommandOptionsOnlyBuilder)[] {
  return [
    new SlashCommandBuilder()
      .setName('generate-token')
      .setDescription('Generate a token for Runner Agent authentication'),

    new SlashCommandBuilder()
      .setName('list-runners')
      .setDescription('List all your runners'),

    new SlashCommandBuilder()
      .setName('my-access')
      .setDescription('Show all runners you can access (owned + shared)'),

    new SlashCommandBuilder()
      .setName('list-access')
      .setDescription('Show users who have access to your runners')
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID to check (leave empty to see all)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('create-session')
      .setDescription('Create a new CLI session')
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID (leave empty to use first online)')
          .setRequired(false)
      )
      .addStringOption(option =>
        option.setName('cli')
          .setDescription('CLI type')
          .addChoices(
            { name: 'Claude Code', value: 'claude' },
            { name: 'Gemini CLI', value: 'gemini' },
            { name: 'Codex CLI', value: 'codex' }
          )
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('share-runner')
      .setDescription('Share a runner with another user')
      .addUserOption(option =>
        option.setName('user')
          .setDescription('User to share with')
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID to share')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('unshare-runner')
      .setDescription('Revoke access to a runner')
      .addUserOption(option =>
        option.setName('user')
          .setDescription('User to revoke from')
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('runner-status')
      .setDescription('Show detailed status of a runner')
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('runner-health')
      .setDescription('Get health info for a runner')
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('list-clis')
      .setDescription('List detected CLI paths for a runner')
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID (optional)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('runner-logs')
      .setDescription('Fetch recent runner logs (requires DISCODE_RUNNER_LOG_PATH)')
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID')
          .setRequired(true)
      ),

    new SlashCommandBuilder()
      .setName('status')
      .setDescription('List all active sessions and their status')
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Filter by runner ID (optional)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('action-items')
      .setDescription('Show action items from CLI sessions')
      .addStringOption(option =>
        option.setName('session')
          .setDescription('Session ID (leave empty to see all)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('end-session')
      .setDescription('End an active session (auto-detects from current thread/channel)')
      .addStringOption(option =>
        option.setName('session')
          .setDescription('Session ID (optional - auto-detects from current context if not provided)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('terminals')
      .setDescription('List available tmux terminals on a runner')
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID (optional)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('watch')
      .setDescription('Watch an existing tmux session')
      .addStringOption(option =>
        option.setName('session')
          .setDescription('Session ID to watch')
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID (optional)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('unwatch')
      .setDescription('Stop watching a tmux session')
      .addStringOption(option =>
        option.setName('session')
          .setDescription('Session ID (optional - auto-detects)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('interrupt')
      .setDescription('Interrupt the current CLI execution (send Ctrl+C)')
      .addStringOption(option =>
        option.setName('session')
          .setDescription('Session ID (optional - auto-detects from current thread)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('set-model')
      .setDescription('Set model for an SDK session')
      .addStringOption(option =>
        option.setName('model')
          .setDescription('Model name (e.g. claude-sonnet-4-5)')
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName('session')
          .setDescription('Session ID (optional - auto-detects from current thread)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('set-permission-mode')
      .setDescription('Set permission mode for an SDK session')
      .addStringOption(option =>
        option.setName('mode')
          .setDescription('Permission mode')
          .addChoices(
            { name: 'Default', value: 'default' },
            { name: 'Accept Edits', value: 'acceptEdits' }
          )
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName('session')
          .setDescription('Session ID (optional - auto-detects from current thread)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('set-thinking-tokens')
      .setDescription('Set max thinking tokens for a session (Claude SDK)')
      .addIntegerOption(option =>
        option.setName('max_tokens')
          .setDescription('Maximum thinking tokens')
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName('session')
          .setDescription('Session ID (optional - auto-detects from current thread)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('assistant')
      .setDescription('Send a message to the runner assistant')
      .addStringOption(option =>
        option.setName('message')
          .setDescription('Message to send to the assistant')
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID (optional - uses current channel runner)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('respawn-session')
      .setDescription('Respawn a dead session in this thread with the same settings'),

    new SlashCommandBuilder()
      .setName('sync-projects')
      .setDescription('Sync projects from ~/.claude/projects/ to Discord')
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID to sync (optional)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('sync-session')
      .setDescription('Sync full message history for a session')
      .addStringOption(option =>
        option.setName('session')
          .setDescription('Session ID (optional - auto-detects from current thread)')
          .setRequired(false)
      )
      .addStringOption(option =>
        option.setName('project')
          .setDescription('Project path (required if not in thread)')
          .setRequired(false)
      )
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID (required if not in thread)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('register-project')
      .setDescription('Manually register a project')
      .addStringOption(option =>
        option.setName('path')
          .setDescription('Full path to project folder')
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID (optional)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('resume')
      .setDescription('Resume a synced session or restart a previous session')
      .addStringOption(option =>
        option.setName('session')
          .setDescription('Session ID to resume (optional if in thread)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('codex-threads')
      .setDescription('List Codex threads available on a runner')
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID (optional)')
          .setRequired(false)
      )
      .addBooleanOption(option =>
        option.setName('archived')
          .setDescription('Include archived threads')
          .setRequired(false)
      )
      .addIntegerOption(option =>
        option.setName('limit')
          .setDescription('Max threads to display (default 10)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('resume-codex')
      .setDescription('Resume a Codex thread')
      .addStringOption(option =>
        option.setName('thread')
          .setDescription('Codex thread ID to resume')
          .setRequired(true)
      )
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID (optional)')
          .setRequired(false)
      )
      .addStringOption(option =>
        option.setName('cwd')
          .setDescription('Working directory override (optional)')
          .setRequired(false)
      ),

    new SlashCommandBuilder()
      .setName('delete-project')
      .setDescription('Delete a project and its channel')
      .addStringOption(option =>
        option.setName('path')
          .setDescription('Project path (optional if in project channel)')
          .setRequired(false)
      )
      .addStringOption(option =>
        option.setName('runner')
          .setDescription('Runner ID (optional)')
          .setRequired(false)
      )
      .addBooleanOption(option =>
        option.setName('all')
          .setDescription('Delete ALL projects for this runner')
          .setRequired(false)
      ),
  ];
}

/**
 * Registers all slash commands with Discord
 */
export async function registerCommands(): Promise<void> {
  const commands = getCommandDefinitions();
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

  try {
    if (config.guildId) {
      console.log(`Registering guild commands for ${config.guildId}...`);
      await rest.put(
        Routes.applicationGuildCommands(DISCORD_CLIENT_ID!, config.guildId),
        { body: commands }
      );
    } else {
      console.log('Registering global commands...');
      await rest.put(
        Routes.applicationCommands(DISCORD_CLIENT_ID!),
        { body: commands }
      );
    }
  } catch (error) {
    console.error('Error registering commands:', error);
  }
}
