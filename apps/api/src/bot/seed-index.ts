import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import type { Redis } from 'ioredis';
import { pool } from '../db/pool.js';
import { latestPrice, isPriceStale } from '../trading/price.js';
import { executeTrade } from '../trading/execute.js';

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000001';
const STARTING_CASH = 100_000_000;
const LOCK_KEY = 'bot:seed-index:lock';
const LOCK_TTL_SEC = 600;

function log(level: 'info' | 'warn', msg: string, extra?: object): void {
  console[level](
    JSON.stringify({ level, component: 'seed-index', msg, ...extra }),
  );
}

export async function seedIndexBot(redis: Redis): Promise<void> {
  // Distributed lock — prevents two bot containers from racing on startup.
  const lock = await redis.set(LOCK_KEY, '1', 'EX', LOCK_TTL_SEC, 'NX');
  if (lock !== 'OK') {
    log('info', 'lock held by another instance, skipping');
    return;
  }
  try {
    await _seed();
  } finally {
    await redis.del(LOCK_KEY);
  }
}

async function _seed(): Promise<void> {
  // Idempotency guard: algo "index" exists and has at least one fill.
  const { rows: existRows } = await pool.query<{ fill_count: string }>(
    `SELECT COUNT(f.id)::text AS fill_count
     FROM algo a
     JOIN portfolio p ON p.algo_id = a.id
     JOIN trade_order o ON o.portfolio_id = p.id
     JOIN fill f ON f.order_id = o.id
     WHERE a.name = 'index' AND a.kind = 'house'`,
  );
  if (Number(existRows[0]?.fill_count ?? 0) > 0) {
    log('info', 'already seeded');
    return;
  }

  // Wait for full backfill before seeding.
  const { rows: pending } = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM universe_symbol WHERE backfilled = false`,
  );
  if (Number(pending[0]?.cnt ?? 1) > 0) {
    log('info', 'backfill incomplete — deferring until next startup');
    return;
  }

  const { rows: symbols } = await pool.query<{ symbol: string }>(
    `SELECT symbol FROM universe_symbol WHERE backfilled = true ORDER BY symbol`,
  );
  const N = symbols.length;
  if (N === 0) {
    log('warn', 'no backfilled symbols, skipping');
    return;
  }

  const perSymbolBudget = Math.floor(STARTING_CASH / N);
  log('info', 'seeding', { symbols: N, perSymbolBudget });

  // Create algo + portfolio (idempotent via unique constraints if re-run
  // before fills exist — rely on the fill-count guard above for the normal path).
  const algoId = randomUUID();
  await pool.query(
    `INSERT INTO algo (id, owner_user_id, kind, name, strategy_type, config)
     VALUES ($1, $2, 'house', 'index', 'buy_and_hold', '{"weighting":"equal"}')`,
    [algoId, SYSTEM_USER_ID],
  );

  const portfolioId = randomUUID();
  await pool.query(
    `INSERT INTO portfolio (id, user_id, algo_id, cash) VALUES ($1, $2, $3, $4)`,
    [portfolioId, SYSTEM_USER_ID, algoId, STARTING_CASH],
  );

  let seeded = 0;
  let skipped = 0;

  for (const { symbol } of symbols) {
    const price = await latestPrice(symbol);
    if (!price || isPriceStale(price.ts)) {
      log('warn', 'no usable price', { symbol });
      skipped++;
      continue;
    }

    // qty = floor(budget / price) to 8 decimal places; skip if < 0.00000001.
    const qty = new Decimal(perSymbolBudget)
      .dividedBy(price.price)
      .toDecimalPlaces(8, Decimal.ROUND_DOWN);

    if (qty.lessThanOrEqualTo(0)) {
      log('warn', 'price exceeds budget', { symbol, price: price.price });
      skipped++;
      continue;
    }

    try {
      await executeTrade({
        portfolioId,
        symbol,
        side: 'buy',
        quantity: qty.toNumber(),
        idempotencyKey: `index-seed:${symbol}`,
        source: 'algo',
      });
      seeded++;
    } catch (err) {
      log('warn', 'trade failed', {
        symbol,
        err: err instanceof Error ? err.message : String(err),
      });
      skipped++;
    }
  }

  log('info', 'done', { seeded, skipped, total: N });
}
