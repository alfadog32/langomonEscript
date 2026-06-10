'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const childProcess = require('child_process');
const crypto = require('crypto');

const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, '.env');
const TOKEN_FILE = path.join(ROOT, '.dashboard_token');
const STATE_FILE_DEFAULT = path.join(ROOT, 'moneymaker_v3_state.json');
const IMPORTANT_LOG_PATTERNS = [
  '[ORDER]',
  '[ORDER SKIP DUPLICATE]',
  '[SIGNAL BLOCK]',
  '[CONSENSUS BLOCK]',
  '[ENGINE STARVATION WARNING]',
  '[FILL]',
  '[RESEARCH REFRESH]',
];
const SENSITIVE_KEY_RE = /(TOKEN|KEY|SECRET|PASSWORD|PRIVATE|MNEMONIC)/i;
const SETTING_KEYS = [
  'INITIAL_CASH',
  'BASE_ORDER_USD',
  'MIN_ORDER_USD',
  'MIN_CONFIDENCE',
  'SPREADHUNTER_MIN_CONFIDENCE_PAPER',
  'PAPER_CONFIDENCE_PROFILE',
  'MIN_SIGNAL_EDGE',
  'MAX_TOTAL_EXPOSURE_USD',
  'MAX_TOTAL_OPEN_ORDER_USD',
  'MAX_POSITION_USD',
  'MAX_MARKET_EXPOSURE_USD',
  'MAX_DRAWDOWN_PCT',
  'AUTO_LIVE_CANDIDATES_ENABLED',
  'ENABLE_LIVE_TRADING',
  'LIVE_AUTO_EXECUTE',
  'LIVE_KILL_SWITCH',
  'LIVE_DRY_RUN_ONLY',
  'LIVE_SUBMIT_CONFIRM',
  'TELEGRAM_APPROVAL_WATCH_PATHS',
  'DASHBOARD_ENABLED',
  'DASHBOARD_HOST',
  'DASHBOARD_PORT',
  'DASHBOARD_PUBLIC_URL',
];

const fileEnv = parseEnvFile(ENV_FILE);
const host = envStr('DASHBOARD_HOST', '127.0.0.1');
const port = envInt('DASHBOARD_PORT', 18888);

if (envStr('DASHBOARD_ENABLED', 'false').toLowerCase() !== 'true') {
  console.error('Dashboard refused to start: DASHBOARD_ENABLED must be true.');
  process.exit(1);
}

const dashboardToken = resolveDashboardToken(host);
const tokenRequired = host === '0.0.0.0' || dashboardToken.length > 0;
const publicUrl = normalizePublicUrl(envStr('DASHBOARD_PUBLIC_URL', defaultPublicUrl(host, port)));

const server = http.createServer((req, res) => {
  try {
    routeRequest(req, res);
  } catch (err) {
    sendJson(res, 500, { ok: false, error: 'dashboard_error', message: err.message });
  }
});

server.listen(port, host, () => {
  const displayUrl = dashboardToken
    ? `${publicUrl}/?token=${encodeURIComponent(dashboardToken)}`
    : `${publicUrl}/`;
  console.log(`Dashboard URL: ${displayUrl}`);
});

function routeRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  if (!isAuthorized(url)) {
    sendText(res, 401, 'Unauthorized\n', 'text/plain; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && url.pathname === '/') {
    sendHtml(res, renderHtml(collectStatus()));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    sendJson(res, 200, collectStatus());
    return;
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/logs') {
    const status = collectStatus();
    sendText(res, 200, status.logs.importantLines.join('\n') + '\n', 'text/plain; charset=utf-8');
    return;
  }

  sendJson(res, 404, { ok: false, error: 'not_found' });
}

function isAuthorized(url) {
  if (!tokenRequired) return true;
  return url.searchParams.get('token') === dashboardToken;
}

function collectStatus() {
  const pm2 = getPm2Status();
  const logs = getLogs(pm2);
  const state = readState();
  const report = parseLatestPortfolioReport(logs.allLines);
  const portfolio = buildPortfolioSummary(state, report);

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    server: {
      time: new Date().toString(),
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
    },
    git: getGitInfo(),
    pm2,
    portfolio,
    latestPortfolioReport: report.lines,
    settings: getEffectiveSettings(),
    logs: {
      source: logs.source,
      message: logs.message,
      importantLines: logs.importantLines.slice(-50),
    },
  };
}

