#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  makeTelegramPollingBackoff,
  pollingBackoffDelay,
  isTransientTelegramPollingError,
} = require('../telegram/telegram_approval_bot');

function run() {
  const config = {
    telegramBackoffBaseMs: 1000,
    telegramBackoffMaxMs: 8000,
    telegramBackoffJitterMs: 0,
  };
  const backoff = makeTelegramPollingBackoff(config);

  backoff.failures = 1;
  assert.strictEqual(pollingBackoffDelay(backoff), 1000, 'first polling failure should use base backoff');
  backoff.failures = 2;
  assert.strictEqual(pollingBackoffDelay(backoff), 2000, 'second polling failure should double backoff');
  backoff.failures = 5;
  assert.strictEqual(pollingBackoffDelay(backoff), 8000, 'polling backoff should be bounded');

  const badGateway = new Error('getUpdates failed: HTTP 502 {"ok":false}');
  assert.strictEqual(isTransientTelegramPollingError(badGateway), true, 'HTTP 502 getUpdates errors should be transient');

  const fetchFailed = new TypeError('fetch failed');
  assert.strictEqual(isTransientTelegramPollingError(fetchFailed), true, 'network fetch failures should be transient');

  const fatal = new Error('sendMessage failed: HTTP 401 {"ok":false}');
  assert.strictEqual(isTransientTelegramPollingError(fatal), false, 'non-polling auth errors should not be hidden by backoff');

  console.log('telegram approval self-check passed');
}

run();
