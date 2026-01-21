import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  generateRunnerId,
  stripAnsi,
  findCliPath,
  expandPath,
  validateOrCreateFolder
} from '../../src/utils';

describe('generateRunnerId', () => {
  it('should generate consistent ID for same token and name', () => {
    const token = 'test-token-123';
    const name = 'MyRunner';

    const id1 = generateRunnerId(token, name);
    const id2 = generateRunnerId(token, name);

    expect(id1).toBe(id2);
  });

  it('should format ID correctly with runner prefix', () => {
    const token = 'test-token';
    const name = 'TestRunner';

    const id = generateRunnerId(token, name);

    expect(id).toMatch(/^runner_testrunner_[a-f0-9]{12}$/);
  });

  it('should replace spaces with underscores in runner name', () => {
    const token = 'token';
    const name = 'My Test Runner';

    const id = generateRunnerId(token, name);

    expect(id).toContain('my_test_runner');
  });

  it('should convert runner name to lowercase', () => {
    const token = 'token';
    const name = 'MyRUNNER';

    const id = generateRunnerId(token, name);

    expect(id).toContain('myrunner');
  });

  it('should generate different IDs for different tokens', () => {
    const name = 'Runner';

    const id1 = generateRunnerId('token1', name);
    const id2 = generateRunnerId('token2', name);

    expect(id1).not.toBe(id2);
  });

  it('should generate different IDs for different names with same token', () => {
    const token = 'token';

    const id1 = generateRunnerId(token, 'Runner1');
    const id2 = generateRunnerId(token, 'Runner2');

    expect(id1).not.toBe(id2);
  });

  it('should generate 12 character hash', () => {
    const token = 'test-token';
    const name = 'Test';

    const id = generateRunnerId(token, name);
    const parts = id.split('_');

    expect(parts[2]).toHaveLength(12);
  });
});

describe('stripAnsi', () => {
  it('should remove basic ANSI color codes', () => {
    const input = '\x1b[31mRed text\x1b[0m';
    const output = stripAnsi(input);

    expect(output).toBe('Red text');
  });

  it('should remove bold ANSI codes', () => {
    const input = '\x1b[1mBold text\x1b[0m';
    const output = stripAnsi(input);

    expect(output).toBe('Bold text');
  });

  it('should remove multiple ANSI sequences', () => {
    const input = '\x1b[1m\x1b[32m\x1b[44mBold green on blue\x1b[0m';
    const output = stripAnsi(input);

    expect(output).toBe('Bold green on blue');
  });

  it('should handle text without ANSI codes', () => {
    const input = 'Plain text';
    const output = stripAnsi(input);

    expect(output).toBe('Plain text');
  });

  it('should handle empty string', () => {
    const output = stripAnsi('');

    expect(output).toBe('');
  });

  it('should remove OSC sequences', () => {
    const input = 'Text\x1b]0;Window Title\x07More text';
    const output = stripAnsi(input);

    expect(output).toBe('TextMore text');
  });

  it('should preserve newlines', () => {
    const input = 'Line 1\nLine 2\nLine 3';
    const output = stripAnsi(input);

    expect(output).toBe('Line 1\nLine 2\nLine 3');
  });

  it('should remove CSI cursor sequences', () => {
    const input = 'Text\x1b[2K\x1b[GMore';
    const output = stripAnsi(input);

    expect(output).toBe('TextMore');
  });

  it('should handle mixed ANSI and regular text', () => {
    const input = '\x1b[31mError:\x1b[0m Something went wrong';
    const output = stripAnsi(input);

    expect(output).toBe('Error: Something went wrong');
  });

  it('should remove complex CSI sequences', () => {
    const input = '\x1b[?25l\x1b[1;32mText\x1b[0m\x1b[?25h';
    const output = stripAnsi(input);

    expect(output).toBe('Text');
  });
});

