'use strict';

import { spawn } from 'node:child_process';

const DEFAULT_COMMAND = 'bot-ocr';
const DEFAULT_PROMPT_FLAG = '--prompt';
const DEFAULT_TIMEOUT_MS = 180000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const IMAGE_PATH_PATTERN = /(?:^|[\s"'`])((?:\/|\.{1,2}\/|~\/)?[^\s"'`]+\.(?:png|jpe?g|webp|gif|bmp|tiff?|pdf))(?=$|[\s"'`,;])/gi;
const MISSING_COMMAND_ADVICE = "Create an agent on the 'Host OCR command' provider with an absolute command path (for example /home/wyatt/.bot-common/tools/bot-ocr), or set the 'command' config field.";
const NOT_EXECUTABLE_ADVICE = "The path exists but is not executable. Point the 'command' config field at the binary itself (for example /home/wyatt/.bot-common/tools/bot-ocr) and make sure it is executable.";
const TIMEOUT_ADVICE = "bot-ocr's -t/--timeout flag is per-image seconds (5-600) while the 'timeoutMs' config field is one millisecond deadline for the whole process, so a multi-image or PDF run needs a far larger deadline than any single -t value. Raise 'timeoutMs' (for example to 600000 for a PDF) if the command was still making progress.";
// bot-ocr renders and uploads each image separately, so one whole-process deadline
// must outlast at least one per-image budget plus process start-up.
const PROVIDER_TIMEOUT_MARGIN_MS = 5000;

export function setup(provide) {
  provide(({ registry }) => {
    let AgentInterface = registry.getClass('AgentInterface');
    if (!AgentInterface)
      throw new Error('kikx-plugin-ocr requires AgentInterface in plugin context');

    class HostOcrCommandAgent extends AgentInterface {
      static pluginId = 'host-ocr-command';
      static featureName = 'ocr';
      static displayName = 'Host OCR command';
      static description = 'OCR agent provider that runs a configured local command such as bot-ocr.';
      static agentType = 'host-ocr-command';
      static supportsOcr = true;
      static serviceType = 'host-command';
      static configFields = [
        {
          name: 'command',
          label: 'Command',
          type: 'text',
          required: true,
          defaultValue: DEFAULT_COMMAND,
          help: 'Executable to run, for example bot-ocr or an absolute path. It is spawned without a shell, so a bare name only works if it is on the server PATH; prefer an absolute path.',
        },
        {
          name: 'args',
          label: 'Extra arguments',
          type: 'text',
          required: false,
          defaultValue: '',
          help: 'Optional arguments placed before the prompt and image paths, for example -f markdown -t 180. These are passed through verbatim and are not validated. bot-ocr\'s -t/--timeout is seconds per image; it does not extend the whole-process Timeout (ms) deadline, which is raised for you when -t asks for more.',
        },
        {
          name: 'promptFlag',
          label: 'Prompt flag',
          type: 'text',
          required: false,
          defaultValue: DEFAULT_PROMPT_FLAG,
          help: 'Flag used to pass the OCR instruction. Set blank to omit the prompt flag.',
        },
        {
          name: 'timeoutMs',
          label: 'Timeout (ms)',
          type: 'number',
          required: false,
          defaultValue: DEFAULT_TIMEOUT_MS,
          help: 'Millisecond deadline for the whole OCR process, covering every image in the run. A single bot-ocr -t value is seconds per image, so a multi-image or PDF run needs more than one -t budget here.',
        },
      ];

      getCapabilities() {
        return {
          streaming: false,
          toolCalls: false,
          reflection: false,
          images: true,
        };
      }

      async runOcr(request = {}) {
        let images = normalizeImages(request.images);
        if (images.length === 0)
          throw new Error('host-ocr-command requires at least one image/PDF path');

        let config = this.context?.agent?.config || request.agent?.config || {};
        let command = normalizeString(config.command) || DEFAULT_COMMAND;
        let prompt = normalizeString(request.prompt);
        let promptFlag = config.promptFlag === '' ? '' : (normalizeString(config.promptFlag) || DEFAULT_PROMPT_FLAG);
        let args = [
          ...splitArguments(config.args),
          ...(prompt && promptFlag ? [ promptFlag, prompt ] : []),
          ...images,
        ];
        let requestedTimeoutMs = normalizePositiveInteger(config.timeoutMs, DEFAULT_TIMEOUT_MS);
        // `args` is free-form text spliced in verbatim, so the only place that knows
        // both halves of the units mismatch is here.
        let deadline = resolveDeadline(requestedTimeoutMs, args);
        let warnings = [];
        if (deadline.raised)
          warnings.push(`'timeoutMs' ${requestedTimeoutMs}ms was shorter than the ${deadline.providerTimeoutSeconds}s that -t/--timeout asked for, so the command was given a ${deadline.timeoutMs}ms deadline instead. bot-ocr's -t is seconds per image; 'timeoutMs' is one deadline for the whole process.`);

        let result = await runCommand(command, args, { timeoutMs: deadline.timeoutMs });
        if (result.exitCode !== 0) {
          let error = new Error(`OCR command failed with exit ${result.exitCode}: ${result.stderr.trim() || result.stdout.trim() || 'no output'}`);
          error.exitCode = result.exitCode;
          error.stdout = result.stdout;
          error.stderr = result.stderr;
          throw error;
        }

        return {
          text: result.stdout.trim(),
          command,
          args,
          exitCode: result.exitCode,
          stderr: result.stderr,
          durationMs: result.durationMs,
          timeoutMs: deadline.timeoutMs,
          warnings,
        };
      }

      async *ask(prompt, options = {}) {
        let text = normalizeString(prompt || options.frame?.content?.text);
        let images = extractImages(text);
        let result = await this.runOcr({
          ...options,
          images,
          prompt: text,
          agent: options.agent || this.context?.agent,
          session: options.session || this.context?.session,
        });
        yield {
          ...(options.responseFrameID ? { id: options.responseFrameID } : {}),
          type: 'AgentMessage',
          content: {
            text: result.text,
            status: 'complete',
            ocr: {
              command: result.command,
              exitCode: result.exitCode,
              durationMs: result.durationMs,
            },
          },
        };
      }
    }

    registry.registerAgentType('host-ocr-command', HostOcrCommandAgent);
  });
}

