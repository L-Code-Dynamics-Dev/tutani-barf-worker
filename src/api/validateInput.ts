/**
 * Validace vstupu `POST /v1/davka`.
 *
 * PROČ NA WORKERU (R3): frontend validaci obejde kdokoli s konzolí.
 * Dávka je zdravotní doporučení — vstup, který by dal nesmyslnou
 * dávku, se nesmí dostat do výpočtu.
 *
 * CHYBOVÉ KÓDY, NE TEXTY (Lucky): odpověď nese `code` + `field`.
 * Frontend si k nim drží překlady sám a nikdy neparsuje český text —
 * jinak by přeformulování hlášky rozbilo UI.
 *
 * NEHÁDÁ SE (R7): chybí-li povinný údaj, vstup se ODMÍTNE. Nikde tady
 * není default, který by za majitele něco dovodil — jediné výjimky
 * jsou `obdobiDni` (převzato z konfigurace tenanta) a `kastrovany`
 * (viz komentář u pole).
 */

import type {
    ActivityLevel,
    BodyCondition,
    DogProfile,
    PhysiologicalState,
    Sex,
} from '../domain/dog/DogProfile.js';

/**
 * Kód chyby. Rozšiřitelný výčet — nový kód znamená nový překlad v UI,
 * ne parsování.
 */
export type ValidationCode =
    | 'BODY_NOT_JSON'          // tělo požadavku není JSON objekt
    | 'MISSING_DOG'            // chybí `pes`
    | 'REQUIRED'               // povinné pole chybí nebo je null
    | 'NOT_A_NUMBER'           // není číslo (nebo je NaN/Infinity)
    | 'OUT_OF_RANGE'           // mimo povolený rozsah
    | 'NOT_A_BOOLEAN'
    | 'NOT_A_STRING'
    | 'NOT_AN_ARRAY'
    | 'UNKNOWN_ENUM_VALUE'     // hodnota není v povoleném výčtu
    | 'MISSING_IDEAL_WEIGHT'   // nadváha bez ideální hmotnosti
    | 'IDEAL_WEIGHT_NOT_LOWER' // ideální hmotnost není nižší než aktuální
    | 'TOO_MANY_ITEMS'         // seznam diagnóz/alergií mimo rozumnou mez
    | 'INVALID_ID_FORMAT';     // id diagnózy/suroviny má nepovolené znaky

export interface ValidationIssue {
    /** Cesta k poli v požadavku, např. `pes.hmotnostKg`. */
    field: string;
    code: ValidationCode;
    /** Povolený rozsah nebo výčet — UI z toho postaví hlášku. */
    allowed?: readonly (string | number)[];
    min?: number;
    max?: number;
}

export interface ValidatedRequest {
    dog: DogProfile;
    periodDays: number;
}

export type ValidationResult =
    | { ok: true; value: ValidatedRequest }
    | { ok: false; issues: ValidationIssue[] };

/**
 * Rozsahy. Vědomě široké — cílem je vyloučit nesmysl a překlep
 * (2,4 kg vs. 24 kg), ne posuzovat, jestli pes existuje.
 *
 * 0,5 kg = čivava/štěně, 100 kg = anglická mastif. 300 měsíců = 25 let,
 * nad tím jde o chybu zadání.
 */
const WEIGHT_MIN_KG = 0.5;
const WEIGHT_MAX_KG = 100;
const AGE_MIN_MONTHS = 0;
const AGE_MAX_MONTHS = 300;

/**
 * Období nákupu. 1 den kvůli zkušebnímu nákupu, 90 dní je horní hranice
 * daná kapacitou mrazáku a trvanlivostí mraženého masa.
 */
const PERIOD_MIN_DAYS = 1;
const PERIOD_MAX_DAYS = 90;

/** Ochrana proti nafouknutému požadavku — reálný pes nemá 50 diagnóz. */
const MAX_CONDITION_IDS = 20;
const MAX_ALLERGY_IDS = 30;

/** Jméno psa se jen zobrazuje; delší text je pokus o zneužití pole. */
const MAX_NAME_LENGTH = 40;

const SEXES = ['MALE', 'FEMALE'] as const satisfies readonly Sex[];
const ACTIVITIES = ['LOW', 'MEDIUM', 'HIGH', 'WORKING'] as const satisfies readonly ActivityLevel[];
const BODY_CONDITIONS = ['UNDER', 'IDEAL', 'OVER'] as const satisfies readonly BodyCondition[];
const PHYSIOLOGICAL_STATES = [
    'NONE',
    'PREGNANT',
    'LACTATING',
    'RECOVERY',
] as const satisfies readonly PhysiologicalState[];

