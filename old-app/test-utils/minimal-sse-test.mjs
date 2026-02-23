#!/usr/bin/env node
/**
 * Minimal SSE + Anthropic API test
 * Completely standalone - no Express, no middleware
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-xxx node minimal-sse-test.mjs
 */
'use strict';

import http from 'node:http';
import Anthropic from '@anthropic-ai/sdk';

const PORT = 9999;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable required');
  process.exit(1);
}

console.log('Creating Anthropic client...');
const anthropic = new Anthropic({ apiKey: API_KEY });

// Create a minimal HTTP server
const server = http.createServer(async (req, res) => {
  console.log(`\n[${new Date().toISOString()}] ${req.method} ${req.url}`);

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end('{"status":"ok"}');
    return;
  }

  if (req.url !== '/stream' || req.method !== 'GET') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  // Set up SSE headers
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  console.log('[Server] Headers sent');

  // Disable socket timeout
  req.socket?.setTimeout(0);
  res.socket?.setTimeout(0);

  // Send initial comment
  res.write(':ok\n\n');
  console.log('[Server] Sent :ok');

  // Track if client disconnected
  let clientClosed = false;
  req.on('close', () => {
    console.log('[Server] Client connection closed', {
      complete: req.complete,
      destroyed: req.destroyed,
    });
    clientClosed = true;
  });

  // Start a heartbeat interval
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
      messages: [{ role: 'user', content: 'Say hi in exactly 3 words.' }],
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
      } else if (event.type === 'message_stop') {
        console.log('[Server] Got message_stop');
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

server.listen(PORT, () => {
  console.log(`Minimal SSE test server running at http://localhost:${PORT}`);
  console.log(`Test with: curl -N http://localhost:${PORT}/stream`);
  console.log('');
});

// Handle shutdown
process.on('SIGINT', () => {
  console.log('\nShutting down...');
  server.close();
  process.exit(0);
});
