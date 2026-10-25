'use strict';

// Server-side frame-window filtering.
//
// The frame filter popup is a visibility control, but it also has to be a
// transport control. The client only ever holds a window into a session
// (`listFrameWindow` returns a bounded tail page), so a predicate that runs in
// the browser cannot answer "are there matches I have not loaded yet" — it
// would report an empty filtered thread while matching frames sit unread on
// disk, and "load older" would page through raw rows instead of matching ones.
//
// Everything here therefore runs inside the store, before the window is
// trimmed. This module is deliberately free of store access so it can be
// tested without a database instance; `frame-store-preview.mjs` owns the scan.
//
// Two predicates exist and they must agree:
//   - `frameMatchesWindowFilters` runs on a hydrated frame (needs `content`).
//   - `pathMatchesWindowFilters` is a prefilter on the frame *path*. The path
//     encodes the frame type (`<order>-<type>-<id>.json`), so type selection
//     can be resolved without reading a single frame body. Anything the path
//     cannot express (session references, text search, soft-deletion) is left
//     to the hydrated predicate — the path prefilter may only ever be used in
//     the "definitely cannot match" direction, never as proof of a match.

// Rows in the popup, in display order. `kind: 'category'` rows are the
// frame-kind selectors; `kind: 'gate'` rows widen what is visible rather than
// selecting a kind, so they are excluded from the pinned "all" toggle.
export const FRAME_FILTER_ROWS = Object.freeze([
  Object.freeze({ key: 'user', label: 'User', kind: 'category' }),
  Object.freeze({ key: 'agent', label: 'Agent', kind: 'category' }),
  Object.freeze({ key: 'question', label: 'Question', kind: 'category' }),
  Object.freeze({ key: 'session', label: 'Child Sessions', kind: 'category' }),
  Object.freeze({ key: 'tools', label: 'Tools', kind: 'category' }),
  Object.freeze({ key: 'commands', label: 'Commands', kind: 'category' }),
  Object.freeze({ key: 'compaction', label: 'Compaction', kind: 'category' }),
  Object.freeze({ key: 'deleted', label: 'Deleted', kind: 'gate' }),
]);

export const FRAME_FILTER_CATEGORY_KEYS = Object.freeze(
  FRAME_FILTER_ROWS.filter((row) => row.kind === 'category').map((row) => row.key),
);

export const FRAME_FILTER_GATE_KEYS = Object.freeze(
  FRAME_FILTER_ROWS.filter((row) => row.kind === 'gate').map((row) => row.key),
);

export const FRAME_FILTER_KEYS = Object.freeze(FRAME_FILTER_ROWS.map((row) => row.key));

// ---------------------------------------------------------------------------
// Frame taxonomy, decided from the type name
// ---------------------------------------------------------------------------
//
// The persisted frame type IS the filename segment in
// `<order>-<type>-<id>.json`, and the persisted types are informative:
// `UserMessage`, `UserDraft`, `AgentMessage`, `AgentProgress`, `Question`,
// `CompactionFrame`, `CommandResult`, `Session`, plus one `<Name>ToolFrame` per
// registered tool (`ShellToolFrame`, `ReadFileToolFrame`, `ExecGrepToolFrame`,
// and so on — 45 distinct types in one live session).
//
// Classifying on an enumerated list of abstract names was wrong: it named only
// `ToolCall`/`ToolResult`/`CommandResult`, while live sessions persist concrete
// `<Name>ToolFrame` records. A session holding 12,564 ShellToolFrame rows
// reported Tools = 0 and Commands = 0. So tool types are matched by shape, not
// by allowlist, and a newly registered tool is classified the day it is
// written rather than the day somebody updates a table here.

// A tool frame is either abstract (`ToolCall`/`ToolResult`) or one of the
// concrete `<Name>ToolFrame` records. The path cannot see `content.phase`, so
// the call and result halves are not distinguished: both belong to the same
// row, and splitting them would make a count depend on hydration.
export function isToolFrameType(type) {
  let value = String(type || '');
  if (value === 'ToolCall' || value === 'ToolResult')
    return true;

  return /ToolFrame$/.test(value);
}

