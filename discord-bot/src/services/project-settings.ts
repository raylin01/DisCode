/**
 * Project Settings Storage
 *
 * Manages per-project default settings that override runner defaults.
 * Stored in ./data/project-settings.yaml
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { ProjectSettings, ProjectConfig } from '../../../shared/types.js';

const STORAGE_PATH = process.env.DISCODE_STORAGE_PATH || './data';
const PROJECT_SETTINGS_FILE = path.join(STORAGE_PATH, 'project-settings.yaml');

class ProjectSettingsStore {
  private data: Record<string, ProjectSettings> = {};

  constructor() {
    this.ensureDirectories();
    this.load();
  }

  private ensureDirectories(): void {
    if (!fs.existsSync(STORAGE_PATH)) {
      fs.mkdirSync(STORAGE_PATH, { recursive: true });
    }
  }

  private load(): void {
    try {
      if (fs.existsSync(PROJECT_SETTINGS_FILE)) {
        const fileData = fs.readFileSync(PROJECT_SETTINGS_FILE, 'utf-8');
        this.data = yaml.load(fileData) as Record<string, ProjectSettings> || {};
      }
    } catch (error) {
      console.error('[ProjectSettings] Error loading:', error);
      this.data = {};
    }
  }

  private save(): void {
    try {
      const yamlStr = yaml.dump(this.data);
      fs.writeFileSync(PROJECT_SETTINGS_FILE, yamlStr, 'utf-8');
    } catch (error) {
      console.error('[ProjectSettings] Error saving:', error);
    }
  }

  /**
   * Generate a unique key for storing project settings
   */
  getKey(runnerId: string, projectPath: string): string {
    return `${runnerId}:${projectPath}`;
  }

  /**
   * Get project settings by runner ID and path
   */
  get(runnerId: string, projectPath: string): ProjectSettings | null {
    const key = this.getKey(runnerId, projectPath);
    return this.data[key] || null;
  }

  /**
   * Get just the config portion (defaults to empty object)
   */
  getConfig(runnerId: string, projectPath: string): ProjectConfig {
    const settings = this.get(runnerId, projectPath);
    return settings?.config || {};
  }

  /**
   * Set project settings (replaces entire config)
   */
  set(runnerId: string, projectPath: string, config: ProjectConfig): void {
    const key = this.getKey(runnerId, projectPath);
    const existing = this.data[key];

    this.data[key] = {
      projectPath,
      runnerId,
      config,
      createdAt: existing?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    this.save();
  }

  /**
   * Update specific fields in project config (merges with existing)
   */
  update(runnerId: string, projectPath: string, updates: Partial<ProjectConfig>): void {
    const existing = this.get(runnerId, projectPath);
    const mergedConfig: ProjectConfig = {
      ...(existing?.config || {}),
      ...updates
    };

    // Remove undefined values
    for (const key in mergedConfig) {
      if (mergedConfig[key as keyof ProjectConfig] === undefined) {
        delete mergedConfig[key as keyof ProjectConfig];
      }
    }

    this.set(runnerId, projectPath, mergedConfig);
  }

  /**
   * Delete project settings
   */
  delete(runnerId: string, projectPath: string): boolean {
    const key = this.getKey(runnerId, projectPath);
    if (this.data[key]) {
      delete this.data[key];
      this.save();
      return true;
    }
    return false;
  }

  /**
   * Check if project has any custom settings
   */
  hasOverrides(runnerId: string, projectPath: string): boolean {
    const config = this.getConfig(runnerId, projectPath);
    return Object.keys(config).length > 0;
  }

  /**
   * List all project settings for a runner
   */
  listByRunner(runnerId: string): ProjectSettings[] {
    return Object.values(this.data).filter(s => s.runnerId === runnerId);
  }

  /**
   * Get all project settings
   */
  getAll(): Record<string, ProjectSettings> {
    return { ...this.data };
  }

  /**
   * Clear all settings for a runner (e.g., when runner is deleted)
   */
  clearByRunner(runnerId: string): number {
    let count = 0;
    for (const key in this.data) {
      if (this.data[key].runnerId === runnerId) {
        delete this.data[key];
        count++;
      }
    }
    if (count > 0) {
      this.save();
    }
    return count;
  }
}

export const projectSettingsStore = new ProjectSettingsStore();
export { ProjectSettingsStore };
