/**
 * Testy synchronizace katalogu — s INJEKTOVANÝM fetch, bez sítě.
 *
 * Ověřuje pojistky, které chrání katalog klienta: dry-run nic
 * nezapíše, prázdný výsledek běh přeruší a produkty se neodebírají,
 * když se část URL nepodařilo přečíst.
 */

import { describe, expect, it } from 'vitest';
import type {
    CatalogHealth,
    ProductStore,
    StoredProduct,
    SyncRunRecord,
} from '../../src/infrastructure/D1ProductStore.js';
import { computeDiff, syncCatalog } from '../../src/adapters/tutani-catalog/syncCatalog.js';
import { TUTANI_TENANT } from '../../tenants/tutani/config/tenant.js';

class FakeStore implements ProductStore {
    public readonly syncRuns: SyncRunRecord[] = [];
    public upserted: StoredProduct[] = [];
    public deleted: string[] = [];

    constructor(private products: StoredProduct[] = []) {}

    async listByGroup(): Promise<StoredProduct[]> {
        return this.products;
    }
    async listUsable(): Promise<StoredProduct[]> {
        return this.products.filter((p) => p.packGrams !== null);
    }
    async listAllSkus(): Promise<string[]> {
        return this.products.map((p) => p.sku);
    }
    async upsertMany(_t: string, products: StoredProduct[]): Promise<number> {
        this.upserted.push(...products);
        return products.length;
    }
    async deleteBySkus(_t: string, skus: string[]): Promise<number> {
        this.deleted.push(...skus);
        return skus.length;
    }
    async recordSyncRun(_t: string, run: SyncRunRecord): Promise<void> {
        this.syncRuns.push(run);
    }
    async health(): Promise<CatalogHealth> {
        return { productCount: this.products.length, usableCount: this.products.length, lastSync: null };
    }
}

/** Minimální HTML detailu produktu Shoptetu — tvar ověřený na tutani.cz. */
function productHtml(opts: {
    code: string;
    name: string;
    weight?: number;
    price?: number;
    quantity?: number;
    category?: string;
    id?: number;
}): string {
    const p = {
        code: opts.code,
        name: opts.name,
        id: opts.id ?? 868,
        guid: 'aaaa-bbbb',
        priceWithVat: opts.price ?? 109,
        weight: opts.weight ?? 3,
        currentCategory: opts.category ?? 'Barf | Svalovina',
        manufacturer: 'Tutani',
        hasVariants: false,
        codes: [{ code: opts.code, quantity: opts.quantity ?? 10 }],
    };
    return `<!doctype html><html><body>
<script>dataLayer.push({"shoptet":{"pageType":"productDetail","product":${JSON.stringify(p)}}});</script>
<table><tr><th>Hmotnost</th><td>${opts.weight ?? 3} kg</td></tr></table>
<p>Složení: 100% kuřecí maso</p>
</body></html>`;
}

const SITEMAP = `<?xml version="1.0"?><urlset>
<loc>https://obchod.tutani.cz/svalovina/mlete-kure/</loc>
<loc>https://obchod.tutani.cz/kosti/veminko/</loc>
<loc>https://obchod.tutani.cz/kontakt/</loc>
</urlset>`;

/** Fetch, který servíruje připravené odpovědi podle URL. */
function fakeFetch(pages: Record<string, string | number>): typeof fetch {
    return (async (input: RequestInfo | URL) => {
        const url = String(input);
        const entry = pages[url];
        if (entry === undefined) return new Response('nenalezeno', { status: 404 });
        if (typeof entry === 'number') return new Response('chyba', { status: entry });
        return new Response(entry, { status: 200 });
    }) as typeof fetch;
}

const SITEMAP_URL = TUTANI_TENANT.catalog.sitemapUrl!;

