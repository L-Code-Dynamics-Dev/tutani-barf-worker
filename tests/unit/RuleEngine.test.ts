/**
 * Testy rule enginu.
 *
 * Zaměřeno na to, co u zdravotních pravidel skutečně rozhoduje:
 * skládání zákazů, nejtvrdší limit, blokace, determinismus a to, že
 * neznámý vstup nezmizí potichu (R7).
 *
 * Data se načítají z REÁLNÝCH ruleset JSONů, ne z vymyšlených fixture —
 * test tak zároveň hlídá konzistenci znalostní databáze.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
    buildKnowledgeBase,
    resolveConstraints,
    type HealthKnowledgeBase,
} from '../../src/rules/RuleEngine.js';

const health = JSON.parse(
    readFileSync(new URL('../../tenants/tutani/rules/tutani-health.json', import.meta.url), 'utf-8')
);
const ingredients = JSON.parse(
    readFileSync(new URL('../../tenants/tutani/rules/ingredients.json', import.meta.url), 'utf-8')
);
const barfCore = JSON.parse(
    readFileSync(new URL('../../tenants/tutani/rules/barf-core.json', import.meta.url), 'utf-8')
);

const KB = buildKnowledgeBase(health, ingredients, barfCore);

const TOXIC = [
    'hrozny',
    'rozinky',
    'cibule',
    'cesnek',
    'cokolada',
    'xylitol',
    'avokado',
    'makadamove-orechy',
];

describe('znalostní databáze — integrita dat', () => {
    it('všechna pravidla míří na existující podmínku', () => {
        const ids = new Set(health.conditions.map((c: { id: string }) => c.id));
        for (const r of health.conditionRules) expect(ids.has(r.conditionId)).toBe(true);
    });

    it('každá podmínka má layNameCs, explainCs, source a updatedAt', () => {
        for (const c of health.conditions) {
            expect(c.layNameCs, c.id).toBeTruthy();
            expect(c.explainCs, c.id).toBeTruthy();
            expect(c.source, c.id).toBeTruthy();
            expect(c.updatedAt, c.id).toBeTruthy();
        }
    });

    it('INGREDIENT_* pravidla míří na surovinu ze slovníku', () => {
        const ids = new Set(ingredients.ingredients.map((i: { id: string }) => i.id));
        for (const r of health.conditionRules) {
            if (r.ruleType === 'INGREDIENT_EXCLUDE' || r.ruleType === 'INGREDIENT_PREFER') {
                expect(ids.has(r.target), `${r.id} → ${r.target}`).toBe(true);
            }
        }
    });
});

describe('prázdný vstup', () => {
    it('bez diagnóz a alergií vyloučí jen toxické potraviny', () => {
        const r = resolveConstraints([], [], KB);
        expect(r.blocked).toBe(false);
        expect(r.compositionLimits).toEqual([]);
        expect(r.dosePctOverride).toBeUndefined();
        expect([...r.excludedIngredientIds].sort()).toEqual([...TOXIC].sort());
        // Toxické potraviny jsou `alwaysActive` — uplatní se i bez zadání.
        expect(r.appliedConditionIds).toContain('toxicke-potraviny');
        expect(r.requiresVet).toBe(false);
    });

    it('nesahá na vstupní pole a snese nesmysly v nich', () => {
        const input = ['', '  '];
        const r = resolveConstraints(input, [''], KB);
        expect(input).toEqual(['', '  ']);
        expect(r.unknownConditionIds).toEqual([]);
    });
});

describe('toxické potraviny jsou vyloučené vždy', () => {
    it('i u zdravého psa bez jakéhokoli vstupu', () => {
        for (const t of TOXIC) {
            expect(resolveConstraints([], [], KB).excludedIngredientIds.has(t)).toBe(true);
        }
    });

    it('i když je dávka blokovaná závažnou diagnózou', () => {
        const r = resolveConstraints(['ckd-advanced'], [], KB);
        expect(r.blocked).toBe(true);
        expect(r.excludedIngredientIds.has('xylitol')).toBe(true);
    });
});

describe('sjednocení zákazů', () => {
    it('alergie na drůbež vyloučí kuřecí, krůtí i kachní', () => {
        const r = resolveConstraints(['alergie-drubez'], [], KB);
        for (const i of ['kure', 'kruti', 'kachna']) {
            expect(r.excludedIngredientIds.has(i), i).toBe(true);
        }
        expect(r.excludedIngredientIds.has('hovezi')).toBe(false);
    });

    it('diagnóza a alergie zadaná majitelem se SKLÁDAJÍ, nepřepisují', () => {
        // Pankreatitida vylučuje tučné suroviny, majitel navíc zadá hovězí.
        const r = resolveConstraints(['pankreatitida'], ['hovezi'], KB);
        expect(r.excludedIngredientIds.has('vepr')).toBe(true);
        expect(r.excludedIngredientIds.has('kachna')).toBe(true);
        expect(r.excludedIngredientIds.has('losos')).toBe(true);
        expect(r.excludedIngredientIds.has('hovezi')).toBe(true);
    });

    it('zákaz je silnější než preference — vyloučená surovina se nepreferuje', () => {
        // Pankreatitida preferuje kuřecí, ale pes má na kuřecí alergii.
        const r = resolveConstraints(['pankreatitida', 'alergie-kure'], [], KB);
        expect(r.excludedIngredientIds.has('kure')).toBe(true);
        expect(r.preferredIngredientIds.has('kure')).toBe(false);
        // Ostatní libové suroviny preferované zůstanou.
        expect(r.preferredIngredientIds.has('kralik')).toBe(true);
    });
});

describe('nejtvrdší limit vyhrává', () => {
    it('dvě diagnózy na tutéž složku → nižší strop', () => {
        // onemocneni-jater: LIVER ≤ 3 %, med-hepatopatie: LIVER ≤ 1 %
        const r = resolveConstraints(['onemocneni-jater', 'med-hepatopatie'], [], KB);
        const liver = r.compositionLimits.find((l) => l.group === 'LIVER');
        expect(liver?.maxPct).toBe(1);
        // Auditní stopa musí ukázat OBA zdroje limitu, i ten přebitý.
        expect(liver?.ruleId).toContain('med-liver-max');
        expect(liver?.ruleId).toContain('jatra-liver-max');
    });

    it('nezáleží na pořadí zadání ani na priority', () => {
        const a = resolveConstraints(['onemocneni-jater', 'med-hepatopatie'], [], KB);
        const b = resolveConstraints(['med-hepatopatie', 'onemocneni-jater'], [], KB);
        expect(a.compositionLimits).toEqual(b.compositionLimits);
    });

    it('u minima vyhrává nejvyšší hodnota', () => {
        const kb: HealthKnowledgeBase = {
            ...KB,
            conditions: [...KB.conditions, cond('t1'), cond('t2')],
            conditionRules: [
                limitRule('r1', 't1', 'PLANT', 'GTE', '5'),
                limitRule('r2', 't2', 'PLANT', 'GTE', '9'),
            ],
        };
        const plant = resolveConstraints(['t1', 't2'], [], kb).compositionLimits.find(
            (l) => l.group === 'PLANT'
        );
        expect(plant?.minPct).toBe(9);
    });

    it('strop i minimum na téže složce koexistují', () => {
        const kb: HealthKnowledgeBase = {
            ...KB,
            conditions: [...KB.conditions, cond('t1'), cond('t2')],
            conditionRules: [
                limitRule('r1', 't1', 'BONE', 'LTE', '8'),
                limitRule('r2', 't2', 'BONE', 'GTE', '6'),
            ],
        };
        const bone = resolveConstraints(['t1', 't2'], [], kb).compositionLimits.find(
            (l) => l.group === 'BONE'
        );
        expect(bone?.maxPct).toBe(8);
        expect(bone?.minPct).toBe(6);
    });
});

describe('CKD + alergie současně', () => {
    const r = resolveConstraints(['ckd-early', 'alergie-kure'], [], KB);

    it('limit z diagnózy a zákaz z alergie platí oba', () => {
        expect(r.compositionLimits.find((l) => l.group === 'BONE')?.maxPct).toBe(8);
        expect(r.excludedIngredientIds.has('kure')).toBe(true);
    });

    it('dávka se vydá — počáteční stadium neblokuje', () => {
        expect(r.blocked).toBe(false);
        expect(r.blockedBy).toEqual([]);
    });

    it('CKD vyžaduje veterináře, i když alergie ne', () => {
        expect(r.requiresVet).toBe(true);
    });

    it('CKD přepíše počet porcí na 3', () => {
        expect(r.portionsOverride?.count).toBe(3);
        expect(r.portionsOverride?.ruleId).toBe('ckd-early-portions');
    });

    it('varování nese severity podmínky a text pro majitele', () => {
        const w = r.warnings.find((x) => x.conditionId === 'ckd-early' && x.textCs.includes('kostí'));
        expect(w?.severity).toBe('SERIOUS');
        expect(w?.requiresVet).toBe(true);
    });
});

describe('blocksResult', () => {
    it('ckd-advanced dávku zablokuje a řekne kvůli čemu', () => {
        const r = resolveConstraints(['ckd-advanced'], [], KB);
        expect(r.blocked).toBe(true);
        expect(r.blockedBy).toEqual(['ckd-advanced']);
        expect(r.requiresVet).toBe(true);
    });

    it('dvě blokující diagnózy → blockedBy obsahuje obě, seřazené', () => {
        const r = resolveConstraints(['portosystemovy-shunt', 'ckd-advanced'], [], KB);
        expect(r.blockedBy).toEqual(['ckd-advanced', 'portosystemovy-shunt']);
    });

    it('neblokující diagnóza sama dávku nezastaví', () => {
        expect(resolveConstraints(['pankreatitida'], [], KB).blocked).toBe(false);
    });
});

describe('neznámé id nezmizí potichu (R7)', () => {
    it('neznámá diagnóza se vrátí, varuje a vynutí veterináře', () => {
        const r = resolveConstraints(['neexistujici-nemoc'], [], KB);
        expect(r.unknownConditionIds).toEqual(['neexistujici-nemoc']);
        expect(r.requiresVet).toBe(true);
        const w = r.warnings.find((x) => x.conditionId === 'neexistujici-nemoc');
        expect(w?.severity).toBe('SERIOUS');
        expect(w?.textCs).toContain('neexistujici-nemoc');
    });

    it('známé diagnózy se vyhodnotí i vedle neznámé', () => {
        const r = resolveConstraints(['ckd-early', 'neco-divneho'], [], KB);
        expect(r.compositionLimits.find((l) => l.group === 'BONE')?.maxPct).toBe(8);
        expect(r.unknownConditionIds).toEqual(['neco-divneho']);
    });

    it('neznámá surovina se pro jistotu vyloučí A přizná', () => {
        const r = resolveConstraints([], ['klokan'], KB);
        expect(r.excludedIngredientIds.has('klokan')).toBe(true);
        expect(r.unknownAllergyIngredientIds).toEqual(['klokan']);
        expect(r.warnings.some((w) => w.conditionId === 'allergy:klokan')).toBe(true);
    });

    it('známá surovina se nehlásí jako neznámá', () => {
        expect(resolveConstraints([], ['hovezi'], KB).unknownAllergyIngredientIds).toEqual([]);
    });

    it('limit na živinu, kterou katalog nenese, se přizná jako neuplatněný', () => {
        const r = resolveConstraints(['ckd-early'], [], KB);
        const u = r.unappliedRules.find((x) => x.ruleId === 'ckd-early-phosphorus');
        expect(u?.reason).toBe('NO_DATA_FOR_NUTRIENT');
        expect(r.warnings.some((w) => w.textCs.includes('fosfor'))).toBe(true);
    });

    it('filtr na atribut, který katalog nenese, produkty nevyřadí', () => {
        const r = resolveConstraints(['pankreatitida'], [], KB);
        expect(r.productAttrFilters).toEqual([]);
        const u = r.unappliedRules.find((x) => x.ruleId === 'pankreatitida-fat-attr');
        expect(u?.reason).toBe('NO_DATA_FOR_PRODUCT_ATTR');
    });

    it('neznámý typ pravidla se přizná, netváří se jako neexistující', () => {
        const kb: HealthKnowledgeBase = {
            ...KB,
            conditions: [...KB.conditions, cond('t1')],
            conditionRules: [
                {
                    id: 'r-nova',
                    conditionId: 't1',
                    ruleType: 'NECO_NOVEHO' as never,
                    priority: 10,
                    updatedAt: '2026-09-09',
                },
            ],
        };
        const u = resolveConstraints(['t1'], [], kb).unappliedRules;
        expect(u[0].reason).toBe('UNKNOWN_RULE_TYPE');
    });

    it('vadná hodnota limitu se neuplatní, nebere se jako 0', () => {
        const kb: HealthKnowledgeBase = {
            ...KB,
            conditions: [...KB.conditions, cond('t1')],
            conditionRules: [limitRule('r1', 't1', 'BONE', 'LTE', 'osm procent')],
        };
        const r = resolveConstraints(['t1'], [], kb);
        expect(r.compositionLimits).toEqual([]);
        expect(r.unappliedRules[0].reason).toBe('INVALID_VALUE');
    });

    it('limit na neexistující složku se neuplatní', () => {
        const kb: HealthKnowledgeBase = {
            ...KB,
            conditions: [...KB.conditions, cond('t1')],
            conditionRules: [limitRule('r1', 't1', 'JATRA', 'LTE', '3')],
        };
        expect(resolveConstraints(['t1'], [], kb).unappliedRules[0].reason).toBe('INVALID_TARGET');
    });
});

describe('determinismus', () => {
    it('stejný vstup dá totožný výstup včetně pořadí varování', () => {
        const args = [
            ['ckd-early', 'pankreatitida', 'alergie-drubez', 'onemocneni-jater'],
            ['hovezi', 'losos'],
        ] as const;
        const a = resolveConstraints(args[0], args[1], KB);
        const b = resolveConstraints(args[0], args[1], KB);
        expect(serialize(a)).toEqual(serialize(b));
    });

    it('opačné pořadí vstupů dá tentýž výstup', () => {
        const a = resolveConstraints(['pankreatitida', 'ckd-early'], ['losos', 'hovezi'], KB);
        const b = resolveConstraints(['ckd-early', 'pankreatitida'], ['hovezi', 'losos'], KB);
        expect(serialize(a)).toEqual(serialize(b));
    });

    it('duplicitní zadání diagnózy nezdvojí varování', () => {
        const once = resolveConstraints(['ckd-early'], [], KB);
        const twice = resolveConstraints(['ckd-early', 'ckd-early'], [], KB);
        expect(serialize(twice)).toEqual(serialize(once));
    });

    it('varování jsou seřazená podle závažnosti', () => {
        const order = { CRITICAL: 0, SERIOUS: 1, CAUTION: 2, INFO: 3 } as const;
        const w = resolveConstraints(
            ['ckd-early', 'pankreatitida', 'laktace', 'toxicke-potraviny'],
            [],
            KB
        ).warnings;
        for (let i = 1; i < w.length; i++) {
            expect(order[w[i].severity]).toBeGreaterThanOrEqual(order[w[i - 1].severity]);
        }
    });
});

describe('fyziologické stavy se neduplikují s barf-core', () => {
    it('laktace nemění dávku ani porce, jen varuje', () => {
        const r = resolveConstraints(['laktace'], [], KB);
        expect(r.dosePctOverride).toBeUndefined();
        expect(r.portionsOverride).toBeUndefined();
        expect(r.compositionLimits).toEqual([]);
        expect(r.warnings.some((w) => w.conditionId === 'laktace')).toBe(true);
    });

    it('rekonvalescence i březost jen varují', () => {
        for (const id of ['rekonvalescence', 'brezost']) {
            const r = resolveConstraints([id], [], KB);
            expect(r.dosePctOverride, id).toBeUndefined();
            expect(r.compositionLimits, id).toEqual([]);
        }
    });
});

describe('metadata výstupu', () => {
    it('nese verzi znalostní databáze a uplatněné podmínky', () => {
        const r = resolveConstraints(['ckd-early'], [], KB);
        expect(r.ruleSetId).toBe('tutani-health@1');
        expect(r.appliedConditionIds).toContain('ckd-early');
    });
});

// ---- pomocné ----

function cond(id: string) {
    return {
        id,
        kind: 'DISEASE' as const,
        nameCs: id,
        layNameCs: id,
        explainCs: id,
        severity: 'CAUTION' as const,
        requiresVet: false,
        blocksResult: false,
        updatedAt: '2026-09-09',
    };
}

function limitRule(id: string, conditionId: string, target: string, op: string, value: string) {
    return {
        id,
        conditionId,
        ruleType: 'COMPOSITION_LIMIT' as const,
        target,
        op: op as never,
        value,
        unit: 'PCT_OF_DIET' as const,
        priority: 10,
        updatedAt: '2026-09-09',
    };
}

/** Set → seřazené pole, aby šel výstup srovnat na rovnost. */
function serialize(r: ReturnType<typeof resolveConstraints>) {
    return JSON.stringify({
        ...r,
        excludedIngredientIds: [...r.excludedIngredientIds].sort(),
        preferredIngredientIds: [...r.preferredIngredientIds].sort(),
    });
}
