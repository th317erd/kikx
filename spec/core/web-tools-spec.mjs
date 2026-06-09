'use strict';

import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { PluginRegistry } from '../../src/core/plugins/index.mjs';
import {
  LocalFileAccessService,
  PuppeteerBrowserService,
  ReadFileTool,
  registerBuiltInTools,
  ToolExecutionService,
  ToolOutputGetTool,
  ToolOutputStore,
  WebFetchTool,
  WebSearchTool,
  WriteFileTool,
} from '../../src/core/tools/index.mjs';

class EchoTool {
  constructor(context = {}) {
    this.context = context;
  }

  async execute(input = {}) {
    return {
      text: input.text,
      agentID: input._agentID,
      sessionID: input._sessionID,
      frameID: input._frameID,
    };
  }
}

test('registerBuiltInTools registers global web tools with OpenAI-safe names', () => {
  let registry = new PluginRegistry({ logger: { warn() {} } });

  registerBuiltInTools(registry);

  assert.equal(registry.getTool('web-search'), WebSearchTool);
  assert.equal(registry.getTool('web-fetch'), WebFetchTool);
  assert.equal(registry.getTool('read-file'), ReadFileTool);
  assert.equal(registry.getTool('write-file'), WriteFileTool);
  assert.equal(registry.getTool('tool-output-get'), ToolOutputGetTool);
  assert.equal([...registry.getTools().keys()].every((name) => /^[A-Za-z0-9_-]+$/.test(name)), true);
});

test('ReadFileTool reads local files through the file access service', async () => {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-read-file-'));
  let filePath = path.join(dir, 'sample.txt');
  await fs.writeFile(filePath, 'hello world\n', 'utf8');

  let tool = new ReadFileTool({
    services: {
      fileAccess: new LocalFileAccessService({ cwd: dir }),
    },
  });
  let result = await tool.execute({
    path: 'sample.txt',
  });

  assert.equal(result.requestedPath, 'sample.txt');
  assert.equal(result.path, filePath);
  assert.equal(result.encoding, 'utf8');
  assert.equal(result.sizeBytes, 12);
  assert.equal(result.bytesRead, 12);
  assert.equal(result.truncated, false);
  assert.equal(result.ranged, false);
  assert.equal(result.rangeType, null);
  assert.equal(result.range, null);
  assert.equal(result.content, 'hello world\n');
});

test('ReadFileTool reads 1-based inclusive line ranges', async () => {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-read-lines-'));
  let filePath = path.join(dir, 'sample.txt');
  await fs.writeFile(filePath, 'one\ntwo\nthree\nfour\n', 'utf8');

  let tool = new ReadFileTool({
    services: {
      fileAccess: new LocalFileAccessService({ cwd: dir }),
    },
  });
  let result = await tool.execute({
    path: 'sample.txt',
    startLine: 2,
    endLine: 3,
  });

  assert.equal(result.path, filePath);
  assert.equal(result.sizeBytes, 19);
  assert.equal(result.bytesRead, 10);
  assert.equal(result.truncated, true);
  assert.equal(result.ranged, true);
  assert.equal(result.rangeType, 'line');
  assert.deepEqual(result.range, {
    type: 'line',
    startLine: 2,
    endLine: 3,
    totalLines: 4,
  });
  assert.equal(result.content, 'two\nthree\n');
});

test('ReadFileTool reads 0-based exclusive character ranges', async () => {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-read-chars-'));
  await fs.writeFile(path.join(dir, 'sample.txt'), 'abcde🙂f', 'utf8');

  let tool = new ReadFileTool({
    services: {
      fileAccess: new LocalFileAccessService({ cwd: dir }),
    },
  });
  let result = await tool.execute({
    path: 'sample.txt',
    startCharacter: 2,
    endCharacter: 6,
  });

  assert.equal(result.content, 'cde🙂');
  assert.equal(result.bytesRead, Buffer.byteLength('cde🙂', 'utf8'));
  assert.equal(result.truncated, true);
  assert.equal(result.ranged, true);
  assert.equal(result.rangeType, 'character');
  assert.deepEqual(result.range, {
    type: 'character',
    startCharacter: 2,
    endCharacter: 6,
    totalCharacters: 7,
  });
});

