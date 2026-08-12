#!/usr/bin/env node
'use strict';

// Offline/read-only analysis of a TailEnd economic-validity checkpoint.
// It performs no network requests and never writes to the source checkpoint.

const fs = require('fs');
const path = require('path');

const PRICE_BUCKETS = [
  ['<0.95', (price) => price < 0.95],
  ['0.95-0.97', (price) => price >= 0.95 && price < 0.97],
  ['0.97-0.98', (price) => price >= 0.97 && price < 0.98],
  ['0.98-0.99', (price) => price >= 0.98 && price < 0.99],
  ['0.99+', (price) => price >= 0.99],
];

const MONTHS = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

function sum(items, getter = (value) => value) {
  return items.reduce((total, item) => total + Number(getter(item) || 0), 0);
}

function mean(items, getter = (value) => value) {
  const values = items.map(getter).map(Number).filter(Number.isFinite);
  return values.length ? sum(values) / values.length : null;
}

function quantile(items, fraction) {
  const values = items.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!values.length) return null;
  const index = (values.length - 1) * fraction;
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return values[low] + (values[high] - values[low]) * (index - low);
}

function distribution(items, getter) {
  const values = items.map(getter).map(Number).filter(Number.isFinite);
  return {
    count: values.length,
    mean: mean(values),
    min: values.length ? Math.min(...values) : null,
    p25: quantile(values, 0.25),
    median: quantile(values, 0.50),
    p75: quantile(values, 0.75),
    max: values.length ? Math.max(...values) : null,
  };
}

function slugPart(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function explicitDate(question, observation) {
  const match = String(question || '').match(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})(?:,?\s+(\d{4}))?/i);
  if (!match) return null;
  const year = Number(match[3]) || new Date(observation.timestamp || observation.endDate).getUTCFullYear();
  return `${year}-${String(MONTHS[match[1].toLowerCase()]).padStart(2, '0')}-${String(Number(match[2])).padStart(2, '0')}`;
}

function clusterIdentity(observation) {
  const question = String(observation.question || '');
  const lower = question.toLowerCase();
  const slug = String(observation.marketSlug || '').toLowerCase();
  const date = explicitDate(question, observation);

  const crypto = lower.match(/\b(bitcoin|ethereum)\b/);
  if (crypto && date && /\b(reach|dip|above|below|price)\b/.test(lower)) {
    return {
      key: `crypto_path:${crypto[1]}:${date}`,
      label: `${crypto[1]} price path on ${date}`,
      correlation: 'highly_correlated_same_asset_overlapping_resolution_window',
      basis: 'same underlying crypto asset and explicit resolution date',
    };
  }

  const weather = question.match(/\b(highest|lowest) temperature in (.+?) (?:be|on).*?\b(?:on\s+)?(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}/i);
  if (weather && date) {
    const measure = weather[1].toLowerCase();
    const location = slugPart(weather[2]);
    return {
      key: `weather:${measure}:${location}:${date}`,
      label: `${measure} temperature in ${weather[2]} on ${date}`,
      correlation: 'mechanically_correlated_same_observed_temperature_measure',
      basis: 'same location, date, and high/low temperature statistic',
    };
  }

  const sports = slug.match(/^(ufc|mlb|wnba|nba|nfl|nhl|lec|lol|col1)-([a-z0-9]+)-([a-z0-9]+)-(\d{4}-\d{2}-\d{2})(?:-|$)/);
  if (sports) {
    const event = `${sports[1]}-${sports[2]}-${sports[3]}-${sports[4]}`;
    return {
      key: `sports_event:${event}`,
      label: event,
      correlation: 'highly_correlated_same_sports_or_fight_event',
      basis: 'shared league, participants, and event date in canonical market slug',
    };
  }

  if (/annual inflation be .* in july/.test(lower)) {
    return {
      key: 'macro_release:annual_inflation:july_2026',
      label: 'July 2026 annual inflation release',
      correlation: 'mechanically_correlated_same_release_measure',
      basis: 'mutually exclusive levels of the same annual inflation release',
    };
  }
  if (/monthly inflation .* in july/.test(lower)) {
    return {
      key: 'macro_release:monthly_inflation:july_2026',
      label: 'July 2026 monthly inflation release',
      correlation: 'same_release_but_distinct_monthly_measure',
      basis: 'same monthly inflation statistic; kept separate from annual inflation',
    };
  }
  if (/south carolina republican senate special primary/.test(lower)) {
    return {
      key: 'election:sc_republican_senate_special_primary:first_round',
      label: 'South Carolina Republican Senate special primary first round',
      correlation: 'mechanically_correlated_same_election_result',
      basis: 'candidate outcomes from the same election round',
    };
  }
  if (/elon musk post .*tweets from august 10 to august 12/.test(lower)) {
    return {
      key: 'count_window:elon_tweets:2026-08-10:2026-08-12',
      label: 'Elon Musk tweet count, August 10-12, 2026',
      correlation: 'mechanically_correlated_same_count_window',
      basis: 'ranges of the same account count over the same window',
    };
  }
  if (/us announces end of iranian blockade by august 1[12]/.test(lower)) {
    return {
      key: 'nested_deadline:us_end_iranian_blockade:2026-08-11:2026-08-12',
      label: 'US announcement ending Iranian blockade by August 11/12, 2026',
      correlation: 'highly_correlated_nested_deadlines',
      basis: 'same event with overlapping nested deadlines',
    };
  }

  return {
    key: `market:${String(observation.marketId)}`,
    label: question || String(observation.marketId),
    correlation: 'no_shared_driver_detected',
    basis: 'singleton fallback; category alone is never used for merging',
  };
}

