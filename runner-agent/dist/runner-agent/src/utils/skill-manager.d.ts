export declare class SkillManager {
    private runnerRoot;
    constructor(runnerRoot: string);
    /**
     * Installs skills into the session's workspace
     */
    /**
     * Installs skills into the session's workspace
     */
    installSkills(cwd: string, cliType: 'claude' | 'gemini', excludedSkills?: string[]): Promise<void>;
    private fileExists;
    private directoryExists;
}
