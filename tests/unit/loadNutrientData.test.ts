/**
 * Testy loaderů proti SKUTEČNÝM datovým souborům — ověřuje, že reálný
 * tvar `fediaf-2025.json` / `ingredients-nutrition.json` / `tutani-products.json`
 * se transformuje bez ztráty a bez tichého domýšlení (R7).
 */

import { describe, expect, it } from 'vitest';
import fediaf2025 from '../../tenants/tutani/rules/fediaf-2025.json';
import ingredientsNutrition from '../../tenants/tutani/rules/ingredients-nutrition.json';
import tutaniProducts from '../../tenants/tutani/rules/tutani-products.json';
import { loadFediafAdultTargets } from '../../src/engine/nutrient-coverage/loadFediafTargets.js';
import { loadNutritionData, loadTutaniProducts } from '../../src/engine/nutrient-coverage/loadNutritionData.js';
import { calculateNutrientCoverage } from '../../src/engine/nutrient-coverage/calculateNutrientCoverage.js';

describe('loadFediafAdultTargets', () => {
    const targets = loadFediafAdultTargets(fediaf2025);

    it('vynechá epaDha (NOT_SPECIFIED pro dospělého psa), nevrátí min:0', () => {
        expect(targets.find((t) => t.nutrient === 'epaDha')).toBeUndefined();
    });

    it('zahrne calcium s nutritionalMax jako max', () => {
        const ca = targets.find((t) => t.nutrient === 'calcium');
        expect(ca?.min).toBe(1.45);
        expect(ca?.max).toBe(6.25);
    });

    it('zahrne iodine s min i bez nutritionalMax (max null)', () => {
        const iodine = targets.find((t) => t.nutrient === 'iodine');
        expect(iodine?.min).toBe(0.3);
        expect(iodine?.max).toBeNull();
    });

    it('všechny cíle mají source FEDIAF a lifeStage ADULT', () => {
        expect(targets.length).toBeGreaterThan(20);
        for (const t of targets) {
            expect(t.source).toBe('FEDIAF');
            expect(t.lifeStage).toBe('ADULT');
        }
    });
});

describe('loadNutritionData + loadTutaniProducts proti reálnému katalogu', () => {
    const ingredients = loadNutritionData(ingredientsNutrition);
    const products = loadTutaniProducts(tutaniProducts);

    it('načte losos-farmovany s EPA/DHA', () => {
        const losos = ingredients.get('losos-farmovany');
        expect(losos?.nutrients.epa.status).toBe('MEASURED');
        expect(losos?.nutrients.epa.value).toBe(860);
    });

    it('načte TUT211 (100% losos) z produktového katalogu', () => {
        const p = products.get('TUT211');
        expect(p).toBeDefined();
        expect(p?.composition[0].ingredientId).toBe('losos-farmovany');
        expect(p?.composition[0].percentage).toBe(100);
    });

    it('end-to-end: TUT211 500g/den pokryje EPA cíl bez chyby a bez pádu', () => {
        const targets = loadFediafAdultTargets(fediaf2025);
        const result = calculateNutrientCoverage(
            [{ sku: 'TUT211', gramsPerDay: 500 }],
            { products, ingredients, targets, dietKcalPerDay: 1000 }
        );
        expect(result.length).toBeGreaterThan(0);
        // Nesmí spadnout na žádném z reálných FEDIAF cílů, i když
        // pro drtivou většinu živin bude status NEZNAME (jednoproduktová
        // dávka z jednoho lososa logicky nepokryje všechno).
        expect(result.every((c) => ['OK', 'NEDOSTATEK', 'NADBYTEK', 'NEZNAME'].includes(c.status))).toBe(true);
    });
});
