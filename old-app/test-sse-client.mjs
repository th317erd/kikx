'use strict';

// Test SSE client to debug streaming issues

const TOKEN = process.argv[2];
const SESSION_ID = process.argv[3] || '6';

if (!TOKEN) {
  console.error('Usage: node test-sse-client.mjs <token> [session_id]');
  process.exit(1);
}

async function testSSE() {
  console.log('Starting SSE test...');
  console.log('Session ID:', SESSION_ID);

  const response = await fetch(`http://localhost:8098/api/sessions/${SESSION_ID}/messages/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': `token=${TOKEN}`,
    },
    body: JSON.stringify({ content: 'Just say hi' }),
  });

  console.log('Response status:', response.status);
  console.log('Response headers:', Object.fromEntries(response.headers.entries()));

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let chunkCount = 0;

  console.log('Starting to read stream...');

  while (true) {
    const startTime = Date.now();
    const { done, value } = await reader.read();
    const elapsed = Date.now() - startTime;

    chunkCount++;
    console.log(`\n--- Chunk #${chunkCount} (waited ${elapsed}ms) ---`);
    console.log('done:', done);

    if (value) {
      const text = decoder.decode(value, { stream: true });
      console.log('value length:', value.length);
      console.log('decoded text:', text.substring(0, 200));
    } else {
      console.log('value: undefined');
    }

    if (done) {
      console.log('\n=== Stream ended ===');
      break;
    }
  }

  console.log('\nTotal chunks received:', chunkCount);
}

testSSE().catch((error) => {
  console.error('Error:', error.message);
  process.exit(1);
});
