/**
 * DRY-RUN SYNCHRONIZACE — spustí `syncCatalog` proti reálnému e-shopu
 * a vypíše diff. NIC nezapíše.
 *
 * Pravidlo L-Code „dry-run first": než noční cron pustíme naostro,
 * musí být diff vidět a schválený.
 *
 * Spuštění:
 *   npx tsx scripts/sync-dry-run.ts             # celý katalog
 *   npx tsx scripts/sync-dry-run.ts --limit 40  # vzorek
 *   SHOPTET_EXPORT_URL='…productsComplete.xml?…&hash=…' npx tsx scripts/sync-dry-run.ts
 *                                               # s admin XML exportem (URL se nevypisuje)
 *
 * Store je TADY v paměti — skript nemá D1 binding a ani ho nechceme:
 * dry-run se nesmí dotknout produkční databáze. Diff je proto vždy
 * proti PRÁZDNÉMU katalogu (všechno je ADDED); smysl je ukázat, co
 * a v jaké kvalitě by se zapsalo.
 */

import { writeFileSync } from 'node:fs';
import { syncCatalog } from '../src/adapters/tutani-catalog/syncCatalog.js';
import { TUTANI_TENANT } from '../tenants/tutani/config/tenant.js';
import type {
    CatalogHealth,
    ProductStore,
    StoredProduct,
    SyncRunRecord,
} from '../src/infrastructure/D1ProductStore.js';

/** Store v paměti — potvrzuje, že dry-run nikam nezapisuje. */
class InMemoryStore implements ProductStore {
    public readonly syncRuns: SyncRunRecord[] = [];
    public readonly writes: StoredProduct[] = [];
    async listByGroup(): Promise<StoredProduct[]> { return []; }
    async listUsable(): Promise<StoredProduct[]> { return []; }
    async listAllSkus(): Promise<string[]> { return []; }
    async upsertMany(_t: string, p: StoredProduct[]): Promise<number> { this.writes.push(...p); return p.length; }
    async deleteBySkus(): Promise<number> { return 0; }
    async recordSyncRun(_t: string, run: SyncRunRecord): Promise<void> { this.syncRuns.push(run); }
    async health(): Promise<CatalogHealth> { return { productCount: 0, usableCount: 0, lastSync: null }; }
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const limitIdx = args.indexOf('--limit');
    const limitUrls = limitIdx !== -1 ? Number(args[limitIdx + 1]) : undefined;
    const jsonIdx = args.indexOf('--json');
    const jsonOut = jsonIdx !== -1 ? args[jsonIdx + 1] : null;

    console.log('DRY-RUN SYNCHRONIZACE KATALOGU — nic se nezapisuje\n');
    console.log(`tenant:  ${TUTANI_TENANT.tenantId} (${TUTANI_TENANT.displayName})`);
    console.log(`e-shop:  ${TUTANI_TENANT.catalog.baseUrl}`);
    console.log(`sitemap: ${TUTANI_TENANT.catalog.sitemapUrl}`);
    if (limitUrls) console.log(`limit:   ${limitUrls} URL (vzorek)`);
    // Jen ANO/NE — URL obsahuje přístupový hash k nákupním cenám.
    console.log(`export:  ${process.env.SHOPTET_EXPORT_URL ? 'ANO (admin XML)' : 'NE (jen scraper)'}`);
    console.log();

    const store = new InMemoryStore();
    const started = Date.now();
    const result = await syncCatalog(TUTANI_TENANT, store, {
        dryRun: true,
        triggerSource: 'MANUAL',
        limitUrls,
        exportUrl: process.env.SHOPTET_EXPORT_URL ?? null,
    });
    const seconds = Math.round((Date.now() - started) / 100) / 10;

    const run = result.run;
    console.log('\n=== BĚH ===');
    console.log(`  stav:                 ${run.status}`);
    console.log(`  doba:                 ${seconds} s`);
    console.log(`  URL celkem:           ${run.urlsTotal}`);
    console.log(`  načteno:              ${run.urlsFetched}`);
    console.log(`  selhalo:              ${run.urlsFailed}`);
    console.log(`  produktů přečteno:    ${run.productsParsed}`);
    if (run.errorText) console.log(`  chyba:                ${run.errorText}`);

    console.log('\n=== DIFF (co by se zapsalo) ===');
    console.log(`  přidat:      ${run.added}`);
    console.log(`  změnit:      ${run.changed}`);
    console.log(`  nezměněno:   ${run.unchanged}`);
    console.log(`  odebrat:     ${run.removed}`);
    console.log(`  nepoužitelné: ${run.unusable}   ← do doporučení nevstoupí`);