function buildPortfolioSummary(state, report) {
  const stateSummary = summarizeState(state);
  return {
    equity: firstFinite(report.equity, stateSummary.equity),
    cash: firstFinite(report.cash, stateSummary.cash),
    drawdownPct: firstFinite(report.drawdownPct, stateSummary.drawdownPct),
    closedPnl: firstFinite(report.closedPnl, stateSummary.closedPnl),
    positionExposureUsd: firstFinite(report.positionExposureUsd, stateSummary.positionExposureUsd),
    openOrderExposureUsd: firstFinite(report.openOrderExposureUsd, null),
    totalExposureUsd: firstFinite(report.totalExposureUsd, stateSummary.totalExposureUsd),
    openOrders: firstFinite(report.openOrders, null),
    ghostFavorablePct: firstFinite(report.ghostFavorablePct, stateSummary.ghostFavorablePct),
    source: report.lines.length > 0 ? 'logs' : stateSummary.source,
    stateFile: state.path,
    stateAvailable: state.available,
    stateMessage: state.message,
  };
}

function summarizeState(state) {
  if (!state.available || !state.data) {
    return {
      source: 'unavailable',
      equity: null,
      cash: null,
      drawdownPct: null,
      closedPnl: null,
      positionExposureUsd: null,
      totalExposureUsd: null,
      ghostFavorablePct: null,
    };
  }

  const data = state.data;
  const positions = data.positions && typeof data.positions === 'object' ? data.positions : {};
  const costBasis = data.costBasis && typeof data.costBasis === 'object' ? data.costBasis : {};
  let positionExposureUsd = 0;

  for (const [tokenId, qtyRaw] of Object.entries(positions)) {
    const qty = Number(qtyRaw);
    const avg = Number(costBasis[tokenId]);
    if (Number.isFinite(qty) && qty > 0 && Number.isFinite(avg) && avg > 0) {
      positionExposureUsd += qty * avg;
    }
  }

  const cash = numberOrNull(data.cash);
  const equity = cash === null ? null : cash + positionExposureUsd;
  const peakEquity = numberOrNull(data.peakEquity);
  const drawdownPct = equity !== null && peakEquity !== null && peakEquity > 0
    ? Math.max(0, ((peakEquity - equity) / peakEquity) * 100)
    : null;
  const ghostTotal = Number(data.ghostStats?.total || 0);
  const ghostFavorable = Number(data.ghostStats?.favorable || 0);

  return {
    source: 'state',
    equity,
    cash,
    drawdownPct,
    closedPnl: numberOrNull(data.closedPnl),
    positionExposureUsd,
    totalExposureUsd: positionExposureUsd,
    ghostFavorablePct: ghostTotal > 0 ? (ghostFavorable / ghostTotal) * 100 : null,
  };
}

function parseLatestPortfolioReport(lines) {
  const start = findLastIndex(lines, (line) => line.includes('--- PORTFOLIO REPORT ---'));
  if (start < 0) return emptyReport();

  const reportLines = lines.slice(start, Math.min(lines.length, start + 40));
  const report = emptyReport();
  report.lines = reportLines;

  for (const line of reportLines) {
    let match = line.match(/Equity:\s*\$([\d.-]+)\s*\|\s*Cash:\s*\$([\d.-]+)\s*\|\s*Drawdown:\s*([\d.-]+)%/);
    if (match) {
      report.equity = Number(match[1]);
      report.cash = Number(match[2]);
      report.drawdownPct = Number(match[3]);
      continue;
    }

    match = line.match(/Open Orders:\s*(\d+)\s*\|\s*Exposure:\s*\$([\d.-]+)\s*\|\s*Closed PnL:\s*\$([\d.-]+)/);
    if (match) {
      report.openOrders = Number(match[1]);
      report.totalExposureUsd = Number(match[2]);
      report.closedPnl = Number(match[3]);
      continue;
    }

    match = line.match(/Position Exposure:\s*\$([\d.-]+)\s*\|\s*Open Order Exposure:\s*\$([\d.-]+)/);
    if (match) {
      report.positionExposureUsd = Number(match[1]);
      report.openOrderExposureUsd = Number(match[2]);
      continue;
    }

    match = line.match(/Ghost calibration:\s*total=(\d+)\s*favorable=([\d.-]+)%/);
    if (match) {
      report.ghostFavorablePct = Number(match[2]);
    }
  }

  return report;
}

