import type { FastifyInstance } from 'fastify';
import { getRedis } from '../../redis.js';
import { requireAdmin } from '../../auth/middleware.js';
import {
  readRecentLogs,
  readLogsAfter,
  type RawLogEntry,
} from '../../log/buffer.js';

/**
 * Admin log viewer (admin-only). A text-only, web-accessible window onto the
 * shared Redis log stream that api/worker/bot fan into (see log/buffer.ts).
 *
 *   GET /admin/logs       — a self-contained terminal-style HTML page
 *                           (black background, monospace, colored by level)
 *                           that tails the stream by polling the JSON endpoint.
 *   GET /admin/logs.json  — recent entries, or those after `?after=<id>` so the
 *                           page can tail incrementally. `?limit=` (1..1000),
 *                           `?level=` filters to a minimum severity.
 *
 * Both routes run at `logLevel: 'warn'` so the viewer's own 2s polling traffic
 * doesn't flood the very stream it's displaying.
 */

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;
const POLL_LIMIT = 500;

/** Pino numeric severities for the `level` (string-label) filter. */
const LEVEL_SEVERITY: Record<string, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const STREAM_ID_RE = /^\d+-\d+$/;

// Where the commit chip links. One named constant — the project has prior
// history of a `ticker`-vs-`tickr` typo in a prod string, so keep it in one
// place and spelled `kgheacock/tickr`.
const GITHUB_REPO_URL = 'https://github.com/kgheacock/tickr';
// A real deployed SHA (api.ts guarantees TICKR_COMMIT is the deploy SHA).
// The compose/dev fallbacks ('local', 'unknown') won't match, so they render
// as a non-linkable label rather than a dead GitHub link.
const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i;

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );
}

/** The commit chip for the page header: a GitHub link for a real SHA, or a
 *  dimmed label for the dev/local sentinels. */
function commitChipHtml(commit: string): string {
  const safe = escapeHtml(commit);
  if (COMMIT_SHA_RE.test(commit)) {
    return (
      `<a class="commit" href="${GITHUB_REPO_URL}/commit/${commit}" ` +
      `target="_blank" rel="noopener noreferrer" title="${safe}">` +
      `⎇ ${commit.slice(0, 7)}</a>`
    );
  }
  return (
    `<span class="commit dim" title="TICKR_COMMIT not set to a deploy SHA ` +
    `in this environment">⎇ ${safe}</span>`
  );
}

interface ParsedLogEntry {
  id: string;
  level: string;
  /** Epoch ms from pino, or null if the line didn't parse. */
  time: number | null;
  msg: string;
  service?: string | undefined;
  request_id?: string | undefined;
  job_id?: string | undefined;
  component?: string | undefined;
  /** Any remaining structured fields, for display. */
  extra: Record<string, unknown>;
  /** True when the raw line wasn't valid JSON (msg holds the raw text). */
  raw?: boolean;
}

interface LogsQuery {
  limit?: string;
  after?: string;
  level?: string;
}

function parseEntry({ id, line }: RawLogEntry): ParsedLogEntry {
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    const {
      level,
      time,
      msg,
      service,
      request_id,
      job_id,
      component,
      pid,
      hostname,
      ...extra
    } = o;
    void pid;
    void hostname;
    return {
      id,
      level: typeof level === 'string' ? level : 'info',
      time: typeof time === 'number' ? time : null,
      msg: typeof msg === 'string' ? msg : '',
      service: typeof service === 'string' ? service : undefined,
      request_id: typeof request_id === 'string' ? request_id : undefined,
      job_id: typeof job_id === 'string' ? job_id : undefined,
      component: typeof component === 'string' ? component : undefined,
      extra,
    };
  } catch {
    return { id, level: 'info', time: null, msg: line, extra: {}, raw: true };
  }
}

function clampLimit(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(n)));
}

