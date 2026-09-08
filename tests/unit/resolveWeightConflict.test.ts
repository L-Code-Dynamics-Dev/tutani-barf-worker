/**
 * Testy řešení rozporu v gramáži cenou za kg.
 *
 * Reálné případy z katalogu Tutani (dry-run 2026-09-08) — nikoli
 * vymyšlená data. Cílem je, aby produkt v rozporu ZŮSTAL
 * v doporučeních, když ho lze rozhodnout, a vypadl jen tehdy, když
 * ani jedna varianta nedává smysl.
 */

import { describe, expect, it } from 'vitest';
import {
    medianPricePerKg,
    resolveWeightConflict,
} from '../../src/adapters/tutani-catalog/resolveWeightConflict.js';
import type { ScrapedProduct } from '../../src/adapters/tutani-catalog/parseProductPage.js';

function product(over: Partial<ScrapedProduct> = {}): ScrapedProduct {
    return {
        sku: 'X1',
        name: 'Testovací produkt 1kg',
        url: 'https://obchod.tutani.cz/x/1',
        productId: '1',
        guid: null,
        priceWithVat: 100,
        packGrams: 1000,
        packGramsSource: 'DATALAYER',
        packGramsConflict: null,
        stockQuantity: 5,
        categoryPath: 'Barf mražené maso',
        manufacturer: null,
        hasVariants: false,
        compositionText: null,
        params: {},
        ...over,
    };
}

describe('medián ceny za kg', () => {
    it('počítá se jen z produktů bez konfliktu', () => {
        const products = [
            product({ sku: 'A', priceWithVat: 100, packGrams: 1000 }), // 100 Kč/kg
            product({ sku: 'B', priceWithVat: 200, packGrams: 1000 }), // 200 Kč/kg
            // konfliktní produkt do mediánu nesmí — zkreslil by hranice
            product({
                sku: 'C',
                priceWithVat: 50,
                packGrams: 5000,
                packGramsConflict: { authoritative: 5000, fromName: 1000 },
            }),
        ];
        const m = medianPricePerKg(products, () => 'MUSCLE', 'MUSCLE');
        expect(m).toBe(150);
    });

    it('bez použitelných produktů vrací null', () => {
        expect(medianPricePerKg([], () => 'MUSCLE', 'MUSCLE')).toBeNull();
    });
});

describe('reálné konflikty z katalogu Tutani', () => {
    // medián MUSCLE naměřený na katalogu: 147 Kč/kg
    const MEDIAN_MUSCLE = 147;
    // medián PLANT: 204 Kč/kg
    const MEDIAN_PLANT = 204;

    it('ZP12 vemínko: admin 5 kg by dal 10 Kč/kg → vyhrává název', () => {
        const p = product({
            sku: 'ZP12',
            name: 'Krájené vemínko 1kg',
            priceWithVat: 50,
            packGrams: 5000,
            packGramsConflict: { authoritative: 5000, fromName: 1000 },
        });
        const d = resolveWeightConflict(p, MEDIAN_MUSCLE);
        expect(d.kind).toBe('RESOLVED');
        if (d.kind !== 'RESOLVED') return;
        expect(d.grams).toBe(1000);
        expect(d.source).toBe('NAME');
        expect(Math.round(d.pricePerKg)).toBe(50);
    });

    it('TUT117 směs 3kg: admin 1 kg by dal 144 Kč/kg → vyhrává název', () => {
        const p = product({
            sku: 'TUT117',
            name: 'Barf Směs paní Krocanové 3kg',
            priceWithVat: 144,
            packGrams: 1000,
            packGramsConflict: { authoritative: 1000, fromName: 3000 },
        });
        const d = resolveWeightConflict(p, MEDIAN_MUSCLE);
        expect(d.kind).toBe('RESOLVED');
        if (d.kind !== 'RESOLVED') return;
        expect(d.grams).toBe(3000);
        expect(Math.round(d.pricePerKg)).toBe(48);
    });

    it('TUT196 mrkev: admin 100 g by dal 390 Kč/kg → vyhrává název', () => {
        const p = product({
            sku: 'TUT196',
            name: 'Barf Mrkev 500g',
            priceWithVat: 39,
            packGrams: 100,
            packGramsConflict: { authoritative: 100, fromName: 500 },
        });
        const d = resolveWeightConflict(p, MEDIAN_PLANT);
        expect(d.kind).toBe('RESOLVED');
        if (d.kind !== 'RESOLVED') return;
        expect(d.grams).toBe(500);
        expect(Math.round(d.pricePerKg)).toBe(78);
    });

    it('žádný z 26 reálných konfliktů se nevyřazuje', () => {
        // Vzorek napříč skupinami; plný běh ověřen skriptem (26/26).
        const cases: [ScrapedProduct, number][] = [
            [product({ sku: 'ZP28', name: 'Dršťky zelené 2 kg', priceWithVat: 104, packGrams: 1000, packGramsConflict: { authoritative: 1000, fromName: 2000 } }), 122],
            [product({ sku: 'TUT38', name: 'Barf Krůtí bachory 500g', priceWithVat: 110, packGrams: 1000, packGramsConflict: { authoritative: 1000, fromName: 500 } }), 122],
            [product({ sku: 'TUT203', name: 'Barf Chrupavka paní Vysoké 500g', priceWithVat: 64, packGrams: 1000, packGramsConflict: { authoritative: 1000, fromName: 500 } }), 76],
            [product({ sku: 'TUT200', name: 'Barf Červená Řepa 500g', priceWithVat: 44, packGrams: 100, packGramsConflict: { authoritative: 100, fromName: 500 } }), 204],
        ];
        for (const [p, median] of cases) {
            expect(resolveWeightConflict(p, median).kind, p.sku).toBe('RESOLVED');
        }
    });
});

describe('kdy se produkt naopak nedoporučí', () => {
    it('ani jedna varianta cenově neobstojí → UNRESOLVED', () => {
        const p = product({
            sku: 'BAD',
            name: 'Nesmysl 10kg',
            priceWithVat: 100_000, // 10 000 resp. 100 000 Kč/kg
            packGrams: 1000,
            packGramsConflict: { authoritative: 1000, fromName: 10_000 },
        });
        const d = resolveWeightConflict(p, 147);
        expect(d.kind).toBe('UNRESOLVED');
    });

    it('chybí cena → nerozhoduje se, produkt jde do reportu', () => {
        const p = product({
            priceWithVat: null,
            packGramsConflict: { authoritative: 1000, fromName: 500 },
        });
        expect(resolveWeightConflict(p, 147).kind).toBe('UNRESOLVED');
    });

    it('pro skupinu není medián → nehádá se', () => {
        const p = product({ packGramsConflict: { authoritative: 1000, fromName: 500 } });
        expect(resolveWeightConflict(p, null).kind).toBe('UNRESOLVED');
    });

    it('chybí gramáž úplně → UNRESOLVED (nehádá se)', () => {
        const p = product({ packGrams: null, packGramsSource: null });
        expect(resolveWeightConflict(p, 147).kind).toBe('UNRESOLVED');
    });
});

describe('produkt bez konfliktu', () => {
    it('projde bez rozhodování', () => {
        const d = resolveWeightConflict(product(), 147);
        expect(d.kind).toBe('NO_CONFLICT');
        if (d.kind !== 'NO_CONFLICT') return;
        expect(d.grams).toBe(1000);
    });
});
