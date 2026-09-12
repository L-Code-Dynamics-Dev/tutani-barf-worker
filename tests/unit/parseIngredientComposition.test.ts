/**
 * Testy rozkladu produktu na part-level suroviny.
 *
 * Reálné texty složení z katalogu Tutani (Lucky 2026-09-09) — TUT175,
 * TUT155, TUT223, TUT58. Cílem je ověřit R7: kde Tutani neuvedl poměr,
 * výsledek je PARTIAL s `percentage: null`, NIKDY dopočtená rovnoměrná
 * hodnota.
 */

import { describe, expect, it } from 'vitest';
import { parseIngredientComposition } from '../../src/domain/barf/parseIngredientComposition.js';

describe('parseIngredientComposition — EXACT rozpad', () => {
    it('TUT175: 40 % plíce / 30 % ledviny / 30 % játra — všechny EXACT', () => {
        const { composition } = parseIngredientComposition(
            'Složení: 40% hovězí plíce, 30% hovězí ledviny, 30% hovězí játra'
        );
        expect(composition).toHaveLength(3);
        expect(composition.every((c) => c.certainty === 'EXACT')).toBe(true);
        expect(composition.every((c) => c.percentage !== null)).toBe(true);

        const jatra = composition.find((c) => c.nameCs.includes('játra'));
        expect(jatra?.ingredientId).toBe('hovezi-jatra');
        expect(jatra?.percentage).toBe(30);

        const soucet = composition.reduce((s, c) => s + (c.percentage ?? 0), 0);
        expect(soucet).toBeCloseTo(100, 0);
    });

    it('součet EXACT procent mimo toleranci se zahodí (nesprávný rozpad je horší než žádný)', () => {
        // Součet 40+40+40=120 přesahuje TOLERANCE_PCT (12) o víc než je únosné.
        const { composition } = parseIngredientComposition(
            'Složení: 40% hovězí plíce, 40% hovězí ledviny, 40% hovězí játra'
        );
        // Krok 2 (PARTIAL fallback) se spustí, protože EXACT nedává ~100 %.
        expect(composition.every((c) => c.percentage === null)).toBe(true);
    });
});

describe('parseIngredientComposition — PARTIAL (poměr chybí)', () => {
    it('TUT155: ledviny, plíce, játra bez procent — všechny PARTIAL, žádný dopočet', () => {
        const { composition } = parseIngredientComposition(
            'Složení: hovězí ledviny, hovězí plíce, hovězí játra'
        );
        expect(composition.length).toBeGreaterThan(0);
        expect(composition.every((c) => c.certainty === 'PARTIAL')).toBe(true);
        expect(composition.every((c) => c.percentage === null)).toBe(true);
    });
});

describe('parseIngredientComposition — INGREDIENT_GROUP (skupina bez vnitřního poměru)', () => {
    it('TUT223: 50 % maso / 50 % zelenina (mrkev, petržel, celer) — skupina EXACT, subcomponents UNKNOWN', () => {
        const { composition } = parseIngredientComposition(
            'Složení: 50% hovězí maso, 50% zelenina (mrkev, petržel, celer)'
        );
        const zelenina = composition.find((c) => c.role === 'INGREDIENT_GROUP');
        expect(zelenina).toBeDefined();
        expect(zelenina?.percentage).toBe(50);
        expect(zelenina?.certainty).toBe('EXACT');
        expect(zelenina?.subcomponentRatio).toBe('UNKNOWN');
        expect(zelenina?.subcomponentsCs.length).toBeGreaterThanOrEqual(3);

        const maso = composition.find((c) => c.role === 'INGREDIENT');
        expect(maso?.percentage).toBe(50);
        expect(maso?.certainty).toBe('EXACT');
    });
});

describe('parseIngredientComposition — explicitní nepřítomnost', () => {
    it('TUT58: "100 % krůta, bez vnitřností" zapíše absent jako fakt, ne mlčení', () => {
        const { absent } = parseIngredientComposition(
            'Složení: 100% krůta (svalovina, kosti, kůže, chrupavka), bez vnitřností'
        );
        expect(absent.some((a) => a.part === 'SECRETORY_OTHER')).toBe(true);
    });
});

describe('parseIngredientComposition — žádné rozpoznatelné suroviny', () => {
    it('vrací prázdné composition, když text nic neobsahuje', () => {
        const { composition, absent } = parseIngredientComposition('Skladem, expedice do 2 dnů.');
        expect(composition).toHaveLength(0);
        expect(absent).toHaveLength(0);
    });

    it('vrací prázdné composition u null/undefined vstupu', () => {
        expect(parseIngredientComposition(null).composition).toHaveLength(0);
        expect(parseIngredientComposition(undefined).composition).toHaveLength(0);
    });
});
