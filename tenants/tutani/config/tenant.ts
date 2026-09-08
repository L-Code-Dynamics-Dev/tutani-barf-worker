/**
 * Konfigurace prvního tenanta — Tutani.
 *
 * ZÁSADA (Lucky 2026-09-08): Worker nesmí obsahovat
 * `if (client === 'tutani')`. Všechno, co je pro Tutani specifické,
 * je TADY jako data. Druhý klient = druhý takový soubor, nula změn
 * v enginu.
 *
 * Dnes je to TS konstanta (typová kontrola při buildu), ale tvar
 * odpovídá řádku v D1 / JSON v KV — přesun je mechanický, až bude
 * tenantů víc nebo je bude spravovat admin.
 */

import type { TenantConfiguration } from '../../../src/domain/tenant.js';

export const TUTANI_TENANT: TenantConfiguration = {
    tenantId: 'tutani',
    displayName: 'Tutani',
    locale: 'cs-CZ',
    currency: 'CZK',

    catalog: {
        // Shoptet bez REST API → čte se `dataLayer` z detailu produktu.
        // Ověřeno 2026-09-08: projectId 92086.
        kind: 'SHOPTET_DOM',
        baseUrl: 'https://obchod.tutani.cz',
        sitemapUrl: 'https://obchod.tutani.cz/sitemap.xml',
    },

    ruleSetIds: ['barf-core@1', 'tutani-health@1'],

    /** Mražené maso — měsíční zásoba se do mrazáku běžně vejde. */
    defaultPeriodDays: 30,

    /**
     * Mapování kategorie e-shopu → složka BARF dávky.
     *
     * Pořadí ROZHODUJE: vyhodnocuje se první shoda v cestě kategorie,
     * proto jdou specifičtější výrazy dřív. `vnitrnosti` je nutné
     * rozlišit na LIVER a ORGAN — játra mají v metodice vlastních 5 %,
     * takže „játra" musí trefit dřív než obecné „vnitrnosti".
     *
     * Kategorie ověřeny proti sitemap 2026-09-08 (346 URL).
     */
    categoryMap: [
        // Játra dřív než obecné vnitřnosti — vlastní podíl v dávce.
        { match: 'játra', barfGroup: 'LIVER' },
        { match: 'jatra', barfGroup: 'LIVER' },

        { match: 'vnitřnost', barfGroup: 'ORGAN' },
        { match: 'vnitrnost', barfGroup: 'ORGAN' },
        { match: 'orgán', barfGroup: 'ORGAN' },

        { match: 'kosti', barfGroup: 'BONE' },
        { match: 'chrupavk', barfGroup: 'BONE' },

        { match: 'svalovina', barfGroup: 'MUSCLE' },
        { match: 'svalové', barfGroup: 'MUSCLE' },
        { match: 'ryb', barfGroup: 'MUSCLE' },      // rybí filé = svalové maso
        { match: 'králič', barfGroup: 'MUSCLE' },
        { match: 'hovězí', barfGroup: 'MUSCLE' },
        { match: 'krůtí', barfGroup: 'MUSCLE' },
        { match: 'drůbeží', barfGroup: 'MUSCLE' },

        { match: 'příloh', barfGroup: 'PLANT' },
        { match: 'priloh', barfGroup: 'PLANT' },
        { match: 'zelenin', barfGroup: 'PLANT' },

        { match: 'doplňk', barfGroup: 'SUPPLEMENT' },
        { match: 'doplnk', barfGroup: 'SUPPLEMENT' },

        /**
         * Slova z NÁZVŮ produktů — druhá úroveň mapování pro 27 produktů
         * z „Barf mražené maso", které nemají podkategorii (dry-run
         * 2026-09-08). Kategorie má vždy přednost.
         *
         * Záměrně jen jednoznačné suroviny. Fantazijní názvy („Gurgle",
         * „Pani Držkatá", „Šemíkova mňamka", „Kopyto jako kráva") tady
         * NEJSOU — z nich se složka odvodit nedá a zařazení musí
         * potvrdit klient.
         */
        { match: 'srdce', barfGroup: 'ORGAN' },
        { match: 'srdíčk', barfGroup: 'ORGAN' },
        { match: 'droby', barfGroup: 'ORGAN' },
        { match: 'žaludk', barfGroup: 'ORGAN' },
        { match: 'slezina', barfGroup: 'ORGAN' },
        { match: 'plíce', barfGroup: 'ORGAN' },
        { match: 'bachor', barfGroup: 'ORGAN' },
        { match: 'dršťk', barfGroup: 'ORGAN' },

        { match: 'jazyk', barfGroup: 'MUSCLE' },
        { match: 'kachn', barfGroup: 'MUSCLE' },
        { match: 'kuře', barfGroup: 'MUSCLE' },
        { match: 'kuřec', barfGroup: 'MUSCLE' },
        { match: 'koňsk', barfGroup: 'MUSCLE' },
        { match: 'krocan', barfGroup: 'MUSCLE' },
        { match: 'vepřov', barfGroup: 'MUSCLE' },
        { match: 'jehněč', barfGroup: 'MUSCLE' },

        // Pamlsky, hračky, obojky, poukázky → OTHER, do dávky nevstupují.
    ],
};
