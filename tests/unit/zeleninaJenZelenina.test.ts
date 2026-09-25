/**
 * Zelenina = jen zelenina a ovoce (Lucky 2026-09-25: „nepočítat tam obiloviny").
 * Názvy jsou SKUTEČNÉ produkty z kategorie „Barf - Přílohy" (D1, 25. 9. 2026).
 */
import { describe, expect, it } from 'vitest';
import { matchProducts, type CatalogProduct } from '../../src/engine/product-matching/matchProducts.js';
import type { CompositionItem } from '../../src/engine/feeding-calculator/calculateDose.js';
import type { ResolvedConstraints } from '../../src/domain/health/Condition.js';
import { TUTANI_TENANT } from '../../tenants/tutani/config/tenant.js';

const POVOLENE = [
    'Barf Mrkev 500g', 'Barf Zeleninová směs 500g', 'Barf Červená Řepa 500g',
    'Dromy Zeleninový mix 300g', 'Dromy Ovocný mix 450 g',
];
const ZAKAZANE = [
    'Barf Instantní rýžová kaše 1kg', 'Barf Instantní rýžová kaše 500g', 'Barf  Potravinářská křemelina  200g',
    'Barf  Extrudovaná příloha pro BARF s kelpu 1kg', 'Barf Sušená zeleninová směs s rýží 1kg',
    'Dromy BARF HERBAL 500g', 'Dromy Digestive BARF 300 g', 'Dromy Extrudo ALFALFA FIBRE 1000 g',
    'Dromy Extrudo BARF 900g', 'Dromy Mořský mix 900 g', 'Dromy Obilný mix se zeleninou 1000 g',
    'Dromy Pohankový mix se zeleninou 1000 g', 'Dromy Rýžový mix se zeleninou 1000 g',
    'Dromy Semínkový mix 600 g', 'Dromy Vločkový mix 1000 g', 'Nutrin Barf Balancer 2500g',
];

const PLANT: CompositionItem[] = [{ group: 'PLANT', labelCs: 'zelenina a ovoce', grams: 40, pct: 10, adjusted: false }];
const BEZ_OMEZENI = { excludedIngredientIds: new Set<string>(), warnings: [], blocked: false } as unknown as ResolvedConstraints;

function prod(name: string, i: number): CatalogProduct {
    return {
        sku: 'S' + i, name, url: '#', priceCzk: 10 + i, packGrams: 500, group: 'PLANT', inStock: true,
        productId: String(i), priceId: String(100 + i), ingredientIds: [], isCooked: false,
    };
}

describe('zeleninová složka bere jen zeleninu a ovoce', () => {
    const katalog = [...POVOLENE, ...ZAKAZANE].map(prod);
    const r = matchProducts(PLANT, katalog, BEZ_OMEZENI, 30, { groupNameRules: TUTANI_TENANT.groupNameRules });
    const vyrazene = new Set(r.excluded.map((e) => e.name));

    it.each(ZAKAZANE)('„%s" se do zeleniny nepočítá', (n) => {
        expect(vyrazene.has(n)).toBe(true);
        expect(r.products.some((p) => p.name === n)).toBe(false);
    });

    it.each(POVOLENE)('„%s" zůstává povolená', (n) => {
        expect(vyrazene.has(n)).toBe(false);
    });

    it('bez pravidla tenanta se chování nemění (jiní tenanti)', () => {
        const bez = matchProducts(PLANT, katalog, BEZ_OMEZENI, 30);
        expect(bez.excluded.filter((e) => ZAKAZANE.includes(e.name))).toHaveLength(0);
    });
});
