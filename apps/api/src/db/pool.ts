import pg from 'pg';

// OID 20 = int8 (BIGINT). Default: returned as string. Override to number so
// cent values are usable without parseInt(). Safe because MAX_SAFE_INTEGER >>
// any realistic dollar amount in cents (see types.ts).
pg.types.setTypeParser(20, Number);

let _pool: pg.Pool | undefined;

function getPool(): pg.Pool {
  if (!_pool) {
    _pool = new pg.Pool({
      connectionString: process.env['DATABASE_URL'],
      max: 10,
    });
  }
  return _pool;
}

// Proxy so all callers can keep using `pool.query(...)` / `pool.connect()` unchanged.
export const pool = new Proxy({} as pg.Pool, {
  get(_target, prop: string | symbol) {
    const p = getPool();
    const val = (p as unknown as Record<string | symbol, unknown>)[prop];
    return typeof val === 'function' ? val.bind(p) : val;
  },
});

export async function closePool(): Promise<void> {
  if (_pool) {
    await _pool.end();
    _pool = undefined;
  }
}
