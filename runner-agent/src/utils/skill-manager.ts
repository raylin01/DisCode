
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
    async installSkills(cwd: string, cliType: 'claude' | 'gemini'): Promise<void> {
        const skillName = 'discord-integration';
        const sourcePath = path.join(this.runnerRoot, 'resources', 'skills', skillName);

        // Target path depends on CLI type
        const skillDirName = cliType === 'claude' ? '.claude' : '.gemini';
        const targetPath = path.join(cwd, skillDirName, 'skills', skillName);

        try {
            // Check if source exists
            await fs.access(sourcePath);

            // Create target directory
            await fs.mkdir(targetPath, { recursive: true });

            // Copy SKILL.md
            await fs.copyFile(
                path.join(sourcePath, 'SKILL.md'),
                path.join(targetPath, 'SKILL.md')
            );

            // Copy bin directory
            const sourceBin = path.join(sourcePath, 'bin');
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

            // Update SKILL.md to point to absolute paths? 
            // Better to use relative paths if possible, but the skill definition might need absolute paths 
            // if the tool execution context is weird.
            // For now, let's assume the user/AI runs the script from the bin folder or we update SKILL.md content.
            // Actually, the SKILL.md I wrote uses /path/to/bin generic path. I should probably replace it 
            // with the actual path in the copied file so the AI knows exactly what to run.

            // Copy instruction files
            // CLAUDE.md should go to the session root or .claude/
            // GEMINI.md should go to session root or .gemini/

            const instructionFile = cliType === 'claude' ? 'CLAUDE.md' : 'GEMINI.md';
            const sourceInstruction = path.join(sourcePath, instructionFile);

            // We'll place it in the session root (cwd) so it's picked up by the CLI immediately
            // But checking if it exists first to avoid overwriting user's own file?
            // User requested proactive behavior, so we might want to prioritize it or append.
            // For now, let's copy it to the .claude/.gemini root to avoid polluting the actual project root too much,
            // but for CLAUDE.md it usually looks in current dir.

            // Actually, best place is CWD/CLAUDE.md or CWD/.gemini/GEMINI.md
            // Let's put it in the hidden folder to strictly associate it with this session context if possible
            // OR put it in the skill directory and referenced?
            // "The CLAUDE.md file... automatically loading context... Place in ~/.claude or root of project."

            const targetInstruction = path.join(cwd, instructionFile);
            try {
                // simple check to avoid overwriting existing project configuration
                await fs.access(targetInstruction);
                console.log(`[SkillManager] ${instructionFile} already exists in ${cwd}, skipping overwrite.`);
            } catch {
                try {
                    await fs.copyFile(sourceInstruction, targetInstruction);
                    console.log(`[SkillManager] Copied ${instructionFile} to ${cwd}`);
                } catch (copyErr) {
                    console.warn(`[SkillManager] Failed to copy instruction file:`, copyErr);
                }
            }

            let skillContent = await fs.readFile(path.join(targetPath, 'SKILL.md'), 'utf8');
            skillContent = skillContent.replace(/\/path\/to\/bin/g, targetBin);
            await fs.writeFile(path.join(targetPath, 'SKILL.md'), skillContent);

            console.log(`[SkillManager] Installed ${skillName} skill to ${targetPath}`);

        } catch (error) {
            console.error(`[SkillManager] Failed to install skills:`, error);
        }
    }
}