// Commands are a *view* over tool frames, not a disjoint type: the thread
// renders a shell tool result as the command that produced it. Keeping this
// separate from `tools` lets Ctrl+Click on Commands show command frames only,
// while Tools still reaches the file, search and session tools.
//
// Two type generations carry a command in this store: the concrete
// `ShellToolFrame` records that live sessions persist, and the older abstract
// `CommandResult` that predates them. Naming only the concrete type left every
// historical command frame in no category at all, so it was invisible under
// every selection -- present in the session, absent from the panel.
export function isCommandFrameType(type) {
  let value = String(type || '');
  return value === 'ShellToolFrame' || value === 'CommandResult';
}

// `MessageDone` and `phantom` frames are transport bookkeeping that the client
// has never rendered, so they are not a category and never become visible.
const NEVER_VISIBLE_TYPES = Object.freeze(new Set(['MessageDone']));

export const isNeverVisibleType = (type) => NEVER_VISIBLE_TYPES.has(String(type || ''));

// The categories a frame type belongs to, in popup display order so callers
// never depend on Set insertion order and a frame's primary category leads.
//
// `session` is deliberately *not* derived here: a frame can link to a session
// from `content.references` or `content.sessionID`, which the path cannot see.
// Those frames are added by the hydrated predicate.
export function frameCategoriesFromType(type) {
  let value = String(type || '');
  if (value === '')
    return [];

  let keys = new Set();

  // Author is not on the path, so these are decided by type. `UserDraft` is
  // user-authored; agent prose and agent progress are both agent output.
  if (value === 'UserMessage' || value === 'UserDraft')
    keys.add('user');
  if (value === 'AgentMessage' || value === 'AgentProgress')
    keys.add('agent');
  if (value === 'Question')
    keys.add('question');
  if (value === 'Session' || value === 'SessionSpawn')
    keys.add('session');
  if (value === 'CompactionFrame')
    keys.add('compaction');
  if (isCommandFrameType(value))
    keys.add('commands');
  if (isToolFrameType(value))
    keys.add('tools');

  return FRAME_FILTER_CATEGORY_KEYS.filter((key) => keys.has(key));
}

export const DEFAULT_FRAME_QUERY = '';

// Categories default ON and the deleted gate defaults OFF: `hidden`/`deleted`
// producers are mostly internal bookkeeping (drafts, frame groups, deadline
// schedules, undispatched invites), and dumping those into every thread by
// default would be a regression, not a feature.
export function defaultFrameWindowFilters() {
  let filters = {};
  for (let row of FRAME_FILTER_ROWS)
    filters[row.key] = row.kind === 'category';

  return filters;
}

export function normalizeFrameQuery(value) {
  if (typeof value !== 'string')
    return DEFAULT_FRAME_QUERY;

  return value.trim().replace(/\s+/g, ' ').slice(0, 200);
}

// Coerce an untrusted filter object into a complete, known-key-only shape.
// A present key keeps its boolean; a missing or non-boolean key falls back to
// its default. Unknown keys are dropped so a stale client cannot smuggle in a
// category the server does not understand.
export function normalizeWindowFilters(input) {
  let defaults = defaultFrameWindowFilters();
  let filters = {};
  let source = input && typeof input === 'object' ? input : {};

  for (let key of FRAME_FILTER_KEYS) {
    let value = source[key];
    filters[key] = typeof value === 'boolean' ? value : defaults[key];
  }

  return filters;
}

// True when the filter set asks for exactly what an unfiltered window already
// returns. Callers use this to skip the scanning path entirely, so the default
// view keeps its current cost.
export function windowFiltersAreDefault(filters, query = DEFAULT_FRAME_QUERY) {
  if (normalizeFrameQuery(query) !== DEFAULT_FRAME_QUERY)
    return false;

  let normal = normalizeWindowFilters(filters);
  let defaults = defaultFrameWindowFilters();

  for (let key of FRAME_FILTER_KEYS) {
    if (normal[key] !== defaults[key])
      return false;
  }

  return true;
}

