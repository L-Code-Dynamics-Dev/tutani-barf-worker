/**
 * Načtení FEDIAF cílů z `tenants/*​/rules/fediaf-2025.json` do kanonického
 * `NutrientTarget[]` (`domain/nutrition/Ingredient.ts`).
 *
 * PROČ SAMOSTATNÝ LOADER: zdrojový JSON má tvar optimalizovaný pro čtení
 * člověkem (`targets[].adult.min`, `growthUnder14w.min`, `nutritionalMax`
 * jako sourozenec, ne pole objektu), `NutrientTarget` má tvar optimalizovaný
 * pro engine (jeden záznam = jedna živina + jedna životní fáze + min/max).
 * Transformace je tady, ne v enginu — engine nesmí znát tvar zdrojového
 * JSONu (stejný princip jako `buildKnowledgeBase` v `RuleEngine.ts`).
 *
 * Dnes se řeší jen `ADULT` (BARF konfigurátor v provozu je pro dospělé
 * psy) — `GROWTH` fáze se přidá, až bude potřeba pro štěňata (R7: nikde
 * se nedomýšlí hodnota pro fázi, kterou FEDIAF NEUVÁDÍ).
 */

import type { NutrientTarget } from '../../domain/nutrition/Ingredient.js';

interface RawFediafTarget {
    nutrient: string;
    unit: string;
    basis: string;
    adult?: { min: number | null; status?: string };
    nutritionalMax?: number;
    noteCs?: string;
}

interface RawFediafFile {
    sourceVersion: string;
    targets: RawFediafTarget[];
}

/**
 * `status: 'NOT_SPECIFIED'` u `adult` znamená, že FEDIAF pro dospělého
 * psa hodnotu neuvádí (např. EPA+DHA — platí jen pro růst/reprodukci).
 * Takový cíl se NEVRACÍ jako `min: 0` — vůbec se nezahrne, aby volající
 * (`calculateNutrientCoverage`) věděl, že nemá s čím porovnávat, ne že
 * je limit nulový.
 */
export function loadFediafAdultTargets(raw: unknown): NutrientTarget[] {
    const file = raw as RawFediafFile;
    const out: NutrientTarget[] = [];

    for (const t of file.targets ?? []) {
        if (!t.adult || t.adult.min === null || t.adult.status === 'NOT_SPECIFIED') continue;
        out.push({
            nutrient: t.nutrient,
            lifeStage: 'ADULT',
            min: t.adult.min,
            max: t.nutritionalMax ?? null,
            unit: t.unit,
            basis: (t.basis as NutrientTarget['basis']) ?? 'PER_1000_KCAL',
            source: 'FEDIAF',
            sourceVersion: file.sourceVersion,
            confidence: 'TABULKA',
            notesCs: t.noteCs,
        });
    }
    return out;
}
