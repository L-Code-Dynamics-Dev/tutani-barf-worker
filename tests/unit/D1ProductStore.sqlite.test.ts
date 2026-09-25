/**
 * `D1ProductStore` proti SKUTEČNÉMU SQL (SQLite + všechny migrace).
 *
 * Chrání před tím, co falešné story nevidí: nesoulad placeholderů
 * a sloupců, chybějící sloupec v migraci, rozjetí rozpadu a produktu.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { D1ProductStore, type StoredProduct } from '../../src/infrastructure/D1ProductStore.js';
import { SqliteD1 } from '../helpers/sqliteD1.js';

const T = 'tutani';

function prod(over: Partial<StoredProduct> = {}): StoredProduct {
    return {
        sku: 'ZP9',
        name: 'Hovězí svalovina 1kg',
        url: 'https://obchod.tutani.cz/svalovina/hovezi-svalovina-1kg/',
        categoryPath: 'Barf | Svalovina',
        group: 'MUSCLE',
        packGrams: 1000,
        packGramsSource: 'EXPORT',
        priceCzk: 129,
        priceId: '973',
        productId: '868',
        inStock: true,
        stockQuantity: 12,
        ingredientIds: ['hovezi'],
        ingredientsUnknown: false,
        isCooked: false,
        hasVariants: false,
        compositionParts: [],
        weightConflict: null,
        sourceFeedAt: '2026-09-24T00:00:00.000Z',
        ...over,
    };
}

describe('D1ProductStore nad SQLite', () => {
    let db: SqliteD1;
    let store: D1ProductStore;

    beforeEach(() => {
        db = new SqliteD1().applyMigrations();
        store = new D1ProductStore(db.asD1());
    });

    it('zapíše a přečte produkty přes víc dávek (regrese 18 vs 21 placeholderů)', async () => {
        // 11 produktů = víc než jedna dávka UPSERT_CHUNK → víc INSERTů.
        const products = Array.from({ length: 11 }, (_, i) =>
            prod({ sku: `SKU${String(i).padStart(2, '0')}`, priceId: String(1000 + i) })
        );
        const written = await store.upsertMany(T, products);
        expect(written).toBe(11);

        const usable = await store.listUsable(T);
        expect(usable.map((p) => p.sku)).toEqual(products.map((p) => p.sku));
        expect(usable[3].priceId).toBe('1003');
        expect(usable[3].productId).toBe('868');
        expect(usable[3].stockQuantity).toBe(12);
    });

    it('upsert přepíše existující řádek, ne duplikuje', async () => {
        await store.upsertMany(T, [prod()]);
        await store.upsertMany(T, [prod({ priceCzk: 139, stockQuantity: 3 })]);
        const all = await store.listUsable(T);
        expect(all).toHaveLength(1);
        expect(all[0].priceCzk).toBe(139);
        expect(all[0].stockQuantity).toBe(3);
    });

    it('varianta se uloží jako vlastní SKU s vlastním priceId a parentCode', async () => {
        await store.upsertMany(T, [
            prod({ sku: '1066/500', priceId: '1751', packGrams: 500, parentCode: '1066', variantName: '500 g' }),
            prod({ sku: '1066/1 K', priceId: '1754', packGrams: 1000, parentCode: '1066', variantName: '1 kg' }),
        ]);
        const all = await store.listUsable(T);
        expect(all.map((p) => [p.sku, p.priceId, p.parentCode])).toEqual([
            ['1066/1 K', '1754', '1066'],
            ['1066/500', '1751', '1066'],
        ]);
    });

    it('rozpad: procenta → řádky BARF_GROUP EXACT, bez procent → 100 % CATEGORY', async () => {
        await store.upsertMany(T, [
            prod({
                sku: 'TUT161',
                compositionParts: [
                    { group: 'MUSCLE', pct: 70, sourceCs: '70 % hovězí ořez' },
                    { group: 'ORGAN', pct: 30, sourceCs: '30 % hovězí droby' },
                ],
            }),
            prod({ sku: 'ZP9' }),
        ]);
        const rows = db.raw
            .prepare(
                `SELECT sku, level, barf_group, ingredient_id, pct, certainty
                   FROM product_composition WHERE tenant_id = ? ORDER BY sku, ordinal`
            )
            .all(T);
        expect(rows).toEqual([
            { sku: 'TUT161', level: 'BARF_GROUP', barf_group: 'MUSCLE', ingredient_id: null, pct: 70, certainty: 'EXACT' },
            { sku: 'TUT161', level: 'BARF_GROUP', barf_group: 'ORGAN', ingredient_id: null, pct: 30, certainty: 'EXACT' },
            { sku: 'TUT161', level: 'INGREDIENT', barf_group: null, ingredient_id: 'hovezi', pct: null, certainty: 'DETECTED' },
            { sku: 'ZP9', level: 'BARF_GROUP', barf_group: 'MUSCLE', ingredient_id: null, pct: 100, certainty: 'CATEGORY' },
            { sku: 'ZP9', level: 'INGREDIENT', barf_group: null, ingredient_id: 'hovezi', pct: null, certainty: 'DETECTED' },
        ]);
    });

    it('rozpad se při dalším syncu přepíše celý, nezůstanou staré řádky', async () => {
        await store.upsertMany(T, [
            prod({
                compositionParts: [
                    { group: 'MUSCLE', pct: 70, sourceCs: 'a' },
                    { group: 'ORGAN', pct: 30, sourceCs: 'b' },
                ],
            }),
        ]);
        await store.upsertMany(T, [prod({ compositionParts: [], ingredientIds: [] })]);
        const n = db.raw.prepare('SELECT COUNT(*) AS n FROM product_composition').get() as { n: number };
        expect(n.n).toBe(1);
    });

    it('smazání produktu smaže i jeho rozpad', async () => {
        await store.upsertMany(T, [prod({ sku: 'A' }), prod({ sku: 'B' })]);
        const deleted = await store.deleteBySkus(T, ['A']);
        expect(deleted).toBe(1);
        const skus = db.raw.prepare('SELECT DISTINCT sku FROM product_composition').all();
        expect(skus).toEqual([{ sku: 'B' }]);
    });

    it('updateStock změní sklad a cenu jen existujícím, chybějící cenu nevynuluje', async () => {
        await store.upsertMany(T, [prod({ sku: 'A', priceCzk: 100, stockQuantity: 5 })]);
        const changed = await store.updateStock(
            T,
            [
                { sku: 'A', stockQuantity: 0, priceCzk: null, visible: true },
                { sku: 'NEEXISTUJE', stockQuantity: 9, priceCzk: 50, visible: true },
            ],
            '2026-09-24T01:10:00.000Z'
        );
        expect(changed).toBe(1);
        const row = db.raw.prepare('SELECT * FROM products WHERE sku = ?').get('A') as Record<string, unknown>;
        expect(row.stock_quantity).toBe(0);
        expect(row.in_stock).toBe(0);
        expect(row.price_czk).toBe(100);
        expect(row.stock_synced_at).toBe('2026-09-24T01:10:00.000Z');
        const n = db.raw.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number };
        expect(n.n).toBe(1);
    });

    it('skrytý produkt není použitelný', async () => {
        await store.upsertMany(T, [prod({ sku: 'A' }), prod({ sku: 'B', visible: false })]);
        expect((await store.listUsable(T)).map((p) => p.sku)).toEqual(['A']);
    });

    it('selhání uprostřed batch nezapíše nic (transakce)', async () => {
        const vadny = prod({ sku: 'B' });
        // NOT NULL porušení u `name` → celý batch musí spadnout.
        (vadny as unknown as { name: null }).name = null;
        await expect(store.upsertMany(T, [prod({ sku: 'A' }), vadny])).rejects.toThrow();
        const n = db.raw.prepare('SELECT COUNT(*) AS n FROM products').get() as { n: number };
        expect(n.n).toBe(0);
    });

    it('audit běhu a health čtou ze skutečných tabulek', async () => {
        await store.upsertMany(T, [prod({ sku: 'A' }), prod({ sku: 'B', packGrams: null })]);
        await store.recordSyncRun(T, {
            id: 'r1', mode: 'LIVE', triggerSource: 'CRON',
            startedAt: '2026-09-24T01:00:00.000Z', finishedAt: '2026-09-24T01:01:00.000Z',
            status: 'OK', urlsTotal: 2, urlsFetched: 2, urlsFailed: 0, productsParsed: 2,
            added: 2, changed: 0, unchanged: 0, removed: 0, unusable: 1,
            diffSummary: { added: 2 }, errorText: null,
        });
        const h = await store.health(T);
        expect(h.productCount).toBe(2);
        expect(h.usableCount).toBe(1);
        expect(h.lastSync?.id).toBe('r1');
    });
});
