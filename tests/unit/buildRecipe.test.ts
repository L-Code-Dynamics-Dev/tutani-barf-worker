/**
 * Recept z konkrétních produktů v nákupu (Lucky 2026-09-24: „přesný
 * recept, jak psíkovi připravit jeho menu").
 */

import { describe, expect, it } from 'vitest';
import { buildRecipe, portionLabels, splitInteger } from '../../src/engine/recipe/buildRecipe.js';
import type { CompositionItem } from '../../src/engine/feeding-calculator/calculateDose.js';
import type { MatchedProduct, MatchResult } from '../../src/engine/product-matching/matchProducts.js';

const COMP: CompositionItem[] = [
    { group: 'MUSCLE', labelCs: 'svalové maso', grams: 254, pct: 75, adjusted: false },
    { group: 'BONE', labelCs: 'mleté kosti', grams: 34, pct: 10, adjusted: false },
    { group: 'LIVER', labelCs: 'játra', grams: 17, pct: 5, adjusted: false },
    { group: 'ORGAN', labelCs: 'ostatní orgány', grams: 17, pct: 5, adjusted: false },
    { group: 'PLANT', labelCs: 'zelenina a ovoce', grams: 17, pct: 5, adjusted: false },
];

function mp(over: Partial<MatchedProduct>): MatchedProduct {
    return {
        sku: 'X', name: 'X', url: 'u', group: 'MUSCLE', packGrams: 1000, packs: 1,
        unitPriceCzk: 100, totalPriceCzk: 100, productId: '1', priceId: '2',
        coversGrams: 1000, stockQuantity: 10, fillsShortage: false, ...over,
    };
}

function match(products: MatchedProduct[], uncovered: MatchResult['uncovered'] = []): MatchResult {
    return { periodDays: 30, products, uncovered, excluded: [], totalPriceCzk: 0 };
}

const STEPS = { stepsCs: ['krok'] };

describe('splitInteger', () => {
    it('součet je vždy přesně celek', () => {
        for (const [t, w] of [[254, [2, 1]], [17, [1, 1, 1]], [1, [5, 5]], [0, [1, 2]], [1000, [0.3, 0.3, 0.4]]] as const) {
            expect(splitInteger(t, w).reduce((a, b) => a + b, 0)).toBe(t);
        }
    });
    it('dělí v poměru vah', () => {
        expect(splitInteger(300, [2, 1])).toEqual([200, 100]);
    });
    it('nulové váhy → rovným dílem, nic se neztratí', () => {
        expect(splitInteger(10, [0, 0])).toEqual([5, 5]);
    });
    it('záporný celek odmítne', () => {
        expect(() => splitInteger(-1, [1])).toThrow(RangeError);
    });
});

describe('buildRecipe', () => {
    const full = match([
        mp({ sku: 'KURE', name: 'Kuře 3kg', group: 'MUSCLE', packGrams: 3000, packs: 2, coversGrams: 6000 }),
        mp({ sku: 'KRUTA', name: 'Krůta 1kg', group: 'MUSCLE', packs: 2, coversGrams: 2000 }),
        mp({ sku: 'KOST', name: 'Kosti 1kg', group: 'BONE', packs: 2, coversGrams: 1020 }),
        mp({ sku: 'JATRA', name: 'Játra 1kg', group: 'LIVER', coversGrams: 510 }),
        mp({ sku: 'PLICE', name: 'Plíce 1kg', group: 'ORGAN', coversGrams: 510 }),
        mp({ sku: 'MRKEV', name: 'Mrkev 500g', group: 'PLANT', packGrams: 500, packs: 2, coversGrams: 510 }),
    ]);

    it('denní součet = dávka enginu na gram přesně', () => {
        const r = buildRecipe(COMP, full, 2, STEPS);
        expect(r.dailyTotalGrams).toBe(254 + 34 + 17 + 17 + 17);
        expect(r.missing).toEqual([]);
    });

    it('svalovina se dělí mezi produkty podle toho, kolik jí v nákupu pokrývají', () => {
        const r = buildRecipe(COMP, full, 2, STEPS);
        const kure = r.daily.find((d) => d.sku === 'KURE')!.grams;
        const kruta = r.daily.find((d) => d.sku === 'KRUTA')!.grams;
        expect(kure + kruta).toBe(254);
        expect(kure).toBe(191); // 254 × 6000/8000 = 190,5 → největší zbytek
        expect(kruta).toBe(63);
    });

    it('porce sečtené dávají denní gramy každé suroviny', () => {
        for (const n of [1, 2, 3, 4]) {
            const r = buildRecipe(COMP, full, n, STEPS);
            expect(r.portions).toHaveLength(n);
            for (const d of r.daily) {
                const sum = r.portions.reduce(
                    (a, p) => a + p.ingredients.filter((i) => i.sku === d.sku).reduce((x, i) => x + i.grams, 0), 0);
                expect(sum).toBe(d.grams);
            }
            const porceCelkem = r.portions.reduce((a, p) => a + p.totalGrams, 0);
            expect(porceCelkem).toBe(r.dailyTotalGrams);
        }
    });

    it('porce jsou vyrovnané (rozdíl max. počet surovin gramů)', () => {
        const r = buildRecipe(COMP, full, 3, STEPS);
        const t = r.portions.map((p) => p.totalGrams);
        expect(Math.max(...t) - Math.min(...t)).toBeLessThanOrEqual(r.daily.length);
    });

    it('balení: na kolik dní vystačí jedno', () => {
        const r = buildRecipe(COMP, full, 2, STEPS);
        const kure = r.packs.find((p) => p.sku === 'KURE')!;
        expect(kure.daysPerPack).toBe(Math.floor(3000 / kure.gramsPerDay));
        expect(r.packs.find((p) => p.sku === 'MRKEV')!.daysPerPack).toBe(29); // 500 / 17
    });

    it('nepokrytá složka se přizná, nenahradí se ničím', () => {
        const bezJater = match(full.products.filter((p) => p.group !== 'LIVER'), [
            { group: 'LIVER', labelCs: 'játra', gramsPerDay: 17, reason: 'OUT_OF_STOCK', filteredOut: 3 },
        ]);
        const r = buildRecipe(COMP, bezJater, 2, STEPS);
        expect(r.missing).toEqual([{ group: 'LIVER', labelCs: 'játra', gramsPerDay: 17 }]);
        expect(r.daily.some((d) => d.group === 'LIVER')).toBe(false);
        expect(r.dailyTotalGrams).toBe(254 + 34 + 17 + 17);
    });

    it('sklad jen na část období: denní gramy zůstanou, chybějící se přizná', () => {
        const m = match(full.products, [
            { group: 'BONE', labelCs: 'mleté kosti', gramsPerDay: 34, reason: 'INSUFFICIENT_STOCK', filteredOut: 0, missingGrams: 500 },
        ]);
        const r = buildRecipe(COMP, m, 2, STEPS);
        expect(r.daily.find((d) => d.group === 'BONE')!.grams).toBe(34);
        expect(r.missing.map((x) => x.group)).toEqual(['BONE']);
    });

    it('postup přípravy je z konfigurace tenanta', () => {
        expect(buildRecipe(COMP, full, 2, { stepsCs: ['a', 'b'] }).stepsCs).toEqual(['a', 'b']);
    });

    it('neplatný počet porcí odmítne', () => {
        expect(() => buildRecipe(COMP, full, 0, STEPS)).toThrow(RangeError);
    });

    it('názvy porcí', () => {
        expect(portionLabels(2)).toEqual(['ráno', 'večer']);
        expect(portionLabels(5)).toHaveLength(5);
    });
});
