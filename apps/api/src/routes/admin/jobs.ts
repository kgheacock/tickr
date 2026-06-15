import type { FastifyInstance } from 'fastify';
import { requireAdmin } from '../../auth/middleware.js';

/**
 * Admin jobs viewer (admin-only), parallel to the log viewer (admin/logs.ts).
 *
 *   GET /admin/jobs  — a self-contained, view-only HTML page listing every
 *                      scheduled worker job and its last-run status. It reads the
 *                      `jobs[]` array already on `GET /admin/ops` (which the
 *                      worker process populates in Redis), polling it every few
 *                      seconds. Strictly read-only — no run/trigger controls.
 *
 * requireAdmin gates the page just like the JSON, so a non-admin gets the 403
 * rather than the shell.
 */

const GITHUB_REPO_URL = 'https://github.com/kgheacock/tickr';
const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i;

function escapeHtml(s: string): string {
  return s.replace(
    /[&<>"]/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c,
  );
}

/** The commit chip for the header: a GitHub link for a real SHA, else a dimmed
 *  label for the dev/local sentinels (mirrors admin/logs.ts). */
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

export async function registerAdminJobsRoute(
  fastify: FastifyInstance,
): Promise<void> {
  fastify.get(
    '/admin/jobs',
    { preHandler: [requireAdmin], logLevel: 'warn' },
    async (_req, reply) => {
      reply.type('text/html; charset=utf-8');
      const commit = process.env['TICKR_COMMIT'] ?? 'unknown';
      return renderJobsViewer(commit);
    },
  );
}

function renderJobsViewer(commit: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>tickr · jobs</title>
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
  header a.logs { color: #8787d7; text-decoration: none; }
  header a.logs:hover { color: #afafff; }
  header a.commit, header span.commit {
    color: #8787d7; text-decoration: none; background: #111;
    border: 1px solid #333; padding: 1px 6px; border-radius: 3px;
  }
  header a.commit:hover { border-color: #555; color: #afafff; }
  header .commit.dim { color: #767676; }
  header .status { margin-left: auto; color: #666; }
  header .status.err { color: #ff5f5f; }
  #wrap { flex: 1 1 auto; overflow-y: auto; padding: 8px 10px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 5px 10px; border-bottom: 1px solid #1a1a1a; vertical-align: top; }
  th { color: #888; font-weight: 600; position: sticky; top: 0; background: #000; border-bottom: 1px solid #333; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .job { color: #fff; }
  .desc { color: #767676; font-size: 12px; }
  .cadence { color: #8787ff; }
  .remote { color: #5f5f5f; }
  /* outcome pills */
  .pill { display: inline-block; padding: 0 7px; border-radius: 10px; font-weight: 600; font-size: 12px; }
  .pill.ok      { background: #06340f; color: #5fd75f; }
  .pill.error   { background: #3a0c0c; color: #ff6b6b; }
  .pill.never   { background: #1a1a1a; color: #767676; }
  .pill.running { background: #3a2f06; color: #ffd75f; }
  .dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; background: #ffd75f; animation: pulse 1.2s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
  .err-msg { color: #ff6b6b; white-space: pre-wrap; word-break: break-word; font-size: 12px; margin-top: 3px; }
  .fails { color: #ff6b6b; }
  .skips { color: #767676; }
  .muted { color: #5f5f5f; }
</style>
</head>
<body>
<header>
  <span class="title">tickr jobs</span>
  <a class="logs" href="/api/v1/admin/logs" title="open the log viewer">logs →</a>
  ${commitChipHtml(commit)}
  <span class="status" id="status">connecting…</span>
</header>
<div id="wrap">
  <table>
    <thead>
      <tr>
        <th>Job</th>
        <th>Cadence</th>
        <th>Status</th>
        <th>Last run</th>
        <th class="num">Duration</th>
        <th class="num">Runs</th>
        <th class="num">Fails</th>
        <th class="num">Skips</th>
      </tr>
    </thead>
    <tbody id="rows"></tbody>
  </table>
</div>
<script>
(function () {
  var rowsEl = document.getElementById('rows');
  var statusEl = document.getElementById('status');

  function fmtDur(ms) {
    if (ms == null) return '—';
    if (ms < 1000) return ms + 'ms';
    var s = ms / 1000;
    if (s < 60) return s.toFixed(s < 10 ? 1 : 0) + 's';
    if (s < 3600) return Math.round(s / 60) + 'm';
    return (s / 3600).toFixed(1) + 'h';
  }

  function fmtAgo(iso) {
    if (!iso) return '—';
    var then = Date.parse(iso);
    if (isNaN(then)) return '—';
    var sec = Math.max(0, Math.round((Date.now() - then) / 1000));
    var t;
    if (sec < 60) t = sec + 's ago';
    else if (sec < 3600) t = Math.round(sec / 60) + 'm ago';
    else if (sec < 86400) t = Math.round(sec / 3600) + 'h ago';
    else t = Math.round(sec / 86400) + 'd ago';
    return t;
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function statusCell(j) {
    var td = el('td');
    if (j.running) {
      var p = el('span', 'pill running');
      p.appendChild(el('span', 'dot'));
      p.appendChild(document.createTextNode('running'));
      td.appendChild(p);
      return td;
    }
    if (!j.lastOutcome) {
      td.appendChild(el('span', 'pill never', j.remote ? 'never run' : 'idle'));
      if (j.remote) td.appendChild(el('div', 'desc', 'remote — disabled in this env?'));
      return td;
    }
    td.appendChild(el('span', 'pill ' + j.lastOutcome, j.lastOutcome === 'ok' ? 'ok' : 'error'));
    if (j.lastOutcome === 'error' && j.lastError) {
      td.appendChild(el('div', 'err-msg', j.lastError));
    }
    return td;
  }

  function row(j) {
    var tr = el('tr');

    var jobTd = el('td');
    jobTd.appendChild(el('div', 'job', j.name));
    jobTd.appendChild(el('div', 'desc', j.description));
    tr.appendChild(jobTd);

    var cadTd = el('td');
    cadTd.appendChild(el('div', 'cadence', j.cadence));
    cadTd.appendChild(el('div', 'desc', j.cron));
    tr.appendChild(cadTd);

    tr.appendChild(statusCell(j));

    // "Last run" = when the last actual execution finished (or started, if still running).
    var when = j.running ? j.lastStartAt : j.lastFinishAt;
    tr.appendChild(el('td', when ? '' : 'muted', fmtAgo(when)));

    tr.appendChild(el('td', 'num', fmtDur(j.lastDurationMs)));
    tr.appendChild(el('td', 'num', String(j.runs)));
    tr.appendChild(el('td', 'num' + (j.fails ? ' fails' : ' muted'), String(j.fails)));
    tr.appendChild(el('td', 'num skips', String(j.skips)));
    return tr;
  }

  function render(jobs) {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < jobs.length; i++) frag.appendChild(row(jobs[i]));
    rowsEl.textContent = '';
    rowsEl.appendChild(frag);
  }

  function poll() {
    fetch('/api/v1/admin/ops', { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then(function (r) {
        if (r.status === 401 || r.status === 403) throw new Error('not authorized');
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) {
        render(d.jobs || []);
        statusEl.textContent = 'live · ' + new Date().toLocaleTimeString('en-GB', { hour12: false });
        statusEl.className = 'status';
      })
      .catch(function (err) {
        statusEl.textContent = String(err.message || err);
        statusEl.className = 'status err';
      });
  }

  poll();
  var timer = setInterval(poll, 10000);
  window.addEventListener('beforeunload', function () { clearInterval(timer); });
})();
</script>
</body>
</html>`;
}
