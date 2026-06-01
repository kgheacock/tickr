import { randomUUID } from 'node:crypto';
import { Decimal } from 'decimal.js';
import { pool } from '../db/pool.js';
import { isPriceStale } from './price.js';
import { computeCostCents, computeNewAvgCost, subtractQuantity } from './money.js';
import { TradeRejectionError } from './validate.js';

export interface TradeInput {
  portfolioId: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  idempotencyKey: string;
  source: 'human' | 'algo';
}

export interface OrderRecord {
  id: string;
  portfolioId: string;
  symbol: string;
  side: 'buy' | 'sell';
  type: 'market';
  quantity: number;
  status: 'filled';
  rejectReason: null;
  idempotencyKey: string;
  source: 'human' | 'algo';
  createdAt: string;
}

export interface FillRecord {
  id: string;
  orderId: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  price: number;
  filledAt: string;
}

export interface TradeResult {
  order: OrderRecord;
  fill: FillRecord;
}

export { TradeRejectionError };

export async function executeTrade(input: TradeInput): Promise<TradeResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Lock the portfolio row — serializes all concurrent orders for this portfolio.
    const portResult = await client.query<{ cash: number; user_id: string }>(
      `SELECT cash, user_id FROM portfolio WHERE id = $1 FOR UPDATE`,
      [input.portfolioId],
    );
    if (!portResult.rows[0]) {
      throw new TradeRejectionError('VALIDATION', 'Portfolio not found');
    }
    const { cash } = portResult.rows[0];

    // Idempotency replay: if this key already produced a fill, return it.
    const existingOrder = await client.query<{
      id: string;
      portfolio_id: string;
      symbol: string;
      side: string;
      type: string;
      quantity: string;
      status: string;
      reject_reason: string | null;
      idempotency_key: string;
      source: string;
      created_at: Date;
    }>(
      `SELECT * FROM trade_order WHERE portfolio_id = $1 AND idempotency_key = $2`,
      [input.portfolioId, input.idempotencyKey],
    );
    if (existingOrder.rows[0]) {
      const ord = existingOrder.rows[0];
      const existingFill = await client.query<{
        id: string;
        order_id: string;
        symbol: string;
        side: string;
        quantity: string;
        price: number;
        filled_at: Date;
      }>(`SELECT * FROM fill WHERE order_id = $1`, [ord.id]);
      await client.query('COMMIT');
      return buildResult(ord, existingFill.rows[0]!);
    }

    // Symbol must be backfilled.
    const symResult = await client.query<{ backfilled: boolean }>(
      `SELECT backfilled FROM universe_symbol WHERE symbol = $1`,
      [input.symbol],
    );
    if (!symResult.rows[0] || !symResult.rows[0].backfilled) {
      throw new TradeRejectionError(
        'SYMBOL_NOT_TRADEABLE',
        `${input.symbol} is not in the tradeable universe`,
      );
    }

    // Latest price.
    const priceResult = await client.query<{ close: number; ts: Date }>(
      `SELECT close, ts FROM price_bar WHERE symbol = $1 ORDER BY ts DESC LIMIT 1`,
      [input.symbol],
    );
    if (!priceResult.rows[0]) {
      throw new TradeRejectionError(
        'SYMBOL_NOT_TRADEABLE',
        `No price data for ${input.symbol}`,
      );
    }
    const { close: priceCents, ts: priceTs } = priceResult.rows[0];

    if (isPriceStale(priceTs)) {
      throw new TradeRejectionError(
        'STALE_PRICE',
        `Price for ${input.symbol} is more than 5 days old`,
      );
    }

    // Cost is computed once; used for both the funds check and the debit.
    const costCents = computeCostCents(input.quantity, priceCents);

    if (input.side === 'buy') {
      if (cash < costCents) {
        throw new TradeRejectionError(
          'INSUFFICIENT_FUNDS',
          `Need ${costCents} cents, have ${cash}`,
        );
      }
    } else {
      const posResult = await client.query<{ quantity: string }>(
        `SELECT quantity FROM position WHERE portfolio_id = $1 AND symbol = $2`,
        [input.portfolioId, input.symbol],
      );
      const heldQty = new Decimal(posResult.rows[0]?.quantity ?? '0');
      const orderQty = new Decimal(input.quantity);
      if (heldQty.lessThan(orderQty)) {
        throw new TradeRejectionError(
          'INSUFFICIENT_POSITION',
          `Hold ${heldQty.toFixed(8)}, order ${orderQty.toFixed(8)}`,
        );
      }
    }

    // Writes — all in the same txn.
    const orderId = randomUUID();
    const fillId = randomUUID();
    const qtyStr = new Decimal(input.quantity).toFixed(8);

    await client.query(
      `INSERT INTO trade_order
         (id, portfolio_id, symbol, side, type, quantity, status, reject_reason, idempotency_key, source)
       VALUES ($1, $2, $3, $4, 'market', $5::numeric, 'filled', NULL, $6, $7)`,
      [
        orderId,
        input.portfolioId,
        input.symbol,
        input.side,
        qtyStr,
        input.idempotencyKey,
        input.source,
      ],
    );

    await client.query(
      `INSERT INTO fill (id, order_id, symbol, side, quantity, price)
       VALUES ($1, $2, $3, $4, $5::numeric, $6)`,
      [fillId, orderId, input.symbol, input.side, qtyStr, priceCents],
    );

    if (input.side === 'buy') {
      // Read existing position for weighted avg_cost calculation.
      const existing = await client.query<{
        quantity: string;
        avg_cost: number;
      }>(
        `SELECT quantity, avg_cost FROM position WHERE portfolio_id = $1 AND symbol = $2`,
        [input.portfolioId, input.symbol],
      );

      if (existing.rows[0]) {
        const newAvgCost = computeNewAvgCost(
          existing.rows[0].quantity,
          existing.rows[0].avg_cost,
          input.quantity,
          priceCents,
        );
        const newQty = new Decimal(existing.rows[0].quantity)
          .plus(input.quantity)
          .toFixed(8);
        await client.query(
          `UPDATE position SET quantity = $3::numeric, avg_cost = $4
           WHERE portfolio_id = $1 AND symbol = $2`,
          [input.portfolioId, input.symbol, newQty, newAvgCost],
        );
      } else {
        await client.query(
          `INSERT INTO position (portfolio_id, symbol, quantity, avg_cost)
           VALUES ($1, $2, $3::numeric, $4)`,
          [input.portfolioId, input.symbol, qtyStr, priceCents],
        );
      }

      await client.query(
        `UPDATE portfolio SET cash = cash - $2 WHERE id = $1`,
        [input.portfolioId, costCents],
      );
    } else {
      // Sell: reduce or remove position; cash += cost.
      const posResult = await client.query<{ quantity: string }>(
        `SELECT quantity FROM position WHERE portfolio_id = $1 AND symbol = $2`,
        [input.portfolioId, input.symbol],
      );
      const newQty = subtractQuantity(posResult.rows[0]!.quantity, input.quantity);
      if (newQty.isZero()) {
        await client.query(
          `DELETE FROM position WHERE portfolio_id = $1 AND symbol = $2`,
          [input.portfolioId, input.symbol],
        );
      } else {
        await client.query(
          `UPDATE position SET quantity = $3 WHERE portfolio_id = $1 AND symbol = $2`,
          [input.portfolioId, input.symbol, newQty.toFixed(8)],
        );
      }
      await client.query(
        `UPDATE portfolio SET cash = cash + $2 WHERE id = $1`,
        [input.portfolioId, costCents],
      );
    }

    const orderRow = await client.query<{
      id: string;
      portfolio_id: string;
      symbol: string;
      side: string;
      type: string;
      quantity: string;
      status: string;
      reject_reason: string | null;
      idempotency_key: string;
      source: string;
      created_at: Date;
    }>(`SELECT * FROM trade_order WHERE id = $1`, [orderId]);

    const fillRow = await client.query<{
      id: string;
      order_id: string;
      symbol: string;
      side: string;
      quantity: string;
      price: number;
      filled_at: Date;
    }>(`SELECT * FROM fill WHERE id = $1`, [fillId]);

    await client.query('COMMIT');
    return buildResult(orderRow.rows[0]!, fillRow.rows[0]!);
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

function buildResult(
  ord: {
    id: string;
    portfolio_id: string;
    symbol: string;
    side: string;
    type: string;
    quantity: string;
    status: string;
    reject_reason: string | null;
    idempotency_key: string;
    source: string;
    created_at: Date;
  },
  fill: {
    id: string;
    order_id: string;
    symbol: string;
    side: string;
    quantity: string;
    price: number;
    filled_at: Date;
  },
): TradeResult {
  return {
    order: {
      id: ord.id,
      portfolioId: ord.portfolio_id,
      symbol: ord.symbol,
      side: ord.side as 'buy' | 'sell',
      type: 'market',
      quantity: parseFloat(ord.quantity),
      status: 'filled',
      rejectReason: null,
      idempotencyKey: ord.idempotency_key,
      source: ord.source as 'human' | 'algo',
      createdAt: ord.created_at.toISOString(),
    },
    fill: {
      id: fill.id,
      orderId: fill.order_id,
      symbol: fill.symbol,
      side: fill.side as 'buy' | 'sell',
      quantity: parseFloat(fill.quantity),
      price: fill.price,
      filledAt: fill.filled_at.toISOString(),
    },
  };
}
