'use strict';

// Provider turns are idempotent until they emit response content. Ollama Cloud
// and other remote providers occasionally fail at the validation/transport
// layer with a 5xx before a single token arrives. Retry only that empty prefix:
// replaying after visible content or a tool call would duplicate user-visible
// work or repeat side effects.

export const DEFAULT_PROVIDER_RETRY_DELAYS_MS = Object.freeze([ 1000, 2000, 3000, 4000 ]);

// BeginTyping/EndTyping are phantom UI signals, not provider output. Keeping
// them retry-safe lets a failed stream restart without duplicating content.
const RETRY_SAFE_OUTPUT_TYPES = new Set([ 'BeginTyping', 'EndTyping' ]);

const RETRYABLE_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENETRESET',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET',
]);

const RETRYABLE_TRANSIENT_ERROR_REGEX = /\b(?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Timeout|Too Many Requests)\b/i;

export function isSubstantiveProviderOutput(output) {
  if (!output || typeof output.type !== 'string')
    return true;

  // Phantom outputs are UI previews that are NEVER committed: they are keyed
  // by responseFrameID, so a retry's fresh stream replaces them in place
  // (same delta/thinking ids) instead of duplicating anything durable, and no
  // tool has run before the stream's done line. Counting them as substantive
  // disabled mid-stream recovery — incident 2026-11-05 (session
  // aaa31337): an Ollama stream died 45s in on "Ollama stream error: Gateway
  // Timeout" after only phantom thinking/text deltas, and because
  // substantiveOutput was already true the retry ladder never engaged, so the
  // error closed the turn and the bot went silent. Non-phantom content of any
  // type still blocks replay exactly as before.
  if (output.phantom === true)
    return false;

  return !RETRY_SAFE_OUTPUT_TYPES.has(output.type);
}

export function isRetryableProviderError(error) {
  if (!error || error.retryable === false)
    return false;

  if (error.retryable === true)
    return true;

  let status = normalizeStatus(error.status ?? error.statusCode ?? error.response?.status);
  if (status === 429 || (status != null && status >= 500 && status <= 599))
    return true;

  let code = normalizeCode(error.code ?? error.cause?.code);
  if (code && (RETRYABLE_NETWORK_CODES.has(code) || code.startsWith('UND_ERR_')))
    return true;

  let message = String(error.message || '');
  if (/\bHTTP\s+(?:429|5\d\d)\b/i.test(message))
    return true;
  if (RETRYABLE_TRANSIENT_ERROR_REGEX.test(message))
    return true;

  return false;
}

export async function* runProviderWithRetry({
  createProvider,
  runParams = {},
  retryDelaysMs = DEFAULT_PROVIDER_RETRY_DELAYS_MS,
  isRetryable = isRetryableProviderError,
  sleep = defaultSleep,
  onRetry = null,
} = {}) {
  if (typeof createProvider !== 'function')
    throw new TypeError('runProviderWithRetry requires createProvider()');

  let delays = normalizeRetryDelays(retryDelaysMs);

  for (let attempt = 0; ; attempt++) {
    let provider = createProvider();
    if (typeof provider?.run !== 'function')
      throw new TypeError('Provider does not provide run()');

    let substantiveOutput = false;
    try {
      for await (let output of provider.run(runParams)) {
        if (isSubstantiveProviderOutput(output))
          substantiveOutput = true;
        yield output;
      }
      return;
    } catch (error) {
      let canRetry = !substantiveOutput
        && provider.providerRetryUnsafe !== true
        && provider._providerRetryUnsafe !== true
        && attempt < delays.length
        && isRetryable(error);
      if (!canRetry) {
        if (attempt > 0 && error && typeof error === 'object')
          error.providerAttempts = attempt + 1;
        throw error;
      }

      let delayMs = delays[attempt];
      let nextAttempt = attempt + 2;
      onRetry?.({
        attempt: nextAttempt,
        maxAttempts: delays.length + 1,
        delayMs,
        error,
      });
      await sleep(delayMs);
    }
  }
}

function normalizeRetryDelays(value) {
  if (!Array.isArray(value))
    return [ ...DEFAULT_PROVIDER_RETRY_DELAYS_MS ];

  return value.map((delay) => {
    let number = Number(delay);
    return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : 0;
  });
}

function normalizeStatus(value) {
  let number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function normalizeCode(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim().toUpperCase() : '';
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