const PAGES: Record<string, string | number> = {
    [SITEMAP_URL]: SITEMAP,
    'https://obchod.tutani.cz/svalovina/mlete-kure/': productHtml({
        code: 'TUT216',
        name: 'Barf Mleté kuře 3kg',
    }),
    'https://obchod.tutani.cz/kosti/veminko/': productHtml({
        code: 'TUT9',
        name: 'Barf Kuřecí vemínko 3kg',
        category: 'Barf | Drůbeží kosti',
        price: 115,
    }),
};

const OPTS = { delayMs: 0, retries: 1, now: () => new Date('2026-09-09T03:15:00.000Z') };

describe('syncCatalog — dry-run', () => {
    it('NIC nezapíše a vrátí diff', async () => {
        const store = new FakeStore();
        const result = await syncCatalog(TUTANI_TENANT, store, {
            dryRun: true,
            triggerSource: 'MANUAL',
            fetchImpl: fakeFetch(PAGES),
            ...OPTS,
        });

        expect(store.upserted).toEqual([]);
        expect(store.deleted).toEqual([]);
        expect(result.run.mode).toBe('DRY_RUN');
        expect(result.run.productsParsed).toBe(2);
        expect(result.diff.filter((d) => d.kind === 'ADDED')).toHaveLength(2);
    });

    it('dry-run se přesto zaznamená do auditu (schválený diff musí být dohledatelný)', async () => {
        const store = new FakeStore();
        await syncCatalog(TUTANI_TENANT, store, {
            dryRun: true,
            triggerSource: 'MANUAL',
            fetchImpl: fakeFetch(PAGES),
            ...OPTS,
        });
        expect(store.syncRuns).toHaveLength(1);
        expect(store.syncRuns[0].mode).toBe('DRY_RUN');
    });

    it('kategoriové URL se nepočítá jako produkt', async () => {
        const store = new FakeStore();
        const result = await syncCatalog(TUTANI_TENANT, store, {
            dryRun: true,
            triggerSource: 'MANUAL',
            fetchImpl: fakeFetch(PAGES),
            ...OPTS,
        });
        // `/kontakt/` má jen jeden segment → do produktových URL nejde.
        expect(result.run.urlsTotal).toBe(2);
    });
});

describe('syncCatalog — ostrý běh', () => {
    it('zapíše produkty a zařadí je do BARF skupin', async () => {
        const store = new FakeStore();
        const result = await syncCatalog(TUTANI_TENANT, store, {
            dryRun: false,
            triggerSource: 'CRON',
            fetchImpl: fakeFetch(PAGES),
            ...OPTS,
        });

        expect(result.run.status).toBe('OK');
        expect(store.upserted).toHaveLength(2);
        const groups = store.upserted.map((p) => p.group).sort();
        expect(groups).toEqual(['BONE', 'MUSCLE']);
        expect(store.upserted[0].packGrams).toBe(3000);
    });

    it('PŘERUŠÍ se, když se nepodařilo přečíst ani jeden produkt', async () => {
        const store = new FakeStore([
            { ...emptyProduct(), sku: 'TUT216', name: 'staré' },
        ]);
        const result = await syncCatalog(TUTANI_TENANT, store, {
            dryRun: false,
            triggerSource: 'CRON',
            // Sitemap projde, produktové stránky selžou → katalog by se
            // jinak vyprázdnil a konfigurátor by přestal doporučovat.
            fetchImpl: fakeFetch({ [SITEMAP_URL]: SITEMAP }),
            ...OPTS,
        });

        expect(result.run.status).toBe('FAILED');
        expect(store.upserted).toEqual([]);
        expect(store.deleted).toEqual([]);
        expect(result.run.errorText).toMatch(/ani jeden produkt/);
    });

    it('NEODEBÍRÁ produkty, když část URL selhala', async () => {
        const store = new FakeStore([{ ...emptyProduct(), sku: 'ZMIZEL', name: 'Zmizelý produkt' }]);
        const pages = { ...PAGES };
        // Jedna produktová stránka je dole → běh je PARTIAL.
        pages['https://obchod.tutani.cz/kosti/veminko/'] = 500;

        const result = await syncCatalog(TUTANI_TENANT, store, {
            dryRun: false,
            triggerSource: 'CRON',
            fetchImpl: fakeFetch(pages),
            ...OPTS,
        });

        expect(result.run.status).toBe('PARTIAL');
        expect(store.upserted).toHaveLength(1);
        // `ZMIZEL` se NESMAZAL — chybí, protože se nepřečetl, ne protože
        // se přestal prodávat (R7).
        expect(store.deleted).toEqual([]);
        expect(result.run.removed).toBe(0);
    });

    it('odebere produkt při úplném běhu', async () => {
        const store = new FakeStore([{ ...emptyProduct(), sku: 'ZMIZEL', name: 'Zmizelý produkt' }]);
        const result = await syncCatalog(TUTANI_TENANT, store, {
            dryRun: false,
            triggerSource: 'CRON',
            fetchImpl: fakeFetch(PAGES),
            ...OPTS,
        });
        expect(result.run.status).toBe('OK');
        expect(store.deleted).toEqual(['ZMIZEL']);
    });

    it('chybějící sitemapa je FAILED, ne pád', async () => {
        const store = new FakeStore();
        const result = await syncCatalog(TUTANI_TENANT, store, {
            dryRun: false,
            triggerSource: 'CRON',
            fetchImpl: fakeFetch({}),
            ...OPTS,
        });
        expect(result.run.status).toBe('FAILED');
        expect(result.run.errorText).toMatch(/sitemap/i);
    });
});

