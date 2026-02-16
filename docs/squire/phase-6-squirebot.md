# Phase 6: SquireBot (Discord Bot)

**Goal:** Create a standalone Discord bot for personal use that interfaces with the Squire package.

## Overview

SquireBot is a **single-user** Discord bot that provides:
- Simple `/listen` command to create workspaces in channels
- `/dm` command for private workspace via DM
- Message handling with Squire integration
- Lightweight configuration (single token)

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                       SQUIREBOT                                  │
│                   (Discord Bot Process)                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  Commands   │  │  Handlers   │  │    Config   │              │
│  │  /listen    │  │  Messages   │  │  (Simple)   │              │
│  │  /dm        │  │  Buttons    │  │             │              │
│  │  /status    │  │  Reactions  │  │             │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
│         │                │                │                      │
│         └────────────────┼────────────────┘                      │
│                          ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    WORKSPACE BRIDGE                          ││
│  │  - Maps Discord channels/DMs to Squire workspaces            ││
│  │  - Routes messages to appropriate workspace                  ││
│  └─────────────────────────────────────────────────────────────┘│
│                          │                                       │
│                          ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                       SQUIRE                                 ││
│  │                 (Agent Package)                              ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Project Structure

```
squire-bot/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts              # Entry point
│   ├── config.ts             # Configuration
│   ├── client.ts             # Discord client setup
│   ├── commands/
│   │   ├── index.ts          # Command loader
│   │   ├── listen.ts         # /listen command
│   │   ├── dm.ts             # /dm command
│   │   ├── status.ts         # /status command
│   │   └── remember.ts       # /remember command
│   ├── handlers/
│   │   ├── message.ts        # Message handler
│   │   └── interaction.ts    # Button/select handlers
│   ├── workspace-bridge.ts   # Discord <-> Squire bridge
│   └── utils/
│       └── embeds.ts         # Embed helpers
└── tests/
```

## package.json

```json
{
  "name": "@discode/squire-bot",
  "version": "0.1.0",
  "description": "Personal AI assistant Discord bot",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "tsc",
    "start": "node dist/index.js",
    "dev": "node --watch dist/index.js"
  },
  "dependencies": {
    "discord.js": "^14.0.0",
    "@discode/squire": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "typescript": "^5.0.0"
  }
}
```

## Configuration (config.ts)

```typescript
import fs from 'fs';
import path from 'path';
import os from 'os';

export interface SquireBotConfig {
  // Discord
  token: string;
  applicationId: string;

  // Squire
  squireId: string;
  squireName: string;
  dataDir: string;

  // Behavior
  prefix?: string;
  allowedGuilds?: string[];
  allowedUsers?: string[];  // If set, only these users can interact

  // Features
  daemonMode: boolean;
  autoListen: boolean;  // Auto-create workspace when joining channel
}

const DEFAULT_CONFIG: Partial<SquireBotConfig> = {
  squireName: 'Squire',
  dataDir: path.join(os.homedir(), '.squire', 'data'),
  daemonMode: true,
  autoListen: false
};

export function loadConfig(): SquireBotConfig {
  const configPath = path.join(os.homedir(), '.squire', 'config.json');

  if (!fs.existsSync(configPath)) {
    console.error(`Config file not found: ${configPath}`);
    console.error(`Run 'squire-bot init' to create a config file`);
    process.exit(1);
  }

  const fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

  return {
    ...DEFAULT_CONFIG,
    ...fileConfig
  } as SquireBotConfig;
}

export function createDefaultConfig(token: string, applicationId: string): void {
  const configDir = path.join(os.homedir(), '.squire');
  const configPath = path.join(configDir, 'config.json');

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const config: SquireBotConfig = {
    token,
    applicationId,
    squireId: `squire-${Date.now()}`,
    squireName: 'Squire',
    dataDir: path.join(configDir, 'data'),
    daemonMode: true,
    autoListen: false
  };

  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  console.log(`Created config at: ${configPath}`);
}
```

## Entry Point (index.ts)

