'use strict';

// A small, vendored emoji set for the composer's `:` typeahead.
//
// Deliberately hand-written rather than pulled from a dependency: package.json
// declares exactly one runtime dependency (`pg`), so a dataset package is not
// an option, and a generated multi-thousand-entry file would be unreviewable
// and would blow past the module size cap without adding anything a chat
// composer needs. This is the "what actually gets typed" set.
//
// Shape: { char, name, shortcodes[], keywords[] }
//   - `name`   is the primary shortcode, without the surrounding colons.
//   - `shortcodes` includes `name` plus accepted aliases, so `:+1:` and
//     `:thumbsup:` both resolve.
//   - `keywords` are extra search words that are NOT insertable shortcodes.
//
// Anything matched must be a real key of an entry (see `resolveEmojiShortcode`)
// so a query result can never insert a code the user did not type.

export const EMOJI = [
  { char: '😀', name: 'grinning', shortcodes: ['grinning'], keywords: ['smile', 'happy', 'face'] },
  { char: '😃', name: 'smiley', shortcodes: ['smiley'], keywords: ['happy', 'face'] },
  { char: '😄', name: 'smile', shortcodes: ['smile'], keywords: ['happy', 'face'] },
  { char: '😁', name: 'grin', shortcodes: ['grin'], keywords: ['happy', 'face'] },
  { char: '😆', name: 'laughing', shortcodes: ['laughing', 'satisfied'], keywords: ['lol', 'face'] },
  { char: '😅', name: 'sweat_smile', shortcodes: ['sweat_smile'], keywords: ['nervous', 'face'] },
  { char: '😂', name: 'joy', shortcodes: ['joy'], keywords: ['lol', 'tears', 'face'] },
  { char: '🙂', name: 'slight_smile', shortcodes: ['slight_smile'], keywords: ['smile', 'face'] },
  { char: '🙃', name: 'upside_down', shortcodes: ['upside_down'], keywords: ['silly', 'face'] },
  { char: '😉', name: 'wink', shortcodes: ['wink'], keywords: ['face'] },
  { char: '😊', name: 'blush', shortcodes: ['blush'], keywords: ['shy', 'happy', 'face'] },
  { char: '😇', name: 'innocent', shortcodes: ['innocent'], keywords: ['halo', 'face'] },
  { char: '🥲', name: 'smiling_face_with_tear', shortcodes: ['smiling_face_with_tear'], keywords: ['touched', 'face'] },
  { char: '😍', name: 'heart_eyes', shortcodes: ['heart_eyes'], keywords: ['love', 'face'] },
  { char: '🤩', name: 'star_struck', shortcodes: ['star_struck'], keywords: ['wow', 'face'] },
  { char: '😘', name: 'kissing_heart', shortcodes: ['kissing_heart'], keywords: ['love', 'face'] },
  { char: '😎', name: 'sunglasses', shortcodes: ['sunglasses'], keywords: ['cool', 'face'] },
  { char: '🤔', name: 'thinking', shortcodes: ['thinking'], keywords: ['hmm', 'face'] },
  { char: '🤨', name: 'raised_eyebrow', shortcodes: ['raised_eyebrow'], keywords: ['skeptical', 'face'] },
  { char: '😐', name: 'neutral_face', shortcodes: ['neutral_face'], keywords: ['meh', 'face'] },
  { char: '😑', name: 'expressionless', shortcodes: ['expressionless'], keywords: ['face'] },
  { char: '🙄', name: 'roll_eyes', shortcodes: ['roll_eyes'], keywords: ['whatever', 'face'] },
  { char: '😬', name: 'grimacing', shortcodes: ['grimacing'], keywords: ['awkward', 'face'] },
  { char: '😴', name: 'sleeping', shortcodes: ['sleeping'], keywords: ['tired', 'face'] },
  { char: '😭', name: 'sob', shortcodes: ['sob'], keywords: ['cry', 'sad', 'face'] },
  { char: '😤', name: 'triumph', shortcodes: ['triumph'], keywords: ['annoyed', 'face'] },
  { char: '😱', name: 'scream', shortcodes: ['scream'], keywords: ['shock', 'face'] },
  { char: '😳', name: 'flushed', shortcodes: ['flushed'], keywords: ['embarrassed', 'face'] },
  { char: '🥳', name: 'partying_face', shortcodes: ['partying_face'], keywords: ['celebrate', 'face'] },
  { char: '🤯', name: 'exploding_head', shortcodes: ['exploding_head'], keywords: ['mind', 'blown', 'face'] },
  { char: '😤', name: 'huff', shortcodes: ['huff'], keywords: ['annoyed'] },
  { char: '🫠', name: 'melting_face', shortcodes: ['melting_face'], keywords: ['hot', 'face'] },
  { char: '🤗', name: 'hugs', shortcodes: ['hugs'], keywords: ['embrace', 'face'] },
  { char: '🤫', name: 'shushing_face', shortcodes: ['shushing_face'], keywords: ['quiet', 'face'] },
  { char: '🤐', name: 'zipper_mouth', shortcodes: ['zipper_mouth'], keywords: ['quiet', 'face'] },
  { char: '😷', name: 'mask', shortcodes: ['mask'], keywords: ['sick', 'face'] },
  { char: '🤒', name: 'thermometer_face', shortcodes: ['thermometer_face'], keywords: ['sick', 'face'] },
  { char: '🤕', name: 'head_bandage', shortcodes: ['head_bandage'], keywords: ['hurt', 'face'] },
  { char: '🥹', name: 'holding_back_tears', shortcodes: ['holding_back_tears'], keywords: ['moved', 'face'] },
  { char: '😶', name: 'no_mouth', shortcodes: ['no_mouth'], keywords: ['speechless', 'face'] },
  { char: '😏', name: 'smirk', shortcodes: ['smirk'], keywords: ['face'] },
  { char: '😒', name: 'unamused', shortcodes: ['unamused'], keywords: ['meh', 'face'] },
  { char: '😞', name: 'disappointed', shortcodes: ['disappointed'], keywords: ['sad', 'face'] },
  { char: '😟', name: 'worried', shortcodes: ['worried'], keywords: ['face'] },
  { char: '😠', name: 'angry', shortcodes: ['angry'], keywords: ['mad', 'face'] },
  { char: '😡', name: 'rage', shortcodes: ['rage'], keywords: ['mad', 'face'] },
  { char: '🥺', name: 'pleading_face', shortcodes: ['pleading_face'], keywords: ['please', 'face'] },
  { char: '😢', name: 'cry', shortcodes: ['cry'], keywords: ['sad', 'face'] },
  { char: '🫡', name: 'saluting_face', shortcodes: ['saluting_face'], keywords: ['yes', 'sir', 'face'] },
  { char: '🤝', name: 'handshake', shortcodes: ['handshake'], keywords: ['deal', 'agree'] },
  { char: '👋', name: 'wave', shortcodes: ['wave'], keywords: ['hi', 'bye', 'hand'] },
  { char: '👍', name: 'thumbsup', shortcodes: ['thumbsup', '+1'], keywords: ['yes', 'ok', 'hand'] },
  { char: '👎', name: 'thumbsdown', shortcodes: ['thumbsdown', '-1'], keywords: ['no', 'hand'] },
  { char: '👌', name: 'ok_hand', shortcodes: ['ok_hand'], keywords: ['ok', 'hand'] },
  { char: '🙏', name: 'pray', shortcodes: ['pray'], keywords: ['thanks', 'please', 'hands'] },
  { char: '👏', name: 'clap', shortcodes: ['clap'], keywords: ['applause', 'hands'] },
  { char: '🙌', name: 'raised_hands', shortcodes: ['raised_hands'], keywords: ['yay', 'hands'] },
  { char: '🤞', name: 'crossed_fingers', shortcodes: ['crossed_fingers'], keywords: ['luck', 'hand'] },
  { char: '✌️', name: 'v', shortcodes: ['v', 'victory'], keywords: ['peace', 'hand'] },
  { char: '🤙', name: 'call_me_hand', shortcodes: ['call_me_hand'], keywords: ['phone', 'hand'] },
  { char: '👀', name: 'eyes', shortcodes: ['eyes'], keywords: ['look', 'watch'] },
  { char: '🧠', name: 'brain', shortcodes: ['brain'], keywords: ['think', 'smart'] },
  { char: '💡', name: 'bulb', shortcodes: ['bulb'], keywords: ['idea', 'light'] },
  { char: '🔥', name: 'fire', shortcodes: ['fire', 'flame'], keywords: ['hot', 'lit'] },
  { char: '💯', name: '100', shortcodes: ['100'], keywords: ['perfect', 'score'] },
  { char: '✅', name: 'white_check_mark', shortcodes: ['white_check_mark', 'check'], keywords: ['done', 'yes', 'tick'] },
  { char: '☑️', name: 'ballot_box_with_check', shortcodes: ['ballot_box_with_check'], keywords: ['done'] },
  { char: '❌', name: 'x', shortcodes: ['x'], keywords: ['no', 'cross', 'fail'] },
  { char: '⚠️', name: 'warning', shortcodes: ['warning'], keywords: ['caution', 'alert'] },
  { char: '🚨', name: 'rotating_light', shortcodes: ['rotating_light'], keywords: ['alarm', 'alert'] },
  { char: '❓', name: 'question', shortcodes: ['question'], keywords: ['ask', 'help'] },
  { char: '❗', name: 'exclamation', shortcodes: ['exclamation'], keywords: ['important', 'bang'] },
  { char: '💬', name: 'speech_balloon', shortcodes: ['speech_balloon'], keywords: ['chat', 'talk'] },
  { char: '📝', name: 'memo', shortcodes: ['memo', 'pencil'], keywords: ['note', 'write'] },
  { char: '📌', name: 'pushpin', shortcodes: ['pushpin'], keywords: ['pin', 'important'] },
  { char: '📎', name: 'paperclip', shortcodes: ['paperclip'], keywords: ['attach'] },
  { char: '🔗', name: 'link', shortcodes: ['link'], keywords: ['url', 'chain'] },
  { char: '🔍', name: 'mag', shortcodes: ['mag', 'search'], keywords: ['find', 'zoom'] },
  { char: '⚙️', name: 'gear', shortcodes: ['gear'], keywords: ['settings', 'config'] },
  { char: '🛠️', name: 'hammer_and_wrench', shortcodes: ['hammer_and_wrench'], keywords: ['tools', 'fix'] },
  { char: '🔧', name: 'wrench', shortcodes: ['wrench'], keywords: ['fix', 'tool'] },
  { char: '🐛', name: 'bug', shortcodes: ['bug'], keywords: ['issue', 'defect'] },
  { char: '🚀', name: 'rocket', shortcodes: ['rocket'], keywords: ['ship', 'launch', 'fast'] },
  { char: '⚡', name: 'zap', shortcodes: ['zap'], keywords: ['fast', 'power', 'lightning'] },
  { char: '⏳', name: 'hourglass', shortcodes: ['hourglass'], keywords: ['wait', 'time'] },
  { char: '⏰', name: 'alarm_clock', shortcodes: ['alarm_clock'], keywords: ['time', 'clock'] },
  { char: '📅', name: 'date', shortcodes: ['date'], keywords: ['calendar', 'day'] },
  { char: '📊', name: 'bar_chart', shortcodes: ['bar_chart'], keywords: ['stats', 'data'] },
  { char: '📈', name: 'chart_with_upwards_trend', shortcodes: ['chart_with_upwards_trend'], keywords: ['growth', 'stats'] },
  { char: '📉', name: 'chart_with_downwards_trend', shortcodes: ['chart_with_downwards_trend'], keywords: ['decline', 'stats'] },
  { char: '🗑️', name: 'wastebasket', shortcodes: ['wastebasket', 'trash'], keywords: ['delete', 'remove'] },
  { char: '💾', name: 'floppy_disk', shortcodes: ['floppy_disk'], keywords: ['save'] },
  { char: '📁', name: 'file_folder', shortcodes: ['file_folder'], keywords: ['directory', 'files'] },
  { char: '📄', name: 'page_facing_up', shortcodes: ['page_facing_up'], keywords: ['document', 'file'] },
  { char: '🤖', name: 'robot', shortcodes: ['robot'], keywords: ['bot', 'ai'] },
  { char: '👾', name: 'space_invader', shortcodes: ['space_invader'], keywords: ['game', 'alien'] },
  { char: '🎉', name: 'tada', shortcodes: ['tada'], keywords: ['party', 'celebrate'] },
  { char: '🎊', name: 'confetti_ball', shortcodes: ['confetti_ball'], keywords: ['party', 'celebrate'] },
  { char: '🏆', name: 'trophy', shortcodes: ['trophy', 'trophy_1st'], keywords: ['win', 'prize'] },
  { char: '⭐', name: 'star', shortcodes: ['star'], keywords: ['favorite'] },
  { char: '🌟', name: 'star2', shortcodes: ['star2', 'sparkle'], keywords: ['favorite', 'shine'] },
  { char: '✨', name: 'sparkles', shortcodes: ['sparkles'], keywords: ['new', 'shine'] },
  { char: '❤️', name: 'heart', shortcodes: ['heart'], keywords: ['love', 'red'] },
  { char: '💔', name: 'broken_heart', shortcodes: ['broken_heart'], keywords: ['sad', 'love'] },
  { char: '💙', name: 'blue_heart', shortcodes: ['blue_heart'], keywords: ['love'] },
  { char: '💚', name: 'green_heart', shortcodes: ['green_heart'], keywords: ['love'] },
  { char: '💛', name: 'yellow_heart', shortcodes: ['yellow_heart'], keywords: ['love'] },
  { char: '💜', name: 'purple_heart', shortcodes: ['purple_heart'], keywords: ['love'] },
  { char: '☕', name: 'coffee', shortcodes: ['coffee'], keywords: ['drink', 'break'] },
  { char: '🍕', name: 'pizza', shortcodes: ['pizza'], keywords: ['food'] },
  { char: '🍺', name: 'beer', shortcodes: ['beer'], keywords: ['drink', 'cheers'] },
  { char: '🎯', name: 'dart', shortcodes: ['dart', 'target'], keywords: ['goal', 'aim'] },
  { char: '🧹', name: 'broom', shortcodes: ['broom'], keywords: ['clean', 'sweep'] },
  { char: '🪄', name: 'magic_wand', shortcodes: ['magic_wand'], keywords: ['magic'] },
  { char: '😈', name: 'smiling_imp', shortcodes: ['smiling_imp'], keywords: ['devil', 'face'] },
  { char: '👻', name: 'ghost', shortcodes: ['ghost'], keywords: ['spooky'] },
  { char: '💤', name: 'zzz', shortcodes: ['zzz'], keywords: ['sleep', 'tired'] },
];

