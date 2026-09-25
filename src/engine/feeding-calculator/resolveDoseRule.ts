/**
 * Výběr pásma z `doseMatrix` — řešení PŘEKRYVŮ v dodané metodice.
 *
 * PROBLÉM: klientova tabulka procent se na některých psech překrývá
 * a systém by musel hádat:
 *
 *   - kastrovaný dospělý s VYSOKOU aktivitou
 *       → `adult-neutered` (1,5–2 %) i `adult-high` (2,5–3,5 %)
 *   - laktující fena s NADVÁHOU
 *       → `over-weight` (1–1,5 %) i `lactating` (4–6 %)
 *
 * ŘEŠENÍ (návrh L-Code, čeká na potvrzení klienta — viz
 * `barf-core.json` → `conflictResolution.openCases`):
 *
 *   1. Vyhraje pravidlo, které psa popisuje NEJKONKRÉTNĚJI, tedy má
 *      nejvíc vyplněných podmínek (`specificity`).
 *   2. Při rovnosti rozhoduje dimenze podle `dimensionPriority` —
 *      fyziologický stav je nad kondicí ZÁMĚRNĚ: laktující fena
 *      s nadváhou se nesmí hladovět, trpěla by ona i štěňata.
 *
 * Výběr je deterministický: stejný pes dá vždy stejné pravidlo, bez
 * ohledu na pořadí pravidel v souboru. Poslední rozhodčí je `id`,
 * aby ani shodná specificity a dimenze nezpůsobila nestabilitu.
 */

import type {
    ActivityLevel,
    BodyCondition,
    LifeStage,
    PhysiologicalState,
} from '../../domain/dog/DogProfile.js';

/** Řádek `doseMatrix` z ruleset JSONu. */
export interface DoseRule {
    id: string;
    lifeStage?: LifeStage;
    activity?: ActivityLevel;
    bodyCondition?: BodyCondition;
    physiologicalState?: PhysiologicalState;
    neutered?: boolean;
    pctMin: number;
    pctMax: number;
    baseWeight: 'ACTUAL' | 'IDEAL';
    portions: number;
    labelCs: string;
    warningCs?: string;
}

export type DimensionName =
    | 'physiologicalState'
    | 'bodyCondition'
    | 'activity'
    | 'neutered'
    | 'lifeStage';

export interface ConflictResolution {
    strategy: string;
    dimensionPriority: DimensionName[];
}

/** Vlastnosti psa, podle kterých se pásmo vybírá. */
export interface DoseMatchInput {
    lifeStage: LifeStage;
    activity: ActivityLevel;
    bodyCondition: BodyCondition;
    physiologicalState: PhysiologicalState;
    neutered: boolean;
}

/** Které dimenze pravidlo skutečně omezuje. */
function specifiedDimensions(rule: DoseRule): DimensionName[] {
    const out: DimensionName[] = [];
    if (rule.physiologicalState !== undefined) out.push('physiologicalState');
    if (rule.bodyCondition !== undefined) out.push('bodyCondition');
    if (rule.activity !== undefined) out.push('activity');
    if (rule.neutered !== undefined) out.push('neutered');
    if (rule.lifeStage !== undefined) out.push('lifeStage');
    return out;
}

/**
 * Sedí pravidlo na psa? Nevyplněná podmínka znamená „na téhle dimenzi
 * nezáleží", ne „musí být prázdné".
 *
 * Výjimka u `physiologicalState`: pravidlo, které ho NEomezuje, sedí
 * i na březí nebo laktující fenu — jinak by pro ni neexistovalo žádné
 * obecné pásmo. Naopak pravidlo pro `NONE` se na fenu v laktaci
 * nevztahuje.
 */
function matches(rule: DoseRule, dog: DoseMatchInput): boolean {
    if (rule.lifeStage !== undefined && rule.lifeStage !== dog.lifeStage) return false;
    if (rule.activity !== undefined && rule.activity !== dog.activity) return false;
    if (rule.bodyCondition !== undefined && rule.bodyCondition !== dog.bodyCondition) return false;
    if (rule.physiologicalState !== undefined && rule.physiologicalState !== dog.physiologicalState) {
        return false;
    }
    if (rule.neutered !== undefined && rule.neutered !== dog.neutered) return false;
    return true;
}

export interface DoseRuleSelection {
    rule: DoseRule;
    /** Pravidla, která na psa taky sedla — pro audit a hlášení překryvu. */
    alsoMatched: DoseRule[];
    /** Byl to překryv, o kterém rozhodovala priorita dimenzí? */
    wasAmbiguous: boolean;
}

/**
 * Vybere pásmo pro psa. Vrací `null`, když na profil nesedí žádné
 * pravidlo — engine to musí ohlásit jako neúplnou metodiku, ne dopočítat
 * (R7: nehádá se).
 *
 * Dřívější reálný případ: senior se střední/vysokou aktivitou — dodaná
 * tabulka měla pro seniora jen „nízká aktivita". 25. 9. 2026 doplněno
 * v barf-core.json podle FEDIAF 2021 (viz `sourceCs` u senior-*).
 */
export function resolveDoseRule(
    rules: DoseRule[],
    dog: DoseMatchInput,
    conflict: ConflictResolution
): DoseRuleSelection | null {
    const matched = rules.filter((r) => matches(r, dog));
    if (matched.length === 0) return null;
    if (matched.length === 1) {
        return { rule: matched[0], alsoMatched: [], wasAmbiguous: false };
    }

    const priorityIndex = (dim: DimensionName): number => {
        const i = conflict.dimensionPriority.indexOf(dim);
        // Dimenze, která v konfiguraci není, jde nakonec.
        return i === -1 ? conflict.dimensionPriority.length : i;
    };

    /** Nejsilnější (nejvýše prioritizovaná) dimenze, kterou pravidlo omezuje. */
    const topDimension = (rule: DoseRule): number => {
        const dims = specifiedDimensions(rule);
        if (dims.length === 0) return conflict.dimensionPriority.length;
        return Math.min(...dims.map(priorityIndex));
    };

    const sorted = [...matched].sort((a, b) => {
        /**
         * 1. Rozhoduje NEJSILNĚJŠÍ dimenze, kterou pravidlo omezuje.
         *
         * Tohle pořadí je oprava chyby z první verze, kde se nejdřív
         * porovnávala specificity (počet omezených dimenzí). Pes
         * s nadváhou pak dostal `adult-medium` (2 dimenze: lifeStage +
         * activity) místo `over-weight` (1 dimenze: bodyCondition),
         * takže 2,25 % místo 1,25 % — a nikdy by nezhubl.
         *
         * Priorita dimenzí je zdravotní rozhodnutí (kondice a
         * fyziologický stav jsou nad aktivitou), počet podmínek je
         * jen technický detail. Proto rozhoduje dřív.
         */
        const dimDiff = topDimension(a) - topDimension(b);
        if (dimDiff !== 0) return dimDiff;

        // 2. Uvnitř téže dimenze vyhrává konkrétnější pravidlo.
        const specDiff = specifiedDimensions(b).length - specifiedDimensions(a).length;
        if (specDiff !== 0) return specDiff;

        // 3. Poslední rozhodčí — stabilní, aby výběr nezávisel na pořadí
        //    v souboru ani na implementaci sortu.
        return a.id.localeCompare(b.id);
    });

    const [winner, ...rest] = sorted;
    return { rule: winner, alsoMatched: rest, wasAmbiguous: true };
}
