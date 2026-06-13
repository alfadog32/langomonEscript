#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { BotEngine, CONFIG } = require('../moneymaker_v3');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeBot(overrides = {}) {
  const config = {
    ...CONFIG,
    ...overrides,
    enableWs: false,
    saveState: false,
    nonBlockingResearchRefresh: true,
    researchRefreshTimeoutMs: overrides.researchRefreshTimeoutMs ?? 25,
    researchStuckResetMs: overrides.researchStuckResetMs ?? 25,
  };
  const bot = new BotEngine(config);
  bot.portfolio.loadState = () => {};
  bot.assets = [];
  return bot;
}

function installDiscover(bot, calls) {
  let index = 0;
  bot.research = {
    discoverCandidates() {
      assert(index < calls.length, 'unexpected research refresh call');
      const next = calls[index];
      index += 1;
      return next();
    },
  };
  return () => index;
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}

async function testCompletionClearsInFlight() {
  const bot = makeBot();
  const getCalls = installDiscover(bot, [
    () => Promise.resolve([{ tokenId: 'complete-token' }]),
  ]);

  const first = bot.requestResearchRefresh();
  assert(bot.researchInFlight, 'research refresh starts');
  await first;
  assert.strictEqual(getCalls(), 1, 'one refresh started');
  assert.strictEqual(bot.researchInFlight, null, 'completion clears in-flight flag');
  assert.strictEqual(bot.assets.length, 1, 'completion updates candidates');
}

async function testFailureClearsInFlight() {
  const bot = makeBot();
  installDiscover(bot, [
    () => Promise.reject(new Error('synthetic research failure')),
  ]);

  await bot.requestResearchRefresh();
  assert.strictEqual(bot.researchInFlight, null, 'failure clears in-flight flag');
}

async function testActiveRefreshBlocksSecondRefresh() {
  const bot = makeBot();
  const pending = deferred();
  const getCalls = installDiscover(bot, [
    () => pending.promise,
  ]);

  const first = bot.requestResearchRefresh();
  const second = bot.requestResearchRefresh();
  assert.strictEqual(second, first, 'second refresh returns active in-flight promise');
  assert.strictEqual(getCalls(), 1, 'second refresh is blocked while active');

  pending.resolve([{ tokenId: 'active-token' }]);
  await first;
  assert.strictEqual(bot.researchInFlight, null, 'active refresh clears after completion');
}

async function testTimeoutRecoveryAllowsSecondRefresh() {
  const bot = makeBot({ researchRefreshTimeoutMs: 5, researchStuckResetMs: 5 });
  const stuck = deferred();
  const getCalls = installDiscover(bot, [
    () => stuck.promise,
    () => Promise.resolve([{ tokenId: 'recovered-token' }]),
  ]);

  const first = bot.requestResearchRefresh();
  assert(bot.researchInFlight, 'stuck refresh starts');
  bot.researchInFlightStartedAt = Date.now() - 100;

  const second = bot.requestResearchRefresh();
  assert.notStrictEqual(second, first, 'second refresh is allowed after timeout recovery');
  await second;
  await flush();

  assert.strictEqual(getCalls(), 2, 'timeout recovery starts a new refresh');
  assert.strictEqual(bot.researchInFlight, null, 'timeout recovery clears in-flight flag');
  assert.strictEqual(bot.assets.length, 1, 'candidate evaluation input resumes after recovery');
  assert.strictEqual(bot.assets[0].tokenId, 'recovered-token', 'recovered refresh owns candidate set');

  stuck.resolve([{ tokenId: 'late-stuck-token' }]);
  await first;
  await flush();
  assert.strictEqual(bot.assets[0].tokenId, 'recovered-token', 'late stuck refresh cannot overwrite recovered candidates');
}

async function testBlockingRefreshTimeoutReturnsControl() {
  const bot = makeBot({ nonBlockingResearchRefresh: false, researchRefreshTimeoutMs: 5, researchStuckResetMs: 5 });
  const stuck = deferred();
  installDiscover(bot, [
    () => stuck.promise,
  ]);

  const selected = await bot.refreshResearch();
  assert.strictEqual(selected, null, 'blocking refresh timeout returns control to caller');
  assert.strictEqual(bot.researchInFlight, null, 'blocking timeout clears in-flight flag');
  assert.strictEqual(bot.researchRefreshTimedOut, true, 'blocking timeout records recovery');
}

async function testCandidateEvaluationCanResumeAfterRecovery() {
  const bot = makeBot({ researchRefreshTimeoutMs: 5, researchStuckResetMs: 5 });
  const stuck = deferred();
  installDiscover(bot, [
    () => stuck.promise,
    () => Promise.resolve([{ tokenId: 'candidate-token', market: 'candidate-market' }]),
  ]);

  bot.requestResearchRefresh();
  bot.researchInFlightStartedAt = Date.now() - 100;
  await bot.requestResearchRefresh();

  for (const asset of bot.assets) {
    bot.portfolio.recordExecutionEvent('candidate_evaluation', {
      tokenId: asset.tokenId,
      strategy: 'research_liveness_selfcheck',
    });
  }

  const health = bot.portfolio.executionHealth();
  assert.strictEqual(health.candidateEvaluationsLastHour, 1, 'candidate evaluation can resume after recovery');
}

async function main() {
  await testCompletionClearsInFlight();
  await testFailureClearsInFlight();
  await testActiveRefreshBlocksSecondRefresh();
  await testTimeoutRecoveryAllowsSecondRefresh();
  await testBlockingRefreshTimeoutReturnsControl();
  await testCandidateEvaluationCanResumeAfterRecovery();
  console.log('research_liveness_selfcheck: ok');
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
