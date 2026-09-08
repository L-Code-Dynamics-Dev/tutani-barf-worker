/**
 * DRY-RUN scraperu katalogu Tutani — nic nezapisuje, jen ukáže, co
 * z e-shopu reálně jde přečíst.
 *
 * Pravidlo L-Code „dry-run first": než se katalog nalije do D1, musí
 * být vidět diff/kvalita dat a schválený výsledek.
 *
 * Spuštění:
 *   npx tsx scripts/scrape-dry-run.ts            # vzorek 25 produktů
 *   npx tsx scripts/scrape-dry-run.ts --all      # celý katalog
 *   npx tsx scripts/scrape-dry-run.ts --json out.json
 */

import { writeFileSync } from 'node:fs';
import { parseProductPage, resolveBarfGroup, type ScrapedProduct } from '../src/adapters/tutani-catalog/parseProductPage.js';
import { TUTANI_TENANT } from '../tenants/tutani/config/tenant.js';

const SITEMAP = TUTANI_TENANT.catalog.sitemapUrl!;
const CONCURRENCY = 4;      // šetrné k e-shopu klienta
const DELAY_MS = 120;       // rozestup mezi dávkami

async function fetchText(url: string, tries = 3): Promise<string | null> {
    for (let i = 1; i <= tries; i++) {
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': 'L-Code-Dynamics-BARF-Configurator/1.0 (+tutani.cz)' },
                signal: AbortSignal.timeout(25_000),
            });
            if (res.ok) return await res.text();
            if (res.status === 404) return null;
        } catch {
            // síťová chyba — retry s odstupem
        }
        if (i < tries) await sleep(400 * i);
    }
    return null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loadUrls(): Promise<string[]> {
    const xml = await fetchText(SITEMAP);
    if (!xml) throw new Error(`sitemap se nepodařilo načíst: ${SITEMAP}`);
    const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    // Produktová URL mají aspoň dva segmenty (kategorie/produkt);
    // jednosegmentová jsou kategorie a informační stránky.
    return urls.filter((u) => {
        const path = u.replace(/^https?:\/\/[^/]+\//, '').replace(/\/$/, '');
        return path.split('/').length >= 2;
    });
}

async function main() {
    const args = process.argv.slice(2);
    const all = args.includes('--all');
    const jsonIdx = args.indexOf('--json');
    const jsonOut = jsonIdx !== -1 ? args[jsonIdx + 1] : null;

    console.log('DRY-RUN scraperu katalogu Tutani — nic se nezapisuje\n');
    const urls = await loadUrls();
    const vzorek = all ? urls : urls.slice(0, 25);
    console.log(`produktových URL v sitemap: ${urls.length}`);
    console.log(`zpracuje se:                ${vzorek.length}${all ? ' (vše)' : ' (vzorek, --all pro celý katalog)'}\n`);

    const ok: ScrapedProduct[] = [];
    let neproduktove = 0;
    let chyby = 0;

    for (let i = 0; i < vzorek.length; i += CONCURRENCY) {
        const davka = vzorek.slice(i, i + CONCURRENCY);
        const vysledky = await Promise.all(
            davka.map(async (u) => {
                const html = await fetchText(u);
                if (html === null) return { u, stav: 'CHYBA' as const };
                const p = parseProductPage(html, u);
                return p ? { u, stav: 'OK' as const, p } : { u, stav: 'NEPRODUKT' as const };
            })
        );
        for (const v of vysledky) {
            if (v.stav === 'OK') ok.push(v.p);
            else if (v.stav === 'NEPRODUKT') neproduktove++;
            else chyby++;
        }
        process.stdout.write(`\r  ${Math.min(i + CONCURRENCY, vzorek.length)}/${vzorek.length}`);
        if (i + CONCURRENCY < vzorek.length) await sleep(DELAY_MS);
    }
    console.log('\n');

    // ---- Kvalita dat: to je smysl dry-runu ----
    const bezCeny = ok.filter((p) => p.priceWithVat === null);
    const bezGramaze = ok.filter((p) => p.packGrams === null);
    const bezSlozeni = ok.filter((p) => p.compositionText === null);
    const varianty = ok.filter((p) => p.hasVariants);

    console.log('=== VÝSLEDEK ===');
    console.log(`  produktů přečteno:     ${ok.length}`);
    console.log(`  nebyl detail produktu: ${neproduktove}`);
    console.log(`  chyba načtení:         ${chyby}\n`);

    console.log('=== KVALITA DAT ===');
    tabulka([
        ['cena', ok.length - bezCeny.length, ok.length],
        ['gramáž balení', ok.length - bezGramaze.length, ok.length],
        ['složení', ok.length - bezSlozeni.length, ok.length],
    ]);
    console.log(`  produkty s variantami: ${varianty.length}\n`);

    console.log('=== ZDROJ GRAMÁŽE ===');
    for (const src of ['DATALAYER', 'PARAM', 'NAME'] as const) {
        const n = ok.filter((p) => p.packGramsSource === src).length;
        if (n) console.log(`  ${src.padEnd(10)} ${n}`);
    }
    if (bezGramaze.length) console.log(`  CHYBÍ      ${bezGramaze.length}  ← do doporučení nevstoupí`);
    console.log();

    console.log('=== ROZPAD DO BARF SKUPIN ===');
    const skupiny = new Map<string, number>();
    for (const p of ok) {
        const g = resolveBarfGroup(p.categoryPath, TUTANI_TENANT.categoryMap, p.name);
        skupiny.set(g, (skupiny.get(g) ?? 0) + 1);
    }
    for (const [g, n] of [...skupiny].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${g.padEnd(12)} ${n}`);
    }
    console.log();

    console.log('=== VZOROVÉ PRODUKTY ===');
    for (const p of ok.slice(0, 10)) {
        const g = resolveBarfGroup(p.categoryPath, TUTANI_TENANT.categoryMap, p.name);
        console.log(
            `  ${(p.sku || '-').padEnd(8)} ${String(p.priceWithVat ?? '?').padStart(6)} Kč  ` +
            `${String(p.packGrams ?? '?').padStart(5)} g [${(p.packGramsSource ?? '-').slice(0, 4)}]  ` +
            `${g.padEnd(10)} ${p.name.slice(0, 42)}`
        );
        if (p.compositionText) console.log(`           složení: ${p.compositionText.slice(0, 90)}`);
    }
    console.log();

    if (bezGramaze.length) {
        console.log('=== BEZ GRAMÁŽE (nehádá se, do doporučení nejdou) ===');
        for (const p of bezGramaze.slice(0, 10)) console.log(`  ${p.sku.padEnd(8)} ${p.name.slice(0, 60)}`);
        console.log();
    }

    const konflikty = ok.filter((p) => p.packGramsConflict !== null);
    if (konflikty.length) {
        console.log('=== ROZPOR V GRAMÁŽI — CHYBA V DATECH E-SHOPU ===');
        console.log('  (autoritativní zdroj vs. název; opravit musí klient v adminu)');
        for (const p of konflikty) {
            const c = p.packGramsConflict!;
            console.log(`  ${p.sku.padEnd(9)} admin ${String(c.authoritative).padStart(5)} g  vs.  název ${String(c.fromName).padStart(5)} g   ${p.name.slice(0, 44)}`);
        }
        console.log();
    }

    if (jsonOut) {
        writeFileSync(jsonOut, JSON.stringify(ok, null, 2), 'utf-8');
        console.log(`JSON zapsán: ${jsonOut}`);
    }
    console.log('Nic nebylo zapsáno do databáze (dry-run).');
}

function tabulka(rows: [string, number, number][]) {
    for (const [label, mam, celkem] of rows) {
        const pct = celkem ? Math.round((mam / celkem) * 100) : 0;
        const bar = '█'.repeat(Math.round(pct / 5)).padEnd(20, '░');
        console.log(`  ${label.padEnd(15)} ${bar} ${mam}/${celkem} (${pct} %)`);
    }
}

main().catch((e) => {
    console.error('SELHALO:', e instanceof Error ? e.message : e);
    process.exit(1);
});
