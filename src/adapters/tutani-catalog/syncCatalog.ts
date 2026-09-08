/**
 * SYNCHRONIZACE KATALOGU — sitemap → produktová URL → parse →
 * vyřešení gramáže → `StoredProduct` → D1.
 *
 * DRY-RUN FIRST (pravidlo L-Code): `dryRun: true` NIC nezapíše
 * a vrátí diff — co by se přidalo, změnilo, odebralo a co je
 * nepoužitelné. Ostrý běh se pouští teprve na schválený diff.
 *
 * ŠETRNOST K E-SHOPU KLIENTA: e-shop je v provozu a scraper na něm
 * nesmí být vidět. Proto `concurrency` 4, rozestup mezi dávkami
 * a retry s narůstajícím odstupem. Přednost má dokončit běh pomalu
 * před tím shodit klientovi e-shop.
 *
 * NEHÁDÁ SE (R7): produkt bez gramáže nebo s nevyřešeným rozporem se
 * uloží, ale jako nepoužitelný — do doporučení nevstoupí a v reportu
 * je vidět, aby to klient opravil v adminu.
 *
 * Funkce je bez závislosti na Node API, aby ji volal jak Cron handler
 * ve Workeru, tak dry-run skript pod tsx.
 */

import type { BarfGroup, TenantConfiguration } from '../../domain/tenant.js';
import type { ProductStore, StoredProduct, SyncRunRecord } from '../../infrastructure/D1ProductStore.js';
import { parseProductPage, resolveBarfGroup, type ScrapedProduct } from './parseProductPage.js';
import { medianPricePerKg, resolveWeightConflict } from './resolveWeightConflict.js';
import { detectIngredients } from './detectIngredients.js';
import { parseUniversalFeed, universalFeedUrl, type FeedDescriptions } from './universalFeed.js';
import { parseCompositionParts } from './parseComposition.js';

export interface SyncOptions {
    /** `true` = nic se nezapíše, vrátí se jen diff. */
    dryRun: boolean;
    triggerSource: SyncRunRecord['triggerSource'];
    /** Omezí počet URL — pro rychlý dry-run vzorek. */
    limitUrls?: number;
    /** Kolik URL se stahuje současně. Šetrnost k e-shopu klienta. */
    concurrency?: number;
    /** Rozestup mezi dávkami v ms. */
    delayMs?: number;
    /** Kolikrát se zkusí neúspěšné URL. */
    retries?: number;
    /** Injektovatelný fetch — kvůli testovatelnosti bez sítě. */
    fetchImpl?: typeof fetch;
    /** Injektovatelný čas — kvůli deterministickým testům. */
    now?: () => Date;
}

/** Jedna změna v diffu. Uchovává jen to, co se reálně změnilo. */
export interface ProductDiff {
    sku: string;
    name: string;
    kind: 'ADDED' | 'CHANGED' | 'REMOVED';
    /** U CHANGED: co se změnilo, staré → nové. */
    changes?: { field: string; from: unknown; to: unknown }[];
}

export interface UnusableProduct {
    sku: string;
    name: string;
    reasonCs: string;
}

export interface SyncResult {
    run: SyncRunRecord;
    diff: ProductDiff[];
    unusable: UnusableProduct[];
    /** Produkty připravené k zápisu (u dry-runu nezapsané). */
    products: StoredProduct[];
    /** URL, které se nepodařilo načíst — nesmí zmizet v tichu. */
    failedUrls: string[];
}

const DEFAULT_CONCURRENCY = 4;
const DEFAULT_DELAY_MS = 150;
const DEFAULT_RETRIES = 3;
const FETCH_TIMEOUT_MS = 25_000;

/**
 * Identifikace scraperu. E-shop klienta má v logu vidět, kdo chodí —
 * anonymní scraper na cizím e-shopu je nepřijatelný.
 */
const USER_AGENT = 'L-Code-Dynamics-BARF-Configurator/1.0 (+https://tutani.cz)';

/**
 * Kolik změn se vejde do `diff_summary` v auditu. Celý diff se do
 * jednoho řádku D1 nevejde a audit není záloha katalogu — ukládá se
 * agregace a vzorek.
 */
