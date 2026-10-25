'use strict';

import { spawn } from 'node:child_process';

const DEFAULT_COMMAND = 'bot-ocr';
const DEFAULT_PROMPT_FLAG = '--prompt';
const DEFAULT_TIMEOUT_MS = 180000;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const IMAGE_PATH_PATTERN = /(?:^|[\s"'`])((?:\/|\.{1,2}\/|~\/)?[^\s"'`]+\.(?:png|jpe?g|webp|gif|bmp|tiff?|pdf))(?=$|[\s"'`,;])/gi;

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
      static serviceType = 'host-command';
      static configFields = [
        {
          name: 'command',
          label: 'Command',
          type: 'text',
          required: true,
          defaultValue: DEFAULT_COMMAND,
          help: 'Executable to run, for example bot-ocr or an absolute path.',
        },
        {
          name: 'args',
          label: 'Extra arguments',
          type: 'text',
          required: false,
          defaultValue: '',
          help: 'Optional arguments placed before the prompt and image paths, for example -f markdown -t 180.',
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
          help: 'Maximum runtime for one OCR command.',
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
        let timeoutMs = normalizePositiveInteger(config.timeoutMs, DEFAULT_TIMEOUT_MS);
        let result = await runCommand(command, args, { timeoutMs });
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

function runCommand(command, args, { timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: [ 'ignore', 'pipe', 'pipe' ] });
    } catch (error) {
      reject(error);
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
        reject(new Error(`OCR command timed out after ${timeoutMs}ms`));
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
    child.on('error', (error) => finish(null, null, error));
    child.on('close', (exitCode, signal) => finish(exitCode, signal));
  });
}

function normalizeString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePositiveInteger(value, fallback) {
  let number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.trunc(number) : fallback;
}
