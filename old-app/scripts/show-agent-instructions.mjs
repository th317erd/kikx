#!/usr/bin/env node

'use strict';

// =============================================================================
// show-agent-instructions — Display default instructions for each agent
// =============================================================================
// Usage: npm run show-agent-instructions
//
// Shows the instructions field and DM summary for every agent in the database,
// plus the core primer that all agents receive.
//
// Options:
//   --db <path>       Database file path (default: ~/.config/kikx/kikx.db)
//   --agent <name>    Show only this agent (by name)
//   --primer          Also show the full assembled primer for each agent
//
// Environment:
//   KIKX_DB           Same as --db
// =============================================================================

import path from 'node:path';
import os   from 'node:os';

import { KikxCore } from '../src/core/kikx-core.mjs';

// --- Argument Parsing ---

function parseArgs(argv) {
  let args = {};
  let i    = 2;

  while (i < argv.length) {
    let arg = argv[i];

    if (arg === '--db' && argv[i + 1]) {
      args.db = argv[++i];
    } else if (arg === '--agent' && argv[i + 1]) {
      args.agentName = argv[++i];
    } else if (arg === '--primer') {
      args.showPrimer = true;
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm run show-agent-instructions [-- --db <path>] [-- --agent <name>] [-- --primer]');
      console.log('');
      console.log('Shows the instructions configured for each agent.');
      console.log('');
      console.log('Options:');
      console.log('  --db <path>     Database file (default: ~/.config/kikx/kikx.db, env: KIKX_DB)');
      console.log('  --agent <name>  Show only this agent (by name, case-insensitive)');
      console.log('  --primer        Also show the full assembled primer for each agent');
      process.exit(0);
    }

    i++;
  }

  return args;
}

// --- Display Helpers ---

function separator(char = '=', width = 78) {
  return char.repeat(width);
}

function printAgent(agent, index) {
  console.log(separator());
  console.log(`Agent #${index + 1}: ${agent.name}`);
  console.log(separator('-'));
  console.log(`  ID:        ${agent.id}`);
  console.log(`  Plugin:    ${agent.pluginID}`);
  console.log(`  Org:       ${agent.organizationID}`);
  console.log('');

  // Instructions
  if (agent.instructions) {
    console.log('  INSTRUCTIONS:');
    console.log(separator('-', 40));
    for (let line of agent.instructions.split('\n'))
      console.log(`  ${line}`);

    console.log('');
  } else {
    console.log('  INSTRUCTIONS: (none)');
    console.log('');
  }

  // DM Summary
  if (agent.dmSummary) {
    console.log('  DM SUMMARY:');
    console.log(separator('-', 40));
    for (let line of agent.dmSummary.split('\n'))
      console.log(`  ${line}`);

    console.log('');
  } else {
    console.log('  DM SUMMARY: (none)');
    console.log('');
  }
}

async function printAbilities(agent) {
  if (typeof agent.hasAbilities !== 'function')
    return;

  let has = await agent.hasAbilities();

  if (has) {
    let text = await agent.getAbilities();
    console.log('  ABILITIES:');
    console.log(separator('-', 40));
    for (let line of (text || '').split('\n'))
      console.log(`  ${line}`);

    console.log('');
  } else {
    console.log('  ABILITIES: (none)');
    console.log('');
  }
}

async function printPrimer(assembler, agent) {
  let primer = await assembler.assemble(agent);

  console.log('  FULL PRIMER:');
  console.log(separator('-', 40));
  for (let line of primer.split('\n'))
    console.log(`  ${line}`);

  console.log('');
}

// --- Main ---

async function main() {
  let args   = parseArgs(process.argv);
  let dbPath = args.db || process.env.KIKX_DB || path.join(os.homedir(), '.config', 'kikx', 'kikx.db');

  let core;

  try {
    core = new KikxCore({
      database: { filename: dbPath },
    });

    await core.start();

    let context = core.getContext();
    let models  = context.getProperty('models');
    let { Agent } = models;

    // Query agents
    let agents = await Agent.where.all();

    if (args.agentName) {
      let filter = args.agentName.toLowerCase();
      agents = agents.filter((a) => a.name.toLowerCase().includes(filter));
    }

    if (agents.length === 0) {
      if (args.agentName)
        console.log(`No agents found matching "${args.agentName}".`);
      else
        console.log('No agents found in database.');

      await core.stop();

      return;
    }

    console.log(`Found ${agents.length} agent(s) in ${dbPath}\n`);

    // Get primer assembler if --primer flag is set
    let assembler;

    if (args.showPrimer) {
      let { PrimerAssembler } = await import('../src/core/primer/index.mjs');
      assembler = new PrimerAssembler(context);
    }

    for (let i = 0; i < agents.length; i++) {
      let agent = agents[i];

      printAgent(agent, i);
      await printAbilities(agent);

      if (assembler)
        await printPrimer(assembler, agent);
    }

    console.log(separator());

    await core.stop();
  } catch (error) {
    console.error(`Error: ${error.message}`);

    if (core)
      await core.stop();

    process.exit(1);
  }
}

main();
