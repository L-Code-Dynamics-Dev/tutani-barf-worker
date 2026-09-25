/**
 * Spojení admin XML exportu (id pro košík, gramáž, sklad, složení,
 * viditelnost) se scraperem detailu (URL, cena na webu, `priceId` produktů
 * bez variant).
 *
 * KOŠÍK (Lucky 2026-09-24): do `/action/Cart/addCartItem/` se VŽDY posílá
 * `priceId` I `productId`.
 *   productId  XML `<SHOPITEM id>` — pro všechny produkty
 *   priceId    XML `<VARIANT id>` u variant; u produktu bez variant ho XML
 *              nemá a bere se z formuláře na detailu (ZP9: 868 vs 973 —
 *              `productId` jako `priceId` poslat NEJDE)
 * Když web a XML nesouhlasí, vyhrává XML a rozpor jde do reportu
 * (u hecmanie takhle vyšlo 15 špatných `priceId`). Když chybí kterýkoli
 * z obou, produkt se nedoporučí — nešel by koupit.
 *
 * KDO MÁ PŘEDNOST A PROČ (ověřeno 2026-09-24 na 264 společných SKU):
 *
 *   gramáž   EXPORT (`packageAmount`) → jinak scraper (název/parametr/dataLayer).
 *            Scraper u 46 z 47 rozporů četl přepravní hmotnost.
 *   sklad    EXPORT — stejný okamžik pro celý katalog, bez 300 requestů.
 *   cena     SCRAPER — web ukazuje cenu, kterou zákazník v košíku zaplatí
 *            (vč. akční). Export nese ceníkovou cenu (16 rozdílů).
 *   priceId  SCRAPER — v exportu není.
 *   složení  obojí — text z exportu se PŘIDÁ k textu z detailu (export
 *            ho má u 513 produktů, detail u 17 %).
 *
 * Párování přes `code` (= SKU). Záloha přes `guid` JEN u produktů bez
 * variant — varianty sdílejí guid hlavního produktu, takže by se spárovaly
 * s cizí gramáží.
 */

import { parseGramsFromText, type ScrapedProduct } from '../tutani-catalog/parseProductPage.js';
import type { ExportProduct } from './parseProductsCompleteXml.js';

export interface MergedProduct extends ScrapedProduct {
    /** `false` = skrytý v adminu. Bez exportu `true` (web ho ukazuje). */
    visible: boolean;
    /** Kód skupiny variant (`pairCode` z exportu, jinak id hlavního produktu). */
    parentCode: string | null;
    /** Popis z exportu bez HTML — vstup pro rozpad složení. */
    exportDescription: string | null;
    /** Odkud je skladová zásoba. */
    stockSource: 'EXPORT' | 'PAGE';
}

export interface MergeResult {
    products: MergedProduct[];
    /**
     * Skladem v exportu, ale scraper je na webu nenašel → nemají `priceId`,
     * do košíku nejdou vložit. Nezapisují se; jsou v reportu pro klienta.
     */
    exportOnlyInStock: { code: string; name: string; stockQuantity: number }[];
    /** Kolik produktů ze scraperu se v exportu nenašlo (nový/přejmenovaný kód). */
    unmatchedScraped: string[];
    /** Web a XML nesouhlasí v id pro košík — vyhrálo XML, klient to má vědět. */
    idMismatches: { sku: string; field: 'productId' | 'priceId'; page: string; xml: string }[];
}

/** Tolerance rozporu gramáže — stejná jako v `parseProductPage` (zaokrouhlení). */
const CONFLICT_TOLERANCE = 0.02;

