import { Suggestion, ToolRule } from '../types/permissions.js';
export interface StoredPermission {
    toolName: string;
    ruleContent: string;
    scope: 'session' | 'localSettings' | 'userSettings' | 'projectSettings';
    createdAt: number;
}
export declare class PermissionStore {
    private rules;
    private directories;
    private permissionMode;
    private sessionPermissions;
    private projectDir;
    constructor(projectDir?: string);
    applySuggestions(suggestions: Suggestion[], scope?: 'session' | 'localSettings' | 'userSettings' | 'projectSettings'): void;
    private addRule;
    private addDirectory;
    private setMode;
    isToolAllowed(toolName: string, input: any): boolean;
    private matchesRule;
    getPermissionMode(): 'default' | 'acceptEdits';
    getRules(): Map<string, ToolRule[]>;
    getDirectories(): Set<string>;
    savePermissions(): Promise<void>;
    private saveToFile;
    private saveToUserSettings;
    private convertToToolRules;
    loadPermissions(): Promise<void>;
    clearSessionPermissions(): void;
}
