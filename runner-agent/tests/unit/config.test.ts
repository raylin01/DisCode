import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import { resetConfig } from '../../src/config';
import { loadConfigFile, parseCliTypes, parseSearchPaths, loadConfig, getConfig } from '../../src/config';

// Mock os module
vi.mock('os', () => ({
  default: {
    homedir: vi.fn(() => '/home/user'),
  },
  homedir: vi.fn(() => '/home/user'),
}));

describe('loadConfigFile', () => {
  beforeEach(() => {
    vi.mock('fs');
    vi.clearAllMocks();
    delete process.env.DISCODE_CONFIG_PATH;
  });

  it('should return empty object when file does not exist', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const config = loadConfigFile();

    expect(config).toEqual({});
  });

  it('should parse valid JSON config file', () => {
    const testConfig = { botWsUrl: 'ws://test:8080', runnerName: 'test-runner' };
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(JSON.stringify(testConfig));

    const config = loadConfigFile();

    expect(config).toEqual(testConfig);
  });

  it('should read from DISCODE_CONFIG_PATH env var', () => {
    process.env.DISCODE_CONFIG_PATH = '/custom/path/config.json';
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('{}');

    loadConfigFile();

    expect(fs.existsSync).toHaveBeenCalledWith('/custom/path/config.json');
    expect(fs.readFileSync).toHaveBeenCalledWith('/custom/path/config.json', 'utf-8');
  });

  it('should fallback to ./config.json when env not set', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('{}');

    loadConfigFile();

    expect(fs.existsSync).toHaveBeenCalledWith('./config.json');
  });

  it('should return empty object on JSON parse error', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue('invalid json{');

    const config = loadConfigFile();

    expect(config).toEqual({});
  });

  it('should return empty object on file read error', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('Permission denied');
    });

    const config = loadConfigFile();

    expect(config).toEqual({});
  });
});

describe('parseCliTypes', () => {
  it('should return claude when input is undefined', () => {
    const result = parseCliTypes(undefined);

    expect(result).toEqual(['claude']);
  });

  it('should parse comma-separated string', () => {
    const result = parseCliTypes('claude,gemini');

    expect(result).toEqual(['claude', 'gemini']);
  });

  it('should trim whitespace from string values', () => {
    const result = parseCliTypes(' claude , gemini ');

    expect(result).toEqual(['claude', 'gemini']);
  });

  it('should handle string array input', () => {
    const result = parseCliTypes(['claude', 'gemini']);

    expect(result).toEqual(['claude', 'gemini']);
  });

  it('should filter out invalid CLI types', () => {
    const result = parseCliTypes('claude,invalid,gemini,another');

    expect(result).toEqual(['claude', 'gemini']);
  });

  it('should be case insensitive', () => {
    const result = parseCliTypes('CLAUDE,GEMINI,ClaUde');

    expect(result).toEqual(['claude', 'gemini', 'claude']);
  });

  it('should return empty array when no valid types', () => {
    const result = parseCliTypes('invalid1,invalid2');

    expect(result).toEqual([]);
  });

  it('should return claude for empty string (falsy value)', () => {
    const result = parseCliTypes('');

    // Empty string is falsy, so it returns default ['claude']
    expect(result).toEqual(['claude']);
  });

  it('should handle mixed valid and invalid types', () => {
    const result = parseCliTypes(['claude', 'invalid', 'gemini']);

    expect(result).toEqual(['claude', 'gemini']);
  });

  it('should handle single valid type', () => {
    const result = parseCliTypes('claude');

    expect(result).toEqual(['claude']);
  });
});