// Lanczos log-gamma plus continued-fraction incomplete beta, used only for
// exact two-sided Clopper-Pearson binomial intervals.
function logGamma(value) {
  const coefficients = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  if (value < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
  let x = 0.99999999999980993;
  const z = value - 1;
  for (let index = 0; index < coefficients.length; index += 1) x += coefficients[index] / (z + index + 1);
  const t = z + coefficients.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
}

function betaFraction(a, b, x) {
  const maxIterations = 200;
  const epsilon = 3e-14;
  const floor = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - qab * x / qap;
  if (Math.abs(d) < floor) d = floor;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= maxIterations; m += 1) {
    const m2 = 2 * m;
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < floor) d = floor;
    c = 1 + aa / c;
    if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    h *= d * c;
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < floor) d = floor;
    c = 1 + aa / c;
    if (Math.abs(c) < floor) c = floor;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < epsilon) break;
  }
  return h;
}

function regularizedBeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const factor = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2)
    ? factor * betaFraction(a, b, x) / a
    : 1 - factor * betaFraction(b, a, 1 - x) / b;
}

function inverseRegularizedBeta(probability, a, b) {
  let low = 0;
  let high = 1;
  for (let index = 0; index < 100; index += 1) {
    const midpoint = (low + high) / 2;
    if (regularizedBeta(midpoint, a, b) < probability) low = midpoint;
    else high = midpoint;
  }
  return (low + high) / 2;
}

function clopperPearson(wins, trials, confidence = 0.95) {
  if (!(trials > 0) || wins < 0 || wins > trials) return { lower: 0, upper: 1, confidence, trials: 0 };
  const alpha = 1 - confidence;
  return {
    lower: wins === 0 ? 0 : inverseRegularizedBeta(alpha / 2, wins, trials - wins + 1),
    upper: wins === trials ? 1 : inverseRegularizedBeta(1 - alpha / 2, wins + 1, trials - wins),
    confidence,
    trials,
  };
}

function aggregateCluster(identity, observations) {
  const resolved = observations.filter((item) => item.resolutionScore);
  const wins = resolved.filter((item) => item.resolutionScore.correct === true);
  const losses = resolved.filter((item) => item.resolutionScore.correct === false);
  const pnl = sum(resolved, (item) => item.resolutionScore.netPnlUsd);
  const capital = sum(resolved, (item) => item.entryEconomics?.requiredCapitalUsd);
  return {
    ...identity,
    signals: observations.length,
    resolved: resolved.length,
    wins: wins.length,
    losses: losses.length,
    prices: observations.map((item) => ({
      marketId: item.marketId,
      question: item.question,
      outcome: item.outcome,
      executablePrice: item.entryEconomics?.executablePrice ?? null,
      resolved: Boolean(item.resolutionScore),
      correct: item.resolutionScore?.correct ?? null,
      netPnlUsd: item.resolutionScore?.netPnlUsd ?? null,
    })),
    hypotheticalPnlUsd: pnl,
    resolvedCapitalUsd: capital,
    roi: capital > 0 ? pnl / capital : null,
    resolutionCoverage: observations.length ? resolved.length / observations.length : null,
    clusterEconomicOutcome: resolved.length === 0 ? 'unresolved' : pnl > 0 ? 'positive' : pnl < 0 ? 'negative' : 'flat',
    internalOutcomePattern: resolved.length === 0 ? 'unresolved' : losses.length === 0 ? 'all_win' : wins.length === 0 ? 'all_loss' : 'mixed',
  };
}