/**
 * Id diagnózy nebo suroviny. Jen malá písmena, číslice a pomlčka —
 * odpovídá `conditions.id` a `ingredients.id`. Zároveň to uzavírá
 * dveře pokusům protlačit tímhle polem cokoli jiného.
 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,49}$/;

/**
 * Zvaliduje tělo požadavku.
 *
 * Vrací VŠECHNY nalezené chyby, ne první — majitel má vidět celý
 * formulář najednou, ne opravovat pole po poli.
 *
 * `defaultPeriodDays` přichází z konfigurace tenanta (R4), ne
 * z konstanty v kódu.
 */
export function validateDoseRequest(body: unknown, defaultPeriodDays: number): ValidationResult {
    const issues: ValidationIssue[] = [];

    if (!isPlainObject(body)) {
        return { ok: false, issues: [{ field: '', code: 'BODY_NOT_JSON' }] };
    }

    const rawDog = body.pes;
    if (!isPlainObject(rawDog)) {
        return { ok: false, issues: [{ field: 'pes', code: 'MISSING_DOG' }] };
    }

    // ---- ČÍSELNÉ ÚDAJE ----
    const weightKg = num(rawDog.hmotnostKg, 'pes.hmotnostKg', WEIGHT_MIN_KG, WEIGHT_MAX_KG, issues);
    const ageMonths = num(rawDog.vekMesicu, 'pes.vekMesicu', AGE_MIN_MONTHS, AGE_MAX_MONTHS, issues);

    // Ideální hmotnost je volitelná — povinnost se váže na kondici,
    // vyhodnocuje se níž, až je známá kondice.
    let idealWeightKg: number | undefined;
    if (rawDog.idealniHmotnostKg !== undefined && rawDog.idealniHmotnostKg !== null) {
        const v = num(
            rawDog.idealniHmotnostKg,
            'pes.idealniHmotnostKg',
            WEIGHT_MIN_KG,
            WEIGHT_MAX_KG,
            issues
        );
        if (v !== null) idealWeightKg = v;
    }

    // ---- ENUMY ----
    const sex = enumValue<Sex>(rawDog.pohlavi, 'pes.pohlavi', SEXES, issues);
    const activity = enumValue<ActivityLevel>(rawDog.aktivita, 'pes.aktivita', ACTIVITIES, issues);
    const bodyCondition = enumValue<BodyCondition>(
        rawDog.kondice,
        'pes.kondice',
        BODY_CONDITIONS,
        issues
    );
    const physiologicalState = enumValue<PhysiologicalState>(
        rawDog.fyziologickyStav,
        'pes.fyziologickyStav',
        PHYSIOLOGICAL_STATES,
        issues
    );

    /**
     * `kastrovany` je JEDINÝ údaj s defaultem: chybí-li, bere se `false`.
     * Je to bezpečná strana — nekastrovaný pes má vyšší pásmo, takže
     * default nikdy nevede k PODhodnocené dávce u kastrovaného. Naopak
     * by to byl problém.
     */
    let neutered = false;
    if (rawDog.kastrovany !== undefined && rawDog.kastrovany !== null) {
        if (typeof rawDog.kastrovany !== 'boolean') {
            issues.push({ field: 'pes.kastrovany', code: 'NOT_A_BOOLEAN' });
        } else {
            neutered = rawDog.kastrovany;
        }
    }

    // ---- JMÉNO (jen zobrazení) ----
    let name: string | undefined;
    if (rawDog.jmeno !== undefined && rawDog.jmeno !== null) {
        if (typeof rawDog.jmeno !== 'string') {
            issues.push({ field: 'pes.jmeno', code: 'NOT_A_STRING' });
        } else {
            const trimmed = rawDog.jmeno.trim();
            if (trimmed.length > MAX_NAME_LENGTH) {
                issues.push({
                    field: 'pes.jmeno',
                    code: 'OUT_OF_RANGE',
                    min: 0,
                    max: MAX_NAME_LENGTH,
                });
            } else if (trimmed.length > 0) {
                name = trimmed;
            }
        }
    }

    // ---- SEZNAMY ID ----
    const conditionIds = idList(rawDog.diagnozy, 'pes.diagnozy', MAX_CONDITION_IDS, issues);
    const allergyIngredientIds = idList(rawDog.alergie, 'pes.alergie', MAX_ALLERGY_IDS, issues);

    // ---- OBDOBÍ ----
    let periodDays = defaultPeriodDays;
    if (body.obdobiDni !== undefined && body.obdobiDni !== null) {
        const v = num(body.obdobiDni, 'obdobiDni', PERIOD_MIN_DAYS, PERIOD_MAX_DAYS, issues);
        if (v !== null) {
            if (!Number.isInteger(v)) {
                issues.push({
                    field: 'obdobiDni',
                    code: 'OUT_OF_RANGE',
                    min: PERIOD_MIN_DAYS,
                    max: PERIOD_MAX_DAYS,
                });
            } else {
                periodDays = v;
            }
        }
    }

    /**
     * NADVÁHA VYŽADUJE IDEÁLNÍ HMOTNOST.
     *
     * Bez ní by se redukční dieta počítala z aktuální (nadvážné)
     * hmotnosti a pes by hubnul jen náhodou. Systém ideální hmotnost
     * NEODHADUJE — je to veterinární údaj.
     */
    if (bodyCondition === 'OVER' && idealWeightKg === undefined) {
        issues.push({ field: 'pes.idealniHmotnostKg', code: 'MISSING_IDEAL_WEIGHT' });
    }

    /**
     * Ideální hmotnost vyšší než aktuální u psa s nadváhou je vnitřní
     * rozpor ve vstupu — buď je špatná kondice, nebo hmotnost. Nehádá se
     * která (R7).
     */
    if (
        bodyCondition === 'OVER' &&
        idealWeightKg !== undefined &&
        weightKg !== null &&
        idealWeightKg >= weightKg
    ) {
        issues.push({ field: 'pes.idealniHmotnostKg', code: 'IDEAL_WEIGHT_NOT_LOWER' });
    }

    if (issues.length > 0) return { ok: false, issues };

    // Po projití validace jsou všechna povinná pole naplněná; non-null
    // asserce jsou tady bezpečné a jinde v kódu už nejsou potřeba.
    const dog: DogProfile = {
        name,
        weightKg: weightKg!,
        idealWeightKg,
        ageMonths: ageMonths!,
        sex: sex!,
        neutered,
        activity: activity!,
        bodyCondition: bodyCondition!,
        physiologicalState: physiologicalState!,
        conditionIds,
        allergyIngredientIds,
    };

    return { ok: true, value: { dog, periodDays } };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Číslo v rozsahu. Řetězec se ZÁMĚRNĚ nepřevádí — `"24"` z formuláře
 * má opravit frontend, ne tichá konverze na serveru. Tichý převod je
 * cesta k tomu, aby `"24 kg"` prošlo jako 24.
 */
function num(
    v: unknown,
    field: string,
    min: number,
    max: number,
    issues: ValidationIssue[]
): number | null {
    if (v === undefined || v === null) {
        issues.push({ field, code: 'REQUIRED' });
        return null;
    }
    if (typeof v !== 'number' || !Number.isFinite(v)) {
        issues.push({ field, code: 'NOT_A_NUMBER' });
        return null;
    }
    if (v < min || v > max) {
        issues.push({ field, code: 'OUT_OF_RANGE', min, max });
        return null;
    }
    return v;
}

/** Hodnota z výčtu. Neznámá hodnota se ODMÍTNE, nemapuje se na default. */
function enumValue<T extends string>(
    v: unknown,
    field: string,
    allowed: readonly string[],
    issues: ValidationIssue[]
): T | null {
    if (v === undefined || v === null) {
        issues.push({ field, code: 'REQUIRED', allowed });
        return null;
    }
    if (typeof v !== 'string') {
        issues.push({ field, code: 'NOT_A_STRING', allowed });
        return null;
    }
    if (!allowed.includes(v)) {
        issues.push({ field, code: 'UNKNOWN_ENUM_VALUE', allowed });
        return null;
    }
    return v as T;
}

/**
 * Seznam id. Chybějící seznam je prázdný seznam (pes bez diagnóz je
 * normální stav), ale nevalidní PRVEK se odmítne — id, které neznáme,
 * by se v rule enginu tiše ignorovalo a majitel by si myslel, že se
 * s diagnózou počítalo.
 *
 * Duplicity se odstraňují: nemají žádný význam a jen by nafoukly
 * dotaz do rule enginu.
 */
function idList(
    v: unknown,
    field: string,
    maxItems: number,
    issues: ValidationIssue[]
): string[] {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) {
        issues.push({ field, code: 'NOT_AN_ARRAY' });
        return [];
    }
    if (v.length > maxItems) {
        issues.push({ field, code: 'TOO_MANY_ITEMS', min: 0, max: maxItems });
        return [];
    }
    const out: string[] = [];
    for (let i = 0; i < v.length; i++) {
        const item: unknown = v[i];
        if (typeof item !== 'string') {
            issues.push({ field: `${field}[${i}]`, code: 'NOT_A_STRING' });
            continue;
        }
        const id = item.trim().toLowerCase();
        if (!ID_PATTERN.test(id)) {
            issues.push({ field: `${field}[${i}]`, code: 'INVALID_ID_FORMAT' });
            continue;
        }
        if (!out.includes(id)) out.push(id);
    }
    return out;
}
