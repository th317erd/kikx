/* eslint-disable key-spacing */

// This module defines all application routes.
// The "name" property on routes tells mythix
// to generate this route when generating API
// interfaces for clients.
//
// The "help" scope is used by the API
// interface generator to provide help
// for each generated API interface method.

import { authRoutes }         from './auth-routes/index.mjs';
import { userRoutes }         from './user-routes/index.mjs';
import { organizationRoutes } from './organization-routes/index.mjs';

export function getRoutes({ path }) {
  path('api', ({ path }) => {
    path('v1', (context) => {
      const { endpoint } = context;

      endpoint('client-interface.js', 'APIInterfaceController.get');
      endpoint('health', 'HealthCheckController.health');

      authRoutes.call(this, context);
      userRoutes.call(this, context);
      organizationRoutes.call(this, context);
    });
  });
}
