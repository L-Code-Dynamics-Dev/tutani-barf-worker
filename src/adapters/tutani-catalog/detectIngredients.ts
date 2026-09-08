/**
 * Odvození SUROVIN produktu z názvu a složení — vstup pro filtr
 * alergií a toxických potravin.
 *
 * KRITICKÝ NÁLEZ AUDITU 2026-09-09: `syncCatalog` ukládal
 * `ingredientIds: []` natvrdo. Filtr v `matchProducts` iteruje přes
 * `ingredientIds`, takže nad prázdným polem neudělal nic — psovi
 * s alergií na kuře se doporučilo kuřecí maso a cibule se nabízela
 * každému, přičemž API hlásilo `knowledgeEngineReady: true`. Systém
 * tvrdil, že alergii vyhodnotil, a nevyhodnotil ji. To je horší než
 * mlčení.
 *
 * ZÁSADA (R7): tohle je odvození z REÁLNÝCH dat, ne odhad chybějících.
 * Co se z názvu ani složení poznat nedá, zůstane nezařazené —
 * a `matchProducts` takový produkt u zadané alergie NEDOPORUČÍ
 * (fail-closed). Nikdy se netvrdí „neobsahuje alergen", jen
 * „nevíme, co obsahuje".
 *
 * Katalog tutani má složení jen u 17 % produktů (dry-run 2026-09-08),
 * proto se čte i NÁZEV: „Hovězí svalovina 1kg" je jednoznačná,
 * i když popis chybí.
 */

/**
 * Vzory surovin. Klíč je `id` z `ingredients.json`, hodnoty jsou
 * podřetězce (bez diakritiky i s ní), které surovinu identifikují.
 *
 * Pořadí NEROZHODUJE — hledají se všechny, produkt může mít víc
 * surovin (`Barf Mleté kuře s dršťkami` = kuře + orgány).
 */
const VZORY: Record<string, readonly string[]> = {
    // ---- živočišné (alergeny) ----
    kure: ['kuřec', 'kurec', 'kuře', 'kure ', 'f16', 'kuřát', 'kurat'],
    kruti: ['krůt', 'krut', 'krocan', 'indi'],
    kachna: ['kachn', 'kachní', 'kachni'],
    hovezi: ['hověz', 'hovez', 'kráv', 'krav', 'telec', 'býč', 'byc', 'vemínko', 'veminko'],
    vepr: ['vepřov', 'veprov', 'pašík', 'pasik', 'prase', 'sele'],
    kralik: ['králič', 'kralic', 'ušák', 'usak', 'zajíc', 'zajic'],
    jehneci: ['jehněč', 'jehnec', 'ovč', 'ovc', 'skopov'],
    kun: ['koňsk', 'konsk', 'kůň', 'kun ', 'šemík', 'semik'],
    zverina: ['zvěřin', 'zverin', 'srnec', 'srnč', 'srnc', 'daněk', 'danek', 'jelen', 'divoč', 'divoc', 'muflon'],
    ryba: ['ryb', 'treska', 'sardin', 'makrel', 'tuňák', 'tunak', 'šprot', 'sprot'],
    losos: ['losos', 'salmo salar', 'salmo'],
    klokan: ['klokan'],

    // ---- rostlinné ----
    mrkev: ['mrkev', 'mrkv', 'karotk'],
    repa: ['řepa', 'repa', 'řep '],
    dyne: ['dýně', 'dyne', 'dýn'],
    spenat: ['špenát', 'spenat'],
    jablko: ['jablk'],
    pohanka: ['pohank'],
    jahly: ['jáhl', 'jahl'],
    kuskus: ['kuskus', 'kus-kus'],
    ryze: ['rýže', 'ryze', 'rýžov', 'ryzov'],

    // ---- toxické (vylučují se VŽDY, i bez zadání majitelem) ----
    hrozny: ['hrozn', 'vinná réva', 'vinna reva'],
    rozinky: ['rozink', 'hrozink'],
    cibule: ['cibul'],
    cesnek: ['česnek', 'cesnek'],
    cokolada: ['čokolád', 'cokolad', 'kakao'],
    xylitol: ['xylitol'],
    avokado: ['avokád', 'avokad'],
    'makadamove-orechy': ['makadam'],
};

/**
 * Slova, která NESMÍ spustit shodu, protože jsou součástí jiného
 * pojmu. Bez nich by „Kuřecí vemínko" vyhodilo `hovezi` (vemínko →
 * kráva) i `kure` a alergik na hovězí by přišel o kuřecí produkt.
 *
 * Kontroluje se PŘED vzory: když text obsahuje výjimku, dané `id`
 * se z ní neodvozuje.
 */
const VYJIMKY: Record<string, readonly string[]> = {
    // „Kuřecí vemínko" a „Kopyto jako kráva" jsou fantazijní názvy,
    // kde slovo ukazuje na tvar, ne na druh zvířete.
    hovezi: ['kuřecí vemínko', 'kurecí veminko', 'kuřecí veminko'],
};

/** Normalizace pro hledání — malá písmena, sjednocené mezery. */
function norm(s: string): string {
    return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Vrátí id surovin, které se v názvu nebo složení daly rozpoznat.
 * Prázdné pole = surovinu nelze určit (NE „neobsahuje nic").
 *
 * Výstup je deterministický (setříděný), aby se dvě volání shodla
 * a diff v D1 nevznikal z pořadí.
 */
export function detectIngredients(
    name: string | null | undefined,
    compositionText?: string | null
): string[] {
    const text = norm([name ?? '', compositionText ?? ''].join(' '));
    if (text.length === 0) return [];

    const nalezeno = new Set<string>();

    for (const [id, vzory] of Object.entries(VZORY)) {
        const vyjimky = VYJIMKY[id];
        if (vyjimky?.some((v) => text.includes(norm(v)))) continue;
        if (vzory.some((v) => text.includes(norm(v)))) nalezeno.add(id);
    }

    return [...nalezeno].sort();
}

/**
 * Obsahuje produkt toxickou surovinu? Používá se pro tvrdý filtr,
 * který platí bez ohledu na to, co majitel zadal.
 */
const TOXICKE = new Set([
    'hrozny', 'rozinky', 'cibule', 'cesnek',
    'cokolada', 'xylitol', 'avokado', 'makadamove-orechy',
]);

export function hasToxicIngredient(ingredientIds: readonly string[]): boolean {
    return ingredientIds.some((i) => TOXICKE.has(i));
}
