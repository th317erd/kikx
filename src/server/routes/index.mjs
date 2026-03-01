'use strict';

// =============================================================================
// V2 Routes — Mythix DSL
// =============================================================================
// Replaces the old ServerRoutes class with Mythix route DSL.
// Uses path(), endpoint(), capture() to define routes that map
// to controller methods.
// =============================================================================

// --- Auth Routes ---

function authRoutes({ endpoint }) {
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
}

// --- Session Routes ---

function sessionRoutes({ path, endpoint, capture }) {
  endpoint('', {
    methods:    [ 'GET' ],
    controller: 'SessionController.list',
  });

  endpoint('', {
    methods:    [ 'POST' ],
    controller: 'SessionController.create',
  });

  let sessionId = capture('id');

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

  path(sessionId, ({ endpoint }) => {
    endpoint('archive', {
      methods:    [ 'POST' ],
      controller: 'SessionController.archive',
    });

    endpoint('revive', {
      methods:    [ 'POST' ],
      controller: 'SessionController.revive',
    });
  });

  // Nested session routes (participants, interactions, frames, stream)
  // Use :sessionId capture for nested resources
  let nestedSessionId = capture('sessionId');

  path(nestedSessionId, (context) => {
    participantRoutes(context);
    interactionRoutes(context);
    frameRoutes(context);
    streamRoutes(context);
  });
}

// --- Participant Routes ---

function participantRoutes({ path, endpoint, capture }) {
  path('participants', ({ endpoint, capture }) => {
    endpoint('', {
      methods:    [ 'GET' ],
      controller: 'ParticipantController.list',
    });

    endpoint('', {
      methods:    [ 'POST' ],
      controller: 'ParticipantController.create',
    });

    let participantId = capture('id');

    endpoint(participantId, {
      methods:    [ 'DELETE' ],
      controller: 'ParticipantController.destroy',
    });
  });
}

// --- Interaction Routes ---

function interactionRoutes({ path, endpoint, capture }) {
  path('interact', ({ endpoint, capture }) => {
    endpoint('', {
      methods:    [ 'POST' ],
      controller: 'InteractionController.sendMessage',
    });

    endpoint('cancel', {
      methods:    [ 'POST' ],
      controller: 'InteractionController.cancel',
    });

    let frameId = capture('frameId');

    endpoint(`approve/${frameId}`, {
      methods:    [ 'POST' ],
      controller: 'InteractionController.approve',
    });

    endpoint(`deny/${frameId}`, {
      methods:    [ 'POST' ],
      controller: 'InteractionController.deny',
    });
  });
}

// --- Frame Routes ---

function frameRoutes({ endpoint }) {
  endpoint('frames', {
    methods:    [ 'GET' ],
    controller: 'FrameController.list',
  });
}

// --- Stream Routes ---

function streamRoutes({ endpoint }) {
  endpoint('stream', {
    methods:    [ 'GET' ],
    controller: 'StreamController.connect',
  });
}

// =============================================================================
// Main route definition
// =============================================================================

export function getRoutes({ path }) {
  path('api', ({ path }) => {
    path('v2', ({ path }) => {
      path('auth', (context) => {
        authRoutes(context);
      });

      path('sessions', (context) => {
        sessionRoutes(context);
      });

      path('agents', ({ endpoint, capture }) => {
        endpoint('', {
          methods:    [ 'GET' ],
          controller: 'AgentController.list',
        });

        endpoint('', {
          methods:    [ 'POST' ],
          controller: 'AgentController.create',
        });

        let agentId = capture('id');

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
      });
    });
  });
}
