/** Deklarovaný podíl kostí v popisu (nález Hrubý pan Ušák, 2026-09-25). */
import { describe, expect, it } from 'vitest';
import { declaredBonePct } from '../../src/adapters/tutani-catalog/parseComposition.js';

describe('declaredBonePct', () => {
    it('skutečný popis Hrubého pana Ušáka → 70 %', () => {
        expect(declaredBonePct(
            'Barf Hrubý pan Ušák nabízí přirozený zdroj výživy pro psy ve formě mletého králičího masa. ' +
            'Balení o hmotnosti 1kg obsahuje cca 70 % kostí a chrupavky pro vyváženou stravu.'
        )).toBe(70);
    });
    it('„40% mleté kosti" → 40', () => expect(declaredBonePct('složení: 60% maso, 40% mleté kosti')).toBe(40));
    it('chrupavka se počítá jako kost', () => expect(declaredBonePct('obsahuje 55 % chrupavky')).toBe(55));
    it('bez procenta kostí → null', () => {
        expect(declaredBonePct('Velmi libový, 5–8 % tuku, bílkoviny kolem 20 %')).toBeNull();
        expect(declaredBonePct('bezpečný zdroj vápníku bez rizika celé kosti')).toBeNull();
        expect(declaredBonePct(null)).toBeNull();
    });
});
