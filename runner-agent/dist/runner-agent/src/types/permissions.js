export const PERMISSION_SCOPES = {
    session: {
        scope: "session",
        label: "this session",
        description: "Permission lasts for this session only"
    },
    localSettings: {
        scope: "localSettings",
        label: "this project (just you)",
        description: "Saves to .claude/settings.local.json (gitignored)"
    },
    userSettings: {
        scope: "userSettings",
        label: "all projects",
        description: "Saves to ~/.claude/settings.json (global)"
    },
    projectSettings: {
        scope: "projectSettings",
        label: "this project (shared)",
        description: "Saves to .claude/settings.json (not gitignored)"
    }
};
