import fs from "fs";
import path from "path";
import os from "os";

async function removeHooks() {
    console.log("🧹 Cleaning up conflicting DisCode Hooks...");

    const homeDir = os.homedir();
    const claudeConfigPath = path.join(homeDir, ".claude", "config.json");

    if (!fs.existsSync(claudeConfigPath)) {
        console.log("   No Claude config found, nothing to clean.");
        return;
    }

    let config = {};
    try {
        const content = fs.readFileSync(claudeConfigPath, "utf8");
        config = JSON.parse(content);
    } catch (e) {
        console.error("❌ Failed to parse Claude config:", e);
        return;
    }

    if (!config.commands || !Array.isArray(config.commands)) {
        console.log("   No commands configured, nothing to clean.");
        return;
    }

    const initialCount = config.commands.length;

    // Filter out any commands that point to discode-hook.sh
    // Use a loose match on the filename in case the path varies
    config.commands = config.commands.filter((cmd) => {
        if (!cmd.command) return true;
        return !cmd.command.includes("discode-hook.sh");
    });

    const finalCount = config.commands.length;
    const removedCount = initialCount - finalCount;

    if (removedCount > 0) {
        console.log(`  Updating ${claudeConfigPath}...`);
        fs.writeFileSync(claudeConfigPath, JSON.stringify(config, null, 2));
        console.log(`✅ Removed ${removedCount} conflicting hook(s).`);
    } else {
        console.log("   No conflicting hooks found.");
    }
}

removeHooks().catch(console.error);
