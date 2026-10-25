'use strict';

import assert from 'node:assert/strict';
import test from 'node:test';
import { register } from 'node:module';

import { installDom } from './support/mini-dom.mjs';

register(new URL('./support/frame-item-loader.mjs', import.meta.url).href, import.meta.url);
installDom();

const { buildAgentTagSection } = await import('../../src/client/components/agent-tag-form.mjs');
const { elements } = await import('../../src/client/lib/aeor-ui.mjs');

function walk(node, visit) {
  visit(node);
    for (let child of node.childNodes || []) {
      if (child?.nodeType === 1)
        walk(child, visit);
    }
}

test('agent tag definitions render typed controls in create and edit forms', () => {
  let app = {
    _state: {
      agentTagDefinitions: [
        {
          name: 'leadership_score',
          label: 'Leadership score',
          type: 'integer',
          min: 0,
          max: 10,
          defaultValue: 0,
          targetTypes: [ 'agent' ],
          description: 'Higher wins',
        },
      ],
      agentFormTags: { leadership_score: 4 },
    },
  };

  let nodes = buildAgentTagSection(app);
  assert.ok(nodes.length > 0);
  let tree = elements.div()(nodes).build(document);
  let controls = [];
  walk(tree, (entry) => {
    if (entry?.localName === 'aeor-input')
      controls.push(entry);
  });

  assert.equal(controls.length, 1);
  assert.equal(controls[0].getAttribute('min'), '0');
  assert.equal(controls[0].getAttribute('max'), '10');
  assert.equal(controls[0].getAttribute('step'), '1');
});
