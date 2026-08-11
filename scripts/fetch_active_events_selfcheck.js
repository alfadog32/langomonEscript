'use strict';

process.env.MM_SKIP_LOCAL_ENV_FILE = 'true';
process.env.SKIP_LOCAL_ENV_FILE = 'true';

const assert = require('assert');
const { PolymarketPublicClient } = require('../moneymaker_v3');

async function main() {
  const eventLimit = 25;
  const eventPages = 3;
  const calls = [];
  const pages = [
    [{ id: 'event-1', title: 'First fixture event' }],
    [{ id: 'event-2', title: 'Second fixture event' }],
    [{ id: 'event-3', title: 'Third fixture event' }],
  ];
  const client = new PolymarketPublicClient({
    gammaBaseUrl: 'https://gamma.example.test',
    eventLimit,
    eventPages,
  });
  client.http = {
    async getJson(url) {
      calls.push(url);
      return pages[calls.length - 1];
    },
  };

  const events = await client.fetchActiveEvents();
  assert.deepStrictEqual(events, pages.flat(), 'Gamma event pages must remain concatenated in order');
  assert.strictEqual(calls.length, eventPages, 'fetchActiveEvents must request every configured page');

  calls.forEach((rawUrl, page) => {
    const url = new URL(rawUrl);
    assert.strictEqual(url.pathname, '/events');
    assert.strictEqual(url.searchParams.get('active'), 'true');
    assert.strictEqual(url.searchParams.get('closed'), 'false');
    assert.strictEqual(url.searchParams.get('order'), 'volume24hr');
    assert.notStrictEqual(url.searchParams.get('order'), 'volume_24hr');
    assert.strictEqual(rawUrl.includes('order=volume_24hr'), false);
    assert.strictEqual(url.searchParams.get('ascending'), 'false');
    assert.strictEqual(url.searchParams.get('limit'), String(eventLimit));
    assert.strictEqual(url.searchParams.get('offset'), String(page * eventLimit));
  });

  const failureCalls = [];
  const failingClient = new PolymarketPublicClient({
    gammaBaseUrl: 'https://gamma.example.test',
    eventLimit,
    eventPages,
  });
  failingClient.http = {
    async getJson(url) {
      failureCalls.push(url);
      throw new Error('HTTP 503 Service Unavailable: fixture Gamma failure');
    },
  };

  await assert.rejects(
    () => failingClient.fetchActiveEvents(),
    /HTTP 503 Service Unavailable: fixture Gamma failure/,
    'Gamma HTTP failures must propagate instead of returning partial or fabricated events'
  );
  assert.strictEqual(failureCalls.length, 1, 'a failed page must stop pagination immediately');

  console.log('fetch active events self-check passed');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
