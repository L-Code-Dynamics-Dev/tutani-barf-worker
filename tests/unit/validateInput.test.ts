/**
 * Testy validace vstupu.
 *
 * Ověřuje to, co má zdravotní dopad: rozsahy, povinná ideální hmotnost
 * u nadváhy, odmítnutí neznámých hodnot a to, že se NIC NEDOPOČÍTÁVÁ
 * (R7). Chybové kódy, ne texty.
 */

import { describe, expect, it } from 'vitest';
import { validateDoseRequest, type ValidationCode } from '../../src/api/validateInput.js';

const DEFAULT_PERIOD = 30;

/** Validní požadavek — základ, ze kterého se odvozují vadné varianty. */
function validBody(over: Record<string, unknown> = {}, dogOver: Record<string, unknown> = {}) {
    return {
        pes: {
            jmeno: 'Rex',
            hmotnostKg: 24,
            vekMesicu: 36,
            pohlavi: 'MALE',
            kastrovany: false,
            aktivita: 'MEDIUM',
            kondice: 'IDEAL',
            fyziologickyStav: 'NONE',
            diagnozy: [],
            alergie: [],
            ...dogOver,
        },
        ...over,
    };
}

/** Kódy chyb u daného pole — testy tvrdí kód, ne text. */
function codesFor(result: ReturnType<typeof validateDoseRequest>, field: string): ValidationCode[] {
    if (result.ok) return [];
    return result.issues.filter((i) => i.field === field).map((i) => i.code);
}

describe('validateDoseRequest — validní vstup', () => {
    it('projde a vrátí kanonický profil', () => {
        const r = validateDoseRequest(validBody(), DEFAULT_PERIOD);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.dog.weightKg).toBe(24);
        expect(r.value.dog.ageMonths).toBe(36);
        expect(r.value.dog.activity).toBe('MEDIUM');
        expect(r.value.dog.name).toBe('Rex');
        // Období se bere z konfigurace tenanta, ne z konstanty v kódu.
        expect(r.value.periodDays).toBe(DEFAULT_PERIOD);
    });

    it('respektuje zadané období', () => {
        const r = validateDoseRequest(validBody({ obdobiDni: 7 }), DEFAULT_PERIOD);
        expect(r.ok && r.value.periodDays).toBe(7);
    });

    it('chybějící `kastrovany` bere jako false — bezpečná strana', () => {
        const body = validBody();
        delete (body.pes as Record<string, unknown>).kastrovany;
        const r = validateDoseRequest(body, DEFAULT_PERIOD);
        expect(r.ok && r.value.dog.neutered).toBe(false);
    });

    it('chybějící seznamy diagnóz a alergií jsou prázdné, ne chyba', () => {
        const body = validBody();
        delete (body.pes as Record<string, unknown>).diagnozy;
        delete (body.pes as Record<string, unknown>).alergie;
        const r = validateDoseRequest(body, DEFAULT_PERIOD);
        expect(r.ok).toBe(true);
        if (!r.ok) return;
        expect(r.value.dog.conditionIds).toEqual([]);
        expect(r.value.dog.allergyIngredientIds).toEqual([]);
    });

    it('normalizuje a odduplikuje id diagnóz', () => {
        const r = validateDoseRequest(
            validBody({}, { diagnozy: ['CKD', 'ckd', ' ckd '] }),
            DEFAULT_PERIOD
        );
        expect(r.ok && r.value.dog.conditionIds).toEqual(['ckd']);
    });
});

