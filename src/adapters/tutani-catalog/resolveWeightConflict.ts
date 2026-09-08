/**
 * Řešení rozporu v gramáži — rozhodnutí CENOU ZA KG.
 *
 * PROBLÉM (dry-run 2026-09-08): u 26 produktů si `dataLayer.weight`
 * (a parametr „Hmotnost") odporuje s gramáží v názvu. 16 z nich patří
 * do krmné dávky — vemínko, dršťky, bachory, droby, chrupavka, mrkev,
 * červená řepa, zeleninová směs. Vyřadit je by znamenalo vyhodit
 * z konfigurátoru zboží, které klient prodává.
 *
 * ŘEŠENÍ (Lucky 2026-09-08): nehádat, ale SPOČÍTAT. Cena za kilogram
 * jednu z variant obvykle vylučuje:
 *
 *   ZP12 „Krájené vemínko 1kg", 50 Kč
 *     1 kg →  50 Kč/kg  ✅ v pásmu skupiny
 *     5 kg →  10 Kč/kg  ❌ nereálně nízko
 *   → použije se 1 kg (z názvu), produkt ZŮSTÁVÁ v doporučeních
 *
 *   TUT196 „Barf Mrkev 500g", 39 Kč
 *     500 g →  78 Kč/kg  ✅
 *     100 g → 390 Kč/kg  ❌ mrkev za 390 Kč/kg nikdo nekoupí
 *   → použije se 500 g
 *
 * Vzor za tím: v adminu bývá nepřepsaná výchozí hodnota (1 kg nebo
 * 0,1 kg), zatímco název píše obchodník ručně. Cena je ale nezávislý
 * třetí zdroj, takže rozhoduje ona — ne domněnka o tom, kdo se
 * spletl.
 *
 * Když ani jedna varianta nedává smysl, produkt se z doporučení
 * vyřadí a jde do reportu pro klienta. Radši nedoporučit než
 * doporučit špatné množství (R7).
 */

import type { BarfGroup } from '../../domain/tenant.js';
import type { ScrapedProduct } from './parseProductPage.js';

export type WeightDecision =
    | { kind: 'NO_CONFLICT'; grams: number }
    | { kind: 'RESOLVED'; grams: number; source: 'AUTHORITATIVE' | 'NAME'; pricePerKg: number; reasonCs: string }
    | { kind: 'UNRESOLVED'; reasonCs: string };

/**
 * Rozumné pásmo ceny za kg, ve kterém varianta obstojí.
 *
 * Odvozuje se z MEDIÁNU skupiny v katalogu, ne z pevných čísel —
 * ceny se mění a natvrdo zapsané hranice by za rok lhaly. Tolerance
 * je široká záměrně: cílem je vyloučit nesmysl (10 Kč/kg, 390 Kč/kg),
 * ne posuzovat, jestli je produkt drahý.
 */
const LOWER_FACTOR = 0.25;   // pod čtvrtinou mediánu = nereálně nízko
const UPPER_FACTOR = 4.0;    // nad čtyřnásobkem = nereálně vysoko

/** Medián ceny za kg pro skupinu, z produktů bez konfliktu. */
export function medianPricePerKg(
    products: ScrapedProduct[],
    groupOf: (p: ScrapedProduct) => BarfGroup,
    group: BarfGroup
): number | null {
    const values = products
        .filter((p) => groupOf(p) === group)
        .filter((p) => p.packGramsConflict === null)
        .filter((p) => p.packGrams !== null && p.packGrams > 0 && p.priceWithVat !== null && p.priceWithVat > 0)
        .map((p) => (p.priceWithVat! / p.packGrams!) * 1000)
        .sort((a, b) => a - b);

    if (values.length === 0) return null;
    const mid = Math.floor(values.length / 2);
    return values.length % 2 === 1 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
}

/**
 * Rozhodne gramáž produktu.
 *
 * `medianForGroup` je medián ceny za kg pro skupinu produktu; když
 * není k dispozici (skupina má samé konfliktní produkty), rozpor se
 * neřeší a produkt jde do reportu — nedopočítává se.
 */
export function resolveWeightConflict(
    product: ScrapedProduct,
    medianForGroup: number | null
): WeightDecision {
    if (product.packGrams === null) {
        return { kind: 'UNRESOLVED', reasonCs: 'gramáž balení není nikde uvedená' };
    }
    if (product.packGramsConflict === null) {
        return { kind: 'NO_CONFLICT', grams: product.packGrams };
    }

    const { authoritative, fromName } = product.packGramsConflict;
    const price = product.priceWithVat;

    if (price === null || price <= 0) {
        return {
            kind: 'UNRESOLVED',
            reasonCs: `rozpor ${authoritative} g (admin) vs. ${fromName} g (název) a chybí cena k rozhodnutí`,
        };
    }
    if (medianForGroup === null || medianForGroup <= 0) {
        return {
            kind: 'UNRESOLVED',
            reasonCs: `rozpor ${authoritative} g vs. ${fromName} g; pro skupinu není srovnávací cena za kg`,
        };
    }

    const lo = medianForGroup * LOWER_FACTOR;
    const hi = medianForGroup * UPPER_FACTOR;

    const perKg = (grams: number) => (price / grams) * 1000;
    const authPerKg = perKg(authoritative);
    const namePerKg = perKg(fromName);
    const authOk = authPerKg >= lo && authPerKg <= hi;
    const nameOk = namePerKg >= lo && namePerKg <= hi;

    const fmt = (n: number) => Math.round(n);

    // Přesně jedna varianta obstojí — to je ten případ, který chceme.
    if (authOk && !nameOk) {
        return {
            kind: 'RESOLVED',
            grams: authoritative,
            source: 'AUTHORITATIVE',
            pricePerKg: authPerKg,
            reasonCs:
                `použito ${authoritative} g z adminu: ${fmt(authPerKg)} Kč/kg je v pásmu skupiny, ` +
                `zatímco ${fromName} g z názvu by dalo ${fmt(namePerKg)} Kč/kg`,
        };
    }
    if (nameOk && !authOk) {
        return {
            kind: 'RESOLVED',
            grams: fromName,
            source: 'NAME',
            pricePerKg: namePerKg,
            reasonCs:
                `použito ${fromName} g z názvu: ${fmt(namePerKg)} Kč/kg je v pásmu skupiny, ` +
                `zatímco ${authoritative} g z adminu by dalo ${fmt(authPerKg)} Kč/kg`,
        };
    }

    // Obě obstojí → cena nerozhoduje. Přednost má NÁZEV: je to údaj,
    // který obchodník napsal ručně a který vidí i zákazník, kdežto
    // v adminu bývá nepřepsaná výchozí hodnota. Rozpor se přesto
    // reportuje, aby ho klient opravil.
    if (authOk && nameOk) {
        return {
            kind: 'RESOLVED',
            grams: fromName,
            source: 'NAME',
            pricePerKg: namePerKg,
            reasonCs:
                `obě varianty jsou cenově možné (${fmt(namePerKg)} vs. ${fmt(authPerKg)} Kč/kg); ` +
                'použit název, protože ho vidí zákazník — opravit v adminu',
        };
    }

    // Ani jedna neobstojí → nedoporučovat.
    return {
        kind: 'UNRESOLVED',
        reasonCs:
            `rozpor ${authoritative} g vs. ${fromName} g a ani jedna varianta nedává smysl ` +
            `(${fmt(authPerKg)} resp. ${fmt(namePerKg)} Kč/kg proti mediánu ${fmt(medianForGroup)} Kč/kg)`,
    };
}
