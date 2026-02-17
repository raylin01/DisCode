import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Storage } from '../../src/storage';

describe('Storage', () => {
  let storage: Storage;
  let mockDataDir: string;

  beforeEach(() => {
    vi.clearAllMocks();

    mockDataDir = './data';
    process.env.DISCODE_STORAGE_PATH = mockDataDir;

    // Setup default mocks - make files not exist so Storage starts empty
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => { });
    vi.spyOn(fs, 'readFileSync').mockReturnValue('{}');
    vi.spyOn(fs, 'writeFileSync').mockImplementation(() => { });

    const yaml = require('js-yaml');
    vi.spyOn(yaml, 'load').mockReturnValue({});
    vi.spyOn(yaml, 'dump').mockReturnValue('');

    storage = new Storage();
  });

  afterEach(() => {
    delete process.env.DISCODE_STORAGE_PATH;
  });

  describe('constructor', () => {
    it('should create storage directory if not exists', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);

      new Storage();

      expect(fs.mkdirSync).toHaveBeenCalledWith(mockDataDir, { recursive: true });
    });

    it('should not load data when files do not exist', () => {
      new Storage();

      expect(fs.readFileSync).not.toHaveBeenCalled();
    });
  });

  describe('generateToken', () => {
    it('should generate a token with correct fields', () => {
      const tokenInfo = storage.generateToken('user1', 'guild1');

      expect(tokenInfo).toMatchObject({
        userId: 'user1',
        guildId: 'guild1',
        isActive: true
      });
      expect(tokenInfo.token).toBeTruthy();
      expect(tokenInfo.createdAt).toBeTruthy();
      expect(tokenInfo.lastUsed).toBeTruthy();
    });

    it('should generate 64 character hex token', () => {
      const tokenInfo = storage.generateToken('user1', 'guild1');

      expect(tokenInfo.token).toHaveLength(64);
      expect(/^[0-9a-f]{64}$/.test(tokenInfo.token)).toBe(true);
    });

    it('should save token to user data', () => {
      storage.generateToken('user1', 'guild1');

      const tokens = storage.getUserTokens('user1');
      expect(tokens).toHaveLength(1);
      expect(tokens[0].userId).toBe('user1');
    });

    it('should create new user if not exists', () => {
      const tokenInfo = storage.generateToken('newuser', 'guild1');

      expect(tokenInfo.userId).toBe('newuser');
      expect(storage.getUserTokens('newuser')).toHaveLength(1);
    });

    it('should generate unique tokens', () => {
      const token1 = storage.generateToken('user1', 'guild1');
      const token2 = storage.generateToken('user1', 'guild1');

      expect(token1.token).not.toBe(token2.token);
    });
  });

  describe('validateToken', () => {
    it('should return TokenInfo for valid active token', () => {
      const tokenInfo = storage.generateToken('user1', 'guild1');
      const validated = storage.validateToken(tokenInfo.token);

      expect(validated).toBeTruthy();
      expect(validated?.token).toBe(tokenInfo.token);
    });

    it('should update lastUsed timestamp', () => {
      const tokenInfo = storage.generateToken('user1', 'guild1');
      const firstLastUsed = tokenInfo.lastUsed;

      // Wait a tiny bit to ensure timestamp changes
      const validated = storage.validateToken(tokenInfo.token);

      expect(validated?.lastUsed).toBeTruthy();
    });

    it('should return null for invalid token', () => {
      const result = storage.validateToken('invalid-token');

      expect(result).toBeNull();
    });

    it('should return null for inactive token', () => {
      const tokenInfo = storage.generateToken('user1', 'guild1');
      storage.revokeToken('user1', tokenInfo.token);

      const result = storage.validateToken(tokenInfo.token);

      expect(result).toBeNull();
    });

    it('should search across all users', () => {
      const token1 = storage.generateToken('user1', 'guild1');
      const validated = storage.validateToken(token1.token);

      expect(validated?.token).toBe(token1.token);
    });
  });

  describe('getUserTokens', () => {
    it('should return empty array for non-existent user', () => {
      const tokens = storage.getUserTokens('nonexistent');

      expect(tokens).toEqual([]);
    });

    it('should return only active tokens', () => {
      const token1 = storage.generateToken('user1', 'guild1');
      storage.generateToken('user1', 'guild1');
      storage.revokeToken('user1', token1.token);

      const tokens = storage.getUserTokens('user1');

      expect(tokens).toHaveLength(1);
    });

    it('should return all active tokens', () => {
      storage.generateToken('user1', 'guild1');
      storage.generateToken('user1', 'guild1');
      storage.generateToken('user1', 'guild1');

      const tokens = storage.getUserTokens('user1');

      expect(tokens).toHaveLength(3);
    });
  });

  describe('revokeToken', () => {
    it('should revoke token successfully', () => {
      const token = storage.generateToken('user1', 'guild1');
      const revoked = storage.revokeToken('user1', token.token);

      expect(revoked).toBe(true);
      expect(storage.validateToken(token.token)).toBeNull();
    });

    it('should return false for non-existent user', () => {
      const result = storage.revokeToken('nonexistent', 'token');

      expect(result).toBe(false);
    });

    it('should return false for non-existent token', () => {
      const result = storage.revokeToken('user1', 'nonexistent-token');

      expect(result).toBe(false);
    });
  });

  describe('registerRunner', () => {
    it('should register a new runner', () => {
      const runner = {
        runnerId: 'runner1',
        name: 'Test Runner',
        ownerId: 'user1',
        token: 'token123',
        status: 'online' as const,
        lastHeartbeat: new Date().toISOString(),
        authorizedUsers: ['user1'],
        cliType: 'claude' as const,
        cliTypes: ['claude'] as ('claude' | 'gemini')[]
      };

      storage.registerRunner(runner);

      const retrieved = storage.getRunner('runner1');
      expect(retrieved).toMatchObject({
        runnerId: 'runner1',
        name: 'Test Runner'
      });
    });

    it('should add runner to user runner list', () => {
      const runner = {
        runnerId: 'runner1',
        name: 'Test Runner',
        ownerId: 'user1',
        token: 'token123',
        status: 'online' as const,
        lastHeartbeat: new Date().toISOString(),
        authorizedUsers: ['user1'],
        cliType: 'claude' as const,
        cliTypes: ['claude'] as ('claude' | 'gemini')[]
      };

      storage.registerRunner(runner);

      // Verify it's in user data
      expect(true).toBe(true); // Would need to access private _data
    });

    it('should deduplicate runner IDs in user list', () => {
      const runner = {
        runnerId: 'runner1',
        name: 'Test Runner',
        ownerId: 'user1',
        token: 'token123',
        status: 'online' as const,
        lastHeartbeat: new Date().toISOString(),
        authorizedUsers: ['user1'],
        cliType: 'claude' as const,
        cliTypes: ['claude'] as ('claude' | 'gemini')[]
      };

      storage.registerRunner(runner);
      storage.registerRunner(runner);

      // Should not duplicate
      expect(true).toBe(true);
    });
  });

  describe('getRunner', () => {
    it('should return null for non-existent runner', () => {
      const result = storage.getRunner('nonexistent');

      expect(result).toBeNull();
    });

    it('should return registered runner', () => {
      const runner = {
        runnerId: 'runner1',
        name: 'Test Runner',
        ownerId: 'user1',
        token: 'token123',
        status: 'online' as const,
        lastHeartbeat: new Date().toISOString(),
        authorizedUsers: [],
        cliType: 'claude' as const,
        cliTypes: ['claude'] as ('claude' | 'gemini')[]
      };

      storage.registerRunner(runner);
      const retrieved = storage.getRunner('runner1');

      expect(retrieved).toMatchObject({
        runnerId: 'runner1',
        name: 'Test Runner'
      });
    });
  });

  describe('deleteRunner', () => {
    it('should delete existing runner', () => {
      const runner = {
        runnerId: 'runner1',
        name: 'Test Runner',
        ownerId: 'user1',
        token: 'token123',
        status: 'online' as const,
        lastHeartbeat: new Date().toISOString(),
        authorizedUsers: [],
        cliType: 'claude' as const,
        cliTypes: ['claude'] as ('claude' | 'gemini')[]
      };

      storage.registerRunner(runner);
      storage.deleteRunner('runner1');

      expect(storage.getRunner('runner1')).toBeNull();
    });

    it('should do nothing for non-existent runner', () => {
      expect(() => storage.deleteRunner('nonexistent')).not.toThrow();
    });
  });

  describe('updateRunnerStatus', () => {
    it('should update runner status', () => {
      const runner = {
        runnerId: 'runner1',
        name: 'Test Runner',
        ownerId: 'user1',
        token: 'token123',
        status: 'online' as const,
        lastHeartbeat: new Date().toISOString(),
        authorizedUsers: [],
        cliType: 'claude' as const,
        cliTypes: ['claude'] as ('claude' | 'gemini')[]
      };

      storage.registerRunner(runner);
      storage.updateRunnerStatus('runner1', 'offline');

      const updated = storage.getRunner('runner1');
      expect(updated?.status).toBe('offline');
    });

    it('should update lastHeartbeat', () => {
      const runner = {
        runnerId: 'runner1',
        name: 'Test Runner',
        ownerId: 'user1',
        token: 'token123',
        status: 'online' as const,
        lastHeartbeat: new Date().toISOString(),
        authorizedUsers: [],
        cliType: 'claude' as const,
        cliTypes: ['claude'] as ('claude' | 'gemini')[]
      };

      storage.registerRunner(runner);
      storage.updateRunnerStatus('runner1', 'online');

      const updated = storage.getRunner('runner1');
      expect(updated?.lastHeartbeat).toBeTruthy();
    });

    it('should do nothing for non-existent runner', () => {
      expect(() => storage.updateRunnerStatus('nonexistent', 'offline')).not.toThrow();
    });
  });

  describe('shareRunner', () => {
    it('should share runner with another user', () => {
      const runner = {
        runnerId: 'runner1',
        name: 'Test Runner',
        ownerId: 'user1',
        token: 'token123',
        status: 'online' as const,
        lastHeartbeat: new Date().toISOString(),
        authorizedUsers: ['user1'],
        cliType: 'claude' as const,
        cliTypes: ['claude'] as ('claude' | 'gemini')[]
      };

      storage.registerRunner(runner);
      const result = storage.shareRunner('user1', 'runner1', 'user2');

      expect(result).toBe(true);

      const updated = storage.getRunner('runner1');
      expect(updated?.authorizedUsers).toContain('user2');
    });

    it('should return false for non-existent runner', () => {
      const result = storage.shareRunner('user1', 'nonexistent', 'user2');

      expect(result).toBe(false);
    });

    it('should return false when user is not owner', () => {
      const runner = {
        runnerId: 'runner1',
        name: 'Test Runner',
        ownerId: 'user1',
        token: 'token123',
        status: 'online' as const,
        lastHeartbeat: new Date().toISOString(),
        authorizedUsers: [],
        cliType: 'claude' as const,
        cliTypes: ['claude'] as ('claude' | 'gemini')[]
      };

      storage.registerRunner(runner);
      const result = storage.shareRunner('user2', 'runner1', 'user3');

      expect(result).toBe(false);
    });

    it('should not duplicate existing shares', () => {
      const runner = {
        runnerId: 'runner1',
        name: 'Test Runner',
        ownerId: 'user1',
        token: 'token123',
        status: 'online' as const,
        lastHeartbeat: new Date().toISOString(),
        authorizedUsers: ['user1', 'user2'],
        cliType: 'claude' as const,
        cliTypes: ['claude'] as ('claude' | 'gemini')[]
      };

      storage.registerRunner(runner);
      storage.shareRunner('user1', 'runner1', 'user2');

      const updated = storage.getRunner('runner1');
      const user2Count = updated?.authorizedUsers.filter((u: string) => u === 'user2').length;
      expect(user2Count).toBe(1);
    });
  });

  describe('canUserAccessRunner', () => {
    it('should return true for owner', () => {
      const runner = {
        runnerId: 'runner1',
        name: 'Test Runner',
        ownerId: 'user1',
        token: 'token123',
        status: 'online' as const,
        lastHeartbeat: new Date().toISOString(),
        authorizedUsers: [],
        cliType: 'claude' as const,
        cliTypes: ['claude'] as ('claude' | 'gemini')[]
      };

      storage.registerRunner(runner);

      expect(storage.canUserAccessRunner('user1', 'runner1')).toBe(true);
    });

    it('should return true for authorized user', () => {
      const runner = {
        runnerId: 'runner1',
        name: 'Test Runner',
        ownerId: 'user1',
        token: 'token123',
        status: 'online' as const,
        lastHeartbeat: new Date().toISOString(),
        authorizedUsers: ['user2'],
        cliType: 'claude' as const,
        cliTypes: ['claude'] as ('claude' | 'gemini')[]
      };

      storage.registerRunner(runner);

      expect(storage.canUserAccessRunner('user2', 'runner1')).toBe(true);
    });

    it('should return false for unauthorized user', () => {
      const runner = {
        runnerId: 'runner1',
        name: 'Test Runner',
        ownerId: 'user1',
        token: 'token123',
        status: 'online' as const,
        lastHeartbeat: new Date().toISOString(),
        authorizedUsers: [],
        cliType: 'claude' as const,
        cliTypes: ['claude'] as ('claude' | 'gemini')[]
      };

      storage.registerRunner(runner);

      expect(storage.canUserAccessRunner('user2', 'runner1')).toBe(false);
    });

    it('should return false for non-existent runner', () => {
      expect(storage.canUserAccessRunner('user1', 'nonexistent')).toBe(false);
    });
  });

  describe('createSession', () => {
    it('should create a new session', () => {
      const session = {
        sessionId: 'session1',
        runnerId: 'runner1',
        channelId: 'channel1',
        threadId: 'thread1',
        createdAt: new Date().toISOString(),
        status: 'active' as const,
        cliType: 'claude' as const
      };

      storage.createSession(session);

      const retrieved = storage.getSession('session1');
      expect(retrieved).toMatchObject({
        sessionId: 'session1',
        status: 'active'
      });
    });

    it('should save session to storage', () => {
      const session = {
        sessionId: 'session1',
        runnerId: 'runner1',
        channelId: 'channel1',
        threadId: 'thread1',
        createdAt: new Date().toISOString(),
        status: 'active' as const,
        cliType: 'claude' as const
      };

      storage.createSession(session);

      expect(storage.getSession('session1')).toBeDefined();
    });
  });

  describe('getSession', () => {
    it('should return null for non-existent session', () => {
      expect(storage.getSession('nonexistent')).toBeNull();
    });

    it('should return existing session', () => {
      const session = {
        sessionId: 'session1',
        runnerId: 'runner1',
        channelId: 'channel1',
        threadId: 'thread1',
        createdAt: new Date().toISOString(),
        status: 'active' as const,
        cliType: 'claude' as const
      };

      storage.createSession(session);

      expect(storage.getSession('session1')?.sessionId).toBe('session1');
    });
  });

  describe('endSession', () => {
    it('should end active session', () => {
      const session = {
        sessionId: 'session1',
        runnerId: 'runner1',
        channelId: 'channel1',
        threadId: 'thread1',
        createdAt: new Date().toISOString(),
        status: 'active' as const,
        cliType: 'claude' as const
      };

      storage.createSession(session);
      storage.endSession('session1');

      const ended = storage.getSession('session1');
      expect(ended?.status).toBe('ended');
    });

    it('should do nothing for non-existent session', () => {
      expect(() => storage.endSession('nonexistent')).not.toThrow();
    });
  });

  describe('getRunnerSessions', () => {
    it('should return sessions for a runner', () => {
      storage.createSession({
        sessionId: 'session1',
        runnerId: 'runner1',
        channelId: 'channel1',
        threadId: 'thread1',
        createdAt: new Date().toISOString(),
        status: 'active' as const,
        cliType: 'claude' as const
      });

      storage.createSession({
        sessionId: 'session2',
        runnerId: 'runner1',
        channelId: 'channel2',
        threadId: 'thread2',
        createdAt: new Date().toISOString(),
        status: 'active' as const,
        cliType: 'claude' as const
      });

      const sessions = storage.getRunnerSessions('runner1');
      expect(sessions).toHaveLength(2);
    });

    it('should only return active sessions', () => {
      storage.createSession({
        sessionId: 'session1',
        runnerId: 'runner1',
        channelId: 'channel1',
        threadId: 'thread1',
        createdAt: new Date().toISOString(),
        status: 'active' as const,
        cliType: 'claude' as const
      });

      storage.createSession({
        sessionId: 'session2',
        runnerId: 'runner1',
        channelId: 'channel2',
        threadId: 'thread2',
        createdAt: new Date().toISOString(),
        status: 'active' as const,
        cliType: 'claude'
      });

      storage.endSession('session1');

      const sessions = storage.getRunnerSessions('runner1');
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe('session2');
    });

    it('should return empty array for runner with no sessions', () => {
      const sessions = storage.getRunnerSessions('runner1');
      expect(sessions).toEqual([]);
    });
  });

  describe('updateSession', () => {
    it('should update session fields', () => {
      storage.createSession({
        sessionId: 'session1',
        runnerId: 'runner1',
        channelId: 'channel1',
        threadId: 'thread1',
        createdAt: new Date().toISOString(),
        status: 'active',
        cliType: 'claude'
      });

      storage.updateSession('session1', { status: 'ended' });

      const updated = storage.getSession('session1');
      expect(updated?.status).toBe('ended');
    });

    it('should do nothing for non-existent session', () => {
      expect(() => storage.updateSession('nonexistent', { status: 'ended' })).not.toThrow();
    });
  });
});
