'use strict';

// V2 Server entry point — boots KikxCore + Mythix HTTP server on port 8089.

import path from 'node:path';
import os   from 'node:os';

import { Application } from './application.mjs';

let dbPath = process.env.KIKX_DB || path.join(os.homedir(), '.config', 'kikx', 'kikx.db');

let app = new Application({
  environment: 'development',
  database: {
    development: {
      dialect:  'sqlite',
      filename: dbPath,
    },
  },
  httpServer: {
    host:       'localhost',
    port:       8089,
    middleware: [],
  },
  core: {
    database: { filename: dbPath },
  },
});

app.start().then(() => {
  console.log(`Kikx V2 server listening on http://localhost:8089`);
  console.log(`Database: ${dbPath}`);
}).catch((error) => {
  console.error('Failed to start V2 server:', error);
  process.exit(1);
});
