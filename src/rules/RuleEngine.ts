/**
 * RULE ENGINE — interpret znalostní databáze.
 *
 * Nemoci, alergie a limity žijí v JSONu (`tenants/*​/rules/`), tady je
 * jen INTERPRET (R5). Přidání diagnózy je datová operace; kódu se
 * dotkne jen přidání nového `RuleType`.
 *
 * ŽÁDNÉ LLM (R1). Výstup je funkce vstupu — stejný vstup dá vždy
 * stejný výsledek včetně pořadí ve `warnings`, protože zdravotní
 * doporučení musí být reprodukovatelné při reklamaci.
 *
 * NEHÁDÁ SE (R7): neznámé `conditionId` se nezahodí, vrátí se
 * v `unknownConditionIds` a jako varování. Pravidlo, které nemá
 * z čeho rozhodnout (limit na živinu, kterou katalog nenese), se
 * neuplatní a přizná se v `unappliedRules`.
 *
 * SKLÁDÁ, NEPŘEPISUJE: CKD + alergie na kuřecí = sjednocení zákazů
 * a NEJTVRDŠÍ z limitů. `priority` je jen pořadí vyhodnocení,
 * rozhodčím je striktnější hodnota.
 *
 * Aritmetika v `Decimal` — procenta se dál násobí gramy a float by
 * na sebe nabaloval chybu (stejný důvod jako v `calculateDose`).
 */

import Decimal from 'decimal.js';
import type { BarfGroup } from '../domain/tenant.js';
import type {
    CompositionLimit,
    Condition,
    ConditionRule,
    ProductAttrFilter,
    ResolvedConstraints,
    ResolvedWarning,
    Severity,
} from '../domain/health/Condition.js';

/** Znalostní databáze načtená z JSONu. Engine ji nemodifikuje. */
export interface HealthKnowledgeBase {
    ruleSetId: string;
    conditions: Condition[];
    conditionRules: ConditionRule[];
    /**
     * Suroviny toxické vždy — sjednocení `isToxic` ze slovníku
     * a `safety.toxicIngredientIds` z metodiky. Vylučují se bez
     * ohledu na zadané podmínky.
     */
    alwaysExcludedIngredientIds?: string[];
    /**
     * Které atributy produktu katalog reálně nese. Filtr na atribut,
     * který tady není, se NEUPLATNÍ a přizná se (R7) — jinak by
     * vyřadil všechno, nebo naopak nic, a nikdo by nevěděl proč.
     */
    availableProductAttrs?: string[];
    /**
     * Které živiny umí systém vyhodnotit. Dnes žádná — katalog Tutani
     * nutriční hodnoty nenese.
     */
    availableNutrients?: string[];
}

/** Pravidlo, které se nemohlo uplatnit. Nikdy nezmizí potichu (R7). */
export interface UnappliedRule {
    ruleId: string;
    conditionId: string;
    ruleType: string;
    reason:
        | 'NO_DATA_FOR_NUTRIENT'
        | 'NO_DATA_FOR_PRODUCT_ATTR'
        | 'UNKNOWN_RULE_TYPE'
        | 'INVALID_VALUE'
        | 'INVALID_TARGET';
    /** Technický popis pro audit a vývoj — zákazník ho NEvidí. */
    detailCs: string;
    target?: string;
}

/**
 * Jak se neuplatněné pravidlo řekne ZÁKAZNÍKOVI (Lucky 2026-09-25:
 * „Katalog neuvádí fatPct…" na webu nikdo nepochopí). Přiznat se to
 * musí dál (R7), jen lidsky: co neumíme ohlídat a co s tím má udělat.
 * Technický `detailCs` zůstává v `unappliedRules` pro audit.
 */
const CUSTOMER_TARGET_LABEL_CS: Record<string, string> = {
    fatPct: 'obsah tuku',
    fosfor: 'obsah fosforu',
    med: 'obsah mědi',
};

function customerTextCs(u: UnappliedRule): string {
    const label = (u.target && CUSTOMER_TARGET_LABEL_CS[u.target]) || null;
    if ((u.reason === 'NO_DATA_FOR_PRODUCT_ATTR' || u.reason === 'NO_DATA_FOR_NUTRIENT') && label) {
        return `Přesný ${label} u našich produktů zatím neuvádíme, takže ho v nákupu nedokážeme ohlídat. ` +
            'Pokud ho váš pes musí hlídat, proberte složení krmení s veterinářem.';
    }
    return 'Část doporučení pro tento zdravotní stav jsme nedokázali vyhodnotit. Dávku prosím projděte s veterinářem.';
}

