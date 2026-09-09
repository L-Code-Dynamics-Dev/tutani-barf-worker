/**
 * DVĚ NEZÁVISLÉ OSY HODNOCENÍ — nutriční správnost a bezpečnost.
 *
 * Zdroj: znalostní báze Lucky, bod 29.
 *
 *   „Nutričně perfektní dieta může být mikrobiologicky riziková."
 *
 * PROČ TO NENÍ JEDEN VÝSLEDEK: dosud byla bezpečnost filtrem UVNITŘ
 * nutričního výpočtu (vařené kosti se vyřadily, toxické suroviny se
 * vyloučily). To mísí dvě různé otázky:
 *
 *   „Dodá dieta, co pes potřebuje?"  ≠  „Je bezpečné to podat?"
 *
 * Bod 29 to rozděluje, protože kombinace mají různé závěry:
 *
 * | dieta | nutričně | bezpečnostně | co s tím |
 * |---|---|---|---|
 * | A | OK | vysoké riziko | upravit manipulaci, ne recepturu |
 * | B | deficit Ca | nízké riziko | doplnit zdroj Ca |
 * | C | OK | přijatelné | podat |
 * | D | nadbytek vit. A | vysoké | přepracovat |
 *
 * Jediné skóre by z A a B udělalo „něco je špatně" a majitel by
 * nevěděl, kterým směrem to řešit.
 */

import type { SourceTier } from './energy.js';

/**
 * Tři úrovně výsledku (bod 95).
 *
 * `ORIENTACNI` je dnes STAV VĚCÍ, ne nedostatek implementace:
 * katalog Tutani nenese žádné nutriční hodnoty, takže klíčové živiny
 * nelze zkontrolovat. Přiznat to je poctivější než vydávat orientační
 * dávku za kontrolovanou.
 */
export type AssessmentLevel =
    | 'KONTROLOVANA'  // 🟢 data umožňují kontrolu a kritéria jsou splněná
    | 'ORIENTACNI'    // 🟡 některá data chybí nebo jsou příliš variabilní
    | 'NEVHODNA';     // 🔴 významný nedostatek/nadbytek nebo bezpečnostní problém

/** Stav jedné kontrolované položky (bod 88). */
export type NutrientStatus = 'OK' | 'NEDOSTATEK' | 'NADBYTEK' | 'NEZNAME';

/** Jedna položka nutriční kontroly z bodu 65. */
export interface NutrientCheck {
    /** Klíč živiny — `energy`, `protein`, `calcium`, `caPRatio`, `epa`… */
    key: string;
    labelCs: string;
    status: NutrientStatus;
    /** Naměřená hodnota, je-li známá. */
    value?: number;
    unit?: string;
    /** Cílové rozmezí podle životní fáze. */
    targetMin?: number;
    targetMax?: number;
    /** Odkud cíl je — `FEDIAF` u standardu, `NEJISTE` u dohadu. */
    source: SourceTier;
    /**
     * Proč `NEZNAME`. Text pro zákazníka, ne pro log — u chybějících
     * dat musí být jasné, že to systém neumí, ne že je vše v pořádku.
     */
    reasonCs?: string;
}

/** Typ bezpečnostního rizika (bod 29, osa B). */
export type SafetyRiskKind =
    | 'PATHOGEN'        // Salmonella, Campylobacter, Listeria, E. coli, Yersinia
    | 'PARASITE'
    | 'BONE_INJURY'     // zlomeniny zubů, obstrukce, perforace
    | 'DENTAL'
    | 'GI_OBSTRUCTION'
    | 'EXCESS'          // nadbytek živiny (vitamin A z jater, měď)
    | 'FOOD_TOXICITY'   // hrozny, cibule, xylitol…
    | 'STORAGE'         // chladicí řetěz, opakované mražení
    | 'HANDLING'        // křížová kontaminace, hygiena
    | 'VULNERABLE_HOUSEHOLD'; // WSAVA: přenos stolicí psa

export type RiskSeverity = 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH';

export interface SafetyRisk {
    kind: SafetyRiskKind;
    severity: RiskSeverity;
    /** Co se může stát. Text pro majitele. */
    textCs: string;
    /** Co s tím dělat — bez toho je varování k ničemu. */
    mitigationCs?: string;
    source: SourceTier;
}

/** Výsledek jedné osy. */
export interface AxisResult<T> {
    level: AssessmentLevel;
    items: T[];
    /** Krátké shrnutí pro UI. */
    summaryCs: string;
}

/**
 * Celkové hodnocení — DVĚ osy, každá s vlastní úrovní.
 *
 * `overall` je jen nejhorší z obou, aby UI mělo co zobrazit jako
 * hlavičku. Rozhodovat se má podle os, ne podle něj.
 */
export interface DietAssessment {
    nutrition: AxisResult<NutrientCheck>;
    safety: AxisResult<SafetyRisk>;
    overall: AssessmentLevel;
}

/**
 * 17 kontrolních položek z bodu 65.
 *
 * Pořadí je závazné — od energie k mastným kyselinám, jak to popisuje
 * bod 13: `energie → makroživiny → minerály → vitaminy → mastné
 * kyseliny`. Zákazník to čte odshora a nejdůležitější má být první.
 *
 * `available` říká, jestli na to VŮBEC máme data. Dnes je `true`
 * jen u energie — ověřeno na všech 7 feedech Shoptetu 2026-09-09.
 */