// A stable list of every insertable shortcode, so shortcode resolution is a
// pure lookup and cannot depend on the query that produced it.
const BY_SHORTCODE = new Map();
for (let entry of EMOJI) {
  for (let code of entry.shortcodes) {
    if (!BY_SHORTCODE.has(code))
      BY_SHORTCODE.set(code, entry);
  }
}

export const EMOJI_SHORTCODES = [...BY_SHORTCODE.keys()];

export function findEmojiByShortcode(shortcode) {
  if (typeof shortcode !== 'string')
    return null;
  return BY_SHORTCODE.get(shortcode) || null;
}

// Rank: exact shortcode > shortcode prefix > keyword prefix > substring.
// Returns at most `limit` entries. A blank query yields nothing, because the
// picker only exists once the user has typed a colon.
export function searchEmoji(query, { limit = 8 } = {}) {
  let needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (!needle)
    return [];

  let scored = [];
  for (let entry of EMOJI) {
    let best = null;
    for (let code of entry.shortcodes) {
      if (code === needle) {
        best = 0;
        break;
      }
      if (code.startsWith(needle))
        best = best === null ? 1 : Math.min(best, 1);
      else if (code.includes(needle))
        best = best === null ? 3 : Math.min(best, 3);
    }
    for (let word of entry.keywords) {
      if (word === needle)
        best = best === null ? 2 : Math.min(best, 2);
      else if (word.startsWith(needle))
        best = best === null ? 2 : Math.min(best, 2);
    }
    if (best !== null)
      scored.push({ entry, rank: best, code: entry.name });
  }

  scored.sort((a, b) => a.rank - b.rank || a.code.localeCompare(b.code));
  return scored.slice(0, Math.max(0, limit)).map((row) => row.entry);
}