/**
 * `ResolvedConstraints` plus diagnostika, kterou volající potřebuje,
 * ale výpočet dávky ne. Rozšíření, ne náhrada — `calculateDose`
 * i `matchProducts` přijímají tenhle objekt beze změny.
 */
export interface ResolveResult extends ResolvedConstraints {
    /** Podmínky, které se v databázi nenašly. NEIGNORUJÍ se. */
    unknownConditionIds: string[];
    /** Alergie na surovinu, kterou slovník nezná. */
    unknownAllergyIngredientIds: string[];
    /** Pravidla, která neměla z čeho rozhodnout. */
    unappliedRules: UnappliedRule[];
    /** Podmínky, které se skutečně uplatnily — pro auditní stopu. */
    appliedConditionIds: string[];
    /** Verze znalostní databáze, ze které výsledek vznikl. */
    ruleSetId: string;
}

/** Pořadí závažnosti pro deterministické řazení varování. */
const SEVERITY_ORDER: Record<Severity, number> = {
    CRITICAL: 0,
    SERIOUS: 1,
    CAUTION: 2,
    INFO: 3,
};

const BARF_GROUPS: ReadonlySet<string> = new Set<BarfGroup>([
    'MUSCLE',
    'BONE',
    'LIVER',
    'ORGAN',
    'PLANT',
    'SUPPLEMENT',
    'OTHER',
]);

/**
 * Složí omezení ze zadaných diagnóz a alergií.
 *
 * @param conditionIds          id diagnóz a stavů z konfigurátoru
 * @param allergyIngredientIds  suroviny, na které pes reaguje (majitel
 *                              je zadá přímo, bez diagnózy)
 * @param kb                    znalostní databáze
 */
