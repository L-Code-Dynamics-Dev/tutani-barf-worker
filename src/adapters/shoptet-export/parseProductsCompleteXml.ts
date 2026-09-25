/**
 * Admin XML export Shoptetu (`/export/productsComplete.xml?patternId=-5&…&hash=…`)
 * → strukturovaná data katalogu.
 *
 * PROČ XML (Lucky 2026-09-24): „variant id je pouze v XML exportu." Ověřeno:
 *
 *   `<SHOPITEM id>`  = `productId` (sedí u 264/264 produktů ze scraperu)
 *   `<VARIANT id>`   = `priceId` varianty (1066/500 → 1751, 1066/1 K → 1754,
 *                      shodné s formulářem na webu)
 *
 * Do košíku (`/action/Cart/addCartItem/`) se VŽDY posílá `priceId`
 * I `productId`. XML je proto autoritativní zdroj `productId` pro všechny
 * produkty a `priceId` pro varianty. Produkt BEZ variant `<VARIANT>` nemá
 * a jeho `priceId` (≠ `productId`, např. ZP9: 868 vs 973) zná jen detail
 * produktu na webu — doplní ho scraper.
 *
 * XML navíc nese vše, co měl XLSX export (sklad, gramáž `PACKAGE_AMOUNT`,
 * viditelnost, popis se složením) a stáhne se rychleji (~1 s / 4,4 MB).
 *
 * ⚠️ CITLIVÁ DATA: XML obsahuje nákupní ceny (`PURCHASE_PRICE`). Čtou se
 * VÝHRADNĚ elementy vyjmenované v tomto souboru — nic se nepřevádí
 * hromadně, takže nákupní cena se nemůže dostat do D1, logu ani API.
 *
 * Parser je regexový záměrně: Worker nemá `DOMParser` a struktura exportu
 * je plochá a pevná. Každý `SHOPITEM` se zpracuje samostatně — vadný
 * blok se přeskočí a nahlásí, nezastaví celý export.
 */

export interface ExportProduct {
    /** Kód produktu / varianty (= SKU). */
    code: string;
    /** Shoptet `productId` (`<SHOPITEM id>`). Do košíku VŽDY. */
    productId: string;
    /** `priceId` varianty (`<VARIANT id>`). U produktu bez variant `null` — dodá web. */
    variantPriceId: string | null;
    /** U varianty `productId` hlavního produktu (skupina variant), jinak `null`. */
    pairCode: string | null;
    name: string;
    /** Název varianty z parametrů („Pivovarské kvasnice: 1 kg"). */
    variantName: string | null;
    guid: string | null;
    manufacturer: string | null;
    categoryPath: string | null;
    priceWithVat: number | null;
    stockQuantity: number | null;
    visible: boolean;
    /** Gramáž balení z `PACKAGE_AMOUNT` (jen g/kg). */
    packGrams: number | null;
    /** Objem u tekutin (ml/l) — gramy se z objemu NEDOPOČÍTÁVAJÍ. */
    packVolumeMl: number | null;
    /** Popis bez HTML (krátký + dlouhý) — zdroj složení. */
    descriptionText: string | null;
}

export interface ExportParseResult {
    products: ExportProduct[];
    skipped: { productId: string | null; reasonCs: string }[];
}

export class ExportFormatError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ExportFormatError';
    }
}

/** Pod tolik položek je export podezřelý (šablona/hash vrací něco jiného). */
const MIN_ITEMS = 1;