const DIFF_SAMPLE_SIZE = 40;

/**
 * Které atributy rozhodují, že se produkt „změnil".
 *
 * `updated_at` mezi nimi ZÁMĚRNĚ není — jinak by každý noční běh
 * hlásil změnu u všech 264 produktů a diff by přestal být k něčemu.
 */
const TRACKED_FIELDS: (keyof StoredProduct)[] = [
    'name',
    'priceCzk',
    'packGrams',
    'group',
    'inStock',
    'stockQuantity',
    'priceId',
    'productId',
    'isCooked',
    'categoryPath',
];

export async function syncCatalog(
    tenant: TenantConfiguration,
    store: ProductStore,
    options: SyncOptions
): Promise<SyncResult> {
    const now = options.now ?? (() => new Date());
    const startedAt = now().toISOString();
    const runId = `${tenant.tenantId}-${startedAt}-${options.dryRun ? 'dry' : 'live'}`;
    const doFetch = options.fetchImpl ?? fetch;
    const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    const delayMs = options.delayMs ?? DEFAULT_DELAY_MS;
    const retries = options.retries ?? DEFAULT_RETRIES;

    const log = (event: string, data: Record<string, unknown> = {}) => {
        // Strukturovaný log: chyba musí být čitelná bez dolování.
        console.log(
            JSON.stringify({
                level: 'info',
                event,
                runId,
                tenantId: tenant.tenantId,
                mode: options.dryRun ? 'DRY_RUN' : 'LIVE',
                ...data,
            })
        );
    };

    const emptyRun = (status: SyncRunRecord['status'], errorText?: string): SyncRunRecord => ({
        id: runId,
        mode: options.dryRun ? 'DRY_RUN' : 'LIVE',
        triggerSource: options.triggerSource,
        startedAt,
        finishedAt: now().toISOString(),
        status,
        urlsTotal: 0,
        urlsFetched: 0,
        urlsFailed: 0,
        productsParsed: 0,
        added: 0,
        changed: 0,
        unchanged: 0,
        removed: 0,
        unusable: 0,
        errorText: errorText ?? null,
    });

    // ---- 1. SITEMAP ----
    if (!tenant.catalog.sitemapUrl) {
        // Konfigurační chyba, ne provozní. Hlásí se jako FAILED.
        const run = emptyRun('FAILED', 'tenant nemá nastavené `catalog.sitemapUrl`');
        await safeRecord(store, tenant.tenantId, run, log);
        return { run, diff: [], unusable: [], products: [], failedUrls: [] };
    }

    let urls: string[];
    try {
        urls = await loadProductUrls(tenant.catalog.sitemapUrl, doFetch, retries);
    } catch (e) {
        const run = emptyRun('FAILED', `sitemap se nepodařilo načíst: ${errMsg(e)}`);
        log('sync.sitemap_failed', { error: errMsg(e) });
        await safeRecord(store, tenant.tenantId, run, log);
        return { run, diff: [], unusable: [], products: [], failedUrls: [] };
    }

    if (options.limitUrls !== undefined) urls = urls.slice(0, options.limitUrls);
    log('sync.started', { urlsTotal: urls.length });

    /**
     * ---- 1b. POPISY Z `universal.xml` ----
     *
     * Veřejný feed Shoptetu (bez hashe) nese popis u 100 % produktů,
     * zatímco detail jen u 17 %. Používá se VÝHRADNĚ k určení surovin
     * pro filtr alergií — SKU, `priceId` ani sklad ve feedu nejsou,
     * takže scraper nenahrazuje.
     *
     * Selhání feedu sync NESMÍ zastavit: je to obohacení, ne zdroj
     * pravdy. Bez něj se suroviny určí jen z názvu a detailu, což je
     * horší, ale funkční — a `ingredientsUnknown` to přizná.
     */
    let feedPopisy: FeedDescriptions = new Map();
    try {
        const feedUrl = universalFeedUrl(tenant.catalog.baseUrl);
        const xml = await fetchWithRetry(feedUrl, doFetch, retries);
        if (xml) {
            feedPopisy = parseUniversalFeed(xml);
            log('sync.feed_loaded', { url: feedUrl, descriptions: feedPopisy.size });
        } else {
            log('sync.feed_unavailable', { url: feedUrl });
        }
    } catch (e) {
        log('sync.feed_failed', { error: errMsg(e) });
    }

    // ---- 2. STAŽENÍ A PARSOVÁNÍ ----
    const scraped: ScrapedProduct[] = [];
    const failedUrls: string[] = [];
    let notProductPages = 0;

    for (let i = 0; i < urls.length; i += concurrency) {
        const batch = urls.slice(i, i + concurrency);
        const results = await Promise.all(
            batch.map(async (url) => {
                const html = await fetchWithRetry(url, doFetch, retries);
                if (html === null) return { url, kind: 'FAILED' as const };
                const parsed = parseProductPage(html, url);
                return parsed
                    ? { url, kind: 'OK' as const, product: parsed }
                    : { url, kind: 'NOT_PRODUCT' as const };
            })
        );
        for (const r of results) {
            if (r.kind === 'OK') scraped.push(r.product);
            else if (r.kind === 'NOT_PRODUCT') notProductPages++;
            else failedUrls.push(r.url);
        }
        if (i + concurrency < urls.length && delayMs > 0) await sleep(delayMs);
    }

    log('sync.scraped', {
        parsed: scraped.length,
        notProductPages,
        failed: failedUrls.length,
    });

    /**
     * BEZPEČNOSTNÍ POJISTKA: když se nepodařilo přečíst skoro nic
     * (e-shop je dole, změnila se struktura stránky), NESMÍ se ostrý
     * běh dopočítat na „katalog má 3 produkty a zbytek odeber".
     * Prázdný katalog by konfigurátoru vzal všechna doporučení.
     */
    if (!options.dryRun && scraped.length === 0) {
        const run = emptyRun(
            'FAILED',
            `z ${urls.length} URL se nepodařilo přečíst ani jeden produkt — katalog zůstal nezměněn`
        );
        run.urlsTotal = urls.length;
        run.urlsFailed = failedUrls.length;
        log('sync.aborted_empty_catalog', { urlsTotal: urls.length });
        await safeRecord(store, tenant.tenantId, run, log);
        return { run, diff: [], unusable: [], products: [], failedUrls };
    }

    // ---- 3. GRAMÁŽ A ZAŘAZENÍ ----
    const groupOf = (p: ScrapedProduct): BarfGroup =>
        resolveBarfGroup(p.categoryPath, tenant.categoryMap, p.name);

    // Medián ceny za kg se počítá jednou pro každou skupinu — je to
    // referenční hodnota pro rozhodování rozporů v gramáži.
    const medians = new Map<BarfGroup, number | null>();
    const allGroups: BarfGroup[] = ['MUSCLE', 'BONE', 'LIVER', 'ORGAN', 'PLANT', 'SUPPLEMENT', 'OTHER'];
    for (const g of allGroups) medians.set(g, medianPricePerKg(scraped, groupOf, g));

    const sourceFeedAt = now().toISOString();
    const products: StoredProduct[] = [];
    const unusable: UnusableProduct[] = [];

    for (const p of scraped) {
        const group = groupOf(p);
        const decision = resolveWeightConflict(p, medians.get(group) ?? null);

        let packGrams: number | null = null;
        let packGramsSource: StoredProduct['packGramsSource'] = null;
        let weightConflict: StoredProduct['weightConflict'] = null;

        if (decision.kind === 'NO_CONFLICT') {
            packGrams = decision.grams;
            packGramsSource = p.packGramsSource;
        } else if (decision.kind === 'RESOLVED') {
            packGrams = decision.grams;
            // Gramáž rozhodla cena, ne původní zdroj — zapisuje se to,
            // aby bylo při reklamaci dohledatelné proč.
            packGramsSource = 'RESOLVED_PRICE';
            weightConflict = {
                authoritative: p.packGramsConflict!.authoritative,
                fromName: p.packGramsConflict!.fromName,
                decidedGrams: decision.grams,
                source: decision.source,
                reasonCs: decision.reasonCs,
            };
        } else {
            // UNRESOLVED: produkt se ULOŽÍ bez gramáže. Do doporučení
            // nevstoupí (filtr `pack_grams IS NOT NULL`), ale klient ho
            // vidí v reportu a může to opravit.
            unusable.push({ sku: p.sku, name: p.name, reasonCs: decision.reasonCs });
            if (p.packGramsConflict) {
                weightConflict = {
                    authoritative: p.packGramsConflict.authoritative,
                    fromName: p.packGramsConflict.fromName,
                    decidedGrams: null,
                    source: null,
                    reasonCs: decision.reasonCs,
                };
            }
        }

        if (p.priceWithVat === null && packGrams !== null) {
            unusable.push({ sku: p.sku, name: p.name, reasonCs: 'produkt nemá cenu' });
        }

        /**
         * Suroviny se odvodí JEDNOU — `detectIngredients` prochází
         * ~30 vzorů a volat ho dvakrát na 264 produktů je zbytečné.
         *
         * Popis z `universal.xml` se přidává ke složení z detailu:
         * detail ho má jen u 17 % produktů, feed u 100 %, takže
         * určení surovin stoupne ze 61 % na 70 % (změřeno 2026-09-09).
         */
        const popisFeed = feedPopisy.get(p.url);
        const suroviny = detectIngredients(
            p.name,
            [p.compositionText, popisFeed].filter(Boolean).join(' ')
        );

        products.push({
            sku: p.sku,
            name: p.name,
            url: p.url,
            categoryPath: p.categoryPath,
            group,
            packGrams,
            packGramsSource,
            priceCzk: p.priceWithVat ?? 0,
            /**
             * `priceId` z hidden inputu formuláře na detailu produktu
             * (doplněno 2026-09-09). V `dataLayer` není, ale v HTML ano:
             * `<input type="hidden" name="priceId" value="973">`.
             * Bez něj nejde produkt vložit do košíku.
             *
             * POZOR u variantních produktů: hodnotu tam přepisuje JS
             * podle vybrané varianty, takže platí jen pro výchozí.
             * Dnes to nevadí — žádný produkt tutani varianty nemá — ale
             * `hasVariants` se ukládá a sync na výskyt upozorní.
             */
            priceId: p.priceId,
            hasVariants: p.hasVariants,
            /**
             * Rozpad podle procent ve složení — u produktů jako
             * „70 % ořez, 30 % droby" jinak celý objem padne do jedné
             * skupiny a zdravotní limit na játra ho mine.
             */
            compositionParts: parseCompositionParts(
                [p.compositionText, popisFeed].filter(Boolean).join(' ')
            ),
            productId: p.productId,
            inStock: (p.stockQuantity ?? 0) > 0,
            stockQuantity: p.stockQuantity,
            /**
             * Suroviny pro filtr alergií a toxických potravin.
             *
             * KRITICKÝ NÁLEZ AUDITU 2026-09-09: dřív tu bylo natvrdo
             * `[]`, takže filtr v `matchProducts` neměl na čem pracovat
             * — psovi s alergií na kuře se doporučilo kuřecí maso
             * a cibule se nabízela každému, přičemž API hlásilo
             * `knowledgeEngineReady: true`. Systém tvrdil, že alergii
             * vyhodnotil, a nevyhodnotil ji.
             *
             * Suroviny se teď odvozují z názvu a složení produktu
             * (`detectIngredients`). Je to heuristika nad reálnými
             * daty, ne odhad chybějících: co se nepozná, zůstane
             * nezařazené a produkt se u zadané alergie NEDOPORUČÍ
             * (fail-closed) — viz `ingredientsUnknown`.
             */
            ingredientIds: suroviny,
            /**
             * `true` = surovinu nelze z dat určit. `matchProducts` pak
             * produkt u zadané alergie vyřadí, místo aby předstíral,
             * že je bezpečný.
             */
            ingredientsUnknown: suroviny.length === 0,
            // Vařené produkty katalog neoznačuje; zůstává `false` a řeší
            // to znalostní vrstva podle složení.
            isCooked: false,
            weightConflict,
            sourceFeedAt,
        });
    }

    // ---- 4. DIFF PROTI SOUČASNÉMU STAVU ----
    const existing = await store.listUsable(tenant.tenantId).catch((e) => {
        log('sync.load_existing_failed', { error: errMsg(e) });
        return [] as StoredProduct[];
    });
    const allSkus = await store.listAllSkus(tenant.tenantId).catch(() => [] as string[]);

    const diff = computeDiff(existing, allSkus, products);
    const added = diff.filter((d) => d.kind === 'ADDED').length;
    const changed = diff.filter((d) => d.kind === 'CHANGED').length;
    const removed = diff.filter((d) => d.kind === 'REMOVED').length;

    const run: SyncRunRecord = {
        id: runId,
        mode: options.dryRun ? 'DRY_RUN' : 'LIVE',
        triggerSource: options.triggerSource,
        startedAt,
        finishedAt: null,
        // PARTIAL = část URL selhala, ale katalog je použitelný. Rozdíl
        // proti FAILED je podstatný: PARTIAL data se zapsat mají.
        status: failedUrls.length > 0 ? 'PARTIAL' : 'OK',
        urlsTotal: urls.length,
        urlsFetched: scraped.length + notProductPages,
        urlsFailed: failedUrls.length,
        productsParsed: scraped.length,
        added,
        changed,
        unchanged: products.length - added - changed,
        removed,
        unusable: unusable.length,
        diffSummary: {
            added,
            changed,
            removed,
            unusable: unusable.length,
            sample: diff.slice(0, DIFF_SAMPLE_SIZE),
            failedUrls: failedUrls.slice(0, 20),
        },
        errorText: null,
    };

    // ---- 5. ZÁPIS (jen ostrý běh) ----
    if (options.dryRun) {
        run.finishedAt = now().toISOString();
        log('sync.dry_run_finished', { added, changed, removed, unusable: unusable.length });
        await safeRecord(store, tenant.tenantId, run, log);
        return { run, diff, unusable, products, failedUrls };
    }

    try {
        const written = await store.upsertMany(tenant.tenantId, products);

        /**
         * ODEBRÁNÍ jen při ÚPLNÉM běhu. Když část URL selhala nebo byl
         * běh omezený `limitUrls`, chybějící SKU neznamená „už se
         * neprodává" — znamená „nepřečetli jsme ho". Smazat by ho bylo
         * hádání (R7).
         */
        const removedSkus = diff.filter((d) => d.kind === 'REMOVED').map((d) => d.sku);
        const fullRun = failedUrls.length === 0 && options.limitUrls === undefined;
        let deleted = 0;
        if (fullRun && removedSkus.length > 0) {
            deleted = await store.deleteBySkus(tenant.tenantId, removedSkus);
        } else if (removedSkus.length > 0) {
            run.removed = 0;
            log('sync.removal_skipped', {
                candidates: removedSkus.length,
                reason: fullRun ? 'limitUrls' : 'partial_run',
            });
        }

        run.finishedAt = now().toISOString();
        log('sync.finished', { written, deleted, added, changed, removed: run.removed });
    } catch (e) {
        run.status = 'FAILED';
        run.errorText = `zápis do D1 selhal: ${errMsg(e)}`;
        run.finishedAt = now().toISOString();
        log('sync.write_failed', { error: errMsg(e) });
    }

    await safeRecord(store, tenant.tenantId, run, log);
    return { run, diff, unusable, products, failedUrls };
}

