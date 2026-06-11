import { describe, it, expect } from 'vitest';
import type { RosterConfig } from '@tickr/shared-types';
import {
  chooseAutofill,
  mandatorySlots,
  type OwnedEntry,
  type SlotRef,
} from '../../src/fantasy/autofill.js';

function owned(
  symbol: string,
  groups: string[],
  ret3m: number | null,
  isShort = false,
): OwnedEntry {
  return { symbol, isShort, groups, ret3m };
}

describe('mandatorySlots', () => {
  it('expands duplicate slots into indexed positions, lower-cased', () => {
    const cfg: RosterConfig = {
      slots: ['Anchor', 'Anchor', 'Defense', 'Wildcard'],
      bench: 2,
    };
    expect(mandatorySlots(cfg)).toEqual<SlotRef[]>([
      { slot: 'anchor', slotIndex: 0 },
      { slot: 'anchor', slotIndex: 1 },
      { slot: 'defense', slotIndex: 0 },
      { slot: 'wildcard', slotIndex: 0 },
    ]);
  });
});

describe('chooseAutofill', () => {
  const empty: SlotRef[] = [
    { slot: 'anchor', slotIndex: 0 },
    { slot: 'growth', slotIndex: 0 },
  ];

  it('picks the highest 3-month return for a long slot', () => {
    const fills = chooseAutofill(
      [{ slot: 'anchor', slotIndex: 0 }],
      [
        owned('AAA', ['anchor'], 3),
        owned('BBB', ['anchor'], 9),
        owned('CCC', ['anchor'], 5),
      ],
    );
    expect(fills).toEqual([
      { slot: 'anchor', slotIndex: 0, symbol: 'BBB', isShort: false },
    ]);
  });

  it('picks the most-negative return for the Defense short', () => {
    const fills = chooseAutofill(
      [{ slot: 'defense', slotIndex: 0 }],
      [
        owned('SHORTA', [], -2, true),
        owned('SHORTB', [], -8, true),
        owned('SHORTC', [], 1, true),
      ],
    );
    // The worst performer is the best short (Defense scores the inverse).
    expect(fills[0]!.symbol).toBe('SHORTB');
    expect(fills[0]!.isShort).toBe(true);
  });

  it('never starts the same symbol in two slots', () => {
    // One stock eligible for both slots, plus a single-slot filler each.
    const fills = chooseAutofill(empty, [
      owned('DUAL', ['anchor', 'growth'], 9),
      owned('ANCH', ['anchor'], 1),
      owned('GROW', ['growth'], 1),
    ]);
    const symbols = fills.map((f) => f.symbol);
    expect(new Set(symbols).size).toBe(symbols.length);
    expect(fills).toHaveLength(2);
  });

  it('fills the scarce slot first so it is not stranded', () => {
    // DUAL fits both; GROW only growth. Greedy-by-need must keep DUAL for the
    // scarce anchor and leave growth for GROW — both slots filled.
    const fills = chooseAutofill(empty, [
      owned('DUAL', ['anchor', 'growth'], 9),
      owned('GROW', ['growth'], 1),
    ]);
    const bySlot = new Map(fills.map((f) => [f.slot, f.symbol]));
    expect(bySlot.get('anchor')).toBe('DUAL');
    expect(bySlot.get('growth')).toBe('GROW');
  });

  it('respects short/long: a long cannot fill Defense and a short cannot fill a long slot', () => {
    const fills = chooseAutofill(
      [
        { slot: 'defense', slotIndex: 0 },
        { slot: 'anchor', slotIndex: 0 },
      ],
      [
        owned('LONG', ['anchor'], 5), // long — only anchor
        owned('SHORT', [], -5, true), // short — only defense
      ],
    );
    const bySlot = new Map(fills.map((f) => [f.slot, f]));
    expect(bySlot.get('defense')!.symbol).toBe('SHORT');
    expect(bySlot.get('anchor')!.symbol).toBe('LONG');
  });

  it('treats Wildcard as universal for any long', () => {
    const fills = chooseAutofill(
      [{ slot: 'wildcard', slotIndex: 0 }],
      [owned('NOGROUP', [], 4)],
    );
    expect(fills[0]!.symbol).toBe('NOGROUP');
  });

  it('leaves a slot empty when nothing eligible remains', () => {
    const fills = chooseAutofill(
      [
        { slot: 'anchor', slotIndex: 0 },
        { slot: 'value', slotIndex: 0 },
      ],
      [owned('ONLYANCHOR', ['anchor'], 5)],
    );
    expect(fills).toHaveLength(1);
    expect(fills[0]!.slot).toBe('anchor');
  });

  it('does not reuse a symbol already started (alreadyUsed)', () => {
    const fills = chooseAutofill(
      [{ slot: 'growth', slotIndex: 0 }],
      [owned('GROW', ['growth'], 5)],
      new Set(['GROW']),
    );
    expect(fills).toHaveLength(0);
  });
});
