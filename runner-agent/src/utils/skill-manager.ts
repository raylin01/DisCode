
import fs from 'fs/promises';
import path from 'path';
import { constants } from 'fs';

export class SkillManager {
    private runnerRoot: string;

    constructor(runnerRoot: string) {
        this.runnerRoot = runnerRoot;
    }

    /**
     * Installs skills into the session's workspace
     */
    /**
     * Installs skills into the session's workspace
     */
    async installSkills(cwd: string, cliType: 'claude' | 'gemini', excludedSkills: string[] = []): Promise<void> {
        const skillsRoot = path.join(this.runnerRoot, 'resources', 'skills');

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

                // Target path depends on CLI type
                const skillDirName = cliType === 'claude' ? '.claude' : '.gemini';
                const targetPath = path.join(cwd, skillDirName, 'skills', skillName);

                try {
                    // Create target directory
                    await fs.mkdir(targetPath, { recursive: true });

                    // Copy SKILL.md
                    if (await this.fileExists(path.join(sourcePath, 'SKILL.md'))) {
                        // Read, replace bin path, and write
                        let skillContent = await fs.readFile(path.join(sourcePath, 'SKILL.md'), 'utf8');

                        // Setup bin path for this skill
                        const targetBin = path.join(targetPath, 'bin');

                        // Replace generic placeholder with actual path
                        skillContent = skillContent.replace(/\/path\/to\/bin/g, targetBin);

                        await fs.writeFile(path.join(targetPath, 'SKILL.md'), skillContent);
                    }

                    // Copy bin directory (scripts)
                    const sourceBin = path.join(sourcePath, 'bin');
                    if (await this.directoryExists(sourceBin)) {
                        const targetBin = path.join(targetPath, 'bin');
                        await fs.mkdir(targetBin, { recursive: true });

                        const scripts = await fs.readdir(sourceBin);
                        for (const script of scripts) {
                            const srcFile = path.join(sourceBin, script);
                            const destFile = path.join(targetBin, script);
                            await fs.copyFile(srcFile, destFile);

                            // Make executable
                            await fs.chmod(destFile, 0o755);
                        }
                    }

                    // Copy instruction files (CLAUDE.md / GEMINI.md)
                    // Logic: If there is an ASSISTANT.md and we are installing for an assistant session...
                    // But here we don't know if it's an assistant session.
                    // We can check if 'thread-spawning' skill has special handling?
                    // Actually, the excludedSkills logic handles the "which skills" part.
                    // The "which instructions" part is tricky.
                    // For now, let's just stick to copying CLAUDE.md/GEMINI.md if present.
                    // But wait, thread-spawning/ASSISTANT.md was part of the plan.

                    const instructionFile = cliType === 'claude' ? 'CLAUDE.md' : 'GEMINI.md';
                    const sourceInstruction = path.join(sourcePath, instructionFile);

                    if (await this.fileExists(sourceInstruction)) {
                        const targetInstruction = path.join(cwd, instructionFile);
                        try {
                            await fs.access(targetInstruction);
                            // console.log(`[SkillManager] ${instructionFile} already exists in ${cwd}, skipping.`);
                        } catch {
                            try {
                                await fs.copyFile(sourceInstruction, targetInstruction);
                                console.log(`[SkillManager] Copied ${instructionFile} for ${skillName}`);
                            } catch (copyErr) {
                                console.warn(`[SkillManager] Failed to copy instruction file:`, copyErr);
                            }
                        }
                    }

                    // Special handling for ASSISTANT.md (if this is the thread-spawning skill)
                    // If we see ASSISTANT.md, should we append it to CLAUDE.md?
                    // Or let the system prompt handle it?
                    // The plan said "Special instructions ONLY for the main assistant session".
                    // The assistant session WILL have 'thread-spawning' skill.
                    // So we can copy ASSISTANT.md content into CLAUDE.md if it exists?
                    // NO, let's keep it simple for now and rely on SKILL.md being enough.
                    // The implementation plan had ASSISTANT.md but I haven't implemented logic to use it yet.

                    console.log(`[SkillManager] Installed ${skillName} skill`);

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
