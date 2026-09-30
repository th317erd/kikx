'use strict';

import { rankMasters } from './agent-list-model.mjs';

// Rank crowned agents so the newest crown is master #1, next #2, etc. Returns a
// Map of agentID -> rank (1-based); uncrowned agents are absent.
//
// The master list is a rolling top-3: only the three most recently crowned
// agents are masters, so older crowns (e.g. legacy data or crowns beyond the
// cap) are not ranked and do not show as masters.
export function masterRankByAgentID(agents = []) {
  let ranks = new Map();
  rankMasters(agents).forEach((agent, index) => ranks.set(agent.id, index + 1));
  return ranks;
}
