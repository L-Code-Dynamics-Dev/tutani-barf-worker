/**
 * BARF CALCULATOR — deterministický výpočet krmné dávky.
 *
 * Čistá funkce: žádné I/O, žádná databáze, ŽÁDNÝ PRODUKT (R6). Vstupem
 * je profil psa, metodika jako data a omezení z rule enginu. Výstupem
 * potřeba v gramech po složkách + auditní stopa.
 *
 * ŽÁDNÉ LLM (R1). Vysvětlení „proč vyšlo 540 g" se skládá z `audit`,
 * ne z modelu — každý krok si zapíše, které pravidlo ho ovlivnilo,
 * z jakého zdroje a v jaké verzi.
 *
 * Aritmetika v `Decimal`: gramy se přepočítávají na koruny a float by
 * na sebe nabaloval chybu (stejný důvod jako v okfish pricing enginu).
 */

import Decimal from 'decimal.js';
import type { BarfGroup } from '../../domain/tenant.js';
import type { DogProfile } from '../../domain/dog/DogProfile.js';
import { resolveLifeStage } from '../../domain/dog/DogProfile.js';
import type { ResolvedConstraints } from '../../domain/health/Condition.js';
import { resolveDoseRule, type ConflictResolution, type DoseRule } from './resolveDoseRule.js';

/** Poměr složky z ruleset JSONu. */
export interface CompositionGroupProfile {
    group: BarfGroup;
    pctMin: number;
    pctMax: number;
    pctDefault: number;
    labelCs: string;
}

export interface BarfMethodology {
    doseMatrix: DoseRule[];
    conflictResolution: ConflictResolution;
    compositionProfile: { groups: CompositionGroupProfile[] };
    sourceVersion: string;
}

/** Jeden krok výpočtu — základ vysvětlení bez LLM. */
export interface AuditEntry {
    step: string;
    ruleId: string;
    resultCs: string;
}

export interface CompositionItem {
    group: BarfGroup;
    labelCs: string;
    grams: number;
    pct: number;
    /** Podíl byl upraven zdravotním pravidlem. */
    adjusted: boolean;
    /** Id pravidla, které úpravu způsobilo. */
    adjustedBy?: string;
}

export type DoseStatus = 'OK' | 'BLOCKED' | 'INCOMPLETE';

export interface DoseResult {
    status: DoseStatus;
    /** Proč INCOMPLETE/BLOCKED — kód pro UI, ne text k parsování. */
    reason?: 'NO_MATCHING_DOSE_RULE' | 'MISSING_IDEAL_WEIGHT' | 'CONDITION_BLOCKS_RESULT';
    /** Pásmo, které vyhrálo. */
    ruleId?: string;
    ruleLabelCs?: string;
    pctMin?: number;
    pctMax?: number;
    pctUsed?: number;
    baseWeightKg?: number;
    baseWeightSource?: 'ACTUAL' | 'IDEAL';
    totalGramsPerDay?: number;
    portions?: { count: number; gramsPerPortion: number };
    composition: CompositionItem[];
    audit: AuditEntry[];
    /** Metodika psa popsala nejednoznačně — překryv pásem. */
    ambiguous?: { chosen: string; alsoMatched: string[] };
}

/**
 * Spočítá denní dávku a její rozpad.
 *
 * Pořadí kroků je závazné: nejdřív blokace (bezpečnost), pak základní
 * hmotnost, procento, celkové gramy, rozpad na složky, porce. Každý
 * krok zapisuje do auditu.
 */
