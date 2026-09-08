/**
 * Testy čtení `priceId` z detailu produktu.
 *
 * `priceId` je nutné pro `/action/Cart/addCartItem/` — bez něj by
 * tlačítko „Vložit vše do košíku" nefungovalo. V `dataLayer` NENÍ,
 * je v hidden inputu formuláře (ověřeno naostro 2026-09-09:
 * ZP9 → 973, TUT196 → 8281, TUT108 → 7207, SF2 → 2497).
 */

import { describe, expect, it } from 'vitest';
import { parsePriceId } from '../../src/adapters/tutani-catalog/parseProductPage.js';

describe('parsePriceId', () => {
    it('přečte priceId z hidden inputu', () => {
        const html = '<form><input type="hidden" name="priceId" value="973"></form>';
        expect(parsePriceId(html)).toBe('973');
    });

    it('zvládne obrácené pořadí atributů', () => {
        const html = '<input value="8281" type="hidden" name="priceId">';
        expect(parsePriceId(html)).toBe('8281');
    });

    it('bere PRVNÍ výskyt — další formuláře nesou cizí priceId', () => {
        // Upsell a „podobné produkty" mají vlastní formuláře; kdyby se
        // vzal poslední, zákazník by si do košíku vložil jiný produkt.
        const html =
            '<input type="hidden" name="priceId" value="973">' +
            '<div class="upsell"><input type="hidden" name="priceId" value="111"></div>';
        expect(parsePriceId(html)).toBe('973');
    });

    it('chybí-li, vrátí null a NEHÁDÁ se', () => {
        expect(parsePriceId('<html><body>bez formuláře</body></html>')).toBeNull();
    });

    it('nespletne si priceId s productId', () => {
        const html =
            '<input type="hidden" name="productId" value="868">' +
            '<input type="hidden" name="priceId" value="973">';
        expect(parsePriceId(html)).toBe('973');
    });

    it('ignoruje nečíselnou hodnotu', () => {
        expect(parsePriceId('<input type="hidden" name="priceId" value="abc">')).toBeNull();
    });
});
