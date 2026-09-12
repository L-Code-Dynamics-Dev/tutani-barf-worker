/**
 * SLOŽENÍ PRODUKTU — vazba produkt → surovina, s upřímnou mírou jistoty.
 *
 * ZDROJ ZADÁNÍ (Lucky, 2026-09-09, „Co teď z katalogu evidujeme"):
 * Tutani uvádí složení produktů ve třech kvalitativně různých tvarech
 * a systém je NESMÍ srovnat na jednu úroveň jistoty:
 *
 *   TUT175 „40 % plíce / 30 % ledviny / 30 % játra"      → EXACT
 *   TUT155 „ledviny, plíce, játra" (bez poměru)          → PARTIAL
 *   TUT223 „50 % maso / 50 % zelenina (mrkev, petržel…)" → EXACT navenek,
 *          ale vnitřní poměr zeleninové půlky je PARTIAL
 *
 * ZÁSADA (R7, stejná jako u `parseComposition.ts`): když Tutani poměr
 * neuvedl, systém ho NEVYMÝŠLÍ. `PARTIAL` složka nese `percentage: null`
 * a engine s ní musí zacházet jako s neúplným údajem (podobně jako
 * `NOT_ANALYZED` u nutrientů v `Ingredient.ts`) — ne jako s rovnoměrným
 * rozpadem, který by byl tichý odhad.
 */

import type { Species, EdiblePart } from '../nutrition/Ingredient.js';

/**
 * Jak jistě víme, že tahle složka a tenhle podíl v produktu skutečně
 * jsou.
 *
 * Pořadí od nejjistější: `EXACT` je citace štítku/popisu, `DERIVED`
 * je dopočet z jiných EXACT hodnot (typicky doplněk do 100 %),
 * `PARTIAL` je složka bez podílu, `UNKNOWN` je mezera, kterou systém
 * PŘIZNÁVÁ, ne domýšlí.
 */
export type CompositionCertainty =
    | 'EXACT'    // Tutani uvedl procento explicitně v textu
    | 'DERIVED'  // dopočteno ze zbytku, když ostatní složky jsou EXACT a sedí na ~100 %
    | 'PARTIAL'  // Tutani uvedl složku, ale ŽÁDNÝ podíl u ní ani u sourozenců
    | 'UNKNOWN'; // podíl produktu se nedá určit vůbec (chybí i seznam složek)

/**
 * Role složky v receptuře — odlišuje jednu konkrétní surovinu od
 * SKUPINY více surovin uvedené jako jeden podíl (TUT223: „50 %
 * zeleninová směs" je jedna položka compositionu, ale skrývá tři
 * druhy zeleniny bez vzájemného poměru).
 */
export type CompositionRole = 'INGREDIENT' | 'INGREDIENT_GROUP';

/**
 * Jedna složka produktu — konkrétní surovina a (možná) její podíl.
 *
 * `ingredientId` míří do `domain/nutrition` katalogu surovin
 * (`beef_liver`, `beef_lung`…), NE do `BarfGroup` (`ORGAN`). Skupina
 * (`barfGroup`) se dá z `ingredientId` odvodit engine-side; tady se
 * ukládá surovina samotná, protože to je úroveň, na které se dělá
 * nutriční výpočet.
 *
 * `ingredientId: null` znamená: text říká, o jakou jde skupinu/druh,
 * ale konkrétní surovinu z nutričního katalogu k tomu nelze spárovat
 * (např. „hovězí plíce" a katalog part `LUNG` zatím nemá záznam) —
 * to NENÍ důvod složku zahodit, jen důvod nutriční výpočet u ní
 * hlásit jako neúplný (stejný mechanismus jako `NOT_ANALYZED`).
 *
 * `role: INGREDIENT_GROUP` (TUT223 zeleninová směs) nese `percentage`
 * za CELOU skupinu (EXACT, protože „50 %" Tutani uvedl), ale
 * `subcomponents` jsou vyjmenované druhy BEZ poměru mezi sebou —
 * `subcomponentRatio: 'UNKNOWN'` to řekne explicitně, engine nesmí
 * dělit 50 % rovnoměrně na tři.
 */
export interface IngredientComposition {
    /** Odkaz do nutričního katalogu, nebo `null` = surovina bez záznamu. */
    ingredientId: string | null;
    /** Pro čitelnost auditu a fallback, když `ingredientId` chybí. */
    nameCs: string;
    species: Species | null;
    part: EdiblePart | null;

