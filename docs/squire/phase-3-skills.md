# Phase 3: Skills System

**Goal:** Implement a skills system with YAML frontmatter, auto-installation, and eligibility filtering.

## Overview

Skills are markdown files with YAML frontmatter that provide instructions and capabilities to Squire. The system supports:

- **YAML frontmatter** for metadata
- **Auto-installation** of skill dependencies (brew, npm, go, uv)
- **Eligibility filtering** based on platform and environment
- **Priority loading** from multiple directories

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     SKILL MANAGER                                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │ Frontmatter │  │ Installation│  │ Eligibility │              │
│  │   Parser    │  │   Manager   │  │   Filter    │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
│         │                │                │                      │
│         └────────────────┼────────────────┘                      │
│                          ▼                                       │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │                    SKILL LOADER                              ││
│  │  Load from (in priority order):                             ││
│  │  1. ~/.squire/skills/        (User skills - highest)        ││
│  │  2. .agents/skills/          (Project skills)               ││
│  │  3. bundled/                 (Bundled skills - lowest)      ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Files to Create

```
squire/src/skills/
├── manager.ts              # Main SkillManager class
├── frontmatter.ts          # YAML frontmatter parser
├── installer.ts            # Dependency installer
├── eligibility.ts          # Platform/env eligibility
├── loader.ts               # Multi-source skill loader
├── types.ts                # Skill-specific types
└── bundled/                # Default bundled skills
    ├── browser/SKILL.md
    ├── memory/SKILL.md
    ├── web/SKILL.md
    ├── github/SKILL.md
    └── discord/SKILL.md
```

## Skill Format (SKILL.md)

```markdown
---
name: browser
description: "Browser automation for web interaction"
version: "1.0.0"
author: "Squire"
userInvocable: true
disableModelInvocation: false
metadata:
  squire:
    emoji: "🌐"
    requires:
      bins: ["chromium"]
      env: []
    install:
      - type: brew
        package: chromium
---
# Browser Skill

Browse the web, take screenshots, fill forms, and click elements.

## Capabilities

- Navigate to URLs
- Take screenshots of pages
- Click elements
- Type text into inputs
- Extract page content

## Usage

When the user asks you to:
- Browse a website
- Check something on the web
- Fill out a form
- Take a screenshot

Use the browser tools to accomplish the task.

## Best Practices

1. Always wait for page loads
2. Take screenshots to verify state
3. Handle popups and dialogs gracefully
```

## Frontmatter Parser (frontmatter.ts)

```typescript
import yaml from 'yaml';
import type { SkillFrontmatter } from '../types.js';

const FRONTMATTER_REGEX = /^---\s*\n([\s\S]*?)\n---\s*\n/;

export interface ParsedSkill {
  frontmatter: SkillFrontmatter;
  content: string;
}

export function parseSkillFrontmatter(markdown: string): ParsedSkill {
  const match = markdown.match(FRONTMATTER_REGEX);

  if (!match) {
    return {
      frontmatter: {},
      content: markdown.trim()
    };
  }

  const frontmatterYaml = match[1];
  const content = markdown.slice(match[0].length).trim();

  try {
    const parsed = yaml.parse(frontmatterYaml) as SkillFrontmatter;
    return {
      frontmatter: parsed || {},
      content
    };
  } catch (error) {
    console.warn('[Skills] Failed to parse frontmatter:', error);
    return {
      frontmatter: {},
      content
    };
  }
}

export function validateFrontmatter(frontmatter: SkillFrontmatter): string[] {
  const errors: string[] = [];

  if (frontmatter.metadata?.squire?.install) {
    for (const step of frontmatter.metadata.squire.install) {
      if (!step.type || !step.package) {
        errors.push(`Invalid install step: ${JSON.stringify(step)}`);
      }

      if (!['brew', 'npm', 'go', 'uv', 'download'].includes(step.type)) {
        errors.push(`Unknown install type: ${step.type}`);
      }
    }
  }

  return errors;
}
```

## Eligibility Filter (eligibility.ts)

