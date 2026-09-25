/**
 * Výběr produktů podle AKTUÁLNÍHO SKLADU, rovnocenné náhrady a rotace.
 *
 * Zadání Lucky 2026-09-24: „Měli bychom absolutně vždycky umět pracovat
 * s aktuální skladovostí a momentální zásobou … když bude místo klokana
 * úplně stejně složením krůtí maso, tak tam dáme krůtí … aby se pořád
 * netočilo pár produktů a ostatní se neprodávaly." + „aby to pokrylo ten
 * balíček na X dní pro toho pejska."
 */

import { describe, expect, it } from 'vitest';
import { matchProducts, type CatalogProduct } from '../../src/engine/product-matching/matchProducts.js';
import type { CompositionItem } from '../../src/engine/feeding-calculator/calculateDose.js';
import type { ResolvedConstraints } from '../../src/domain/health/Condition.js';

function constraints(over: Partial<ResolvedConstraints> = {}): ResolvedConstraints {
    return {
        useIdealWeight: false,
        compositionLimits: [],
        excludedIngredientIds: new Set(),
        preferredIngredientIds: new Set(),
        productAttrFilters: [],
        warnings: [],
        blocked: false,
        blockedBy: [],
        requiresVet: false,
        ...over,
    };
}

function prod(over: Partial<CatalogProduct> = {}): CatalogProduct {
    return {
        sku: 'P1',
        name: 'Produkt',
        url: 'u',
        priceCzk: 200,
        packGrams: 1000,
        group: 'MUSCLE',
        inStock: true,
        productId: '1',
        priceId: '10',
        ingredientIds: ['hovezi'],
        isCooked: false,
        stockQuantity: 50,
        ...over,
    };
}

/** 400 g/den × 30 dní = 12 000 g = 12 balení po 1 kg. */
const MUSCLE: CompositionItem[] = [{ group: 'MUSCLE', labelCs: 'svalové maso', grams: 400, pct: 75, adjusted: false }];

const totalGrams = (r: ReturnType<typeof matchProducts>) =>
    r.products.reduce((a, p) => a + p.packs * p.packGrams, 0);

describe('sklad: balíček na X dní v rámci momentální zásoby', () => {
    it('nikdy víc balení, než je skladem', () => {
        const r = matchProducts(MUSCLE, [prod({ sku: 'KLOKAN', stockQuantity: 3 })], constraints(), 30);
        expect(r.products[0].packs).toBe(3);
    });

    it('klokan dojde → doplní se rovnocenná krůtí svalovina a balíček se pokryje celý', () => {
        const catalog = [
            prod({ sku: 'KLOKAN', stockQuantity: 3, ingredientIds: ['klokan'] }),
            prod({ sku: 'KRUTI', stockQuantity: 40, ingredientIds: ['kruta'], priceCzk: 205 }),
        ];
        const r = matchProducts(MUSCLE, catalog, constraints(), 30);
        expect(totalGrams(r)).toBeGreaterThanOrEqual(12_000);
        expect(r.uncovered).toEqual([]);
        for (const p of r.products) expect(p.packs).toBeLessThanOrEqual(p.stockQuantity!);
    });

    it('když jeden produkt pokryje celé období sám, nedělí se na víc sáčků', () => {
        const catalog = [
            prod({ sku: 'MALO', stockQuantity: 2 }),
            prod({ sku: 'DOST', stockQuantity: 30 }),
        ];
        for (let d = 0; d < 20; d++) {
            const r = matchProducts(MUSCLE, catalog, constraints(), 30, { seed: `pes-${d}` });
            expect(r.products.map((p) => p.sku)).toEqual(['DOST']);
        }
    });

    it('celkový sklad nestačí → přizná INSUFFICIENT_STOCK s chybějícími gramy', () => {
        const catalog = [prod({ sku: 'A', stockQuantity: 4 }), prod({ sku: 'B', stockQuantity: 3 })];
        const r = matchProducts(MUSCLE, catalog, constraints(), 30);
        expect(totalGrams(r)).toBe(7000);
        expect(r.uncovered).toEqual([
            expect.objectContaining({ group: 'MUSCLE', reason: 'INSUFFICIENT_STOCK', missingGrams: 5000 }),
        ]);
    });

    it('zásoba 0 vyřadí produkt, i když noční příznak tvrdí „skladem"', () => {
        const r = matchProducts(MUSCLE, [prod({ sku: 'X', inStock: true, stockQuantity: 0 })], constraints(), 30);
        expect(r.products).toEqual([]);
        expect(r.uncovered[0].reason).toBe('OUT_OF_STOCK');
    });

    it('neznámá zásoba (null) se chová postaru — neomezuje počet balení', () => {
        const r = matchProducts(MUSCLE, [prod({ stockQuantity: null })], constraints(), 30);
        expect(r.products[0].packs).toBe(12);
    });

    it('doplňující produkt je označený fillsShortage', () => {
        const catalog = [prod({ sku: 'A', stockQuantity: 5 }), prod({ sku: 'B', stockQuantity: 5, priceCzk: 201 })];
        const r = matchProducts(MUSCLE, catalog, constraints(), 30, { seed: 's' });
        expect(r.products).toHaveLength(2);
        expect(r.products[0].fillsShortage).toBe(false);
        expect(r.products.slice(1).every((p) => p.fillsShortage)).toBe(true);
    });
});

