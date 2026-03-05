'use strict';

// =============================================================================
// V2 Routes — Mythix DSL
// =============================================================================
// Uses path(), endpoint(), capture() to define routes that map
// to controller methods.
//
// IMPORTANT: Mythix endpoint() requires a non-empty path segment.
// Collections use the resource name as the endpoint, not empty string.
// =============================================================================

export function getRoutes({ path }) {
  path('api', ({ path }) => {
    path('v2', ({ path, endpoint, capture }) => {
      // --- Auth Routes ---
      path('auth', ({ endpoint }) => {
        endpoint('register', {
          methods:    [ 'POST' ],
          controller: 'AuthController.register',
        });

        endpoint('login', {
          methods:    [ 'POST' ],
          controller: 'AuthController.login',
        });

        endpoint('me', {
          methods:    [ 'GET' ],
          controller: 'AuthController.me',
        });

        endpoint('me', {
          methods:    [ 'PUT' ],
          controller: 'AuthController.updateProfile',
        });
      });

      // --- Agent Routes ---
      // List + Create at /api/v2/agents
      endpoint('agents', {
        methods:    [ 'GET' ],
        controller: 'AgentController.list',
      });

      endpoint('agents', {
        methods:    [ 'POST' ],
        controller: 'AgentController.create',
      });

      // Single agent: /api/v2/agents/:agentId
      path('agents', ({ endpoint, capture, path: agentPath }) => {
        let agentId = capture('agentId');

        endpoint(agentId, {
          methods:    [ 'GET' ],
          controller: 'AgentController.show',
        });

        endpoint(agentId, {
          methods:    [ 'PUT' ],
          controller: 'AgentController.update',
        });

        endpoint(agentId, {
          methods:    [ 'DELETE' ],
          controller: 'AgentController.destroy',
        });

        // DM routes nested under agent
        agentPath(agentId, ({ endpoint, path: dmPath }) => {
          endpoint('dm', {
            methods:    [ 'POST' ],
            controller: 'DmController.getOrCreate',
          });

          dmPath('dm', ({ endpoint }) => {
            endpoint('summary', {
              methods:    [ 'GET' ],
              controller: 'DmController.getSummary',
            });

            endpoint('summary', {
              methods:    [ 'PUT' ],
              controller: 'DmController.updateSummary',
            });

            endpoint('summarize', {
              methods:    [ 'POST' ],
              controller: 'DmController.summarize',
            });
          });
        });
      });

      // --- Session Routes ---
      // List + Create at /api/v2/sessions
      endpoint('sessions', {
        methods:    [ 'GET' ],
        controller: 'SessionController.list',
      });

      endpoint('sessions', {
        methods:    [ 'POST' ],
        controller: 'SessionController.create',
      });

      // Single session: /api/v2/sessions/:sessionId
      path('sessions', ({ endpoint, capture, path: sessionPath }) => {
        let sessionId = capture('sessionId');

        endpoint(sessionId, {
          methods:    [ 'GET' ],
          controller: 'SessionController.show',
        });

        endpoint(sessionId, {
          methods:    [ 'PUT' ],
          controller: 'SessionController.update',
        });

        endpoint(sessionId, {
          methods:    [ 'DELETE' ],
          controller: 'SessionController.destroy',
        });

        // Archive/revive
        sessionPath(sessionId, ({ endpoint, path: nestedPath }) => {
          endpoint('archive', {
            methods:    [ 'POST' ],
            controller: 'SessionController.archive',
          });

          endpoint('revive', {
            methods:    [ 'POST' ],
            controller: 'SessionController.revive',
          });

          // Participants
          nestedPath('participants', ({ endpoint, capture }) => {
            endpoint('list', {
              methods:    [ 'GET' ],
              controller: 'ParticipantController.list',
            });

            endpoint('create', {
              methods:    [ 'POST' ],
              controller: 'ParticipantController.create',
            });

            let participantId = capture('participantId');

            endpoint(participantId, {
              methods:    [ 'DELETE' ],
              controller: 'ParticipantController.destroy',
            });
          });

          // Interaction
          nestedPath('interact', ({ endpoint, capture }) => {
            endpoint('send', {
              methods:    [ 'POST' ],
              controller: 'InteractionController.sendMessage',
            });

            endpoint('cancel', {
              methods:    [ 'POST' ],
              controller: 'InteractionController.cancel',
            });

            let frameId = capture('frameId');

            endpoint(frameId, {
              methods:    [ 'POST' ],
              controller: 'InteractionController.approve',
            });
          });

          // Frames
          endpoint('frames', {
            methods:    [ 'GET' ],
            controller: 'FrameController.list',
          });

          nestedPath('frames', ({ endpoint, capture }) => {
            let frameId = capture('frameId');

            endpoint(frameId, {
              methods:    [ 'PATCH' ],
              controller: 'FrameController.update',
            });
          });

          // Stream
          endpoint('stream', {
            methods:    [ 'GET' ],
            controller: 'StreamController.connect',
          });
        });
      });
    });
  });
}