test('ReadFileTool rejects ambiguous ranges', async () => {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-read-bad-range-'));
  await fs.writeFile(path.join(dir, 'sample.txt'), 'hello', 'utf8');
  let tool = new ReadFileTool({
    services: {
      fileAccess: new LocalFileAccessService({ cwd: dir }),
    },
  });

  await assert.rejects(
    () => tool.execute({
      path: 'sample.txt',
      startLine: 1,
      startCharacter: 0,
    }),
    /either a line range or a character range/,
  );
});

test('WriteFileTool writes local files through the file access service', async () => {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-write-file-'));
  let filePath = path.join(dir, 'nested', 'sample.txt');
  let tool = new WriteFileTool({
    services: {
      fileAccess: new LocalFileAccessService({ cwd: dir }),
    },
  });

  let result = await tool.execute({
    path: 'nested/sample.txt',
    content: 'hello world\n',
  });

  assert.equal(result.requestedPath, 'nested/sample.txt');
  assert.equal(result.path, filePath);
  assert.equal(result.encoding, 'utf8');
  assert.equal(result.mode, 'overwrite');
  assert.equal(result.bytesWritten, 12);
  assert.equal(result.sizeBytes, 12);
  assert.equal(result.created, true);
  assert.equal(result.appended, false);
  assert.equal(result.createDirectories, true);
  assert.equal(await fs.readFile(filePath, 'utf8'), 'hello world\n');
});

test('WriteFileTool appends and create mode refuses existing files', async () => {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-write-append-'));
  let filePath = path.join(dir, 'sample.txt');
  await fs.writeFile(filePath, 'one\n', 'utf8');

  let tool = new WriteFileTool({
    services: {
      fileAccess: new LocalFileAccessService({ cwd: dir }),
    },
  });
  let appendResult = await tool.execute({
    path: 'sample.txt',
    content: 'two\n',
    mode: 'append',
  });

  assert.equal(appendResult.created, false);
  assert.equal(appendResult.appended, true);
  assert.equal(appendResult.sizeBytes, 8);
  assert.equal(await fs.readFile(filePath, 'utf8'), 'one\ntwo\n');

  await assert.rejects(
    () => tool.execute({
      path: 'sample.txt',
      content: 'three\n',
      mode: 'create',
    }),
    /refusing to overwrite existing file/,
  );
  assert.equal(await fs.readFile(filePath, 'utf8'), 'one\ntwo\n');
});

test('WriteFileTool supports empty and base64 content', async () => {
  let dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kikx-write-base64-'));
  let tool = new WriteFileTool({
    services: {
      fileAccess: new LocalFileAccessService({ cwd: dir }),
    },
  });

  let emptyResult = await tool.execute({
    path: 'empty.txt',
    content: '',
  });
  assert.equal(emptyResult.bytesWritten, 0);
  assert.equal(await fs.readFile(path.join(dir, 'empty.txt'), 'utf8'), '');

  let base64Result = await tool.execute({
    path: 'binary.bin',
    content: Buffer.from([ 0, 1, 2, 255 ]).toString('base64'),
    encoding: 'base64',
  });
  assert.equal(base64Result.encoding, 'base64');
  assert.equal(base64Result.bytesWritten, 4);
  assert.deepEqual([...(await fs.readFile(path.join(dir, 'binary.bin')))], [ 0, 1, 2, 255 ]);
});

test('WriteFileTool requires consolidated file access service', async () => {
  let tool = new WriteFileTool();

  await assert.rejects(
    () => tool.execute({ path: '/tmp/example.txt', content: 'hello' }),
    /write-file requires a fileAccess service/,
  );
});