// A type-level admission test for a filter set, or null when the set cannot be
// decided from the type alone.
//
// `session` is not path-expressible: a UserMessage or ToolResult that merely
// references a child session belongs under Child Sessions, and only the body
// says so. Selecting it therefore disables the prefilter rather than silently
// hiding those frames.
//
// Returning null means "no constraint": the caller must hydrate and run the
// full predicate. An empty selection admits no type at all, so every frame is
// rejected.
export function frameTypeMatcherForFilters(filters) {
  let normal = normalizeWindowFilters(filters);

  let selected = FRAME_FILTER_CATEGORY_KEYS.filter((key) => normal[key] === true);
  if (selected.length === 0)
    return () => false;

  if (selected.includes('session'))
    return null;

  // Tools/commands overlap with each other but neither overlaps the remaining
  // kinds, so the selected set is a faithful union of type predicates.
  return (type) => {
    let categories = frameCategoriesFromType(type);
    if (categories.length === 0)
      return false;

    return categories.some((key) => normal[key] === true);
  };
}

export function frameTypeFromPath(path) {
  let name = String(path || '').split('/').pop() || '';
  let match = /^\d+-([^-]+)-/.exec(name);
  return match ? match[1] : '';
}

// A path-level "cannot possibly match" test. Returning false is final;
// returning true only means the path does not *exclude* the frame.
export function pathMatchesWindowFilters(path, filters, query = DEFAULT_FRAME_QUERY) {
  let type = frameTypeFromPath(path);
  if (type === '')
    return false;
  if (isNeverVisibleType(type))
    return false;

  let matcher = frameTypeMatcherForFilters(filters);
  if (matcher && !matcher(type))
    return false;

  // A text query is answered from frame bodies, so the path can never rule a
  // frame in; it stays neutral here.
  return true;
}

// A frame references a child session when one of its references names a
// session AND carries an id. A reference object with a blank id is a stub, not
// a link, and must not make a message appear under Child Sessions.
export function frameReferencesSession(frame) {
  let references = frame?.content?.references;
  if (!Array.isArray(references))
    return false;

  return references.some((reference) => {
    if (reference?.type !== 'session')
      return false;

    // A *blank* id is a stub and must not count as a link. A *missing* id still
    // names a child session: the reference declared its own type, and demanding
    // the id as well silently dropped those links from the Child Sessions row.
    if (typeof reference.id === 'string')
      return reference.id.trim() !== '';

    return reference.id === undefined || reference.id === null;
  });
}

// A tool result can also raise a session without a `references` entry: it
// records the new session's id directly.
export function frameSpawnsSession(frame) {
  if (!isToolFrameType(frame?.type))
    return false;

  let content = frame.content;
  if (!content || typeof content !== 'object')
    return false;

  return typeof content.sessionID === 'string' && content.sessionID.trim() !== '';
}

// Frame types whose category set is decided partly by *who wrote them* rather
// than by the type alone. Only prose is included: a tool frame's author is the
// agent, but its row is Tools, not Agent.
const AUTHORED_TYPES = Object.freeze(new Set([
  'UserMessage',
  'UserDraft',
  'AgentMessage',
  'AgentProgress',
  'Question',
]));

// A hydrated frame's categories: the type-derived set plus the two body-only
// ways a frame can belong to Child Sessions.
export function frameFilterCategories(frame) {
  if (!frame)
    return [];

  let keys = new Set(frameCategoriesFromType(frame.type));

  // Author joins the type-derived set, so a Question asked by an agent belongs
  // under Question *and* Agent. Categories are ANY-of, so that is not a
  // conflict: either row shows the frame.
  //
  // This is restricted to frames whose content is authored prose. A tool frame
  // also records `authorType: 'agent'`, and taking it at face value would mean
  // 'agent' matched all 919 tool frames in a real 17,968-frame session -- so
  // isolating Agent would silently also show Tools, and unchecking Tools would
  // change nothing. Tools and Commands already name those frames.
  let author = typeof frame.authorType === 'string' ? frame.authorType : '';
  if ((author === 'user' || author === 'agent') && AUTHORED_TYPES.has(String(frame.type || '')))
    keys.add(author);

  if (frameReferencesSession(frame) || frameSpawnsSession(frame))
    keys.add('session');

  return FRAME_FILTER_CATEGORY_KEYS.filter((key) => keys.has(key));
}