describe('findCliPath', () => {
  beforeEach(() => {
    vi.mock('fs');
    vi.clearAllMocks();
  });

  it('should return path when CLI found in first directory', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await findCliPath('claude', ['/usr/local/bin']);

    expect(result).toBe('/usr/local/bin/claude');
  });

  it('should return path when CLI found in later directory', async () => {
    vi.spyOn(fs, 'existsSync').mockImplementation((path) => {
      return path === '/opt/homebrew/bin/claude';
    });

    const result = await findCliPath('claude', ['/usr/local/bin', '/opt/homebrew/bin']);

    expect(result).toBe('/opt/homebrew/bin/claude');
  });

  it('should return null when CLI not found', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const result = await findCliPath('claude', ['/usr/local/bin']);

    expect(result).toBeNull();
  });

  it('should handle fs errors gracefully', async () => {
    vi.spyOn(fs, 'existsSync').mockImplementation(() => {
      throw new Error('Permission denied');
    });

    const result = await findCliPath('claude', ['/usr/local/bin']);

    expect(result).toBeNull();
  });

  it('should search paths in order', async () => {
    const mockExistsSync = vi.spyOn(fs, 'existsSync').mockImplementation((path) => {
      // Found in second directory
      return path === '/opt/claude';
    });

    await findCliPath('claude', ['/usr/bin', '/opt']);

    expect(mockExistsSync).toHaveBeenNthCalledWith(1, '/usr/bin/claude');
    expect(mockExistsSync).toHaveBeenNthCalledWith(2, '/opt/claude');
  });

  it('should work with gemini CLI type', async () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = await findCliPath('gemini', ['/usr/local/bin']);

    expect(result).toBe('/usr/local/bin/gemini');
  });
});

describe('expandPath', () => {
  it('should expand ~ to home directory', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home/user');

    const result = expandPath('~/Documents');

    expect(result).toBe('/home/user/Documents');
  });

  it('should handle ~ with nested paths', () => {
    vi.spyOn(os, 'homedir').mockReturnValue('/home/user');

    const result = expandPath('~/projects/my-project/src');

    expect(result).toBe('/home/user/projects/my-project/src');
  });

  it('should resolve relative paths against default workspace', () => {
    const result = expandPath('./src', '/home/user/project');

    expect(result).toContain('/home/user/project/src');
  });

  it('should resolve relative paths with .. against default workspace', () => {
    // Mock path.join to return expected result
    const mockJoin = vi.spyOn(path, 'join').mockImplementation((...args) => {
      return args.join('/');
    });

    expandPath('../src', '/home/user/project');

    expect(mockJoin).toHaveBeenCalledWith('/home/user/project', '../src');
  });

  it('should resolve relative paths against cwd when no default workspace', () => {
    vi.spyOn(process, 'cwd').mockReturnValue('/home/user');
    vi.spyOn(path, 'resolve').mockImplementation((...args) => {
      return args.join('/');
    });

    expandPath('./src');

    expect(path.resolve).toHaveBeenCalledWith(process.cwd(), './src');
  });

  it('should return absolute paths unchanged', () => {
    const result = expandPath('/absolute/path/to/project');

    expect(result).toBe('/absolute/path/to/project');
  });

  it('should handle empty string', () => {
    const result = expandPath('');

    expect(result).toBe('');
  });

  it('should handle . in relative path', () => {
    const mockJoin = vi.spyOn(path, 'join').mockImplementation((...args) => {
      return args.join('/');
    });

    expandPath('./src', '/workspace');

    expect(mockJoin).toHaveBeenCalledWith('/workspace', './src');
  });
});

describe('validateOrCreateFolder', () => {
  beforeEach(() => {
    vi.mock('fs');
    vi.clearAllMocks();
  });

  it('should return exists: true when folder exists', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = validateOrCreateFolder('/existing/path');

    expect(result).toEqual({ exists: true });
  });

  it('should create folder when create=true and folder does not exist', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});

    const result = validateOrCreateFolder('/new/path', true);

    expect(result).toEqual({ exists: true });
    expect(fs.mkdirSync).toHaveBeenCalledWith('/new/path', { recursive: true });
  });

  it('should return error when create=false and folder does not exist', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const result = validateOrCreateFolder('/new/path', false);

    expect(result).toEqual({
      exists: false,
      error: 'Folder does not exist: /new/path'
    });
  });

  it('should return error when creation fails', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw new Error('Permission denied');
    });

    const result = validateOrCreateFolder('/new/path', true);

    expect(result.exists).toBe(false);
    expect(result.error).toContain('Failed to create folder');
    expect(result.error).toContain('Permission denied');
  });

  it('should create nested directories', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {});

    validateOrCreateFolder('/path/to/nested/folder', true);

    expect(mkdirSpy).toHaveBeenCalledWith('/path/to/nested/folder', { recursive: true });
  });

  it('should handle valid folder with trailing slash', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);

    const result = validateOrCreateFolder('/valid/path/');

    expect(result).toEqual({ exists: true });
  });
});