    role: CompositionRole;
    /**
     * Jen u `role: INGREDIENT_GROUP` — druhy uvnitř skupiny, které
     * Tutani vyjmenoval, ale bez vzájemného podílu. Prázdné pole
     * u `role: INGREDIENT`.
     */
    subcomponentsCs: string[];
    subcomponentRatio: 'UNKNOWN' | null;

    /** `null`, pokud `certainty` je `PARTIAL` nebo `UNKNOWN` (R7). */
    percentage: number | null;
    certainty: CompositionCertainty;

    /**
     * Přesný úryvek textu, ze kterého se složka odvodila — auditní
     * stopa, aby šlo ověřit, že se nic nedomyslelo.
     */
    sourceCs: string;
}

/**
 * Analytická hodnota deklarovaná VÝROBCEM na obalu/popisu — odlišná
 * evidence od nutričních dat USDA (`domain/nutrition`).
 *
 * ZÁSADNÍ ODDĚLENÍ (Lucky): „Tutani uvádí toto složení, USDA pro
 * jednotlivé komponenty uvádí tyto hodnoty" — DVĚ evidence, NIKDY
 * sloučené do jedné pravdy. `AnalyticalValue` je ta první: co říká
 * štítek. Nutriční dopočet z USDA surovin je vždy spočten zvlášť
 * a engine je prezentuje vedle sebe, ne jako jedno číslo.
 */
export interface AnalyticalValue {
    nutrient: string;
    value: number;
    /** Přesně jak výrobce uvádí — `%`, `mg/kg`, `IU/kg`, `g`… */
    unit: string;
    /** Základ, ke kterému se hodnota vztahuje (štítek to málokdy říká explicitně). */
    basis: 'PER_KG_PRODUCT' | 'PERCENT_OF_PRODUCT' | 'PER_100G_PRODUCT' | 'UNSPECIFIED';
}

/**
 * Nutriční hodnota DOPOČTENÁ enginem z rozloženého složení + USDA dat —
 * protiváha k `AnalyticalValue` (co říká štítek).
 *
 * ZÁSADNÍ ROZDÍL (Lucky): „Tutani tvrdí X" (`AnalyticalValue`) vs.
 * „náš výpočet z komponent vychází na Y" (`CalculatedNutritionValue`).
 * Engine je NIKDY neslučuje do jednoho čísla — prezentují se vedle
 * sebe, i když nesouhlasí. Nesoulad je informace (možný důkaz, že
 * complet reálné složení produktu je jiné, než popisek říká), ne chyba
 * k potichu opravení.
 */
export interface CalculatedNutritionValue {
    nutrient: string;
    /** `null`, když je součet neúplný (chybějící ingredient nebo NOT_ANALYZED živina). */
    value: number | null;
    unit: string;
    calculationMethod: 'WEIGHTED_SUM_OF_EXACT_COMPOSITION' | 'PARTIAL_COMPOSITION_LOWER_BOUND';
    /**
     * `COMPLETE` = všechny složky měly `certainty: EXACT|DERIVED` a
     * všechny potřebné živiny byly `MEASURED`. Cokoliv jiného
     * (`INGREDIENT_GROUP` bez poměru, chybějící ingredientId,
     * `NOT_ANALYZED` živina) → `INCOMPLETE`, hodnota je dolní odhad,
     * ne skutečnost.
     */
    confidence: 'COMPLETE' | 'INCOMPLETE';
    /** Které složky produktu do součtu nešly (a proč) — auditní stopa. */
    missingCs: string[];
}

/** Věcná tvrzení z popisu produktu — ne nutriční, ale relevantní pro filtr. */
export interface ProductClaims {
    rawDescriptionCs: string | null;
    ageCategory: 'PUPPY' | 'ADULT' | 'SENIOR' | 'ALL' | null;
    dietaryClaimsCs: string[];
}

/** Kdy a odkud byl produkt/hodnota naposled ověřena — audit napříč vrstvami. */
export interface Evidence {
    source: 'TUTANI_PRODUCT_PAGE' | 'TUTANI_CATEGORY_PAGE' | 'USDA' | 'MANUFACTURER_LABEL' | 'LUCKY_MANUAL';
    sourceDate: string;
    confidence: 'EXACT' | 'DERIVED' | 'ESTIMATED' | 'UNKNOWN';
    noteCs?: string;
}
