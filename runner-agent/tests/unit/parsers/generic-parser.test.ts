import { describe, it, expect } from 'vitest';
import { genericParser } from '../../../src/plugins/parsers/generic-parser';

describe('GenericParser', () => {
  describe('detectReady', () => {
    it('should detect > prompt', () => {
      const output = 'Some output\n>';
      expect(genericParser.detectReady(output)).toBe(true);
    });

    it('should detect ❯ prompt', () => {
      const output = 'Some output\n❯';
      expect(genericParser.detectReady(output)).toBe(true);
    });

    it('should detect $ prompt', () => {
      const output = 'Some output\n$';
      expect(genericParser.detectReady(output)).toBe(true);
    });

    it('should detect # prompt', () => {
      const output = 'Some output\n#';
      expect(genericParser.detectReady(output)).toBe(true);
    });

    it('should detect % prompt', () => {
      const output = 'Some output\n%';
      expect(genericParser.detectReady(output)).toBe(true);
    });

    it('should detect ? prompt', () => {
      const output = 'Some output\n?';
      expect(genericParser.detectReady(output)).toBe(true);
    });

    it('should detect prompts with ANSI codes', () => {
      const output = 'Some output\x1b[0m\n>';
      expect(genericParser.detectReady(output)).toBe(true);
    });

    it('should return false for empty output', () => {
      expect(genericParser.detectReady('')).toBe(false);
    });

    it('should return false for output without prompt', () => {
      const output = 'Just some text\nNo prompt here';
      expect(genericParser.detectReady(output)).toBe(false);
    });

    it('should handle output with only newlines', () => {
      const output = '\n\n\n';
      expect(genericParser.detectReady(output)).toBe(false);
    });

    it('should detect prompt with trailing whitespace', () => {
      const output = 'Some output\n>  ';
      expect(genericParser.detectReady(output)).toBe(true);
    });
  });

  describe('detectPermissionPrompt', () => {
    it('should always return null for generic parser', () => {
      const output = 'Any output here';
      expect(genericParser.detectPermissionPrompt(output)).toBe(null);
    });

    it('should return null even with prompt-like text', () => {
      const output = 'Do you want to proceed? [Y/n]';
      expect(genericParser.detectPermissionPrompt(output)).toBe(null);
    });
  });

  describe('parseMetadata', () => {
    it('should parse simple token count', () => {
      const output = 'Used 1234 tokens';
      const result = genericParser.parseMetadata(output);

      expect(result).toEqual({ tokens: 1234 });
    });

    it('should parse comma-separated tokens', () => {
      const output = 'Used 1,234 tokens';
      const result = genericParser.parseMetadata(output);

      expect(result).toEqual({ tokens: 1234 });
    });

    it('should parse tokens: pattern', () => {
      const output = '5678 tokens';
      const result = genericParser.parseMetadata(output);

      expect(result).toEqual({ tokens: 5678 });
    });

    it('should be case insensitive for tokens', () => {
      const output = '999 TOKENS';
      const result = genericParser.parseMetadata(output);

      expect(result).toEqual({ tokens: 999 });
    });

    it('should return null when no tokens found', () => {
      const output = 'No token information here';
      const result = genericParser.parseMetadata(output);

      expect(result).toBe(null);
    });

    it('should return null for empty string', () => {
      const result = genericParser.parseMetadata('');

      expect(result).toBe(null);
    });
  });

  describe('cleanOutput', () => {
    it('should remove ANSI color codes', () => {
      const input = '\x1b[31mRed text\x1b[0m';
      const output = genericParser.cleanOutput(input);

      expect(output).toBe('Red text');
    });

    it('should remove control characters except newlines', () => {
      const input = 'Text\x00\x01\x02\nMore text';
      const output = genericParser.cleanOutput(input);

      expect(output).toContain('Text');
      expect(output).toContain('More text');
      expect(output).not.toContain('\x00');
    });

    it('should normalize CRLF to LF', () => {
      const input = 'Line 1\r\nLine 2\r\n';
      const output = genericParser.cleanOutput(input);

      expect(output).toBe('Line 1\nLine 2');
    });

    it('should collapse excessive newlines', () => {
      const input = 'Line 1\n\n\n\nLine 2';
      const output = genericParser.cleanOutput(input);

      expect(output).toBe('Line 1\n\nLine 2');
    });

    it('should trim output', () => {
      const input = '  \n  Text  \n  ';
      const output = genericParser.cleanOutput(input);

      expect(output).toBe('Text');
    });

    it('should handle empty string', () => {
      const output = genericParser.cleanOutput('');

      expect(output).toBe('');
    });

    it('should remove CSI sequences', () => {
      const input = 'Text\x1b[?25lMore';
      const output = genericParser.cleanOutput(input);

      expect(output).toBe('TextMore');
    });
  });

  describe('detectBypassWarning', () => {
    it('should always return false for generic parser', () => {
      const output = 'WARNING bypass mode';
      expect(genericParser.detectBypassWarning(output)).toBe(false);
    });

    it('should return false for any text', () => {
      const output = 'Any text here';
      expect(genericParser.detectBypassWarning(output)).toBe(false);
    });
  });

  describe('detectWorking', () => {
    it('should detect ... at end of output', () => {
      const output = 'Processing...';
      expect(genericParser.detectWorking(output)).toBe(true);
    });

    it('should detect processing keyword', () => {
      const output = 'Currently processing data';
      expect(genericParser.detectWorking(output)).toBe(true);
    });

    it('should detect loading keyword', () => {
      const output = 'Loading configuration';
      expect(genericParser.detectWorking(output)).toBe(true);
    });

    it('should detect working keyword', () => {
      const output = 'Working on it';
      expect(genericParser.detectWorking(output)).toBe(true);
    });

    it('should be case insensitive for keywords', () => {
      const output = 'PROCESSING data';
      expect(genericParser.detectWorking(output)).toBe(true);
    });

    it('should return false when no activity indicators', () => {
      const output = 'Just sitting here';
      expect(genericParser.detectWorking(output)).toBe(false);
    });

    it('should return false for empty string', () => {
      expect(genericParser.detectWorking('')).toBe(false);
    });
  });

  describe('detectIdle', () => {
    it('should delegate to detectReady', () => {
      const output = 'Text\n>';
      expect(genericParser.detectIdle(output)).toBe(true);
    });

    it('should return false when not ready', () => {
      const output = 'Working...';
      expect(genericParser.detectIdle(output)).toBe(false);
    });
  });

  describe('parser metadata', () => {
    it('should have correct name', () => {
      expect(genericParser.name).toBe('GenericParser');
    });

    it('should have correct cliType', () => {
      expect(genericParser.cliType).toBe('generic');
    });

    it('should have all required functions', () => {
      expect(genericParser.detectReady).toBeDefined();
      expect(genericParser.detectPermissionPrompt).toBeDefined();
      expect(genericParser.parseMetadata).toBeDefined();
      expect(genericParser.cleanOutput).toBeDefined();
      expect(genericParser.detectBypassWarning).toBeDefined();
      expect(genericParser.detectWorking).toBeDefined();
      expect(genericParser.detectIdle).toBeDefined();
    });
  });
});
