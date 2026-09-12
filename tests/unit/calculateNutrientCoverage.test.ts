/**
 * Testy `calculateNutrientCoverage` — propojka nutriční vrstvy do
 * skutečného výpočtu (nález auditu 2026-09-12, D-1).
 *
 * Fixture data jsou VLASTNÍ, ne z reálného `tutani-products.json` —
 * test nesmí být křehký vůči budoucím úpravám katalogu a musí pokrýt
 * přesně definované hraniční případy (R7: NOT_ANALYZED ≠ 0, PARTIAL
 * composition se nesčítá jako jistota).
 */

import { describe, expect, it } from 'vitest';
import {
    calculateNutrientCoverage,
    type NutrientDataIngredient,
} from '../../src/engine/nutrient-coverage/calculateNutrientCoverage.js';
import type { NutrientTarget } from '../../src/domain/nutrition/Ingredient.js';
import type { TutaniProduct } from '../../src/domain/products/TutaniProduct.js';

function target(nutrient: string, min: number, max: number | null = null): NutrientTarget {
    return {
        nutrient,
        lifeStage: 'ADULT',
        min,
        max,
        unit: 'mg',
        basis: 'PER_1000_KCAL',
        source: 'FEDIAF',
        sourceVersion: '2025',
        confidence: 'TABULKA',
    };
}

function product(code: string, composition: TutaniProduct['composition']): TutaniProduct {
    return {
        productId: code,
        code,
        nameCs: `Produkt ${code}`,
        brand: null,
        categoryPath: null,
        topCategory: 'OTHER',
        priceWithVatCzk: null,
        packGrams: null,
        availability: 'UNKNOWN',
        url: '',
        kind: 'SINGLE_INGREDIENT',
        composition,
        compositionAccountedPct: 100,
        analytical: [],
        claims: { rawDescriptionCs: null, ageCategory: null, dietaryClaimsCs: [] },
        evidence: { source: 'TUTANI_PRODUCT_PAGE', sourceDate: '2026-09-12', confidence: 'EXACT' },
        updatedAt: '2026-09-12',
    };
}

