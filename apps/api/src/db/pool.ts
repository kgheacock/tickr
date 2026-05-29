import pg from 'pg';

// OID 20 = int8 (BIGINT). Default: returned as string. Override to number so
// cent values are usable without parseInt(). Safe because MAX_SAFE_INTEGER >>
// any realistic dollar amount in cents (see types.ts).
pg.types.setTypeParser(20, Number);

export const pool = new pg.Pool({
  connectionString: process.env['DATABASE_URL'],
  max: 10,
});