describe('rovnocenná náhrada', () => {
    it('čistá svalovina se nenahrazuje směsí s droby, dokud je čisté dost', () => {
        const catalog = [
            prod({ sku: 'CISTA', stockQuantity: 50, priceCzk: 220 }),
            prod({
                sku: 'SMES', stockQuantity: 50, priceCzk: 150,
                compositionParts: [{ group: 'MUSCLE', pct: 70 }, { group: 'ORGAN', pct: 30 }],
            }),
        ];
        for (let d = 0; d < 20; d++) {
            const r = matchProducts(MUSCLE, catalog, constraints(), 30, { seed: `d${d}` });
            expect(r.products.map((p) => p.sku)).toEqual(['CISTA']);
        }
    });

    it('směs se použije až když čistá nestačí', () => {
        const catalog = [
            prod({ sku: 'CISTA', stockQuantity: 4 }),
            prod({ sku: 'SMES', stockQuantity: 50, compositionParts: [{ group: 'MUSCLE', pct: 70 }, { group: 'ORGAN', pct: 30 }] }),
        ];
        const r = matchProducts(MUSCLE, catalog, constraints(), 30);
        expect(r.products.map((p) => [p.sku, p.packs])).toEqual([['CISTA', 4], ['SMES', 8]]);
    });

    it('náhrada podléhá alergii stejně jako první volba', () => {
        const catalog = [
            prod({ sku: 'KLOKAN', stockQuantity: 3, ingredientIds: ['klokan'] }),
            prod({ sku: 'KRUTI', stockQuantity: 40, ingredientIds: ['kruta'] }),
        ];
        const r = matchProducts(MUSCLE, catalog, constraints({ excludedIngredientIds: new Set(['kruta']) }), 30);
        expect(r.products.map((p) => p.sku)).toEqual(['KLOKAN']);
        expect(r.uncovered[0].reason).toBe('INSUFFICIENT_STOCK');
    });
});

describe('rotace: prodej se rozkládá po sortimentu', () => {
    const PASMO = [
        prod({ sku: 'HOVEZI', priceCzk: 200, stockQuantity: 40 }),
        prod({ sku: 'KRUTI', priceCzk: 210, stockQuantity: 40 }),
        prod({ sku: 'KRALIK', priceCzk: 225, stockQuantity: 40 }),
    ];
    const DRAHY = prod({ sku: 'DRAHY', priceCzk: 300, stockQuantity: 40 }); // +50 % = mimo pásmo

    it('různí psi dostávají různé produkty z cenového pásma (+15 %)', () => {
        const counts = new Map<string, number>();
        for (let d = 0; d < 300; d++) {
            const r = matchProducts(MUSCLE, [...PASMO, DRAHY], constraints(), 30, { seed: `pes-${d}` });
            const sku = r.products[0].sku;
            counts.set(sku, (counts.get(sku) ?? 0) + 1);
        }
        // Každý produkt z pásma dostane rozumný podíl, nikdo nemonopolizuje.
        for (const sku of ['HOVEZI', 'KRUTI', 'KRALIK']) {
            expect(counts.get(sku) ?? 0).toBeGreaterThan(50);
        }
        // Produkt o 50 % dražší se nedoporučí, dokud má pásmo zásobu.
        expect(counts.get('DRAHY') ?? 0).toBe(0);
    });

    it('víc kusů skladem = častější doporučení', () => {
        const catalog = [
            prod({ sku: 'PLNY_SKLAD', stockQuantity: 200 }),
            prod({ sku: 'SKORO_PRAZDNY', stockQuantity: 12 }),
        ];
        let plny = 0;
        for (let d = 0; d < 300; d++) {
            if (matchProducts(MUSCLE, catalog, constraints(), 30, { seed: `s${d}` }).products[0].sku === 'PLNY_SKLAD') plny++;
        }
        expect(plny).toBeGreaterThan(180);
        expect(plny).toBeLessThan(300); // ani ten s malou zásobou nevypadne úplně
    });

    it('stejný seed = stejný nákup (obnovení stránky, reklamace), nezávisle na pořadí katalogu', () => {
        const a = matchProducts(MUSCLE, [...PASMO], constraints(), 30, { seed: 'rex|2026-09-24' });
        const b = matchProducts(MUSCLE, [...PASMO].reverse(), constraints(), 30, { seed: 'rex|2026-09-24' });
        expect(a.products).toEqual(b.products);
    });

    it('produkt mimo pásmo se použije, když pásmo nemá dost zásoby', () => {
        const catalog = [prod({ sku: 'LEVNY', priceCzk: 200, stockQuantity: 2 }), DRAHY];
        const r = matchProducts(MUSCLE, catalog, constraints(), 30);
        expect(r.products.map((p) => [p.sku, p.packs])).toEqual([['LEVNY', 2], ['DRAHY', 10]]);
    });
});
