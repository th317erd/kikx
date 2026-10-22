'use strict';

export const MOOD_MIN = -3;
export const MOOD_MAX = 3;
export const MOOD_BAD_MAX = -1;
export const MOOD_GOOD_MIN = 1;
export const MOOD_WORD_MAX_LENGTH = 32;

// The raw score is continuous; only the client renders it in three bands.
export function normalizeMood(value) {
  if (value == null || value === '')
    throw new TypeError('mood is required and must be a number from -3 to 3');

  let mood = Number(value);
  if (!Number.isFinite(mood))
    throw new TypeError('mood must be a finite number from -3 to 3');
  if (mood < MOOD_MIN || mood > MOOD_MAX)
    throw new TypeError('mood must be between -3 and 3');

  return mood;
}

export function normalizeMoodWord(value) {
  if (typeof value !== 'string' || value.trim() === '')
    throw new TypeError('moodWord is required and must be a single word');

  let word = value.trim();
  if (word.length > MOOD_WORD_MAX_LENGTH)
    throw new TypeError(`moodWord must be ${MOOD_WORD_MAX_LENGTH} characters or fewer`);
  if (/[\s]/u.test(word) || !/^[\p{L}][\p{L}'’\-]*$/u.test(word))
    throw new TypeError('moodWord must be a single word such as Elated, Happy, Meh, Cranky, or Stressed');

  return word;
}

export function moodBand(value) {
  let mood = Number(value);
  if (!Number.isFinite(mood))
    return '';

  if (mood < MOOD_BAD_MAX)
    return 'bad';
  if (mood > MOOD_GOOD_MIN)
    return 'good';
  return 'meh';
}
