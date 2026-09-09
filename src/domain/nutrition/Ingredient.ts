/**
 * NUTRIČNÍ DATABÁZE SUROVIN — datový model.
 *
 * Zdroj struktury: znalostní báze Lucky, body 66, 90 a díl o zdrojích
 * dat (FEDIAF 2025 + USDA FoodData Central).
 *
 * ZÁSADNÍ ROZHODNUTÍ O JEDNOTKÁCH:
 *
 * Hodnoty se ukládají **na 100 g suroviny jak se krmí** (as-fed),
 * NE na sušinu. Důvod: uživatel váží mokré maso, ne sušinu, a převod
 * na sušinu potřebuje obsah vody — ten se u masa liší podle tuku
 * a části zvířete.
 *
 * FEDIAF ale udává potřeby **na 1000 kcal ME** (a na 100 g sušiny).
 * Engine tedy NESMÍ říct „pes potřebuje 5 mg zinku". Musí říct:
 *
 *   „pes při této energetické potřebě potřebuje aspoň X mg zinku
 *    na 1000 kcal"
 *
 * Převodní cesta je proto vždy:
 *
 *   surovina (na 100 g) × gramy v dávce  →  absolutní příjem
 *   absolutní příjem / (kcal dávky / 1000) →  příjem na 1000 kcal
 *   porovnat s FEDIAF cílem na 1000 kcal
 *
 * FEDIAF sám upozorňuje, že převody mezi „na 100 g sušiny" a „na
 * 1000 kcal" předpokládají určitou energetickou hustotu — u potravin
 * s jinou hustotou se doporučení musí korigovat. Proto se u každé
 * suroviny ukládá `kcal` i `waterG`: bez nich převod není možný.
 *
 * KAŽDÁ HODNOTA MÁ ZDROJ (bod 66: `source`, `source_date`,
 * `confidence`). To je oprava nálezu auditu, že naše čísla se
 * v odpovědi tváří jako citace, i když jsou to převody.
 */

import type { SourceTier } from './energy.js';

/** Jak byla hodnota získána. Řídí, jak silně se na ni lze odvolat. */
export type DataConfidence =
    | 'ANALYZA'    // laboratorní rozbor konkrétního produktu
    | 'DATABAZE'   // analytická databáze (USDA FoodData Central, Frida)
    | 'TABULKA'    // publikovaná tabulka bez rozboru vzorku
    | 'ODHAD'      // odvozeno z podobné suroviny — NENÍ měření
    | 'CHYBI';     // hodnota není a nedopočítává se (R7)

/**
 * Stav hodnoty — ROZLIŠUJE „je to nula" od „nikdo to neměřil".
 *
 * ZÁSADNÍ (Lucky): `value = 0` a `NOT_ANALYZED` nesmí splynout.
 * USDA sám upozorňuje, že část komponent zatím nebyla analyzována
 * a hodnoty se doplňují. Kdyby se neanalyzovaná položka počítala
 * jako nula:
 *
 *   - součet vitaminu D by vyšel 0 → engine hlásí NEDOSTATEK
 *   - a doporučí suplementaci, kterou pes možná nepotřebuje
 *
 * Naopak skutečná nula je platná informace: rostlinná surovina
 * opravdu neobsahuje vitamin B12.
 */
export type ValueStatus =
    | 'MEASURED'      // změřeno, `value` platí (i když je 0)
    | 'NOT_ANALYZED'  // nikdo neměřil — NENÍ to nula
    | 'TRACE'         // stopové množství pod hranicí kvantifikace
    | 'NOT_PRESENT';  // surovina živinu prokazatelně neobsahuje

/**
 * Jedna nutriční hodnota se svou evidencí.
 *
 * Nikdy se neukládá jen číslo: bez `confidence` a `source` by se
 * tabulková hodnota pro „hovězí maso" tvářila stejně jako rozbor
 * konkrétního produktu Tutani. To je přesně ten problém, na který
 * upozornil audit.
 */
