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
    reason?:
        | 'NO_MATCHING_DOSE_RULE'
        | 'MISSING_IDEAL_WEIGHT'
        | 'CONDITION_BLOCKS_RESULT'
        | 'UNSATISFIABLE_LIMITS'
        | 'INVALID_DOSE_PCT';
    /** Které limity si odporují — pro report klientovi, ne pro zákazníka. */
    unsatisfiable?: string[];
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
        const o = constraints.dosePctOverride;
        /**
         * SANITY (nález auditu 2026-09-09): bez téhle kontroly vydal
         * engine u `{min:-10,max:-10}` dávku **-2000 g** se statusem
         * OK a negativní gramáží u všech složek. Pravidlo s nesmyslným
         * procentem je chyba v datech, ne vstup k výpočtu — a protože
         * pravidla smí editovat klient, musí to engine odchytit.
         *
         * Horní hranice 20 % je nad nejvyšším pásmem metodiky
         * (laktující fena 4–6 %) s velkou rezervou; cokoliv nad tím je
         * překlep, ne zdravotní rozhodnutí.
         */
        const platny =
            Number.isFinite(o.min) && Number.isFinite(o.max) &&
            o.min > 0 && o.max > 0 && o.min <= o.max && o.max <= 20;
        if (!platny) {
            return {
                status: 'INCOMPLETE',
                reason: 'INVALID_DOSE_PCT',
                composition: [],
                audit: [
                    ...audit,
                    {
                        step: 'DOSE_PCT_OVERRIDE',
                        ruleId: o.ruleId,
                        resultCs:
                            `pravidlo dodalo neplatné procento (${o.min}–${o.max} %) — ` +
                            'dávka se nevydává, dokud se pravidlo neopraví',
                    },
                ],
            };
        }
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
    const rozpad = splitComposition(
        totalGramsRounded,
        methodology.compositionProfile.groups,
        constraints,
        audit
    );

    /**
     * Nesplnitelné limity → dávka se NEVYDÁ (nález auditu 2026-09-09).
     *
     * Dřív engine v takovém případě čísla domyslel: u `MUSCLE maxPct 0`
     * vyhnal zeleninu na 80 % (metodika povoluje 10 %), u konfliktu
     * `max 5 + min 90` oba limity tiše zahodil a spočítal, jako by pes
     * byl zdravý, a u limitů na všech složkách vrátil `grams: 450`
     * s `pct: 0` — výstup si protiřečil sám se sebou.
     *
     * Takový stav vzniká kombinací dvou diagnóz, což je datová operace,
     * kterou smí udělat klient. Engine ho proto musí odchytit a přiznat,
     * ne obejít (R7).
     */
    if (rozpad.unsatisfiable.length > 0) {
        return {
            status: 'INCOMPLETE',
            reason: 'UNSATISFIABLE_LIMITS',
            unsatisfiable: rozpad.unsatisfiable,
            composition: [],
            audit: [
                ...audit,
                {
                    step: 'COMPOSITION_UNSATISFIABLE',
                    ruleId: rozpad.unsatisfiable.join(','),
                    resultCs:
                        'Zdravotní omezení psa se navzájem vylučují — dávku, která by ' +
                        'je splnila všechny, nelze sestavit. Je potřeba individuální ' +
                        'plán od veterinárního nutričního specialisty.',
                },
            ],
        };
    }
    const composition = rozpad.items;

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
 * Rozpad dávky na složky s RENORMALIZACÍ a KONTROLOU SPLNITELNOSTI.
 *
 * Zdravotní pravidlo může složku omezit (CKD → kosti max 8 % kvůli
 * fosforu). Ušetřená procenta se musí přerozdělit, jinak by součet
 * nedal 100 % a pes by dostal méně, než má.
 *
 * PŘEPSÁNO 2026-09-09 po auditu, který v původní verzi našel čtyři
 * způsoby, jak engine vydal nesmysl místo přiznání problému:
 *
 *  1. `MUSCLE maxPct 0` → zelenina vyhnána na 80 %, přes `pctMax` 10 %
 *  2. `PLANT minPct 30` → výsledek 9,2 %, ale audit hlásil „→ 30 %"
 *  3. `max 5` + `min 90` na téže složce → oba limity tiše zahozeny
 *  4. limity na všech složkách → `grams: 450` s `pct: 0` současně
 *
 * Kořen všech čtyř: kód rozdělil zbytek i tam, kde na něj nebyla
 * kapacita, a nikdy neověřil, že výsledek metodice odpovídá. Nová
 * verze proto vrací `unsatisfiable` a volající dávku nevydá.
 *
 * Vrací `items` i `unsatisfiable` — nikdy nevyhazuje výjimku, aby se
 * chyba v datech neprojevila jako HTTP 500.
 */
