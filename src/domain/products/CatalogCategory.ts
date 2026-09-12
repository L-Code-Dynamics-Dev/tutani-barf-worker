/**
 * STAV KATEGORIE KATALOGU — odlišuje „kategorie neexistuje/je prázdná"
 * od „kategorie existuje, ale crawler z ní zatím nevytáhl produkty".
 *
 * NÁLEZ (Lucky 2026-09-09): Graf Barf a Barf pro dravce jsou v Tutani
 * navigaci jako samostatné větve a jejich popis kategorie POTVRZUJE
 * model produktu (Graf Barf: šokově mražené kostky, svalovina+kosti/
 * chrupavky+droby, nemleté, lidská kvalita; dravci: jednodenní kuřátka,
 * mražené myši), ale aktuální crawler z nich nevrátil produktové řádky.
 *
 * ZÁSADNÍ ROZDÍL: to NENÍ totéž jako „kategorie má 0 produktů". Systém
 * by jinak tiše tvrdil, že Tutani dravčí BARF neprodává, což je
 * nepravda — jen ho ještě neumíme vytěžit. `PRODUCTS_NOT_EXTRACTED`
 * dělá tenhle rozdíl viditelný (stejný duch jako `NOT_ANALYZED` u
 * nutrientů — chybějící extrakce není nula).
 */
export type CatalogCategoryExtractionStatus =
    /** Produkty úspěšně vytaženy a jsou v `tutani-products.json`/`tutani-supplements.json`. */
    | 'PRODUCTS_EXTRACTED'
    /**
     * Kategorie v navigaci Tutani existuje a popis kategorie potvrzuje
     * typický produktový model, ale konkrétní SKU se z ní vytěžit
     * nepodařilo (crawler ji nevrátil, nebo je JS-rendered mimo dosah
     * dnešního scraperu). Engine tuhle kategorii NESMÍ považovat za
     * prázdnou — jen za neúplně pokrytou.
     */
    | 'CATALOG_CATEGORY_PRESENT_PRODUCTS_NOT_EXTRACTED'
    /** Kategorie záměrně vynechána (marketingový text bez SKU, viz BARF_STRAVA_PRO_PSY). */
    | 'MARKETING_ONLY_NO_SKU';

export interface CatalogCategoryRecord {
    categoryId: string;
    nameCs: string;
    status: CatalogCategoryExtractionStatus;
    /** Co popis kategorie potvrzuje o typickém produktu, i bez konkrétních SKU. */
    confirmedProductModelCs: string | null;
    /** Kolik SKU je touto kategorií pokryto v `tutani-products.json`/`tutani-supplements.json`. */
    extractedProductCount: number;
    noteCs: string | null;
    sourceDate: string;
}
