/**
 * Testy product matchingu.
 *
 * Ověřuje to, co má obchodní dopad: celá balení, nejlepší cena za kg,
 * determinismus, filtr alergií, tvrdý zákaz vařených kostí a přiznání
 * nepokryté složky (nikdy se nesubstituuje jinou složkou).
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
        url: 'https://obchod.tutani.cz/x/p1',
        priceCzk: 100,
        packGrams: 1000,
        group: 'MUSCLE',
        inStock: true,
        productId: '1',
        priceId: '10',
        ingredientIds: ['hovezi'],
        isCooked: false,
        ...over,
    };
}

/** Rozpad pro psa 24 kg / 540 g denně (výstup calculateDose). */
const COMPOSITION: CompositionItem[] = [
    { group: 'MUSCLE', labelCs: 'svalové maso', grams: 405, pct: 75, adjusted: false },
    { group: 'BONE', labelCs: 'mleté kosti', grams: 54, pct: 10, adjusted: false },
    { group: 'LIVER', labelCs: 'játra', grams: 27, pct: 5, adjusted: false },
    { group: 'ORGAN', labelCs: 'ostatní orgány', grams: 27, pct: 5, adjusted: false },
    { group: 'PLANT', labelCs: 'zelenina a ovoce', grams: 27, pct: 5, adjusted: false },
];

/** Minimální katalog pokrývající všechny složky. */
const CATALOG: CatalogProduct[] = [
    prod({ sku: 'ZP9', name: 'Hovězí svalovina 1kg', group: 'MUSCLE', priceCzk: 209, packGrams: 1000 }),
    prod({ sku: 'ZP10', name: 'Hrubomletá směs 1,5kg', group: 'BONE', priceCzk: 95, packGrams: 1500, ingredientIds: ['hovezi'] }),
    prod({ sku: 'TUT108', name: 'Pašíkova játra mletá 1kg', group: 'LIVER', priceCzk: 149, packGrams: 1000, ingredientIds: ['vepr'] }),
    prod({ sku: 'ZP19', name: 'Srdce krmné vepřové 1kg', group: 'ORGAN', priceCzk: 99, packGrams: 1000, ingredientIds: ['vepr'] }),
    prod({ sku: 'TUT196', name: 'Barf Mrkev 500g', group: 'PLANT', priceCzk: 39, packGrams: 500, ingredientIds: ['mrkev'] }),
];

describe('sestavení nákupu', () => {
    it('pokryje všechny složky dávky', () => {
        const r = matchProducts(COMPOSITION, CATALOG, constraints(), 30);
        expect(r.uncovered).toHaveLength(0);
        expect(r.products.map((p) => p.group).sort()).toEqual(
            ['BONE', 'LIVER', 'MUSCLE', 'ORGAN', 'PLANT'].sort()
        );
    });

    it('počítá CELÁ balení a zaokrouhluje nahoru — maso se nekrájí', () => {
        const r = matchProducts(COMPOSITION, CATALOG, constraints(), 30);
        const muscle = r.products.find((p) => p.group === 'MUSCLE')!;
        // 405 g × 30 dní = 12 150 g → 13 balení po 1 kg
        expect(muscle.packs).toBe(13);
        expect(muscle.totalPriceCzk).toBe(209 * 13);
    });

    it('nikdy nedoporučí 0 balení, i když je potřeba menší než balení', () => {
        const r = matchProducts(
            [{ group: 'LIVER', labelCs: 'játra', grams: 1, pct: 5, adjusted: false }],
            CATALOG,
            constraints(),
            1
        );
        expect(r.products[0].packs).toBe(1);
    });

    it('celková cena je součtem položek', () => {
        const r = matchProducts(COMPOSITION, CATALOG, constraints(), 30);
        const sum = r.products.reduce((a, p) => a + p.totalPriceCzk, 0);
        expect(r.totalPriceCzk).toBeCloseTo(sum, 2);
    });

    it('kratší období = méně balení', () => {
        const mesic = matchProducts(COMPOSITION, CATALOG, constraints(), 30);
        const tyden = matchProducts(COMPOSITION, CATALOG, constraints(), 7);
        expect(tyden.totalPriceCzk).toBeLessThan(mesic.totalPriceCzk);
        // 405 g × 7 = 2 835 g → 3 balení
        expect(tyden.products.find((p) => p.group === 'MUSCLE')!.packs).toBe(3);
    });
});