function normalizeImages(value) {
  let list = Array.isArray(value) ? value : typeof value === 'string' ? [ value ] : [];
  let images = [];
  for (let item of list) {
    let image = normalizeString(item);
    if (image && !images.includes(image))
      images.push(image);
  }
  return images;
}

function extractImages(text) {
  let images = [];
  let match;
  IMAGE_PATH_PATTERN.lastIndex = 0;
  while ((match = IMAGE_PATH_PATTERN.exec(String(text || ''))))
    if (!images.includes(match[1]))
      images.push(match[1]);
  return images;
}

function splitArguments(value) {
  let text = normalizeString(value);
  if (!text)
    return [];

  let args = [];
  let current = '';
  let quote = null;
  let escaped = false;
  for (let char of text) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote)
        quote = null;
      else
        current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = '';
      }
      continue;
    }
    current += char;
  }
  if (current)
    args.push(current);
  return args;
}

// The extra-arguments field is free text, so a `-t 300` in it is invisible to the
// timeout field and vice versa. Without this, an agent configured `args: -t 300`
// believes it has a 300-second budget while the wrapper kills the process at the
// 180-second default, and nothing ever says so.
function resolveDeadline(requestedMs, args) {
  let seconds = requestedProviderTimeoutSeconds(args);
  if (seconds == null)
    return { timeoutMs: requestedMs, providerTimeoutSeconds: null, raised: false };

  let floorMs = seconds * 1000 + PROVIDER_TIMEOUT_MARGIN_MS;
  return {
    timeoutMs: Math.max(requestedMs, floorMs),
    providerTimeoutSeconds: seconds,
    raised: floorMs > requestedMs,
  };
}

