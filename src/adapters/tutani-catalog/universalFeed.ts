/**
 * `universal.xml` — VEŘEJNÝ feed Shoptetu, zdroj popisů produktů.
 *
 * Objev Lucky 2026-09-09 (analogie k hecmania.cz/universal.xml):
 * `https://obchod.tutani.cz/universal.xml` je dostupný **bez hashe
 * a bez přihlášení**, 212 KB, 269 položek.
 *
 * PROČ NENAHRAZUJE SCRAPER (změřeno, ne odhadnuto):
 *
 * | údaj | universal.xml | scraper (dataLayer) |
 * |---|---|---|
 * | ceny | ✅ shodné, 0 rozdílů | ✅ |
 * | popis / složení | ✅ **269/269** | ⚠️ 45/264 (17 %) |
 * | SKU (`PRODUCTNO`) | ❌ **0/269 prázdné** | ✅ 264/264 |
 * | `priceId`, `productId` | ❌ nejsou | ✅ |
 * | dostupnost, sklad | ❌ není | ✅ |
 * | hmotnost balení | ❌ jen v názvu | ✅ z `dataLayer` |
 *
 * Bez SKU a `priceId` by nešlo nic vložit do košíku, takže scraper
 * zůstává primárním zdrojem. Feed se používá k JEDNÉ věci: doplnit
 * popis tam, kde ho detail produktu nenese.
 *
 * PŘÍNOS (změřeno na 264 produktech): určení surovin pro filtr
 * alergií stoupne ze **54 % na 64 %** — o 25 produktů víc. To je
 * přímá odpověď na kritický nález auditu, že filtr alergií pracoval
 * nad prázdnými daty.
 *
 * Párování je přes `URL`, která je v obou zdrojích identická
 * (ověřeno: 264/264 spárováno).
 */

/** Popis produktu z feedu, klíčem je URL detailu. */
export type FeedDescriptions = Map<string, string>;

/**
 * Vytáhne popisy z `universal.xml`.
 *
 * Parser je záměrně tolerantní: chybějící nebo poškozená položka se
 * přeskočí, protože feed je jen obohacení — jeho selhání NESMÍ shodit
 * synchronizaci katalogu. Když feed nedorazí vůbec, sync běží dál
 * s tím, co má z detailů produktů.
 */
export function parseUniversalFeed(xml: string): FeedDescriptions {
    const out: FeedDescriptions = new Map();
    if (!xml || xml.length === 0) return out;

    // `[\s\S]` místo `.` s `s` flagem — kompatibilita s cíli bez ES2018.
    const items = xml.match(/<SHOPITEM>[\s\S]*?<\/SHOPITEM>/g);
    if (!items) return out;

    for (const item of items) {
        const url = tag(item, 'URL');
        if (!url) continue;

        const desc = tag(item, 'DESCRIPTION');
        if (!desc) continue;

        const text = htmlToText(desc);
        if (text.length > 0) out.set(url, text);
    }
    return out;
}

/** Obsah jednoho tagu. Vrací `''`, když chybí. */
function tag(xml: string, name: string): string {
    const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
    return m ? m[1].trim() : '';
}

/**
 * Popis ve feedu je HTML **dvakrát escapované** (`&lt;p&gt;`), takže
 * se entity dekódují, teprve pak se strhnou tagy a dekóduje znovu.
 */
function htmlToText(s: string): string {
    const once = decodeEntities(s);
    const noTags = once
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ');
    return decodeEntities(noTags).replace(/\s+/g, ' ').trim();
}

function decodeEntities(s: string): string {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, d) => {
            const n = Number(d);
            return n >= 32 && n <= 0x10ffff ? String.fromCodePoint(n) : ' ';
        })
        // `&amp;` až nakonec, jinak by rozbil entity vzniklé z něj.
        .replace(/&amp;/g, '&');
}

/** Výchozí URL feedu pro tenanta se Shoptetem. */
export function universalFeedUrl(baseUrl: string): string {
    return `${baseUrl.replace(/\/+$/, '')}/universal.xml`;
}
