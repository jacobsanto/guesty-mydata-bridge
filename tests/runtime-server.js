'use strict';

const assert = require('assert');
process.env.NODE_ENV = 'test';
process.env.DB_CLIENT = 'better-sqlite3';
process.env.DB_PATH = '/tmp/bridge-runtime-server.db';
process.env.DATA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');

const { liveHealth, readyHealth, createShutdown } = require('../src/server');

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

(async () => {
  const live = responseRecorder();
  liveHealth({}, live);
  assert.strictEqual(live.statusCode, 200);
  assert.strictEqual(live.body.status, 'ok');

  const ready = responseRecorder();
  await readyHealth({}, ready, { raw: async () => [{ ok: 1 }] });
  assert.strictEqual(ready.statusCode, 200);
  assert.strictEqual(ready.body.status, 'ready');

  const unavailable = responseRecorder();
  await readyHealth({}, unavailable, { raw: async () => { throw new Error('database unavailable'); } });
  assert.strictEqual(unavailable.statusCode, 503);
  assert.strictEqual(unavailable.body.status, 'not_ready');

  let serverClosed = false;
  let databaseClosed = false;
  const scheduler = setInterval(() => {}, 60000);
  const shutdown = createShutdown({
    server: { close(callback) { serverClosed = true; callback(); } },
    scheduler,
    database: { async destroy() { databaseClosed = true; } },
    timeoutMs: 1000,
  });
  await shutdown('TEST');
  assert(serverClosed && databaseClosed);
  console.log('✅ Runtime server health and shutdown tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