export function resolveConstraints(
    conditionIds: readonly string[],
    allergyIngredientIds: readonly string[],
    kb: HealthKnowledgeBase
): ResolveResult {
    const conditionById = new Map<string, Condition>();
    for (const c of kb.conditions ?? []) conditionById.set(c.id, c);

    const knownIngredientIds = new Set(kb.alwaysExcludedIngredientIds ?? []);

    // ---- 1. KTERÉ PODMÍNKY SE UPLATNÍ ----
    // `alwaysActive` (toxické potraviny) platí i bez zadání majitelem —
    // bezpečnost není volba uživatele.
    const requested = dedupeSorted(conditionIds);
    const unknownConditionIds: string[] = [];
    const active: Condition[] = [];
    const seen = new Set<string>();

    for (const id of requested) {
        const cond = conditionById.get(id);
        if (!cond) {
            unknownConditionIds.push(id);
            continue;
        }
        if (!seen.has(cond.id)) {
            seen.add(cond.id);
            active.push(cond);
        }
    }
    for (const cond of kb.conditions ?? []) {
        if ((cond as { alwaysActive?: boolean }).alwaysActive && !seen.has(cond.id)) {
            seen.add(cond.id);
            active.push(cond);
        }
    }

    // Deterministické pořadí: závažnost, pak id. Nezávisí na tom, v jakém
    // pořadí majitel diagnózy naklikal.
    active.sort(byConditionOrder);

    // ---- 2. BLOKACE A VETERINÁŘ ----
    const blockedBy = active.filter((c) => c.blocksResult).map((c) => c.id);
    const requiresVet = active.some((c) => c.requiresVet);

    // ---- 3. PRAVIDLA ----
    const activeIds = new Set(active.map((c) => c.id));
    // Řazení pravidel: `priority`, pak id. Priorita je pořadí
    // vyhodnocení, NE rozhodčí u konfliktu (o tom rozhoduje tvrdost).
    const rules = (kb.conditionRules ?? [])
        .filter((r) => activeIds.has(r.conditionId))
        .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

    const unappliedRules: UnappliedRule[] = [];
    const excluded = new Set<string>(kb.alwaysExcludedIngredientIds ?? []);
    /**
     * Zákazy ze ZADANÝCH alergií a diagnóz, bez toxických surovin.
     * Řídí fail-closed v matchingu — viz `ownerExcludedIngredientIds`.
     */
    const ownerExcluded = new Set<string>();
    const preferred = new Set<string>();
    const attrFilters: ProductAttrFilter[] = [];
    /** Limity po skupinách, průběžně zpřísňované. */
    const limits = new Map<BarfGroup, { max?: Decimal; min?: Decimal; ruleIds: string[] }>();
    let dosePct: { min: Decimal; max: Decimal; ruleId: string } | undefined;
    let useIdealWeight = false;
    let portions: { count: number; ruleId: string } | undefined;
    const ruleWarnings: Array<{ rule: ConditionRule; cond: Condition }> = [];

    for (const rule of rules) {
        const cond = conditionById.get(rule.conditionId)!;

        switch (rule.ruleType) {
            case 'INGREDIENT_EXCLUDE': {
                if (!rule.target) {
                    unappliedRules.push(
                        unapplied(rule, 'INVALID_TARGET', 'Pravidlo neuvádí, kterou surovinu vyloučit.')
                    );
                    break;
                }
                excluded.add(rule.target);
                /**
                 * Do `ownerExcluded` jen zákazy ze SKUTEČNĚ ZADANÝCH
                 * podmínek. `alwaysActive` (toxické potraviny) platí
                 * vždy, takže by tuhle množinu naplnila i u zdravého
                 * psa a fail-closed by vyřadil celý katalog bez
                 * složení (odchyceno testem 2026-09-09).
                 */
                if (!(cond as { alwaysActive?: boolean }).alwaysActive) {
                    ownerExcluded.add(rule.target);
                }
                break;
            }

            case 'INGREDIENT_PREFER': {
                if (!rule.target) {
                    unappliedRules.push(
                        unapplied(rule, 'INVALID_TARGET', 'Pravidlo neuvádí, kterou surovinu preferovat.')
                    );
                    break;
                }
                preferred.add(rule.target);
                break;
            }

            case 'COMPOSITION_LIMIT': {
                if (!rule.target || !BARF_GROUPS.has(rule.target)) {
                    unappliedRules.push(
                        unapplied(
                            rule,
                            'INVALID_TARGET',
                            `„${rule.target ?? '-'}" není složka dávky (MUSCLE, BONE, LIVER, ORGAN, PLANT).`
                        )
                    );
                    break;
                }
                const value = parsePct(rule.value);
                if (value === null) {
                    unappliedRules.push(
                        unapplied(rule, 'INVALID_VALUE', `„${rule.value ?? '-'}" není procento v rozsahu 0–100.`)
                    );
                    break;
                }
                const group = rule.target as BarfGroup;
                const entry = limits.get(group) ?? { ruleIds: [] };
                // NEJTVRDŠÍ VYHRÁVÁ: u stropu nejnižší, u minima nejvyšší.
                // Proto se nesleduje, které pravidlo přišlo později.
                if (rule.op === 'GTE') {
                    if (entry.min === undefined || value.greaterThan(entry.min)) entry.min = value;
                } else {
                    if (entry.max === undefined || value.lessThan(entry.max)) entry.max = value;
                }
                if (!entry.ruleIds.includes(rule.id)) entry.ruleIds.push(rule.id);
                limits.set(group, entry);
                break;
            }

            case 'DOSE_PCT_OVERRIDE': {
                const range = parseRange(rule.value);
                if (!range) {
                    unappliedRules.push(
                        unapplied(
                            rule,
                            'INVALID_VALUE',
                            `„${rule.value ?? '-'}" není procento ani rozsah (např. „1" nebo „1-1.5").`
                        )
                    );
                    break;
                }
                // Sejde-li se víc přepisů, platí NEJNIŽŠÍ strop —
                // konzervativní volba: překrmit je snazší než dohnat.
                if (!dosePct || range.max.lessThan(dosePct.max)) {
                    dosePct = { min: range.min, max: range.max, ruleId: rule.id };
                }
                break;
            }

            case 'DOSE_BASE_WEIGHT': {
                // Jakékoli pravidlo tohohle typu znamená „počítej z ideální".
                // Opačný směr (vynutit aktuální) by u nadváhy škodil.
                useIdealWeight = true;
                break;
            }

            case 'PORTIONS_OVERRIDE': {
                const count = parseCount(rule.value);
                if (count === null) {
                    unappliedRules.push(
                        unapplied(rule, 'INVALID_VALUE', `„${rule.value ?? '-'}" není počet porcí (1–8).`)
                    );
                    break;
                }
                // Víc porcí = menší jednorázová zátěž. Vyhrává VYŠŠÍ počet.
                if (!portions || count > portions.count) {
                    portions = { count, ruleId: rule.id };
                }
                break;
            }

            case 'PRODUCT_ATTR_EXCLUDE': {
                if (!rule.target) {
                    unappliedRules.push(
                        unapplied(rule, 'INVALID_TARGET', 'Pravidlo neuvádí, na který atribut produktu míří.')
                    );
                    break;
                }
                // Katalog atribut nemá → NEHÁDÁ SE. Filtr se neuplatní
                // a přizná se, místo aby vyřadil všechno nebo nic.
                if (!(kb.availableProductAttrs ?? []).includes(rule.target)) {
                    unappliedRules.push(
                        unapplied(
                            rule,
                            'NO_DATA_FOR_PRODUCT_ATTR',
                            `Katalog neuvádí „${rule.target}", filtr se neuplatnil — produkty se podle něj nevyřazují.`
                        )
                    );
                    break;
                }
                attrFilters.push({
                    attr: rule.target,
                    op: rule.op ?? 'LTE',
                    value: rule.value ?? '',
                    ruleId: rule.id,
                });
                break;
            }

            case 'NUTRIENT_LIMIT': {
                // Živiny (fosfor, měď) katalog nenese. Limit se zapíše
                // jako neuplatněný — je to informace pro veterináře,
                // ne tichý zahozený požadavek.
                if (!(kb.availableNutrients ?? []).includes(rule.target ?? '')) {
                    unappliedRules.push(
                        unapplied(
                            rule,
                            'NO_DATA_FOR_NUTRIENT',
                            `Obsah „${rule.target ?? '-'}" u produktů neznáme, limit se nevyhodnotil.`
                        )
                    );
                    break;
                }
                // Vyhodnocení živin přijde, až budou v katalogu data.
                unappliedRules.push(
                    unapplied(
                        rule,
                        'NO_DATA_FOR_NUTRIENT',
                        `Limit na „${rule.target}" zatím engine nevyhodnocuje.`
                    )
                );
                break;
            }

            case 'WARNING': {
                if (!rule.value || rule.value.trim() === '') {
                    unappliedRules.push(unapplied(rule, 'INVALID_VALUE', 'Varování bez textu.'));
                    break;
                }
                ruleWarnings.push({ rule, cond });
                break;
            }

            default: {
                // Nový typ pravidla v datech, který interpret nezná.
                // Radši se přizná, než aby se choval, jako by neexistoval.
                unappliedRules.push(
                    unapplied(
                        rule,
                        'UNKNOWN_RULE_TYPE',
                        `Typ pravidla „${String(rule.ruleType)}" tenhle engine neumí vyhodnotit.`
                    )
                );
            }
        }
    }

    // ---- 4. ALERGIE ZADANÉ MAJITELEM ----
    // Jdou mimo diagnózy: majitel ví, že pes nesnáší kuřecí, i když
    // nemá papír od veterináře.
    const unknownAllergyIngredientIds: string[] = [];
    const hasDictionary = (kb.alwaysExcludedIngredientIds ?? []).length > 0;

    for (const ing of dedupeSorted(allergyIngredientIds)) {
        /**
         * PŘIJÍMÁ SE OBOJÍ: id suroviny (`kure`) i id ALERGICKÉ
         * PODMÍNKY (`alergie-kure`).
         *
         * NÁLEZ 2026-09-09: `/v1/knowledge` posílá do UI id podmínek
         * (`alergie-kure`, `alergie-drubez`), protože ta nesou
         * srozumitelný název pro majitele. Zákazník je zaškrtl, backend
         * je dostal v `alergie[]` a zacházel s nimi jako s NÁZVEM
         * SUROVINY — vyloučila se neexistující surovina `alergie-kure`,
         * zatímco produkty mají `kure`. **Filtr nevyřadil nic.**
         *
         * Kontrakt se proto nesjednocuje jen v UI (kde by to spravila
         * jedna změna a rozbila druhá), ale TADY: přijde-li id
         * podmínky, rozloží se na suroviny, které její pravidla
         * `INGREDIENT_EXCLUDE` vylučují. `alergie-drubez` tak správně
         * vyřadí kuře, krůtu i kachnu naráz.
         */
        const jakoPodminka = conditionById.get(ing);
        if (
            jakoPodminka &&
            (jakoPodminka.kind === 'ALLERGY' || jakoPodminka.kind === 'INTOLERANCE')
        ) {
            const suroviny = (kb.conditionRules ?? [])
                .filter(
                    (r) =>
                        r.conditionId === jakoPodminka.id &&
                        r.ruleType === 'INGREDIENT_EXCLUDE' &&
                        typeof r.target === 'string'
                )
                .map((r) => r.target as string);

            if (suroviny.length > 0) {
                for (const s of suroviny) {
                    excluded.add(s);
                    ownerExcluded.add(s);
                }
                continue;
            }
            // Podmínka bez pravidel je chyba v datech — vyloučí se
            // aspoň sama a přizná se to.
        }

        // Vyloučí se VŽDY — neznámou surovinu je bezpečnější vyloučit
        // než ignorovat. Zároveň se přizná, že ji slovník nezná.
        excluded.add(ing);
        ownerExcluded.add(ing);
        if (hasDictionary && !knownIngredientIds.has(ing) && !isKnownIngredient(ing, kb)) {
            unknownAllergyIngredientIds.push(ing);
        }
    }

    // Zákaz je silnější než preference: surovina vyloučená diagnózou
    // se nesmí objevit v preferencích a tlačit se do výběru.
    for (const ing of excluded) preferred.delete(ing);

    // ---- 5. VAROVÁNÍ ----
    const warnings: ResolvedWarning[] = [];

    for (const id of unknownConditionIds) {
        warnings.push({
            conditionId: id,
            severity: 'SERIOUS',
            textCs:
                `Zdravotní stav „${id}" v naší databázi nemáme, takže jsme ho do dávky ` +
                'nezapočítali. Dávku prosím proberte s veterinářem.',
            requiresVet: true,
        });
    }
    for (const ing of unknownAllergyIngredientIds) {
        warnings.push({
            conditionId: `allergy:${ing}`,
            severity: 'CAUTION',
            textCs:
                `Surovinu „${ing}" v našem seznamu nemáme. Vyloučili jsme ji pro jistotu, ` +
                'ale zkontrolujte prosím složení u produktů sami.',
            requiresVet: false,
        });
    }
    for (const { rule, cond } of ruleWarnings) {
        warnings.push({
            conditionId: cond.id,
            severity: cond.severity,
            textCs: rule.value!,
            requiresVet: cond.requiresVet,
        });
    }
    for (const u of unappliedRules) {
        // Chybějící data už vysvětluje vlastní upozornění nemoci (slinivka,
        // ledviny, měď) → druhá, skoro stejná hláška by zákazníka jen mátla.
        // V `unappliedRules` (audit) zůstává vždy.
        const noData = u.reason === 'NO_DATA_FOR_PRODUCT_ATTR' || u.reason === 'NO_DATA_FOR_NUTRIENT';
        if (noData && ruleWarnings.some((w) => w.cond.id === u.conditionId)) continue;
        const cond = conditionById.get(u.conditionId);
        warnings.push({
            conditionId: u.conditionId,
            severity: 'CAUTION',
            textCs: customerTextCs(u),
            requiresVet: cond?.requiresVet ?? false,
        });
    }

    // Deterministické pořadí: závažnost, pak podmínka, pak text.
    warnings.sort(
        (a, b) =>
            SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
            a.conditionId.localeCompare(b.conditionId) ||
            a.textCs.localeCompare(b.textCs)
    );

    // ---- 6. VÝSTUP ----
    const compositionLimits: CompositionLimit[] = [...limits.entries()]
        .map(([group, e]) => ({
            group,
            maxPct: e.max?.toNumber(),
            minPct: e.min?.toNumber(),
            // Všechna pravidla, která limit tvarovala — auditní stopa
            // musí ukázat i to, které bylo přebito tvrdším.
            ruleId: [...e.ruleIds].sort().join('+'),
        }))
        .sort((a, b) => a.group.localeCompare(b.group));

    return {
        dosePctOverride: dosePct
            ? { min: dosePct.min.toNumber(), max: dosePct.max.toNumber(), ruleId: dosePct.ruleId }
            : undefined,
        useIdealWeight,
        compositionLimits,
        excludedIngredientIds: excluded,
        ownerExcludedIngredientIds: ownerExcluded,
        preferredIngredientIds: preferred,
        productAttrFilters: attrFilters.sort(
            (a, b) => a.attr.localeCompare(b.attr) || a.ruleId.localeCompare(b.ruleId)
        ),
        portionsOverride: portions,
        warnings,
        blocked: blockedBy.length > 0,
        blockedBy: [...blockedBy].sort(),
        requiresVet: requiresVet || unknownConditionIds.length > 0,
        unknownConditionIds,
        unknownAllergyIngredientIds,
        unappliedRules: unappliedRules.sort((a, b) => a.ruleId.localeCompare(b.ruleId)),
        appliedConditionIds: active.map((c) => c.id),
        ruleSetId: kb.ruleSetId,
    };
}

