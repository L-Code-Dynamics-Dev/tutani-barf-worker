/**
 * Parser detailu produktu ze Shoptetu — čtení `dataLayer` z HTML.
 *
 * PROČ Z HTML A NE Z FEEDU (Lucky 2026-09-08: „můžeme to vytáhnout
 * z DOMu"): Shoptet sype na každý detail produktu
 * `dataLayer.push({ shoptet: { ... } })` s kompletními strukturovanými
 * daty — kód, cena, hmotnost, dostupnost po skladech, kategorie,
 * výrobce. Feed s hashem z adminu tedy není potřeba a klient nám nemusí
 * nic posílat ani exportovat.
 *
 * Ověřeno naostro na obchod.tutani.cz 2026-09-08 (ZP9, ZP10, DR46).
 *
 * ZÁSADA: co v HTML není, se NEHÁDÁ (R7). Chybějící údaj je `null`
 * a produkt s chybějící gramáží do doporučení nevstoupí — je lepší
 * produkt nedoporučit než doporučit špatné množství.
 */

import type { BarfGroup } from '../../domain/tenant.js';

/** Surová data produktu, jak je nese stránka. Bez interpretace. */
export interface ScrapedProduct {
    /** Kód produktu (SKU) — `product.code`. */
    sku: string;
    name: string;
    url: string;
    /** Shoptet interní id — potřebné pro vložení do košíku. */
    productId: string | null;
    /**
     * `priceId` pro `/action/Cart/addCartItem/` — bez něj nejde
     * produkt vložit do košíku.
     *
     * NENÍ v `dataLayer` (ověřeno 2026-09-09), ale JE v hidden inputu
     * formuláře na detailu produktu: `<input type="hidden"
     * name="priceId" value="973">`. Proto se čte odtud, ne z JSONu.
     */
    priceId: string | null;
    guid: string | null;
    /** Cena s DPH v Kč. */
    priceWithVat: number | null;
    /**
     * Hmotnost balení v gramech. `null` = nezjištěno, NEHÁDÁ se.
     * Kaskáda zdrojů: `product.weight` (kg) → parametr „Hmotnost"
     * → parsing názvu.
     */
    packGrams: number | null;
    /** Odkud se hmotnost vzala — pro audit a kontrolu kvality dat. */
    packGramsSource: 'DATALAYER' | 'PARAM' | 'NAME' | null;
    /**
     * Autoritativní zdroj si odporuje s názvem produktu — chyba v datech
     * e-shopu, kterou musí opravit klient. Systém ji NEOPRAVUJE odhadem,
     * jen ji nahlásí a produkt drží mimo doporučení.
     *
     * Reálný případ (2026-09-08): `TUT117` „Směs paní Krocanové 3kg" má
     * `weight: 1` i parametr „Hmotnost = 1 kg", zatímco `TUT216`
     * „Mleté kuře 3kg" má správně 3.
     */
    packGramsConflict: { authoritative: number; fromName: number } | null;
    /** Celkem skladem přes všechny skladové lokace. */
    stockQuantity: number | null;
    /** Plná cesta kategorií, oddělená `|`. */
    categoryPath: string | null;
    manufacturer: string | null;
    hasVariants: boolean;
    /** Text složení z popisu, je-li tam. */
    compositionText: string | null;
    /** Parametry z tabulky na detailu. */
    params: Record<string, string>;
}

/**
 * Vytáhne `shoptet` objekt z `dataLayer.push(...)`.
 *
 * Nepoužívá se plný JSON.parse na celý push (obsahuje i `cartInfo`,
 * `customer` a další, co se může měnit) — hledá se konkrétně blok
 * `"product": { ... }` s vyváženými složenými závorkami. Robustnější
 * proti změnám okolí a nezávislé na pořadí klíčů.
 */