function priceRegime(name, predicate, observations) {
  const population = observations.filter((item) => item.entryEconomics?.ok && predicate(Number(item.entryEconomics.executablePrice)));
  const resolved = population.filter((item) => item.resolutionScore);
  const wins = resolved.filter((item) => item.resolutionScore.correct === true);
  const losses = resolved.filter((item) => item.resolutionScore.correct === false);
  const capital = sum(resolved, (item) => item.entryEconomics.requiredCapitalUsd);
  const pnl = sum(resolved, (item) => item.resolutionScore.netPnlUsd);
  const averageCorrectPnl = mean(population, (item) => item.entryEconomics.shares - item.entryEconomics.requiredCapitalUsd);
  const averageLossMagnitude = mean(population, (item) => item.entryEconomics.requiredCapitalUsd);
  return {
    bucket: name,
    totalOpportunities: population.length,
    resolvedOpportunities: resolved.length,
    independentResolvedClusters: new Set(resolved.map((item) => clusterIdentity(item).key)).size,
    wins: wins.length,
    losses: losses.length,
    observedWinRate: resolved.length ? wins.length / resolved.length : null,
    signalLevelConfidence95: clopperPearson(wins.length, resolved.length),
    meanBreakEvenWinRate: mean(population, (item) => item.entryEconomics.breakEvenProbability),
    hypotheticalPnlUsd: pnl,
    resolvedCapitalUsd: capital,
    roi: capital > 0 ? pnl / capital : null,
    averageCorrectPnlUsd: averageCorrectPnl,
    averageLossMagnitudeUsd: averageLossMagnitude,
    averageWinsToRecoverOneLoss: averageCorrectPnl > 0 ? averageLossMagnitude / averageCorrectPnl : null,
  };
}