function splitComposition(
    totalGrams: number,
    groups: CompositionGroupProfile[],
    constraints: ResolvedConstraints,
    audit: AuditEntry[]
): { items: CompositionItem[]; unsatisfiable: string[] } {
    const limitFor = (g: BarfGroup) => constraints.compositionLimits.find((l) => l.group === g);
    const unsatisfiable: string[] = [];

    // ---- 1. Cílové procento každé složky podle limitů ----
    const working = groups.map((g) => {
        const limit = limitFor(g.group);
        let pct = new Decimal(g.pctDefault);
        let adjusted = false;
        let adjustedBy: string | undefined;

        /**
         * Konflikt `min > max` na téže složce je nesplnitelný.
         * Vzniká kombinací dvou diagnóz — dřív se oba limity tiše
         * zahodily a pes dostal dávku, jako by byl zdravý.
         */
        if (limit?.maxPct !== undefined && limit?.minPct !== undefined && limit.minPct > limit.maxPct) {
            unsatisfiable.push(limit.ruleId);
            audit.push({
                step: 'COMPOSITION_CONFLICT',
                ruleId: limit.ruleId,
                resultCs:
                    `${g.labelCs}: pravidla si odporují — minimum ${limit.minPct} % ` +
                    `je vyšší než maximum ${limit.maxPct} %`,
            });
            return { profile: g, pct, adjusted, adjustedBy, limit };
        }

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
            /**
             * Minimum nad `pctMax` metodiky je nesplnitelné: nelze
             * současně dodržet zdravotní pravidlo i poměry metodiky.
             */
            if (limit.minPct > g.pctMax) {
                unsatisfiable.push(limit.ruleId);
                audit.push({
                    step: 'COMPOSITION_CONFLICT',
                    ruleId: limit.ruleId,
                    resultCs:
                        `${g.labelCs}: pravidlo žádá minimum ${limit.minPct} %, ` +
                        `ale metodika povoluje nejvýš ${g.pctMax} %`,
                });
                return { profile: g, pct, adjusted, adjustedBy, limit };
            }
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

    if (unsatisfiable.length > 0) {
        return { items: [], unsatisfiable: dedupe(unsatisfiable) };
    }

    // ---- 2. Renormalizace na 100 % ----
    /**
     * Hranice, ve kterých se složka smí hýbat.
     *
     * ZDRAVOTNÍ LIMIT PŘEBÍJÍ METODIKU, nekoliduje s ní. Metodika
     * Tutani má `BONE 10–10` (pevných 10 %), ale CKD vyžaduje max 8 %
     * kvůli fosforu — a to musí projít. Kdyby se hranice jen průnikem
     * zužovaly, vznikl by prázdný interval a pes s nemocnými ledvinami
     * by dávku nedostal vůbec.
     *
     * Proto: je-li zdravotní limit tvrdší než metodika, posune se
     * i protilehlá hranice, aby interval zůstal neprázdný. Nesplnitelné
     * je až to, co si odporuje MEZI ZDRAVOTNÍMI PRAVIDLY (`min > max`,
     * řešeno výše) nebo součtem (níže).
     */
    const dolni = working.map((w) => {
        const zdravotniMax = w.limit?.maxPct;
        const zaklad = Math.max(w.profile.pctMin, w.limit?.minPct ?? 0);
        // Zdravotní strop pod metodikovým minimem → minimum ustoupí.
        return new Decimal(zdravotniMax !== undefined ? Math.min(zaklad, zdravotniMax) : zaklad);
    });
    const horni = working.map((w) => {
        const zdravotniMin = w.limit?.minPct;
        const zaklad = Math.min(w.profile.pctMax, w.limit?.maxPct ?? w.profile.pctMax);
        // Zdravotní minimum nad metodikovým maximem → maximum ustoupí.
        return new Decimal(zdravotniMin !== undefined ? Math.max(zaklad, zdravotniMin) : zaklad);
    });

    // Nesplnitelné už na úrovni hranic (limit pod metodikou i naopak).
    for (let i = 0; i < working.length; i++) {
        if (dolni[i].greaterThan(horni[i])) {
            const id = working[i].limit?.ruleId ?? 'compositionProfile';
            unsatisfiable.push(id);
            audit.push({
                step: 'COMPOSITION_CONFLICT',
                ruleId: id,
                resultCs:
                    `${working[i].profile.labelCs}: povolené rozmezí je prázdné ` +
                    `(${dolni[i]}–${horni[i]} %)`,
            });
        }
    }
    if (unsatisfiable.length > 0) {
        return { items: [], unsatisfiable: dedupe(unsatisfiable) };
    }

    // Součet musí být dosažitelný uvnitř hranic, jinak dávku nelze složit.
    const sumDolni = dolni.reduce((a, d) => a.plus(d), new Decimal(0));
    const sumHorni = horni.reduce((a, d) => a.plus(d), new Decimal(0));
    if (sumDolni.greaterThan(100) || sumHorni.lessThan(100)) {
        const ids = working
            .map((w) => w.limit?.ruleId)
            .filter((x): x is string => typeof x === 'string');
        audit.push({
            step: 'COMPOSITION_CONFLICT',
            ruleId: ids.join(',') || 'compositionProfile',
            resultCs:
                `součet složek nemůže dát 100 % — povolené rozmezí je ` +
                `${sumDolni.toFixed(1)}–${sumHorni.toFixed(1)} %`,
        });
        return { items: [], unsatisfiable: dedupe(ids.length ? ids : ['compositionProfile']) };
    }

    // Start uvnitř hranic, pak dorovnání zbytku POUZE do volné kapacity.
    const pct = working.map((w, i) => Decimal.min(Decimal.max(w.pct, dolni[i]), horni[i]));
    let zbytek = new Decimal(100).minus(pct.reduce((a, x) => a.plus(x), new Decimal(0)));

    // Iterativně: kapacita se po každém kroku přepočítá, takže se
    // nikdy nepřelije nad `horni` ani pod `dolni`.
    for (let krok = 0; krok < 8 && !zbytek.abs().lessThan('0.0001'); krok++) {
        const kapacita = pct.map((p, i) =>
            zbytek.greaterThan(0) ? horni[i].minus(p) : p.minus(dolni[i])
        );
        const celkem = kapacita.reduce((a, k) => a.plus(Decimal.max(k, 0)), new Decimal(0));
        if (celkem.lessThanOrEqualTo(0)) break;

        for (let i = 0; i < pct.length; i++) {
            const k = Decimal.max(kapacita[i], 0);
            if (k.isZero()) continue;
            pct[i] = pct[i].plus(zbytek.mul(k).div(celkem));
        }
        zbytek = new Decimal(100).minus(pct.reduce((a, x) => a.plus(x), new Decimal(0)));
    }

    if (!zbytek.abs().lessThan('0.01')) {
        // Sem se po kontrolách výše nemá jak dostat; kdyby ano, je to
        // chyba v metodice a dávka se nevydá.
        const ids = working.map((w) => w.limit?.ruleId).filter((x): x is string => !!x);
        return { items: [], unsatisfiable: dedupe(ids.length ? ids : ['compositionProfile']) };
    }

    if (working.some((w) => w.adjusted)) {
        audit.push({
            step: 'RENORMALIZE',
            ruleId: 'compositionProfile',
            resultCs:
                'po zdravotních úpravách se zbytek rozdělil mezi složky, ' +
                'které mají v metodice prostor',
        });
    }

    // ---- 3. Gramy ----
    const items: CompositionItem[] = working.map((w, i) => ({
        group: w.profile.group,
        labelCs: w.profile.labelCs,
        grams: Math.round((totalGrams * pct[i].toNumber()) / 100),
        pct: Math.round(pct[i].toNumber() * 10) / 10,
        adjusted: w.adjusted,
        adjustedBy: w.adjustedBy,
    }));

    /**
     * Dorovnání zaokrouhlení: rozdíl se přičte složce s největší
     * gramáží, KTERÁ MÁ NENULOVÉ PROCENTO.
     *
     * Podmínka `pct > 0` je nález 4: dřív se rozdíl přičetl prostě
     * největší položce, takže při nulových procentech vznikl objekt
     * `grams: 450, pct: 0` — výstup si protiřečil.
     */
    const gramSum = items.reduce((a, x) => a + x.grams, 0);
    const diff = totalGrams - gramSum;
    if (diff !== 0) {
        const kandidati = items.filter((x) => x.pct > 0);
        if (kandidati.length > 0) {
            const nejvetsi = kandidati.reduce((a, b) => (b.grams > a.grams ? b : a));
            nejvetsi.grams += diff;
            audit.push({
                step: 'ROUNDING',
                ruleId: 'compositionProfile',
                resultCs: `zaokrouhlení dorovnáno na složce „${nejvetsi.labelCs}" (${diff > 0 ? '+' : ''}${diff} g)`,
            });
        }
    }

    return { items, unsatisfiable: [] };
}

/** Deduplikace se zachováním pořadí — pro stabilní `unsatisfiable`. */
function dedupe(ids: string[]): string[] {
    return [...new Set(ids)];
}