function emptyReport() {
  return {
    lines: [],
    equity: null,
    cash: null,
    drawdownPct: null,
    closedPnl: null,
    positionExposureUsd: null,
    openOrderExposureUsd: null,
    totalExposureUsd: null,
    openOrders: null,
    ghostFavorablePct: null,
  };
}

function getPm2Status() {
  const result = runCommand('pm2', ['jlist'], { timeout: 4000 });
  if (!result.ok) {
    return {
      available: false,
      message: `PM2 status unavailable: ${result.message}`,
      processes: [],
    };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    const processes = Array.isArray(parsed) ? parsed.map((proc) => ({
      name: proc.name || '',
      pmId: proc.pm_id,
      status: proc.pm2_env?.status || 'unknown',
      restartCount: proc.pm2_env?.restart_time,
      unstableRestarts: proc.pm2_env?.unstable_restarts,
      uptime: proc.pm2_env?.pm_uptime ? new Date(proc.pm2_env.pm_uptime).toISOString() : null,
      memoryBytes: proc.monit?.memory,
      cpuPct: proc.monit?.cpu,
      outLogPath: proc.pm2_env?.pm_out_log_path || null,
      errLogPath: proc.pm2_env?.pm_err_log_path || null,
    })) : [];

    return {
      available: true,
      message: processes.length > 0 ? 'PM2 process list loaded.' : 'PM2 is available but has no processes.',
      processes,
    };
  } catch (err) {
    return {
      available: false,
      message: `PM2 returned invalid JSON: ${err.message}`,
      processes: [],
    };
  }
}

function getLogs(pm2) {
  const pm2LogPaths = [];
  for (const proc of pm2.processes || []) {
    if (proc.outLogPath) pm2LogPaths.push(proc.outLogPath);
    if (proc.errLogPath) pm2LogPaths.push(proc.errLogPath);
  }

  const pm2Text = readManyFiles(pm2LogPaths, 256 * 1024);
  if (pm2Text.length > 0) {
    return buildLogResult('pm2', 'Read recent PM2 log files.', pm2Text);
  }

  const fallbackPaths = findFallbackLogFiles();
  const fallbackText = readManyFiles(fallbackPaths, 256 * 1024);
  if (fallbackText.length > 0) {
    return buildLogResult('local-files', 'Read recent local log files.', fallbackText);
  }

  return buildLogResult('unavailable', 'No PM2 or local safe log files were available.', '');
}

function buildLogResult(source, message, text) {
  const allLines = text
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter(Boolean);
  const importantLines = allLines.filter((line) => IMPORTANT_LOG_PATTERNS.some((pattern) => line.includes(pattern)));

  return {
    source,
    message,
    allLines,
    importantLines: importantLines.slice(-50),
  };
}

function findFallbackLogFiles() {
  const candidates = [
    path.join(ROOT, 'moneymaker.log'),
    path.join(ROOT, 'moneymaker_v3.log'),
    path.join(ROOT, 'pm2.log'),
    path.join(ROOT, 'logs', 'moneymaker.log'),
    path.join(ROOT, 'logs', 'moneymaker_v3.log'),
  ];

  for (const dir of [ROOT, path.join(ROOT, 'logs')]) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith('.log')) {
          candidates.push(path.join(dir, entry.name));
        }
      }
    } catch {
      // Ignore inaccessible log directories.
    }
  }

  return [...new Set(candidates)].filter((candidate) => {
    const base = path.basename(candidate).toLowerCase();
    return !base.includes('secret') && !base.includes('key') && !base.includes('token');
  });
}