export function extractProductJson(html: string): Record<string, unknown> | null {
    const marker = '"product"';
    let from = 0;
    // Stránka může mít `"product"` i jinde (např. v jiném skriptu),
    // proto se zkouší každý výskyt, dokud jeden nedá platný objekt
    // s klíčem `code`.
    for (;;) {
        const idx = html.indexOf(marker, from);
        if (idx === -1) return null;
        const braceStart = html.indexOf('{', idx + marker.length);
        if (braceStart === -1) return null;

        const raw = readBalancedObject(html, braceStart);
        if (raw) {
            try {
                const parsed = JSON.parse(raw) as Record<string, unknown>;
                if (typeof parsed.code === 'string' || typeof parsed.id === 'number') {
                    return parsed;
                }
            } catch {
                // Nevalidní kandidát — zkusit další výskyt.
            }
        }
        from = idx + marker.length;
    }
}

/**
 * Přečte objekt od `{` po odpovídající `}`, s respektem k řetězcům
 * a escapování. Regex na tohle nestačí — vnořené objekty (`codes`,
 * `stocks`) by ho rozbily.
 */
function readBalancedObject(s: string, start: number): string | null {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < s.length; i++) {
        const ch = s[i];

        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            if (inString) escaped = true;
            continue;
        }
        if (ch === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;

        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return s.slice(start, i + 1);
        }
    }
    return null;
}

/** Je to vůbec detail produktu? Kategoriové stránky nesou náhledy karet. */
export function isProductDetail(html: string): boolean {
    return /"pageType"\s*:\s*"productDetail"/.test(html);
}

/**
 * Hmotnost balení v gramech z názvu produktu.
 *
 * Ověřené tvary na tutani.cz: `Hovězí svalovina 1kg`,
 * `Hrubomletá směs 1,5kg`, `Dromy BARF HERBAL 500g`,
 * `Dromy Pohankový mix se zeleninou 1000 g`.
 *
 * Bere POSLEDNÍ výskyt — v názvu bývá dřív jiné číslo (`BARF 2 kg mix
 * 500g`) a gramáž balení je konvenčně na konci.
 */
export function parseGramsFromText(text: string): number | null {
    const re = /(\d+(?:[.,]\d+)?)\s*(kg|g)\b/gi;
    let last: { value: number; unit: string } | null = null;

    for (const m of text.matchAll(re)) {
        const value = parseFloat(m[1].replace(',', '.'));
        if (!Number.isFinite(value) || value <= 0) continue;
        last = { value, unit: m[2].toLowerCase() };
    }
    if (!last) return null;

    const grams = last.unit === 'kg' ? last.value * 1000 : last.value;
    // Sanity: balení pod 10 g nebo nad 50 kg je nejspíš špatně přečtené
    // číslo (obsah balení vs. dávkování), takže radši `null` než nesmysl.
    if (grams < 10 || grams > 50_000) return null;
    return Math.round(grams);
}

/**
 * `priceId` z hidden inputu formuláře „do košíku".
 *
 * Shoptet ho na detailu produktu vykresluje jako
 * `<input type="hidden" name="priceId" value="973">`. U variantních
 * produktů se přepisuje JS podle vybrané varianty — pro produkty bez
 * variant (což je celý katalog Tutani, `hasVariants: false`) je
 * hodnota v HTML správná.
 *
 * Bere se PRVNÍ výskyt: stránka může mít další formuláře (upsell,
 * „podobné produkty"), které nesou cizí `priceId`.
 */
export function parsePriceId(html: string): string | null {
    // Atributy mohou být v libovolném pořadí, proto dvě varianty.
    const patterns = [
        /<input[^>]*name="priceId"[^>]*value="(\d+)"/i,
        /<input[^>]*value="(\d+)"[^>]*name="priceId"/i,
    ];
    for (const re of patterns) {
        const m = html.match(re);
        if (m) return m[1];
    }
    return null;
}

/** Parametry z tabulky na detailu, např. `Hmotnost = 1 kg`. */
export function parseParams(html: string): Record<string, string> {
    const out: Record<string, string> = {};
    const re = /<t[dh][^>]*>([^<]{2,60})<\/t[dh]>\s*<t[dh][^>]*>([^<]{1,120})<\/t[dh]>/gi;
    for (const m of html.matchAll(re)) {
        const key = decodeEntities(m[1]).trim();
        const val = decodeEntities(m[2]).trim();
        if (key && val) out[key] = val;
    }
    return out;
}

