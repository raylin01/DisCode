import { describe, it, expect } from 'vitest';
import { claudeParser } from '../../../src/plugins/parsers/claude-parser';

describe('ClaudeParser', () => {
  describe('detectReady', () => {
    it('should detect > prompt with ANSI codes', () => {
      const output = '\x1b[0mSome text\x1b[0m\n>';
      expect(claudeParser.detectReady(output)).toBe(true);
    });

    it('should detect > prompt without ANSI codes', () => {
      const output = 'Output\n>';
      expect(claudeParser.detectReady(output)).toBe(true);
    });

    it('should return false when no > present', () => {
      const output = 'Working...';
      expect(claudeParser.detectReady(output)).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(claudeParser.detectReady('')).toBe(false);
    });
  });

  describe('detectPermissionPrompt', () => {
    it('should detect prompt with footer', () => {
      const output = `Do you want to proceed?
  1. Yes
  2. No
Esc to cancel`;
      const result = claudeParser.detectPermissionPrompt(output);
      expect(result).not.toBeNull();
      expect(result?.tool).toBeDefined();
      expect(result?.options).toHaveLength(2);
    });

    it('should detect "Would you like" variant', () => {
      const output = `Would you like to proceed?
  1. Allow
  2. Deny
Esc to cancel`;
      const result = claudeParser.detectPermissionPrompt(output);
      expect(result).not.toBeNull();
    });

    it('should detect prompt with selector', () => {
      const output = `Do you want to proceed?
❯ 1. Yes
  2. No`;
      const result = claudeParser.detectPermissionPrompt(output);
      expect(result).not.toBeNull();
    });

    it('should parse tool name from bullet pattern', () => {
      const output = `● Read (package.json)
Do you want to proceed?
  1. Yes
  2. No
Esc to cancel`;
      const result = claudeParser.detectPermissionPrompt(output);
      expect(result?.tool).toBe('Read');
    });

    it('should parse tool name from command pattern', () => {
      const output = `Bash command
Do you want to proceed?
  1. Yes
  2. No
Esc to cancel`;
      const result = claudeParser.detectPermissionPrompt(output);
      expect(result?.tool).toBe('Bash');
    });

    it('should return null when fewer than 2 options', () => {
      const output = `Do you want to proceed?
  1. Yes
Esc to cancel`;
      const result = claudeParser.detectPermissionPrompt(output);
      expect(result).toBeNull();
    });

    it('should return null without proceed question', () => {
      const output = `Some text
  1. Option 1
  2. Option 2`;
      const result = claudeParser.detectPermissionPrompt(output);
      expect(result).toBeNull();
    });

    it('should return null without footer or selector', () => {
      const output = `Do you want to proceed?
Some other text`;
      const result = claudeParser.detectPermissionPrompt(output);
      expect(result).toBeNull();
    });
  });

  describe('parseTokensFromOutput (via parseMetadata)', () => {
    it('should parse plain token count', () => {
      const output = '↓ 879 tokens';
      const result = claudeParser.parseMetadata(output);
      expect(result?.tokens).toBe(879);
    });

    it('should parse comma-separated tokens', () => {
      const output = '↓ 1,234 tokens';
      const result = claudeParser.parseMetadata(output);
      expect(result?.tokens).toBe(1234);
    });

    it('should parse k-suffix tokens (12.5k)', () => {
      const output = '↓ 12.5k tokens';
      const result = claudeParser.parseMetadata(output);
      expect(result?.tokens).toBe(12500);
    });

    it('should parse k-suffix tokens (12k)', () => {
      const output = '↓ 12k tokens';
      const result = claudeParser.parseMetadata(output);
      expect(result?.tokens).toBe(12000);
    });

    it('should return max of multiple token counts', () => {
      const output = '↓ 100 tokens\n↓ 200 tokens\n↓ 150 tokens';
      const result = claudeParser.parseMetadata(output);
      expect(result?.tokens).toBe(200);
    });

    it('should return null when no tokens found', () => {
      const output = 'No token info';
      const result = claudeParser.parseMetadata(output);
      expect(result).toBeNull();
    });
  });

  describe('parseActivity (via parseMetadata)', () => {
    it('should detect Thinking activity', () => {
      const output = '* Thinking...';
      const result = claudeParser.parseMetadata(output);
      expect(result?.activity).toBe('Thinking');
    });

    it('should detect Wrangling activity', () => {
      const output = '* Wrangling...';
      const result = claudeParser.parseMetadata(output);
      expect(result?.activity).toBe('Wrangling');
    });

    it('should detect activity with (esc to interrupt)', () => {
      const output = '* Honking... (esc to interrupt)';
      const result = claudeParser.parseMetadata(output);
      expect(result?.activity).toBe('Honking');
    });

    it('should detect activity with unicode ellipsis', () => {
      const output = '* Vibing…';
      const result = claudeParser.parseMetadata(output);
      expect(result?.activity).toBe('Vibing');
    });

    it('should return last activity when multiple', () => {
      const output = '* Thinking...\n* Working...';
      const result = claudeParser.parseMetadata(output);
      expect(result?.activity).toBe('Working');
    });

    it('should return null when no activity', () => {
      const output = 'Just text';
      const result = claudeParser.parseMetadata(output);
      expect(result?.activity).toBeUndefined();
    });
  });

  describe('parseMode (via parseMetadata)', () => {
    it('should detect bypass mode', () => {
      const output = 'bypass permissions on';
      const result = claudeParser.parseMetadata(output);
      expect(result?.mode).toBe('bypass');
    });

    it('should detect plan mode', () => {
      const output = 'plan mode';
      const result = claudeParser.parseMetadata(output);
      expect(result?.mode).toBe('plan');
    });

    it('should return null when no mode', () => {
      const output = 'normal mode';
      const result = claudeParser.parseMetadata(output);
      expect(result?.mode).toBeUndefined();
    });
  });

  describe('cleanOutput', () => {
    it('should remove ANSI codes', () => {
      const input = '\x1b[31mError\x1b[0m';
      const output = claudeParser.cleanOutput(input);
      expect(output).not.toContain('\x1b');
    });

    it('should remove CPU warning', () => {
      const input = 'warn: CPU lacks AVX support. Please download...zip\nText';
      const output = claudeParser.cleanOutput(input);
      expect(output).not.toContain('CPU lacks AVX');
    });

    it('should remove shell prompts', () => {
      const input = '(base) user@machine $ command';
      const output = claudeParser.cleanOutput(input);
      expect(output).not.toContain('(base)');
      expect(output).not.toContain('user@machine');
    });

    it('should remove horizontal rules', () => {
      const input = '─────\nText\n─────';
      const output = claudeParser.cleanOutput(input);
      expect(output).not.toContain('─');
    });

    it('should remove empty prompt lines', () => {
      const input = 'Text\n>\nMore';
      const output = claudeParser.cleanOutput(input);
      expect(output).not.toMatch(/^>\n$/m);
    });

    it('should remove "? for shortcuts"', () => {
      const input = 'Text\n? for shortcuts\nMore';
      const output = claudeParser.cleanOutput(input);
      expect(output).not.toContain('? for shortcuts');
    });

    it('should remove bypass permissions text', () => {
      const input = 'bypass permissions on (shift+tab to cycle)';
      const output = claudeParser.cleanOutput(input);
      expect(output).not.toContain('bypass permissions');
    });

    it('should remove Claude Code branding', () => {
      const input = 'Welcome to Claude Code\nText';
      const output = claudeParser.cleanOutput(input);
      expect(output).not.toContain('Welcome to Claude');
    });

    it('should remove activity status lines', () => {
      const input = '* Thinking...\nText';
      const output = claudeParser.cleanOutput(input);
      expect(output).not.toContain('Thinking');
    });

    it('should collapse excessive newlines', () => {
      const input = 'Line1\n\n\n\nLine2';
      const output = claudeParser.cleanOutput(input);
      expect(output).not.toContain('\n\n\n');
    });

    it('should trim output', () => {
      const input = '  \n Text  \n  ';
      const output = claudeParser.cleanOutput(input);
      expect(output).toBe('Text');
    });
  });

  describe('detectBypassWarning', () => {
    it('should detect WARNING with Bypass Permissions mode', () => {
      const output = 'WARNING\nBypass Permissions mode active';
      expect(claudeParser.detectBypassWarning(output)).toBe(true);
    });

    it('should return false when only WARNING present', () => {
      const output = 'WARNING: Something else';
      expect(claudeParser.detectBypassWarning(output)).toBe(false);
    });

    it('should return false when only Bypass Permissions present', () => {
      const output = 'Bypass Permissions mode';
      expect(claudeParser.detectBypassWarning(output)).toBe(false);
    });

    it('should be case sensitive', () => {
      const output = 'warning\nBypass Permissions mode';
      // Function is case-sensitive - requires exact "WARNING"
      expect(claudeParser.detectBypassWarning(output)).toBe(false);
    });
  });

  describe('detectWorking', () => {
    it('should return true when activity present', () => {
      const output = '* Thinking...';
      expect(claudeParser.detectWorking(output)).toBe(true);
    });

    it('should return false when no activity', () => {
      const output = 'Ready>';
      expect(claudeParser.detectWorking(output)).toBe(false);
    });
  });

  describe('detectIdle', () => {
    it('should detect > prompt at end', () => {
      const output = 'Done\n>';
      expect(claudeParser.detectIdle(output)).toBe(true);
    });

    it('should detect ❯ prompt at end', () => {
      const output = 'Done\n❯';
      expect(claudeParser.detectIdle(output)).toBe(true);
    });

    it('should detect > prompt with whitespace', () => {
      const output = 'Done\n>  ';
      expect(claudeParser.detectIdle(output)).toBe(true);
    });

    it('should return false when working', () => {
      const output = '* Thinking...';
      expect(claudeParser.detectIdle(output)).toBe(false);
    });
  });

  describe('parser metadata', () => {
    it('should have correct name', () => {
      expect(claudeParser.name).toBe('ClaudeParser');
    });

    it('should have correct cliType', () => {
      expect(claudeParser.cliType).toBe('claude');
    });

    it('should have all required functions', () => {
      expect(claudeParser.detectReady).toBeDefined();
      expect(claudeParser.detectPermissionPrompt).toBeDefined();
      expect(claudeParser.parseMetadata).toBeDefined();
      expect(claudeParser.cleanOutput).toBeDefined();
      expect(claudeParser.detectBypassWarning).toBeDefined();
      expect(claudeParser.detectWorking).toBeDefined();
      expect(claudeParser.detectIdle).toBeDefined();
    });
  });
});