describe('validateDoseRequest — nadváha vyžaduje ideální hmotnost', () => {
    it('OVER bez ideální hmotnosti se ODMÍTNE (nedopočítává se)', () => {
        const r = validateDoseRequest(validBody({}, { kondice: 'OVER' }), DEFAULT_PERIOD);
        expect(r.ok).toBe(false);
        expect(codesFor(r, 'pes.idealniHmotnostKg')).toContain('MISSING_IDEAL_WEIGHT');
    });

    it('OVER s ideální hmotnostní projde', () => {
        const r = validateDoseRequest(
            validBody({}, { kondice: 'OVER', idealniHmotnostKg: 20 }),
            DEFAULT_PERIOD
        );
        expect(r.ok).toBe(true);
        expect(r.ok && r.value.dog.idealWeightKg).toBe(20);
    });

    it('ideální hmotnost >= aktuální u nadváhy je rozpor ve vstupu', () => {
        const r = validateDoseRequest(
            validBody({}, { kondice: 'OVER', idealniHmotnostKg: 24 }),
            DEFAULT_PERIOD
        );
        expect(codesFor(r, 'pes.idealniHmotnostKg')).toContain('IDEAL_WEIGHT_NOT_LOWER');
    });

    it('u IDEAL kondice se ideální hmotnost nevyžaduje', () => {
        const r = validateDoseRequest(validBody({}, { kondice: 'IDEAL' }), DEFAULT_PERIOD);
        expect(r.ok).toBe(true);
    });
});

describe('validateDoseRequest — rozsahy', () => {
    it.each([
        [0.4, 'pod minimem'],
        [0, 'nula'],
        [101, 'nad maximem'],
        [-5, 'negativní'],
    ])('hmotnost %s kg (%s) se odmítne', (weight) => {
        const r = validateDoseRequest(validBody({}, { hmotnostKg: weight }), DEFAULT_PERIOD);
        expect(codesFor(r, 'pes.hmotnostKg')).toContain('OUT_OF_RANGE');
    });

    it.each([0.5, 24, 100])('hmotnost %s kg projde', (weight) => {
        const r = validateDoseRequest(validBody({}, { hmotnostKg: weight }), DEFAULT_PERIOD);
        expect(r.ok).toBe(true);
    });

    it('věk 0 měsíců projde (novorozené štěně)', () => {
        const r = validateDoseRequest(validBody({}, { vekMesicu: 0 }), DEFAULT_PERIOD);
        expect(r.ok).toBe(true);
    });

    it('věk 301 měsíců se odmítne', () => {
        const r = validateDoseRequest(validBody({}, { vekMesicu: 301 }), DEFAULT_PERIOD);
        expect(codesFor(r, 'pes.vekMesicu')).toContain('OUT_OF_RANGE');
    });

    it('období nad 90 dní se odmítne (trvanlivost mraženého masa)', () => {
        const r = validateDoseRequest(validBody({ obdobiDni: 120 }), DEFAULT_PERIOD);
        expect(codesFor(r, 'obdobiDni')).toContain('OUT_OF_RANGE');
    });

    it('neceločíselné období se odmítne', () => {
        const r = validateDoseRequest(validBody({ obdobiDni: 7.5 }), DEFAULT_PERIOD);
        expect(codesFor(r, 'obdobiDni')).toContain('OUT_OF_RANGE');
    });
});