/**
 * Text složení z popisu produktu.
 *
 * Ověřené tvary: `Složení: 100% kuřecí srdíčka`,
 * `složení: Instantní pohankové vločky, mrkev obecná, …`.
 * Bere se do konce věty nebo do dalšího nadpisu (`Návod k použití`).
 */
export function parseComposition(html: string): string | null {
    const text = htmlToText(html);
    const m = text.match(/slo[žz]en[íi]\s*:?\s*(.{5,600}?)(?:\s*(?:návod k použití|analytické|doporučen|skladování|krmn[áé] d[áo]vk|$))/i);
    if (!m) return null;
    const val = m[1].trim().replace(/\s{2,}/g, ' ');
    return val.length >= 5 ? val : null;
}

/**
 * Zařazení do BARF skupiny. Mapování je data, ne kód.
 *
 * DVĚ ÚROVNĚ (zjištěno dry-runem 2026-09-08): 27 produktů z kategorie
 * „Barf mražené maso - syrové maso pro psy" nemá podkategorii, takže
 * z cesty kategorie složku poznat nelze — a jsou mezi nimi věci, které
 * do dávky jednoznačně patří (`TUT108` Pašíkova játra, `TUT147` Srdce
 * jako kráva, `TUT218` Mleté kachní maso). Proto se po kategorii zkusí
 * ještě NÁZEV produktu.
 *
 * Pozor na hranici: názvy jsou u Tutani často fantazijní („Gurgle",
 * „Pani Držkatá", „Šemíkova mňamka", „Krůtí vznášedla"). Z takového
 * názvu se složka odvodit NEDÁ a produkt zůstane `OTHER` — nehádá se
 * (R7). Zařazení těch případů musí potvrdit klient.
 */
export function resolveBarfGroup(
    categoryPath: string | null,
    categoryMap: { match: string; barfGroup: BarfGroup }[],
    productName?: string | null
): BarfGroup {
    /**
     * 0. JÁTRA podle názvu mají přednost i před kategorií.
     *
     * Játra jsou v metodice samostatná složka (5 %) oddělená od
     * ostatních orgánů (5 %) a u hepatopatie s ukládáním měďi se
     * limitují zvlášť (max 1 %). Když je e-shop zařadí pod obecné
     * „vnitřnosti", zdravotní limit by je minul.
     *
     * Nález 2026-09-09: `TUT22 Barf Kachní jatýrka 500g` je
     * v kategorii „Barf - Kachní vnitřnosti" → padalo na ORGAN, takže
     * u omezení měďi by se měď dostala přesně tam, odkud ji
     * vyřazujeme.
     *
     * Výjimka platí JEN pro játra a jen když kategorie neříká něco
     * úplně jiného (pamlsky, hračky) — proto se nejdřív ověří, že
     * kategorie nemapuje na OTHER.
     */
    if (productName && categoryPath) {
        const jmeno = productName.toLowerCase();
        if (/jat[ýy]rk|j[áa]tr/.test(jmeno)) {
            const dleKategorie = matchIn(categoryPath, categoryMap);
            if (dleKategorie !== 'OTHER') return 'LIVER';
        }
    }

    // 1. Kategorie je autoritativní — klient ji v adminu spravuje.
    if (categoryPath) {
        const hay = categoryPath.toLowerCase();
        for (const entry of categoryMap) {
            if (hay.includes(entry.match.toLowerCase())) return entry.barfGroup;
        }
    }
    // 2. Fallback na název, jen když kategorie nerozhodla.
    if (productName) {
        const hay = productName.toLowerCase();
        for (const entry of categoryMap) {
            if (hay.includes(entry.match.toLowerCase())) return entry.barfGroup;
        }
    }
    return 'OTHER';
}

/** Najde první shodu v textu podle mapování. Pomocník pro `resolveBarfGroup`. */
function matchIn(
    text: string,
    categoryMap: { match: string; barfGroup: BarfGroup }[]
): BarfGroup {
    const hay = text.toLowerCase();
    for (const entry of categoryMap) {
        if (hay.includes(entry.match.toLowerCase())) return entry.barfGroup;
    }
    return 'OTHER';
}