/**
 * Diff proti současnému katalogu.
 *
 * `existing` je jen POUŽITELNÁ část katalogu (co se dá doporučit),
 * ale `allSkus` je všechno — jinak by se produkt, který ztratil
 * gramáž, tvářil jako ADDED a zároveň nikdy nezmizel.
 */
export function computeDiff(
    existing: StoredProduct[],
    allSkus: string[],
    incoming: StoredProduct[]
): ProductDiff[] {
    const byExistingSku = new Map(existing.map((p) => [p.sku, p]));
    const knownSkus = new Set(allSkus);
    const incomingSkus = new Set(incoming.map((p) => p.sku));
    const out: ProductDiff[] = [];

    for (const p of incoming) {
        const old = byExistingSku.get(p.sku);
        if (!old) {
            // Není v použitelných. Pokud ho vůbec neznáme → ADDED,
            // jinak se stal použitelným a je to CHANGED.
            out.push({
                sku: p.sku,
                name: p.name,
                kind: knownSkus.has(p.sku) ? 'CHANGED' : 'ADDED',
                ...(knownSkus.has(p.sku)
                    ? { changes: [{ field: 'usable', from: false, to: p.packGrams !== null }] }
                    : {}),
            });
            continue;
        }
        const changes: { field: string; from: unknown; to: unknown }[] = [];
        for (const field of TRACKED_FIELDS) {
            if (!sameValue(old[field], p[field])) {
                changes.push({ field, from: old[field], to: p[field] });
            }
        }
        if (changes.length > 0) out.push({ sku: p.sku, name: p.name, kind: 'CHANGED', changes });
    }

    for (const sku of allSkus) {
        if (!incomingSkus.has(sku)) {
            out.push({ sku, name: byExistingSku.get(sku)?.name ?? '', kind: 'REMOVED' });
        }
    }

    // Deterministické řazení — diff se schvaluje a musí se dát srovnat
    // dvě spuštění vedle sebe.
    return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.sku.localeCompare(b.sku));
}