export interface NutrientValue {
    /**
     * Hodnota na 100 g suroviny jak se krmí.
     *
     * Čte se VŽDY spolu se `status`: `value: 0` s `MEASURED` je nula,
     * `value: null` s `NOT_ANALYZED` je neznámo. Zaměnit to znamená
     * doporučit suplementaci naslepo.
     */
    value: number | null;
    /** Odlišuje měřenou nulu od neměřené hodnoty. */
    status: ValueStatus;
    unit: string;
    confidence: DataConfidence;
    source: SourceTier | 'USDA' | 'FRIDA' | 'DODAVATEL';
    /** Kdy hodnota vznikla nebo byla naposled ověřena (ISO). */
    sourceDate?: string;
    /** Identifikátor v databázi zdroje — např. USDA FDC ID. */
    sourceRef?: string;
    /** Poznámka: variabilita, část zvířete, sezónnost. */
    noteCs?: string;
}

/** Skupina hodnot. Klíč je název živiny (`protein`, `calcium`…). */
export type NutrientMap = Record<string, NutrientValue>;

/**
 * Kterou část zvířete surovina představuje. Bod 15 a 50: orgány
 * NEJSOU navzájem zaměnitelné — játra ≠ ledvina ≠ slezina ≠ srdce.
 */
export type EdiblePart =
    | 'MUSCLE'          // svalovina
    | 'MUSCLE_ORGAN'    // srdce, jazyk — nutričně svalovina (bod 50)
    | 'SECRETORY_LIVER' // játra
    | 'SECRETORY_KIDNEY'
    | 'SECRETORY_SPLEEN'
    | 'SECRETORY_OTHER'
    | 'BONE'
    | 'CARTILAGE'
    | 'SKIN_FAT'
    | 'WHOLE_PREY'
    | 'EGG'
    | 'EGGSHELL'        // zdroj Ca — bod 51, počítá se ELEMENTÁRNÍ Ca
    | 'DAIRY'
    | 'FISH_WHOLE'
    | 'FISH_FILLET'
    | 'OIL'
    | 'VEGETABLE'
    | 'FRUIT'
    | 'CEREAL'
    | 'SUPPLEMENT';

export type Species =
    | 'BEEF' | 'PORK' | 'CHICKEN' | 'TURKEY' | 'DUCK' | 'RABBIT'
    | 'LAMB' | 'HORSE' | 'GAME' | 'FISH' | 'KANGAROO'
    | 'PLANT' | 'MINERAL' | 'OTHER';

/**
 * Riziko nadbytku u konkrétní suroviny.
 *
 * Bod 14: surovina musí mít v systému nejen „benefit", ale i riziko.
 * Játra jsou zdravá, a přesto může jejich nadbytek uškodit — proto
 * `vitaminA_excess` a `copper_excess` jako samostatné příznaky.
 */
export type ExcessRisk =
    | 'VITAMIN_A_EXCESS'
    | 'COPPER_EXCESS'
    | 'VITAMIN_D_EXCESS'
    | 'IODINE_EXCESS'
    | 'SELENIUM_EXCESS'
    | 'FAT_EXCESS'
    | 'CALCIUM_EXCESS'
    | 'PHOSPHORUS_EXCESS';

/**
 * Jedna surovina nutriční databáze.
 *
 * `nutrients` je záměrně mapa, ne pevná pole: FEDIAF i USDA přidávají
 * živiny a nová položka nemá znamenat změnu typu ani migraci.
 */
export interface Ingredient {
    id: string;
    nameCs: string;
    /** Jak to zákazník najde v katalogu — pro párování s produkty. */
    aliasesCs?: string[];
    species: Species;
    part: EdiblePart;
    /** `true` = surová, `false` = tepelně upravená (bod 66 `raw_cooked`). */
    raw: boolean;

    /** Energie na 100 g as-fed. Bez ní nelze převádět na 1000 kcal. */
    kcalPer100g: NutrientValue;
    /** Obsah vody na 100 g. Bez ní nelze přepočítat na sušinu. */
    waterG: NutrientValue;