function requestedProviderTimeoutSeconds(args) {
  let seconds = null;
  for (let index = 0; index < args.length; index += 1) {
    let arg = String(args[index]);
    let value = null;
    if (arg === '-t' || arg === '--timeout')
      value = args[index + 1];
    else if (arg.startsWith('--timeout='))
      value = arg.slice('--timeout='.length);
    else if (/^-t\d/.test(arg))
      value = arg.slice(2);
    if (value == null || value === '')
      continue;
    let number = Number(value);
    if (Number.isFinite(number) && number > 0)
      seconds = number;
  }
  return seconds;
}

function runCommand(command, args, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: [ 'ignore', 'pipe', 'pipe' ] });
    } catch (error) {
      reject(describeSpawnFailure(command, error));
      return;
    }

    let startedAt = Date.now();
    let stdout = [];
    let stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;
    let timedOut = false;
    let timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 1000).unref?.();
    }, timeoutMs);
    timer.unref?.();

    let finish = (exitCode, signal, error = null) => {
      if (settled)
        return;
      settled = true;
      clearTimeout(timer);
      if (error)
        reject(error);
      else if (timedOut)
        reject(describeTimeout(command, {
          timeoutMs,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          durationMs: Date.now() - startedAt,
        }));
      else
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode,
          signal,
          durationMs: Date.now() - startedAt,
        });
    };

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES)
        child.kill('SIGKILL');
      else
        stdout.push(Buffer.from(chunk));
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_OUTPUT_BYTES)
        child.kill('SIGKILL');
      else
        stderr.push(Buffer.from(chunk));
    });
    child.on('error', (error) => finish(null, null, describeSpawnFailure(command, error)));
    child.on('close', (exitCode, signal) => finish(exitCode, signal));
  });
}

// A bare `spawn X ENOENT` names neither the resolved command nor the fix, and
// the resolved command is the whole story here: the plugin spawns without a
// shell, so a bare default such as `bot-ocr` only works if it is on PATH of the
// server process. Say which command failed and what to configure instead.
function describeSpawnFailure(command, error) {
  if (error?.code !== 'ENOENT' && error?.code !== 'EACCES')
    return error;

  // EACCES is the sibling of ENOENT here, not a separate bug: same plugin, same
  // config field, same "nothing says what to configure" complaint. A directory or
  // a non-executable file reach the caller as a bare `spawn X EACCES`.
  let failure = error.code === 'EACCES'
    ? new Error(`OCR command '${command}' could not be executed. ${NOT_EXECUTABLE_ADVICE}`)
    : new Error(`OCR command '${command}' was not found. ${MISSING_COMMAND_ADVICE}`);
  failure.code = error.code;
  failure.errno = error.errno;
  failure.syscall = error.syscall;
  failure.path = error.path;
  if ('exitCode' in error)
    failure.exitCode = error.exitCode;
  // Keep the failure shape uniform with the non-zero-exit path in runOcr so
  // callers can read error.stdout/error.stderr without a type check.
  failure.stdout = '';
  failure.stderr = '';
  failure.cause = error;
  return failure;
}

// The timeout was the third silent failure mode here, after ENOENT and EACCES:
// `OCR command timed out after 2000ms` named no command, no cause and carried no
// exitCode, so the reader could not tell a slow binary from a huge prompt from
// timeoutMs disagreeing with bot-ocr's own -t. Whatever the command managed to
// print before the kill is the most useful evidence, so keep it.
function describeTimeout(command, { timeoutMs, stdout, stderr, durationMs }) {
  let error = new Error(`OCR command '${command}' was killed after ${timeoutMs}ms without finishing. ${TIMEOUT_ADVICE}`);
  error.code = 'ETIMEDOUT';
  error.command = command;
  error.timeoutMs = timeoutMs;
  error.durationMs = durationMs;
  error.exitCode = null;
  error.stdout = stdout;
  error.stderr = stderr;
  return error;
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePositiveInteger(value, fallback) {
  let number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}
