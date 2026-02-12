import * as fs from 'fs/promises';
import * as path from 'path';
export class PermissionStore {
    rules = new Map();
    directories = new Set();
    permissionMode = 'default';
    sessionPermissions = [];
    projectDir;
    constructor(projectDir = process.cwd()) {
        this.projectDir = projectDir;
    }
    applySuggestions(suggestions, scope = 'session') {
        for (const suggestion of suggestions) {
            switch (suggestion.type) {
                case 'addRules':
                    for (const rule of suggestion.rules) {
                        this.addRule(rule, scope);
                    }
                    break;
                case 'addDirectories':
                    for (const dir of suggestion.directories) {
                        this.addDirectory(dir, scope);
                    }
                    break;
                case 'setMode':
                    this.setMode(suggestion.mode);
                    break;
            }
        }
    }
    addRule(rule, scope) {
        const existing = this.rules.get(rule.toolName) || [];
        existing.push(rule);
        this.rules.set(rule.toolName, existing);
        // Store for persistence
        if (scope !== 'session') {
            this.sessionPermissions.push({
                toolName: rule.toolName,
                ruleContent: rule.ruleContent,
                scope,
                createdAt: Date.now()
            });
        }
    }
    addDirectory(dir, scope) {
        this.directories.add(dir);
        // Store for persistence
        if (scope !== 'session') {
            this.sessionPermissions.push({
                toolName: 'directory',
                ruleContent: dir,
                scope,
                createdAt: Date.now()
            });
        }
    }
    setMode(mode) {
        this.permissionMode = mode;
    }
    // Check if tool is allowed
    isToolAllowed(toolName, input) {
        // If in acceptEdits mode, allow Edit and Write tools
        if (this.permissionMode === 'acceptEdits' && (toolName === 'Edit' || toolName === 'Write')) {
            return true;
        }
        // Check rules
        const toolRules = this.rules.get(toolName) || [];
        if (toolRules.length === 0) {
            return false; // No explicit permission
        }
        // Simple rule matching - can be enhanced
        for (const rule of toolRules) {
            if (this.matchesRule(toolName, input, rule.ruleContent)) {
                return true;
            }
        }
        return false;
    }
    matchesRule(toolName, input, ruleContent) {
        // Basic wildcard matching
        if (ruleContent === '*' || ruleContent === `${toolName}:*`) {
            return true;
        }
        // Command matching for Bash tool
        if (toolName === 'Bash' && ruleContent.startsWith('command:')) {
            const pattern = ruleContent.substring(8);
            const command = input?.command || '';
            if (pattern === '*') {
                return true;
            }
            if (pattern.includes('*')) {
                const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
                return regex.test(command);
            }
            return command === pattern;
        }
        // Path matching for file operations
        if (ruleContent.includes('/')) {
            const filePath = input?.file_path || input?.path || '';
            if (ruleContent.endsWith('/*')) {
                const prefix = ruleContent.substring(0, ruleContent.length - 2);
                return filePath.startsWith(prefix);
            }
            return filePath === ruleContent;
        }
        return false;
    }
    getPermissionMode() {
        return this.permissionMode;
    }
    getRules() {
        return new Map(this.rules);
    }
    getDirectories() {
        return new Set(this.directories);
    }
    // Save non-session permissions to file
    async savePermissions() {
        const nonSessionPermissions = this.sessionPermissions.filter(p => p.scope !== 'session');
        if (nonSessionPermissions.length === 0) {
            return;
        }
        // Group by scope
        const localSettings = nonSessionPermissions.filter(p => p.scope === 'localSettings');
        const userSettings = nonSessionPermissions.filter(p => p.scope === 'userSettings');
        const projectSettings = nonSessionPermissions.filter(p => p.scope === 'projectSettings');
        // Save to appropriate files
        if (localSettings.length > 0) {
            await this.saveToFile(localSettings, '.claude/settings.local.json');
        }
        if (userSettings.length > 0) {
            await this.saveToUserSettings(userSettings);
        }
        if (projectSettings.length > 0) {
            await this.saveToFile(projectSettings, '.claude/settings.json');
        }
    }
    async saveToFile(permissions, filename) {
        const filePath = path.join(this.projectDir, filename);
        // Create directory if it doesn't exist
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        // Read existing settings
        let existingSettings = {};
        try {
            const content = await fs.readFile(filePath, 'utf-8');
            existingSettings = JSON.parse(content);
        }
        catch {
            // File doesn't exist yet
        }
        // Convert permissions to tool rules format
        const toolRules = this.convertToToolRules(permissions);
        // Merge with existing
        existingSettings.toolRules = {
            ...existingSettings.toolRules,
            ...toolRules
        };
        // Write back
        await fs.writeFile(filePath, JSON.stringify(existingSettings, null, 2));
    }
    async saveToUserSettings(permissions) {
        const homeDir = process.env.HOME || process.env.USERPROFILE || '';
        if (!homeDir) {
            console.error('Could not determine home directory for user settings');
            return;
        }
        const filePath = path.join(homeDir, '.claude/settings.json');
        await this.saveToFile(permissions, filePath);
    }
    convertToToolRules(permissions) {
        const rules = {};
        for (const perm of permissions) {
            if (perm.toolName === 'directory') {
                continue; // Skip directory rules for now
            }
            if (!rules[perm.toolName]) {
                rules[perm.toolName] = [];
            }
            rules[perm.toolName].push(perm.ruleContent);
        }
        return rules;
    }
    // Load permissions from file on startup
    async loadPermissions() {
        const settingsFiles = [
            path.join(this.projectDir, '.claude/settings.json'),
            path.join(this.projectDir, '.claude/settings.local.json'),
            path.join(process.env.HOME || process.env.USERPROFILE || '', '.claude/settings.json')
        ];
        for (const filePath of settingsFiles) {
            try {
                const content = await fs.readFile(filePath, 'utf-8');
                const settings = JSON.parse(content);
                if (settings.toolRules) {
                    for (const [toolName, rules] of Object.entries(settings.toolRules)) {
                        if (Array.isArray(rules)) {
                            for (const rule of rules) {
                                if (typeof rule === 'string') {
                                    this.addRule({ toolName, ruleContent: rule }, 'session');
                                }
                            }
                        }
                    }
                }
                if (settings.permissionMode) {
                    this.setMode(settings.permissionMode);
                }
            }
            catch {
                // File doesn't exist or invalid JSON, skip
            }
        }
    }
    clearSessionPermissions() {
        // Remove all session-scoped permissions
        this.sessionPermissions = this.sessionPermissions.filter(p => p.scope !== 'session');
        // Clear in-memory rules and reload from persistent storage
        this.rules.clear();
        this.directories.clear();
        // Re-add non-session permissions
        for (const perm of this.sessionPermissions) {
            if (perm.toolName === 'directory') {
                this.directories.add(perm.ruleContent);
            }
            else {
                const existing = this.rules.get(perm.toolName) || [];
                existing.push({ toolName: perm.toolName, ruleContent: perm.ruleContent });
                this.rules.set(perm.toolName, existing);
            }
        }
    }
}
