'use strict';

import express from 'express';
import cookieParser from 'cookie-parser';
import { readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import config from './config.mjs';
import { getDatabase, closeDatabase } from './database.mjs';
import { requireAuth, optionalAuth } from './middleware/auth.mjs';
import routes from './routes/index.mjs';
import { loadSystemProcesses } from './lib/processes/index.mjs';
import { initializeAbilities } from './lib/abilities/index.mjs';
import { initializeInteractions } from './lib/interactions/index.mjs';
import { initWebSocket } from './lib/websocket.mjs';
import './lib/assertions/index.mjs';  // Register assertion handlers

const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);

// Write debug.js based on DEBUG environment variable
const DEBUG = process.env.DEBUG === 'true' || process.env.DEBUG === '1';
const debugJsPath = join(__dirname, '..', 'public', 'js', 'debug.js');
const debugJsContent = DEBUG
  ? `// Auto-generated debug configuration\n'use strict';\nsetDebug(true);\nconsole.log('[Debug] Debug mode enabled via environment variable');\n`
  : `// Auto-generated debug configuration\n'use strict';\n// Debug mode disabled\n`;
writeFileSync(debugJsPath, debugJsContent);

// Load and prepare index.html with config injection
const indexHtmlPath = join(__dirname, '..', 'public', 'index.html');
const indexHtmlTemplate = readFileSync(indexHtmlPath, 'utf8');
const indexHtml = indexHtmlTemplate.replace(
  /<base href="[^"]*">/,
  `<base href="${config.basePath}">`
);

// Initialize database on startup
getDatabase();

// Load system processes (legacy)
await loadSystemProcesses();

// Initialize abilities system
await initializeAbilities();

// Initialize interactions system (InteractionBus + system methods)
initializeInteractions();

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// API routes (serve at both /api and /hero/api for direct and proxied access)
app.use('/api', routes);
app.use('/hero/api', routes);

// Static files (serve at both /path and /hero/path for direct and proxied access)
app.use('/css', express.static(join(__dirname, '..', 'public', 'css')));
app.use('/js', express.static(join(__dirname, '..', 'public', 'js')));
app.use('/assets', express.static(join(__dirname, '..', 'public', 'assets')));
app.use('/favicon.ico', express.static(join(__dirname, '..', 'public', 'favicon.ico')));
app.use('/mythix-ui', express.static(join(__dirname, '..', 'node_modules')));

// Also serve static files under /hero/ prefix for direct server access
app.use('/hero/css', express.static(join(__dirname, '..', 'public', 'css')));
app.use('/hero/js', express.static(join(__dirname, '..', 'public', 'js')));
app.use('/hero/assets', express.static(join(__dirname, '..', 'public', 'assets')));
app.use('/hero/favicon.ico', express.static(join(__dirname, '..', 'public', 'favicon.ico')));
app.use('/hero/mythix-ui', express.static(join(__dirname, '..', 'node_modules')));

// Login page - accessible without auth
app.get('/login', optionalAuth, (req, res) => {
  // If already authenticated, redirect to home
  if (req.user)
    return res.redirect('/');

  res.type('html').send(indexHtml);
});

// Components test page (dev only)
app.get('/components-test', (req, res) => {
  res.sendFile(join(__dirname, '..', 'public', 'components-test.html'));
});

// Component demo page (dev only)
app.get('/demo', (req, res) => {
  res.sendFile(join(__dirname, '..', 'public', 'demo.html'));
});

// All other routes require auth and serve the SPA
app.get('*', requireAuth, (req, res) => {
  res.type('html').send(indexHtml);
});

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('Server error:', error);

  if (req.path.startsWith('/api/'))
    return res.status(500).json({ error: 'Internal server error' });

  res.status(500).send('Internal server error');
});

// Graceful shutdown
function shutdown() {
  console.log('\nShutting down...');
  closeDatabase();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Start server
const server = app.listen(config.port, config.host, () => {
  console.log(`Hero server running at http://${config.host}:${config.port}`);
  console.log(`Base URL: ${config.baseUrl}`);
});

// Increase timeouts for SSE streaming connections
server.keepAliveTimeout = 120000; // 2 minutes
server.headersTimeout = 125000;   // Slightly longer than keepAliveTimeout
server.requestTimeout = 0;        // Disable request timeout
server.timeout = 0;               // Disable idle timeout

// Initialize WebSocket for real-time command updates
initWebSocket(server);

export default app;
