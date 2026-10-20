'use strict';

// Guards the DISCOVERY text for ask-user, not its behaviour.
//
// Why this exists: the P2 answer loop was fully implemented, route-tested and
// event-tested while the text agents actually read still told them to "continue
// without waiting for the answer". The mode semantics were ambiguous enough that
// a live agent asked the workspace owner when to use `wait` versus `continue` —
// a question answered correctly nowhere in the tool surface. Behaviour specs
// (`ask-user-tool-spec.mjs` asserts persisted `mode`) cannot catch that: they
// exercise arguments the agent has to already know to pass.
//
// So: assert the two surfaces an agent can actually reach, and assert they
// agree, because they are edited separately and drift silently.
//   (1) `description`       — shown in tool listings; the first thing read.
//   (2) `help`              — the detailed decision rule.
//   (3) the Brief A tool map — the at-a-glance list in the start brief.
// Brief B (buildMessageBrief) deliberately carries no tool map, so it is not
// asserted here; an earlier draft did and failed against the real product.

import test from 'node:test';
import assert from 'node:assert/strict';

import { AskUserTool } from '../../../src/core/tools/ask-user-tool.mjs';
import { buildStartBrief } from '../../../src/core/plugins/agent-brief-template.mjs';

const HELP = AskUserTool.help;
const DESCRIPTION = AskUserTool.description;
const MODES = AskUserTool.inputSchema.properties.mode.enum;

test('the schema accepts exactly the documented modes', () => {
  // Anchor for every other assertion: the words used below must be modes the
  // tool really takes, not prose invented for the help text.
  assert.deepEqual([ ...MODES ].sort(), [ 'continue', 'wait' ]);
});

test('the description does not claim ask-user always continues', () => {
  // The precise defect: "Ask the user one or more questions and continue
  // without waiting for the answer." True only for mode 'continue', and it was
  // stated unconditionally in the field agents read first.
  assert.doesNotMatch(
    DESCRIPTION,
    /and continue without waiting|continue without waiting for the answer/i,
    'description must not present "keep working" as unconditional',
  );
});

test('the description names every mode so the choice is discoverable', () => {
  // Naming both modes in the listing is what makes `help` reachable at all: an
  // agent that only sees the summary learns there IS a choice.
  for (const mode of MODES) {
    assert.match(DESCRIPTION, new RegExp(mode, 'i'),
      `description must name mode '${mode}'`);
  }
});

test('the help states the decision rule, not just the two mode names', () => {
  // The owner's answer, encoded in the tool: decide by whether you can proceed.
  assert.match(HELP, /cannot proceed|can not continue|can't continue|urgent/i,
    'help must frame the choice as "can I proceed without this answer?"');
  assert.match(HELP, /END YOUR TURN|end-turn/i,
    'help must say wait mode ends the turn');
  assert.match(HELP, /KEEP WORKING|continue-turn/i,
    'help must say continue mode keeps working');
  assert.match(HELP, /steering prompt/i,
    'help must say how the answer comes back');
});

test('the help names the failure mode of mixing the two', () => {
  // "ask in wait mode then keep working" strands the user. Stated explicitly
  // because it is the exact mistake this guidance exists to prevent.
  assert.match(HELP, /Do not ask in wait mode and then keep working/i);
});

test('the brief tool map mentions ask-user with both modes', () => {
  // The original gap reported by a live agent: ask-user was registered as a tool
  // but absent from the brief's tool map, so it was invisible at a glance.
  const { text } = buildStartBrief({});
  const toolSection = text.slice(text.indexOf('Tools:'));
  assert.notEqual(toolSection, text, 'start brief must contain a Tools section');
  assert.match(toolSection, /ask-user/, 'ask-user must appear in the brief tool map');
  for (const mode of MODES) {
    assert.match(toolSection, new RegExp(`mode ${mode}|${mode} =`, 'i'),
      `brief line must say what mode '${mode}' does`);
  }
});