export function parseProductsCompleteXml(xml: string): ExportParseResult {
    const head = xml.slice(0, 500).trimStart();
    if (!head.startsWith('<?xml') && !head.startsWith('<SHOP')) {
        // Neplatný hash → Shoptet vrací HTML stránku 404.
        throw new ExportFormatError('odpověď není XML export (nejspíš neplatný odkaz nebo hash)');
    }
    if (!xml.includes('<SHOP>') && !xml.includes('<SHOP ')) {
        throw new ExportFormatError('v XML chybí kořen <SHOP> — změnila se šablona exportu?');
    }

    const products: ExportProduct[] = [];
    const skipped: ExportParseResult['skipped'] = [];
    const seen = new Set<string>();

    let items = 0;
    for (const m of xml.matchAll(/<SHOPITEM\b([^>]*)>([\s\S]*?)<\/SHOPITEM>/g)) {
        items++;
        const productId = attr(m[1], 'id');
        if (!productId) {
            skipped.push({ productId: null, reasonCs: 'SHOPITEM bez id' });
            continue;
        }
        try {
            for (const p of parseItem(productId, m[2])) {
                if (seen.has(p.code)) {
                    skipped.push({ productId, reasonCs: `duplicitní kód ${p.code}` });
                    continue;
                }
                seen.add(p.code);
                products.push(p);
            }
        } catch (e) {
            skipped.push({ productId, reasonCs: `nečitelný blok: ${e instanceof Error ? e.message : String(e)}` });
        }
    }
    if (items < MIN_ITEMS) throw new ExportFormatError('XML export neobsahuje žádný SHOPITEM');

    return { products, skipped };
}

const NESTED_FOREIGN_CODES =
    /<(FLAGS|RELATED_PRODUCTS|ALTERNATIVE_PRODUCTS|GIFTS|SET_ITEMS|ACCESSORIES)\b[^>]*>[\s\S]*?<\/\1>/g;

/**
 * Vlastní kód položky. Když po odstranění vnořených bloků zůstane víc
 * <CODE>, struktura je neznámá — položka se přeskočí a nahlásí, NEHÁDÁ
 * se, který kód je její (R7).
 */
function ownCode(scope: string): string {
    const codes = [...scope.matchAll(/<CODE>([\s\S]*?)<\/CODE>/g)].map((m) => decodeXml(m[1]).trim()).filter(Boolean);
    if (codes.length === 0) throw new Error('položka bez CODE');
    if (codes.length > 1) throw new Error(`víc kódů v jedné položce (${codes.slice(0, 3).join(', ')}) — neznámá struktura`);
    return codes[0];
}

function parseItem(productId: string, body: string): ExportProduct[] {
    /**
     * Vnořené bloky s CIZÍMI <CODE> musí pryč, než se čte vlastní kód:
     *   FLAGS              → <CODE>action</CODE>, <CODE>tip</CODE>…
     *   RELATED_PRODUCTS   → kódy souvisejících produktů
     *
     * CHYBA ODCHYCENÁ 2026-09-24 na reálném exportu: bez odstranění
     * RELATED_PRODUCTS dostal „Hrubý pan Ušák" (TUT10) kód TUT20/1
     * souvisejícího produktu — a s ním by převzal cizí sklad a gramáž.
     */
    const clean = body.replace(NESTED_FOREIGN_CODES, '');
    const variantsBlock = clean.match(/<VARIANTS>([\s\S]*?)<\/VARIANTS>/)?.[1] ?? null;
    const top = variantsBlock === null ? clean : clean.replace(/<VARIANTS>[\s\S]*?<\/VARIANTS>/, '');

    const itemType = text(top, 'ITEM_TYPE');
    if (itemType && itemType !== 'product') return [];

    const shared = {
        name: text(top, 'NAME') ?? '',
        guid: text(top, 'GUID'),
        manufacturer: text(top, 'MANUFACTURER'),
        categoryPath: text(top, 'DEFAULT_CATEGORY'),
        itemVisible: text(top, 'VISIBILITY') === 'visible',
        descriptionText: joinText(htmlToText(text(top, 'SHORT_DESCRIPTION') ?? ''), htmlToText(text(top, 'DESCRIPTION') ?? '')),
    };

    if (variantsBlock === null) {
        return [build(productId, null, null, ownCode(top), top, shared, null)];
    }

    const out: ExportProduct[] = [];
    for (const v of variantsBlock.matchAll(/<VARIANT\b([^>]*)>([\s\S]*?)<\/VARIANT>/g)) {
        const variantId = attr(v[1], 'id');
        if (!variantId) throw new Error('varianta bez id');
        const code = ownCode(v[2]);
        const params = [...v[2].matchAll(/<PARAMETER>([\s\S]*?)<\/PARAMETER>/g)]
            .map((pm) => {
                const n = text(pm[1], 'NAME');
                const val = text(pm[1], 'VALUE');
                return n && val ? `${n}: ${val}` : (val ?? n);
            })
            .filter((x): x is string => !!x);
        out.push(build(productId, variantId, productId, code, v[2], shared, params.length > 0 ? params.join(', ') : null));
    }
    return out;
}

