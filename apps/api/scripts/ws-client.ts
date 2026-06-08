/**
 * Minimal reference WS client for the platform live spine (item 16).
 *
 * Authenticates with an existing session cookie, opens `/ws`, subscribes to the
 * `universe` and `prices` topics, and logs every `WsServerMessage` to the
 * console. This is the only client deliverable in item 16 — it proves the spine
 * end-to-end. Rendering is item 18 / item 11.
 *
 * Usage:
 *   TICKR_SID=<session-token> \
 *   WS_URL=ws://localhost:3000/ws \
 *   SYMBOLS=AAPL,MSFT \
 *   tsx apps/api/scripts/ws-client.ts
 *
 * Get a session token by completing the SSO login flow in a browser and copying
 * the `tickr_sid` cookie value.
 */
import { WebSocket } from 'ws';
import type { WsClientMessage, WsServerMessage } from '@tickr/shared-types';

const WS_URL = process.env['WS_URL'] ?? 'ws://localhost:3000/ws';
const TICKR_SID = process.env['TICKR_SID'];
const SYMBOLS = (process.env['SYMBOLS'] ?? 'AAPL,MSFT')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

if (!TICKR_SID) {
  console.error(
    'Set TICKR_SID to a valid session token (the tickr_sid cookie).',
  );
  process.exit(1);
}

const ws = new WebSocket(WS_URL, {
  headers: { Cookie: `tickr_sid=${TICKR_SID}` },
});

function send(msg: WsClientMessage): void {
  ws.send(JSON.stringify(msg));
}

ws.on('open', () => {
  console.log(`[ws-client] connected to ${WS_URL}`);
  send({ type: 'subscribe', topic: { kind: 'universe' } });
  send({ type: 'subscribe', topic: { kind: 'prices', symbols: SYMBOLS } });
  console.log(`[ws-client] subscribed: universe, prices=${SYMBOLS.join(',')}`);
});

ws.on('message', (data: Buffer) => {
  let msg: WsServerMessage;
  try {
    msg = JSON.parse(data.toString()) as WsServerMessage;
  } catch {
    console.log('[ws-client] non-JSON message:', data.toString());
    return;
  }
  console.log('[ws-client] message:', JSON.stringify(msg, null, 2));
});

ws.on('close', (code) => {
  console.log(`[ws-client] closed (${code})`);
  process.exit(0);
});

ws.on('error', (err) => {
  console.error('[ws-client] error:', err);
  process.exit(1);
});
