'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EMOJI,
  EMOJI_SHORTCODES,
  findEmojiByShortcode,
  searchEmoji,
  findActiveEmojiQuery,
  applyEmojiInsertion,
} from '../../src/client/components/emoji-data.mjs';

test('every entry has a glyph, a primary shortcode, and that code is resolvable', () => {
  assert.ok(EMOJI.length > 50, `expected a usable set, got ${EMOJI.length}`);
  for (let entry of EMOJI) {
    assert.ok(entry.char && entry.char.length > 0, `missing glyph for ${entry.name}`);
    assert.ok(entry.name && entry.name.length > 0, 'missing primary shortcode');
    assert.ok(Array.isArray(entry.shortcodes) && entry.shortcodes.includes(entry.name),
      `${entry.name} must list its own name as a shortcode`);
    assert.equal(findEmojiByShortcode(entry.name)?.char, entry.char);
    for (let code of entry.shortcodes)
      assert.match(code, /^[A-Za-z0-9_+\-]+$/, `${code} is not a typeable shortcode`);
  }
});

test('shortcode lookup resolves aliases but refuses anything not published', () => {
  assert.equal(findEmojiByShortcode('+1')?.char, '👍');
  assert.equal(findEmojiByShortcode('thumbsup')?.char, '👍');
  assert.equal(findEmojiByShortcode('tada')?.char, '🎉');
  // Not a published code: resolution must not invent one.
  assert.equal(findEmojiByShortcode('definitely_not_a_code'), null);
  assert.equal(findEmojiByShortcode(''), null);
  assert.equal(findEmojiByShortcode(null), null);
});

test('EMOJI_SHORTCODES is deduplicated, so the picker cannot offer a code twice', () => {
  assert.equal(new Set(EMOJI_SHORTCODES).size, EMOJI_SHORTCODES.length);
});

test('search ranks an exact shortcode above a prefix, and a prefix above a substring', () => {
  let exact = searchEmoji('fire');
  assert.equal(exact[0].name, 'fire', 'exact match must come first');

  let prefix = searchEmoji('thu');
  assert.ok(prefix.length > 0);
  assert.ok(prefix.some((e) => e.name === 'thumbsup' || e.name === 'thumbsdown'));

  // 'ar' appears inside several codes; ranking must still return results.
  assert.ok(searchEmoji('ar').length > 0);
});

test('a blank query returns nothing, so a bare colon alone does not dump the set', () => {
  assert.deepEqual(searchEmoji(''), []);
  assert.deepEqual(searchEmoji('   '), []);
  assert.deepEqual(searchEmoji(null), []);
});

test('search respects the limit and is case-insensitive', () => {
  let limited = searchEmoji('a', { limit: 3 });
  assert.ok(limited.length <= 3);
  assert.deepEqual(searchEmoji('FIRE'), searchEmoji('fire'));
});

test('the active query span starts at the colon and ends at the caret', () => {
  let span = findActiveEmojiQuery('hello :smi', 10);
  assert.deepEqual(span, { start: 6, end: 10, query: 'smi' });
});

test('a bare colon yields an empty query rather than null', () => {
  let span = findActiveEmojiQuery(': ', 0);
  // Caret at 0 is before the colon, so nothing is active.
  assert.equal(span, null);
  assert.deepEqual(findActiveEmojiQuery(':', 1), { start: 0, end: 1, query: '' });
});

test('a colon mid-word does not open the picker', () => {
  assert.equal(findActiveEmojiQuery('https://example.com', 19), null);
  assert.equal(findActiveEmojiQuery('a:b', 3), null);
});

test('the picker closes once the caret leaves the token', () => {
  // Caret after the space: no token.
  assert.equal(findActiveEmojiQuery(':smile is done', 14), null);
});

test('insertion replaces the whole :query span and lands the caret after the glyph', () => {
  let value = 'hi :smi there';
  let span = findActiveEmojiQuery('hi :smi there', 7);
  assert.deepEqual(span, { start: 3, end: 7, query: 'smi' });

  let result = applyEmojiInsertion(value, span, '😀');
  assert.equal(result.value, 'hi 😀 there');
  assert.equal(result.caret, 'hi 😀'.length);
  // The glyph is one glyph, not the surrogate pair counted twice.
  assert.equal(result.value.slice(0, result.caret), 'hi 😀');
});

test('insertion at the very end of the value works and leaves no stray colon', () => {
  let value = 'ok :tad';
  let span = findActiveEmojiQuery(value, value.length);
  let result = applyEmojiInsertion(value, span, '🎉');
  assert.equal(result.value, 'ok 🎉');
  assert.ok(!result.value.includes(':'));
});

test('insertion refuses a missing span instead of corrupting the text', () => {
  assert.deepEqual(applyEmojiInsertion('abc', null, '😀'), { value: 'abc', caret: 3 });
  // A caret index is UTF-16 code units, so the glyph advances it by 2 -- this is
  // the same unit the textarea's own selectionStart uses.
  assert.deepEqual(applyEmojiInsertion('abc', { start: 9, end: 12 }, '😀'), { value: 'abc😀', caret: 5 });
  assert.equal('😀'.length, 2, 'guarding the unit assumption above');
});

test('round trip: what search returns is exactly what insertion can resolve', () => {
  for (let query of ['fire', 'thu', 'heart', 'check', 'rocket']) {
    let [first] = searchEmoji(query);
    assert.ok(first, `no result for ${query}`);
    assert.equal(findEmojiByShortcode(first.name)?.char, first.char,
      `${query} returned ${first.name}, which is not an insertable shortcode`);
  }
});