describe('parseSearchPaths', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return default paths when no input provided', () => {
    const result = parseSearchPaths(undefined, undefined);

    expect(result).toEqual([
      '/home/user/.local/bin',
      '/usr/local/bin',
      '/opt/homebrew/bin',
      '/home/linuxbrew/.linuxbrew/bin',
    ]);
  });

  it('should prioritize env input over file input', () => {
    const result = parseSearchPaths('/env/path', ['/file/path']);

    expect(result[0]).toBe('/env/path');
  });

  it('should split env string by comma', () => {
    const result = parseSearchPaths('/path1,/path2,/path3', undefined);

    expect(result.slice(0, 3)).toEqual(['/path1', '/path2', '/path3']);
  });

  it('should trim whitespace from env paths', () => {
    const result = parseSearchPaths(' /path1 , /path2 ', undefined);

    expect(result.slice(0, 2)).toEqual(['/path1', '/path2']);
  });

  it('should filter empty strings from env', () => {
    const result = parseSearchPaths('/path1,,/path2,', undefined);

    expect(result.slice(0, 2)).toEqual(['/path1', '/path2']);
  });

  it('should handle file input array', () => {
    const result = parseSearchPaths(undefined, ['/custom1', '/custom2']);

    expect(result.slice(0, 2)).toEqual(['/custom1', '/custom2']);
  });

  it('should append default paths after custom paths from env', () => {
    const result = parseSearchPaths('/custom', undefined);

    expect(result[0]).toBe('/custom');
    expect(result).toContain('/usr/local/bin');
    expect(result).toContain('/opt/homebrew/bin');
  });

  it('should append default paths after custom paths from file', () => {
    const result = parseSearchPaths(undefined, ['/custom']);

    expect(result[0]).toBe('/custom');
    expect(result).toContain('/usr/local/bin');
  });
});