function build(
    productId: string,
    variantPriceId: string | null,
    pairCode: string | null,
    code: string,
    scope: string,
    shared: { name: string; guid: string | null; manufacturer: string | null; categoryPath: string | null; itemVisible: boolean; descriptionText: string | null },
    variantName: string | null
): ExportProduct {
    const stockBlock = scope.match(/<STOCK>([\s\S]*?)<\/STOCK>/)?.[1] ?? '';
    const unitBlock = scope.match(/<UNIT_OF_MEASURE>([\s\S]*?)<\/UNIT_OF_MEASURE>/)?.[1] ?? '';
    const { grams, volumeMl } = packageSize(text(unitBlock, 'PACKAGE_AMOUNT') ?? '', text(unitBlock, 'PACKAGE_AMOUNT_UNIT') ?? '');
    // Varianta má vlastní VISIBLE (0/1) — skrytá varianta viditelného produktu se nedoporučí.
    const variantVisible = text(scope, 'VISIBLE');

    return {
        code: code.trim(),
        productId,
        variantPriceId,
        pairCode,
        name: shared.name,
        variantName,
        guid: shared.guid,
        manufacturer: shared.manufacturer,
        categoryPath: shared.categoryPath,
        priceWithVat: toNumber(text(scope, 'PRICE_VAT') ?? ''),
        stockQuantity: toNumber(text(stockBlock, 'AMOUNT') ?? ''),
        visible: shared.itemVisible && variantVisible !== '0',
        packGrams: grams,
        packVolumeMl: volumeMl,
        descriptionText: shared.descriptionText,
    };
}

/**
 * Velikost balení z `PACKAGE_AMOUNT` + `PACKAGE_AMOUNT_UNIT`.
 * Kusy a prázdné = gramáž neznámá (sync pak zkusí název).
 */
export function packageSize(amountRaw: string, unitRaw: string): { grams: number | null; volumeMl: number | null } {
    const amount = toNumber(amountRaw);
    const unit = unitRaw.trim().toLowerCase();
    if (amount === null || amount <= 0) return { grams: null, volumeMl: null };
    switch (unit) {
        case 'g':
            return { grams: sane(amount), volumeMl: null };
        case 'kg':
            return { grams: sane(amount * 1000), volumeMl: null };
        case 'ml':
            return { grams: null, volumeMl: Math.round(amount) };
        case 'l':
            return { grams: null, volumeMl: Math.round(amount * 1000) };
        default:
            return { grams: null, volumeMl: null };
    }
}

function sane(grams: number): number | null {
    const g = Math.round(grams);
    return g >= 10 && g <= 50_000 ? g : null;
}

/** Text PRVNÍHO výskytu elementu (bez vnořených elementů), s CDATA a entitami. */
function text(scope: string, tag: string): string | null {
    const m = scope.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`));
    if (!m) return null;
    let v = m[1];
    const cdata = v.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
    v = cdata ? cdata[1] : decodeXml(v);
    v = v.trim();
    return v.length > 0 ? v : null;
}

function attr(attrs: string, name: string): string | null {
    return attrs.match(new RegExp(`\\b${name}="([^"]*)"`))?.[1] ?? null;
}

function toNumber(raw: string): number | null {
    if (!raw) return null;
    const n = Number(raw.replace(/\s/g, '').replace(',', '.'));
    return Number.isFinite(n) ? n : null;
}

function joinText(...parts: string[]): string | null {
    const t = parts.filter((p) => p.length > 0).join(' ');
    return t.length > 0 ? t : null;
}

function decodeXml(s: string): string {
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&amp;/g, '&');
}

function htmlToText(html: string): string {
    if (!html) return '';
    return html
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<br\s*\/?>|<\/p>|<\/li>/gi, '. ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/\s*\.\s*(\.\s*)+/g, '. ')
        .replace(/\s+/g, ' ')
        .trim();
}