describe('výběr produktu', () => {
    it('vybere nižší cenu za KILOGRAM, ne nižší cenu balení', () => {
        const catalog = [
            prod({ sku: 'DRAHY', priceCzk: 100, packGrams: 500 }),   // 200 Kč/kg
            prod({ sku: 'LEVNY', priceCzk: 150, packGrams: 1500 }),  // 100 Kč/kg
        ];
        const r = matchProducts([COMPOSITION[0]], catalog, constraints(), 30);
        expect(r.products[0].sku).toBe('LEVNY');
    });

    it('preferovaná surovina ze zdravotního pravidla má přednost před cenou', () => {
        const catalog = [
            prod({ sku: 'LEVNY', priceCzk: 50, packGrams: 1000, ingredientIds: ['hovezi'] }),
            prod({ sku: 'PREFEROVANY', priceCzk: 300, packGrams: 1000, ingredientIds: ['kralik'] }),
        ];
        const r = matchProducts(
            [COMPOSITION[0]],
            catalog,
            constraints({ preferredIngredientIds: new Set(['kralik']) }),
            30
        );
        expect(r.products[0].sku).toBe('PREFEROVANY');
    });

    it('nedoporučí zbytečně velké balení, když stačí menší za rozumnou cenu', () => {
        // Potřeba 54 g/den × 30 = 1 620 g.
        const catalog = [
            // 10kg balení: nejlepší cena za kg, ale zásoba na půl roku
            prod({ sku: 'VELKE', priceCzk: 400, packGrams: 10_000 }),  // 40 Kč/kg
            prod({ sku: 'PRIMERENE', priceCzk: 120, packGrams: 2000 }), // 60 Kč/kg
        ];
        const r = matchProducts(
            [{ group: 'MUSCLE', labelCs: 'svalové maso', grams: 54, pct: 75, adjusted: false }],
            catalog,
            constraints(),
            30
        );
        expect(r.products[0].sku).toBe('PRIMERENE');
    });

    it('velké balení se použije, když menší alternativa není', () => {
        const catalog = [prod({ sku: 'JEN_VELKE', priceCzk: 400, packGrams: 10_000 })];
        const r = matchProducts(
            [{ group: 'MUSCLE', labelCs: 'svalové maso', grams: 54, pct: 75, adjusted: false }],
            catalog,
            constraints(),
            30
        );
        expect(r.products[0].sku).toBe('JEN_VELKE');
        expect(r.products[0].packs).toBe(1);
    });

    it('u velké potřeby velké balení vyhraje cenou', () => {
        // 405 g/den × 30 = 12 150 g → velké balení je přiměřené i výhodné
        const catalog = [
            prod({ sku: 'VELKE', priceCzk: 400, packGrams: 10_000 }),   // 40 Kč/kg
            prod({ sku: 'MALE', priceCzk: 120, packGrams: 2000 }),      // 60 Kč/kg
        ];
        const r = matchProducts([COMPOSITION[0]], catalog, constraints(), 30);
        expect(r.products[0].sku).toBe('VELKE');
    });

    it('výběr je deterministický i při shodné ceně za kg', () => {
        const catalog = [
            prod({ sku: 'B_SKU', priceCzk: 100, packGrams: 1000 }),
            prod({ sku: 'A_SKU', priceCzk: 200, packGrams: 2000 }),
        ];
        const a = matchProducts([COMPOSITION[0]], catalog, constraints(), 30);
        const b = matchProducts([COMPOSITION[0]], [...catalog].reverse(), constraints(), 30);
        expect(a.products[0].sku).toBe(b.products[0].sku);
        expect(a.products[0].sku).toBe('A_SKU');
    });

    it('vrací priceId a productId pro vložení do košíku', () => {
        const r = matchProducts(COMPOSITION, CATALOG, constraints(), 30);
        for (const p of r.products) {
            expect(p.priceId).toBeTruthy();
            expect(p.productId).toBeTruthy();
        }
    });
});

