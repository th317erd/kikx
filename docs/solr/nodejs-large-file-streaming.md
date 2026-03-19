# Node.js Best Practices for Streaming Large Files

> Target runtime: Node.js 20+ / 22+

---

## Table of Contents

1. [Stream Fundamentals](#1-stream-fundamentals)
   - 1.1 [The Four Stream Types](#11-the-four-stream-types)
   - 1.2 [Flowing vs. Paused Mode](#12-flowing-vs-paused-mode)
   - 1.3 [Object Mode](#13-object-mode)
   - 1.4 [Backpressure](#14-backpressure)
   - 1.5 [pipeline() vs. pipe()](#15-pipeline-vs-pipe)
   - 1.6 [Async Iteration over Streams](#16-async-iteration-over-streams)
2. [Large File Streaming Patterns](#2-large-file-streaming-patterns)
   - 2.1 [Reading Files from Disk](#21-reading-files-from-disk)
   - 2.2 [Streaming HTTP Responses (Sending)](#22-streaming-http-responses-sending)
   - 2.3 [Streaming HTTP Responses (Receiving)](#23-streaming-http-responses-receiving)
   - 2.4 [Chunked Transfer Encoding](#24-chunked-transfer-encoding)
   - 2.5 [HTTP Range Requests for Partial Delivery](#25-http-range-requests-for-partial-delivery)
   - 2.6 [Streaming Multipart Uploads](#26-streaming-multipart-uploads)
   - 2.7 [Transform Streams for On-the-Fly Processing](#27-transform-streams-for-on-the-fly-processing)
3. [Specific Use Cases](#3-specific-use-cases)
   - 3.1 [Streaming Large Files to/from S3 (AWS SDK v3)](#31-streaming-large-files-tofrom-s3-aws-sdk-v3)
   - 3.2 [Streaming Large JSON](#32-streaming-large-json)
   - 3.3 [Streaming CSV and NDJSON](#33-streaming-csv-and-ndjson)
   - 3.4 [File → Compress → Encrypt → Upload Pipeline](#34-file--compress--encrypt--upload-pipeline)
   - 3.5 [Serving Video/Audio with Range Support](#35-serving-videoaudio-with-range-support)
   - 3.6 [Streaming Solr Responses](#36-streaming-solr-responses)
4. [Performance and Pitfalls](#4-performance-and-pitfalls)
   - 4.1 [Choosing the Right highWaterMark](#41-choosing-the-right-highwatermark)
   - 4.2 [Memory Leak Patterns](#42-memory-leak-patterns)
   - 4.3 [Error Handling and Cleanup](#43-error-handling-and-cleanup)
   - 4.4 [Workers for CPU-Bound Transform Operations](#44-workers-for-cpu-bound-transform-operations)

---

## 1. Stream Fundamentals

### 1.1 The Four Stream Types

Node.js exposes four abstract stream classes in the `node:stream` module:

| Type | Description | Example |
|------|-------------|---------|
| `Readable` | Produces data; consumers read from it | `fs.createReadStream`, `http.IncomingMessage` |
| `Writable` | Consumes data; producers write to it | `fs.createWriteStream`, `http.ServerResponse` |
| `Duplex` | Both readable and writable (independent sides) | `net.Socket`, `tls.TLSSocket` |
| `Transform` | Duplex where output is derived from input | `zlib.createGzip()`, `crypto.createCipheriv()` |

All four inherit from `EventEmitter` and share a common buffering/backpressure mechanism.

```js
'use strict';

import { Readable, Writable, Transform, Duplex } from 'node:stream';

// Custom Readable: produces incrementing numbers
class CounterStream extends Readable {
  constructor(options) {
    super({ objectMode: true, ...options });
    this._counter = 0;
    this._max     = options.max ?? 100;
  }

  _read() {
    if (this._counter >= this._max) {
      this.push(null); // signal end-of-stream
      return;
    }
    this.push(this._counter++);
  }
}

// Custom Writable: logs each chunk
class LogWritable extends Writable {
  _write(chunk, encoding, callback) {
    console.log('received:', chunk);
    callback(); // MUST call callback to signal readiness for next chunk
  }
}

// Custom Transform: doubles each number
class DoubleTransform extends Transform {
  constructor(options) {
    super({ objectMode: true, ...options });
  }

  _transform(chunk, encoding, callback) {
    this.push(chunk * 2);
    callback();
  }
}
```

### 1.2 Flowing vs. Paused Mode

Every `Readable` starts in **paused mode** — it will not emit data until something consumes it. A stream enters **flowing mode** when:

- A `'data'` event listener is attached
- `.pipe()` or `.pipeline()` is called
- `.resume()` is called explicitly
- `for await...of` is used (handled internally)

```js
'use strict';

import { createReadStream } from 'node:fs';

const stream = createReadStream('/path/to/large-file.bin');

// Paused mode — pull manually
stream.on('readable', () => {
  let chunk;
  while ((chunk = stream.read(64 * 1024)) !== null) {
    console.log(`Read ${chunk.length} bytes`);
  }
});

stream.on('end', () => console.log('Done'));

// OR: Flowing mode — push via 'data' event
// (Less preferred; harder to manage backpressure manually)
stream.on('data', (chunk) => {
  console.log(`Chunk: ${chunk.length} bytes`);
});
```

**Rule of thumb**: Prefer `pipeline()`, `for await...of`, or `.pipe()` over raw `'data'` event listeners. Raw flowing mode requires you to implement backpressure manually.

### 1.3 Object Mode

By default streams operate on `Buffer` / `string` chunks. Setting `objectMode: true` allows streams to push/pull arbitrary JavaScript values (objects, numbers, etc.). This is essential for processing pipelines where parsed records flow between stages.

```js
'use strict';

import { Transform } from 'node:stream';

// Parses CSV lines (strings) into plain objects
class CsvRowParser extends Transform {
  constructor(headers) {
    super({ objectMode: true });
    this._headers  = headers;
    this._leftover = '';
  }

  _transform(chunk, encoding, callback) {
    const lines = (this._leftover + chunk.toString()).split('\n');
    this._leftover = lines.pop(); // keep incomplete trailing line

    for (const line of lines) {
      if (!line.trim())
        continue;

      const values = line.split(',');
      const record = {};
      for (let index = 0; index < this._headers.length; index++)
        record[this._headers[index]] = values[index];

      this.push(record);
    }
    callback();
  }

  _flush(callback) {
    if (this._leftover.trim()) {
      const values = this._leftover.split(',');
      const record = {};
      for (let index = 0; index < this._headers.length; index++)
        record[this._headers[index]] = values[index];
      this.push(record);
    }
    callback();
  }
}
```

**Caution**: Object mode streams do not respect `highWaterMark` in bytes — the watermark is measured in *object count* (default: 16 objects). Size each appropriately.

### 1.4 Backpressure

Backpressure is a flow-control mechanism that prevents a fast producer from overwhelming a slow consumer. Understanding it prevents out-of-memory crashes on large files.

**How it works:**

1. Each `Writable` has an internal buffer capped by `highWaterMark` (default: 16 KB for bytes, 16 objects for object mode).
2. `.write()` returns `false` when the buffer is at or above `highWaterMark`.
3. The producer **must stop writing** when `.write()` returns `false`.
4. When the consumer drains the buffer, a `'drain'` event fires — the producer resumes.

```js
'use strict';

import { createReadStream, createWriteStream } from 'node:fs';

// WRONG: ignores backpressure — will buffer everything in memory
function badCopy(source, destination) {
  const readable = createReadStream(source);
  const writable = createWriteStream(destination);

  readable.on('data', (chunk) => {
    writable.write(chunk); // return value ignored!
  });
}

// CORRECT: manual backpressure handling
function goodCopyManual(source, destination) {
  const readable = createReadStream(source);
  const writable = createWriteStream(destination);

  readable.on('data', (chunk) => {
    const canContinue = writable.write(chunk);
    if (!canContinue) {
      readable.pause();                      // stop reading
      writable.once('drain', () => {
        readable.resume();                   // resume when drained
      });
    }
  });

  readable.on('end', () => writable.end());
  readable.on('error', (error) => writable.destroy(error));
  writable.on('error', (error) => readable.destroy(error));
}
```

In practice, you should **never write this plumbing by hand**. Use `pipeline()` instead — it handles all of it automatically.

### 1.5 pipeline() vs. pipe()

**`pipe()` is deprecated for production use.** Its fatal flaw: if a stream in the chain errors, the other streams are **not automatically destroyed**, leaving open file descriptors, sockets, and memory leaks.

```js
'use strict';

import { createReadStream, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';

// AVOID: pipe() does not propagate errors or clean up
function compressWithPipe(inputPath, outputPath) {
  const source      = createReadStream(inputPath);
  const gzip        = createGzip();
  const destination = createWriteStream(outputPath);

  source.pipe(gzip).pipe(destination);
  // If source errors: gzip and destination remain open!
}

// PREFER: pipeline() — automatic error propagation and cleanup
async function compressWithPipeline(inputPath, outputPath) {
  const source      = createReadStream(inputPath);
  const gzip        = createGzip();
  const destination = createWriteStream(outputPath);

  await pipeline(source, gzip, destination);
  // If any stream errors: ALL streams are destroyed automatically
  console.log('Compression complete');
}
```

**Key differences:**

| Aspect | `pipe()` | `pipeline()` |
|--------|----------|--------------|
| Error propagation | Manual — you must attach `'error'` to every stream | Automatic |
| Cleanup on error | No — streams remain open | Yes — all streams destroyed |
| Callback/Promise | Returns destination stream | Returns a Promise (or takes callback) |
| Node.js version | Since v0.9.4 | Promise form since v15; callback since v10 |

For the callback form (useful inside non-async contexts):

```js
'use strict';

import { pipeline } from 'node:stream';
import { createReadStream, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';

pipeline(
  createReadStream('/data/huge.log'),
  createGzip(),
  createWriteStream('/data/huge.log.gz'),
  (error) => {
    if (error) {
      console.error('Pipeline failed:', error);
      return;
    }
    console.log('Pipeline succeeded');
  },
);
```

### 1.6 Async Iteration over Streams

Node.js 12+ makes every `Readable` an async iterable. This is the cleanest way to consume a stream when you need to process chunks sequentially without callbacks.

```js
'use strict';

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

// Line-by-line processing of a large file using async iteration
async function processLineByLine(filePath) {
  const fileStream = createReadStream(filePath);
  const lineReader = createInterface({
    input:     fileStream,
    crlfDelay: Infinity,
  });

  let lineCount = 0;
  for await (const line of lineReader) {
    lineCount++;
    // Process line here — await is fully supported inside the loop
    await processLine(line);
  }

  console.log(`Processed ${lineCount} lines`);
}

async function processLine(line) {
  // Simulated async work
  if (line.startsWith('#'))
    return;
  // ... do something
}
```

**Important**: When using `for await...of` you must handle errors with `try/catch`. The stream's `'error'` event is surfaced as a thrown exception:

```js
'use strict';

import { createReadStream } from 'node:fs';

async function safeRead(filePath) {
  const stream = createReadStream(filePath);

  try {
    for await (const chunk of stream) {
      console.log(`Chunk size: ${chunk.length}`);
    }
  } catch (error) {
    console.error('Stream error:', error);
    stream.destroy(); // Ensure cleanup if not already destroyed
  }
}
```

---

## 2. Large File Streaming Patterns

### 2.1 Reading Files from Disk

`fs.createReadStream` is the primary tool. Key options:

| Option | Default | Purpose |
|--------|---------|---------|
| `highWaterMark` | 64 KB | Internal buffer size per read chunk |
| `start` | 0 | Byte offset to start reading |
| `end` | file size | Byte offset to stop reading (inclusive) |
| `encoding` | `null` (Buffer) | Set to `'utf8'` for text files |
| `flags` | `'r'` | File open flags |
| `fd` | none | Use an already-opened file descriptor |

```js
'use strict';

import { createReadStream } from 'node:fs';

// Stream entire file with a larger buffer (good for network I/O)
const fullStream = createReadStream('/data/large.bin', {
  highWaterMark: 256 * 1024, // 256 KB chunks
});

// Stream a specific byte range (for range requests, resume, etc.)
const rangeStream = createReadStream('/data/large.bin', {
  start:         1_000_000, // byte 1,000,000
  end:           1_999_999, // byte 1,999,999 (inclusive — reads 1 MB)
  highWaterMark: 64 * 1024,
});

// Text file line-by-line (encoding set on readline, not stream)
const textStream = createReadStream('/data/large.csv', {
  highWaterMark: 128 * 1024,
  // Do NOT set encoding here if piping through a Transform
  // that expects Buffers (e.g., zlib)
});
```

**Memory cost**: At any moment, Node.js holds at most `highWaterMark` bytes per stream in the internal buffer. For a pipeline of N streams, peak memory is roughly `N * highWaterMark` plus whatever your transforms accumulate.

### 2.2 Streaming HTTP Responses (Sending)

When sending a large file over HTTP, pipe the file stream directly into the response — never buffer the entire file first.

```js
'use strict';

import { createServer }    from 'node:http';
import { createReadStream } from 'node:fs';
import { stat }            from 'node:fs/promises';
import { pipeline }        from 'node:stream/promises';

const server = createServer(async (request, response) => {
  if (request.url !== '/download')
    return response.writeHead(404).end('Not found');

  const filePath = '/data/large-export.csv';

  try {
    const fileStats = await stat(filePath);

    response.writeHead(200, {
      'Content-Type':   'text/csv',
      'Content-Length': fileStats.size,
      'Content-Disposition': 'attachment; filename="export.csv"',
    });

    await pipeline(createReadStream(filePath), response);
  } catch (error) {
    if (!response.headersSent)
      response.writeHead(500).end('Internal error');
    console.error('Download error:', error);
  }
});

server.listen(3000, () => console.log('Listening on :3000'));
```

**Do not call `response.end()` after `pipeline()`** — `pipeline()` automatically calls `.end()` on the destination when the source is exhausted.

### 2.3 Streaming HTTP Responses (Receiving)

When fetching large remote files, use the response body as a stream rather than awaiting the fully-buffered body.

```js
'use strict';

import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';

// Using native fetch (Node 18+) — body is a Web ReadableStream
async function downloadFileWithFetch(url, destinationPath) {
  const response = await fetch(url);

  if (!response.ok)
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);

  const { Readable } = await import('node:stream');

  // Convert Web ReadableStream → Node.js Readable
  const nodeReadable = Readable.fromWeb(response.body);
  const fileWriter   = createWriteStream(destinationPath);

  await pipeline(nodeReadable, fileWriter);
  console.log(`Downloaded to ${destinationPath}`);
}

// Using node:http/https directly for full control
import { get } from 'node:https';
import { createWriteStream } from 'node:fs';

function downloadWithHttps(url, destinationPath) {
  return new Promise((resolve, reject) => {
    const fileWriter = createWriteStream(destinationPath);

    get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume(); // drain to free socket
        fileWriter.destroy();
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      pipeline(response, fileWriter)
        .then(resolve)
        .catch(reject);
    }).on('error', reject);
  });
}
```

### 2.4 Chunked Transfer Encoding

Node.js HTTP server applies `Transfer-Encoding: chunked` automatically whenever you write to a response **without** setting `Content-Length`. This is ideal for dynamically generated content where the total size is unknown upfront.

```js
'use strict';

import { createServer } from 'node:http';

const server = createServer((request, response) => {
  if (request.url !== '/stream')
    return response.writeHead(404).end();

  // No Content-Length → Node automatically uses chunked encoding
  response.writeHead(200, { 'Content-Type': 'application/json' });

  // Stream a large JSON array incrementally
  response.write('[\n');

  let index    = 0;
  const total  = 10_000;
  const ticker = setInterval(() => {
    const record = JSON.stringify({ index, timestamp: Date.now() });
    const isLast = index === total - 1;

    response.write(record + (isLast ? '\n' : ',\n'));
    index++;

    if (isLast) {
      clearInterval(ticker);
      response.write(']');
      response.end();
    }
  }, 0);

  request.on('close', () => clearInterval(ticker)); // Client disconnected
});

server.listen(3000);
```

**Note**: If you set `Content-Length`, Node switches to identity transfer encoding and will error if you send more bytes than declared.

### 2.5 HTTP Range Requests for Partial File Delivery

Range requests (RFC 7233) allow clients to request specific byte ranges. This enables:
- Video/audio seeking without full download
- Resumable downloads
- Parallel multi-part downloads

```js
'use strict';

import { createServer }    from 'node:http';
import { createReadStream } from 'node:fs';
import { stat }            from 'node:fs/promises';
import { pipeline }        from 'node:stream/promises';

const FILE_PATH = '/data/video.mp4';

const server = createServer(async (request, response) => {
  if (request.method !== 'GET') {
    response.writeHead(405).end();
    return;
  }

  let fileStats;
  try {
    fileStats = await stat(FILE_PATH);
  } catch {
    response.writeHead(404).end('Not found');
    return;
  }

  const fileSize   = fileStats.size;
  const rangeHeader = request.headers['range'];

  if (!rangeHeader) {
    // No range requested — stream the full file
    response.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type':   'video/mp4',
      'Accept-Ranges':  'bytes',
    });
    await pipeline(createReadStream(FILE_PATH), response);
    return;
  }

  // Parse "Range: bytes=<start>-<end>"
  const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
  if (!match) {
    response.writeHead(416, { 'Content-Range': `bytes */${fileSize}` }).end();
    return;
  }

  const startByte = match[1] ? parseInt(match[1], 10) : 0;
  const endByte   = match[2] ? parseInt(match[2], 10) : fileSize - 1;

  if (startByte >= fileSize || endByte >= fileSize || startByte > endByte) {
    response.writeHead(416, { 'Content-Range': `bytes */${fileSize}` }).end();
    return;
  }

  const chunkSize = endByte - startByte + 1;

  response.writeHead(206, {
    'Content-Range':  `bytes ${startByte}-${endByte}/${fileSize}`,
    'Accept-Ranges':  'bytes',
    'Content-Length': chunkSize,
    'Content-Type':   'video/mp4',
  });

  const rangeStream = createReadStream(FILE_PATH, {
    start: startByte,
    end:   endByte,
  });

  try {
    await pipeline(rangeStream, response);
  } catch (error) {
    // Client likely disconnected mid-stream — not an error worth logging
    if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE')
      console.error('Range stream error:', error);
  }
});

server.listen(3000);
```

### 2.6 Streaming Multipart Uploads

Never buffer an entire multipart upload to memory. Use `busboy` (maintained by Fastify team) to process upload streams field-by-field.

```js
'use strict';

import { createServer } from 'node:http';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import Busboy from 'busboy';

const server = createServer((request, response) => {
  if (request.method !== 'POST' || request.url !== '/upload') {
    response.writeHead(405).end();
    return;
  }

  const busboy = Busboy({
    headers: request.headers,
    limits: {
      fileSize: 5 * 1024 * 1024 * 1024, // 5 GB max
      files:    10,
    },
  });

  const uploadPromises = [];

  busboy.on('file', (fieldName, fileStream, fileInfo) => {
    const { filename, mimeType } = fileInfo;
    console.log(`Receiving file: ${filename} (${mimeType})`);

    const destinationPath = `/uploads/${Date.now()}-${filename}`;
    const writer          = createWriteStream(destinationPath);

    // pipeline() handles backpressure and cleanup
    const uploadPromise = pipeline(fileStream, writer)
      .then(() => ({ fieldName, filename, destinationPath }))
      .catch((error) => {
        console.error(`Upload failed for ${filename}:`, error);
        writer.destroy();
        throw error;
      });

    uploadPromises.push(uploadPromise);
  });

  busboy.on('field', (fieldName, value) => {
    console.log(`Field: ${fieldName} = ${value}`);
  });

  busboy.on('finish', async () => {
    try {
      const results = await Promise.all(uploadPromises);
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ uploaded: results }));
    } catch (error) {
      response.writeHead(500).end('Upload failed');
    }
  });

  busboy.on('error', (error) => {
    console.error('Busboy error:', error);
    response.writeHead(400).end('Bad request');
  });

  // Pipe request body through busboy
  request.pipe(busboy);
});

server.listen(3000);
```

**For streaming directly to S3** (skipping disk entirely), see section 3.1 which combines busboy with `@aws-sdk/lib-storage`.

### 2.7 Transform Streams for On-the-Fly Processing

`Transform` is the primary tool for modifying data mid-pipeline. Key points:
- Always call `callback()` — it signals readiness for the next chunk
- Call `this.push(null)` in `_flush()` only if you need to emit nothing at the end (it's optional — `_flush`'s `callback` ending the stream is sufficient)
- Use `allowHalfOpen: false` on the underlying socket if applicable

```js
'use strict';

import { Transform } from 'node:stream';

// Line counter transform — passes through all data, counts lines
class LineCountTransform extends Transform {
  constructor(options) {
    super(options);
    this.lineCount = 0;
  }

  _transform(chunk, encoding, callback) {
    const text = chunk.toString();
    for (const char of text) {
      if (char === '\n')
        this.lineCount++;
    }
    this.push(chunk); // pass through unchanged
    callback();
  }

  _flush(callback) {
    // Emit final stats as a trailing log line
    console.log(`Total lines: ${this.lineCount}`);
    callback();
  }
}

// Usage
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const lineCounter = new LineCountTransform();
await pipeline(
  createReadStream('/data/large.log'),
  lineCounter,
  createWriteStream('/data/large.log.copy'),
);
console.log(`Counted ${lineCounter.lineCount} lines`);
```

---

## 3. Specific Use Cases

### 3.1 Streaming Large Files to/from S3 (AWS SDK v3)

#### Download from S3

The `GetObjectCommand` response's `Body` is a `SdkStreamMixin`-wrapped `Readable`. Pipe it directly.

```js
'use strict';

import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

const s3Client = new S3Client({ region: 'us-east-1' });

async function downloadFromS3(bucket, key, destinationPath) {
  const command  = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await s3Client.send(command);

  // response.Body is a Node.js Readable stream
  const fileWriter = createWriteStream(destinationPath);

  await pipeline(response.Body, fileWriter);
  console.log(`Downloaded s3://${bucket}/${key} → ${destinationPath}`);
}

// Stream S3 object directly to an HTTP response (no disk at all)
async function streamS3ToResponse(bucket, key, httpResponse) {
  const command  = new GetObjectCommand({ Bucket: bucket, Key: key });
  const response = await s3Client.send(command);

  httpResponse.writeHead(200, {
    'Content-Type':   response.ContentType ?? 'application/octet-stream',
    'Content-Length': response.ContentLength,
  });

  await pipeline(response.Body, httpResponse);
}
```

#### Upload to S3 (multipart, streaming)

For files > 5 MB, use `@aws-sdk/lib-storage` which handles multipart splitting automatically.

```js
'use strict';

import { S3Client } from '@aws-sdk/client-s3';
import { Upload }   from '@aws-sdk/lib-storage';
import { createReadStream } from 'node:fs';

const s3Client = new S3Client({ region: 'us-east-1' });

async function uploadToS3(bucket, key, filePath) {
  const fileStream = createReadStream(filePath, {
    highWaterMark: 10 * 1024 * 1024, // 10 MB read buffer matches part size
  });

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: bucket,
      Key:    key,
      Body:   fileStream,
    },
    queueSize:   4,            // concurrent part uploads
    partSize:    10 * 1024 * 1024, // 10 MB per part (min 5 MB)
    leavePartsOnError: false,  // clean up on failure
  });

  upload.on('httpUploadProgress', (progress) => {
    console.log(`Uploaded ${progress.loaded} / ${progress.total ?? '?'} bytes`);
  });

  const result = await upload.done();
  console.log('Uploaded to:', result.Location);
  return result;
}

// Stream directly from an HTTP request body to S3 (no disk)
async function streamUploadRequestToS3(bucket, key, requestBody) {
  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: bucket,
      Key:    key,
      Body:   requestBody, // IncomingMessage is a Readable
    },
    partSize: 5 * 1024 * 1024,
  });

  return upload.done();
}
```

**S3 streaming gotchas:**
- S3 requires each part (except the last) to be at least 5 MB.
- The `Upload` class from `@aws-sdk/lib-storage` handles this transparently.
- Avoid setting `Content-Length` on the upload stream if you don't know the total size — `@aws-sdk/lib-storage` uses multipart which does not require it.

### 3.2 Streaming Large JSON

#### Problem: `JSON.parse()` is all-or-nothing

`JSON.parse(fs.readFileSync('huge.json'))` loads the entire file and the parsed object into memory simultaneously — easily 3–5x the file size. For files > ~100 MB this is impractical.

#### Option 1: `stream-json` (recommended for complex JSON)

`stream-json` is a SAX-style streaming JSON parser. It emits events for each token and includes high-level helpers like `StreamArray` and `StreamObject` that reassemble top-level items.

```js
'use strict';

import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { parser }      from 'stream-json';
import { streamArray } from 'stream-json/streamers/StreamArray.js';

// Stream a JSON file that is a top-level array: [{...}, {...}, ...]
async function processLargeJsonArray(filePath, processRecord) {
  const fileStream   = createReadStream(filePath);
  const jsonParser   = parser();
  const arrayStreamer = streamArray();

  arrayStreamer.on('data', ({ key, value }) => {
    processRecord(value, key);
  });

  await pipeline(fileStream, jsonParser, arrayStreamer);
  console.log('Done processing JSON array');
}

// Usage
await processLargeJsonArray('/data/records.json', (record, index) => {
  console.log(`Record ${index}:`, record.id);
});
```

#### Option 2: NDJSON (Newline-Delimited JSON — preferred for pipelines)

NDJSON stores one JSON object per line. This is far easier to stream than nested JSON and is the format used by Elasticsearch bulk APIs, Solr export, many log systems, etc.

```js
'use strict';

import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

async function streamNdjson(filePath, processRecord) {
  const fileStream = createReadStream(filePath, { encoding: 'utf8' });
  const lineReader = createInterface({ input: fileStream, crlfDelay: Infinity });

  let lineNumber = 0;
  for await (const line of lineReader) {
    lineNumber++;
    if (!line.trim())
      continue;

    let record;
    try {
      record = JSON.parse(line);
    } catch (error) {
      console.warn(`Invalid JSON on line ${lineNumber}:`, error.message);
      continue;
    }

    await processRecord(record, lineNumber);
  }
}
```

#### Option 3: `json-stream-stringify` for writing large JSON

When *emitting* a large JSON array from a stream, use `json-stream-stringify` to serialize objects one at a time without materializing the whole structure.

```js
'use strict';

import { createServer } from 'node:http';
import { Readable }     from 'node:stream';
import JsonStreamStringify from 'json-stream-stringify';

// Async generator that yields records lazily from DB
async function* fetchRecordsFromDatabase() {
  let offset = 0;
  const pageSize = 500;

  while (true) {
    const page = await db.query('SELECT * FROM records LIMIT ? OFFSET ?', [pageSize, offset]);
    if (page.length === 0)
      break;
    for (const record of page)
      yield record;
    offset += pageSize;
  }
}

const server = createServer(async (request, response) => {
  response.writeHead(200, { 'Content-Type': 'application/json' });

  const recordStream = Readable.from(fetchRecordsFromDatabase());
  const jsonStream   = new JsonStreamStringify(recordStream);

  jsonStream.pipe(response);
});
```

### 3.3 Streaming CSV and NDJSON Processing

#### CSV with `csv-parse` in streaming mode

```js
'use strict';

import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { parse }    from 'csv-parse';
import { stringify } from 'csv-stringify';
import { Transform } from 'node:stream';

// Transform: filter records where age > 30
class AgeFilter extends Transform {
  constructor() {
    super({ objectMode: true });
  }

  _transform(record, encoding, callback) {
    if (parseInt(record.age, 10) > 30)
      this.push(record);
    callback();
  }
}

async function filterCsv(inputPath, outputPath) {
  await pipeline(
    createReadStream(inputPath),
    parse({ columns: true, trim: true }),  // parse → object mode
    new AgeFilter(),                        // filter records
    stringify({ header: true }),            // object mode → CSV text
    createWriteStream(outputPath),
  );
  console.log('CSV filter complete');
}
```

#### NDJSON → Transform → NDJSON pipeline

```js
'use strict';

import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';

class NdjsonParser extends Transform {
  constructor() {
    super({ readableObjectMode: true });
    this._buffer = '';
  }

  _transform(chunk, encoding, callback) {
    const lines = (this._buffer + chunk.toString()).split('\n');
    this._buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim())
        continue;
      try {
        this.push(JSON.parse(line));
      } catch {
        // skip malformed lines
      }
    }
    callback();
  }

  _flush(callback) {
    if (this._buffer.trim()) {
      try {
        this.push(JSON.parse(this._buffer));
      } catch {
        // ignore
      }
    }
    callback();
  }
}

class NdjsonStringifier extends Transform {
  constructor() {
    super({ writableObjectMode: true });
  }

  _transform(record, encoding, callback) {
    this.push(JSON.stringify(record) + '\n');
    callback();
  }
}

class RecordTransformer extends Transform {
  constructor() {
    super({ objectMode: true });
  }

  _transform(record, encoding, callback) {
    // Example: add a computed field
    this.push({ ...record, processedAt: new Date().toISOString() });
    callback();
  }
}

await pipeline(
  createReadStream('/data/input.ndjson'),
  new NdjsonParser(),
  new RecordTransformer(),
  new NdjsonStringifier(),
  createWriteStream('/data/output.ndjson'),
);
```

### 3.4 File → Compress → Encrypt → Upload Pipeline

The ideal streaming pipeline: no intermediate files, bounded memory, full error propagation.

```js
'use strict';

import { createReadStream }               from 'node:fs';
import { createGzip }                     from 'node:zlib';
import { createCipheriv, randomBytes }    from 'node:crypto';
import { pipeline }                       from 'node:stream/promises';
import { S3Client }                       from '@aws-sdk/client-s3';
import { Upload }                         from '@aws-sdk/lib-storage';
import { PassThrough }                    from 'node:stream';

const s3Client = new S3Client({ region: 'us-east-1' });

async function compressEncryptUpload(inputPath, bucket, key, encryptionKey) {
  const iv = randomBytes(16); // fresh IV per upload

  const fileStream  = createReadStream(inputPath, { highWaterMark: 64 * 1024 });
  const gzip        = createGzip({ level: 6 }); // balance speed vs. compression
  const cipher      = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const passThrough = new PassThrough(); // gives Upload a plain stream

  // pipeline() connects all the transforms with proper error propagation
  // We need to keep the end of the chain as a PassThrough so Upload can read it
  const pipelinePromise = pipeline(fileStream, gzip, cipher, passThrough);

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket:   bucket,
      Key:      key,
      Body:     passThrough,
      Metadata: {
        'encryption-iv': iv.toString('hex'),
        'algorithm':     'aes-256-gcm',
      },
    },
    partSize: 10 * 1024 * 1024,
  });

  // Run both concurrently — pipeline feeds passThrough, Upload drains it
  const [, uploadResult] = await Promise.all([pipelinePromise, upload.done()]);

  // Retrieve and store the GCM auth tag (critical for decryption verification)
  const authTag = cipher.getAuthTag();
  console.log('Auth tag (store this):', authTag.toString('hex'));
  console.log('Uploaded to:', uploadResult.Location);

  return { authTag, iv, location: uploadResult.Location };
}
```

**Memory profile**: At any given moment, only `highWaterMark`-sized chunks flow through each transform. The total memory used is `O(highWaterMark * number_of_transforms)`, not `O(file_size)`.

### 3.5 Serving Video/Audio with Range Support

A production-grade video server needs:
1. `Accept-Ranges: bytes` header on all responses
2. Correct `206 Partial Content` responses with exact byte ranges
3. Proper handling of prefix ranges (`bytes=500-`), suffix ranges (`bytes=-500`), and multi-ranges
4. Graceful handling of client disconnects mid-stream

```js
'use strict';

import { createServer }    from 'node:http';
import { createReadStream } from 'node:fs';
import { stat }            from 'node:fs/promises';
import { pipeline }        from 'node:stream/promises';
import { extname }         from 'node:path';

const MIME_TYPES = {
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.ogg':  'video/ogg',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.flac': 'audio/flac',
};

function parseRangeHeader(rangeHeader, fileSize) {
  if (!rangeHeader?.startsWith('bytes='))
    return null;

  const rangeSpec = rangeHeader.slice(6);
  const parts     = rangeSpec.split('-');

  let startByte = parseInt(parts[0], 10);
  let endByte   = parseInt(parts[1], 10);

  // Suffix range: bytes=-500 means last 500 bytes
  if (parts[0] === '') {
    startByte = fileSize - parseInt(parts[1], 10);
    endByte   = fileSize - 1;
  }

  // Prefix range: bytes=500- means from 500 to end
  if (isNaN(endByte))
    endByte = fileSize - 1;

  if (isNaN(startByte))
    startByte = 0;

  return { startByte, endByte };
}

const server = createServer(async (request, response) => {
  const filePath = `/media${request.url}`;
  const extension = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[extension];

  if (!contentType) {
    response.writeHead(415).end('Unsupported media type');
    return;
  }

  let fileStats;
  try {
    fileStats = await stat(filePath);
  } catch {
    response.writeHead(404).end('Not found');
    return;
  }

  const fileSize   = fileStats.size;
  const rangeHeader = request.headers['range'];
  const range       = parseRangeHeader(rangeHeader, fileSize);

  if (!range) {
    // Full content
    response.writeHead(200, {
      'Content-Type':   contentType,
      'Content-Length': fileSize,
      'Accept-Ranges':  'bytes',
    });

    if (request.method === 'HEAD') {
      response.end();
      return;
    }

    await pipeline(createReadStream(filePath), response).catch((error) => {
      if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE')
        console.error('Stream error:', error);
    });
    return;
  }

  const { startByte, endByte } = range;

  if (startByte >= fileSize || endByte >= fileSize || startByte > endByte) {
    response.writeHead(416, { 'Content-Range': `bytes */${fileSize}` }).end();
    return;
  }

  const chunkSize = endByte - startByte + 1;

  response.writeHead(206, {
    'Content-Range':  `bytes ${startByte}-${endByte}/${fileSize}`,
    'Accept-Ranges':  'bytes',
    'Content-Length': chunkSize,
    'Content-Type':   contentType,
  });

  if (request.method === 'HEAD') {
    response.end();
    return;
  }

  const mediaStream = createReadStream(filePath, {
    start:         startByte,
    end:           endByte,
    highWaterMark: 256 * 1024, // 256 KB for smooth video delivery
  });

  await pipeline(mediaStream, response).catch((error) => {
    if (error.code !== 'ERR_STREAM_PREMATURE_CLOSE')
      console.error('Range stream error:', error);
  });
});

server.listen(3000, () => console.log('Media server on :3000'));
```

### 3.6 Streaming Solr Responses

Solr provides two approaches for exporting large result sets: cursor-based pagination and the `/export` handler (streaming).

#### Approach 1: Cursor-Based Pagination

Best for arbitrary queries where you need standard search features (facets, complex scoring). Solr maintains a cursor position server-side.

```js
'use strict';

import { Readable } from 'node:stream';

async function* solrCursorStream(solrBaseUrl, collection, query, options = {}) {
  const {
    sortField    = 'id',
    pageSize     = 1000,
    filterQuery  = null,
    fieldList    = '*',
  } = options;

  let cursor = '*'; // initial cursor
  let totalFetched = 0;
  let totalFound;

  do {
    const params = new URLSearchParams({
      q:           query,
      sort:        `${sortField} asc`,
      rows:        pageSize,
      cursorMark:  cursor,
      wt:          'json',
      fl:          fieldList,
    });

    if (filterQuery)
      params.set('fq', filterQuery);

    const url      = `${solrBaseUrl}/${collection}/select?${params}`;
    const response = await fetch(url);

    if (!response.ok)
      throw new Error(`Solr error: ${response.status} ${await response.text()}`);

    const body = await response.json();

    if (totalFound === undefined)
      totalFound = body.response.numFound;

    const documents  = body.response.docs;
    const nextCursor = body.nextCursorMark;

    for (const document of documents)
      yield document;

    totalFetched += documents.length;
    console.log(`Fetched ${totalFetched} / ${totalFound}`);

    // Stop when cursor hasn't advanced (no more results)
    if (nextCursor === cursor || documents.length === 0)
      break;

    cursor = nextCursor;
  } while (true);
}

// Convert the async generator to a Node.js Readable and pipe it
async function exportSolrToNdjson(solrUrl, collection, outputPath) {
  const { createWriteStream } = await import('node:fs');
  const { pipeline }          = await import('node:stream/promises');
  const { Transform }         = await import('node:stream');

  class NdjsonStringifier extends Transform {
    constructor() { super({ objectMode: true }); }
    _transform(record, enc, cb) { this.push(JSON.stringify(record) + '\n'); cb(); }
  }

  const solrStream = Readable.from(solrCursorStream(solrUrl, collection, '*:*'));

  await pipeline(
    solrStream,
    new NdjsonStringifier(),
    createWriteStream(outputPath),
  );
}
```

#### Approach 2: Solr `/export` Handler (True Streaming)

The `/export` handler streams results in JSON format over a single HTTP connection. It requires a `DocValues` field for sorting and cannot support all query features.

```js
'use strict';

import { Readable }          from 'node:stream';
import { pipeline }          from 'node:stream/promises';
import { Transform }         from 'node:stream';
import { createWriteStream } from 'node:fs';
import { parser }            from 'stream-json';
import { streamArray }       from 'stream-json/streamers/StreamArray.js';

async function streamSolrExport(solrBaseUrl, collection, query, outputPath) {
  const params = new URLSearchParams({
    q:    query,
    sort: 'id asc',
    fl:   'id,title,timestamp',
    wt:   'json',
  });

  const url      = `${solrBaseUrl}/${collection}/export?${params}`;
  const response = await fetch(url);

  if (!response.ok)
    throw new Error(`Solr export error: ${response.status}`);

  // Solr export returns {"responseHeader":{...},"response":{"numFound":N,"docs":[...]}}
  // We want to stream the docs array without loading all docs into memory.
  const nodeReadable = Readable.fromWeb(response.body);

  // Use stream-json to extract the docs array incrementally
  const jsonParser    = parser();
  const docsStreamer  = streamArray();

  // stream-json path filter to only emit items from response.docs
  // (in practice, Solr export JSON is flat — the array is at response.docs)
  class NdjsonOut extends Transform {
    constructor() { super({ objectMode: true }); }
    _transform({ value }, enc, cb) { this.push(JSON.stringify(value) + '\n'); cb(); }
  }

  await pipeline(
    nodeReadable,
    jsonParser,
    docsStreamer,
    new NdjsonOut(),
    createWriteStream(outputPath),
  );
}
```

**Choosing between cursor and export:**

| Feature | Cursor Pagination | `/export` Handler |
|---------|------------------|-------------------|
| Memory | Low (page at a time) | Very low (true streaming) |
| Throughput | Moderate | High |
| Arbitrary scoring | Yes | No (sort must be DocValues) |
| Facets | Yes | No |
| Max docs | Unlimited | Unlimited |
| Requires DocValues | No | Yes (sort field) |

For bulk export (ETL, backup), prefer `/export`. For search-with-pagination, use cursor.

---

## 4. Performance and Pitfalls

### 4.1 Choosing the Right highWaterMark

`highWaterMark` is a *threshold*, not a hard limit. When the internal buffer exceeds this value, backpressure kicks in and the upstream pauses.

**Guidelines:**

| Scenario | Recommended `highWaterMark` |
|----------|-----------------------------|
| Local disk copy | 64 KB – 1 MB (match OS page cache) |
| Network upload (LAN) | 256 KB – 4 MB |
| Network upload (WAN, high latency) | 1 MB – 16 MB (amortize RTT) |
| Video streaming to browser | 256 KB (keep response latency low) |
| Object mode (records) | 16 – 512 objects |
| Compression (zlib output) | 64 KB – 256 KB (zlib works in chunks) |

```js
'use strict';

import { createReadStream, createWriteStream } from 'node:fs';
import { createGzip }                          from 'node:zlib';
import { pipeline }                            from 'node:stream/promises';

// For network upload: larger read buffer amortizes I/O syscalls
const readStream = createReadStream('/data/large.bin', {
  highWaterMark: 1 * 1024 * 1024, // 1 MB read chunks
});

// Gzip has its own internal buffer; don't set highWaterMark on it
// unless you're running memory-constrained (e.g., embedded)
const gzip = createGzip({
  level:         6,        // balance: 1=fastest, 9=best compression
  chunkSize:     64 * 1024, // output chunk size
  highWaterMark: 256 * 1024,
});

const writeStream = createWriteStream('/data/large.bin.gz');

await pipeline(readStream, gzip, writeStream);
```

**Benchmarking tip**: Profile with `process.memoryUsage().heapUsed` at intervals during streaming. If RSS grows unboundedly, you have a backpressure or leak issue.

### 4.2 Memory Leak Patterns

These are the most common stream-related memory leaks in production:

#### Pattern 1: Attaching event listeners in a loop

```js
'use strict';

// WRONG: creates a new listener on every request — listeners accumulate
function handleRequest(request, response) {
  const database = getDatabaseConnection();

  database.on('data', (row) => response.write(JSON.stringify(row))); // LEAK
  database.on('end', ()  => response.end());
}

// CORRECT: use pipeline which handles teardown
async function handleRequestCorrect(request, response) {
  const database = getDatabaseConnection();

  response.writeHead(200, { 'Content-Type': 'application/x-ndjson' });

  const { Transform } = await import('node:stream');
  const serializer    = new Transform({
    objectMode: true,
    transform(row, enc, callback) {
      this.push(JSON.stringify(row) + '\n');
      callback();
    },
  });

  await pipeline(database, serializer, response);
}
```

#### Pattern 2: Not destroying streams on error

```js
'use strict';

import { createReadStream, createWriteStream } from 'node:fs';

// WRONG: if writeStream errors, readStream stays open (file descriptor leak)
const readStream  = createReadStream('/huge/file');
const writeStream = createWriteStream('/output/file');
readStream.pipe(writeStream);
// No error handler on writeStream!

// CORRECT: pipeline destroys all streams on any error
import { pipeline } from 'node:stream/promises';

try {
  await pipeline(
    createReadStream('/huge/file'),
    createWriteStream('/output/file'),
  );
} catch (error) {
  console.error('Pipeline failed, all streams already destroyed:', error);
}
```

#### Pattern 3: Not consuming a Readable

If you create a `Readable` but never consume it (no `pipe`, no `for await`, no `'data'` listener), the stream accumulates data in its internal buffer indefinitely.

```js
'use strict';

import { createReadStream } from 'node:fs';

// WRONG: creates stream but never reads it — memory grows
function badCode(filePath) {
  const stream = createReadStream(filePath);
  // stream.on('data', ...) — forgot this!
  // stream just sits there, buffering data
}

// CORRECT: always consume or destroy
function correctCode(filePath) {
  const stream = createReadStream(filePath);

  if (!needsStream) {
    stream.destroy(); // explicit cleanup
    return;
  }

  return stream; // caller must consume
}
```

#### Pattern 4: Accumulating chunks in a Transform

```js
'use strict';

import { Transform } from 'node:stream';

// WRONG: buffers ALL input before emitting — O(file_size) memory
class BadBatchTransform extends Transform {
  constructor() {
    super({ objectMode: true });
    this._records = [];
  }

  _transform(record, enc, callback) {
    this._records.push(record); // accumulates everything!
    callback();
  }

  _flush(callback) {
    // Only emits at the very end
    this.push(this._records);
    callback();
  }
}

// CORRECT: emit fixed-size batches to maintain bounded memory
class GoodBatchTransform extends Transform {
  constructor(batchSize = 100) {
    super({ objectMode: true });
    this._batchSize = batchSize;
    this._batch     = [];
  }

  _transform(record, enc, callback) {
    this._batch.push(record);
    if (this._batch.length >= this._batchSize) {
      this.push(this._batch);
      this._batch = [];
    }
    callback();
  }

  _flush(callback) {
    if (this._batch.length > 0)
      this.push(this._batch);
    callback();
  }
}
```

### 4.3 Error Handling and Cleanup

#### `stream.finished()` for cleanup after pipe()

If you must use `.pipe()` (e.g., in third-party code), use `stream.finished()` to know when all streams have completed or errored.

```js
'use strict';

import { finished } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';

async function compressWithCleanup(inputPath, outputPath) {
  const source      = createReadStream(inputPath);
  const gzip        = createGzip();
  const destination = createWriteStream(outputPath);

  source.pipe(gzip).pipe(destination);

  try {
    await finished(destination);
    console.log('Compression complete');
  } catch (error) {
    // Manually clean up since pipe() doesn't do it
    source.destroy();
    gzip.destroy();
    destination.destroy();
    throw error;
  }
}
```

**Better alternative**: just use `pipeline()`. The only reason to combine `.pipe()` + `finished()` is when working with code that already uses `.pipe()` internally (e.g., some third-party modules).

#### Handling client disconnect mid-stream

When a client disconnects mid-download, `pipeline()` will throw `ERR_STREAM_PREMATURE_CLOSE`. Always filter this:

```js
'use strict';

import { pipeline } from 'node:stream/promises';
import { createReadStream } from 'node:fs';

async function serveFile(request, response, filePath) {
  try {
    await pipeline(createReadStream(filePath), response);
  } catch (error) {
    // ERR_STREAM_PREMATURE_CLOSE = client disconnected — normal, not an error
    if (error.code === 'ERR_STREAM_PREMATURE_CLOSE')
      return;

    console.error('Unexpected stream error:', error);

    if (!response.headersSent)
      response.writeHead(500).end('Internal error');
  }
}
```

#### `AbortController` for cancellable pipelines

Node 18+ `pipeline()` accepts an `AbortSignal` to cancel a pipeline mid-stream:

```js
'use strict';

import { pipeline } from 'node:stream/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';

async function cancellableCompress(inputPath, outputPath, timeoutMs = 30_000) {
  const controller = new AbortController();
  const { signal } = controller;

  // Auto-cancel after timeout
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    await pipeline(
      createReadStream(inputPath),
      createGzip(),
      createWriteStream(outputPath),
      { signal },
    );
    console.log('Done');
  } catch (error) {
    if (error.name === 'AbortError') {
      console.log('Compression cancelled after timeout');
      return;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
```

### 4.4 Workers and Streams for CPU-Bound Transform Operations

Node.js is single-threaded. CPU-intensive transforms (e.g., encryption, custom compression, image resizing) block the event loop and stall all concurrent streams.

**Solution**: Offload CPU work to `Worker` threads. Pipe data in/out via `MessageChannel` with `transferList` (zero-copy transfer).

```js
'use strict';

// worker.mjs — runs in a Worker thread
import { parentPort } from 'node:worker_threads';
import { Transform }  from 'node:stream';
import { createHash } from 'node:crypto';

// Receive chunks from main thread, hash them, send result back
parentPort.on('message', ({ type, chunk, done }) => {
  if (type === 'chunk') {
    // Simulate CPU-intensive work: compute SHA-256 of each chunk
    const hash = createHash('sha256').update(chunk).digest('hex');
    parentPort.postMessage({ type: 'result', hash, length: chunk.length });
    return;
  }

  if (done)
    parentPort.postMessage({ type: 'done' });
});
```

```js
'use strict';

// main.mjs — streams through a worker
import { createReadStream } from 'node:fs';
import { Worker }           from 'node:worker_threads';
import { Transform, pipeline } from 'node:stream';
import { pipeline as pipelinePromise } from 'node:stream/promises';

class WorkerTransform extends Transform {
  constructor(workerPath) {
    super();
    this._worker    = new Worker(workerPath);
    this._pending   = 0;
    this._ended     = false;
    this._flushCb   = null;

    this._worker.on('message', ({ type, hash, length }) => {
      if (type === 'result') {
        this.push(`${hash} (${length} bytes)\n`);
        this._pending--;

        if (this._ended && this._pending === 0 && this._flushCb) {
          this._flushCb();
          this._worker.terminate();
        }
      }
    });

    this._worker.on('error', (error) => this.destroy(error));
  }

  _transform(chunk, encoding, callback) {
    this._pending++;
    // Transfer the buffer to the worker (zero-copy)
    this._worker.postMessage({ type: 'chunk', chunk }, [chunk.buffer]);
    callback(); // Don't wait — keep reading (worker processes async)
  }

  _flush(callback) {
    this._ended  = true;
    this._flushCb = callback;

    if (this._pending === 0) {
      callback();
      this._worker.terminate();
    }
  }
}

async function hashFile(inputPath) {
  const workerTransform = new WorkerTransform('./worker.mjs');

  await pipelinePromise(
    createReadStream(inputPath, { highWaterMark: 256 * 1024 }),
    workerTransform,
    process.stdout,
  );
}

hashFile('/data/large.bin').catch(console.error);
```

**When to use workers for streaming:**
- Custom encryption/decryption not covered by `node:crypto` streams
- Image/video frame processing
- Complex serialization (e.g., Protobuf encoding of large objects)
- Any transform where a single chunk takes > ~10 ms of CPU

**When NOT to use workers:**
- Transforms using built-in streams (`zlib.createGzip()`, `crypto.createCipheriv()`) — these are already native C++ and non-blocking
- I/O-bound operations (network, disk) — these never block the event loop
- Simple data reformatting — overhead of thread communication exceeds savings

---

## Summary: Decision Tree

```
Need to process a large file?
│
├─ Reading from disk?
│   └─ Use fs.createReadStream() with appropriate highWaterMark
│
├─ Sending over HTTP?
│   ├─ Known size → set Content-Length, pipe stream to response
│   ├─ Unknown size → omit Content-Length (chunked encoding automatic)
│   └─ Supporting seek/resume → implement Range request handling (206)
│
├─ Receiving via HTTP upload?
│   └─ Use busboy to stream multipart without buffering
│
├─ Transforming in flight?
│   ├─ Compression → zlib.createGzip() / zlib.createBrotliCompress()
│   ├─ Encryption → crypto.createCipheriv()
│   ├─ Parsing → csv-parse / stream-json / readline for line-by-line
│   └─ CPU-heavy custom logic → Worker thread with MessageChannel
│
├─ Storing to S3?
│   ├─ < 5 MB → PutObjectCommand with stream Body
│   └─ >= 5 MB → @aws-sdk/lib-storage Upload (automatic multipart)
│
├─ JSON data?
│   ├─ Output → json-stream-stringify or async generator + chunked response
│   └─ Input → stream-json (complex), readline (NDJSON), or csv-parse
│
└─ Always:
    ├─ Use pipeline() (not pipe()) for error propagation
    ├─ Handle ERR_STREAM_PREMATURE_CLOSE for client disconnects
    └─ Use AbortController for timeout/cancellation
```

---

## References

- [Node.js Backpressuring in Streams](https://nodejs.org/en/learn/modules/backpressuring-in-streams)
- [Node.js Stream API Documentation](https://nodejs.org/api/stream.html)
- [Node.js: How to Use Streams](https://nodejs.org/en/learn/modules/how-to-use-streams)
- [Better Stack: Node.js Streams Comprehensive Guide](https://betterstack.com/community/guides/scaling-nodejs/nodejs-streams/)
- [Platformatic: Reading and Writing Node.js Streams](https://blog.platformatic.dev/a-guide-to-reading-and-writing-nodejs-streams)
- [AWS S3 Streaming with Node.js SDK v3](https://www.codestudy.net/blog/aws-s3-v3-javascript-sdk-stream-file-from-bucket-getobjectcommand/)
- [Streaming Files from AWS S3 with TypeScript](https://dev.to/about14sheep/streaming-data-from-aws-s3-using-nodejs-stream-api-and-typescript-3dj0)
- [How to Stream Large Files from S3 in Node.js](https://oneuptime.com/blog/post/2026-02-12-stream-large-files-s3-nodejs/view)
- [stream-json on npm](https://www.npmjs.com/package/stream-json)
- [stream-json on GitHub](https://github.com/uhop/stream-json)
- [Building a Node.js Video Streaming Server](https://liveapi.com/blog/nodejs-video-streaming-server/)
- [Busboy on GitHub (Fastify fork)](https://github.com/fastify/busboy)
- [Formidable on npm](https://www.npmjs.com/package/formidable)
- [Streaming Large JSON with Low Memory in Node.js](https://lepape.me/how-to-stream-big-json-files-with-low-memory-footprint-in-node-js/)
- [The 7 Node Stream Errors That Skip Cleanup](https://medium.com/@1nick1patel1/the-7-node-stream-errors-that-skip-cleanup-ae22dcf66bfd)
- [Node.js Stream and HighWaterMark](https://dev.to/mrrishimeena/stream-and-highwatermark-nodejs-44kd)
- [All About Uploading Large Data to S3 in Node.js](https://medium.com/@bdleecs95/all-about-uploading-large-amounts-of-data-to-s3-in-node-js-a1b17a98e9f7)
