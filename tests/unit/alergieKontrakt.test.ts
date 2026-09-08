/**
 * KONTRAKT ALERGIÍ mezi UI a filtrem produktů.
 *
 * NÁLEZ 2026-09-09: `/v1/knowledge` posílá do UI id PODMÍNEK
 * (`alergie-kure`, `alergie-drubez`), protože nesou srozumitelný
 * název pro majitele. Backend je ale dostával v `alergie[]`, kde se
 * čekají id SUROVIN — vyloučila se neexistující surovina
 * `alergie-kure`, zatímco produkty mají `kure`, a filtr nevyřadil nic.
 *
 * Pes s alergií tak dostal doporučený produkt s alergenem, přičemž
 * API hlásilo, že alergii vyhodnotilo. Tyhle testy hlídají, aby se
 * kontrakt znovu nerozešel.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildKnowledgeBase, resolveConstraints } from '../../src/rules/RuleEngine.js';
import { matchProducts, type CatalogProduct } from '../../src/engine/product-matching/matchProducts.js';
import type { CompositionItem } from '../../src/engine/feeding-calculator/calculateDose.js';

const json = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf-8'));
const KB = buildKnowledgeBase(
    json('../../tenants/tutani/rules/tutani-health.json'),
    json('../../tenants/tutani/rules/ingredients.json'),
    json('../../tenants/tutani/rules/barf-core.json')
);

/** Toxické suroviny jsou vyloučené vždy — v testech se odfiltrují. */
const TOXICKE = new Set(KB.alwaysExcludedIngredientIds ?? []);
const navic = (s: ReadonlySet<string>) => [...s].filter((x) => !TOXICKE.has(x)).sort();

function prod(over: Partial<CatalogProduct> = {}): CatalogProduct {
    return {
        sku: 'P1', name: 'Produkt', url: '#', priceCzk: 100, packGrams: 1000,
        group: 'MUSCLE', inStock: true, productId: '1', priceId: '10',
        ingredientIds: ['hovezi'], isCooked: false, ...over,
    };
}
const MUSCLE: CompositionItem[] = [
    { group: 'MUSCLE', labelCs: 'svalové maso', grams: 405, pct: 75, adjusted: false },
];

describe('id alergie z UI se přeloží na suroviny', () => {
    it('`alergie-kure` vyloučí surovinu `kure`, ne sama sebe', () => {
        const c = resolveConstraints([], ['alergie-kure'], KB);
        expect(navic(c.excludedIngredientIds)).toEqual(['kure']);
        // A nesmí se hlásit jako neznámá surovina.
        expect(c.unknownAllergyIngredientIds).toHaveLength(0);
    });

    it('`alergie-drubez` vyloučí kuře, krůtu I kachnu naráz', () => {
        const c = resolveConstraints([], ['alergie-drubez'], KB);
        expect(navic(c.excludedIngredientIds).sort()).toEqual(['kachna', 'kruti', 'kure']);
    });

    it('id SUROVINY (`kure`) funguje dál — zpětná kompatibilita', () => {
        const c = resolveConstraints([], ['kure'], KB);
        expect(navic(c.excludedIngredientIds)).toEqual(['kure']);
    });

    it('každé id z /v1/knowledge musí něco vyloučit', () => {
        // Tohle je jádro kontraktu: co UI nabídne, to musí filtr umět.
        const alergeny = KB.conditions.filter(
            (x) => x.kind === 'ALLERGY' || x.kind === 'INTOLERANCE'
        );
        expect(alergeny.length).toBeGreaterThan(0);

        for (const a of alergeny) {
            if ((a as { alwaysActive?: boolean }).alwaysActive) continue;
            const c = resolveConstraints([], [a.id], KB);
            expect(navic(c.excludedIngredientIds).length, `${a.id} nevylučuje nic`).toBeGreaterThan(0);
        }
    });
});

describe('filtr produktů skutečně vyřadí alergen', () => {
    it('produkt s kuřecím se psovi s `alergie-kure` nedoporučí', () => {
        const catalog = [
            prod({ sku: 'KURE', ingredientIds: ['kure'], priceCzk: 50 }),
            prod({ sku: 'HOVEZI', ingredientIds: ['hovezi'], priceCzk: 300 }),
        ];
        const c = resolveConstraints([], ['alergie-kure'], KB);
        const r = matchProducts(MUSCLE, catalog, c, 30);

        expect(r.products.map((p) => p.sku)).toEqual(['HOVEZI']);
        expect(r.excluded.find((e) => e.sku === 'KURE')).toBeTruthy();
    });

    it('FAIL-CLOSED: produkt s neznámou surovinou se u alergie nedoporučí', () => {
        // Katalog tutani má složení jen u části produktů; neznámou
        // surovinu nelze prohlásit za bezpečnou.
        const catalog = [
            prod({ sku: 'NEZNAMY', ingredientIds: [], ingredientsUnknown: true }),
        ];
        const c = resolveConstraints([], ['alergie-kure'], KB);
        const r = matchProducts(MUSCLE, catalog, c, 30);

        expect(r.products).toHaveLength(0);
        expect(r.uncovered[0].reason).toBe('ALL_FILTERED_OUT');
    });

    it('u psa BEZ alergií se produkt s neznámou surovinou doporučí normálně', () => {
        const catalog = [prod({ sku: 'NEZNAMY', ingredientIds: [], ingredientsUnknown: true })];
        const c = resolveConstraints([], [], KB);
        const r = matchProducts(MUSCLE, catalog, c, 30);

        expect(r.products.map((p) => p.sku)).toEqual(['NEZNAMY']);
    });
});

describe('bezpečnost bez ohledu na zadání', () => {
    it('toxické suroviny jsou vyloučené i u psa bez alergií', () => {
        const c = resolveConstraints([], [], KB);
        for (const t of ['hrozny', 'cibule', 'cesnek', 'xylitol', 'cokolada']) {
            expect(c.excludedIngredientIds.has(t), t).toBe(true);
        }
    });

    it('vařený produkt se nedoporučí ani mimo skupinu BONE', () => {
        const catalog = [prod({ sku: 'VARENE', group: 'MUSCLE', isCooked: true })];
        const r = matchProducts(MUSCLE, catalog, resolveConstraints([], [], KB), 30);
        expect(r.products).toHaveLength(0);
        expect(r.excluded[0].reasonCs).toContain('vařen');
    });
});