/**
 * Složí `ScrapedProduct` ze stránky. Vrací `null`, když to není
 * detail produktu (kategoriové URL) nebo chybí kód.
 */
export function parseProductPage(html: string, url: string): ScrapedProduct | null {
    if (!isProductDetail(html)) return null;

    const p = extractProductJson(html);
    if (!p) return null;

    const sku = typeof p.code === 'string' ? p.code.trim() : '';
    if (!sku) return null;

    const name = typeof p.name === 'string' ? p.name.trim() : '';
    const params = parseParams(html);

    // Hmotnost: kaskáda zdrojů, každý krok si pamatuje, odkud je.
    let packGrams: number | null = null;
    let packGramsSource: ScrapedProduct['packGramsSource'] = null;

    const weightKg = typeof p.weight === 'number' ? p.weight : null;
    if (weightKg !== null && weightKg > 0) {
        packGrams = Math.round(weightKg * 1000);
        packGramsSource = 'DATALAYER';
    }
    if (packGrams === null) {
        // Parametr „Hmotnost" — u produktů, kde `weight` je 0.
        const paramKey = Object.keys(params).find((k) => /hmotnost|váha|vaha/i.test(k));
        if (paramKey) {
            const g = parseGramsFromText(params[paramKey]);
            if (g !== null) {
                packGrams = g;
                packGramsSource = 'PARAM';
            }
        }
    }
    if (packGrams === null && name) {
        const g = parseGramsFromText(name);
        if (g !== null) {
            packGrams = g;
            packGramsSource = 'NAME';
        }
    }

    /**
     * Kontrola rozporu: máme-li hmotnost z autoritativního zdroje
     * (`dataLayer` nebo parametr) a název tvrdí něco jiného, je to chyba
     * v datech e-shopu. Autoritativní zdroj vyhrává, ale rozpor se
     * ohlásí — produkt s nesprávnou gramáží by znamenal špatný nákup.
     *
     * Tolerance 2 % kryje zaokrouhlení (1,5 kg vs. 1500 g), ne rozdíl
     * 1 kg vs. 3 kg.
     */
    let packGramsConflict: ScrapedProduct['packGramsConflict'] = null;
    if (packGrams !== null && packGramsSource !== 'NAME' && name) {
        const fromName = parseGramsFromText(name);
        if (fromName !== null && Math.abs(fromName - packGrams) > packGrams * 0.02) {
            packGramsConflict = { authoritative: packGrams, fromName };
        }
    }

    // Sklad: součet přes všechny kódy a lokace.
    let stockQuantity: number | null = null;
    const codes = Array.isArray(p.codes) ? p.codes : null;
    if (codes) {
        let sum = 0;
        let found = false;
        for (const c of codes as Record<string, unknown>[]) {
            const q = c?.quantity;
            const n = typeof q === 'number' ? q : typeof q === 'string' ? parseFloat(q) : NaN;
            if (Number.isFinite(n)) {
                sum += n;
                found = true;
            }
        }
        if (found) stockQuantity = sum;
    }

    return {
        sku,
        name,
        url,
        productId: p.id !== undefined && p.id !== null ? String(p.id) : null,
        priceId: parsePriceId(html),
        guid: typeof p.guid === 'string' ? p.guid : null,
        priceWithVat: typeof p.priceWithVat === 'number' ? p.priceWithVat : null,
        packGrams,
        packGramsSource,
        packGramsConflict,
        stockQuantity,
        categoryPath:
            typeof p.currentCategory === 'string'
                ? p.currentCategory
                : typeof p.defaultCategory === 'string'
                  ? p.defaultCategory
                  : null,
        manufacturer: typeof p.manufacturer === 'string' ? p.manufacturer : null,
        hasVariants: p.hasVariants === true,
        compositionText: parseComposition(html),
        params,
    };
}

/** Odstraní tagy a normalizuje bílé znaky. Skripty a styly vyhodí. */
function htmlToText(html: string): string {
    const noScript = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ');
    return decodeEntities(noScript.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
}

/** Minimální dekódování entit — jen to, co Shoptet reálně používá. */
function decodeEntities(s: string): string {
    return s
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;|&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
}