```typescript
import { execSync } from 'child_process';
import process from 'process';
import type { SkillFrontmatter } from '../types.js';

export interface EligibilityResult {
  eligible: boolean;
  reason?: string;
  missingBins: string[];
  missingEnv: string[];
}

export function checkEligibility(frontmatter: SkillFrontmatter): EligibilityResult {
  const requires = frontmatter.metadata?.squire?.requires;

  if (!requires) {
    return { eligible: true, missingBins: [], missingEnv: [] };
  }

  const missingBins: string[] = [];
  const missingEnv: string[] = [];

  // Check required binaries
  if (requires.bins) {
    for (const bin of requires.bins) {
      if (!isBinaryAvailable(bin)) {
        missingBins.push(bin);
      }
    }
  }

  // Check required environment variables
  if (requires.env) {
    for (const envVar of requires.env) {
      if (!process.env[envVar]) {
        missingEnv.push(envVar);
      }
    }
  }

  const eligible = missingBins.length === 0 && missingEnv.length === 0;
  const reason = eligible ? undefined : buildReason(missingBins, missingEnv);

  return { eligible, reason, missingBins, missingEnv };
}

function isBinaryAvailable(bin: string): boolean {
  try {
    execSync(`which ${bin}`, { stdio: 'ignore' });
    return true;
  } catch {
    // Check common paths
    const commonPaths = [
      '/usr/local/bin',
      '/usr/bin',
      '/opt/homebrew/bin',
      path.join(os.homedir(), '.local/bin'),
      path.join(os.homedir(), 'go/bin')
    ];

    for (const p of commonPaths) {
      if (fs.existsSync(path.join(p, bin))) {
        return true;
      }
    }

    return false;
  }
}

function buildReason(missingBins: string[], missingEnv: string[]): string {
  const parts: string[] = [];

  if (missingBins.length > 0) {
    parts.push(`Missing binaries: ${missingBins.join(', ')}`);
  }

  if (missingEnv.length > 0) {
    parts.push(`Missing env vars: ${missingEnv.join(', ')}`);
  }

  return parts.join('; ');
}

// Platform helpers
export function getPlatform(): 'darwin' | 'linux' | 'windows' {
  switch (process.platform) {
    case 'darwin': return 'darwin';
    case 'linux': return 'linux';
    case 'win32': return 'windows';
    default: return 'linux';
  }
}

export function isMacOS(): boolean {
  return process.platform === 'darwin';
}

export function isLinux(): boolean {
  return process.platform === 'linux';
}

export function isWindows(): boolean {
  return process.platform === 'win32';
}
```

## Dependency Installer (installer.ts)

