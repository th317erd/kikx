'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { t, setLocale, getLocale, getCurrentLanguage } from '../../lib/i18n.mjs';
import enLocale from '../../lib/locales/en.mjs';

describe('i18n', () => {
  beforeEach(() => {
    setLocale(enLocale, 'en');
  });

  describe('t()', () => {
    it('returns the translated string for a top-level dot-separated key', () => {
      assert.equal(t('application.title'), 'Hero');
    });

    it('falls back to the key string when the key does not exist', () => {
      assert.equal(t('nonexistent.key'), 'nonexistent.key');
    });

    it('resolves deeply nested keys', () => {
      assert.equal(t('chat.input.placeholder'), 'Type a message...');
    });

    it('interpolates variables into a template string', () => {
      assert.equal(t('chat.interaction.tokenCount.other', { count: 5 }), '~5 tokens');
    });

    it('picks the singular form when count is 1', () => {
      assert.equal(t('chat.interaction.tokenCount', { count: 1 }), '~1 token');
    });

    it('picks the plural form when count is greater than 1', () => {
      assert.equal(t('chat.interaction.tokenCount', { count: 5 }), '~5 tokens');
    });

    it('returns the key when a key resolves to a pluralization object but no count is provided', () => {
      assert.equal(t('chat.interaction.tokenCount'), 'chat.interaction.tokenCount');
    });

    it('returns the key when a key resolves to a plain object (not a pluralization object)', () => {
      assert.equal(t('chat.input'), 'chat.input');
    });

    it('interpolates multiple variables in a single template', () => {
      setLocale({
        greeting: {
          full: 'Hello, {name}! You have {count} messages.',
        },
      }, 'en');

      assert.equal(
        t('greeting.full', { name: 'Wyatt', count: 3 }),
        'Hello, Wyatt! You have 3 messages.',
      );
    });

    it('leaves a placeholder literal when the corresponding variable is not provided', () => {
      setLocale({
        greeting: 'Hello, {name}!',
      }, 'en');

      assert.equal(t('greeting'), 'Hello, {name}!');
    });

    it('returns an empty string key as-is', () => {
      assert.equal(t(''), '');
    });
  });

  describe('setLocale()', () => {
    it('swaps the active locale so t() returns values from the new locale', () => {
      setLocale({
        application: {
          title: 'Héros',
        },
      }, 'fr');

      assert.equal(t('application.title'), 'Héros');
    });

    it('defaults the language to "en" when no language argument is given', () => {
      setLocale({});
      assert.equal(getCurrentLanguage(), 'en');
    });
  });

  describe('getLocale()', () => {
    it('returns the currently active locale object', () => {
      const locale = { application: { title: 'Test' } };
      setLocale(locale, 'en');
      assert.equal(getLocale(), locale);
    });
  });

  describe('getCurrentLanguage()', () => {
    it('returns the language code set via setLocale()', () => {
      setLocale({}, 'de');
      assert.equal(getCurrentLanguage(), 'de');
    });

    it('returns "en" after resetting to the English locale', () => {
      setLocale(enLocale, 'en');
      assert.equal(getCurrentLanguage(), 'en');
    });
  });
});