export function mergeWithExport(scraped: ScrapedProduct[], exported: ExportProduct[] | null): MergeResult {
    if (exported === null) {
        // Bez exportu se chová přesně jako dřív — nic se nepřepisuje.
        return {
            products: scraped.map((p) => ({
                ...p,
                visible: true,
                parentCode: p.parentProductId ?? null,
                exportDescription: null,
                stockSource: 'PAGE' as const,
            })),
            exportOnlyInStock: [],
            unmatchedScraped: [],
            idMismatches: [],
        };
    }

    const byCode = new Map(exported.map((e) => [e.code, e]));
    const byGuid = new Map<string, ExportProduct>();
    for (const e of exported) if (e.guid && !e.pairCode) byGuid.set(e.guid, e);

    const matchedCodes = new Set<string>();
    const unmatchedScraped: string[] = [];
    const idMismatches: MergeResult['idMismatches'] = [];

    const products = scraped.map((p): MergedProduct => {
        const e = byCode.get(p.sku) ?? (!p.hasVariants && p.guid ? byGuid.get(p.guid) : undefined);
        if (!e) {
            unmatchedScraped.push(p.sku);
            return {
                ...p,
                visible: true,
                parentCode: p.parentProductId ?? null,
                exportDescription: null,
                stockSource: 'PAGE',
            };
        }
        matchedCodes.add(e.code);

        let packGrams = p.packGrams;
        let packGramsSource = p.packGramsSource;
        let packGramsConflict = p.packGramsConflict;

        if (e.packGrams !== null) {
            packGrams = e.packGrams;
            packGramsSource = 'EXPORT';
            packGramsConflict = null;
            /**
             * Rozpor exportu s názvem se NEPŘEHLÍŽÍ. Reálný případ: kód 815
             * „Kost kalciová … 250g" má v exportu 100 g. Rozhodne cena za kg
             * (`resolveWeightConflict`), jinak jde produkt do reportu.
             * U varianty se bere název varianty („…: 1 kg"), ne společný
             * název produktu („500g, 1kg"), kde je víc čísel.
             */
            const fromName = parseGramsFromText(p.variantName ?? p.name);
            if (fromName !== null && Math.abs(fromName - e.packGrams) > e.packGrams * CONFLICT_TOLERANCE) {
                packGramsConflict = { authoritative: e.packGrams, fromName };
            }
        }

        // ---- ID PRO KOŠÍK: XML je autorita ----
        if (p.productId && p.productId !== e.productId) {
            idMismatches.push({ sku: p.sku, field: 'productId', page: p.productId, xml: e.productId });
        }
        let priceId = p.priceId;
        if (e.variantPriceId !== null) {
            if (p.priceId && p.priceId !== e.variantPriceId) {
                idMismatches.push({ sku: p.sku, field: 'priceId', page: p.priceId, xml: e.variantPriceId });
            }
            priceId = e.variantPriceId;
        } else if (p.productId && p.productId !== e.productId) {
            /**
             * Produkt bez variant a web ukazuje JINÝ produkt, než XML pod
             * tímhle kódem: `priceId` z webu patří k cizímu produktu.
             * Poslat ho s `productId` z XML by vložilo do košíku něco
             * jiného. Radši nedoporučit (priceId = null) a nahlásit.
             */
            priceId = null;
        }

        return {
            ...p,
            productId: e.productId,
            priceId,
            packGrams,
            packGramsSource,
            packGramsConflict,
            stockQuantity: e.stockQuantity ?? p.stockQuantity,
            stockSource: e.stockQuantity !== null ? 'EXPORT' : 'PAGE',
            guid: p.guid ?? e.guid,
            manufacturer: p.manufacturer ?? e.manufacturer,
            visible: e.visible,
            parentCode: e.pairCode ?? p.parentProductId ?? null,
            variantName: p.variantName ?? e.variantName,
            exportDescription: e.descriptionText,
        };
    });

    const exportOnlyInStock = exported
        .filter((e) => !matchedCodes.has(e.code) && e.visible && (e.stockQuantity ?? 0) > 0)
        .map((e) => ({ code: e.code, name: e.name, stockQuantity: e.stockQuantity ?? 0 }))
        .sort((a, b) => a.code.localeCompare(b.code));

    return {
        products,
        exportOnlyInStock,
        unmatchedScraped: unmatchedScraped.sort(),
        idMismatches: idMismatches.sort((a, b) => a.sku.localeCompare(b.sku)),
    };
}