/**
 * Postaví znalostní databázi z načtených JSONů.
 *
 * Toxické suroviny se berou ze DVOU zdrojů (slovník `isToxic`
 * a `safety.toxicIngredientIds` v metodice) a sjednotí se — kdyby se
 * někdy rozešly, bezpečnostní filtr má být širší, ne užší.
 */
export function buildKnowledgeBase(
    healthJson: unknown,
    ingredientsJson?: unknown,
    barfCoreJson?: unknown
): HealthKnowledgeBase {
    const h = asRecord(healthJson);
    const ing = ingredientsJson ? asRecord(ingredientsJson) : {};
    const core = barfCoreJson ? asRecord(barfCoreJson) : {};

    const toxic = new Set<string>();
    const list = Array.isArray(ing.ingredients) ? ing.ingredients : [];
    for (const i of list) {
        const r = asRecord(i);
        if (r.isToxic === true && typeof r.id === 'string') toxic.add(r.id);
    }
    const safety = asRecord(core.safety);
    if (Array.isArray(safety.toxicIngredientIds)) {
        for (const id of safety.toxicIngredientIds) if (typeof id === 'string') toxic.add(id);
    }

    return {
        ruleSetId: typeof h.ruleSetId === 'string' ? h.ruleSetId : 'unknown',
        conditions: Array.isArray(h.conditions) ? (h.conditions as Condition[]) : [],
        conditionRules: Array.isArray(h.conditionRules) ? (h.conditionRules as ConditionRule[]) : [],
        alwaysExcludedIngredientIds: [...toxic].sort(),
        // Katalog Tutani nenese ani tuk, ani nutriční hodnoty
        // (dry-run 2026-09-08) — proto prázdné, ne vymyšlené.
        availableProductAttrs: [],
        availableNutrients: [],
        ingredientIds: list
            .map((i) => asRecord(i).id)
            .filter((id): id is string => typeof id === 'string'),
    } as HealthKnowledgeBase;
}

