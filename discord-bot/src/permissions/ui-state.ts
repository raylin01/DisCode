import type { PermissionScope } from '../../../runner-agent/src/types/permissions.js';

/**
 * UI state for a permission request
 * Tracks the current scope selection and provides helper methods
 */
export class PermissionUIState {
  private _scope: PermissionScope = 'session';

  constructor(initialScope: PermissionScope = 'session') {
    this._scope = initialScope;
  }

  get scope(): PermissionScope {
    return this._scope;
  }

  get scopeLabel(): string {
    const labels: Record<PermissionScope, string> = {
      session: 'this session',
      localSettings: 'this project (just you)',
      userSettings: 'all projects',
      projectSettings: 'this project (shared)'
    };
    return labels[this._scope];
  }

  get scopeDescription(): string {
    const descriptions: Record<PermissionScope, string> = {
      session: 'Permission lasts for this session only',
      localSettings: 'Saves to .claude/settings.local.json (gitignored)',
      userSettings: 'Saves to ~/.claude/settings.json (global)',
      projectSettings: 'Saves to .claude/settings.json (not gitignored)'
    };
    return descriptions[this._scope];
  }

  /**
   * Cycle to the next scope in the sequence:
   * localSettings → userSettings → projectSettings → session → repeat
   */
  cycleScope(): PermissionScope {
    const scopes: PermissionScope[] = [
      'localSettings',
      'userSettings',
      'projectSettings',
      'session'
    ];
    const currentIndex = scopes.indexOf(this._scope);
    this._scope = scopes[(currentIndex + 1) % scopes.length];
    return this._scope;
  }

  /**
   * Set a specific scope
   */
  setScope(scope: PermissionScope): void {
    this._scope = scope;
  }
}

/**
 * Build "Always" button text based on suggestions and current scope
 */
export function buildAlwaysButtonText(
  suggestions: any[],
  scope: PermissionScope
): string {
  if (!suggestions || suggestions.length === 0) {
    return `Always (for ${new PermissionUIState(scope).scopeLabel})`;
  }

  // Parse suggestions to count tools and directories
  const tools = new Set<string>();
  let directoryCount = 0;

  for (const suggestion of suggestions) {
    if (suggestion.type === 'addRules' && Array.isArray(suggestion.rules)) {
      for (const rule of suggestion.rules) {
        if (rule.toolName) {
          tools.add(rule.toolName);
        }
      }
    } else if (suggestion.type === 'addDirectories' && Array.isArray(suggestion.directories)) {
      directoryCount += suggestion.directories.length;
    }
  }

  const scopeLabel = new PermissionUIState(scope).scopeLabel;

  // Build button text based on what's being allowed
  if (directoryCount > 0) {
    return `Yes, allow access to ${directoryCount} director${directoryCount === 1 ? 'y' : 'ies'} for ${scopeLabel}`;
  }

  const toolList = Array.from(tools);
  if (toolList.length === 0) {
    return `Yes, always allow for ${scopeLabel}`;
  } else if (toolList.length === 1) {
    return `Yes, allow <${toolList[0]}> for ${scopeLabel}`;
  } else if (toolList.length === 2) {
    return `Yes, allow <${toolList[0]}> and <${toolList[1]}> for ${scopeLabel}`;
  } else {
    return `Yes, allow <${toolList[0]}> and ${toolList.length - 1} more for ${scopeLabel}`;
  }
}