```typescript
import { exec } from 'child_process';
import { promisify } from 'util';
import type { SkillInstallStep } from '../types.js';

const execAsync = promisify(exec);

export class SkillInstaller {
  private installed: Set<string> = new Set();

  async install(steps: SkillInstallStep[]): Promise<{
    success: boolean;
    installed: string[];
    failed: string[];
    errors: string[];
  }> {
    const installed: string[] = [];
    const failed: string[] = [];
    const errors: string[] = [];

    for (const step of steps) {
      const key = `${step.type}:${step.package}`;

      if (this.installed.has(key)) {
        continue;
      }

      try {
        await this.installStep(step);
        installed.push(step.package);
        this.installed.add(key);
      } catch (error) {
        failed.push(step.package);
        errors.push(`${step.package}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    return {
      success: failed.length === 0,
      installed,
      failed,
      errors
    };
  }

  private async installStep(step: SkillInstallStep): Promise<void> {
    console.log(`[Installer] Installing ${step.package} via ${step.type}...`);

    switch (step.type) {
      case 'brew':
        await this.installBrew(step.package);
        break;
      case 'npm':
        await this.installNpm(step.package, step.version);
        break;
      case 'go':
        await this.installGo(step.package, step.version);
        break;
      case 'uv':
        await this.installUv(step.package, step.version);
        break;
      case 'download':
        await this.download(step.package);
        break;
      default:
        throw new Error(`Unknown install type: ${step.type}`);
    }

    console.log(`[Installer] Installed ${step.package}`);
  }

  private async installBrew(packageName: string): Promise<void> {
    await execAsync(`brew install ${packageName}`);
  }

  private async installNpm(packageName: string, version?: string): Promise<void> {
    const spec = version ? `${packageName}@${version}` : packageName;
    await execAsync(`npm install -g ${spec}`);
  }

  private async installGo(packageName: string, version?: string): Promise<void> {
    const spec = version ? `${packageName}@${version}` : packageName;
    await execAsync(`go install ${spec}`);
  }

  private async installUv(packageName: string, version?: string): Promise<void> {
    const spec = version ? `${packageName}==${version}` : packageName;
    await execAsync(`uv pip install ${spec}`);
  }

  private async download(url: string): Promise<void> {
    // Download and install from URL
    // This is a simplified implementation
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Download failed: ${response.statusText}`);
    }
    // TODO: Handle different file types (zip, tar, binary)
  }
}
```

## Skill Loader (loader.ts)

```typescript
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { Skill, SkillsConfig } from '../types.js';
import { parseSkillFrontmatter } from './frontmatter.js';
import { checkEligibility } from './eligibility.js';

export interface SkillSource {
  path: string;
  priority: number; // Higher = more important
  name: string;
}

export class SkillLoader {
  private config: SkillsConfig;
  private sources: SkillSource[] = [];

  constructor(config: SkillsConfig, dataDir: string) {
    this.config = config;

    // Define sources in priority order
    this.sources = [
      // User skills (highest priority)
      {
        path: path.join(os.homedir(), '.squire', 'skills'),
        priority: 100,
        name: 'user'
      },
      // Project skills
      {
        path: path.join(process.cwd(), '.agents', 'skills'),
        priority: 50,
        name: 'project'
      },
      // Bundled skills (lowest priority)
      {
        path: path.join(dataDir, 'bundled'),
        priority: 10,
        name: 'bundled'
      }
    ];

    // Add additional skill directories from config
    for (const additionalPath of config.additional) {
      this.sources.push({
        path: additionalPath,
        priority: 75,
        name: 'additional'
      });
    }
  }

  loadAllSkills(): Skill[] {
    const skills = new Map<string, Skill>(); // name -> skill

    // Load from all sources (lower priority first, so higher priority overwrites)
    const sortedSources = [...this.sources].sort((a, b) => a.priority - b.priority);

    for (const source of sortedSources) {
      if (!fs.existsSync(source.path)) {
        continue;
      }

      const sourceSkills = this.loadFromDirectory(source.path);

      for (const skill of sourceSkills) {
        // Higher priority sources override lower priority
        skills.set(skill.name, skill);
      }
    }

    // Filter to only bundled skills if specified
    if (this.config.bundled.length > 0) {
      const bundledSet = new Set(this.config.bundled);

      for (const [name, skill] of skills) {
        if (!bundledSet.has(name) && skill.path.includes('bundled')) {
          skills.delete(name);
        }
      }
    }

    return Array.from(skills.values());
  }

  private loadFromDirectory(dir: string): Skill[] {
    const skills: Skill[] = [];

    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = path.join(dir, entry.name);
      const skillFile = path.join(skillDir, 'SKILL.md');

      if (!fs.existsSync(skillFile)) {
        continue;
      }

      try {
        const skill = this.loadSkill(skillFile);
        skills.push(skill);
      } catch (error) {
        console.warn(`[Skills] Failed to load ${skillFile}:`, error);
      }
    }

    return skills;
  }

  private loadSkill(skillPath: string): Skill {
    const markdown = fs.readFileSync(skillPath, 'utf-8');
    const { frontmatter, content } = parseSkillFrontmatter(markdown);
    const eligibility = checkEligibility(frontmatter);

    const name = frontmatter.name || path.basename(path.dirname(skillPath));

    return {
      name,
      description: frontmatter.description || '',
      path: skillPath,
      frontmatter,
      content,
      eligible: eligibility.eligible,
      eligibilityReason: eligibility.reason
    };
  }
}
```

## Skill Manager (manager.ts)

```typescript
import type { Skill, SkillsConfig } from '../types.js';
import { SkillLoader } from './loader.js';
import { SkillInstaller } from './installer.js';

export class SkillManager {
  private config: SkillsConfig;
  private loader: SkillLoader;
  private installer: SkillInstaller;
  private skills: Map<string, Skill> = new Map();

  constructor(config: SkillsConfig, dataDir: string) {
    this.config = config;
    this.loader = new SkillLoader(config, dataDir);
    this.installer = new SkillInstaller();
  }

  async loadSkills(): Promise<void> {
    const loaded = this.loader.loadAllSkills();

    // Auto-install dependencies if enabled
    if (this.config.autoInstall) {
      await this.installDependencies(loaded);
    }

    // Store skills
    this.skills.clear();
    for (const skill of loaded) {
      this.skills.set(skill.name, skill);
    }

    console.log(`[Skills] Loaded ${this.skills.size} skills`);
  }

  private async installDependencies(skills: Skill[]): Promise<void> {
    const toInstall: SkillInstallStep[] = [];

    for (const skill of skills) {
      const install = skill.frontmatter.metadata?.squire?.install;
      if (install) {
        toInstall.push(...install);
      }
    }

    if (toInstall.length === 0) {
      return;
    }

    console.log(`[Skills] Installing ${toInstall.length} dependencies...`);

    const result = await this.installer.install(toInstall);

    if (result.failed.length > 0) {
      console.warn(`[Skills] Failed to install: ${result.failed.join(', ')}`);
    }

    // Re-check eligibility after installation
    for (const skill of skills) {
      const eligibility = checkEligibility(skill.frontmatter);
      skill.eligible = eligibility.eligible;
      skill.eligibilityReason = eligibility.reason;
    }
  }

  getSkills(): Skill[] {
    return Array.from(this.skills.values());
  }

  getEligibleSkills(): Skill[] {
    return this.getSkills().filter(s => s.eligible);
  }

  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  buildSystemPrompt(): string {
    const eligible = this.getEligibleSkills();

    if (eligible.length === 0) {
      return '';
    }

    const parts: string[] = ['# Skills Available\n'];

    for (const skill of eligible) {
      parts.push(`## ${skill.frontmatter.metadata?.squire?.emoji || '📋'} ${skill.name}`);
      parts.push(skill.content);
      parts.push('');
    }

    return parts.join('\n');
  }
}
```

## Bundled Skills

### browser/SKILL.md
```markdown
---
name: browser
description: "Browser automation for web interaction"
userInvocable: true
metadata:
  squire:
    emoji: "🌐"
    requires:
      bins: []