describe('validateDoseRequest — typy a enumy', () => {
    it('neznámá hodnota enumu se ODMÍTNE, nemapuje se na default', () => {
        const r = validateDoseRequest(validBody({}, { aktivita: 'EXTREME' }), DEFAULT_PERIOD);
        expect(codesFor(r, 'pes.aktivita')).toContain('UNKNOWN_ENUM_VALUE');
    });

    it('u neznámého enumu se vrátí povolené hodnoty pro UI', () => {
        const r = validateDoseRequest(validBody({}, { kondice: 'FAT' }), DEFAULT_PERIOD);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        const issue = r.issues.find((i) => i.field === 'pes.kondice');
        expect(issue?.allowed).toEqual(['UNDER', 'IDEAL', 'OVER']);
    });

    it.each([
        ['pohlavi', 'PES'],          // český tvar z návrhu kontraktu není kanonický enum
        ['fyziologickyStav', 'TEHOTNA'],
    ])('neznámá hodnota `%s` se odmítne', (field, value) => {
        const r = validateDoseRequest(validBody({}, { [field]: value }), DEFAULT_PERIOD);
        expect(codesFor(r, `pes.${field}`)).toContain('UNKNOWN_ENUM_VALUE');
    });

    it('hmotnost jako řetězec se NEPŘEVÁDÍ — tichá konverze je cesta k chybě', () => {
        const r = validateDoseRequest(validBody({}, { hmotnostKg: '24' }), DEFAULT_PERIOD);
        expect(codesFor(r, 'pes.hmotnostKg')).toContain('NOT_A_NUMBER');
    });

    it('NaN se odmítne', () => {
        const r = validateDoseRequest(validBody({}, { hmotnostKg: NaN }), DEFAULT_PERIOD);
        expect(codesFor(r, 'pes.hmotnostKg')).toContain('NOT_A_NUMBER');
    });

    it('chybějící povinné pole hlásí REQUIRED', () => {
        const body = validBody();
        delete (body.pes as Record<string, unknown>).hmotnostKg;
        const r = validateDoseRequest(body, DEFAULT_PERIOD);
        expect(codesFor(r, 'pes.hmotnostKg')).toContain('REQUIRED');
    });

    it('`kastrovany` jako řetězec se odmítne', () => {
        const r = validateDoseRequest(validBody({}, { kastrovany: 'ano' }), DEFAULT_PERIOD);
        expect(codesFor(r, 'pes.kastrovany')).toContain('NOT_A_BOOLEAN');
    });
});

describe('validateDoseRequest — tvar požadavku', () => {
    it.each([[null], ['text'], [42], [[]]])('tělo %s není objekt', (body) => {
        const r = validateDoseRequest(body, DEFAULT_PERIOD);
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.issues[0].code).toBe('BODY_NOT_JSON');
    });

    it('chybějící `pes` hlásí MISSING_DOG', () => {
        const r = validateDoseRequest({ obdobiDni: 30 }, DEFAULT_PERIOD);
        expect(codesFor(r, 'pes')).toContain('MISSING_DOG');
    });

    it('vrací VŠECHNY chyby, ne jen první', () => {
        const r = validateDoseRequest(
            validBody({}, { hmotnostKg: 500, vekMesicu: -1, aktivita: 'XX' }),
            DEFAULT_PERIOD
        );
        expect(r.ok).toBe(false);
        if (r.ok) return;
        expect(r.issues.length).toBeGreaterThanOrEqual(3);
    });
});

describe('validateDoseRequest — seznamy id', () => {
    it('nevalidní formát id se odmítne', () => {
        const r = validateDoseRequest(
            validBody({}, { alergie: ['kure', 'DROP TABLE products'] }),
            DEFAULT_PERIOD
        );
        expect(codesFor(r, 'pes.alergie[1]')).toContain('INVALID_ID_FORMAT');
    });

    it('diagnózy jako objekt místo pole se odmítnou', () => {
        const r = validateDoseRequest(validBody({}, { diagnozy: { ckd: true } }), DEFAULT_PERIOD);
        expect(codesFor(r, 'pes.diagnozy')).toContain('NOT_AN_ARRAY');
    });

    it('nafouknutý seznam alergií se odmítne', () => {
        const many = Array.from({ length: 40 }, (_, i) => `alergen-${i}`);
        const r = validateDoseRequest(validBody({}, { alergie: many }), DEFAULT_PERIOD);
        expect(codesFor(r, 'pes.alergie')).toContain('TOO_MANY_ITEMS');
    });

    it('nečíselný prvek v seznamu se odmítne', () => {
        const r = validateDoseRequest(validBody({}, { diagnozy: [123] }), DEFAULT_PERIOD);
        expect(codesFor(r, 'pes.diagnozy[0]')).toContain('NOT_A_STRING');
    });
});
