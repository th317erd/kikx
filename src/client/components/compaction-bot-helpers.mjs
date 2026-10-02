'use strict';

import { rankCompactionBots } from './agent-list-model.mjs';

// The compaction-bot toggle glyph. A "compact/compress" mark deliberately
// distinct from the crown (♛): U+229F SQUARED MINUS reads as collapse/compact.
// Exported from one place so the owner can swap it later without hunting the UI.
export const COMPACTION_BOT_ICON = '⊟';

// Rank designated compaction bots so the newest designation is #1, next #2, etc.
// Returns a Map of agentID -> rank (1-based); non-designated agents are absent.
//
// Parallel to masterRankByAgentID but over the independent compaction-bot
// fields, so the two ranks never interfere. The list is a rolling top-3: older
// designations beyond the cap are not ranked and do not show as compaction bots.
export function compactionBotRankByAgentID(agents = []) {
  let ranks = new Map();
  rankCompactionBots(agents).forEach((agent, index) => ranks.set(agent.id, index + 1));
  return ranks;
}

export function compactionBotButtonTitle(rank) {
  return rank ? `Compaction bot #${rank} (click to clear)` : 'Set as compaction bot';
}

export function compactionBotButtonAriaLabel(rank) {
  return rank ? `Compaction bot number ${rank}` : 'Set as compaction bot';
}
