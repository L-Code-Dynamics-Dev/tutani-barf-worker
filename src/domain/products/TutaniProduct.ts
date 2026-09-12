/**
 * PRODUKT KATALOGU — kanonický tvar, na kterém stojí BARF surovinová
 * databáze (Lucky 2026-09-09).
 *
 * ROZDĚLENÍ VRSTEV (klíčové rozhodnutí zadání):
 *
 *   PRODUCTS       — co Tutani skutečně prodává (tenhle soubor)
 *   INGREDIENTS    — nutriční surovina (`domain/nutrition/Ingredient.ts`)
 *   COMPOSITIONS   — přesná vazba produkt→surovina (`Composition.ts`)
 *   NUTRIENTS      — USDA hodnoty (`domain/nutrition`)
 *   ANALYTICAL     — hodnoty deklarované VÝROBCEM (`Composition.ts`)
 *   SUPPLEMENTS    — vitaminy/minerály/oleje/přílohy (`Supplement.ts`)
 *   EVIDENCE       — zdroj+datum+confidence u všeho výše
 *
 * Hodnoty hovězích jater se NIKDY nepoužijí jako hodnota pro celý
 * produkt „Hovězí droby mleté" — kompozitní produkt se vždy nejdřív
 * rozloží na složky (`composition[]`), teprve ty nesou nutriční data.
 * `TutaniProduct` sám o sobě žádná nutrienta pole nemá — je to čistě
 * KATALOGOVÝ záznam plus odkaz na složení.
 */

import type { IngredientComposition, AnalyticalValue, ProductClaims, Evidence } from './Composition.js';

/**
 * Je produkt jednosložkový (čistá surovina, `composition.length === 1`
 * s `percentage: 100`), nebo kompozit více surovin?
 *
 * Rozlišuje se explicitně (ne odvozením z délky pole), protože
 * i jednosložkový produkt může mít `certainty: PARTIAL` (např. „100 %
 * losos" ale bez upřesnění, zda ořez nebo filet) — `kind` říká, jak se
 * s produktem smí zacházet ve výpočtu, `composition` říká co v něm je.
 */
export type ProductKind = 'SINGLE_INGREDIENT' | 'COMPOSITE' | 'SUPPLEMENT';

/**
 * Jeden produkt katalogu Tutani.
 *
 * Zůstává odděleno od `StoredProduct`/`products` tabulky v D1
 * (`infrastructure/D1ProductStore.ts`) — ta je matching engine dnešní
 * verze (BarfGroup-level, ostrý provoz). `TutaniProduct` je nová,
 * jemnější vrstva (ingredient-level) pro nutriční engine. Přechod mezi
 * nimi řeší `barf/composeProduct.ts`, žádná z tabulek se nepřepisuje —
 * NON-INTERFERENCE s otestovaným kódem.
 */
export interface TutaniProduct {
    productId: string;
    code: string;
    nameCs: string;
    brand: string | null;
    /** Plná cesta kategorie, jak ji Tutani uvádí (Shoptet `|`-cesta). */
    categoryPath: string | null;
    /** Pomocné zařazení pro navigaci v datasetu — ne vstup do výpočtu. */
    topCategory:
        | 'DRUBEZ' | 'HOVEZI' | 'KACHNA' | 'KLOKAN' | 'KONINA' | 'KRALIK'
        | 'JEHNECI_SKOPOVE' | 'KRUTA' | 'RYBY' | 'TELECI' | 'VEPROVE'
        | 'ZVERINA' | 'BARF_PRILOHA' | 'SUPPLEMENT' | 'CAT_BARF' | 'BARF_KOMPLET'
        | 'BARF_NA_CESTY' | 'ZOO_KRMIVO' | 'GRAF_BARF' | 'BARF_PRO_DRAVCE' | 'OTHER';

    priceWithVatCzk: number | null;
    packGrams: number | null;
    availability: 'IN_STOCK' | 'OUT_OF_STOCK' | 'UNKNOWN';
    url: string;

    kind: ProductKind;
    composition: IngredientComposition[];
    /**
     * Součet `percentage` u složek s `certainty: EXACT | DERIVED`.
     * Slouží jako rychlá kontrola úplnosti (mělo by být ~100, ale NENÍ
     * to vynucené — produkt s `PARTIAL` složkami legitimně nedosahuje
     * 100 a to je přesně to, co se má vidět, ne skrýt).
     */
    compositionAccountedPct: number;

    /** Hodnoty přímo ze štítku/popisu — oddělené od USDA nutrientů. */
    analytical: AnalyticalValue[];
    claims: ProductClaims;

    evidence: Evidence;
    updatedAt: string;
}

/**
 * Součet `percentage` u složek, kde je známý (EXACT nebo DERIVED).
 * Používá se při importu k naplnění `compositionAccountedPct` a při
 * validaci datasetu (kontrola, že žádný EXACT rozpad nepřekračuje
 * ~100 % o víc, než je rozumná tolerance popisu).
 */
export function accountedPct(composition: ReadonlyArray<IngredientComposition>): number {
    return Math.round(
        composition
            .filter((c) => c.percentage !== null && (c.certainty === 'EXACT' || c.certainty === 'DERIVED'))
            .reduce((sum, c) => sum + (c.percentage as number), 0) * 10
    ) / 10;
}
