/**
 * Parser admin XML exportu (`productsComplete.xml`).
 * Fixture je syntetická (repo je veřejné, export má nákupní ceny), tvar
 * i pasti jsou převzaté ze skutečného exportu Tutani 2026-09-24.
 */

import { describe, expect, it } from 'vitest';
import {
    ExportFormatError,
    packageSize,
    parseProductsCompleteXml,
} from '../../src/adapters/shoptet-export/parseProductsCompleteXml.js';
import { buildCompleteXml } from '../helpers/completeXml.js';

const XML = buildCompleteXml([
    { id: '868', name: 'Hovězí svalovina 1kg', code: 'ZP9', stock: 16, amount: '1', unit: 'kg', price: 209, description: '<p>Složení: 100% hovězí svalovina</p>' },
    {
        id: '1066', name: 'Pivovarské kvasnice 500g, 1kg',
        variants: [
            { id: '1754', code: '1066/1 K', stock: 4, amount: '1', unit: 'kg', price: 88, param: '1 kg' },
            { id: '1751', code: '1066/500', stock: 8, amount: '500', unit: 'g', price: 59, param: '500 g' },
        ],
    },
    // Související produkty PŘED vlastním kódem — past z reálného exportu.
    { id: '2880', name: 'Barf Hrubý pan Ušák 1kg', code: 'TUT10', stock: 25, amount: '1', unit: 'kg', related: ['TUT20/1', 'TUT112'] },
    { id: '9', name: 'Skrytý', code: 'HID', stock: 3, amount: '1', unit: 'kg', visibility: 'hidden' },
]);

describe('parseProductsCompleteXml', () => {
    it('productId = SHOPITEM id, u produktu bez variant priceId z XML NENÍ (dodá web)', () => {
        const p = parseProductsCompleteXml(XML).products.find((x) => x.code === 'ZP9')!;
        expect(p.productId).toBe('868');
        expect(p.variantPriceId).toBeNull();
        expect(p.stockQuantity).toBe(16);
        expect(p.packGrams).toBe(1000);
        expect(p.descriptionText).toBe('Složení: 100% hovězí svalovina.');
    });

    it('varianta: priceId = VARIANT id, productId = hlavní produkt, vlastní sklad a gramáž', () => {
        const v = parseProductsCompleteXml(XML).products.filter((x) => x.pairCode === '1066');
        expect(v.map((p) => [p.code, p.productId, p.variantPriceId, p.stockQuantity, p.packGrams, p.variantName])).toEqual([
            ['1066/1 K', '1066', '1754', 4, 1000, 'Pivovarské kvasnice 500g, 1kg: 1 kg'],
            ['1066/500', '1066', '1751', 8, 500, 'Pivovarské kvasnice 500g, 1kg: 500 g'],
        ]);
    });

    it('REGRESE: kód z RELATED_PRODUCTS ani FLAGS se nevezme jako vlastní', () => {
        const codes = parseProductsCompleteXml(XML).products.map((p) => p.code);
        expect(codes).toContain('TUT10');
        expect(codes).not.toContain('TUT20/1');
        expect(codes).not.toContain('action');
    });

    it('nákupní cena se NIKDY nedostane do výstupu', () => {
        const json = JSON.stringify(parseProductsCompleteXml(XML));
        expect(json).not.toContain('11.11');
        expect(json).not.toMatch(/purchase/i);
    });

    it('skrytý produkt je visible: false', () => {
        expect(parseProductsCompleteXml(XML).products.find((p) => p.code === 'HID')!.visible).toBe(false);
    });

    it('víc vlastních kódů v jedné položce = přeskočit a nahlásit, ne hádat', () => {
        const bad = XML.replace('<CODE>ZP9</CODE>', '<CODE>ZP9</CODE><CODE>ZP9B</CODE>');
        const r = parseProductsCompleteXml(bad);
        expect(r.products.some((p) => p.code === 'ZP9')).toBe(false);
        expect(r.skipped[0].reasonCs).toMatch(/víc kódů/);
    });

    it('HTML místo XML (neplatný hash) = čitelná chyba', () => {
        expect(() => parseProductsCompleteXml('<!DOCTYPE html><html>404</html>')).toThrow(ExportFormatError);
    });
});

describe('packageSize', () => {
    it.each([
        ['500', 'g', 500, null],
        ['1', 'kg', 1000, null],
        ['1,5', 'kg', 1500, null],
        ['250', 'ml', null, 250],
        ['1', 'l', null, 1000],
        ['1', 'pcs', null, null],
        ['', '', null, null],
        ['5', 'g', null, null],
    ])('%s %s → %s g / %s ml', (a, u, g, ml) => {
        expect(packageSize(a, u)).toEqual({ grams: g, volumeMl: ml });
    });
});
