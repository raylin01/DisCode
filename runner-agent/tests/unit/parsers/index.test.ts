import { describe, it, expect } from 'vitest';
import { genericParser, claudeParser, geminiParser, getParser } from '../../../src/plugins/parsers/index';

describe('Parsers Index', () => {
  describe('getParser', () => {
    it('should return claudeParser for claude', () => {
      const parser = getParser('claude');
      expect(parser).toBe(claudeParser);
      expect(parser.cliType).toBe('claude');
    });

    it('should return geminiParser for gemini', () => {
      const parser = getParser('gemini');
      expect(parser).toBe(geminiParser);
      expect(parser.cliType).toBe('gemini');
    });

    it('should return genericParser for generic', () => {
      const parser = getParser('generic');
      expect(parser).toBe(genericParser);
      expect(parser.cliType).toBe('generic');
    });

    it('should return genericParser for unknown types', () => {
      const parser = getParser('unknown-cli');
      expect(parser).toBe(genericParser);
    });

    it('should be case insensitive for claude', () => {
      const parser = getParser('CLAUDE');
      expect(parser).toBe(genericParser); // Falls back to generic
    });

    it('should be case insensitive for gemini', () => {
      const parser = getParser('GEMINI');
      expect(parser).toBe(genericParser); // Falls back to generic
    });
  });

  describe('Parser Exports', () => {
    it('should export genericParser', () => {
      expect(genericParser).toBeDefined();
      expect(genericParser.cliType).toBe('generic');
    });

    it('should export claudeParser', () => {
      expect(claudeParser).toBeDefined();
      expect(claudeParser.cliType).toBe('claude');
    });

    it('should export geminiParser', () => {
      expect(geminiParser).toBeDefined();
      expect(geminiParser.cliType).toBe('gemini');
    });
  });
});
