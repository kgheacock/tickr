import { describe, it, expect } from 'vitest';
import {
  fetchSp500Symbols,
  WikipediaUniverseError,
} from '../../src/universe/wikipedia.js';

// Build a wikitext blob with `count` synthetic NyseSymbol templates plus any
// extra raw symbols, so we can exercise the parser and the plausibility floor.
function makeWikitext(count: number, extras: string[] = []): string {
  const tickers: string[] = [];
  for (let i = 0; i < count; i++) {
    const a = String.fromCharCode(65 + Math.floor(i / 26));
    const b = String.fromCharCode(65 + (i % 26));
    tickers.push(a + b + 'X'); // e.g. AAX, ABX … always 3 letters, unique
  }
  const all = [...tickers, ...extras];
  return (
    'some preamble {| class="wikitable"\n' +
    all.map((t) => `|-\n|{{NyseSymbol|${t}}}\n|[[Some Co]]`).join('\n')
  );
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function fakeFetch(res: Response | (() => Promise<never>)): typeof fetch {
  return (() =>
    typeof res === 'function'
      ? res()
      : Promise.resolve(res)) as unknown as typeof fetch;
}

describe('fetchSp500Symbols', () => {
  it('parses dotted symbols, dedupes, and sorts', async () => {
    const wikitext =
      makeWikitext(460, ['BRK.B']) +
      '\n|-\n|{{NasdaqSymbol|AAPL}}' +
      '\n|-\n|{{NyseSymbol|BRK.B}}'; // duplicate BRK.B
    const symbols = await fetchSp500Symbols(
      fakeFetch(jsonResponse({ parse: { wikitext } })),
    );

    expect(symbols).toContain('BRK.B');
    expect(symbols).toContain('AAPL');
    // dotted share class preserved, not normalized to a dash
    expect(symbols).not.toContain('BRK-B');
    // deduped despite appearing twice
    expect(symbols.filter((s) => s === 'BRK.B')).toHaveLength(1);
    // sorted ascending
    expect([...symbols]).toEqual([...symbols].sort());
  });

  it('throws below the plausibility floor (truncated/changed page)', async () => {
    const wikitext = makeWikitext(10);
    await expect(
      fetchSp500Symbols(fakeFetch(jsonResponse({ parse: { wikitext } }))),
    ).rejects.toBeInstanceOf(WikipediaUniverseError);
  });

  it('throws on a non-OK HTTP status', async () => {
    await expect(
      fetchSp500Symbols(fakeFetch(jsonResponse({}, 503))),
    ).rejects.toBeInstanceOf(WikipediaUniverseError);
  });

  it('throws on an API-level error payload', async () => {
    await expect(
      fetchSp500Symbols(
        fakeFetch(jsonResponse({ error: { info: 'no such page' } })),
      ),
    ).rejects.toBeInstanceOf(WikipediaUniverseError);
  });

  it('throws when the fetch itself rejects', async () => {
    await expect(
      fetchSp500Symbols(fakeFetch(() => Promise.reject(new Error('offline')))),
    ).rejects.toBeInstanceOf(WikipediaUniverseError);
  });
});
