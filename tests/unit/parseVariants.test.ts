/**
 * Varianty na detailu produktu — proti SKUTEČNÉMU HTML z obchod.tutani.cz
 * (2026-09-24, Pivovarské kvasnice 500 g / 1 kg, CSRF token vymazán).
 *
 * Regrese: variantní produkt nemá v dataLayeru `product.code`, takže ho
 * `parseProductPage` zahodil a scraper varianty nikdy nenačetl.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    parseProductPage,
    parseProductPageAll,
    parseVariantRows,
} from '../../src/adapters/tutani-catalog/parseProductPage.js';

const HTML = readFileSync(
    join(process.cwd(), 'tests/fixtures/detail-varianty-pivovarske-kvasnice-2026-09-24.html'),
    'utf8'
);
const URL = 'https://obchod.tutani.cz/doplnky/pivovarske-kvasnice/';

describe('varianty produktu', () => {
    it('původní parseProductPage variantní stránku neumí (proto parseProductPageAll)', () => {
        expect(parseProductPage(HTML, URL)).toBeNull();
    });

    it('každý řádek tabulky má vlastní priceId — párováno v řádku, ne podle pořadí', () => {
        expect(parseVariantRows(HTML)).toEqual([
            { code: '1066/500', priceId: '1751', variantName: 'Pivovarské kvasnice: 500 g', priceWithVat: 59, stockQuantity: 8 },
            { code: '1066/1 K', priceId: '1754', variantName: 'Pivovarské kvasnice: 1 kg', priceWithVat: 88, stockQuantity: 4 },
        ]);
    });

    it('parseProductPageAll vrátí každou variantu jako samostatné SKU', () => {
        const items = parseProductPageAll(HTML, URL);
        expect(items.map((p) => [p.sku, p.priceId, p.productId, p.packGrams, p.stockQuantity, p.priceWithVat])).toEqual([
            ['1066/500', '1751', '1066', 500, 8, 59],
            ['1066/1 K', '1754', '1066', 1000, 4, 88],
        ]);
        expect(items.every((p) => p.hasVariants && p.parentProductId === '1066')).toBe(true);
    });

    it('gramáž varianty NEBERE z codes[].weight (přepravní hmotnost), ale z názvu varianty', () => {
        const items = parseProductPageAll(HTML, URL);
        expect(items.every((p) => p.packGramsSource === 'NAME')).toBe(true);
    });

    it('stránka bez tabulky variant a bez kódu = prázdno, ne vymyšlená položka', () => {
        const bezTabulky = HTML.replace(/<tr\b[^>]*data-testid="productVariant"[\s\S]*?<\/tr>/g, '');
        expect(parseProductPageAll(bezTabulky, URL)).toEqual([]);
    });
});