export function calculateDose(
    dog: DogProfile,
    methodology: BarfMethodology,
    constraints: ResolvedConstraints
): DoseResult {
    const audit: AuditEntry[] = [];

    // ---- 0. BEZPEČNOSTNÍ BLOKACE ----
    // Závažná diagnóza dávku zastaví. Je lepší neporadit nic než poradit
    // špatně; rozhodnutí je datové (`blocksResult`), ne v kódu.
    if (constraints.blocked) {
        return {
            status: 'BLOCKED',
            reason: 'CONDITION_BLOCKS_RESULT',
            composition: [],
            audit: [
                {
                    step: 'SAFETY_BLOCK',
                    ruleId: constraints.blockedBy.join(','),
                    resultCs:
                        'Dávka nebyla vydána — zdravotní stav psa vyžaduje individuální ' +
                        'plán od veterinárního nutričního specialisty.',
                },
            ],
        };
    }

    // ---- 1. PÁSMO ----
    const lifeStage = resolveLifeStage(dog.ageMonths);
    audit.push({
        step: 'LIFE_STAGE',
        ruleId: 'resolveLifeStage',
        resultCs: `${dog.ageMonths} měsíců → ${lifeStage}`,
    });

    const selection = resolveDoseRule(
        methodology.doseMatrix,
        {
            lifeStage,
            activity: dog.activity,
            bodyCondition: dog.bodyCondition,
            physiologicalState: dog.physiologicalState,
            neutered: dog.neutered,
        },
        methodology.conflictResolution
    );

    if (!selection) {
        // Reálný případ: senior s vysokou aktivitou. V dodané metodice
        // pro něj pásmo není — nedopočítává se (R7).
        return {
            status: 'INCOMPLETE',
            reason: 'NO_MATCHING_DOSE_RULE',
            composition: [],
            audit: [
                ...audit,
                {
                    step: 'DOSE_RULE',
                    ruleId: '-',
                    resultCs:
                        'Pro tuto kombinaci věku, aktivity a stavu není v metodice ' +
                        'definované pásmo. Doporučujeme konzultaci s veterinářem.',
                },
            ],
        };
    }

    const rule = selection.rule;
    audit.push({
        step: 'DOSE_RULE',
        ruleId: rule.id,
        resultCs: `${rule.labelCs} → ${rule.pctMin}–${rule.pctMax} %`,
    });

    if (selection.wasAmbiguous) {
        audit.push({
            step: 'DOSE_RULE_CONFLICT',
            ruleId: rule.id,
            resultCs:
                `Psa popisuje víc pásem (${selection.alsoMatched.map((r) => r.id).join(', ')}); ` +
                `použito nejkonkrétnější: ${rule.id}`,
        });
    }

    // ---- 2. PROCENTO ----
    // Zdravotní pravidlo (např. redukční dieta u CKD) může pásmo přepsat.
    let pctMin = new Decimal(rule.pctMin);
    let pctMax = new Decimal(rule.pctMax);

    if (constraints.dosePctOverride) {
        pctMin = new Decimal(constraints.dosePctOverride.min);
        pctMax = new Decimal(constraints.dosePctOverride.max);
        audit.push({
            step: 'DOSE_PCT_OVERRIDE',
            ruleId: constraints.dosePctOverride.ruleId,
            resultCs: `procento přepsáno zdravotním pravidlem na ${pctMin}–${pctMax} %`,
        });
    }

    // Střední hodnota rozmezí — konzervativní volba, kterou majitel
    // vidí i s rozmezím, takže si ji může sám doladit podle kondice.
    const pctUsed = pctMin.plus(pctMax).div(2);

    // ---- 3. ZÁKLADNÍ HMOTNOST ----
    const useIdeal = rule.baseWeight === 'IDEAL' || constraints.useIdealWeight;
    const baseWeightKg = useIdeal ? dog.idealWeightKg : dog.weightKg;

    if (useIdeal && (baseWeightKg === undefined || baseWeightKg === null)) {
        // Nadváha bez ideální hmotnosti — chybí vstup, NEHÁDÁ se.
        return {
            status: 'INCOMPLETE',
            reason: 'MISSING_IDEAL_WEIGHT',
            composition: [],
            audit: [
                ...audit,
                {
                    step: 'BASE_WEIGHT',
                    ruleId: rule.id,
                    resultCs:
                        'Pro redukční dietu je potřeba ideální hmotnost psa — ' +
                        'z aktuální by se dávka spočítala příliš vysoká.',
                },
            ],
        };
    }

    const baseWeight = new Decimal(baseWeightKg!);
    audit.push({
        step: 'BASE_WEIGHT',
        ruleId: rule.id,
        resultCs: useIdeal
            ? `počítáno z IDEÁLNÍ hmotnosti ${baseWeight} kg (ne z aktuální ${dog.weightKg} kg)`
            : `počítáno z aktuální hmotnosti ${baseWeight} kg`,
    });

    // ---- 4. CELKOVÁ DENNÍ DÁVKA ----
    const totalGrams = baseWeight.mul(1000).mul(pctUsed).div(100);
    const totalGramsRounded = Math.round(totalGrams.toNumber());
    audit.push({
        step: 'TOTAL_DOSE',
        ruleId: rule.id,
        resultCs: `${baseWeight} kg × ${pctUsed.toFixed(2)} % = ${totalGramsRounded} g/den`,
    });

    // ---- 5. ROZPAD NA SLOŽKY ----
    const composition = splitComposition(
        totalGramsRounded,
        methodology.compositionProfile.groups,
        constraints,
        audit
    );

    // ---- 6. PORCE ----
    const portionCount = constraints.portionsOverride?.count ?? rule.portions;
    if (constraints.portionsOverride) {
        audit.push({
            step: 'PORTIONS',
            ruleId: constraints.portionsOverride.ruleId,
            resultCs: `počet porcí přepsán zdravotním pravidlem na ${portionCount}`,
        });
    }

    return {
        status: 'OK',
        ruleId: rule.id,
        ruleLabelCs: rule.labelCs,
        pctMin: pctMin.toNumber(),
        pctMax: pctMax.toNumber(),
        pctUsed: pctUsed.toNumber(),
        baseWeightKg: baseWeight.toNumber(),
        baseWeightSource: useIdeal ? 'IDEAL' : 'ACTUAL',
        totalGramsPerDay: totalGramsRounded,
        portions: {
            count: portionCount,
            gramsPerPortion: Math.round(totalGramsRounded / portionCount),
        },
        composition,
        audit,
        ambiguous: selection.wasAmbiguous
            ? { chosen: rule.id, alsoMatched: selection.alsoMatched.map((r) => r.id) }
            : undefined,
    };
}

