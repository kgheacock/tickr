/**
 * Starting team-name generator. New non-commissioner members join with no team
 * name of their own, which would otherwise fall back to the bland account
 * default ("User"). To give every manager a recognisable identity from the
 * first page-load, we mint a playful market-themed "Adjective Noun" pair (e.g.
 * "Fierce Minnows"); the manager can rename their team later.
 *
 * Purely cosmetic — members are keyed by id, not name. Kept dependency-free so
 * createLeague can call it inside its transaction.
 */
const ADJECTIVES = [
  'Fierce',
  'Bold',
  'Roaring',
  'Bullish',
  'Savvy',
  'Nimble',
  'Golden',
  'Diamond',
  'Steady',
  'Frugal',
  'Lucky',
  'Rogue',
  'Cunning',
  'Mighty',
  'Wild',
  'Daring',
  'Sly',
  'Brazen',
  'Restless',
  'Hungry',
] as const;

const NOUNS = [
  'Minnows',
  'Bulls',
  'Bears',
  'Sharks',
  'Whales',
  'Wolves',
  'Hawks',
  'Tigers',
  'Rhinos',
  'Foxes',
  'Otters',
  'Falcons',
  'Badgers',
  'Bison',
  'Lemurs',
  'Marmots',
  'Vipers',
  'Stallions',
  'Pelicans',
  'Mantis',
] as const;

const pick = <T>(arr: readonly T[]): T =>
  arr[Math.floor(Math.random() * arr.length)]!;

/**
 * Return a fresh "Adjective Noun" team name. Pass `taken` to avoid colliding
 * with names already handed out in the same league; after a few tries it falls
 * back to appending a numeric suffix so it always terminates.
 */
export function randomTeamName(taken?: ReadonlySet<string>): string {
  for (let i = 0; i < 12; i++) {
    const name = `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
    if (!taken || !taken.has(name)) return name;
  }
  let n = 2;
  let name = `${pick(ADJECTIVES)} ${pick(NOUNS)}`;
  while (taken?.has(name)) name = `${pick(ADJECTIVES)} ${pick(NOUNS)} ${n++}`;
  return name;
}
