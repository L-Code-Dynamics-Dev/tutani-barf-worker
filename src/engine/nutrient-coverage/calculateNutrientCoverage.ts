/**
 * NUTRIENT COVERAGE — propojení nutriční vrstvy do skutečného výpočtu.
 *
 * NÁLEZ AUDITU 2026-09-12 (docs/ARCHITECTURE_AUDIT.md, D-1): `Ingredient.ts`,
 * `TutaniProduct.ts`, `assessment.ts` a `fediaf-2025.json` existují jako
 * hotové typy a data, ale `calculateDose`/`matchProducts` s nimi nepočítají —
 * produkční tok počítá jen na úrovni `BarfGroup` (gramy MUSCLE/BONE/…).
 * Tenhle modul je propojka: BEZ ZMĚNY `calculateDose`/`matchProducts`
 * (non-interference s otestovaným kódem) spočítá z JIŽ HOTOVÉHO výstupu
 * (`MatchedProduct[]` + FEDIAF cíle) nutriční pokrytí dávky.
 *
 * ŽÁDNÉ LLM, čistá funkce, žádné I/O — stejná disciplína jako zbytek enginu.
 *
 * FAIL-SAFE (R7): produkt bez nalezeného `TutaniProduct` záznamu, složka
 * s `certainty: PARTIAL|UNKNOWN`, nebo živina se `status: NOT_ANALYZED`
 * se NIKDY nepočítá jako nula — `NutrientCheck.status` je `NEZNAME`,
 * ne `OK` s tichým podhodnocením.
 */

import type { NutrientTarget } from '../../domain/nutrition/Ingredient.js';
import type { NutrientCheck, NutrientStatus } from '../../domain/nutrition/assessment.js';
import type { SourceTier } from '../../domain/nutrition/energy.js';
import type { IngredientComposition } from '../../domain/products/Composition.js';
import type { TutaniProduct } from '../../domain/products/TutaniProduct.js';

/** Nutriční databáze surovin — jen to, co tenhle modul potřebuje z `Ingredient`. */
export interface NutrientDataIngredient {
    id: string;
    nutrients: Record<
        string,
        { value: number | null; status: 'MEASURED' | 'NOT_ANALYZED' | 'TRACE' | 'NOT_PRESENT'; unit: string }
    >;
}

/** Produkt vybraný v `matchProducts` + gramy za den (ne za celé období). */
export interface CoverageInput {
    sku: string;
    gramsPerDay: number;
}

export interface NutrientCoverageDeps {
    /** Katalog `TutaniProduct` — ingredient-level složení. Klíč je `code`. */
    products: ReadonlyMap<string, TutaniProduct>;
    /** Nutriční databáze surovin. Klíč je `ingredientId`. */
    ingredients: ReadonlyMap<string, NutrientDataIngredient>;
    /** FEDIAF (nebo jiný standard) cíle na 1000 kcal ME. */
    targets: readonly NutrientTarget[];
    /** Energie dávky (kcal/den) — bez ní nelze převést na PER_1000_KCAL. */
    dietKcalPerDay: number | null;
}

const LABELS_CS: Record<string, string> = {
    protein: 'Bílkoviny',
    fat: 'Tuk',
    calcium: 'Vápník (Ca)',
    phosphorus: 'Fosfor (P)',
    caPRatio: 'Poměr Ca:P',
    vitaminA: 'Vitamin A',
    vitaminD: 'Vitamin D',
    vitaminE: 'Vitamin E',
    iodine: 'Jód',
    zinc: 'Zinek',
    copper: 'Měď',
    iron: 'Železo',
    selenium: 'Selen',
    sodium: 'Sodík',
    potassium: 'Draslík',
    magnesium: 'Hořčík',
    manganese: 'Mangan',
    epa: 'EPA',
    dha: 'DHA',
};

/**
 * Jedna živina jednoho produktu, přepočtená na absolutní příjem/den.
 *
 * Vrací `null`, když příjem nelze určit — a `null` se NESMÍ sečíst jako 0
 * (stejná zásada jako `contribution()` v `Ingredient.ts`, tady jen na
 * úrovni celého produktu s možná neúplným složením, ne jedné suroviny).
 */
function productNutrientIntake(
    product: TutaniProduct,
    ingredients: ReadonlyMap<string, NutrientDataIngredient>,
    nutrientKey: string,
    productGrams: number
): { amount: number | null; incomplete: boolean; missingCs: string[] } {
    const missingCs: string[] = [];
    let total = 0;
    let anyKnown = false;

    for (const part of product.composition) {
        const partResult = compositionPartIntake(part, ingredients, nutrientKey);
        if (partResult === null) {
            missingCs.push(part.nameCs);
            continue;
        }
        anyKnown = true;
        total += partResult;
    }

    // Neúplné složení (PARTIAL/UNKNOWN podíl, nebo chybějící ingredientId)
    // znamená, že součet je jen DOLNÍ ODHAD — přizná se jako neúplný.
    const incomplete = missingCs.length > 0 || product.composition.length === 0;

    if (!anyKnown && product.composition.length > 0) {
        return { amount: null, incomplete: true, missingCs };
    }

    // `total` je na 100 g produktu → přepočet na skutečnou gramáž v dávce.
    return { amount: (total * productGrams) / 100, incomplete, missingCs };
}

/**
 * Příspěvek jedné složky produktu (surovina nebo skupina surovin)
 * k živině, na 100 g PRODUKTU (ne na 100 g té složky).
 *
 * `null` = nelze určit (chybí `ingredientId`, surovina není v databázi,
 * podíl je `PARTIAL`/`UNKNOWN`, nebo živina je u suroviny `NOT_ANALYZED`).
 */