/**
 * Rozpad dávky na složky s RENORMALIZACÍ.
 *
 * Zdravotní pravidlo může složku omezit (CKD → kosti max 8 % kvůli
 * fosforu). Ušetřená procenta se musí PŘERPZDĚLIT, jinak by součet
 * nedal 100 % a pes by dostal méně, než má.
 *
 * Přerozděluje se poměrně mezi složky, které mají prostor do svého
 * `pctMax` — nejde tedy naložit celý zbytek na svalové maso, když
 * metodika říká max 80 %.
 */
function splitComposition(
    totalGrams: number,
    groups: CompositionGroupProfile[],
    constraints: ResolvedConstraints,
    audit: AuditEntry[]
): CompositionItem[] {
    const limitFor = (g: BarfGroup) => constraints.compositionLimits.find((l) => l.group === g);

    // 1. Výchozí procenta, upravená o zdravotní limity.
    const working = groups.map((g) => {
        const limit = limitFor(g.group);
        let pct = new Decimal(g.pctDefault);
        let adjusted = false;
        let adjustedBy: string | undefined;

        if (limit?.maxPct !== undefined && pct.greaterThan(limit.maxPct)) {
            audit.push({
                step: 'COMPOSITION_LIMIT',
                ruleId: limit.ruleId,
                resultCs: `${g.labelCs}: ${g.pctDefault} % → ${limit.maxPct} %`,
            });
            pct = new Decimal(limit.maxPct);
            adjusted = true;
            adjustedBy = limit.ruleId;
        }
        if (limit?.minPct !== undefined && pct.lessThan(limit.minPct)) {
            audit.push({
                step: 'COMPOSITION_LIMIT',
                ruleId: limit.ruleId,
                resultCs: `${g.labelCs}: ${g.pctDefault} % → ${limit.minPct} % (minimum)`,
            });
            pct = new Decimal(limit.minPct);
            adjusted = true;
            adjustedBy = limit.ruleId;
        }
        return { profile: g, pct, adjusted, adjustedBy, limit };
    });

    // 2. Renormalizace — zbytek do 100 % rozdělit tam, kde je prostor.
    const sum = working.reduce((acc, w) => acc.plus(w.pct), new Decimal(0));
    let remainder = new Decimal(100).minus(sum);

    if (!remainder.isZero()) {
        // Kapacita = kolik ještě složka unese do svého `pctMax`
        // (a nad limit ze zdravotního pravidla se nikdy nejde).
        const capacity = working.map((w) => {
            const hardMax = w.limit?.maxPct !== undefined
                ? Math.min(w.profile.pctMax, w.limit.maxPct)
                : w.profile.pctMax;
            return remainder.greaterThan(0)
                ? Decimal.max(new Decimal(hardMax).minus(w.pct), 0)
                : Decimal.max(w.pct.minus(w.profile.pctMin), 0);
        });
        const totalCapacity = capacity.reduce((a, c) => a.plus(c), new Decimal(0));

        if (totalCapacity.greaterThan(0)) {
            for (let i = 0; i < working.length; i++) {
                if (capacity[i].isZero()) continue;
                const share = remainder.mul(capacity[i]).div(totalCapacity);
                working[i].pct = working[i].pct.plus(share);
            }
            audit.push({
                step: 'RENORMALIZE',
                ruleId: 'compositionProfile',
                resultCs:
                    `po zdravotních úpravách chybělo ${remainder.toFixed(1)} % — ` +
                    'rozděleno mezi složky, které mají v metodice prostor',
            });
            remainder = new Decimal(0);
        }
    }

    // 3. Gramy. Zaokrouhlení se dorovná na největší složce, aby součet
    //    přesně odpovídal celkové dávce — jinak by se drobné rozdíly
    //    projevily v nákupu.
    const items: CompositionItem[] = working.map((w) => ({
        group: w.profile.group,
        labelCs: w.profile.labelCs,
        grams: Math.round((totalGrams * w.pct.toNumber()) / 100),
        pct: Math.round(w.pct.toNumber() * 10) / 10,
        adjusted: w.adjusted,
        adjustedBy: w.adjustedBy,
    }));

    const gramSum = items.reduce((a, i) => a + i.grams, 0);
    const diff = totalGrams - gramSum;
    if (diff !== 0 && items.length > 0) {
        const biggest = items.reduce((a, b) => (b.grams > a.grams ? b : a));
        biggest.grams += diff;
    }

    return items;
}