describe('calculateNutrientCoverage', () => {
    it('kompletní EXACT složení → OK s reálnou hodnotou (losos, EPA)', () => {
        const losos: NutrientDataIngredient = {
            id: 'losos-farmovany',
            nutrients: { epa: { value: 860, unit: 'mg', status: 'MEASURED' } },
        };
        const p = product('TUT211', [
            {
                ingredientId: 'losos-farmovany',
                nameCs: 'losos',
                species: 'FISH',
                part: 'FISH_FILLET',
                role: 'INGREDIENT',
                subcomponentsCs: [],
                subcomponentRatio: null,
                percentage: 100,
                certainty: 'EXACT',
                sourceCs: 'test',
            },
        ]);

        const result = calculateNutrientCoverage(
            [{ sku: 'TUT211', gramsPerDay: 500 }],
            {
                products: new Map([['TUT211', p]]),
                ingredients: new Map([['losos-farmovany', losos]]),
                targets: [target('epa', 100)],
                dietKcalPerDay: 1000,
            }
        );

        // 500 g × 860 mg/100g = 4300 mg. Cíl 100 mg/1000kcal × (1000/1000) = 100 mg.
        expect(result).toHaveLength(1);
        expect(result[0].status).toBe('OK');
        expect(result[0].value).toBe(4300);
        expect(result[0].targetMin).toBe(100);
    });

    it('NOT_ANALYZED živina se NIKDY nepočítá jako nula → NEZNAME, ne NEDOSTATEK', () => {
        const losos: NutrientDataIngredient = {
            id: 'losos-farmovany',
            nutrients: { iodine: { value: null, unit: 'mg', status: 'NOT_ANALYZED' } },
        };
        const p = product('TUT211', [
            {
                ingredientId: 'losos-farmovany',
                nameCs: 'losos',
                species: 'FISH',
                part: 'FISH_FILLET',
                role: 'INGREDIENT',
                subcomponentsCs: [],
                subcomponentRatio: null,
                percentage: 100,
                certainty: 'EXACT',
                sourceCs: 'test',
            },
        ]);

        const result = calculateNutrientCoverage(
            [{ sku: 'TUT211', gramsPerDay: 500 }],
            {
                products: new Map([['TUT211', p]]),
                ingredients: new Map([['losos-farmovany', losos]]),
                targets: [target('iodine', 0.3)],
                dietKcalPerDay: 1000,
            }
        );

        expect(result[0].status).toBe('NEZNAME');
        expect(result[0].value).toBeUndefined();
        expect(result[0].reasonCs).toBeDefined();
    });

    it('PARTIAL složení (bez procenta) se nesčítá jako jistota → NEZNAME', () => {
        const hovezi: NutrientDataIngredient = {
            id: 'hovezi-mlete-93-7',
            nutrients: { calcium: { value: 10, unit: 'mg', status: 'MEASURED' } },
        };
        const p = product('TUT999', [
            {
                ingredientId: 'hovezi-mlete-93-7',
                nameCs: 'chrupavka (bez podílu)',
                species: 'BEEF',
                part: 'CARTILAGE',
                role: 'INGREDIENT',
                subcomponentsCs: [],
                subcomponentRatio: null,
                percentage: null, // PARTIAL — Tutani podíl neuvedl
                certainty: 'PARTIAL',
                sourceCs: 'test',
            },
        ]);

        const result = calculateNutrientCoverage(
            [{ sku: 'TUT999', gramsPerDay: 500 }],
            {
                products: new Map([['TUT999', p]]),
                ingredients: new Map([['hovezi-mlete-93-7', hovezi]]),
                targets: [target('calcium', 1.45)],
                dietKcalPerDay: 1000,
            }
        );

        expect(result[0].status).toBe('NEZNAME');
    });

    it('chybějící energie dávky → NEZNAME pro všechny cíle, žádný dopočet (R7)', () => {
        const result = calculateNutrientCoverage([{ sku: 'X', gramsPerDay: 100 }], {
            products: new Map(),
            ingredients: new Map(),
            targets: [target('calcium', 1.45)],
            dietKcalPerDay: null,
        });

        expect(result[0].status).toBe('NEZNAME');
        expect(result[0].reasonCs).toMatch(/energie/);
    });

    it('produkt mimo katalog (sku bez TutaniProduct) → NEZNAME, ne tichá nula', () => {
        const result = calculateNutrientCoverage([{ sku: 'NEZNAMY-SKU', gramsPerDay: 500 }], {
            products: new Map(),
            ingredients: new Map(),
            targets: [target('calcium', 1.45)],
            dietKcalPerDay: 1000,
        });

        expect(result[0].status).toBe('NEZNAME');
    });

    it('cíl FEDIAF s NOT_SPECIFIED (loader ho vůbec nevytvoří) — coverage prostě tenhle klíč nevidí', () => {
        // loadFediafAdultTargets už takové cíle vyfiltruje před předáním sem;
        // calculateNutrientCoverage se testuje jen na to, co dostane.
        const result = calculateNutrientCoverage([{ sku: 'X', gramsPerDay: 100 }], {
            products: new Map(),
            ingredients: new Map(),
            targets: [],
            dietKcalPerDay: 1000,
        });
        expect(result).toHaveLength(0);
    });

    it('nadbytek: hodnota nad nutritionalMax → NADBYTEK', () => {
        const jatra: NutrientDataIngredient = {
            id: 'hovezi-jatra',
            nutrients: { copper: { value: 9.755, unit: 'mg', status: 'MEASURED' } },
        };
        const p = product('TUT7', [
            {
                ingredientId: 'hovezi-jatra',
                nameCs: 'játra',
                species: 'BEEF',
                part: 'SECRETORY_LIVER',
                role: 'INGREDIENT',
                subcomponentsCs: [],
                subcomponentRatio: null,
                percentage: 100,
                certainty: 'EXACT',
                sourceCs: 'test',
            },
        ]);

        const result = calculateNutrientCoverage(
            [{ sku: 'TUT7', gramsPerDay: 500 }],
            {
                products: new Map([['TUT7', p]]),
                ingredients: new Map([['hovezi-jatra', jatra]]),
                targets: [target('copper', 2, 5)],
                dietKcalPerDay: 1000,
            }
        );

        // 500g × 9.755mg/100g = 48.775mg, cíl max 5mg → NADBYTEK.
        expect(result[0].status).toBe('NADBYTEK');
    });
});
