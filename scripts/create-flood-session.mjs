'use strict';

// Creates a disposable, agent-free session with a large mixed user/agent frame
// history. Intended for manual browser profiling, not CI: it writes to the
// configured development database and prints the session id.
//
// Usage:
//   ORG_AEOR_KIKX_DATABASE_URL=postgres://... \
//     node scripts/create-flood-session.mjs --messages 3000
//
// Every message is a separate raw frame. The browser's initial window still
// loads 600 frames, so counts above that also exercise server windowing and the
// client's bounded render window.

import { randomUUID } from 'node:crypto';

import { PostgreSQLConnection } from '../src/core/database/postgresql-connection.mjs';
import { FrameStore } from '../src/core/aeordb/frame-store.mjs';
import { FrameRuntime } from '../src/core/runtime/frame-runtime.mjs';
import { countMessageFrames } from '../src/shared/frame-manager/frame-manager.mjs';

let options = parseArgs(process.argv.slice(2));
let databaseURL = options.databaseURL
  || process.env.ORG_AEOR_KIKX_DATABASE_URL
  || process.env.KIKX_DATABASE_URL
  || '';

if (!databaseURL) {
  console.error('create-flood-session: database URL is required (ORG_AEOR_KIKX_DATABASE_URL)');
  process.exit(2);
}

let db = new PostgreSQLConnection({ url: databaseURL });
await db.connect();

let store = new FrameStore({ aeordb: db });
let runtime = new FrameRuntime({
  frameStore: store,
  idGenerator: randomUUID,
  clock: () => Date.now() * 1000,
  logger: { info() {}, warn() {}, error() {}, debug() {} },
});

let title = options.title || `Profile flood ${new Date().toISOString()}`;
let session = await runtime.createSession({ title });
let entry = await runtime.ensureSessionEntry(session.id);
let total = Math.max(1, options.messages);
let batch = [];

for (let index = 0; index < total; index++) {
  let isUser = index % 2 === 0;
  let at = Date.now() * 1000 + index;
  batch.push({
    id: randomUUID(),
    type: isUser ? 'UserMessage' : 'AgentMessage',
    sessionID: session.id,
    interactionID: `flood-${session.id}-${Math.floor(index / 2)}`,
    authorType: isUser ? 'user' : 'agent',
    authorID: isUser ? 'profile-user' : 'profile-agent',
    authorDisplayName: isUser ? 'Profile User' : 'Profile Agent',
    timestamp: at,
    createdAt: at,
    updatedAt: at,
    hidden: false,
    deleted: false,
    content: isUser
      ? { text: userText(index) }
      : { text: agentText(index), status: 'complete' },
  });

  if (batch.length >= 100) {
    entry.frameEngine.merge(batch, { authorType: 'system', authorID: 'profile-flood' });
    await store.flush();
    batch = [];
  }
}

if (batch.length > 0) {
  entry.frameEngine.merge(batch, { authorType: 'system', authorID: 'profile-flood' });
  await store.flush();
}

let messageCount = countMessageFrames(entry.frameEngine.toArray());
if (typeof runtime.queueSessionManifestSave === 'function') {
  entry.session.messageCount = messageCount;
  await runtime.queueSessionManifestSave(entry);
} else {
  entry.session.messageCount = messageCount;
  await store.saveSessionManifest(entry.session);
}

console.log(JSON.stringify({
  sessionID: session.id,
  title,
  frames: total,
  messageCount,
  url: `http://127.0.0.1:3002/?session=${session.id}`,
}, null, 2));

await db.close();

function parseArgs(argv) {
  let result = { messages: 1000, title: '', databaseURL: '' };
  for (let index = 0; index < argv.length; index++) {
    let arg = argv[index];
    if (arg === '--messages') {
      result.messages = Number(argv[++index]) || result.messages;
    } else if (arg === '--title') {
      result.title = String(argv[++index] || '');
    } else if (arg === '--database-url') {
      result.databaseURL = String(argv[++index] || '');
    }
  }
  return result;
}

function userText(index) {
  let base = `User request ${index}: inspect the current implementation and report the next concrete step.`;
  if (index % 20 === 0)
    return `${base}\n\n- first check\n- second check\n- third check\n\n\`\`\`js\nconst value = ${index};\nconsole.log(value);\n\`\`\``;
  if (index % 25 === 0)
    return `${base}\n\n| Area | Result |\n| --- | --- |\n| render | ok |\n| scroll | ok |`;
  return base;
}

function agentText(index) {
  let base = `Agent response ${index}: I checked the current state and the next step is to verify the measurement before changing anything.`;
  if (index % 15 === 0)
    return `${base}\n\n- measured the current path\n- confirmed the regression\n- prepared the fix`;
  if (index % 29 === 0)
    return `${base}\n\n\`\`\`bash\nnode --test spec/client/state-spec.mjs\n\`\`\`\n\nAll checks passed.`;
  return base;
}