function analyze(checkpoint) {
  if (!checkpoint || !Array.isArray(checkpoint.observations)) throw new Error('checkpoint observations are required');
  const observations = checkpoint.observations;
  const grouped = new Map();
  for (const observation of observations) {
    const identity = clusterIdentity(observation);
    if (!grouped.has(identity.key)) grouped.set(identity.key, { identity, observations: [] });
    grouped.get(identity.key).observations.push(observation);
  }
  const clusters = [...grouped.values()]
    .map(({ identity, observations: members }) => aggregateCluster(identity, members))
    .sort((a, b) => b.resolved - a.resolved || b.signals - a.signals || a.key.localeCompare(b.key));
  const resolvedSignals = observations.filter((item) => item.resolutionScore);
  const signalWins = resolvedSignals.filter((item) => item.resolutionScore.correct === true).length;
  const resolvedClusters = clusters.filter((cluster) => cluster.resolved > 0);
  const positiveClusters = resolvedClusters.filter((cluster) => cluster.clusterEconomicOutcome === 'positive').length;
  const regimes = Object.fromEntries(PRICE_BUCKETS.map(([name, predicate]) => [name, priceRegime(name, predicate, observations)]));
  const nearOne = regimes['0.99+'];
  const nearOneResolved = resolvedSignals.filter((item) => Number(item.entryEconomics?.executablePrice) >= 0.99);
  const representativeLoss = mean(nearOneResolved, (item) => item.entryEconomics.requiredCapitalUsd)
    ?? nearOne.averageLossMagnitudeUsd;
  const currentNearOneCapital = sum(nearOneResolved, (item) => item.entryEconomics.requiredCapitalUsd);
  const stress = [1, 2, 3].map((losses) => {
    const pnl = nearOne.hypotheticalPnlUsd - losses * representativeLoss;
    const capital = currentNearOneCapital + losses * representativeLoss;
    return {
      additionalLosses: losses,
      resultingRawWinRate: nearOne.wins / (nearOne.wins + nearOne.losses + losses),
      hypotheticalPnlUsd: pnl,
      capitalUsd: capital,
      roi: capital > 0 ? pnl / capital : null,
    };
  });
  const resolvedClusterSignalCounts = resolvedClusters.map((cluster) => cluster.resolved);
  return {
    study: 'TAILEND_INDEPENDENT_EVENT_ECONOMIC_ANALYSIS_V1',
    analyzedAt: new Date().toISOString(),
    checkpointUpdatedAt: checkpoint.updatedAt || null,
    checkpointReason: checkpoint.reason || null,
    methodology: {
      singletonFallback: true,
      categoryNeverUsedAlone: true,
      clusterSuccessDefinition: 'positive aggregate hypothetical PnL among resolved signals in a shared-driver cluster',
      confidence: 'two-sided exact 95% Clopper-Pearson',
      caveat: 'cluster outcomes are heterogeneous, overlapping across price buckets, and not clean iid Bernoulli trials',
    },
    summary: {
      rawSignals: observations.length,
      rawResolvedSignals: resolvedSignals.length,
      signalWins,
      signalLosses: resolvedSignals.length - signalWins,
      signalWinRate: resolvedSignals.length ? signalWins / resolvedSignals.length : null,
      signalLevelConfidence95: clopperPearson(signalWins, resolvedSignals.length),
      totalDistinctClusters: clusters.length,
      independentResolvedClusters: resolvedClusters.length,
      positiveResolvedClusters: positiveClusters,
      negativeResolvedClusters: resolvedClusters.filter((cluster) => cluster.clusterEconomicOutcome === 'negative').length,
      flatResolvedClusters: resolvedClusters.filter((cluster) => cluster.clusterEconomicOutcome === 'flat').length,
      clusterPositiveRate: resolvedClusters.length ? positiveClusters / resolvedClusters.length : null,
      clusterLevelConfidence95: clopperPearson(positiveClusters, resolvedClusters.length),
      resolvedSignalsPerCluster: distribution(resolvedClusterSignalCounts, (value) => value),
    },
    clusters,
    priceRegimes: regimes,
    nearOneFragility: {
      currentPnlUsd: nearOne.hypotheticalPnlUsd,
      wins: nearOne.wins,
      losses: nearOne.losses,
      representativeAdditionalLossUsd: representativeLoss,
      stress,
      populationMeanBreakEvenWinRate: nearOne.meanBreakEvenWinRate,
      resolvedPayoffBreakEvenWinRate: representativeLoss && mean(nearOneResolved, (item) => item.entryEconomics.shares - item.entryEconomics.requiredCapitalUsd)
        ? representativeLoss / (representativeLoss + mean(nearOneResolved, (item) => item.entryEconomics.shares - item.entryEconomics.requiredCapitalUsd))
        : null,
    },
    lowerPricePnl: {
      below097Usd: regimes['<0.95'].hypotheticalPnlUsd + regimes['0.95-0.97'].hypotheticalPnlUsd,
      below097Resolved: regimes['<0.95'].resolvedOpportunities + regimes['0.95-0.97'].resolvedOpportunities,
      below097IndependentClusters: new Set(resolvedSignals
        .filter((item) => Number(item.entryEconomics?.executablePrice) < 0.97)
        .map((item) => clusterIdentity(item).key)).size,
    },
    resolutionBias: {
      executablePrice: {
        full: distribution(observations.filter((item) => item.entryEconomics?.ok), (item) => item.entryEconomics.executablePrice),
        resolved: distribution(resolvedSignals, (item) => item.entryEconomics?.executablePrice),
      },
      confidence: {
        full: distribution(observations, (item) => item.currentSignal?.confidence),
        resolved: distribution(resolvedSignals, (item) => item.currentSignal?.confidence),
      },
      hoursToExpiry: {
        full: distribution(observations, (item) => Number(item.timeToExpiryMs) / 3_600_000),
        resolved: distribution(resolvedSignals, (item) => Number(item.timeToExpiryMs) / 3_600_000),
      },
      spread: {
        full: distribution(observations, (item) => item.spread),
        resolved: distribution(resolvedSignals, (item) => item.spread),
      },
    },
  };
}

function parseArgs(argv) {
  const args = {};
  for (const value of argv) {
    if (!value.startsWith('--')) continue;
    const [key, ...rest] = value.slice(2).split('=');
    args[key] = rest.length ? rest.join('=') : true;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = path.resolve(String(args.input || process.argv[2] || ''));
  if (!input) throw new Error('usage: tailend_economic_cluster_analysis.js --input=<checkpoint.json> [--output=<analysis.json>]');
  const checkpoint = JSON.parse(fs.readFileSync(input, 'utf8'));
  const result = analyze(checkpoint);
  const rendered = `${JSON.stringify(result, null, 2)}\n`;
  if (args.output) {
    const output = path.resolve(String(args.output));
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    const temporary = `${output}.tmp-${process.pid}`;
    fs.writeFileSync(temporary, rendered, { mode: 0o600 });
    fs.renameSync(temporary, output);
    process.stdout.write(`${JSON.stringify({ ok: true, input, output, summary: result.summary })}\n`);
  } else {
    process.stdout.write(rendered);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  }
}

module.exports = { analyze, clopperPearson, clusterIdentity };
