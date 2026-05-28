'use strict';

import { createServer } from './create-server.mjs';

let host = process.env.KIKX_HOST || '127.0.0.1';
let port = Number.parseInt(process.env.KIKX_PORT || '3000', 10);

let server = createServer();

server.listen(port, host, () => {
  console.log(`Kikx listening on http://${host}:${port}`);
});

for (let signal of [ 'SIGINT', 'SIGTERM' ]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}