function compositionPartIntake(
    part: IngredientComposition,
    ingredients: ReadonlyMap<string, NutrientDataIngredient>,
    nutrientKey: string
): number | null {
    if (part.percentage === null) return null; // PARTIAL/UNKNOWN — R7
    if (part.ingredientId === null) return null; // surovina bez záznamu v katalogu

    const ing = ingredients.get(part.ingredientId);
    if (!ing) return null;

    const nv = ing.nutrients[nutrientKey];
    if (!nv) return null;
    if (nv.status === 'NOT_ANALYZED') return null; // NIKDY nula (R7)
    if (nv.status === 'NOT_PRESENT' || nv.status === 'TRACE') return 0;
    if (nv.value === null) return null;

    // `nv.value` je na 100 g SUROVINY. Složka je `percentage` % PRODUKTU,
    // takže příspěvek na 100 g produktu je `value × percentage / 100`.
    return (nv.value * part.percentage) / 100;
}

/**
 * Cíl FEDIAF pro danou živinu, přepočtený z PER_1000_KCAL na denní gramy.
 * Vrací `null`, když FEDIAF pro tuhle fázi hodnotu neuvádí (`NOT_SPECIFIED`)
 * nebo když chybí energie dávky — bez kcal nelze převod udělat (R7).
 */
function resolveTargetPerDay(
    target: NutrientTarget,
    dietKcalPerDay: number | null
): { min: number | null; max: number | null } | null {
    if (dietKcalPerDay === null || !Number.isFinite(dietKcalPerDay) || dietKcalPerDay <= 0) return null;
    if (target.min === null) return null;
    const factor = dietKcalPerDay / 1000;
    return {
        min: target.min * factor,
        max: target.max !== null ? target.max * factor : null,
    };
}

/**
 * Spočítá nutriční pokrytí dávky z vybraných produktů.
 *
 * Vstup je JIŽ HOTOVÝ výstup `matchProducts` (sku + gramy/den) — tahle
 * funkce nepočítá dávku ani nevybírá produkty, jen na existující výsledek
 * napočítává druhou vrstvu informace. `calculateDose`/`matchProducts`
 * zůstávají beze změny.
 */
export function calculateNutrientCoverage(
    selected: readonly CoverageInput[],
    deps: NutrientCoverageDeps
): NutrientCheck[] {
    const checks: NutrientCheck[] = [];

    for (const target of deps.targets) {
        const targetPerDay = resolveTargetPerDay(target, deps.dietKcalPerDay);

        if (targetPerDay === null) {
            checks.push({
                key: target.nutrient,
                labelCs: LABELS_CS[target.nutrient] ?? target.nutrient,
                status: 'NEZNAME',
                unit: target.unit,
                source: target.source as SourceTier,
                reasonCs:
                    deps.dietKcalPerDay === null
                        ? 'energie dávky není známa, nelze převést FEDIAF cíl na gramy'
                        : `${target.source} pro tuto životní fázi hodnotu neuvádí`,
            });
            continue;
        }

        let total = 0;
        let anyIncomplete = false;
        let anyKnownProduct = false;
        const missingProducts: string[] = [];

        for (const item of selected) {
            const product = deps.products.get(item.sku);
            if (!product) {
                missingProducts.push(item.sku);
                anyIncomplete = true;
                continue;
            }
            const result = productNutrientIntake(product, deps.ingredients, target.nutrient, item.gramsPerDay);
            if (result.incomplete) anyIncomplete = true;
            if (result.amount === null) continue;
            anyKnownProduct = true;
            total += result.amount;
        }

        if (!anyKnownProduct && selected.length > 0) {
            checks.push({
                key: target.nutrient,
                labelCs: LABELS_CS[target.nutrient] ?? target.nutrient,
                status: 'NEZNAME',
                unit: target.unit,
                targetMin: targetPerDay.min ?? undefined,
                targetMax: targetPerDay.max ?? undefined,
                source: target.source as SourceTier,
                reasonCs: 'žádný z vybraných produktů nemá pro tuto živinu dostupná data',
            });
            continue;
        }

        const status: NutrientStatus =
            targetPerDay.min !== null && total < targetPerDay.min
                ? 'NEDOSTATEK'
                : targetPerDay.max !== null && total > targetPerDay.max
                  ? 'NADBYTEK'
                  : 'OK';

        checks.push({
            key: target.nutrient,
            labelCs: LABELS_CS[target.nutrient] ?? target.nutrient,
            // Neúplná data (chybějící produkt/suroviny) → hodnota je jen
            // DOLNÍ ODHAD, ne jistota. Nikdy se netvrdí OK, pokud je součet
            // neúplný a přitom nedosahuje minima — mohlo by to ve
            // skutečnosti stačit, systém to ale neumí potvrdit (R7).
            status: anyIncomplete && status !== 'NEDOSTATEK' ? 'NEZNAME' : status,
            value: Math.round(total * 100) / 100,
            unit: target.unit,
            targetMin: targetPerDay.min ?? undefined,
            targetMax: targetPerDay.max ?? undefined,
            source: target.source as SourceTier,
            reasonCs: anyIncomplete
                ? `data neúplná (${missingProducts.length > 0 ? 'produkt(y) mimo katalog: ' + missingProducts.join(', ') : 'část složení produktu nemá určený podíl nebo surovinu'})`
                : undefined,
        });
    }

    return checks;
}
