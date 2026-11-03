'use strict';

/**
 * Recurrence rules for recurring timers.
 *
 * VOCABULARY — structured rules, not cron (option (a) of the owner's question;
 * everything outside this file is vocabulary-independent, so a later choice of
 * cron reduces to a second parser feeding `normalizeRecurringRule`):
 *
 *   { type: 'every',  n, unit: 'minute'|'hour'|'day'|'week', anchorAt, timezone? }
 *   { type: 'daily',  time: 'HH:MM', timezone? }
 *   { type: 'weekly', time: 'HH:MM', days: [0..6], timezone? }   // 0 = Sunday
 *
 * `timezone` is an IANA name; daily/weekly fire at the EXACT wall-clock time in
 * that zone, preserved across DST transitions (that is the owner's "exact
 * specified recurring time"). `every` interval rules are FIXED-LENGTH from
 * `anchorAt`: an 'every 1 day' anchored at 09:00 shifts its local wall-clock
 * time across a DST transition. Deliberate v1 limit — use daily/weekly when the
 * exact local time matters.
 *
 * All returned instants are epoch MILLISECONDS. Conversion to the queue's
 * microseconds happens exactly once, in armRecurringTimer via toScheduledAt —
 * the unit trap documented there (ms written where µs is read schedules the
 * year 57,000, silently) applies to every value flowing through this module.
 */

export const DEFAULT_TIMEZONE = 'UTC';

const UNIT_SPAN_MS = {
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
};

/** IANA zone or the default; an invalid zone is rejected (null), never guessed. */
export function normalizeTimezone(value) {
  if (value == null || value === '')
    return DEFAULT_TIMEZONE;

  if (typeof value !== 'string')
    return null;

  try {
    // Constructor throws RangeError on an unknown zone — that is the validation.
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return value;
  } catch (_error) {
    return null;
  }
}

/** 'HH:MM' (or an already-normalized {hh,mm}) → {hh,mm}; null when invalid. */
export function normalizeWallClock(value) {
  let hh = null;
  let mm = null;

  if (value && typeof value === 'object') {
    // Re-normalizing an already-normalized rule must be a no-op: the tool layer
    // and nextOccurrence() both call normalizeRecurringRule().
    hh = Number(value.hh);
    mm = Number(value.mm);
  } else {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
    if (!match)
      return null;

    hh = Number(match[1]);
    mm = Number(match[2]);
  }

  if (!Number.isInteger(hh) || !Number.isInteger(mm))
    return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59)
    return null;

  return { hh, mm };
}

/**
 * Validate and canonicalize a rule. Returns null for anything invalid —
 * callers treat null as "refuse to arm", never as "guess a schedule".
 * Idempotent: normalizing a normalized rule returns an equal rule.
 */
export function normalizeRecurringRule(rule, { anchorAt = null } = {}) {
  if (!rule || typeof rule !== 'object')
    return null;

  const timezone = normalizeTimezone(rule.timezone);
  if (!timezone)
    return null;

  if (rule.type === 'every') {
    const n = Number(rule.n);
    const unit = String(rule.unit ?? '').toLowerCase();
    const anchor = Number(rule.anchorAt ?? anchorAt);

    if (!UNIT_SPAN_MS[unit])
      return null;
    if (!Number.isFinite(n) || n < 1 || Math.trunc(n) !== n)
      return null;
    if (!Number.isFinite(anchor) || anchor <= 0)
      return null;

    return { type: 'every', n, unit, anchorAt: anchor, timezone };
  }

  if (rule.type === 'daily') {
    const time = normalizeWallClock(rule.time);
    if (!time)
      return null;

    return { type: 'daily', time, timezone };
  }

  if (rule.type === 'weekly') {
    const time = normalizeWallClock(rule.time);
    if (!time)
      return null;

    const days = [ ...new Set((Array.isArray(rule.days) ? rule.days : []).map(Number)) ]
      .filter((day) => Number.isInteger(day) && day >= 0 && day <= 6)
      .sort((a, b) => a - b);
    if (days.length === 0)
      return null;

    return { type: 'weekly', time, days, timezone };
  }

  return null;
}