export async function registerAdminLogsRoutes(
  fastify: FastifyInstance,
): Promise<void> {
  // JSON tail endpoint. Recent entries, or those strictly after `?after=<id>`.
  fastify.get<{ Querystring: LogsQuery }>(
    '/admin/logs.json',
    {
      preHandler: [requireAdmin],
      logLevel: 'warn',
      config: { rateLimit: { max: 120, timeWindow: '1 minute' } },
    },
    async (req) => {
      const redis = getRedis();
      const after = req.query.after;

      let result;
      if (after && STREAM_ID_RE.test(after)) {
        result = await readLogsAfter(
          redis,
          after,
          clampLimit(req.query.limit, POLL_LIMIT),
        );
      } else {
        result = await readRecentLogs(
          redis,
          clampLimit(req.query.limit, DEFAULT_LIMIT),
        );
      }

      let entries = result.entries.map(parseEntry);

      const minSeverity = LEVEL_SEVERITY[req.query.level ?? ''];
      if (minSeverity !== undefined) {
        entries = entries.filter(
          (e) => (LEVEL_SEVERITY[e.level] ?? 0) >= minSeverity,
        );
      }

      return { entries, lastId: result.lastId };
    },
  );

  // The terminal-style HTML page. Self-contained (inline CSS/JS); polls the
  // JSON endpoint above. requireAdmin still gates it, so a non-admin gets the
  // 403 JSON rather than the page.
  fastify.get(
    '/admin/logs',
    { preHandler: [requireAdmin], logLevel: 'warn' },
    async (_req, reply) => {
      reply.type('text/html; charset=utf-8');
      // Bake the deployed commit into the page server-side (it's constant per
      // process) so there's no client fetch/flash for it; the backfill bar,
      // which genuinely changes, is polled from the client.
      const commit = process.env['TICKR_COMMIT'] ?? 'unknown';
      return renderLogViewer(commit);
    },
  );
}

