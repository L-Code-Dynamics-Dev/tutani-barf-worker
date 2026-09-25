/**
 * Testy výpočetního jádra.
 *
 * Zaměřeno na to, co se v praxi pokazí: překryvy pásem, redukční dieta
 * z ideální hmotnosti, renormalizace po zdravotním limitu, blokace
 * u závažné diagnózy a chybějící vstupy (nikdy se nehádá).
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { calculateDose, type BarfMethodology } from '../../src/engine/feeding-calculator/calculateDose.js';
import { resolveDoseRule } from '../../src/engine/feeding-calculator/resolveDoseRule.js';
import type { DogProfile } from '../../src/domain/dog/DogProfile.js';
import type { ResolvedConstraints } from '../../src/domain/health/Condition.js';

const raw = JSON.parse(
    readFileSync(new URL('../../tenants/tutani/rules/barf-core.json', import.meta.url), 'utf-8')
);

const METHODOLOGY: BarfMethodology = {
    doseMatrix: raw.doseMatrix,
    conflictResolution: raw.conflictResolution,
    compositionProfile: raw.compositionProfile,
    sourceVersion: raw.sourceVersion,
};

function noConstraints(): ResolvedConstraints {
    return {
        useIdealWeight: false,
        compositionLimits: [],
        excludedIngredientIds: new Set(),
        preferredIngredientIds: new Set(),
        productAttrFilters: [],
        warnings: [],
        blocked: false,
        blockedBy: [],
        requiresVet: false,
    };
}

function dog(over: Partial<DogProfile> = {}): DogProfile {
    return {
        name: 'Rex',
        weightKg: 24,
        ageMonths: 36,
        sex: 'MALE',
        neutered: false,
        activity: 'MEDIUM',
        bodyCondition: 'IDEAL',
        physiologicalState: 'NONE',
        conditionIds: [],
        allergyIngredientIds: [],
        ...over,
    };
}

describe('metodika jako data', () => {
    it('výchozí poměry složek dávají 100 %', () => {
        const sum = raw.compositionProfile.groups.reduce(
            (a: number, g: { pctDefault: number }) => a + g.pctDefault,
            0
        );
        expect(sum).toBe(100);
    });

    it('všechna pásma mají platné rozmezí a porce', () => {
        for (const r of raw.doseMatrix) {
            expect(r.pctMin).toBeGreaterThan(0);
            expect(r.pctMax).toBeGreaterThanOrEqual(r.pctMin);
            expect(r.portions).toBeGreaterThan(0);
            expect(['ACTUAL', 'IDEAL']).toContain(r.baseWeight);
        }
    });
});

describe('základní výpočet', () => {
    it('dospělý pes 24 kg, střední aktivita → 540 g/den', () => {
        const r = calculateDose(dog(), METHODOLOGY, noConstraints());
        expect(r.status).toBe('OK');
        expect(r.ruleId).toBe('adult-medium');
        // 2,0–2,5 % → střed 2,25 % z 24 kg = 540 g
        expect(r.pctUsed).toBeCloseTo(2.25, 5);
        expect(r.totalGramsPerDay).toBe(540);
    });

    it('rozpad složek sedí na celkovou dávku do gramu', () => {
        const r = calculateDose(dog(), METHODOLOGY, noConstraints());
        const sum = r.composition.reduce((a, c) => a + c.grams, 0);
        expect(sum).toBe(r.totalGramsPerDay);
    });

    it('výchozí rozpad odpovídá metodice (75/10/5/5/5)', () => {
        const r = calculateDose(dog(), METHODOLOGY, noConstraints());
        const g = (name: string) => r.composition.find((c) => c.group === name)!.grams;
        expect(g('MUSCLE')).toBe(405); // 75 % z 540
        expect(g('BONE')).toBe(54);
        expect(g('LIVER')).toBe(27);
        expect(g('ORGAN')).toBe(27);
        expect(g('PLANT')).toBe(27);
    });

    it('štěně do 6 měsíců dostane 8–10 % a 4 porce', () => {
        const r = calculateDose(dog({ ageMonths: 4, weightKg: 8 }), METHODOLOGY, noConstraints());
        expect(r.ruleId).toBe('puppy-0-6');
        expect(r.portions!.count).toBe(4);
        expect(r.totalGramsPerDay).toBe(720); // 9 % z 8 kg
    });

    it('audit obsahuje kroky, ze kterých jde vysvětlit výsledek (bez LLM)', () => {
        const r = calculateDose(dog(), METHODOLOGY, noConstraints());
        const steps = r.audit.map((a) => a.step);
        expect(steps).toContain('LIFE_STAGE');
        expect(steps).toContain('DOSE_RULE');
        expect(steps).toContain('BASE_WEIGHT');
        expect(steps).toContain('TOTAL_DOSE');
        // Každý krok musí mít pravidlo, jinak není co ukázat.
        for (const a of r.audit) expect(a.ruleId).toBeTruthy();
    });
});

describe('překryvy pásem (kolize v dodané metodice)', () => {
    it('kastrovaný dospělý s vysokou aktivitou: vyhrává aktivita, ne kastrace', () => {
        const sel = resolveDoseRule(
            METHODOLOGY.doseMatrix,
            {
                lifeStage: 'ADULT',
                activity: 'HIGH',
                bodyCondition: 'IDEAL',
                physiologicalState: 'NONE',
                neutered: true,
            },
            METHODOLOGY.conflictResolution
        )!;
        expect(sel.wasAmbiguous).toBe(true);
        // `activity` je v dimensionPriority nad `neutered`.
        expect(sel.rule.id).toBe('adult-high');
        expect(sel.alsoMatched.map((r) => r.id)).toContain('adult-neutered');
    });

    it('laktující fena s nadváhou se NESMÍ hladovět — vyhrává laktace', () => {
        const r = calculateDose(
            dog({ sex: 'FEMALE', bodyCondition: 'OVER', physiologicalState: 'LACTATING', idealWeightKg: 20 }),
            METHODOLOGY,
            noConstraints()
        );
        expect(r.status).toBe('OK');
        expect(r.ruleId).toBe('lactating');
        // 4–6 % → střed 5 %, z AKTUÁLNÍ hmotnosti (laktace, ne redukce)
        expect(r.pctUsed).toBeCloseTo(5, 5);
        expect(r.baseWeightSource).toBe('ACTUAL');
    });

    it('výběr pásma je stabilní bez ohledu na pořadí pravidel v souboru', () => {
        const input = {
            lifeStage: 'ADULT' as const,
            activity: 'HIGH' as const,
            bodyCondition: 'IDEAL' as const,
            physiologicalState: 'NONE' as const,
            neutered: true,
        };
        const a = resolveDoseRule(METHODOLOGY.doseMatrix, input, METHODOLOGY.conflictResolution)!;
        const b = resolveDoseRule(
            [...METHODOLOGY.doseMatrix].reverse(),
            input,
            METHODOLOGY.conflictResolution
        )!;
        expect(a.rule.id).toBe(b.rule.id);
    });

    it('překryv se hlásí v auditu, aby byl dohledatelný', () => {
        const r = calculateDose(dog({ neutered: true, activity: 'HIGH' }), METHODOLOGY, noConstraints());
        expect(r.ambiguous).toBeTruthy();
        expect(r.audit.map((a) => a.step)).toContain('DOSE_RULE_CONFLICT');
    });
});

describe('redukční dieta', () => {
    it('kondice přebije aktivitu — jinak by pes s nadváhou nezhubl', () => {
        // Regrese: dřív vyhrálo `adult-medium` (2 dimenze) nad
        // `over-weight-adult` (1 dimenze) a pes dostal 2,25 % místo 1,25 %.
        const r = calculateDose(
            dog({ weightKg: 30, idealWeightKg: 24, bodyCondition: 'OVER', activity: 'MEDIUM' }),
            METHODOLOGY,
            noConstraints()
        );
        expect(r.ruleId).toBe('over-weight-adult');
        expect(r.pctUsed).toBeCloseTo(1.25, 5);
    });

    it('ROSTOUCÍ ŠTĚNĚ s nadváhou se nehladoví', () => {
        const r = calculateDose(
            dog({ ageMonths: 9, weightKg: 20, idealWeightKg: 17, bodyCondition: 'OVER' }),
            METHODOLOGY,
            noConstraints()
        );
        expect(r.ruleId).toBe('puppy-over-weight');
        // 6–7 %, ne 1–1,5 % jako u dospělého
        expect(r.pctUsed).toBeCloseTo(6.5, 5);
        expect(r.baseWeightSource).toBe('ACTUAL');
    });

    it('nadváha se počítá z IDEÁLNÍ hmotnosti', () => {
        const r = calculateDose(
            dog({ weightKg: 30, idealWeightKg: 24, bodyCondition: 'OVER' }),
            METHODOLOGY,
            noConstraints()
        );
        expect(r.status).toBe('OK');
        expect(r.baseWeightSource).toBe('IDEAL');
        expect(r.baseWeightKg).toBe(24);
        // 1,0–1,5 % → střed 1,25 % z 24 kg = 300 g
        expect(r.totalGramsPerDay).toBe(300);
    });

    it('nadváha bez ideální hmotnosti NEHÁDÁ, vrátí INCOMPLETE', () => {
        const r = calculateDose(
            dog({ weightKg: 30, bodyCondition: 'OVER' }),
            METHODOLOGY,
            noConstraints()
        );
        expect(r.status).toBe('INCOMPLETE');
        expect(r.reason).toBe('MISSING_IDEAL_WEIGHT');
        expect(r.totalGramsPerDay).toBeUndefined();
    });
});

describe('zdravotní omezení', () => {
    it('limit na kosti sníží podíl a zbytek se renormalizuje na 100 %', () => {
        const c = noConstraints();
        c.compositionLimits = [{ group: 'BONE', maxPct: 8, ruleId: 'ckd:bone-limit' }];

        const r = calculateDose(dog(), METHODOLOGY, c);
        expect(r.status).toBe('OK');

        const bone = r.composition.find((x) => x.group === 'BONE')!;
        expect(bone.pct).toBeLessThanOrEqual(8);
        expect(bone.adjusted).toBe(true);
        expect(bone.adjustedBy).toBe('ckd:bone-limit');

        // Gramy pořád dávají celou dávku — pes nesmí dostat méně.
        const sum = r.composition.reduce((a, x) => a + x.grams, 0);
        expect(sum).toBe(r.totalGramsPerDay);

        expect(r.audit.map((a) => a.step)).toContain('RENORMALIZE');
    });

    it('renormalizace nepřekročí maximum složky z metodiky', () => {
        const c = noConstraints();
        c.compositionLimits = [{ group: 'BONE', maxPct: 2, ruleId: 'test:bone-2' }];

        const r = calculateDose(dog(), METHODOLOGY, c);
        const muscle = r.composition.find((x) => x.group === 'MUSCLE')!;
        // metodika říká svalovina max 80 %
        expect(muscle.pct).toBeLessThanOrEqual(80.05);
    });

    it('přepis procenta zdravotním pravidlem se použije a zaloguje', () => {
        const c = noConstraints();
        c.dosePctOverride = { min: 1.5, max: 2.0, ruleId: 'ckd:reduce' };

        const r = calculateDose(dog(), METHODOLOGY, c);
        expect(r.pctUsed).toBeCloseTo(1.75, 5);
        expect(r.totalGramsPerDay).toBe(420); // 1,75 % z 24 kg
        expect(r.audit.map((a) => a.step)).toContain('DOSE_PCT_OVERRIDE');
    });

    it('závažná diagnóza dávku BLOKUJE, nevydá číslo', () => {
        const c = noConstraints();
        c.blocked = true;
        c.blockedBy = ['ckd-stage-3'];

        const r = calculateDose(dog(), METHODOLOGY, c);
        expect(r.status).toBe('BLOCKED');
        expect(r.reason).toBe('CONDITION_BLOCKS_RESULT');
        expect(r.totalGramsPerDay).toBeUndefined();
        expect(r.composition).toHaveLength(0);
    });
});

describe('chybějící metodika se nedopočítává', () => {
    it('pes bez pásma v tabulce → INCOMPLETE (nehádá se)', () => {
        // Metodika bez seniorských pásem = stav před 25. 9. 2026.
        const bezSeniora: BarfMethodology = {
            ...METHODOLOGY,
            doseMatrix: METHODOLOGY.doseMatrix.filter((r) => r.lifeStage !== 'SENIOR'),
        };
        const r = calculateDose(dog({ ageMonths: 120, activity: 'HIGH' }), bezSeniora, noConstraints());
        expect(r.status).toBe('INCOMPLETE');
        expect(r.reason).toBe('NO_MATCHING_DOSE_RULE');
    });
});

describe('senior (8+ let) — pásma doplněná podle FEDIAF 2021 (25. 9. 2026)', () => {
    // Dřív měl senior jen „nízká aktivita" → s výchozí střední aktivitou nedostal dávku vůbec.
    it.each([
        ['LOW', 'senior-low', 1.5, 2.0],
        ['MEDIUM', 'senior-medium', 1.75, 2.25],
        ['HIGH', 'senior-high', 2.25, 3.0],
        ['WORKING', 'senior-working', 2.25, 3.0],
    ] as const)('aktivita %s → %s (%s–%s %%)', (activity, id, min, max) => {
        const r = calculateDose(dog({ ageMonths: 120, activity }), METHODOLOGY, noConstraints());
        expect(r.status).toBe('OK');
        expect(r.ruleId).toBe(id);
        const rule = METHODOLOGY.doseMatrix.find((x) => x.id === id)!;
        expect([rule.pctMin, rule.pctMax]).toEqual([min, max]);
    });

    it('senior dostane o 10–15 % méně než dospělý se stejnou aktivitou (FEDIAF)', () => {
        for (const activity of ['MEDIUM', 'HIGH', 'WORKING'] as const) {
            const adult = calculateDose(dog({ ageMonths: 60, activity }), METHODOLOGY, noConstraints());
            const senior = calculateDose(dog({ ageMonths: 120, activity }), METHODOLOGY, noConstraints());
            const ratio = senior.totalGramsPerDay! / adult.totalGramsPerDay!;
            expect(ratio).toBeGreaterThanOrEqual(0.85);
            expect(ratio).toBeLessThanOrEqual(0.9);
        }
    });

    it('senior s nadváhou má pořád redukční dietu, ne pásmo aktivity', () => {
        const r = calculateDose(
            dog({ ageMonths: 120, activity: 'HIGH', bodyCondition: 'OVER', idealWeightKg: 20 }),
            METHODOLOGY,
            noConstraints()
        );
        expect(r.ruleId).toBe('over-weight-senior');
    });

    it('každá kombinace věk × aktivita má pásmo (žádný pes bez dávky)', () => {
        for (const ageMonths of [3, 9, 18, 60, 96, 150])
            for (const activity of ['LOW', 'MEDIUM', 'HIGH', 'WORKING'] as const) {
                const r = calculateDose(dog({ ageMonths, activity }), METHODOLOGY, noConstraints());
                expect(r.status, `${ageMonths} měs, ${activity}`).toBe('OK');
            }
    });
});
