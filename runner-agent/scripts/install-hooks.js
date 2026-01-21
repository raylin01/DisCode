
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function installHooks() {
  console.log('📦 Installing DisCode Hooks...');

  const homeDir = os.homedir();
  const discodeDir = path.join(homeDir, '.discode');
  const hooksDir = path.join(discodeDir, 'hooks');
  const claudeConfigPath = path.join(homeDir, '.claude', 'config.json');

  // 1. Create directory structure
  if (!fs.existsSync(hooksDir)) {
    console.log(`  mkdir ${hooksDir}`);
    fs.mkdirSync(hooksDir, { recursive: true });
  }

  // 2. Copy hook script
  const sourceScript = path.resolve(__dirname, '../../hooks/discode-hook.sh');
  const targetScript = path.join(hooksDir, 'discode-hook.sh');

  if (!fs.existsSync(sourceScript)) {
    console.error(`❌ Source script not found at ${sourceScript}`);
    process.exit(1);
  }

  console.log(`  cp ${sourceScript} -> ${targetScript}`);
  fs.copyFileSync(sourceScript, targetScript);
  try {
    fs.chmodSync(targetScript, '755'); // Make executable
  } catch (e) {
    console.warn(`  Warning: Could not chmod ${targetScript} (might be on Windows?)`);
  }

  // 3. Update Claude config
  if (!fs.existsSync(claudeConfigPath)) {
    console.warn(`⚠️  Claude config not found at ${claudeConfigPath}. Is Claude Code installed?`);
    console.log('   Creating empty config...');
    try {
        if (!fs.existsSync(path.dirname(claudeConfigPath))) {
            fs.mkdirSync(path.dirname(claudeConfigPath), { recursive: true });
        }
        fs.writeFileSync(claudeConfigPath, '{}');
    } catch (e) {
        console.error(`❌ Failed to create config file: ${e.message}`);
        return;
    }
  }

  let config = {};
  try {
    const content = fs.readFileSync(claudeConfigPath, 'utf8');
    config = JSON.parse(content);
  } catch (e) {
    console.error('❌ Failed to parse Claude config:', e);
    process.exit(1);
  }

  // Define the hooks we want to register
  // We register ALL available hooks to get maximum visibility
  const hooks = [
    'PreToolUse',
    'PostToolUse',
    'UserPrompt',
    'SessionStart',
    'SessionEnd' // Note: This might not be official yet but good to have if supported
  ];

  config.commands = config.commands || [];

  let addedCount = 0;
  for (const hookName of hooks) {
    // Check if we already have this hook registered to our script
    const existing = config.commands.find(c => c.type === hookName && c.command.includes('discode-hook.sh'));
    
    if (existing) {
      // Update command path just in case
      existing.command = targetScript;
    } else {
      // Add new hook
      config.commands.push({
        type: hookName,
        command: targetScript
      });
      addedCount++;
    }
  }

  console.log(`  Updating ${claudeConfigPath}...`);
  fs.writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2));

  console.log(`✅ Success! Added/Updated ${addedCount} hooks.`);
  console.log(`   DisCode bot will now receive real-time events from Claude.`);
}

installHooks().catch(console.error);