test('ToolExecutionService stores every tool result and returns inline envelope below limit', async () => {
  let aeordb = createFakeToolOutputDB();
  let store = new ToolOutputStore({
    aeordb,
    idGenerator: () => 'OUT1',
    clock: () => '2026-06-08T00:00:00.000Z',
  });
  let result = await new ToolExecutionService({ toolOutputStore: store }).executeTool({
    toolName: 'global-echo',
    ToolClass: EchoTool,
    input: { text: 'hello' },
    context: {
      agent: { id: 'agent_1' },
      session: { id: 'ses_1' },
      frame: { id: 'frm_1' },
    },
  });

  assert.equal(result.type, 'ToolOutput');
  assert.equal(result.toolOutputID, 'OUT1');
  assert.equal(result.stored, true);
  assert.equal(result.inline, true);
  assert.equal(result.retrieval.getTool, 'tool-output-get');
  assert.deepEqual(result.retrieval.getAll.arguments, {
    id: 'OUT1',
    full: true,
  });
  assert.deepEqual(result.result, {
    text: 'hello',
    agentID: 'agent_1',
    sessionID: 'ses_1',
    frameID: 'frm_1',
  });

  assert.ok(aeordb.files.has('/kikx/tool-outputs/.aeordb-config/indexes.json'));
  assert.equal(aeordb.files.get('/kikx/tool-outputs/OUT1/metadata.json').toolName, 'global-echo');
  assert.match(aeordb.files.get('/kikx/tool-outputs/OUT1/result.txt'), /"text": "hello"/);
});

test('ToolExecutionService returns a pointer envelope for outputs above inline limit', async () => {
  let aeordb = createFakeToolOutputDB();
  let store = new ToolOutputStore({
    aeordb,
    inlineLimitBytes: 180,
    defaultReadBytes: 32,
    idGenerator: () => 'BIG1',
  });

  class BigTool {
    async execute() {
      return { content: 'x'.repeat(512) };
    }
  }

  let result = await new ToolExecutionService({ toolOutputStore: store }).executeTool({
    toolName: 'big-tool',
    ToolClass: BigTool,
    input: {},
    context: {},
  });

  assert.equal(result.type, 'ToolOutputPointer');
  assert.equal(result.toolOutputID, 'BIG1');
  assert.equal(result.inline, false);
  assert.equal(result.sizeBytes > 512, true);
  assert.equal(result.retrieval.getRange.tool, 'tool-output-get');
  assert.deepEqual(result.retrieval.getRange.arguments, {
    id: 'BIG1',
    start: 0,
    end: 32,
  });
  assert.match(result.message, /tool-output-get/);
  assert.match(result.message, /"full":true/);
  assert.equal('result' in result, false);
  assert.match(aeordb.files.get('/kikx/tool-outputs/BIG1/result.txt'), /"content"/);
});

test('ToolOutputGetTool retrieves stored output ranges', async () => {
  let aeordb = createFakeToolOutputDB();
  let store = new ToolOutputStore({
    aeordb,
    idGenerator: () => 'RANGE1',
  });
  await store.storeToolOutput({
    toolName: 'plain-text',
    result: 'abcdef',
  });

  let tool = new ToolOutputGetTool({
    services: { toolOutputStore: store },
  });
  let result = await tool.execute({
    id: 'RANGE1',
    start: 2,
    end: 5,
  });

  assert.equal(result.id, 'RANGE1');
  assert.equal(result.content, 'cde');
  assert.equal(result.start, 2);
  assert.equal(result.end, 5);
  assert.equal(result.returnedBytes, 3);
  assert.equal(result.truncated, true);
  assert.ok(aeordb.calls.some((call) => call.method === 'getFile' && call.options?.headers?.Range === 'bytes=2-4'));
});

test('ReadFileTool requires consolidated file access service', async () => {
  let tool = new ReadFileTool();

  await assert.rejects(
    () => tool.execute({ path: '/tmp/example.txt' }),
    /read-file requires a fileAccess service/,
  );
});

