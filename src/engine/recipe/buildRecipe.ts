/**
 * Recept — „co přesně dát do misky" z KONKRÉTNÍCH produktů v nákupu.
 *
 * Zadání Lucky 2026-09-24: kromě dávky a košíku i přesný návod, jak psovi
 * připravit jeho menu, a to jako PDF ke stažení.
 *
 * PRINCIP: recept nepočítá novou dávku. Bere `dose.composition`
 * (gramy/den po složkách) a `match.products` (co je v košíku)
 * a rozdělí gramy složky mezi produkty podle toho, kolik ze složky
 * každý produkt v nákupu pokrývá (`coversGrams`). Recept tak sedí na
 * to, co zákazník skutečně koupí. Když z kuřete koupí 2/3 a z krůty
 * 1/3 svaloviny, v misce je 2/3 kuřete a 1/3 krůty.
 *
 * ZAOKROUHLENÍ: celé gramy metodou největšího zbytku, takže součet
 * produktů = gramy složky a součet porcí = denní gramy produktu. Nikdy
 * se neztratí ani nepřibude gram, který engine nespočítal.
 *
 * Nepokrytá složka (není skladem, alergie) se v receptu PŘIZNÁ jako
 * chybějící. Recept ji nenahradí ničím, co engine nevybral (R7).
 */

import type { BarfGroup } from '../../domain/tenant.js';
import type { CompositionItem } from '../feeding-calculator/calculateDose.js';
import type { MatchResult } from '../product-matching/matchProducts.js';

export interface RecipeIngredient {
    sku: string;
    name: string;
    group: BarfGroup;
    groupLabelCs: string;
    grams: number;
}

export interface RecipePortion {
    /** „ráno", „večer"… */
    labelCs: string;
    ingredients: RecipeIngredient[];
    totalGrams: number;
}

export interface RecipePack {
    sku: string;
    name: string;
    packGrams: number;
    packs: number;
    gramsPerDay: number;
    /**
     * Na kolik dní vystačí JEDNO balení (zaokrouhleno dolů, min. 1).
     * Podle toho se plánuje rozmrazování. `null` = produkt se denně
     * nepoužívá (0 g).
     */
    daysPerPack: number | null;
}

export interface RecipeMissing {
    group: BarfGroup;
    labelCs: string;
    gramsPerDay: number;
}

export interface Recipe {
    daily: RecipeIngredient[];
    dailyTotalGrams: number;
    portions: RecipePortion[];
    packs: RecipePack[];
    missing: RecipeMissing[];
    /** Obecný postup přípravy a hygieny z konfigurace tenanta. */
    stepsCs: readonly string[];
}

export interface RecipeConfig {
    /** Postup přípravy — obecná hygiena BARF, bez čísel, schvaluje klient. */
    stepsCs: readonly string[];
}

/** Názvy porcí podle počtu krmení za den. */
export function portionLabels(count: number): string[] {
    if (count === 1) return ['denně'];
    if (count === 2) return ['ráno', 'večer'];
    if (count === 3) return ['ráno', 'poledne', 'večer'];
    if (count === 4) return ['ráno', 'dopoledne', 'odpoledne', 'večer'];
    return Array.from({ length: count }, (_, i) => `${i + 1}. porce`);
}

/**
 * Rozdělí celé číslo `total` podle vah metodou největšího zbytku.
 * Součet výsledku je VŽDY přesně `total`. Remízy rozhoduje pořadí
 * (deterministické — pořadí vstupu je z enginu).
 */
export function splitInteger(total: number, weights: readonly number[]): number[] {
    if (!Number.isInteger(total) || total < 0) throw new RangeError(`splitInteger: total ${total}`);
    const sum = weights.reduce((a, w) => a + Math.max(0, w), 0);
    if (weights.length === 0) return [];
    if (sum <= 0) {
        // Bez vah rovným dílem — nikdy se gramy nezahodí.
        return splitInteger(total, weights.map(() => 1));
    }
    const exact = weights.map((w) => (Math.max(0, w) / sum) * total);
    const floors = exact.map(Math.floor);
    let rest = total - floors.reduce((a, b) => a + b, 0);
    const order = exact
        .map((x, i) => ({ i, frac: x - Math.floor(x) }))
        .sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (let k = 0; rest > 0; k++, rest--) floors[order[k % order.length].i]++;
    return floors;
}

export function buildRecipe(
    composition: readonly CompositionItem[],
    match: MatchResult,
    portionCount: number,
    config: RecipeConfig
): Recipe {
    if (!Number.isInteger(portionCount) || portionCount < 1) {
        throw new RangeError(`buildRecipe: portionCount ${portionCount}`);
    }

    const daily: RecipeIngredient[] = [];
    const missing: RecipeMissing[] = [];
    const gramsBySku = new Map<string, number>();

    for (const c of composition) {
        const target = Math.round(c.grams);
        if (target <= 0) continue;
        const inGroup = match.products.filter((p) => p.group === c.group && p.coversGrams > 0);
        const uncovered = match.uncovered.find((u) => u.group === c.group);

        if (inGroup.length === 0) {
            missing.push({ group: c.group, labelCs: c.labelCs, gramsPerDay: target });
            continue;
        }

        /**
         * Sklad nestačí na celé období (INSUFFICIENT_STOCK): do misky jde
         * plná denní dávka, dokud nákup vydrží — kratší období se přizná
         * v `missing`, recept si gramy nevymýšlí ani nezmenšuje.
         */
        if (uncovered && uncovered.reason === 'INSUFFICIENT_STOCK') {
            missing.push({ group: c.group, labelCs: c.labelCs, gramsPerDay: target });
        }

        const split = splitInteger(target, inGroup.map((p) => p.coversGrams));
        inGroup.forEach((p, i) => {
            if (split[i] <= 0) return;
            daily.push({ sku: p.sku, name: p.name, group: c.group, groupLabelCs: c.labelCs, grams: split[i] });
            gramsBySku.set(p.sku, (gramsBySku.get(p.sku) ?? 0) + split[i]);
        });
    }

    // Porce: každou surovinu rozdělit na N dílů (součet = denní gramy).
    const labels = portionLabels(portionCount);
    const portions: RecipePortion[] = labels.map((labelCs) => ({ labelCs, ingredients: [], totalGrams: 0 }));
    daily.forEach((ing, idx) => {
        // Posun startu podle pořadí suroviny, ať zbytkové gramy nepadají
        // všechny do ranní porce.
        const weights = labels.map(() => 1);
        const parts = splitInteger(ing.grams, weights);
        const rotated = parts.map((_, k) => parts[(k + idx) % parts.length]);
        rotated.forEach((g, k) => {
            if (g <= 0) return;
            portions[k].ingredients.push({ ...ing, grams: g });
            portions[k].totalGrams += g;
        });
    });

    const packs: RecipePack[] = match.products.map((p) => {
        const perDay = gramsBySku.get(p.sku) ?? 0;
        return {
            sku: p.sku,
            name: p.name,
            packGrams: p.packGrams,
            packs: p.packs,
            gramsPerDay: perDay,
            daysPerPack: perDay > 0 ? Math.max(1, Math.floor(p.packGrams / perDay)) : null,
        };
    });

    return {
        daily,
        dailyTotalGrams: daily.reduce((a, d) => a + d.grams, 0),
        portions,
        packs,
        missing,
        stepsCs: config.stepsCs,
    };
}