/** Zná slovník tuhle surovinu? Bez slovníku se nic netvrdí (R7). */
function isKnownIngredient(id: string, kb: HealthKnowledgeBase): boolean {
    const ids = (kb as { ingredientIds?: string[] }).ingredientIds;
    return Array.isArray(ids) ? ids.includes(id) : true;
}

function byConditionOrder(a: Condition, b: Condition): number {
    return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.id.localeCompare(b.id);
}

function unapplied(
    rule: ConditionRule,
    reason: UnappliedRule['reason'],
    detailCs: string
): UnappliedRule {
    return { ruleId: rule.id, conditionId: rule.conditionId, ruleType: rule.ruleType, reason, detailCs, target: rule.target };
}

/** Procento 0–100. Mimo rozsah = chyba v datech, ne hodnota k použití. */
function parsePct(raw?: string): Decimal | null {
    if (raw === undefined || raw === null || String(raw).trim() === '') return null;
    let d: Decimal;
    try {
        d = new Decimal(String(raw).replace(',', '.').trim());
    } catch {
        return null;
    }
    if (!d.isFinite() || d.lessThan(0) || d.greaterThan(100)) return null;
    return d;
}

/** „1,5" nebo „1-1.5" → rozsah. Jedna hodnota = min i max. */
function parseRange(raw?: string): { min: Decimal; max: Decimal } | null {
    if (raw === undefined || raw === null) return null;
    const s = String(raw).replace(',', '.').trim();
    if (s === '') return null;
    const parts = s.split(/\s*[-–]\s*/);
    if (parts.length === 1) {
        const v = parsePct(parts[0]);
        return v ? { min: v, max: v } : null;
    }
    if (parts.length !== 2) return null;
    const min = parsePct(parts[0]);
    const max = parsePct(parts[1]);
    if (!min || !max || min.greaterThan(max)) return null;
    return { min, max };
}

/** Počet porcí 1–8. Nad 8 je chyba v datech, ne krmný režim. */
function parseCount(raw?: string): number | null {
    if (raw === undefined || raw === null) return null;
    const n = Number(String(raw).trim());
    if (!Number.isInteger(n) || n < 1 || n > 8) return null;
    return n;
}

function dedupeSorted(xs: readonly string[]): string[] {
    return [...new Set((xs ?? []).filter((x) => typeof x === 'string' && x.trim() !== ''))].sort();
}

function asRecord(x: unknown): Record<string, unknown> {
    return x && typeof x === 'object' ? (x as Record<string, unknown>) : {};
}