test('WebSearchTool queries DuckDuckGo instant answers and normalizes results', async () => {
  let requestedURL = null;
  let tool = new WebSearchTool({
    fetchImpl: async (url, options = {}) => {
      requestedURL = new URL(url);
      assert.equal(options.headers.Accept, 'application/json');
      return {
        ok: true,
        async text() {
          return JSON.stringify({
            Heading: 'Kikx',
            AbstractText: 'A modular agent runner.',
            AbstractURL: 'https://example.test/kikx',
            AbstractSource: 'Example',
            Answer: '42',
            Results: [
              {
                Text: 'Kikx result',
                FirstURL: 'https://example.test/result',
              },
            ],
            RelatedTopics: [
              {
                Name: 'Related',
                Topics: [
                  {
                    Text: 'Nested related result',
                    FirstURL: 'https://example.test/related',
                  },
                ],
              },
            ],
          });
        },
      };
    },
  });

  let result = await tool.execute({
    query: 'kikx agent runner',
    maxResults: 3,
  });

  assert.equal(requestedURL.origin, 'https://api.duckduckgo.com');
  assert.equal(requestedURL.searchParams.get('q'), 'kikx agent runner');
  assert.equal(requestedURL.searchParams.get('format'), 'json');
  assert.equal(result.source, 'duckduckgo-instant-answer');
  assert.equal(result.heading, 'Kikx');
  assert.equal(result.results.length, 3);
  assert.deepEqual(result.results.map((item) => item.type), [ 'abstract', 'answer', 'result' ]);
  assert.equal(result.results[0].url, 'https://example.test/kikx');
});

test('WebSearchTool falls back to DuckDuckGo HTML results when instant answers are empty', async () => {
  let requests = [];
  let tool = new WebSearchTool({
    fetchImpl: async (url, options = {}) => {
      let requestedURL = new URL(url);
      requests.push({
        url: requestedURL,
        accept: options.headers.Accept,
      });

      if (requestedURL.origin === 'https://api.duckduckgo.com') {
        return {
          ok: true,
          async text() {
            return JSON.stringify({
              Heading: '',
              Results: [],
              RelatedTopics: [],
            });
          },
        };
      }

      return {
        ok: true,
        async text() {
          return `
            <div class="result results_links results_links_deep web-result">
              <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fforecast.weather.gov%2Fzipcity.php%3Finputstring%3DPhoenix%2CAZ&amp;rut=abc">
                7-Day Forecast 33.45N 112.07W - National Weather Service
              </a>
              <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fforecast.weather.gov%2Fzipcity.php%3Finputstring%3DPhoenix%2CAZ&amp;rut=abc">
                Your local <b>forecast</b> office is <b>Phoenix</b>, <b>AZ</b>.
              </a>
            </div>
            <div class="result results_links results_links_deep web-result">
              <a rel="nofollow" class="result__a" href="https://www.weather.gov/psr/">NWS Forecast Office Phoenix, AZ</a>
              <a class="result__snippet" href="https://www.weather.gov/psr/">Weather forecast office page.</a>
            </div>
          `;
        },
      };
    },
  });

  let result = await tool.execute({
    query: 'Phoenix AZ weather forecast National Weather Service',
    maxResults: 2,
  });

  assert.equal(requests.length, 2);
  assert.equal(requests[0].url.origin, 'https://api.duckduckgo.com');
  assert.equal(requests[1].url.origin, 'https://html.duckduckgo.com');
  assert.equal(requests[1].accept, 'text/html,application/xhtml+xml');
  assert.equal(result.source, 'duckduckgo-html');
  assert.equal(result.resultCount, 2);
  assert.equal(result.results[0].url, 'https://forecast.weather.gov/zipcity.php?inputstring=Phoenix,AZ');
  assert.equal(result.results[0].text, 'Your local forecast office is Phoenix, AZ.');
  assert.equal(result.results[0].source, 'forecast.weather.gov');
  assert.equal(result.results[1].url, 'https://www.weather.gov/psr/');
});

test('WebSearchTool reports empty DuckDuckGo responses with query context', async () => {
  let tool = new WebSearchTool({
    fetchImpl: async () => ({
      ok: true,
      async text() {
        return '';
      },
    }),
  });

  await assert.rejects(
    () => tool.execute({ query: 'Phoenix weather' }),
    /DuckDuckGo returned an empty response for query: Phoenix weather/,
  );
});