```typescript
import { Client, GatewayIntentBits, Events, REST, Routes } from 'discord.js';
import { loadConfig, createDefaultConfig } from './config.js';
import { Squire } from '@discode/squire';
import { WorkspaceBridge } from './workspace-bridge.js';
import { setupCommands } from './commands/index.js';
import { setupHandlers } from './handlers/index.js';

const args = process.argv.slice(2);

// Handle init command
if (args[0] === 'init') {
  const token = args.find(a => a.startsWith('--token='))?.split('=')[1];
  const appId = args.find(a => a.startsWith('--app-id='))?.split('=')[1];

  if (!token || !appId) {
    console.error('Usage: squire-bot init --token=YOUR_TOKEN --app-id=YOUR_APP_ID');
    process.exit(1);
  }

  createDefaultConfig(token, appId);
  process.exit(0);
}

// Load config and start
const config = loadConfig();

// Initialize Squire
const squire = new Squire({
  squireId: config.squireId,
  name: config.squireName,
  dataDir: config.dataDir,
  daemonMode: config.daemonMode
});

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ]
});

// Workspace bridge
const bridge = new WorkspaceBridge(squire, config);

// Setup commands and handlers
const commands = setupCommands(client, squire, bridge, config);
setupHandlers(client, squire, bridge, config);

// Register commands on ready
client.once(Events.ClientReady, async (readyClient) => {
  console.log(`[SquireBot] Logged in as ${readyClient.user.tag}`);

  // Start Squire
  await squire.start();
  console.log(`[SquireBot] Squire started`);

  // Register commands
  const rest = new REST().setToken(config.token);

  try {
    await rest.put(
      Routes.applicationCommands(config.applicationId),
      { body: commands }
    );
    console.log(`[SquireBot] Registered ${commands.length} commands`);
  } catch (error) {
    console.error('[SquireBot] Failed to register commands:', error);
  }
});

// Login
client.login(config.token);
```

## Commands

### listen.ts
```typescript
import { SlashCommandBuilder, CommandInteraction, EmbedBuilder } from 'discord.js';
import type { Squire } from '@discode/squire';
import type { WorkspaceBridge } from '../workspace-bridge.js';
import type { SquireBotConfig } from '../config.js';

export const command = new SlashCommandBuilder()
  .setName('listen')
  .setDescription('Start listening to this channel')
  .addStringOption(option =>
    option.setName('name')
      .setDescription('Optional name for this workspace')
      .setRequired(false)
  );

export async function execute(
  interaction: CommandInteraction,
  squire: Squire,
  bridge: WorkspaceBridge,
  config: SquireBotConfig
): Promise<void> {
  // Check permissions if restricted
  if (config.allowedUsers && !config.allowedUsers.includes(interaction.user.id)) {
    await interaction.reply({
      content: 'You are not authorized to use this bot.',
      ephemeral: true
    });
    return;
  }

  const channel = interaction.channel;
  if (!channel) {
    await interaction.reply({
      content: 'Cannot determine channel.',
      ephemeral: true
    });
    return;
  }

  const name = interaction.options.get('name')?.value as string || channel.id;

  // Create workspace
  const workspace = bridge.createChannelWorkspace(channel.id, name);

  const embed = new EmbedBuilder()
    .setTitle(`🎯 Now Listening: ${name}`)
    .setDescription(`I'm now active in this channel!\n\nYou can talk to me directly and I'll remember our conversations.`)
    .setColor('Green')
    .addFields({
      name: 'Commands',
      value: '`/status` - Check my status\n`/remember <fact>` - Store a memory\n`/dm` - Start a private conversation',
      inline: false
    })
    .setTimestamp();

  await interaction.reply({ embeds: [embed] });
}
```

### dm.ts
```typescript
import { SlashCommandBuilder, CommandInteraction, EmbedBuilder } from 'discord.js';
import type { Squire } from '@discode/squire';
import type { WorkspaceBridge } from '../workspace-bridge.js';
import type { SquireBotConfig } from '../config.js';

export const command = new SlashCommandBuilder()
  .setName('dm')
  .setDescription('Start a private conversation via DM');

export async function execute(
  interaction: CommandInteraction,
  squire: Squire,
  bridge: WorkspaceBridge,
  config: SquireBotConfig
): Promise<void> {
  // Check permissions
  if (config.allowedUsers && !config.allowedUsers.includes(interaction.user.id)) {
    await interaction.reply({
      content: 'You are not authorized to use this bot.',
      ephemeral: true
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });

  // Create DM workspace
  const workspace = bridge.createDMWorkspace(interaction.user.id);

  // Send DM
  const user = interaction.user;
  const dm = await user.createDM();

  const embed = new EmbedBuilder()
    .setTitle(`👋 Hello!`)
    .setDescription(`I'm ${config.squireName}, your personal assistant.\n\nThis is our private workspace. Anything we discuss here is remembered across all our conversations.`)
    .setColor('Blue')
    .setTimestamp();

  await dm.send({ embeds: [embed] });

  await interaction.editReply({
    content: `I've started a DM with you! Check your messages.`
  });
}
```

### status.ts
```typescript
import { SlashCommandBuilder, CommandInteraction, EmbedBuilder } from 'discord.js';
import type { Squire } from '@discode/squire';
import type { WorkspaceBridge } from '../workspace-bridge.js';
import type { SquireBotConfig } from '../config.js';

