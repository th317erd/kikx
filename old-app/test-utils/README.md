# SSE/Anthropic API Test Utilities

These test files help debug SSE streaming issues with the Anthropic API.

## Files

- `minimal-sse-test.mjs` - Raw Node.js HTTP server (no Express) - works correctly
- `minimal-sse-client.mjs` - Fetch-based client for testing SSE
- `minimal-express-no-json.mjs` - Express GET route without express.json() - works
- `minimal-express-test.mjs` - Express POST route WITH express.json() - fails
- `express-post-raw.mjs` - Express POST with manual body parsing - works
- `express-json-issue.mjs` - Reproduces the express.json() SSE bug
- `express-res-close.mjs` - Shows the fix using res.on('close')

## Key Finding

`express.json()` middleware causes `req.on('close')` to fire prematurely after
parsing the request body, even though the SSE response stream is still active.

**Fix**: Use `res.on('close')` instead of `req.on('close')` for detecting
client disconnection in SSE handlers.

## Usage

```bash
# Get API key from database
node get-api-key.mjs  # or use the API key directly

# Run a test server
ANTHROPIC_API_KEY="sk-xxx" node test-utils/minimal-sse-test.mjs

# In another terminal, test with curl
curl -N http://localhost:9999/stream
```