describe('bezpečnost a zdraví', () => {
    it('VAŘENÉ KOSTI se nikdy nedoporučí', () => {
        const catalog = [prod({ sku: 'VARENE', group: 'BONE', isCooked: true })];
        const r = matchProducts([COMPOSITION[1]], catalog, constraints(), 30);
        expect(r.products).toHaveLength(0);
        expect(r.uncovered[0].group).toBe('BONE');
        expect(r.excluded[0].reasonCs).toContain('vařené kosti');
    });

    it('alergie vyřadí produkt s danou surovinou', () => {
        const catalog = [
            prod({ sku: 'KURE', ingredientIds: ['kure'] }),
            prod({ sku: 'HOVEZI', ingredientIds: ['hovezi'] }),
        ];
        const r = matchProducts(
            [COMPOSITION[0]],
            catalog,
            constraints({ excludedIngredientIds: new Set(['kure']) }),
            30
        );
        expect(r.products).toHaveLength(1);
        expect(r.products[0].sku).toBe('HOVEZI');
        expect(r.excluded.find((e) => e.sku === 'KURE')).toBeTruthy();
    });

    it('vyloučí-li alergie celou složku, výsledek to PŘIZNÁ', () => {
        const catalog = [prod({ sku: 'KURE', group: 'LIVER', ingredientIds: ['kure'] })];
        const r = matchProducts(
            [COMPOSITION[2]],
            catalog,
            constraints({ excludedIngredientIds: new Set(['kure']) }),
            30
        );
        expect(r.products).toHaveLength(0);
        expect(r.uncovered[0]).toMatchObject({ group: 'LIVER', reason: 'ALL_FILTERED_OUT' });
    });

    it('nepokrytá složka se NESUBSTITUUJE jinou složkou', () => {
        // Katalog bez jater — svalovina se nesmí navýšit, aby to nahradila.
        const catalog = CATALOG.filter((p) => p.group !== 'LIVER');
        const r = matchProducts(COMPOSITION, catalog, constraints(), 30);

        expect(r.uncovered.map((u) => u.group)).toEqual(['LIVER']);
        const muscle = r.products.find((p) => p.group === 'MUSCLE')!;
        // Stejný počet balení jako s plným katalogem — žádná kompenzace.
        const full = matchProducts(COMPOSITION, CATALOG, constraints(), 30);
        expect(muscle.packs).toBe(full.products.find((p) => p.group === 'MUSCLE')!.packs);
    });
});

describe('dostupnost', () => {
    it('produkt mimo sklad se nedoporučí', () => {
        const catalog = [
            prod({ sku: 'NENI', priceCzk: 10, packGrams: 1000, inStock: false }),
            prod({ sku: 'JE', priceCzk: 300, packGrams: 1000, inStock: true }),
        ];
        const r = matchProducts([COMPOSITION[0]], catalog, constraints(), 30);
        expect(r.products[0].sku).toBe('JE');
    });

    it('je-li celá složka vyprodaná, hlásí OUT_OF_STOCK', () => {
        const catalog = [prod({ sku: 'A', group: 'BONE', inStock: false })];
        const r = matchProducts([COMPOSITION[1]], catalog, constraints(), 30);
        expect(r.uncovered[0].reason).toBe('OUT_OF_STOCK');
    });

    it('chybí-li složka v katalogu úplně, hlásí NO_PRODUCT_IN_GROUP', () => {
        const r = matchProducts([COMPOSITION[2]], [], constraints(), 30);
        expect(r.uncovered[0].reason).toBe('NO_PRODUCT_IN_GROUP');
    });
});