    /** Makroživiny, minerály, vitaminy, mastné kyseliny — vše na 100 g. */
    nutrients: NutrientMap;

    /** Rizika nadbytku (bod 14). */
    excessRisks?: ExcessRisk[];
    /**
     * Bezpečnostní zvláštnosti, které nejsou o živinách:
     * thiamináza v surových rybách, avidin v surovém bílku,
     * laktóza v mléčných výrobcích (body 21, 22, 56).
     */
    safetyNotesCs?: string[];

    updatedAt: string;
}

/**
 * Cílová hodnota živiny podle FEDIAF (bod 91 `Rule`).
 *
 * `basis` je klíčové: `PER_1000_KCAL` je to, co FEDIAF primárně
 * udává, a co engine musí použít. `PER_100G_DM` je alternativa pro
 * sušinu a nelze ji míchat s prvním bez znalosti energetické hustoty.
 */
export interface NutrientTarget {
    nutrient: string;
    lifeStage: 'ADULT' | 'GROWTH' | 'GROWTH_LARGE_BREED' | 'PREGNANCY' | 'LACTATION';
    min: number | null;
    max: number | null;
    unit: string;
    basis: 'PER_1000_KCAL' | 'PER_100G_DM' | 'PER_KG_BW';
    source: SourceTier;
    sourceVersion: string;
    confidence: DataConfidence;
    notesCs?: string;
}

/**
 * Přepočet příjmu živiny na základ FEDIAF (na 1000 kcal).
 *
 * Vrací `null`, když chybí energie dávky — bez ní převod NELZE
 * udělat a odhadovat ho by znamenalo vydávat dohad za měření.
 */
export function perThousandKcal(
    absoluteIntake: number,
    dietKcal: number
): number | null {
    if (!Number.isFinite(absoluteIntake) || !Number.isFinite(dietKcal)) return null;
    if (dietKcal <= 0) return null;
    return (absoluteIntake / dietKcal) * 1000;
}

/**
 * Příspěvek suroviny k jedné živině pro dané množství v gramech.
 *
 * `null` znamená „tuhle živinu u téhle suroviny neznáme" — a takový
 * výsledek se NESMÍ sečíst jako nula. Součet, do kterého vstupuje
 * `null`, je neúplný a musí to být vidět (bod 95: 🟡 ORIENTAČNÍ).
 */
export function contribution(
    ingredient: Ingredient,
    nutrientKey: string,
    grams: number
): number | null {
    if (!Number.isFinite(grams) || grams <= 0) return 0;
    const nv = ingredient.nutrients[nutrientKey];
    if (!nv) return null;

    /**
     * `NOT_ANALYZED` se NIKDY nepočítá jako nula — vrací `null`, aby
     * to součet přiznal jako neúplný. `NOT_PRESENT` a `TRACE` naopak
     * nulu znamenají: surovina živinu prokazatelně nemá.
     */
    if (nv.status === 'NOT_ANALYZED' || nv.confidence === 'CHYBI') return null;
    if (nv.status === 'NOT_PRESENT') return 0;
    if (nv.status === 'TRACE') return 0;
    if (nv.value === null) return null;

    return (nv.value * grams) / 100;
}

/**
 * Součet příspěvků, který PŘIZNÁVÁ neúplnost.
 *
 * `complete: false` znamená, že aspoň jedna surovina hodnotu nemá,
 * takže součet je dolní hranicí, ne skutečností. Bez téhle informace
 * by systém tvrdil „vápníku je dost", i když polovinu surovin
 * nezměřil.
 */
export function sumContributions(
    items: ReadonlyArray<{ ingredient: Ingredient; grams: number }>,
    nutrientKey: string
): { total: number; complete: boolean; missingIds: string[] } {
    let total = 0;
    const missingIds: string[] = [];

    for (const it of items) {
        const c = contribution(it.ingredient, nutrientKey, it.grams);
        if (c === null) {
            missingIds.push(it.ingredient.id);
            continue;
        }
        total += c;
    }
    return { total, complete: missingIds.length === 0, missingIds };
}
