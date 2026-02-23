#!/usr/bin/env node
/**
 * Minimal Express SSE + Anthropic API test
 * Tests if Express middleware is causing the issue
 */
'use strict';

import express from 'express';
import Anthropic from '@anthropic-ai/sdk';

const PORT = 9998;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable required');
  process.exit(1);
}

console.log('Creating Anthropic client...');
const anthropic = new Anthropic({ apiKey: API_KEY });

const app = express();
app.use(express.json()); // Same as main app

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// POST route like the real streaming endpoint
app.post('/stream', async (req, res) => {
  console.log(`\n[${new Date().toISOString()}] POST /stream`);
  console.log('[Server] Body:', req.body);

  // Set up SSE headers (same as messages-stream.mjs)
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  req.setTimeout(0);
  res.setTimeout(0);
  if (req.socket) req.socket.setTimeout(0);

  res.flushHeaders();
  console.log('[Server] Headers sent');

  // Send initial comment
  res.write(':ok\n\n');
  console.log('[Server] Sent :ok');

  // Track client disconnect
  let clientClosed = false;
  req.on('close', () => {
    console.log('[Server] req.on(close) fired', {
      complete: req.complete,
      destroyed: req.destroyed,
      socketDestroyed: req.socket?.destroyed,
      writableEnded: res.writableEnded,
    });
    clientClosed = true;
  });

  // Start heartbeat
  let heartbeatCount = 0;
  const heartbeat = setInterval(() => {
    heartbeatCount++;
    console.log(`[Server] Heartbeat #${heartbeatCount}, clientClosed=${clientClosed}`);
    if (!clientClosed) {
      res.write(`:heartbeat-${heartbeatCount}\n\n`);
    }
  }, 500);

  res.write('event: status\ndata: {"status":"calling_api"}\n\n');
  console.log('[Server] Sent status event, now calling Anthropic API...');

  try {
    console.log('[Server] Creating Anthropic stream...');
    const startTime = Date.now();

    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: req.body?.content || 'Say hi in exactly 3 words.' }],
    });

    console.log(`[Server] Stream object created in ${Date.now() - startTime}ms`);

    let textContent = '';

    for await (const event of stream) {
      if (clientClosed) {
        console.log('[Server] Client closed, breaking stream loop');
        break;
      }

      console.log(`[Server] Received event: ${event.type}`);

      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        textContent += event.delta.text;
        res.write(`event: text\ndata: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    console.log(`[Server] Stream complete. Full response: "${textContent}"`);

    if (!clientClosed) {
      res.write(`event: done\ndata: ${JSON.stringify({ content: textContent })}\n\n`);
      console.log('[Server] Sent done event');
    }

  } catch (error) {
    console.error('[Server] Error:', error.message);
    if (!clientClosed) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
    }
  } finally {
    clearInterval(heartbeat);
    if (!clientClosed) {
      res.end();
      console.log('[Server] Response ended');
    }
  }
});

const server = app.listen(PORT, () => {
  console.log(`Minimal Express SSE test running at http://localhost:${PORT}`);
  console.log(`Test with: curl -N -X POST -H "Content-Type: application/json" -d '{"content":"Hi"}' http://localhost:${PORT}/stream`);
  console.log('');
});

// Disable timeouts on server
server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;
server.requestTimeout = 0;
server.timeout = 0;

process.on('SIGINT', () => {
  console.log('\nShutting down...');
  server.close();
  process.exit(0);
});