test('WebFetchTool extracts rendered page details through injected browser service', async () => {
  let visitedURL = null;
  let browserService = {
    async withPage(callback) {
      let page = {
        setDefaultNavigationTimeout(timeout) {
          assert.equal(timeout, 5000);
        },
        setDefaultTimeout(timeout) {
          assert.equal(timeout, 5000);
        },
        async setUserAgent(userAgent) {
          assert.match(userAgent, /Kikx/);
        },
        async goto(url, options = {}) {
          visitedURL = url;
          assert.equal(options.waitUntil, 'domcontentloaded');
          return {
            status() {
              return 200;
            },
          };
        },
        async waitForSelector(selector) {
          assert.equal(selector, 'main');
        },
        async evaluate(_fn, args) {
          assert.deepEqual(args, {
            selector: 'main',
            maxTextLength: 2000,
            maxLinks: 2,
          });
          let evaluated = vm.runInNewContext(`(${_fn.toString()})(args)`, {
            args,
            document: {
              title: 'Example Page',
              body: {
                innerText: 'Rendered   text\n\n\nMore text',
              },
              documentElement: {
                innerText: 'Fallback text',
              },
              querySelector(selector) {
                assert.equal(selector, 'main');
                return {
                  innerText: 'Rendered   text\n\n\nMore text',
                };
              },
              querySelectorAll(selector) {
                assert.equal(selector, 'a[href]');
                return [
                  {
                    innerText: 'Docs\nLink',
                    href: 'https://example.test/docs',
                  },
                  {
                    textContent: 'Other Link',
                    href: 'https://example.test/other',
                  },
                  {
                    innerText: 'Hidden',
                    href: '',
                  },
                ];
              },
            },
            location: {
              href: 'https://example.test/final',
            },
          });
          return JSON.parse(JSON.stringify(evaluated));
        },
      };

      return await callback(page, { mode: 'cdp' });
    },
  };

  let tool = new WebFetchTool({
    services: { webBrowser: browserService },
  });
  let result = await tool.execute({
    url: 'https://example.test/start',
    selector: 'main',
    timeoutMs: 5000,
    maxTextLength: 2000,
    maxLinks: 2,
  });

  assert.equal(visitedURL, 'https://example.test/start');
  assert.deepEqual(result, {
    requestedURL: 'https://example.test/start',
    finalURL: 'https://example.test/final',
    title: 'Example Page',
    status: 200,
    browserMode: 'cdp',
    selector: 'main',
    text: 'Rendered text\n\nMore text',
    textTruncated: false,
    links: [
      { text: 'Docs\nLink', url: 'https://example.test/docs' },
      { text: 'Other Link', url: 'https://example.test/other' },
    ],
  });
});

test('WebFetchTool rejects non-http URLs', async () => {
  let tool = new WebFetchTool({
    services: {
      webBrowser: {
        async withPage() {
          throw new Error('should not open browser');
        },
      },
    },
  });

  await assert.rejects(
    () => tool.execute({ url: 'file:///etc/passwd' }),
    /url must use http or https/,
  );
});

test('PuppeteerBrowserService falls back to headless stealth launch with a Chrome channel', async () => {
  let launchOptions = null;
  let closed = false;
  let service = new PuppeteerBrowserService({
    puppeteerCore: {
      async connect() {
        throw new Error('cdp offline');
      },
    },
    stealthPuppeteer: {
      async launch(options) {
        launchOptions = options;
        return {
          on() {},
          async close() {
            closed = true;
          },
        };
      },
    },
  });

  await service.browser();
  await service.close();

  assert.equal(launchOptions.headless, true);
  assert.equal(launchOptions.channel, 'chrome');
  assert.deepEqual(launchOptions.args.slice(0, 2), [ '--no-sandbox', '--disable-setuid-sandbox' ]);
  assert.equal(closed, true);
});

function createFakeToolOutputDB() {
  let files = new Map();
  let calls = [];

  return {
    files,
    calls,
    async putFile(path, body, options = {}) {
      calls.push({ method: 'putFile', path, body, options });
      files.set(path, body);
      return { path };
    },
    async getFile(path, options = {}) {
      calls.push({ method: 'getFile', path, options });
      if (!files.has(path)) {
        let error = new Error(`missing file: ${path}`);
        error.status = 404;
        throw error;
      }

      let value = files.get(path);
      if (options.expectJSON === false)
        return String(value ?? '');

      return value;
    },
    async searchFiles(search) {
      calls.push({ method: 'searchFiles', search });
      return { results: [] };
    },
  };
}
