/**
 * Ověří, že se `priceId` skutečně čte z detailu produktu.
 *
 * `priceId` je nutné pro `/action/Cart/addCartItem/` — bez něj nejde
 * produkt vložit do košíku a tlačítko „Vložit vše" by nefungovalo.
 * V `dataLayer` NENÍ, je v hidden inputu formuláře.
 *
 *   npx tsx scripts/overit-priceid.ts
 */

import { parseProductPage } from '../src/adapters/tutani-catalog/parseProductPage.js';

const URLS = [
    'https://obchod.tutani.cz/svalovina-2/hovezi-svalovina/',
    'https://obchod.tutani.cz/prilohy/barf-mrkev-500g/',
    'https://obchod.tutani.cz/mrazene-maso/barf-pasikova-jatra-mleta-1kg/',
    'https://obchod.tutani.cz/barf-na-cesty/max-deluxe-kostky-hovezi-svaloviny-800g/',
];

async function main() {
    let chybi = 0;
    for (const u of URLS) {
        try {
            const res = await fetch(u, {
                headers: { 'User-Agent': 'L-Code-Dynamics-BARF-Configurator/1.0 (+tutani.cz)' },
                signal: AbortSignal.timeout(25_000),
            });
            const p = parseProductPage(await res.text(), u);
            if (!p) {
                console.log(`  ${u} — nebyl detail produktu`);
                continue;
            }
            if (!p.priceId) chybi++;
            console.log(
                `  ${p.sku.padEnd(9)} productId=${String(p.productId).padEnd(6)} ` +
                `priceId=${String(p.priceId ?? 'CHYBÍ').padEnd(7)} ${p.name.slice(0, 40)}`
            );
        } catch (e) {
            console.log(`  ${u} — chyba: ${e instanceof Error ? e.message : e}`);
            chybi++;
        }
    }
    console.log(chibiText(chybi));
    if (chybi > 0) process.exit(1);
}

const chibiText = (n: number) =>
    n === 0
        ? '\n  Všechny produkty mají priceId — košík bude fungovat.'
        : `\n  ${n} produktů bez priceId — tyhle by se do košíku nevložily.`;

main();