describe('loadConfig', () => {
  let originalExit: any;

  beforeEach(() => {
    vi.mock('fs');
    vi.clearAllMocks();
    originalExit = process.exit;
    process.exit = vi.fn() as any;
  });

  afterEach(() => {
    process.exit = originalExit;
    delete process.env.DISCODE_TOKEN;
    delete process.env.DISCODE_CLI_TYPES;
    delete process.env.DISCODE_BOT_URL;
    delete process.env.DISCODE_RUNNER_NAME;
    delete process.env.DISCODE_HTTP_PORT;
  });

  it('should exit when DISCODE_TOKEN is missing', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    loadConfig();

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('should load token from DISCODE_TOKEN env', () => {
    process.env.DISCODE_TOKEN = 'test-token-123';
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const config = loadConfig();

    expect(config.token).toBe('test-token-123');
  });

  it('should exit when no valid CLI types', () => {
    process.env.DISCODE_TOKEN = 'test-token';
    process.env.DISCODE_CLI_TYPES = 'invalid,another-invalid';
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    loadConfig();

    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it('should use default botWsUrl when not specified', () => {
    process.env.DISCODE_TOKEN = 'test-token';
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const config = loadConfig();

    expect(config.botWsUrl).toBe('ws://localhost:8080');
  });

  it('should use env botWsUrl over file config', () => {
    process.env.DISCODE_TOKEN = 'test-token';
    process.env.DISCODE_BOT_URL = 'ws://env:8080';
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({ botWsUrl: 'ws://file:8080' })
    );

    const config = loadConfig();

    expect(config.botWsUrl).toBe('ws://env:8080');
  });

  it('should use default runnerName when not specified', () => {
    process.env.DISCODE_TOKEN = 'test-token';
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const config = loadConfig();

    expect(config.runnerName).toBe('local-runner');
  });

  it('should use env runnerName over file config', () => {
    process.env.DISCODE_TOKEN = 'test-token';
    process.env.DISCODE_RUNNER_NAME = 'env-runner';
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({ runnerName: 'file-runner' })
    );

    const config = loadConfig();

    expect(config.runnerName).toBe('env-runner');
  });

  it('should use default httpPort when not specified', () => {
    process.env.DISCODE_TOKEN = 'test-token';
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const config = loadConfig();

    expect(config.httpPort).toBe(3122);
  });

  it('should parse httpPort from env', () => {
    process.env.DISCODE_TOKEN = 'test-token';
    process.env.DISCODE_HTTP_PORT = '4000';
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const config = loadConfig();

    expect(config.httpPort).toBe(4000);
  });

  it('should parse CLI types from env', () => {
    process.env.DISCODE_TOKEN = 'test-token';
    process.env.DISCODE_CLI_TYPES = 'claude,gemini';
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const config = loadConfig();

    expect(config.cliTypes).toEqual(['claude', 'gemini']);
  });

  it('should use default heartbeatInterval', () => {
    process.env.DISCODE_TOKEN = 'test-token';
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const config = loadConfig();

    expect(config.heartbeatInterval).toBe(30000);
  });

  it('should parse heartbeatInterval from env', () => {
    process.env.DISCODE_TOKEN = 'test-token';
    process.env.DISCODE_HEARTBEAT_INTERVAL = '60000';
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const config = loadConfig();

    expect(config.heartbeatInterval).toBe(60000);
  });

  it('should use default reconnectDelay', () => {
    process.env.DISCODE_TOKEN = 'test-token';
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const config = loadConfig();

    expect(config.reconnectDelay).toBe(5000);
  });

  it('should use default approvalTimeout', () => {
    process.env.DISCODE_TOKEN = 'test-token';
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const config = loadConfig();

    expect(config.approvalTimeout).toBe(30000);
  });

  it('should use default sessionReadyTimeout', () => {
    process.env.DISCODE_TOKEN = 'test-token';
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const config = loadConfig();

    expect(config.sessionReadyTimeout).toBe(10000);
  });

  it('should have default tmux config', () => {
    process.env.DISCODE_TOKEN = 'test-token';
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const config = loadConfig();

    expect(config.tmux.pollInterval).toBe(1000);
    expect(config.tmux.healthCheckInterval).toBe(5000);
    expect(config.tmux.sessionDiscoveryInterval).toBe(5000);
    expect(config.tmux.discoveryEnabled).toBe(true);
  });

  it('should disable tmux discovery when DISCODE_TMUX_POLLING=false', () => {
    process.env.DISCODE_TOKEN = 'test-token';
    process.env.DISCODE_TMUX_POLLING = 'false';
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const config = loadConfig();

    expect(config.tmux.discoveryEnabled).toBe(false);
  });

  it('should merge tmux config from file', () => {
    process.env.DISCODE_TOKEN = 'test-token';
    vi.spyOn(fs, 'existsSync').mockReturnValue(true);
    vi.spyOn(fs, 'readFileSync').mockReturnValue(
      JSON.stringify({
        tmux: {
          pollInterval: 2000,
          healthCheckInterval: 10000,
        }
      })
    );

    const config = loadConfig();

    expect(config.tmux.pollInterval).toBe(2000);
    expect(config.tmux.healthCheckInterval).toBe(10000);
    expect(config.tmux.sessionDiscoveryInterval).toBe(5000); // default
  });
});

describe('getConfig (singleton)', () => {
  let originalExit: any;

  beforeEach(() => {
    vi.mock('fs');
    vi.clearAllMocks();
    originalExit = process.exit;
    process.exit = vi.fn() as any;
    process.env.DISCODE_TOKEN = 'test-token';
    resetConfig();
  });

  afterEach(() => {
    process.exit = originalExit;
    delete process.env.DISCODE_TOKEN;
    resetConfig();
  });

  it('should return same instance on multiple calls', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const config1 = getConfig();
    const config2 = getConfig();

    expect(config1).toBe(config2);
  });

  it('should cache config instance', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const config = getConfig();

    expect(config).toBeDefined();
    expect(config.token).toBe('test-token');
  });

  it('should reload config after reset', () => {
    vi.spyOn(fs, 'existsSync').mockReturnValue(false);

    const config1 = getConfig();
    resetConfig();
    const config2 = getConfig();

    expect(config1).not.toBe(config2);
    expect(config1.token).toBe(config2.token);
  });
});
