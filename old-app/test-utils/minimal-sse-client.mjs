#!/usr/bin/env node
/**
 * Minimal SSE client to test the minimal server
 */
'use strict';

console.log('Starting minimal SSE client...');

async function main() {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    console.log('\n[TIMEOUT] Aborting after 30 seconds');
    controller.abort();
  }, 30000);

  try {
    const response = await fetch('http://localhost:9999/stream', {
      signal: controller.signal,
    });

    console.log('Response status:', response.status);
    console.log('Response headers:', Object.fromEntries(response.headers.entries()));
    console.log('\n--- Reading stream ---\n');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let chunkNum = 0;

    while (true) {
      const { done, value } = await reader.read();
      chunkNum++;

      if (done) {
        console.log(`\n[Chunk #${chunkNum}] Stream ended (done=true)`);
        break;
      }

      const timestamp = new Date().toISOString();
      const text = decoder.decode(value, { stream: true });
      console.log(`[${timestamp}] Chunk #${chunkNum} (${value.length} bytes):`);
      console.log(text);
    }

    console.log('\nStream finished normally');
  } catch (error) {
    console.error('Error:', error.message);
  } finally {
    clearTimeout(timeout);
  }
}

main();