// Finds the `:token` the caret currently sits inside, if any.
//
// Returns { start, end, query } where the span is what a selection must
// replace: `start` is the index of the colon itself. Returns null when the
// caret is not in a shortcode, which is the common case and must be cheap.
export function findActiveEmojiQuery(value, caret) {
  if (typeof value !== 'string')
    return null;

  let at = Number.isInteger(caret) ? caret : value.length;
  if (at < 0)
    at = 0;
  if (at > value.length)
    at = value.length;

  // Shortcodes are letters, digits, underscore, plus and minus: that covers
  // `+1`, `-1` and `white_check_mark` without admitting spaces.
  let start = at - 1;
  while (start >= 0 && /[A-Za-z0-9_+\-]/.test(value[start]))
    start -= 1;

  if (start < 0 || value[start] !== ':')
    return null;

  // A colon must begin the token: `https://x` has a colon mid-word and must not
  // open the picker, so require a boundary before it.
  let before = start - 1;
  if (before >= 0 && !/[\s(\[{]/.test(value[before]))
    return null;

  let query = value.slice(start + 1, at);
  // An empty query is legal: typing just `:` should offer the popular set.
  if (query.length > 32)
    return null;

  return { start, end: at, query };
}

// Replaces the active `:query` span with `char` and places the caret after it.
// Pure string maths so the unit lane can assert caret placement even though
// mini-dom has no textarea selection model.
export function applyEmojiInsertion(value, span, char) {
  let text = typeof value === 'string' ? value : '';
  if (!span || typeof char !== 'string' || !char)
    return { value: text, caret: text.length };

  let start = Math.max(0, Math.min(span.start, text.length));
  let end = Math.max(start, Math.min(span.end, text.length));
  let next = text.slice(0, start) + char + text.slice(end);
  return { value: next, caret: start + char.length };
}

// A short "most typed" set for a bare colon. The owner asked for a picker that
// opens when they type `:`, so an empty query must offer something instead of
// rendering an empty box; these are the codes chat users reach for first.
export const POPULAR_EMOJI = [
  'thumbsup', 'heart', 'joy', 'tada', 'fire', 'rocket', 'eyes', 'wave',
  'smile', '100', 'pray', 'warning',
];

// Query entry point for the picker. Differs from `searchEmoji` in exactly one
// way: a blank query returns POPULAR_EMOJI rather than nothing. `searchEmoji`
// stays blank-in/blank-out because it is also the shortcode search surface, and
// "no query" must not read as "match everything" there.
export function suggestEmoji(query, { limit = 12 } = {}) {
  let needle = typeof query === 'string' ? query.trim() : '';
  if (needle)
    return searchEmoji(needle, { limit });

  let out = [];
  for (let code of POPULAR_EMOJI) {
    let entry = findEmojiByShortcode(code);
    if (entry && !out.includes(entry))
      out.push(entry);
  }
  return out.slice(0, Math.max(0, limit));
}
