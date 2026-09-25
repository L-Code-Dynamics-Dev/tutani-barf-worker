/**
 * RYCHLÝ SYNC SKLADU — každých 10 minut z admin exportu.
 *
 * ZADÁNÍ (Lucky 2026-09-24): konfigurátor musí VŽDY pracovat s aktuální
 * skladovostí a momentální zásobou. Plný sync (300+ stránek) běží jednou
 * denně; sklad se ale mění v průběhu dne. Export je jeden request
 * (ověřeno: generuje se živě, `no-store`, ~1,9 s), takže se dá volat
 * často, aniž by e-shop klienta něco poznal.
 *
 * CO MĚNÍ: jen `stock_quantity`, `in_stock`, `visible`, `stock_synced_at`
 * u EXISTUJÍCÍCH produktů. Cenu NEMĚNÍ — web ukazuje akční cenu, export
 * ceníkovou (viz `mergeExport.ts`); cenu drží noční sync z webu. Nový
 * produkt nepřidává — bez detailu nemá `price_id` a do košíku nejde.
 *
 * POJISTKY (threat model):
 *   - export se nepodaří stáhnout / nejde přečíst → nic se nezmění,
 *     sklad zůstane z posledního úspěšného běhu, `stock_synced_at`
 *     zestárne a API to přizná (`skladAktualizovan`).
 *   - export obsahuje podezřele málo známých SKU (< 50 %) → běh se
 *     přeruší. Chrání před šablonou exportu, která by omylem vracela
 *     jen část produktů — jinak by zbytek „zůstal skladem" se starým
 *     číslem, ale hlavně by se to nikdo nedozvěděl.
 *   - produkt z D1, který v exportu chybí, se NENULUJE — chybějící řádek
 *     neznamená „vyprodáno" (R7). Nahlásí se v logu.
 */

import type { ProductStore, StockUpdate } from '../../infrastructure/D1ProductStore.js';
import { parseProductsCompleteXml } from './parseProductsCompleteXml.js';
import { fetchExportWithRetry } from '../tutani-catalog/syncCatalog.js';

export interface StockSyncOptions {
    exportUrl: string;
    dryRun: boolean;
    fetchImpl?: typeof fetch;
    now?: () => Date;
    retries?: number;
}

export interface StockSyncResult {
    status: 'OK' | 'FAILED';
    /** Kolik produktů se změnilo (u dry-runu kolik BY se změnilo). */
    changed: number;
    /** Známé SKU, které v exportu nejsou — nenulují se. */
    missingInExport: string[];
    /** Změny skladu pro audit — jen ty, kde se číslo liší. */
    changes: { sku: string; from: number | null; to: number }[];
    errorText: string | null;
    syncedAt: string;
}

const MIN_MATCH_RATIO = 0.5;

export async function syncStock(
    tenantId: string,
    store: ProductStore,
    options: StockSyncOptions
): Promise<StockSyncResult> {
    const now = options.now ?? (() => new Date());
    const syncedAt = now().toISOString();
    const doFetch = options.fetchImpl ?? fetch;
    const fail = (errorText: string): StockSyncResult => {
        console.error(JSON.stringify({ level: 'error', event: 'stock_sync.failed', tenantId, errorText }));
        return { status: 'FAILED', changed: 0, missingInExport: [], changes: [], errorText, syncedAt };
    };

    if (!store.updateStock || !store.listStockState) return fail('store neumí updateStock/listStockState');

    // URL se neloguje — obsahuje přístupový hash.
    const xml = await fetchExportWithRetry(options.exportUrl, doFetch, options.retries ?? 3);
    if (xml === null) return fail('export se nepodařilo stáhnout');

    let exported;
    try {
        exported = parseProductsCompleteXml(xml).products;
    } catch (e) {
        return fail(`export nejde přečíst: ${e instanceof Error ? e.message : String(e)}`);
    }

    let current;
    try {
        current = await store.listStockState!(tenantId);
    } catch (e) {
        return fail(`nelze načíst stav katalogu: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (current.length === 0) {
        // Prázdná D1 = ještě neproběhl plný sync. Není co aktualizovat,
        // není to chyba.
        return { status: 'OK', changed: 0, missingInExport: [], changes: [], errorText: null, syncedAt };
    }

    const byCode = new Map(exported.map((e) => [e.code, e]));
    const updates: StockUpdate[] = [];
    const changes: StockSyncResult['changes'] = [];
    const missingInExport: string[] = [];

    for (const c of current) {
        const e = byCode.get(c.sku);
        if (!e || e.stockQuantity === null) {
            missingInExport.push(c.sku);
            continue;
        }
        updates.push({ sku: c.sku, stockQuantity: e.stockQuantity, priceCzk: null, visible: e.visible });
        if (c.stockQuantity !== e.stockQuantity || c.visible !== e.visible) {
            changes.push({ sku: c.sku, from: c.stockQuantity, to: e.stockQuantity });
        }
    }

    const matchRatio = updates.length / current.length;
    if (matchRatio < MIN_MATCH_RATIO) {
        return fail(
            `export pokrývá jen ${updates.length} z ${current.length} produktů (${Math.round(matchRatio * 100)} %) — sklad nezměněn`
        );
    }

    const changed = changes.length;
    if (!options.dryRun) {
        try {
            // Zapisují se VŠECHNY spárované (i beze změny), aby se posunulo
            // `stock_synced_at` = „tohle číslo je potvrzené teď".
            await store.updateStock!(tenantId, updates, syncedAt);
        } catch (e) {
            return fail(`zápis skladu do D1 selhal: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    console.log(
        JSON.stringify({
            level: 'info',
            event: 'stock_sync.done',
            tenantId,
            mode: options.dryRun ? 'DRY_RUN' : 'LIVE',
            matched: updates.length,
            changed,
            missingInExport: missingInExport.length,
            sampleMissing: missingInExport.slice(0, 10),
        })
    );
    return { status: 'OK', changed, missingInExport, changes, errorText: null, syncedAt };
}
