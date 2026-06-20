/**
 * Fantasy points formatting. Points are r (long) / −r (short), already
 * rounded to 2 dp server-side; we render them with an explicit sign and a fixed
 * scale so the scoreboard reads consistently. Percent returns get the same
 * treatment.
 *
 * The sign is the single source of gain/loss meaning — every figure carries
 * one, so the convention reads the same in colour, in monochrome, and to a
 * screen reader (it announces "minus …"). Colour, applied by `<SignedNumber>`,
 * only reinforces it. Negatives use a true minus (U+2212), not a hyphen, so the
 * sign aligns under the digits in the tabular serif columns. Zero is neutral:
 * no sign, no colour.
 */

/** Gain/loss/flat bucket for a figure, rounded to the 2 dp we display so the
 *  colour always matches the rendered value (e.g. −0.004 shows "0.00", flat). */
export type FigureSign = 'pos' | 'neg' | 'flat';

export function signOf(value: number | null | undefined): FigureSign {
  if (value == null) return 'flat';
  const v = Math.round(value * 100) / 100;
  if (v > 0) return 'pos';
  if (v < 0) return 'neg';
  return 'flat';
}

function signGlyph(v: number): string {
  if (v > 0) return '+';
  if (v < 0) return '−'; // U+2212 MINUS SIGN
  return '';
}

export function fmtPoints(points: number | null | undefined): string {
  if (points == null) return '—';
  const v = Math.round(points * 100) / 100;
  return `${signGlyph(v)}${Math.abs(v).toFixed(2)}`;
}

export function fmtPercent(pct: number | null | undefined): string {
  if (pct == null) return '—';
  const v = Math.round(pct * 100) / 100;
  return `${signGlyph(v)}${Math.abs(v).toFixed(2)}%`;
}