export const command = new SlashCommandBuilder()
  .setName('status')
  .setDescription('Check Squire status');

export async function execute(
  interaction: CommandInteraction,
  squire: Squire,
  bridge: WorkspaceBridge,
  config: SquireBotConfig
): Promise<void> {
  const workspaces = squire.getWorkspaces();
  const activeWorkspaces = workspaces.filter(w => w.status === 'active');
  const skills = squire.getSkills();
  const memories = await squire.recall('anything', 1);

  const embed = new EmbedBuilder()
    .setTitle(`📊 ${config.squireName} Status`)
    .setColor('Blue')
    .addFields(
      { name: 'Workspaces', value: `${activeWorkspaces.length} active / ${workspaces.length} total`, inline: true },
      { name: 'Skills', value: `${skills.length} loaded`, inline: true },
      { name: 'Memory', value: memories.length > 0 ? 'Active' : 'Empty', inline: true },
      { name: 'Mode', value: config.daemonMode ? 'Daemon' : 'Session', inline: true }
    )
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
```

### remember.ts
```typescript
import { SlashCommandBuilder, CommandInteraction, EmbedBuilder } from 'discord.js';
import type { Squire } from '@discode/squire';
import type { WorkspaceBridge } from '../workspace-bridge.js';
import type { SquireBotConfig } from '../config.js';

export const command = new SlashCommandBuilder()
  .setName('remember')
  .setDescription('Store a fact in memory')
  .addStringOption(option =>
    option.setName('fact')
      .setDescription('The fact to remember')
      .setRequired(true)
  );

export async function execute(
  interaction: CommandInteraction,
  squire: Squire,
  bridge: WorkspaceBridge,
  config: SquireBotConfig
): Promise<void> {
  const fact = interaction.options.get('fact')?.value as string;

  await squire.remember(fact, { source: 'user' });

  const embed = new EmbedBuilder()
    .setTitle('🧠 Remembered')
    .setDescription(`I'll remember: "${fact}"`)
    .setColor('Green')
    .setTimestamp();

  await interaction.reply({ embeds: [embed], ephemeral: true });
}
```

## Workspace Bridge (workspace-bridge.ts)

```typescript
import type { Squire, Workspace } from '@discode/squire';
import type { SquireBotConfig } from './config.js';

export class WorkspaceBridge {
  private squire: Squire;
  private config: SquireBotConfig;

  constructor(squire: Squire, config: SquireBotConfig) {
    this.squire = squire;
    this.config = config;
  }

  createChannelWorkspace(channelId: string, name?: string): Workspace {
    const existing = this.squire.getWorkspaceBySource('discord_channel', channelId);
    if (existing) {
      return existing;
    }

    return this.squire.createWorkspace({
      name: name || `Channel: ${channelId}`,
      source: 'discord_channel',
      sourceId: channelId
    });
  }

  createDMWorkspace(userId: string): Workspace {
    const existing = this.squire.getWorkspaceBySource('discord_dm', userId);
    if (existing) {
      return existing;
    }

    return this.squire.createWorkspace({
      name: `DM: ${userId}`,
      source: 'discord_dm',
      sourceId: userId
    });
  }

  getWorkspaceForChannel(channelId: string): Workspace | undefined {
    return this.squire.getWorkspaceBySource('discord_channel', channelId);
  }

  getWorkspaceForDM(userId: string): Workspace | undefined {
    return this.squire.getWorkspaceBySource('discord_dm', userId);
  }

  async handleMessage(sourceId: string, sourceType: 'channel' | 'dm', content: string): Promise<string> {
    const source = sourceType === 'channel' ? 'discord_channel' : 'discord_dm';
    let workspace = this.squire.getWorkspaceBySource(source, sourceId);

    if (!workspace) {
      // Auto-create if configured
      if (this.config.autoListen) {
        workspace = sourceType === 'channel'
          ? this.createChannelWorkspace(sourceId)
          : this.createDMWorkspace(sourceId);
      } else {
        return 'I\'m not listening here yet. Use `/listen` to start a conversation.';
      }
    }

    const message = await this.squire.sendMessage(workspace.workspaceId, content);
    return message.content;
  }
}
```

## Message Handler (handlers/message.ts)

```typescript
import { Events, Message } from 'discord.js';
import type { Squire } from '@discode/squire';
import type { WorkspaceBridge } from '../workspace-bridge.js';
import type { SquireBotConfig } from '../config.js';

export function setupMessageHandler(
  client: any,
  squire: Squire,
  bridge: WorkspaceBridge,
  config: SquireBotConfig
): void {
  client.on(Events.MessageCreate, async (message: Message) => {
    // Ignore bot messages
    if (message.author.bot) return;

    // Check permissions
    if (config.allowedUsers && !config.allowedUsers.includes(message.author.id)) {
      return;
    }

    // Determine source type
    const isDM = message.channel.type === 1; // DM

    if (isDM) {
      // Handle DM
      await handleDM(message, squire, bridge);
    } else {
      // Handle channel message (only if bot is mentioned or workspace exists)
      await handleChannelMessage(message, squire, bridge, config);
    }
  });
}

async function handleDM(message: Message, squire: Squire, bridge: WorkspaceBridge): Promise<void> {
  try {
    const response = await bridge.handleMessage(
      message.author.id,
      'dm',
      message.content
    );

    await message.reply(response);
  } catch (error) {
    console.error('[SquireBot] Error handling DM:', error);
    await message.reply('Sorry, I encountered an error. Please try again.');
  }
}

async function handleChannelMessage(
  message: Message,
  squire: Squire,
  bridge: WorkspaceBridge,
  config: SquireBotConfig
): Promise<void> {
  const channelId = message.channelId;

  // Check if workspace exists
  const workspace = bridge.getWorkspaceForChannel(channelId);
  if (!workspace) return; // Not listening here

  // Check if bot is mentioned or replied to
  const botMentioned = message.mentions.users.has(message.client.user.id);
  const isReply = message.reference?.messageId;

  if (!botMentioned && !isReply) {
    // Still process but indicate it's passive
    // This allows squire to observe conversations
    return;
  }

  try {
    // Remove mention from content
    let content = message.content.replace(/<@!?\d+>/g, '').trim();

    const response = await bridge.handleMessage(channelId, 'channel', content);
    await message.reply(response);
  } catch (error) {
    console.error('[SquireBot] Error handling channel message:', error);
    await message.reply('Sorry, I encountered an error. Please try again.');
  }
}
```

## Running SquireBot

```bash
# Install
npm install -g @discode/squire-bot

# Initialize (first time)
squire-bot init --token=YOUR_DISCORD_BOT_TOKEN --app-id=YOUR_APP_ID

# Start
squire-bot

# Development
cd squire-bot
npm run dev
```

## Docker Deployment

```dockerfile
FROM node:20-slim

WORKDIR /app

COPY package*.json ./
COPY dist/ ./dist/

RUN npm install --production

CMD ["node", "dist/index.js"]
```

```yaml
# docker-compose.yml
version: '3.8'
services:
  squire-bot:
    build: .
    restart: unless-stopped
    volumes:
      - ~/.squire:/root/.squire
```

## Testing

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { WorkspaceBridge } from '../dist/workspace-bridge.js';
import { Squire } from '@discode/squire';

test('Creates channel workspace', async () => {
  const squire = new Squire({ squireId: 'test', dataDir: '/tmp/squire-test' });
  await squire.start();

  const bridge = new WorkspaceBridge(squire, {} as any);

  const workspace = bridge.createChannelWorkspace('channel-123', 'Test Channel');
  assert.ok(workspace.workspaceId);
  assert.strictEqual(workspace.source, 'discord_channel');

  // Same channel returns same workspace
  const workspace2 = bridge.createChannelWorkspace('channel-123', 'Different Name');
  assert.strictEqual(workspace.workspaceId, workspace2.workspaceId);

  await squire.stop();
});
```

## Next Phase

- **Phase 7**: DisCode Integration - runner-agent plugin
