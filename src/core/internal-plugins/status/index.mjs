'use strict';

// =============================================================================
// Status Capability Plugin
// =============================================================================
// Registers `status` capability — unified slash command + tool.
// Returns contextual information about the current session, participants,
// server state, loaded plugins/tools, and Solr availability.
//
// Invocable as:
//   - Slash command: /status
//   - Tool call:     { toolName: 'status', arguments: {} }
// =============================================================================

function formatUptime(seconds) {
  let d = Math.floor(seconds / 86400);
  let h = Math.floor((seconds % 86400) / 3600);
  let m = Math.floor((seconds % 3600) / 60);
  let s = Math.floor(seconds % 60);
  let parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

export function setup({ registerCapability }) {
  registerCapability('status', {
    description:  'Show current session status, participants, server info, and available tools.',
    displayName:  'Session Status',
    riskLevel:    'none',
    slashCommand: 'status',
    schema: {
      type:       'object',
      properties: {},
    },
    examples: [
      { input: '/status', description: 'Show session status and server info' },
    ],

    async handler({ sessionID, context: ctx, agent }) {
      let models         = ctx.getProperty('models');
      let pluginRegistry = ctx.getProperty('pluginRegistry');
      let pluginLoader   = ctx.getProperty('pluginLoader');
      let solrService    = ctx.getProperty('solrService');

      // 1. Session info
      let sessionName = '(unknown)';
      if (models && models.Session) {
        try {
          let session = await models.Session.where.id.EQ(sessionID).first();
          sessionName = session ? (session.name || '(unnamed)') : '(unknown)';
        } catch (_e) {
          // leave as unknown
        }
      }

      // 2. Participants
      let participants = [];
      if (models && models.Participant && models.Agent) {
        try {
          let entries = await models.Participant.where.sessionID.EQ(sessionID).all();
          for (let p of entries) {
            let agentName = null;
            if (p.agentID) {
              let a = await models.Agent.where.id.EQ(p.agentID).first();
              agentName = a ? a.name : null;
            }

            participants.push({
              id:   p.agentID || p.id,
              name: agentName || 'Unknown Agent',
              type: 'agent',
              role: p.role || 'member',
            });
          }
        } catch (_e) {
          // leave participants empty
        }
      }

      // 3. Date/time
      let now      = new Date();
      let dateStr  = now.toISOString();
      let timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

      // 4. Server
      let serverVersion = '2.0.0';
      let uptime        = process.uptime();
      let uptimeStr     = formatUptime(uptime);

      // 5. Plugins
      let pluginNames = [];
      if (pluginLoader && typeof pluginLoader.getLoadedPlugins === 'function') {
        pluginNames = Array.from(pluginLoader.getLoadedPlugins());
      }

      // 6. Tools
      let toolNames = [];
      if (pluginRegistry && typeof pluginRegistry.getTools === 'function') {
        let tools = pluginRegistry.getTools();
        toolNames = Array.from(tools.keys()).sort();
      }

      // 7. Solr
      let solrStatus = 'not configured';
      if (solrService) {
        try {
          let ok = await solrService.ping();
          solrStatus = ok ? 'available' : 'unavailable';
        } catch (_e) {
          solrStatus = 'unavailable';
        }
      }

      // Build HTML response
      let participantList = participants.length > 0
        ? participants.map(p => `<li><strong>${p.name}</strong> (${p.type}, ${p.role}) — <code>${p.id}</code></li>`).join('\n')
        : '<li>No participants</li>';

      let pluginList = pluginNames.length > 0
        ? pluginNames.join(', ')
        : '(none)';

      let html = `
<h3>Session Status</h3>
<p><strong>Session:</strong> ${sessionName}<br/>
<strong>Session ID:</strong> <code>${sessionID}</code></p>

<p><strong>Participants (${participants.length}):</strong></p>
<ul>${participantList}</ul>

<p><strong>Date/Time:</strong> ${dateStr}<br/>
<strong>Timezone:</strong> ${timezone}</p>

<p><strong>Server:</strong> v${serverVersion} — uptime ${uptimeStr}<br/>
<strong>Search (Solr):</strong> ${solrStatus}</p>

<p><strong>Plugins (${pluginNames.length}):</strong> ${pluginList}</p>

<p><strong>Tools (${toolNames.length}):</strong> ${toolNames.join(', ') || '(none)'}</p>
`.trim();

      return { content: { html } };
    },
  });

  return () => {};
}