    // Košík: každý produkt musí mít OBĚ id (Lucky 2026-09-24).
    console.log('\n=== ID PRO KOŠÍK (priceId + productId) ===');
    const oba = result.products.filter((p) => p.priceId && p.productId).length;
    console.log(`  obě id:        ${oba} / ${result.products.length}`);
    console.log(`  bez priceId:   ${result.products.filter((p) => !p.priceId).length}`);
    console.log(`  bez productId: ${result.products.filter((p) => !p.productId).length}`);
    console.log(`  variant:       ${result.products.filter((p) => p.parentCode).length}`);
    const exp = (result.run.diffSummary as { export?: { idMismatches: unknown[]; exportOnlyInStock: { code: string; name: string; stockQuantity: number }[]; unmatchedScraped: string[] } } | undefined)?.export;
    if (exp) {
        console.log(`  rozpor web×XML: ${exp.idMismatches.length}`);
        for (const m of exp.idMismatches.slice(0, 20)) console.log(`    ${JSON.stringify(m)}`);
        console.log(`\n=== SKLADEM V EXPORTU, ALE NA WEBU NENALEZENO (${exp.exportOnlyInStock.length}) ===`);
        for (const e of exp.exportOnlyInStock.slice(0, 30)) console.log(`  ${e.code.padEnd(10)} ${String(e.stockQuantity).padStart(4)} ks  ${e.name.slice(0, 60)}`);
        console.log(`\n  scraper bez páru v exportu: ${exp.unmatchedScraped.length} ${exp.unmatchedScraped.slice(0, 10).join(', ')}`);
    }

    // Rozpad do skupin: kontrola, že mapování kategorií funguje.
    console.log('\n=== ROZPAD DO BARF SKUPIN ===');
    const groups = new Map<string, number>();
    const usableGroups = new Map<string, number>();
    for (const p of result.products) {
        groups.set(p.group, (groups.get(p.group) ?? 0) + 1);
        if (p.packGrams !== null && p.priceCzk > 0) {
            usableGroups.set(p.group, (usableGroups.get(p.group) ?? 0) + 1);
        }
    }
    console.log('  skupina      celkem  použitelných');
    for (const [g, n] of [...groups].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${g.padEnd(12)} ${String(n).padStart(5)}  ${String(usableGroups.get(g) ?? 0).padStart(11)}`);
    }

    // Gramáž: odkud se vzala. `RESOLVED_PRICE` = rozhodl rozpor cenou.
    console.log('\n=== ZDROJ GRAMÁŽE ===');
    const sources = new Map<string, number>();
    for (const p of result.products) {
        sources.set(p.packGramsSource ?? 'CHYBÍ', (sources.get(p.packGramsSource ?? 'CHYBÍ') ?? 0) + 1);
    }
    for (const [s, n] of [...sources].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${s.padEnd(16)} ${String(n).padStart(4)}`);
    }

    const conflicts = result.products.filter((p) => p.weightConflict !== null);
    if (conflicts.length > 0) {
        console.log(`\n=== ROZPOR V GRAMÁŽI (${conflicts.length}) — klient má opravit v adminu ===`);
        for (const p of conflicts.slice(0, 30)) {
            const c = p.weightConflict!;
            const decided = c.decidedGrams === null ? 'NEVYŘEŠENO' : `${c.decidedGrams} g (${c.source})`;
            console.log(`  ${p.sku.padEnd(9)} admin ${String(c.authoritative).padStart(5)} g vs. název ${String(c.fromName).padStart(5)} g → ${decided}`);
            console.log(`            ${p.name.slice(0, 70)}`);
        }
    }

    if (result.unusable.length > 0) {
        console.log(`\n=== NEPOUŽITELNÉ PRODUKTY (${result.unusable.length}) ===`);
        for (const u of result.unusable.slice(0, 25)) {
            console.log(`  ${u.sku.padEnd(9)} ${u.name.slice(0, 46).padEnd(48)} ${u.reasonCs.slice(0, 70)}`);
        }
    }

    if (result.failedUrls.length > 0) {
        console.log(`\n=== NEPODAŘILO SE NAČÍST (${result.failedUrls.length}) ===`);
        for (const u of result.failedUrls.slice(0, 15)) console.log(`  ${u}`);
    }

    console.log('\n=== VZOREK PRODUKTŮ K ZÁPISU ===');
    for (const p of result.products.slice(0, 12)) {
        console.log(
            `  ${p.sku.padEnd(8)} ${String(p.priceCzk).padStart(6)} Kč  ` +
            `${String(p.packGrams ?? '?').padStart(5)} g  ${p.group.padEnd(10)} ` +
            `${p.inStock ? 'skladem  ' : 'nedostupné'} ${p.name.slice(0, 40)}`
        );
    }

    if (jsonOut) {
        writeFileSync(jsonOut, JSON.stringify({ run, diff: result.diff, products: result.products }, null, 2), 'utf-8');
        console.log(`\nJSON zapsán: ${jsonOut}`);
    }

    console.log(`\nZápisů do databáze: ${store.writes.length} (dry-run — nic se nezapsalo)`);
}

main().catch((e) => {
    console.error('SELHALO:', e instanceof Error ? e.message : e);
    process.exit(1);
});