/**
 * Srovnání hodnot. Ceny se porovnávají s tolerancí na haléř — jinak
 * by float reprezentace hlásila změnu u ceny, která se nezměnila.
 */
function sameValue(a: unknown, b: unknown): boolean {
    if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 0.005;
    return a === b;
}

/** Produktová URL ze sitemap. Kategoriové a informační stránky vypadnou. */
export async function loadProductUrls(
    sitemapUrl: string,
    doFetch: typeof fetch,
    retries: number
): Promise<string[]> {
    const xml = await fetchWithRetry(sitemapUrl, doFetch, retries);
    if (xml === null) throw new Error(`sitemap nedostupná: ${sitemapUrl}`);
    const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
    // Produktová URL mají aspoň dva segmenty (kategorie/produkt).
    // Jednosegmentová jsou kategorie a informační stránky. Ověřeno
    // proti sitemap 2026-09-08 (346 URL).
    return urls.filter((u) => {
        const path = u.replace(/^https?:\/\/[^/]+\/?/, '').replace(/\/$/, '');
        return path.length > 0 && path.split('/').length >= 2;
    });
}

/**
 * Stažení s retry. Defenzivní programování na každém síťovém volání
 * (pravidlo L-Code): timeout, retry s narůstajícím odstupem, 404 se
 * neopakuje (produkt zmizel, to je legitimní odpověď).
 */