function readManyFiles(paths, maxBytes) {
  let text = '';
  for (const filePath of [...new Set(paths)]) {
    const chunk = readTail(filePath, maxBytes);
    if (chunk) text += `\n${chunk}`;
  }
  return text;
}

function readTail(filePath, maxBytes) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return '';
    const start = Math.max(0, stat.size - maxBytes);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buffer, 0, buffer.length, start);
      return buffer.toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

function readState() {
  const statePath = path.resolve(ROOT, envStr('STATE_FILE', STATE_FILE_DEFAULT));
  try {
    if (!fs.existsSync(statePath)) {
      return { available: false, path: statePath, message: 'State file not found.', data: null };
    }
    const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    return { available: true, path: statePath, message: 'State file loaded.', data };
  } catch (err) {
    return { available: false, path: statePath, message: `State file unavailable: ${err.message}`, data: null };
  }
}

function getGitInfo() {
  return {
    branch: commandText('git', ['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown',
    commit: commandText('git', ['rev-parse', '--short', 'HEAD']) || 'unknown',
  };
}

function getEffectiveSettings() {
  const settings = {};
  for (const key of SETTING_KEYS) {
    settings[key] = sanitizeValue(key, envRaw(key));
  }
  return settings;
}

function sanitizeValue(key, value) {
  if (value === undefined || value === null || value === '') return '';
  if (SENSITIVE_KEY_RE.test(key)) return '[REDACTED]';
  return String(value);
}

function resolveDashboardToken(bindHost) {
  const configured = envRaw('DASHBOARD_TOKEN');
  if (configured && String(configured).trim()) return String(configured).trim();
  if (bindHost !== '0.0.0.0') return '';

  try {
    if (fs.existsSync(TOKEN_FILE)) {
      const existing = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
      if (existing) return existing;
    }

    const token = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
    try {
      fs.chmodSync(TOKEN_FILE, 0o600);
    } catch {
      // chmod can be unavailable on some Windows filesystems.
    }
    return token;
  } catch (err) {
    console.error(`Dashboard refused to start: could not create .dashboard_token: ${err.message}`);
    process.exit(1);
  }
}

function normalizePublicUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function defaultPublicUrl(bindHost, bindPort) {
  const urlHost = bindHost === '0.0.0.0' ? firstLanAddress() || os.hostname() : bindHost;
  return `http://${urlHost}:${bindPort}`;
}

function firstLanAddress() {
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return '';
}

function parseEnvFile(filePath) {
  const parsed = {};
  try {
    if (!fs.existsSync(filePath)) return parsed;
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
      if (!match) continue;
      parsed[match[1]] = stripEnvQuotes(match[2].trim());
    }
  } catch {
    return parsed;
  }
  return parsed;
}

function stripEnvQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function envRaw(key) {
  if (Object.prototype.hasOwnProperty.call(process.env, key)) return process.env[key];
  return fileEnv[key];
}

function envStr(key, fallback) {
  const value = envRaw(key);
  if (value === undefined || value === null || value === '') return fallback;
  return String(value);
}

function envInt(key, fallback) {
  const value = Number.parseInt(envStr(key, String(fallback)), 10);
  return Number.isFinite(value) ? value : fallback;
}

function commandText(command, args) {
  const result = runCommand(command, args, { timeout: 3000 });
  return result.ok ? result.stdout.trim() : '';
}

function runCommand(command, args, options = {}) {
  const commands = process.platform === 'win32' ? [command, `${command}.cmd`] : [command];
  for (const candidate of commands) {
    try {
      const stdout = childProcess.execFileSync(candidate, args, {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: options.timeout || 3000,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, stdout, message: 'ok' };
    } catch (err) {
      if (candidate === commands[commands.length - 1]) {
        return { ok: false, stdout: '', message: err.message };
      }
    }
  }
  return { ok: false, stdout: '', message: 'command unavailable' };
}

function renderHtml(status) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>MoneyMaker Dashboard</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 24px; color: #111; background: #f6f7f8; }
    h1, h2 { margin: 0 0 12px; }
    section { margin: 0 0 18px; padding: 16px; background: #fff; border: 1px solid #ddd; }
    table { border-collapse: collapse; width: 100%; background: #fff; }
    th, td { text-align: left; border: 1px solid #ddd; padding: 8px; vertical-align: top; }
    th { background: #eee; }
    pre { white-space: pre-wrap; word-break: break-word; background: #111; color: #eee; padding: 12px; overflow: auto; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
    .metric { border: 1px solid #ddd; padding: 10px; background: #fafafa; }
    .label { color: #555; font-size: 12px; text-transform: uppercase; }
    .value { font-size: 20px; margin-top: 4px; }
  </style>
  <script>setTimeout(function () { window.location.reload(); }, 10000);</script>
</head>
<body>
  <h1>MoneyMaker Dashboard</h1>
  <section>
    <div class="grid">
      ${metric('Server Time', status.server.time)}
      ${metric('Hostname', status.server.hostname)}
      ${metric('Git Branch', status.git.branch)}
      ${metric('Git Commit', status.git.commit)}
    </div>
  </section>
  <section>
    <h2>Portfolio</h2>
    <div class="grid">
      ${metric('Equity', money(status.portfolio.equity))}
      ${metric('Cash', money(status.portfolio.cash))}
      ${metric('Drawdown', pct(status.portfolio.drawdownPct))}
      ${metric('Closed PnL', money(status.portfolio.closedPnl))}
      ${metric('Position Exposure', money(status.portfolio.positionExposureUsd))}
      ${metric('Open Order Exposure', money(status.portfolio.openOrderExposureUsd))}
      ${metric('Open Orders', display(status.portfolio.openOrders))}
      ${metric('Ghost Favorable', pct(status.portfolio.ghostFavorablePct))}
    </div>
    <p>${escapeHtml(status.portfolio.stateMessage)}</p>
  </section>
  <section>
    <h2>PM2</h2>
    <p>${escapeHtml(status.pm2.message)}</p>
    ${renderTable(status.pm2.processes, ['name', 'pmId', 'status', 'restartCount', 'unstableRestarts', 'uptime', 'memoryBytes', 'cpuPct'])}
  </section>
  <section>
    <h2>Settings</h2>
    ${renderKeyValueTable(status.settings)}
  </section>
  <section>
    <h2>Latest Portfolio Report</h2>
    <pre>${escapeHtml(status.latestPortfolioReport.join('\n') || 'No portfolio report found in available logs.')}</pre>
  </section>
  <section>
    <h2>Important Logs</h2>
    <p>${escapeHtml(status.logs.message)}</p>
    <pre>${escapeHtml(status.logs.importantLines.join('\n') || 'No important log lines found.')}</pre>
  </section>
</body>
</html>`;
}

function metric(label, value) {
  return `<div class="metric"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(display(value))}</div></div>`;
}

function renderTable(rows, columns) {
  if (!rows || rows.length === 0) return '<p>No rows.</p>';
  return `<table><thead><tr>${columns.map((col) => `<th>${escapeHtml(col)}</th>`).join('')}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map((col) => `<td>${escapeHtml(display(row[col]))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
}

function renderKeyValueTable(obj) {
  const rows = Object.entries(obj).map(([key, value]) => ({ key, value }));
  return renderTable(rows, ['key', 'value']);
}

function sendHtml(res, html) {
  sendText(res, 200, html, 'text/html; charset=utf-8');
}

function sendJson(res, statusCode, data) {
  sendText(res, statusCode, JSON.stringify(data, null, 2), 'application/json; charset=utf-8');
}

function sendText(res, statusCode, body, contentType) {
  res.writeHead(statusCode, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function renderNumber(value, digits) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : 'n/a';
}

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : 'n/a';
}

function pct(value) {
  const n = Number(value);
  return Number.isFinite(n) ? `${n.toFixed(2)}%` : 'n/a';
}

function display(value) {
  if (value === undefined || value === null || value === '') return 'n/a';
  if (typeof value === 'number') return renderNumber(value, 2);
  return String(value);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstFinite(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function findLastIndex(items, predicate) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i], i)) return i;
  }
  return -1;
}
