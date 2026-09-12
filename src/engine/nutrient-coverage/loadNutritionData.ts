/**
 * Načtení `tenants/*​/rules/ingredients-nutrition.json` do map pro
 * `calculateNutrientCoverage` — stejný princip jako `loadFediafTargets.ts`:
 * transformace zdrojového JSONu žije mimo engine.
 */

import type { NutrientDataIngredient } from './calculateNutrientCoverage.js';
import type { TutaniProduct } from '../../domain/products/TutaniProduct.js';

interface RawNutrientValue {
    value: number | null;
    status: 'MEASURED' | 'NOT_ANALYZED' | 'TRACE' | 'NOT_PRESENT';
    unit: string;
}

interface RawIngredient {
    id: string;
    nutrients: Record<string, RawNutrientValue>;
}

interface RawNutritionFile {
    ingredients: RawIngredient[];
}

export function loadNutritionData(raw: unknown): ReadonlyMap<string, NutrientDataIngredient> {
    const file = raw as RawNutritionFile;
    const map = new Map<string, NutrientDataIngredient>();
    for (const ing of file.ingredients ?? []) {
        map.set(ing.id, { id: ing.id, nutrients: ing.nutrients });
    }
    return map;
}

interface RawProductsFile {
    products: TutaniProduct[];
}

/** `tutani-products.json` → mapa `code → TutaniProduct` pro rychlé dohledání podle SKU. */
export function loadTutaniProducts(raw: unknown): ReadonlyMap<string, TutaniProduct> {
    const file = raw as RawProductsFile;
    const map = new Map<string, TutaniProduct>();
    for (const p of file.products ?? []) {
        map.set(p.code, p);
    }
    return map;
}
