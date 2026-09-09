/**
 * Testy energetické potřeby (RER/MER).
 *
 * Referenční hodnoty ze znalostní báze, bod 69 — `RER = 70 × kg^0.75`.
 */

import { describe, expect, it } from 'vitest';
import { calculateEnergy, calculateRER, type EnergyInput } from '../../src/domain/nutrition/energy.js';

const pes = (o: Partial<EnergyInput> = {}): EnergyInput => ({
    weightKg: 20, lifeStage: 'ADULT', activity: 'MEDIUM',
    bodyCondition: 'IDEAL', physiologicalState: 'NONE', neutered: false, ...o,
});

describe('RER podle referenční tabulky (bod 69)', () => {
    it.each([[5, 234], [10, 394], [20, 662], [30, 897], [40, 1115]])(
        '%i kg → ~%i kcal',
        (kg, ocek) => {
            // Tolerance 3 kcal: tabulka je zaokrouhlená, ne přesná.
            expect(Math.abs(calculateRER(kg) - ocek)).toBeLessThanOrEqual(3);
        }
    );

    it('nesmyslná hmotnost dá 0, ne NaN ani výjimku', () => {
        for (const w of [0, -5, NaN, Infinity]) expect(calculateRER(w)).toBe(0);
    });
});

describe('bod 73: stejná hmotnost, jiná potřeba', () => {
    it('senior kastrovaný s nadváhou vs. mladý pracovní pes', () => {
        const a = calculateEnergy(pes({
            weightKg: 20, idealWeightKg: 16, lifeStage: 'SENIOR',
            activity: 'LOW', bodyCondition: 'OVER', neutered: true,
        }));
        const b = calculateEnergy(pes({ activity: 'WORKING' }));

        // Rozdíl musí být násobný — jinak by procento z hmotnosti stačilo.
        expect(b.merKcal / a.merKcal).toBeGreaterThan(2);
    });

    it('redukční dieta se počítá z IDEÁLNÍ hmotnosti (bod 82)', () => {
        const r = calculateEnergy(pes({ weightKg: 30, idealWeightKg: 24, bodyCondition: 'OVER' }));
        expect(r.baseWeightSource).toBe('IDEAL');
        expect(r.baseWeightKg).toBe(24);
    });

    it('bez ideální hmotnosti se použije aktuální — NEHÁDÁ se', () => {
        const r = calculateEnergy(pes({ weightKg: 30, bodyCondition: 'OVER' }));
        expect(r.baseWeightSource).toBe('ACTUAL');
    });
});

describe('vrací ROZMEZÍ, ne jedno číslo (bod 69)', () => {
    it('MER má min i max a min ≤ max', () => {
        const r = calculateEnergy(pes());
        expect(r.merMinKcal).toBeLessThanOrEqual(r.merMaxKcal);
        expect(r.merKcal).toBeGreaterThanOrEqual(r.merMinKcal);
        expect(r.merKcal).toBeLessThanOrEqual(r.merMaxKcal);
    });

    it('poznámka upozorní, že RER není denní dávka', () => {
        const r = calculateEnergy(pes());
        expect(r.noteCs).toContain('RER');
        expect(r.noteCs.toLowerCase()).toContain('skutečná');
    });

    it('každý koeficient nese ZDROJ (oprava nálezu auditu)', () => {
        const r = calculateEnergy(pes({ activity: 'HIGH', neutered: true }));
        expect(r.factors.length).toBeGreaterThan(1);
        for (const f of r.factors) {
            expect(f.source, f.reasonCs).toBeTruthy();
            expect(f.reasonCs).toBeTruthy();
        }
    });
});

describe('fyziologický stav', () => {
    it('laktace zvýší potřebu výrazně (bod 86)', () => {
        const norm = calculateEnergy(pes());
        const lakt = calculateEnergy(pes({ physiologicalState: 'LACTATING' }));
        expect(lakt.merMaxKcal).toBeGreaterThan(norm.merMaxKcal * 1.5);
    });

    it('březost zvýší potřebu, ale méně než laktace', () => {
        const brez = calculateEnergy(pes({ physiologicalState: 'PREGNANT' }));
        const lakt = calculateEnergy(pes({ physiologicalState: 'LACTATING' }));
        expect(brez.merKcal).toBeLessThan(lakt.merKcal);
        expect(brez.merKcal).toBeGreaterThan(calculateEnergy(pes()).merKcal);
    });

    it('u štěněte se aktivita ani kastrace nepřičítá — rozhoduje růst', () => {
        const a = calculateEnergy(pes({ lifeStage: 'PUPPY_0_6', activity: 'LOW' }));
        const b = calculateEnergy(pes({ lifeStage: 'PUPPY_0_6', activity: 'WORKING' }));
        expect(a.merKcal).toBe(b.merKcal);
    });
});

describe('bezpečnostní hranice', () => {
    it('nikdy nejde pod klidovou potřebu — hladovění není dieta', () => {
        // Nejnižší možná kombinace: senior, nízká aktivita, kastrovaný.
        const r = calculateEnergy(pes({
            lifeStage: 'SENIOR', activity: 'LOW', neutered: true,
            bodyCondition: 'OVER', idealWeightKg: 16,
        }));
        expect(r.merMinKcal).toBeGreaterThanOrEqual(r.rerKcal);
    });

    it('výpočet je deterministický', () => {
        const a = calculateEnergy(pes({ activity: 'HIGH' }));
        const b = calculateEnergy(pes({ activity: 'HIGH' }));
        expect(a).toEqual(b);
    });
});