// The concrete frame types each category can be narrowed to on the server.
//
// A `null` result means "no type constraint": the category depends on the body
// (Child Sessions also matches frames that merely *reference* a session, which a
// filename cannot express), or every category is on and there is nothing to
// narrow. An empty array is different from null — it means the selection admits
// no type at all, so every frame is rejected without reading a single body.
//
// Kept as data rather than an allowlist of abstract names because the persisted
// types are concrete (`<Name>ToolFrame`), and a newly registered tool must be
// classified the day it is written.
const SINGLE_TYPE_CATEGORIES = Object.freeze({
  user: Object.freeze([ 'UserMessage', 'UserDraft' ]),
  agent: Object.freeze([ 'AgentMessage', 'AgentProgress' ]),
  question: Object.freeze([ 'Question' ]),
  compaction: Object.freeze([ 'CompactionFrame' ]),
});

export function frameTypesForFilters(filters) {
  let normal = normalizeWindowFilters(filters);

  let selected = FRAME_FILTER_CATEGORY_KEYS.filter((key) => normal[key] === true);
  if (selected.length === 0)
    return [];

  // Two categories cannot be narrowed to a type list at all:
  //
  //   - `session` is decided by frame *content* (a message that merely
  //     references a child session), which a filename cannot express.
  //   - `tools` and `commands` are matched by *shape* (`<Name>ToolFrame`), and
  //     live sessions persist concrete types like `ShellToolFrame`. Enumerating
  //     `ToolCall`/`ToolResult` here would reject every real tool frame and
  //     reproduce the exact "Tools = 0 on a 12,564-row session" defect this
  //     module exists to fix. A newly registered tool must not need a code
  //     change to stay visible.
  // `commands` sits on this side of the line for the same reason as `tools`:
  // it is a *shape* (a tool frame that ran a command), not a closed list of
  // names. Enumerating `ShellToolFrame` here would reject the older
  // `CommandResult` frames and any future command-bearing type -- the same
  // defect, a filter that hides real frames, wearing a different row.
  if (selected.includes('session') || selected.includes('tools') || selected.includes('commands'))
    return null;

  // Nothing is selected out: the widest possible set is every type, which the
  // directory glob already expresses, so a constraint would only cost a scan.
  if (selected.length === FRAME_FILTER_CATEGORY_KEYS.length)
    return null;

  let types = new Set();
  for (let key of selected) {
    let list = SINGLE_TYPE_CATEGORIES[key];
    if (list)
      for (let type of list)
        types.add(type);
  }

  return [ ...types ].sort();
}

// A path-level rejection test. Returning false is final; returning true only
// means the path does not *exclude* the frame. `null` types means unconstrained.
export function pathMatchesTypes(path, types) {
  if (types == null)
    return true;

  if (!Array.isArray(types) || types.length === 0)
    return false;

  let type = frameTypeFromPath(path);
  if (type === '')
    return false;

  return types.includes(type);
}

// Wildcard matcher for the generalized frame search.
//
// `*` matches any run of characters; everything else is literal. Multiple
// segments must appear in order (so `tool*call` matches "ToolCall"), and a
// query with no wildcard is a plain case-insensitive substring test.
export function frameQueryMatchesText(text, query) {
  let needle = normalizeFrameQuery(query).toLowerCase();
  if (needle === '')
    return true;

  let haystack = String(text ?? '').toLowerCase();
  if (haystack === '')
    return false;

  let segments = needle.split('*').map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0)
    return true;

  let cursor = 0;
  for (let segment of segments) {
    let index = haystack.indexOf(segment, cursor);
    if (index === -1)
      return false;

    cursor = index + segment.length;
  }

  return true;
}

// Every field a person could plausibly be searching for. Kept explicit rather
// than JSON.stringify-ing the frame so ids and metadata do not create matches
// nobody expects.
export function frameSearchText(frame) {
  if (!frame)
    return '';

  let content = frame?.content && typeof frame.content === 'object' ? frame.content : {};
  let parts = [
    frame.type,
    content.text,
    content.title,
    content.summary,
    content.name,
    content.toolName,
    content.command,
    content.query,
  ];

  if (Array.isArray(content.references)) {
    for (let reference of content.references) {
      if (!reference || typeof reference !== 'object')
        continue;
      parts.push(reference.type, reference.title, reference.name, reference.id);
    }
  }

  return parts.filter((part) => typeof part === 'string' && part !== '').join('\n');
}

