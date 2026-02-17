/**
 * Interaction Lock Utilities
 *
 * Provides file-based locking to prevent duplicate interaction handling
 * across multiple bot instances or restarts.
 */

import fs from 'fs';
import path from 'path';

const STORAGE_PATH = process.env.DISCODE_STORAGE_PATH || './data';
const INTERACTION_LOCK_DIR = path.join(STORAGE_PATH, 'interaction-locks');
const INTERACTION_LOCK_TTL_MS = parseInt(process.env.DISCODE_INTERACTION_LOCK_TTL_MS || '900000');

let lastInteractionLockCleanup = 0;

/**
 * Ensures the interaction lock directory exists
 */
export function ensureInteractionLockDir(): void {
  if (!fs.existsSync(INTERACTION_LOCK_DIR)) {
    fs.mkdirSync(INTERACTION_LOCK_DIR, { recursive: true });
  }
}

/**
 * Cleans up expired interaction lock files
 * @param nowMs - Current timestamp in milliseconds
 */
export function cleanupInteractionLocks(nowMs: number): void {
  if (nowMs - lastInteractionLockCleanup < 60000) return;
  lastInteractionLockCleanup = nowMs;

  try {
    ensureInteractionLockDir();
    const files = fs.readdirSync(INTERACTION_LOCK_DIR);
    for (const file of files) {
      if (!file.endsWith('.lock')) continue;
      const lockPath = path.join(INTERACTION_LOCK_DIR, file);
      try {
        const stat = fs.statSync(lockPath);
        if (nowMs - stat.mtimeMs > INTERACTION_LOCK_TTL_MS) {
          fs.unlinkSync(lockPath);
        }
      } catch {
        // Ignore per-file cleanup failures.
      }
    }
  } catch {
    // Ignore cleanup failures to avoid breaking interaction flow.
  }
}

/**
 * Attempts to claim an interaction lock to prevent duplicate handling
 * @param interactionId - The Discord interaction ID
 * @returns true if the lock was successfully claimed, false if already locked
 */
export function tryClaimInteraction(interactionId: string): boolean {
  const nowMs = Date.now();
  cleanupInteractionLocks(nowMs);

  try {
    ensureInteractionLockDir();
    const lockPath = path.join(INTERACTION_LOCK_DIR, `${interactionId}.lock`);
    fs.writeFileSync(lockPath, String(nowMs), { flag: 'wx' });
    return true;
  } catch (error: any) {
    if (error?.code === 'EEXIST') {
      return false;
    }
    console.error('[Interaction] Failed to claim interaction lock:', error);
    // Fail open so a lock issue doesn't block bot behavior.
    return true;
  }
}
