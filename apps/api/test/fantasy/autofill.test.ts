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
): OwnedEntry {
  return { symbol, groups, ret3m };
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

  it('fills Defense from any owned stock, picking the most-negative return', () => {
    // Plain long holdings — the slot defines the basis, so any can be shorted
    // into Defense. The worst performer is the best short (it scores the inverse).
    const fills = chooseAutofill(
      [{ slot: 'defense', slotIndex: 0 }],
      [owned('AAA', [], -2), owned('BBB', [], -8), owned('CCC', [], 1)],
    );
    expect(fills[0]!.symbol).toBe('BBB');
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

  it('fills Defense from any stock; long slots still need the classification', () => {
    const fills = chooseAutofill(
      [
        { slot: 'defense', slotIndex: 0 },
        { slot: 'anchor', slotIndex: 0 },
      ],
      [
        owned('X1', ['anchor'], 5), // fits the anchor long slot
        owned('X2', [], -5), // no classification — long-ineligible here
      ],
    );
    const bySlot = new Map(fills.map((f) => [f.slot, f]));
    // anchor is the scarce slot (only X1 fits) → X1 long; X2 falls to Defense,
    // converted to a short by the slot.
    expect(bySlot.get('anchor')!.symbol).toBe('X1');
    expect(bySlot.get('anchor')!.isShort).toBe(false);
    expect(bySlot.get('defense')!.symbol).toBe('X2');
    expect(bySlot.get('defense')!.isShort).toBe(true);
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