async function fetchWithRetry(
    url: string,
    doFetch: typeof fetch,
    tries: number
): Promise<string | null> {
    for (let attempt = 1; attempt <= tries; attempt++) {
        try {
            const res = await doFetch(url, {
                headers: { 'User-Agent': USER_AGENT },
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
            });
            if (res.ok) return await res.text();
            // 404/410 = stránka opravdu není, retry by nic nezměnil.
            if (res.status === 404 || res.status === 410) return null;
            // 429/5xx = přetížení, má smysl počkat a zkusit znovu.
        } catch {
            // Síťová chyba nebo timeout — retry.
        }
        if (attempt < tries) await sleep(400 * attempt);
    }
    console.warn(JSON.stringify({ level: 'warn', event: 'fetch.failed', url, tries }));
    return null;
}

/**
 * Audit běhu nesmí shodit sync. Když se nepodaří zapsat `sync_runs`,
 * je to chyba observability, ne důvod zahodit načtený katalog.
 */
async function safeRecord(
    store: ProductStore,
    tenantId: string,
    run: SyncRunRecord,
    log: (event: string, data?: Record<string, unknown>) => void
): Promise<void> {
    try {
        await store.recordSyncRun(tenantId, run);
    } catch (e) {
        log('sync.audit_write_failed', { error: errMsg(e) });
    }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
}
