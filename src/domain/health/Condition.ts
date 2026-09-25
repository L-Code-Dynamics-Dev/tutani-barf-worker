/**
 * Znalostní vrstva — zdravotní stavy a pravidla, která z nich plynou.
 *
 * ZÁSADA (Lucky 2026-09-08): knowledge base NESMÍ být natvrdo v
 * TypeScriptu. Tyhle typy popisují jen TVAR dat; samotné nemoci, stavy,
 * alergie a pravidla žijí v JSON souborech (`tenants/*​/rules/`) a v D1,
 * verzované a auditovatelné. Engine pravidla pouze INTERPRETUJE.
 *
 * Nemoc není textové upozornění (§3 zadání) — každá nese strojově
 * vyhodnotitelná pravidla, která se promítnou do výpočtu i do filtru
 * produktů.
 */

import type { BarfGroup } from '../tenant.js';

export type ConditionKind =
    | 'DISEASE'         // diagnóza (CKD, pankreatitida)
    | 'PHYSIOLOGICAL'   // březost, laktace, rekonvalescence
    | 'ALLERGY'         // alergie na surovinu
    | 'INTOLERANCE'
    | 'BODY_CONDITION'; // nadváha, podváha

/**
 * Závažnost. Řídí, jak nápadné je upozornění, a spolu s `requiresVet`
 * a `blocksResult` i to, jestli se dávka vůbec vydá.
 */
export type Severity = 'INFO' | 'CAUTION' | 'SERIOUS' | 'CRITICAL';

export interface Condition {
    id: string;
    kind: ConditionKind;
    /** Odborný název — pro veterináře a dokumentaci. */
    nameCs: string;
    /** Co uvidí majitel. Bez odborné hantýrky (§1 zadání). */
    layNameCs?: string;
    /** Vysvětlení pro majitele, proč se dávka mění. */
    explainCs?: string;
    severity: Severity;
    /** Doporučit konzultaci s veterinárním nutričním specialistou. */
    requiresVet: boolean;
    /**
     * BEZPEČNOSTNÍ VENTIL: `true` = dávku vůbec nevydat.
     * U stavů, kde by orientační doporučení mohlo uškodit. Je to
     * DATOVÉ rozhodnutí (klient/veterinář ho může změnit bez deploye),
     * ne rozhodnutí zabudované v kódu.
     */
    blocksResult: boolean;
    source?: string;
    sourceVersion?: string;
    updatedAt: string;
}

/**
 * Typ pravidla. Rozšiřitelný výčet — přidání nového typu je jediné
 * místo, kde se kód dotkne (interpret v rule enginu), zatímco přidání
 * nové NEMOCI nebo nového pravidla existujícího typu je čistě datová
 * operace (§10 zadání).
 */
export type RuleType =
    | 'DOSE_PCT_OVERRIDE'    // přepíše % z hmotnosti
    | 'DOSE_BASE_WEIGHT'     // počítat z ideální hmotnosti
    | 'COMPOSITION_LIMIT'    // strop/minimum složky dávky
    | 'NUTRIENT_LIMIT'       // limit na živinu (fosfor, bílkovina, tuk)
    | 'INGREDIENT_EXCLUDE'   // zakázaná surovina
    | 'INGREDIENT_PREFER'    // preferovaná surovina
    | 'PRODUCT_ATTR_EXCLUDE' // filtr na atribut produktu
    | 'PORTIONS_OVERRIDE'    // počet porcí denně
    | 'WARNING';             // povinné upozornění

export type RuleOp = 'LTE' | 'GTE' | 'EQ' | 'EXCLUDE' | 'REQUIRE' | 'SCALE';

export type RuleUnit = 'PCT_OF_DIET' | 'PCT_OF_WEIGHT' | 'G_PER_KG' | 'RATIO' | 'NONE';