export function frameMatchesQuery(frame, query = DEFAULT_FRAME_QUERY) {
  if (normalizeFrameQuery(query) === DEFAULT_FRAME_QUERY)
    return true;

  return frameQueryMatchesText(frameSearchText(frame), query);
}

// The authoritative predicate, applied to a hydrated frame.
//
// Order matters and mirrors the client so the two can never disagree:
//   1. `hidden` is absolute. System-only records are never shown, whatever the
//      user selects — there is no category that can rescue them.
//   2. `phantom` and `MessageDone` are transport scaffolding, never content.
//   3. `deleted` is a gate: soft-deleted frames appear only when Deleted is on.
//   4. categories are ANY-of.
//   5. the text query must match.
//
// Frame *identity* is deliberately not tested here. The thread keys its items
// by `data-frame-id` and the reconciler needs that identity, but enforcing it
// in the filter predicate would make every id-less fixture and every partially
// hydrated record invisible, which is a rendering concern rather than a
// visibility-selection one.
export function frameMatchesWindowFilters(frame, filters, query = DEFAULT_FRAME_QUERY) {
  if (!frame)
    return false;

  if (frame.hidden === true)
    return false;
  if (frame.phantom === true)
    return false;
  if (isNeverVisibleType(frame.type))
    return false;

  let normal = normalizeWindowFilters(filters);

  if (frame.deleted === true && normal.deleted !== true)
    return false;

  let categories = frameFilterCategories(frame);
  if (categories.length === 0) {
    // An uncategorised frame is visible whenever any kind is being shown;
    // otherwise turning Categories down to nothing would silently keep them.
    if (!FRAME_FILTER_CATEGORY_KEYS.some((key) => normal[key] === true))
      return false;
  } else if (!categories.some((key) => normal[key] === true)) {
    return false;
  }

  return frameMatchesQuery(frame, query);
}

export function emptyFilterCounts() {
  let counts = {};
  for (let key of FRAME_FILTER_KEYS)
    counts[key] = 0;

  return counts;
}

// Per-row counts for a set of already-hydrated frames. Excludes frames that
// the hidden/phantom gates removed, so a badge never counts something the
// popup cannot actually reveal.
export function frameFilterCounts(frames = []) {
  let counts = emptyFilterCounts();

  for (let frame of Array.isArray(frames) ? frames : []) {
    if (!frame || frame.hidden === true || frame.phantom === true)
      continue;
    if (isNeverVisibleType(frame.type))
      continue;

    if (frame.deleted === true)
      counts.deleted += 1;

    for (let key of frameFilterCategories(frame))
      counts[key] += 1;
  }

  return counts;
}

// Per-row counts for a whole session, from frame paths only.
//
// This is the number the popup shows. Counting the frames the browser happens
// to hold answers a different question — "how many are on this page" — and
// reported a page-sized Agent number next to zeros for every kind that fell
// outside it. Counting paths instead costs one directory scan (tens of
// milliseconds for a 17k-frame session, versus seconds to hydrate every body)
// and describes the session rather than the page.
//
// Counts are computed against the *unfiltered* set on purpose: a badge answers
// "how many of these exist", so it must not shrink as neighbouring rows are
// switched off, or a number would depend on state elsewhere in the panel.
//
// Two rows cannot be answered from paths and are returned as `null` rather
// than as a confident 0:
//   - `deleted`, because soft-deletion is a body field;
//   - the reference half of `session`, because a link to a child session lives
//     in the body. The type-derived Session/SessionSpawn frames are counted.
export function countFilterMatches(paths = []) {
  let counts = emptyFilterCounts();
  counts.deleted = null;

  for (let path of Array.isArray(paths) ? paths : []) {
    let type = frameTypeFromPath(path);
    if (type === '')
      continue;
    if (isNeverVisibleType(type))
      continue;

    for (let key of frameCategoriesFromType(type))
      counts[key] += 1;
  }

  return counts;
}