describe('computeDiff', () => {
    const base = (over: Partial<StoredProduct> = {}): StoredProduct => ({
        ...emptyProduct(),
        sku: 'A',
        name: 'Produkt A',
        packGrams: 1000,
        priceCzk: 100,
        ...over,
    });

    it('nová SKU je ADDED', () => {
        const diff = computeDiff([], [], [base({ sku: 'NEW' })]);
        expect(diff).toEqual([{ sku: 'NEW', name: 'Produkt A', kind: 'ADDED' }]);
    });

    it('změna ceny je CHANGED s uvedením staré a nové hodnoty', () => {
        const diff = computeDiff([base()], ['A'], [base({ priceCzk: 129 })]);
        expect(diff).toHaveLength(1);
        expect(diff[0].kind).toBe('CHANGED');
        expect(diff[0].changes).toEqual([{ field: 'priceCzk', from: 100, to: 129 }]);
    });

    it('beze změny nevrací nic — noční běh nesmí hlásit 264 změn', () => {
        const diff = computeDiff([base()], ['A'], [base()]);
        expect(diff).toEqual([]);
    });

    it('haléřový rozdíl v ceně není změna (float)', () => {
        const diff = computeDiff([base({ priceCzk: 100 })], ['A'], [base({ priceCzk: 100.001 })]);
        expect(diff).toEqual([]);
    });

    it('chybějící SKU je REMOVED', () => {
        const diff = computeDiff([base()], ['A'], []);
        expect(diff).toEqual([{ sku: 'A', name: 'Produkt A', kind: 'REMOVED' }]);
    });

    it('změna dostupnosti je CHANGED', () => {
        const diff = computeDiff([base({ inStock: true })], ['A'], [base({ inStock: false })]);
        expect(diff[0].changes?.[0].field).toBe('inStock');
    });

    it('řazení je deterministické — dva běhy se dají srovnat', () => {
        const incoming = [base({ sku: 'C' }), base({ sku: 'B' })];
        const a = computeDiff([], [], incoming);
        const b = computeDiff([], [], [...incoming].reverse());
        expect(a).toEqual(b);
    });
});

function emptyProduct(): StoredProduct {
    return {
        sku: '',
        name: '',
        url: '',
        categoryPath: null,
        group: 'MUSCLE',
        packGrams: 1000,
        packGramsSource: 'DATALAYER',
        priceCzk: 100,
        priceId: null,
        productId: null,
        inStock: true,
        stockQuantity: 10,
        ingredientIds: [],
        isCooked: false,
        weightConflict: null,
        sourceFeedAt: null,
    };
}