export interface ConditionRule {
    id: string;
    conditionId: string;
    ruleType: RuleType;
    /**
     * Na co pravidlo míří: `BarfGroup` u COMPOSITION_LIMIT, id
     * ingredience u INGREDIENT_*, název atributu u PRODUCT_ATTR_EXCLUDE.
     */
    target?: string;
    op?: RuleOp;
    /** Hodnota jako string — interpretuje se podle `unit`. */
    value?: string;
    unit?: RuleUnit;
    /**
     * Nižší číslo = dřív. Při konfliktu dvou pravidel na tomtéž cíli
     * vyhrává STRIKTNĚJŠÍ hodnota, ne pozdější pravidlo — proto je
     * priorita jen pořadí vyhodnocení, ne rozhodčí.
     */
    priority: number;
    noteCs?: string;
    source?: string;
    sourceVersion?: string;
    updatedAt: string;
}

/**
 * Výsledek rule enginu — omezení sjednocená ze všech aktivních
 * podmínek. Vstup pro výpočet dávky i pro filtr produktů.
 *
 * Kombinace se řeší SKLÁDÁNÍM, ne přepisem (§3 zadání): CKD +
 * alergie na kuřecí = sjednocení zákazů a nejtvrdší z limitů.
 */
export interface ResolvedConstraints {
    /** Přepis procenta z hmotnosti, je-li nějaký. */
    dosePctOverride?: { min: number; max: number; ruleId: string };
    /** Počítat z ideální hmotnosti místo aktuální. */
    useIdealWeight: boolean;
    /** Stropy a minima na složky dávky, už sjednocené. */
    compositionLimits: CompositionLimit[];
    /** Sjednocená množina zakázaných surovin (alergie + toxické + nemoci). */
    excludedIngredientIds: Set<string>;
    /**
     * Zákazy plynoucí ze ZADANÉ alergie nebo diagnózy — BEZ toxických
     * surovin, které platí vždy.
     *
     * Rozlišení je potřebné pro fail-closed v `matchProducts`: produkt
     * s neurčitelnou surovinou se má vyřadit jen tehdy, když pes
     * skutečně něco nesnáší. Kdyby se použila celá
     * `excludedIngredientIds`, byla by neprázdná vždy (8 toxických
     * surovin) a u zdravého psa by vypadlo všech 219 produktů bez
     * složení — konfigurátor by nedoporučil nic.
     *
     * Volitelné kvůli existujícím testům; chybějící hodnota se čte
     * jako prázdná množina (žádná zadaná alergie).
     */
    ownerExcludedIngredientIds?: Set<string>;
    /** Preferované suroviny — ovlivní řazení, ne filtr. */
    preferredIngredientIds: Set<string>;
    /** Filtry na atributy produktu, např. `fatPct LTE 10`. */
    productAttrFilters: ProductAttrFilter[];
    /** Přepis počtu porcí. */
    portionsOverride?: { count: number; ruleId: string };
    /** Upozornění k zobrazení. */
    warnings: ResolvedWarning[];
    /** `true` = dávku nevydávat (blocksResult u některé podmínky). */
    blocked: boolean;
    /** Kvůli kterým podmínkám je blokováno. */
    blockedBy: string[];
    /** Aspoň jedna podmínka vyžaduje veterináře. */
    requiresVet: boolean;
    /**
     * Jen mleté kosti — celé kosti a maso s celou kostí se nedoporučí
     * (pes s problémem se zuby / polykáním, `applyDogProfileFlags`).
     */
    groundBoneOnly?: boolean;
}

export interface CompositionLimit {
    group: BarfGroup;
    /** Strop v procentech dávky (0–100), je-li omezen. */
    maxPct?: number;
    /** Minimum v procentech dávky. */
    minPct?: number;
    ruleId: string;
}

export interface ProductAttrFilter {
    attr: string;
    op: RuleOp;
    value: string;
    ruleId: string;
}

export interface ResolvedWarning {
    conditionId: string;
    severity: Severity;
    textCs: string;
    requiresVet: boolean;
}