function renderLogViewer(commit: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>tickr · logs</title>
<style>
  :root { color-scheme: dark; }
  html, body { margin: 0; height: 100%; background: #000; }
  body {
    color: #e0e0e0;
    font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    display: flex; flex-direction: column;
  }
  header {
    flex: 0 0 auto; display: flex; align-items: center; gap: 12px;
    padding: 6px 10px; background: #0a0a0a; border-bottom: 1px solid #222;
    position: sticky; top: 0;
  }
  header .title { color: #fff; font-weight: 600; }
  header label { color: #888; }
  header select, header button {
    background: #111; color: #ddd; border: 1px solid #333;
    font: inherit; padding: 2px 6px; border-radius: 3px;
  }
  header button { cursor: pointer; }
  header .status { margin-left: auto; color: #666; }
  header .status.err { color: #ff5f5f; }
  header a.commit, header span.commit {
    color: #8787d7; text-decoration: none; background: #111;
    border: 1px solid #333; padding: 1px 6px; border-radius: 3px;
  }
  header a.commit:hover { border-color: #555; color: #afafff; }
  header .commit.dim { color: #767676; }
  header .backfill {
    display: inline-flex; align-items: center; gap: 5px; color: #888;
  }
  header .backfill .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: #767676; display: inline-block;
  }
  header .backfill.ok .dot { background: #5fd75f; }
  header .backfill.busy .dot { background: #ffd75f; }
  header .backfill.err .dot { background: #ff5f5f; }
  #log { flex: 1 1 auto; overflow-y: auto; padding: 6px 10px; white-space: pre-wrap; word-break: break-word; }
  .line { display: block; }
  .ts { color: #5f5f5f; }
  .svc { color: #8787ff; }
  .lvl { font-weight: 600; }
  .ctx { color: #5f8787; }
  .extra { color: #767676; }
  /* per-level tint of the message */
  .l-trace .msg, .l-debug .msg { color: #767676; }
  .l-info  .msg { color: #e0e0e0; }
  .l-warn  .msg { color: #ffd75f; }
  .l-error .msg, .l-fatal .msg { color: #ff5f5f; }
  .l-warn  .lvl { color: #ffd75f; }
  .l-error .lvl, .l-fatal .lvl { color: #ff5f5f; }
  .l-info  .lvl { color: #5fd7af; }
  .l-debug .lvl, .l-trace .lvl { color: #767676; }
</style>
</head>
<body>
<header>
  <span class="title">tickr logs</span>
  ${commitChipHtml(commit)}
  <span class="backfill" id="backfill" title="universe backfill status (polled from /admin/ops)">
    <span class="dot"></span><span id="backfill-text">backfill…</span>
  </span>
  <label>level
    <select id="level">
      <option value="">all</option>
      <option value="debug">debug+</option>
      <option value="info">info+</option>
      <option value="warn">warn+</option>
      <option value="error">error+</option>
    </select>
  </label>
  <label><input type="checkbox" id="follow" checked /> follow</label>
  <button id="clear">clear</button>
  <span class="status" id="status">connecting…</span>
</header>
<div id="log" role="log" aria-live="polite"></div>
<script>
(function () {
  var logEl = document.getElementById('log');
  var statusEl = document.getElementById('status');
  var followEl = document.getElementById('follow');
  var levelEl = document.getElementById('level');
  var lastId = null;
  var timer = null;

  function fmtTime(ms) {
    if (!ms) return '--:--:--';
    var d = new Date(ms);
    return d.toLocaleTimeString('en-GB', { hour12: false }) +
      '.' + String(d.getMilliseconds()).padStart(3, '0');
  }

  function span(cls, text) {
    var s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  }

  function render(e) {
    var line = document.createElement('span');
    line.className = 'line l-' + (e.level || 'info');
    line.appendChild(span('ts', fmtTime(e.time)));
    line.appendChild(document.createTextNode(' '));
    line.appendChild(span('lvl', (e.level || 'info').toUpperCase().padEnd(5)));
    line.appendChild(document.createTextNode(' '));
    if (e.service) { line.appendChild(span('svc', '[' + e.service + ']')); line.appendChild(document.createTextNode(' ')); }
    var ctx = e.component || e.job_id || e.request_id;
    if (ctx) { line.appendChild(span('ctx', '(' + ctx + ')')); line.appendChild(document.createTextNode(' ')); }
    line.appendChild(span('msg', e.msg || ''));
    if (e.extra && Object.keys(e.extra).length) {
      var extra; try { extra = JSON.stringify(e.extra); } catch (_) { extra = ''; }
      if (extra && extra !== '{}') { line.appendChild(document.createTextNode(' ')); line.appendChild(span('extra', extra)); }
    }
    line.appendChild(document.createTextNode('\\n'));
    return line;
  }

  function append(entries) {
    if (!entries.length) return;
    var atBottom = followEl.checked;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < entries.length; i++) frag.appendChild(render(entries[i]));
    logEl.appendChild(frag);
    // cap the DOM to the most recent ~3000 lines
    while (logEl.childElementCount > 3000) logEl.removeChild(logEl.firstChild);
    if (atBottom) logEl.scrollTop = logEl.scrollHeight;
  }

  function poll() {
    var url = '/api/v1/admin/logs.json';
    var qs = [];
    if (lastId) qs.push('after=' + encodeURIComponent(lastId));
    if (levelEl.value) qs.push('level=' + encodeURIComponent(levelEl.value));
    if (qs.length) url += '?' + qs.join('&');
    fetch(url, { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) throw new Error('not authorized');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        append(data.entries || []);
        if (data.lastId) lastId = data.lastId;
        statusEl.textContent = 'live · ' + new Date().toLocaleTimeString('en-GB', { hour12: false });
        statusEl.className = 'status';
      })
      .catch(function (err) {
        statusEl.textContent = String(err.message || err);
        statusEl.className = 'status err';
      });
  }

  function reload() {
    lastId = null;
    logEl.textContent = '';
    poll();
  }

  // Minimal backfill status bar. Polled less often than the log tail (the ops
  // endpoint isn't at logLevel:warn, so each call shows up as an info line in
  // the very feed below) and kept honest: backfillRemaining is the primary
  // signal; jobQueueDepth is reported as general job activity, not "backfill".
  var backfillEl = document.getElementById('backfill');
  var backfillTextEl = document.getElementById('backfill-text');
  var opsTimer = null;

  function pollOps() {
    fetch('/api/v1/admin/ops', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) {
        var rem = d.backfillRemaining;
        var depth = d.jobQueueDepth;
        if (rem === 0) {
          backfillEl.className = 'backfill ok';
          backfillTextEl.textContent = 'backfill idle';
        } else {
          backfillEl.className = 'backfill busy';
          backfillTextEl.textContent = 'backfill · ' + rem + ' remaining';
        }
        if (depth > 0) {
          backfillTextEl.textContent += ' · ' + depth + ' job' + (depth === 1 ? '' : 's') + ' active';
        }
      })
      .catch(function () {
        backfillEl.className = 'backfill err';
        backfillTextEl.textContent = 'backfill ?';
      });
  }

  levelEl.addEventListener('change', reload);
  document.getElementById('clear').addEventListener('click', function () { logEl.textContent = ''; });

  poll();
  timer = setInterval(poll, 2000);
  pollOps();
  opsTimer = setInterval(pollOps, 20000);
  window.addEventListener('beforeunload', function () {
    if (timer) clearInterval(timer);
    if (opsTimer) clearInterval(opsTimer);
  });
})();
</script>
</body>
</html>`;
}
