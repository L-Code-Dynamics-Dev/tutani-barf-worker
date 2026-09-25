/**
 * Sync s admin exportem + 10min sync skladu.
 *
 * Ověřuje zadání z 2026-09-24: gramáž z exportu (ne z přepravní
 * hmotnosti), varianty s vlastním priceId, aktuální sklad a pojistky,
 * které chrání katalog klienta při výpadku nebo rozbitém exportu.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
    CatalogHealth,
    ProductStore,
    StoredProduct,
    SyncRunRecord,
} from '../../src/infrastructure/D1ProductStore.js';
import { D1ProductStore } from '../../src/infrastructure/D1ProductStore.js';
import { syncCatalog } from '../../src/adapters/tutani-catalog/syncCatalog.js';
import { syncStock } from '../../src/adapters/shoptet-export/syncStock.js';
import { TUTANI_TENANT } from '../../tenants/tutani/config/tenant.js';
import { buildCompleteXml } from '../helpers/completeXml.js';
import { parseProductsCompleteXml } from '../../src/adapters/shoptet-export/parseProductsCompleteXml.js';
import { mergeWithExport } from '../../src/adapters/shoptet-export/mergeExport.js';
import { SqliteD1 } from '../helpers/sqliteD1.js';

class FakeStore implements ProductStore {
    syncRuns: SyncRunRecord[] = [];
    upserted: StoredProduct[] = [];
    deleted: string[] = [];
    constructor(private products: StoredProduct[] = []) {}
    async listByGroup() { return this.products; }
    async listUsable() { return this.products.filter((p) => p.packGrams !== null); }
    async listAllSkus() { return this.products.map((p) => p.sku); }
    async upsertMany(_t: string, p: StoredProduct[]) { this.upserted.push(...p); return p.length; }
    async deleteBySkus(_t: string, s: string[]) { this.deleted.push(...s); return s.length; }
    async recordSyncRun(_t: string, r: SyncRunRecord) { this.syncRuns.push(r); }
    async health(): Promise<CatalogHealth> { return { productCount: 0, usableCount: 0, lastSync: null }; }
}

const EXPORT_URL = 'https://obchod.tutani.cz/export/productsComplete.xml?patternId=-5&partnerId=6&hash=TEST';
const SITEMAP_URL = TUTANI_TENANT.catalog.sitemapUrl!;
const OPTS = { delayMs: 0, retries: 1, now: () => new Date('2026-09-24T03:15:00.000Z') };

function productHtml(o: { code: string; name: string; weight: number; price: number; qty: number; id: number; category?: string }): string {
    const p = {
        code: o.code, name: o.name, id: o.id, guid: `guid-${o.code}`, priceWithVat: o.price,
        weight: o.weight, currentCategory: o.category ?? 'Barf | Svalovina', manufacturer: 'Tutani',
        hasVariants: false, codes: [{ code: o.code, quantity: o.qty }],
    };
    return `<html><body><script>dataLayer.push({"shoptet":{"pageType":"productDetail","product":${JSON.stringify(p)}}});</script>
<form><input type="hidden" name="productId" value="${o.id}" /><input type="hidden" name="priceId" value="${o.id + 100}" /></form></body></html>`;
}

function fakeFetch(pages: Record<string, string | number | Uint8Array>): typeof fetch {
    return (async (input: RequestInfo | URL) => {
        const entry = pages[String(input)];
        if (entry === undefined) return new Response('nenalezeno', { status: 404 });
        if (typeof entry === 'number') return new Response('chyba', { status: entry });
        return new Response(entry, { status: 200 });
    }) as typeof fetch;
}

const U = {
    svalovina: 'https://obchod.tutani.cz/svalovina/hovezi-svalovina-1kg/',
    veminko: 'https://obchod.tutani.cz/svalovina/krajene-veminko-1kg/',
    kost: 'https://obchod.tutani.cz/kosti/kost-kalciova/',
    kvasnice: 'https://obchod.tutani.cz/doplnky/pivovarske-kvasnice/',
};

const SITEMAP = `<urlset>${Object.values(U).map((u) => `<loc>${u}</loc>`).join('')}</urlset>`;

const PAGES: Record<string, string | number | Uint8Array> = {
    [SITEMAP_URL]: SITEMAP,
    // Scraper by vzal přepravní hmotnost 5 kg — export říká 1 kg.
    [U.veminko]: productHtml({ code: 'ZP12', name: 'Krájené vemínko 1kg', weight: 5, price: 159, qty: 9, id: 500 }),
    [U.svalovina]: productHtml({ code: 'ZP9', name: 'Hovězí svalovina 1kg', weight: 1, price: 129, qty: 3, id: 501 }),
    // Export chybně 100 g, název 250 g → musí se nahlásit jako rozpor.
    [U.kost]: productHtml({ code: '815', name: 'Kost kalciová obalená kachním masem-250g', weight: 0.25, price: 69, qty: 4, id: 502, category: 'Barf pamlsky' }),
    [U.kvasnice]: readFileSync(join(process.cwd(), 'tests/fixtures/detail-varianty-pivovarske-kvasnice-2026-09-24.html'), 'utf8'),
};

const EXPORT = buildCompleteXml([
    // Scraper by vzal přepravní hmotnost 5 kg — export říká 1 kg.
    { id: '500', name: 'Krájené vemínko 1kg', code: 'ZP12', stock: 7, amount: '1', unit: 'kg' },
    { id: '501', name: 'Hovězí svalovina 1kg', code: 'ZP9', stock: 11, amount: '1', unit: 'kg', description: '<p>Složení: 100% hovězí svalovina</p>' },
    // Export chybně 100 g, název 250 g → musí se nahlásit jako rozpor.
    { id: '502', name: 'Kost kalciová obalená kachním masem-250g', code: '815', stock: 4, amount: '100', unit: 'g' },
    {
        id: '1066', name: 'Pivovarské kvasnice 500g, 1kg',
        variants: [
            { id: '1751', code: '1066/500', stock: 6, amount: '500', unit: 'g', price: 59, param: '500 g' },
            { id: '1754', code: '1066/1 K', stock: 2, amount: '1', unit: 'kg', price: 88, param: '1 kg' },
        ],
    },
    // Skladem, ale na webu není (sitemap ho nemá) → report, ne zápis.
    { id: '503', name: 'Vepřová svalovina 1kg', code: 'ZP24', stock: 8, amount: '1', unit: 'kg' },
]);

describe('syncCatalog s admin exportem', () => {
    it('gramáž z exportu přebije přepravní hmotnost ze scraperu', async () => {
        const r = await syncCatalog(TUTANI_TENANT, new FakeStore(), {
            dryRun: true, triggerSource: 'MANUAL', exportUrl: EXPORT_URL,
            fetchImpl: fakeFetch({ ...PAGES, [EXPORT_URL]: EXPORT }), ...OPTS,
        });
        const veminko = r.products.find((p) => p.sku === 'ZP12')!;
        expect(veminko.packGrams).toBe(1000);
        expect(veminko.packGramsSource).toBe('EXPORT');
        expect(veminko.weightConflict).toBeNull();
    });

    it('sklad bere z exportu a zapíše, kdy byl potvrzen', async () => {
        const r = await syncCatalog(TUTANI_TENANT, new FakeStore(), {
            dryRun: true, triggerSource: 'MANUAL', exportUrl: EXPORT_URL,
            fetchImpl: fakeFetch({ ...PAGES, [EXPORT_URL]: EXPORT }), ...OPTS,
        });
        const sv = r.products.find((p) => p.sku === 'ZP9')!;
        expect(sv.stockQuantity).toBe(11);
        expect(sv.stockSyncedAt).toBe('2026-09-24T03:15:00.000Z');
        // Cena zůstává z webu (akční cena), ne z exportu.
        expect(sv.priceCzk).toBe(129);
    });

    it('rozpor exportu s názvem (815: 100 g vs 250 g) se nepřehlédne', async () => {
        const r = await syncCatalog(TUTANI_TENANT, new FakeStore(), {
            dryRun: true, triggerSource: 'MANUAL', exportUrl: EXPORT_URL,
            fetchImpl: fakeFetch({ ...PAGES, [EXPORT_URL]: EXPORT }), ...OPTS,
        });
        const kost = r.products.find((p) => p.sku === '815')!;
        expect(kost.weightConflict).not.toBeNull();
        expect(kost.weightConflict!.authoritative).toBe(100);
        expect(kost.weightConflict!.fromName).toBe(250);
    });

    it('varianty: každá vlastní SKU, priceId z řádku, sklad z exportu, společný parentCode', async () => {
        const r = await syncCatalog(TUTANI_TENANT, new FakeStore(), {
            dryRun: true, triggerSource: 'MANUAL', exportUrl: EXPORT_URL,
            fetchImpl: fakeFetch({ ...PAGES, [EXPORT_URL]: EXPORT }), ...OPTS,
        });
        const v = r.products.filter((p) => p.parentCode === '1066').map((p) => [p.sku, p.priceId, p.packGrams, p.stockQuantity]);
        expect(v).toEqual([
            ['1066/500', '1751', 500, 6],
            ['1066/1 K', '1754', 1000, 2],
        ]);
        expect(r.products.filter((p) => p.parentCode === '1066').every((p) => p.productId === '1066')).toBe(true);
    });

    it('produkt skladem jen v exportu (bez priceId) se nezapíše, ale nahlásí', async () => {
        const r = await syncCatalog(TUTANI_TENANT, new FakeStore(), {
            dryRun: true, triggerSource: 'MANUAL', exportUrl: EXPORT_URL,
            fetchImpl: fakeFetch({ ...PAGES, [EXPORT_URL]: EXPORT }), ...OPTS,
        });
        expect(r.products.some((p) => p.sku === 'ZP24')).toBe(false);
        expect(r.exportOnlyInStock).toEqual([{ code: 'ZP24', name: 'Vepřová svalovina 1kg', stockQuantity: 8 }]);
    });

    it('rozpad složení z popisu v exportu', async () => {
        const r = await syncCatalog(TUTANI_TENANT, new FakeStore(), {
            dryRun: true, triggerSource: 'MANUAL', exportUrl: EXPORT_URL,
            fetchImpl: fakeFetch({ ...PAGES, [EXPORT_URL]: EXPORT }), ...OPTS,
        });
        const sv = r.products.find((p) => p.sku === 'ZP9')!;
        expect(sv.compositionParts.map((c) => [c.group, c.pct])).toEqual([['MUSCLE', 100]]);
        expect(sv.ingredientIds.length).toBeGreaterThan(0);
    });

    it('nastavený, ale nedostupný export = FAILED a NIC se nezapíše (žádný návrat k přepravní hmotnosti)', async () => {
        const store = new FakeStore();
        const r = await syncCatalog(TUTANI_TENANT, store, {
            dryRun: false, triggerSource: 'CRON', exportUrl: EXPORT_URL,
            fetchImpl: fakeFetch({ ...PAGES, [EXPORT_URL]: 404 }), ...OPTS,
        });
        expect(r.run.status).toBe('FAILED');
        expect(r.run.errorText).toMatch(/admin export selhal/);
        expect(store.upserted).toEqual([]);
        // Hash exportu se nesmí objevit v auditu.
        expect(JSON.stringify(store.syncRuns)).not.toContain('hash=');
    });

    it('bez exportu (secret nenastaven) funguje postaru', async () => {
        const r = await syncCatalog(TUTANI_TENANT, new FakeStore(), {
            dryRun: true, triggerSource: 'MANUAL', fetchImpl: fakeFetch(PAGES), ...OPTS,
        });
        expect(r.products.find((p) => p.sku === 'ZP9')!.packGramsSource).toBe('DATALAYER');
    });

    it('pojistka: běh neodebere víc než 20 % katalogu najednou', async () => {
        const existing = Array.from({ length: 40 }, (_, i) => ({
            sku: `OLD${i}`, name: 'x', url: '', categoryPath: null, group: 'MUSCLE' as const, packGrams: 1000,
            packGramsSource: 'NAME' as const, priceCzk: 1, priceId: '1', productId: '1', inStock: true,
            stockQuantity: 1, ingredientIds: [], ingredientsUnknown: true, isCooked: false, hasVariants: false,
            compositionParts: [], weightConflict: null, sourceFeedAt: null,
        }));
        const store = new FakeStore(existing);
        const r = await syncCatalog(TUTANI_TENANT, store, {
            dryRun: false, triggerSource: 'CRON', exportUrl: EXPORT_URL,
            fetchImpl: fakeFetch({ ...PAGES, [EXPORT_URL]: EXPORT }), ...OPTS,
        });
        expect(store.deleted).toEqual([]);
        expect(r.run.removed).toBe(0);
        expect(r.run.status).toBe('PARTIAL');
    });
});

describe('syncStock (každých 10 min)', () => {
    async function seeded() {
        const db = new SqliteD1().applyMigrations();
        const store = new D1ProductStore(db.asD1());
        const base = {
            name: 'x', url: 'u', categoryPath: null, group: 'MUSCLE' as const, packGrams: 1000,
            packGramsSource: 'EXPORT' as const, priceCzk: 129, priceId: '1', productId: '1', inStock: true,
            ingredientIds: [], ingredientsUnknown: true, isCooked: false, hasVariants: false,
            compositionParts: [], weightConflict: null, sourceFeedAt: null,
        };
        await store.upsertMany('tutani', [
            { ...base, sku: 'ZP9', stockQuantity: 3 },
            { ...base, sku: 'ZP12', stockQuantity: 9 },
            { ...base, sku: 'MIMO', stockQuantity: 5 },
        ]);
        return { db, store };
    }

    it('aktualizuje sklad, cenu nemění, chybějící v exportu NENULUJE', async () => {
        const { db, store } = await seeded();
        const r = await syncStock('tutani', store, {
            exportUrl: EXPORT_URL, dryRun: false, retries: 1,
            fetchImpl: fakeFetch({ [EXPORT_URL]: EXPORT }), now: () => new Date('2026-09-24T10:10:00.000Z'),
        });
        expect(r.status).toBe('OK');
        expect(r.missingInExport).toEqual(['MIMO']);
        const rows = db.raw.prepare('SELECT sku, stock_quantity, in_stock, price_czk, stock_synced_at FROM products ORDER BY sku').all();
        expect(rows).toEqual([
            { sku: 'MIMO', stock_quantity: 5, in_stock: 1, price_czk: 129, stock_synced_at: null },
            { sku: 'ZP12', stock_quantity: 7, in_stock: 1, price_czk: 129, stock_synced_at: '2026-09-24T10:10:00.000Z' },
            { sku: 'ZP9', stock_quantity: 11, in_stock: 1, price_czk: 129, stock_synced_at: '2026-09-24T10:10:00.000Z' },
        ]);
    });

    it('dry-run spočítá změny, ale nic nezapíše', async () => {
        const { db, store } = await seeded();
        const r = await syncStock('tutani', store, {
            exportUrl: EXPORT_URL, dryRun: true, retries: 1, fetchImpl: fakeFetch({ [EXPORT_URL]: EXPORT }),
        });
        expect(r.changes).toEqual([
            { sku: 'ZP12', from: 9, to: 7 },
            { sku: 'ZP9', from: 3, to: 11 },
        ]);
        const zp9 = db.raw.prepare("SELECT stock_quantity FROM products WHERE sku = 'ZP9'").get() as { stock_quantity: number };
        expect(zp9.stock_quantity).toBe(3);
    });

    it('export pokrývá méně než polovinu katalogu → FAILED, sklad beze změny', async () => {
        const { db, store } = await seeded();
        const maly = buildCompleteXml([{ id: '1', name: 'x', code: 'ZP9', stock: 0 }]);
        const r = await syncStock('tutani', store, {
            exportUrl: EXPORT_URL, dryRun: false, retries: 1, fetchImpl: fakeFetch({ [EXPORT_URL]: maly }),
        });
        expect(r.status).toBe('FAILED');
        const zp9 = db.raw.prepare("SELECT stock_quantity FROM products WHERE sku = 'ZP9'").get() as { stock_quantity: number };
        expect(zp9.stock_quantity).toBe(3);
    });

    it('HTML místo exportu (neplatný hash) → FAILED, čitelná chyba', async () => {
        const { store } = await seeded();
        const r = await syncStock('tutani', store, {
            exportUrl: EXPORT_URL, dryRun: false, retries: 1, fetchImpl: fakeFetch({ [EXPORT_URL]: '<html>404</html>' }),
        });
        expect(r.status).toBe('FAILED');
        expect(r.errorText).toMatch(/není XML export/);
    });
});

describe('id pro košík (priceId + productId, vždy oba)', () => {
    const scraped = (o: Partial<import('../../src/adapters/tutani-catalog/parseProductPage.js').ScrapedProduct>) => ({
        sku: 'ZP9', name: 'Hovězí svalovina 1kg', url: 'u', productId: '868', priceId: '973', guid: null,
        priceWithVat: 209, packGrams: 1000, packGramsSource: 'DATALAYER' as const, packGramsConflict: null,
        stockQuantity: 1, categoryPath: null, manufacturer: null, hasVariants: false, compositionText: null,
        params: {}, ...o,
    });
    const xml = (items: Parameters<typeof buildCompleteXml>[0]) => parseProductsCompleteXml(buildCompleteXml(items)).products;

    it('produkt bez variant: productId z XML, priceId z webu (≠ productId)', () => {
        const r = mergeWithExport([scraped({})], xml([{ id: '868', name: 'x', code: 'ZP9', stock: 5, amount: '1', unit: 'kg' }]));
        expect([r.products[0].productId, r.products[0].priceId]).toEqual(['868', '973']);
        expect(r.idMismatches).toEqual([]);
    });

    it('varianta: priceId z XML přebije web a rozpor se nahlásí', () => {
        const r = mergeWithExport(
            [scraped({ sku: '1066/500', productId: '1066', priceId: '9999', hasVariants: true })],
            xml([{ id: '1066', name: 'K', variants: [{ id: '1751', code: '1066/500', stock: 8, amount: '500', unit: 'g', price: 59 }] }])
        );
        expect([r.products[0].productId, r.products[0].priceId]).toEqual(['1066', '1751']);
        expect(r.idMismatches).toEqual([{ sku: '1066/500', field: 'priceId', page: '9999', xml: '1751' }]);
    });

    it('web ukazuje pod kódem jiný produkt než XML → priceId zahozen, produkt se nedoporučí', () => {
        const r = mergeWithExport([scraped({ productId: '111' })], xml([{ id: '868', name: 'x', code: 'ZP9', stock: 5 }]));
        expect(r.products[0].productId).toBe('868');
        expect(r.products[0].priceId).toBeNull();
        expect(r.idMismatches).toEqual([{ sku: 'ZP9', field: 'productId', page: '111', xml: '868' }]);
    });

    it('sync označí produkt bez priceId jako nepoužitelný (nejde do košíku)', async () => {
        const html = productHtml({ code: 'ZP9', name: 'Hovězí svalovina 1kg', weight: 1, price: 129, qty: 3, id: 501 })
            .replace(/<input type="hidden" name="priceId"[^>]*>/, '');
        const r = await syncCatalog(TUTANI_TENANT, new FakeStore(), {
            dryRun: true, triggerSource: 'MANUAL', exportUrl: EXPORT_URL,
            fetchImpl: fakeFetch({ [SITEMAP_URL]: `<urlset><loc>${U.svalovina}</loc></urlset>`, [U.svalovina]: html, [EXPORT_URL]: EXPORT }),
            ...OPTS,
        });
        expect(r.unusable.find((u) => u.sku === 'ZP9')?.reasonCs).toMatch(/chybí priceId/);
    });
});
