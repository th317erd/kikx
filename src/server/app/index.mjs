import { Application } from './application.mjs';

(async function() {
  const app = new Application({ exitOnShutdown: 0 });
  await app.start();
})();
