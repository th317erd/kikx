#!/usr/bin/env node
/**
 * Minimal Express SSE test WITHOUT express.json() middleware
 */
'use strict';

import express from 'express';
import Anthropic from '@anthropic-ai/sdk';

const PORT = 9997;
const API_KEY = process.env.ANTHROPIC_API_KEY;

if (!API_KEY) {
  console.error('Error: ANTHROPIC_API_KEY environment variable required');
  process.exit(1);
}

const anthropic = new Anthropic({ apiKey: API_KEY });
const app = express();

// NO express.json() - just raw Express

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// GET route (no body parsing needed)
app.get('/stream', async (req, res) => {
  console.log(`\n[${new Date().toISOString()}] GET /stream`);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  req.setTimeout(0);
  res.setTimeout(0);
  if (req.socket) req.socket.setTimeout(0);

  res.flushHeaders();
  console.log('[Server] Headers sent');

  res.write(':ok\n\n');
  console.log('[Server] Sent :ok');

  let clientClosed = false;
  req.on('close', () => {
    console.log('[Server] req.on(close) fired', {
      complete: req.complete,
      destroyed: req.destroyed,
    });
    clientClosed = true;
  });

  let heartbeatCount = 0;
  const heartbeat = setInterval(() => {
    heartbeatCount++;
    console.log(`[Server] Heartbeat #${heartbeatCount}, clientClosed=${clientClosed}`);
    if (!clientClosed) {
      res.write(`:heartbeat-${heartbeatCount}\n\n`);
    }
  }, 500);

  res.write('event: status\ndata: {"status":"calling_api"}\n\n');
  console.log('[Server] Calling Anthropic API...');

  try {
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Say hi in exactly 3 words.' }],
    });

    console.log('[Server] Stream created');

    let textContent = '';

    for await (const event of stream) {
      if (clientClosed) {
        console.log('[Server] Client closed, breaking');
        break;
      }

      console.log(`[Server] Event: ${event.type}`);

      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        textContent += event.delta.text;
        res.write(`event: text\ndata: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }

    console.log(`[Server] Complete: "${textContent}"`);

    if (!clientClosed) {
      res.write(`event: done\ndata: ${JSON.stringify({ content: textContent })}\n\n`);
      res.end();
      console.log('[Server] Response ended');
    }

  } catch (error) {
    console.error('[Server] Error:', error.message);
  } finally {
    clearInterval(heartbeat);
  }
});

const server = app.listen(PORT, () => {
  console.log(`Express (no JSON) test at http://localhost:${PORT}`);
  console.log(`curl -N http://localhost:${PORT}/stream`);
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;
server.requestTimeout = 0;
server.timeout = 0;

process.on('SIGINT', () => {
  server.close();
  process.exit(0);
});