---
# Browser Skill

Interact with web pages using the browser tools.

## Available Tools
- `browser_navigate` - Go to a URL
- `browser_screenshot` - Take a screenshot
- `browser_click` - Click an element
- `browser_type` - Type text into an input
- `browser_snapshot` - Get page accessibility tree

## Usage

When asked to browse the web, check a website, or interact with web forms, use these tools.
```

### memory/SKILL.md
```markdown
---
name: memory
description: "Store and retrieve information across sessions"
userInvocable: true
metadata:
  squire:
    emoji: "🧠"
---
# Memory Skill

Remember and recall information across conversations.

## Commands
- "Remember this: [fact]"
- "What do you know about [topic]?"
- "Forget about [topic]"

## Tools
- `memory_remember` - Store a fact
- `memory_recall` - Search memories
- `memory_forget` - Remove memories

## How It Works
Memories are stored with vector embeddings for semantic search.
```

### web/SKILL.md
```markdown
---
name: web
description: "Search the web for current information"
userInvocable: true
metadata:
  squire:
    emoji: "🔍"
---
# Web Search Skill

Search the web for current information and answers.

## Usage
When you need up-to-date information that may not be in your training data, search the web.

## Tools
- `web_search` - Search for information
- `web_reader` - Read and extract content from URLs
```

### github/SKILL.md
```markdown
---
name: github
description: "Interact with GitHub repositories"
userInvocable: true
metadata:
  squire:
    emoji: "🐙"
    requires:
      env: ["GITHUB_TOKEN"]
---
# GitHub Skill

Interact with GitHub repositories, issues, and pull requests.

## Capabilities
- Read repository structure
- Search code
- Read file contents
- Create issues and PRs (with permission)

## Tools
- `github_get_repo_structure`
- `github_read_file`
- `github_search`
```

### discord/SKILL.md
```markdown
---
name: discord
description: "Discord integration for messaging"
userInvocable: true
metadata:
  squire:
    emoji: "💬"
---
# Discord Skill

Send messages and interact with Discord channels.

## Capabilities
- Send messages to channels
- Send DMs
- Create embeds
- Update channel names

## Tools
- `discord_send_message`
- `discord_send_dm`
- `discord_update_channel`
```

## Dependencies

```json
{
  "dependencies": {
    "yaml": "^2.3.0"
  }
}
```

## Testing

```typescript
import { test } from 'node:test';
import assert from 'node:assert';
import { parseSkillFrontmatter } from '../dist/skills/frontmatter.js';
import { checkEligibility } from '../dist/skills/eligibility.js';

test('Parses skill frontmatter', () => {
  const markdown = `---
name: test-skill
description: "A test skill"
metadata:
  squire:
    emoji: "🧪"
---
# Test Skill

This is the skill content.`;

  const { frontmatter, content } = parseSkillFrontmatter(markdown);

  assert.strictEqual(frontmatter.name, 'test-skill');
  assert.strictEqual(frontmatter.description, 'A test skill');
  assert.ok(content.includes('# Test Skill'));
});

test('Checks eligibility', () => {
  const frontmatter = {
    metadata: {
      squire: {
        requires: {
          bins: ['nonexistent-binary-xyz'],
          env: []
        }
      }
    }
  };

  const result = checkEligibility(frontmatter);
  assert.strictEqual(result.eligible, false);
  assert.ok(result.missingBins.includes('nonexistent-binary-xyz'));
});
```

## Next Phase

- **Phase 4**: Scheduler for daemon mode
