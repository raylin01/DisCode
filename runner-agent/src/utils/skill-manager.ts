
import fs from 'fs/promises';
import path from 'path';
import { constants } from 'fs';

export class SkillManager {
    private runnerRoot: string;

    constructor(runnerRoot: string) {
        this.runnerRoot = runnerRoot;
    }

    /**
     * Gets the path to the skills directory in runner-agent
     */
    getSkillsRoot(): string {
        return path.join(this.runnerRoot, 'resources', 'skills');
    }

    /**
     * Installs skills into the session's workspace
     * NOTE: This no longer copies script files. Instead, it sets up instruction files
     * that reference the scripts directly from the runner-agent directory.
     * The DISCODE_SKILLS_PATH environment variable should be set to allow scripts to be found.
     */
    async installSkills(cwd: string, cliType: 'claude' | 'gemini' | 'codex', excludedSkills: string[] = []): Promise<void> {
        const skillsRoot = this.getSkillsRoot();

        try {
            const skillDirs = await fs.readdir(skillsRoot);

            for (const skillName of skillDirs) {
                // Skip excluded skills
                if (excludedSkills.includes(skillName)) {
                    console.log(`[SkillManager] Skipping excluded skill: ${skillName}`);
                    continue;
                }

                const sourcePath = path.join(skillsRoot, skillName);

                // Skip if not a directory
                const stats = await fs.stat(sourcePath);
                if (!stats.isDirectory()) continue;

                // Target path for SKILL.md only (no bin copying)
                const skillDirName = cliType === 'claude' ? '.claude' : cliType === 'gemini' ? '.gemini' : '.codex';
                const targetPath = path.join(cwd, skillDirName, 'skills', skillName);

                try {
                    // Create target directory
                    await fs.mkdir(targetPath, { recursive: true });

                    // The actual bin path in runner-agent (not copied)
                    const runnerBinPath = path.join(sourcePath, 'bin');

                    // Copy SKILL.md with updated paths
                    if (await this.fileExists(path.join(sourcePath, 'SKILL.md'))) {
                        let skillContent = await fs.readFile(path.join(sourcePath, 'SKILL.md'), 'utf8');
                        // Replace generic placeholder with actual runner-agent path
                        skillContent = skillContent.replace(/\/path\/to\/bin/g, runnerBinPath);
                        await fs.writeFile(path.join(targetPath, 'SKILL.md'), skillContent);
                    }

                    // DO NOT copy bin directory anymore - scripts are used directly from runner-agent
                    // This prevents duplicate scripts and makes updates easier

                    // Copy instruction files (CLAUDE.md / GEMINI.md)
                    const instructionFile = cliType === 'claude' ? 'CLAUDE.md' : cliType === 'gemini' ? 'GEMINI.md' : null;
                    if (!instructionFile) {
                        continue;
                    }
                    const sourceInstruction = path.join(sourcePath, instructionFile);

                    if (await this.fileExists(sourceInstruction)) {
                        const targetInstruction = path.join(cwd, instructionFile);
                        try {
                            // Always update the instruction file to ensure paths are correct
                            // This is important because paths may change between sessions
                            let instructionContent = await fs.readFile(sourceInstruction, 'utf8');
                            instructionContent = instructionContent.replace(/\/path\/to\/bin/g, runnerBinPath);

                            // Check if file exists and compare content
                            let shouldWrite = true;
                            try {
                                const existingContent = await fs.readFile(targetInstruction, 'utf8');
                                // Only write if content has changed (paths updated)
                                shouldWrite = existingContent !== instructionContent;
                            } catch {
                                // File doesn't exist, need to write
                                shouldWrite = true;
                            }

                            if (shouldWrite) {
                                await fs.writeFile(targetInstruction, instructionContent);
                                console.log(`[SkillManager] Updated ${instructionFile} for ${skillName}`);
                            }
                        } catch (copyErr) {
                            console.warn(`[SkillManager] Failed to update instruction file:`, copyErr);
                        }
                    }

                    console.log(`[SkillManager] Installed ${skillName} skill (scripts at ${runnerBinPath})`);

                } catch (error) {
                    console.error(`[SkillManager] Failed to install skill ${skillName}:`, error);
                }
            }

        } catch (error) {
            console.error(`[SkillManager] Failed to install skills:`, error);
        }
    }

    private async fileExists(path: string): Promise<boolean> {
        try {
            await fs.access(path);
            return true;
        } catch {
            return false;
        }
    }

    private async directoryExists(path: string): Promise<boolean> {
        try {
            const stats = await fs.stat(path);
            return stats.isDirectory();
        } catch {
            return false;
        }
    }
}