const formatterCache = new Map();

function partsFormatter(tz) {
  let formatter = formatterCache.get(tz);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(tz, formatter);
  }

  return formatter;
}

/** Wall-clock parts of `utcMs` as seen in `tz`. */
function localParts(tz, utcMs) {
  const parts = partsFormatter(tz).formatToParts(new Date(utcMs));
  const values = {};
  for (const part of parts) {
    if (part.type !== 'literal')
      values[part.type] = part.value;
  }

  return {
    y: Number(values.year),
    m: Number(values.month),
    d: Number(values.day),
    hh: Number(values.hour) % 24,
    mm: Number(values.minute),
  };
}

/** Zone offset (ms) in effect at `utcMs`, to minute granularity. */
function timezoneOffsetMs(tz, utcMs) {
  const local = localParts(tz, utcMs);
  const utcMinute = utcMs - (utcMs % 60_000);
  const asIfUTC = Date.UTC(local.y, local.m - 1, local.d, local.hh, local.mm, 0);
  return asIfUTC - utcMinute;
}

/**
 * Local wall-clock date/time in `tz` → the UTC instant. Resolved twice so a DST
 * transition between the naive instant and the true one settles: the classic
 * one-pass offset read is wrong exactly at transitions.
 *
 * A wall-clock time that does not exist (spring-forward gap, e.g. 02:30 on a
 * 02:00→03:00 day) resolves to the instant the arithmetic lands on; v1 does not
 * invent a substitute time. Documented, not silently "fixed".
 */
function utcFromLocal(tz, y, m, d, hh, mm) {
  const naive = Date.UTC(y, m - 1, d, hh, mm, 0);
  const offset = timezoneOffsetMs(tz, naive);
  let instant = naive - offset;
  const refined = timezoneOffsetMs(tz, instant);
  if (refined !== offset)
    instant = naive - refined;

  return instant;
}

/**
 * The next occurrence strictly after `afterMs` (epoch ms), or null when the
 * rule can never fire again (currently: never for valid rules — null means
 * invalid input, and callers refuse to arm rather than arm "soon").
 *
 * Re-normalizes its input so callers may pass either a raw or an already
 * normalized rule; `timezone` (if given) overrides the rule's own zone.
 */
export function nextOccurrence(rule, afterMs, timezone = null) {
  const normalized = normalizeRecurringRule(
    timezone != null ? { ...rule, timezone } : rule,
  );
  if (!normalized)
    return null;

  const after = Number(afterMs);
  if (!Number.isFinite(after))
    return null;

  if (normalized.type === 'every') {
    if (normalized.anchorAt > after)
      return normalized.anchorAt;

    const span = UNIT_SPAN_MS[normalized.unit] * normalized.n;
    const steps = Math.floor((after - normalized.anchorAt) / span) + 1;
    const next = normalized.anchorAt + steps * span;
    return next > after ? next : null;
  }

  // daily/weekly: enumerate calendar days starting from the local date of
  // `after`. Day advancement happens in UTC-anchored calendar arithmetic
  // (Date.UTC normalizes overflow), which has no DST of its own; only the
  // final wall-clock → instant conversion is zone-aware.
  const base = localParts(normalized.timezone, after);
  for (let i = 0; i < 14; i++) {
    const date = new Date(Date.UTC(base.y, base.m - 1, base.d + i));
    if (normalized.type === 'weekly'
      && !normalized.days.includes(date.getUTCDay()))
      continue;

    const candidate = utcFromLocal(
      normalized.timezone,
      date.getUTCFullYear(),
      date.getUTCMonth() + 1,
      date.getUTCDate(),
      normalized.time.hh,
      normalized.time.mm,
    );
    if (candidate > after)
      return candidate;
  }

  return null;
}
