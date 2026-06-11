import { jobLogger } from '../log/logger.js';

const log = jobLogger('universe:wikipedia');

// Wikipedia's "List of S&P 500 companies" is the live constituent source. We
// pull the raw *wikitext* (not rendered HTML) via the MediaWiki action API:
// every ticker sits in a {{NyseSymbol|X}} / {{NasdaqSymbol|X}} template, which
// is far more stable to parse than the rendered table markup and already carries
// the symbol in the dotted form Massive expects (e.g. BRK.B, BF.B).
const WIKIPEDIA_URL =
  'https://en.wikipedia.org/w/api.php' +
  '?action=parse&page=List_of_S%26P_500_companies' +
  '&prop=wikitext&format=json&formatversion=2';

// Wikipedia asks API clients to send a descriptive User-Agent identifying the
// app and a contact, or requests may be throttled/blocked.
const USER_AGENT =
  'tickr/1.0 (S&P 500 universe sync; https://tickr.keithheacock.com)';

const TIMEOUT_MS = 15_000;

// Plausibility floor — the single most important safety valve. The S&P 500 has
// ~500 members; if the page moves, the table markup changes, or the response is
// truncated, the regex yields far fewer symbols. Refusing anything under this
// floor guarantees a bad fetch can never drive a mass "departure" reconciliation
// (which would retire hundreds of live tickers). 450 leaves headroom for normal
// index size drift while still catching gross breakage.
const MIN_PLAUSIBLE_SYMBOLS = 450;

// Symbols live in {{NyseSymbol|TICKER}} or {{NasdaqSymbol|TICKER}}. Tickers are
// uppercase letters plus an optional dotted share-class suffix (BRK.B).
const SYMBOL_RE = /\{\{(?:Nyse|Nasdaq)Symbol\|([A-Z][A-Z.]*)\}\}/g;

interface ParseResponse {
  parse?: { wikitext?: string };
  error?: { info?: string };
}

export class WikipediaUniverseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WikipediaUniverseError';
  }
}

function parseSymbols(wikitext: string): string[] {
  const seen = new Set<string>();
  for (const match of wikitext.matchAll(SYMBOL_RE)) {
    seen.add(match[1]!);
  }
  return [...seen].sort();
}

/**
 * Fetch the current S&P 500 constituents from Wikipedia as dotted symbols.
 *
 * Throws WikipediaUniverseError on any failure — network, non-OK status, an
 * API-level error payload, or a result below the plausibility floor. Callers
 * MUST treat a throw as "do not reconcile departures" and fall back to the
 * bundled seed for inserts only; never retire tickers against a failed fetch.
 *
 * `fetchFn` is injectable so tests can supply fixtures without a network call.
 */
export async function fetchSp500Symbols(
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<string[]> {
  let res: Response;
  try {
    res = await fetchFn(WIKIPEDIA_URL, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    throw new WikipediaUniverseError(
      `Wikipedia fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    throw new WikipediaUniverseError(`Wikipedia HTTP ${res.status}`);
  }

  const body = (await res.json()) as ParseResponse;
  if (body.error) {
    throw new WikipediaUniverseError(
      `Wikipedia API error: ${body.error.info ?? 'unknown'}`,
    );
  }

  const wikitext = body.parse?.wikitext;
  if (!wikitext) {
    throw new WikipediaUniverseError('Wikipedia response had no wikitext');
  }

  const symbols = parseSymbols(wikitext);
  if (symbols.length < MIN_PLAUSIBLE_SYMBOLS) {
    throw new WikipediaUniverseError(
      `Parsed only ${symbols.length} symbols (< ${MIN_PLAUSIBLE_SYMBOLS}) — ` +
        'refusing to reconcile against an implausible list (page/markup likely changed)',
    );
  }

  log.info({ count: symbols.length }, 'fetched S&P 500 constituents');
  return symbols;
}
