import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { runMigrations } from '../db/migrate.js';

const PORT = Number(process.env['PORT'] ?? 3000);
const HOST = '0.0.0.0';

function handle(req: IncomingMessage, res: ServerResponse): void {
  if (req.method === 'GET' && req.url === '/api/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'not_found' }));
}

export async function runApi(): Promise<void> {
  await runMigrations();
  const server = createServer(handle);
  await new Promise<void>((resolve) => {
    server.listen(PORT, HOST, () => resolve());
  });
  console.log(`[api] listening on http://${HOST}:${PORT}`);
}
