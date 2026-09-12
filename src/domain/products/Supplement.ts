/**
 * SUPPLEMENT — vitaminové/minerální přípravky a přílohy, oddělené
 * od masných surovin (Lucky 2026-09-09).
 *
 * PROČ VLASTNÍ TVAR DAT: štítek doplňku udává hodnoty v jiné jednotce
 * a na jiném základu než maso. Nutrin BARF Balancer říká „Zn 300 mg/kg",
 * ne „Zn X mg/100 g jak se krmí" jako USDA u masa. Kdyby se to vtlačilo
 * do `Ingredient.nutrients` (100 g as-fed), muselo by se přepočítat při
 * importu a PŮVODNÍ ŠTÍTKOVÁ HODNOTA by se ztratila — a tu Lucky chce
 * zachovat přesně tak, jak ji výrobce uvádí (auditovatelnost, R7 duch:
 * co je citace štítku, nesmí vypadat jako dopočet).
 *
 * Proto: `declaredValue` = přesně štítek (jednotka i základ beze
 * změny), `perHundredGrams` = odvozená hodnota pro engine, která PŘESNĚ
 * říká, že je odvozená (`derivedFrom` ukazuje na `declaredValue`).
 */

/** Základ, na který výrobce hodnotu vztahuje. Štítky to nesjednocují. */
export type SupplementBasis =
    | 'PERCENT_OF_PRODUCT'  // "Ca 2,6 %"
    | 'MG_PER_KG'           // "Cu 16,7 mg/kg"
    | 'UG_PER_KG'           // "Se 0,2 µg/kg" — TUT198, odděleno od MG_PER_KG (1000× rozdíl)
    | 'IU_PER_KG'           // "Vitamin A 29 040 IU/kg"
    | 'PERCENT_ANALYTICAL'; // analytické složky extrudované přílohy (protein 14,5 %…)

export interface DeclaredValue {
    nutrient: string;
    value: number;
    /** Jednotka přesně jak na štítku — `%`, `mg/kg`, `IU/kg`. */
    unit: string;
    basis: SupplementBasis;
}

/**
 * Hodnota přepočtená na 100 g produktu, aby ji šlo sečíst do stejné
 * dávky jako maso. `derivedFromNutrient` ukazuje zpět na `declaredValue`
 * se stejným klíčem — nikdy se needituje na místě štítková hodnota,
 * vždy se k ní dopočítá nová.
 *
 * Přepočet: `MG_PER_KG` → `/10` (mg/kg → mg/100g); `IU_PER_KG` →
 * `/10` (IU/kg → IU/100g, jednotka IU zůstává, převod na hmotnostní
 * jednotku vitaminu je samostatný krok engine, ne tady);
 * `PERCENT_OF_PRODUCT` a `PERCENT_ANALYTICAL` → `hodnota × 1000` mg/100g
 * (1 % = 1 g/100g = 1000 mg/100g).
 */
export interface DerivedPer100g {
    nutrient: string;
    value: number;
    unit: string;
}

export function derivePer100g(d: DeclaredValue): DerivedPer100g {
    switch (d.basis) {
        case 'MG_PER_KG':
            return { nutrient: d.nutrient, value: d.value / 10, unit: 'mg' };
        case 'UG_PER_KG':
            return { nutrient: d.nutrient, value: d.value / 10, unit: 'ug' };
        case 'IU_PER_KG':
            return { nutrient: d.nutrient, value: d.value / 10, unit: 'IU' };
        case 'PERCENT_OF_PRODUCT':
        case 'PERCENT_ANALYTICAL':
            return { nutrient: d.nutrient, value: d.value * 1000, unit: 'mg' };
        default: {
            const _exhaustive: never = d.basis;
            throw new Error(`Neznámý basis: ${_exhaustive}`);
        }
    }
}

/**
 * Seznam ingrediencí doplňku/přílohy tak, jak je uvádí výrobce
 * (např. extrudovaná příloha: pohanka, jáhly, pivovarské kvasnice…).
 * Bez procent — Tutani je u příloh neuvádí a systém je NEVYMÝŠLÍ (R7).
 */
export interface SupplementIngredientList {
    itemsCs: string[];
    /** `null`, pokud výrobce pořadí/podíl neuvádí (obvyklý případ). */
    orderedByQuantity: boolean;
}

