'use strict';

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { t, setLocale, getLocale, getCurrentLanguage } from '../../src/client/lib/i18n.mjs';

beforeEach(() => {
  // Reset to a known locale
  setLocale({
    greeting:   'Hello',
    nested:     { deep: { value: 'Found it' } },
    withVar:    'Hello {name}!',
    multiVar:   '{a} and {b}',
    count:      { one: '{count} item', other: '{count} items' },
    onlyOther:  { other: '{count} things' },
    onlyOne:    { one: '1 thing' },
    plain:      'Just text',
  }, 'en');
});

// =============================================================================
// t() — basic key resolution
// =============================================================================

describe('i18n: t() basic resolution', { timeout: 5000 }, () => {
  it('should resolve a top-level key', () => {
    assert.equal(t('greeting'), 'Hello');
  });

  it('should resolve a nested key with dot notation', () => {
    assert.equal(t('nested.deep.value'), 'Found it');
  });

  it('should return key itself for missing key', () => {
    assert.equal(t('missing.key'), 'missing.key');
  });

  it('should return empty/falsy key as-is', () => {
    assert.equal(t(''), '');
    assert.equal(t(null), null);
    assert.equal(t(undefined), undefined);
  });

  it('should return key for partial nested path that hits non-object', () => {
    assert.equal(t('greeting.nonexistent'), 'greeting.nonexistent');
  });
});

// =============================================================================
// t() — interpolation
// =============================================================================

describe('i18n: t() interpolation', { timeout: 5000 }, () => {
  it('should interpolate a single variable', () => {
    assert.equal(t('withVar', { name: 'World' }), 'Hello World!');
  });

  it('should interpolate multiple variables', () => {
    assert.equal(t('multiVar', { a: 'Cats', b: 'Dogs' }), 'Cats and Dogs');
  });

  it('should preserve unmatched placeholders', () => {
    assert.equal(t('withVar', {}), 'Hello {name}!');
  });

  it('should handle undefined variables by preserving placeholder', () => {
    assert.equal(t('withVar', { name: undefined }), 'Hello {name}!');
  });

  it('should handle numeric variables', () => {
    assert.equal(t('withVar', { name: 42 }), 'Hello 42!');
  });

  it('should return raw string when no variables provided', () => {
    assert.equal(t('withVar'), 'Hello {name}!');
  });
});

// =============================================================================
// t() — pluralization
// =============================================================================

describe('i18n: t() pluralization', { timeout: 5000 }, () => {
  it('should use "one" form when count is 1', () => {
    assert.equal(t('count', { count: 1 }), '1 item');
  });

  it('should use "other" form when count is not 1', () => {
    assert.equal(t('count', { count: 5 }), '5 items');
  });

  it('should use "other" form when count is 0', () => {
    assert.equal(t('count', { count: 0 }), '0 items');
  });

  it('should fall back to "other" when "one" is missing', () => {
    assert.equal(t('onlyOther', { count: 1 }), '1 things');
  });

  it('should fall back to "one" when "other" is missing', () => {
    assert.equal(t('onlyOne', { count: 5 }), '1 thing');
  });

  it('should return key when object has no one/other and no count', () => {
    setLocale({ obj: { foo: 'bar' } }, 'en');
    assert.equal(t('obj'), 'obj');
  });
});

// =============================================================================
// setLocale / getLocale / getCurrentLanguage
// =============================================================================

describe('i18n: locale management', { timeout: 5000 }, () => {
  it('should set and get locale', () => {
    let locale = { test: 'value' };
    setLocale(locale, 'fr');

    assert.deepStrictEqual(getLocale(), locale);
    assert.equal(getCurrentLanguage(), 'fr');
  });

  it('should default language to "en" if not specified', () => {
    setLocale({ test: 'value' });
    assert.equal(getCurrentLanguage(), 'en');
  });

  it('should override previous locale', () => {
    setLocale({ a: '1' }, 'en');
    setLocale({ b: '2' }, 'de');

    assert.equal(t('a'), 'a');
    assert.equal(t('b'), '2');
    assert.equal(getCurrentLanguage(), 'de');
  });
});