export const CONTROL_POINTS: ReadonlyArray<{
    key: string;
    labelCs: string;
    unit?: string;
    available: boolean;
}> = [
    { key: 'energy', labelCs: 'Energie', unit: 'kcal', available: true },
    { key: 'protein', labelCs: 'Bílkoviny', unit: 'g', available: false },
    { key: 'fat', labelCs: 'Tuk', unit: 'g', available: false },
    { key: 'calcium', labelCs: 'Vápník (Ca)', unit: 'mg', available: false },
    { key: 'phosphorus', labelCs: 'Fosfor (P)', unit: 'mg', available: false },
    { key: 'caPRatio', labelCs: 'Poměr Ca:P', available: false },
    { key: 'vitaminA', labelCs: 'Vitamin A', unit: 'IU', available: false },
    { key: 'vitaminD', labelCs: 'Vitamin D', unit: 'IU', available: false },
    { key: 'vitaminE', labelCs: 'Vitamin E', unit: 'mg', available: false },
    { key: 'vitaminB', labelCs: 'B-vitaminy', available: false },
    { key: 'iodine', labelCs: 'Jód', unit: 'µg', available: false },
    { key: 'zinc', labelCs: 'Zinek', unit: 'mg', available: false },
    { key: 'copper', labelCs: 'Měď', unit: 'mg', available: false },
    { key: 'iron', labelCs: 'Železo', unit: 'mg', available: false },
    { key: 'selenium', labelCs: 'Selen', unit: 'µg', available: false },
    { key: 'epa', labelCs: 'EPA', unit: 'mg', available: false },
    { key: 'dha', labelCs: 'DHA', unit: 'mg', available: false },
];

/**
 * Nutriční osa — co umíme zkontrolovat a co ne.
 *
 * `knownChecks` dodává volající za to, co spočítat umí (dnes energie).
 * Zbytek se doplní jako `NEZNAME` s vysvětlením — NIKDY se netvrdí
 * `OK` u živiny, kterou jsme nezměřili (bod 94).
 */
export function assessNutrition(knownChecks: NutrientCheck[]): AxisResult<NutrientCheck> {
    const podleKlice = new Map(knownChecks.map((c) => [c.key, c]));
    const items: NutrientCheck[] = [];

    for (const cp of CONTROL_POINTS) {
        const znamy = podleKlice.get(cp.key);
        if (znamy) {
            items.push(znamy);
            continue;
        }
        items.push({
            key: cp.key,
            labelCs: cp.labelCs,
            status: 'NEZNAME',
            unit: cp.unit,
            source: 'NEJISTE',
            reasonCs: cp.available
                ? 'nepodařilo se spočítat'
                : 'katalog neuvádí nutriční hodnoty produktů — tuhle živinu neumíme zkontrolovat',
        });
    }

    const nedostatky = items.filter((i) => i.status === 'NEDOSTATEK' || i.status === 'NADBYTEK');
    const nezname = items.filter((i) => i.status === 'NEZNAME');

    let level: AssessmentLevel;
    let summaryCs: string;

    if (nedostatky.length > 0) {
        level = 'NEVHODNA';
        summaryCs = `Dieta má ${nedostatky.length}× problém s živinami.`;
    } else if (nezname.length > 0) {
        level = 'ORIENTACNI';
        summaryCs =
            `Zkontrolovali jsme ${items.length - nezname.length} z ${items.length} živin. ` +
            'U ostatních katalog neuvádí hodnoty, proto je dávka orientační.';
    } else {
        level = 'KONTROLOVANA';
        summaryCs = 'Všechny klíčové živiny odpovídají potřebě psa.';
    }

    return { level, items, summaryCs };
}

/**
 * Bezpečnostní osa — nezávislá na nutriční.
 *
 * `alwaysRisks` jsou rizika, která u surového krmení platí VŽDY
 * (patogeny, hygiena, skladování) a nezmizí tím, že je dieta
 * nutričně správná. WSAVA: zmrazení ani sušení nemusí odstranit
 * všechny patogeny.
 */
export function assessSafety(risks: SafetyRisk[]): AxisResult<SafetyRisk> {
    const vysoke = risks.filter((r) => r.severity === 'HIGH');
    const stredni = risks.filter((r) => r.severity === 'MEDIUM');

    // Deterministické pořadí — nejzávažnější první.
    const poradi: Record<RiskSeverity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2, INFO: 3 };
    const items = [...risks].sort(
        (a, b) => poradi[a.severity] - poradi[b.severity] || a.kind.localeCompare(b.kind)
    );

    let level: AssessmentLevel;
    let summaryCs: string;

    if (vysoke.length > 0) {
        level = 'NEVHODNA';
        summaryCs = `${vysoke.length}× vysoké bezpečnostní riziko — přečtěte si upozornění.`;
    } else if (stredni.length > 0) {
        level = 'ORIENTACNI';
        summaryCs = 'Surové krmení má rizika, která se dají zvládnout správnou manipulací.';
    } else {
        level = 'KONTROLOVANA';
        summaryCs = 'Bez zjištěných bezpečnostních problémů nad běžné riziko surového krmení.';
    }

    return { level, items, summaryCs };
}

/** Nejhorší z obou os — jen pro hlavičku UI. */
export function combineAxes(
    nutrition: AxisResult<NutrientCheck>,
    safety: AxisResult<SafetyRisk>
): DietAssessment {
    const vaha: Record<AssessmentLevel, number> = {
        NEVHODNA: 0,
        ORIENTACNI: 1,
        KONTROLOVANA: 2,
    };
    const overall = vaha[nutrition.level] <= vaha[safety.level] ? nutrition.level : safety.level;
    return { nutrition, safety, overall };
}