/**
 * Minerální produkt (křemelina) evidovaný jako oxidový rozbor, NE
 * jako potravina — Lucky: „budeme ho evidovat jako minerální produkt,
 * nikoli jako potravinu". Odlišná kategorie od `nutrients`/`analytical`,
 * protože oxidové procento (SiO2, CaO…) není totéž co elementární obsah
 * minerálu a nesmí se s ním sčítat bez přepočtu.
 */
export interface MineralAssay {
    compound: string; // "SiO2", "CaO", "Fe2O3"…
    percentOfProduct: number;
}

/**
 * Rozšířeno 2026-09-09 o kategorie z druhé vlny katalogu (přílohy,
 * doplňky, pamlsky, BARF na cesty). `role`-tag z Luckyho zadání:
 * MASO/VNITŘNOST/KOST patří do `TutaniProduct.topCategory` (jsou to
 * masné produkty), tady jsou jen ty NE-masné role.
 */
export type SupplementCategory =
    | 'VITAMIN_MINERAL_PREMIX' // Nutrin BARF Balancer, Dromy Balancer BARF
    | 'EXTRUDED_SIDE_DISH'     // extrudovaná příloha, sušená zeleninová směs
    | 'OIL'                    // Dromy FLEX, Krill Pure, Energy Omegavet
    | 'MINERAL_ASSAY'          // křemelina
    | 'FIBER'                  // Psyllium
    | 'TREAT'                  // pamlsky — výcvikové, sušené maso, kroužky
    | 'THERAPEUTIC_SUPPLEMENT' // Energy řada (Skelevet, Regavet, Kingvet, Imunovet) — cílený zdravotní účel, ne základní BARF doplněk
    | 'OTHER';

/**
 * Věcné/marketingové tvrzení výrobce, KTERÉ NENÍ ČÍSLO — „podporuje
 * imunitu", „zdroj omega-3 mastných kyselin", zdravotní účinky kelpy
 * apod.
 *
 * ZÁSADNÍ ODDĚLENÍ (Lucky 2026-09-09): „Tutani u kelpy uvádí řadu
 * zdravotních účinků, ale do nutričního engine se z toho nesmí
 * automaticky stát účinek." Tvrzení se ukládá SEM, do textu — nikdy se
 * z něj nevyrábí `declared`/`derivedPer100g` hodnota. Engine počítá
 * jen s `DeclaredValue`, kde je konkrétní číslo a jednotka.
 *
 * Konkrétní pravidlo (Omegavet příklad): produkt se smí evidovat jako
 * zdroj EPA/DHA JEN tehdy, když existuje `DeclaredValue` s
 * `nutrient: 'epa'`/`'dha'` a konkrétním mg — tvrzení „obsahuje
 * omega-3" samo o sobě do `declared` nikdy nevstupuje.
 */
export interface MarketingClaim {
    claimCs: string;
    /** Je tvrzení podloženo konkrétní `DeclaredValue` položkou, nebo je jen textové? */
    backedByDeclaredNutrient: string | null;
}

export interface Supplement {
    productId: string;
    code: string;
    nameCs: string;
    brand: string | null;
    category: SupplementCategory;

    /** Přesně jak na štítku — základ výpočtu níže. Jen ČÍSELNÉ hodnoty s jednotkou. */
    declared: DeclaredValue[];
    /** Odvozeno z `declared` pro engine — nikdy ruční vstup. */
    derivedPer100g: DerivedPer100g[];
    /** Textová tvrzení výrobce — NIKDY se z nich nedopočítává `declared`. */
    marketingClaims: MarketingClaim[];

    ingredientList: SupplementIngredientList | null;
    mineralAssay: MineralAssay[] | null;

    /** Dávkovací doporučení výrobce, jak je uvádí (text, ne dopočet). */
    dosageInstructionCs: string | null;

    packGrams: number | null;
    priceWithVatCzk: number | null;
    availability: 'IN_STOCK' | 'OUT_OF_STOCK' | 'UNKNOWN';
    url: string;

    evidence: {
        source: 'MANUFACTURER_LABEL' | 'TUTANI_PRODUCT_PAGE';
        sourceDate: string;
        confidence: 'EXACT';
        noteCs?: string;
    };
    updatedAt: string;
}
