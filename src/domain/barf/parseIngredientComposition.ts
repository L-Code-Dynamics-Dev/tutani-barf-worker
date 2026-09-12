/**
 * ROZKLAD PRODUKTU NA SUROVINY (ingredient-level), NE na BarfGroup.
 *
 * Navazuje na `adapters/tutani-catalog/parseComposition.ts`
 * (`parseCompositionParts`), který rozkládá text na `BarfGroup`
 * (MUSCLE/ORGAN/LIVER/BONE/PLANT/SUPPLEMENT). Tenhle soubor jde
 * o úroveň hlouběji — na konkrétní surovinu (`beef_lung`, `beef_kidney`,
 * `beef_liver`), protože to je úroveň, na které se dělá nutriční
 * výpočet (Lucky 2026-09-09).
 *
 * ROZLIŠENÍ CERTAINTY (zásadní bod zadání):
 *
 *   TUT175 „40 % plíce / 30 % ledviny / 30 % játra" → EXACT u všech tří
 *   TUT155 „ledviny, plíce, játra" (bez čísel)       → PARTIAL u všech
 *   TUT223 „50 % maso / 50 % zelenina (mrkev, petržel, celer)"
 *                → EXACT na úrovni masa/zeleniny (50/50),
 *                  PARTIAL uvnitř zeleninové skupiny (mrkev/petržel/celer)
 *   TUT58  „100 % krůta: svalovina, kosti, kůže, chrupavka, bez vnitřností"
 *                → PARTIAL u čtyř složek (společně tvoří 100 % krůty,
 *                  ale jejich vzájemný poměr Tutani neuvádí) — DŮLEŽITÉ:
 *                  „bez vnitřností" se zapisuje jako explicitní
 *                  `organsPresent: false` fakt, ne mlčení.
 *
 * ZÁSADA (R7): když Tutani poměr neuvedl, engine ho NEDOPOČÍTÁVÁ
 * rovnoměrným rozdělením. Rovnoměrný rozpad „100 % / 3 = 33,3 % každé"
 * by se navenek tvářil jako měření a byl by to tichý odhad — přesně
 * to, co audit `parseComposition.ts` už jednou odhalil jako problém.
 */

import type { IngredientComposition, CompositionCertainty } from '../products/Composition.js';
import type { Species, EdiblePart } from '../nutrition/Ingredient.js';

/** Vzor jedné suroviny — jméno pro audit + odkaz do nutričního katalogu. */
interface IngredientPattern {
    /** `null` = surovina je textem rozpoznatelná, ale v USDA katalogu zatím není. */
    ingredientId: string | null;
    nameCs: string;
    species: Species | null;
    part: EdiblePart | null;
    /** Podřetězce (bez diakritiky i s ní), které surovinu identifikují v textu. */
    triggers: readonly string[];
}

/**
 * Katalog part-level surovin rozpoznatelných v textu Tutani.
 *
 * Pořadí ROZHODUJE stejně jako v `parseComposition.ts` — specifičtější
 * dřív („hovězí plíce" musí trefit `beef_lung`, ne obecný `beef_organ`).
 * `ingredientId: null` u surovin bez nutričního záznamu je ZÁMĚRNÉ
 * (viz `gaps.missingIngredients` v `ingredients-nutrition.json`) —
 * rozklad produktu na ně proběhne i tak, jen výpočet nutrice u nich
 * zůstane neúplný (stejný mechanismus jako `NOT_ANALYZED`).
 */
const SUROVINY: readonly IngredientPattern[] = [
    // ---- hovězí orgány (part-level) ----
    { ingredientId: 'hovezi-jatra', nameCs: 'hovězí játra', species: 'BEEF', part: 'SECRETORY_LIVER',
        triggers: ['hovězí játra', 'hovezi jatra'] },
    { ingredientId: 'hovezi-ledvina', nameCs: 'hovězí ledviny', species: 'BEEF', part: 'SECRETORY_KIDNEY',
        triggers: ['ledvin'] },
    { ingredientId: null, nameCs: 'hovězí plíce', species: 'BEEF', part: 'SECRETORY_LUNG',
        triggers: ['plíce', 'plice'] },
    { ingredientId: 'hovezi-srdce', nameCs: 'hovězí srdce', species: 'BEEF', part: 'MUSCLE_ORGAN',
        triggers: ['srdíčk', 'srdicek', 'srdce'] },
    { ingredientId: null, nameCs: 'dršťky', species: null, part: 'SECRETORY_TRIPE',
        triggers: ['dršťk', 'drstk', 'bachor'] },
    { ingredientId: null, nameCs: 'žaludky', species: null, part: 'SECRETORY_OTHER',
        triggers: ['žaludk', 'zaludk', 'žaludek'] },

    // ---- svalovina, kosti, kůže, chrupavka ----
    { ingredientId: 'hovezi-mlete-93-7', nameCs: 'hovězí svalovina/ořez', species: 'BEEF', part: 'MUSCLE',
        triggers: ['hovězí ořez', 'hovezi orez', 'hovězí svalovin', 'hovězí maso', 'hovězí mleté'] },
    { ingredientId: null, nameCs: 'kosti', species: null, part: 'BONE',
        triggers: ['kost'] },
    { ingredientId: null, nameCs: 'chrupavka', species: null, part: 'CARTILAGE',
        triggers: ['chrupavk'] },
    { ingredientId: null, nameCs: 'kůže', species: null, part: 'SKIN',
        triggers: ['kůže', 'kuze', 'kůži', 'kuzi'] },

    // ---- kachna ----
    { ingredientId: null, nameCs: 'kachní krky', species: 'DUCK', part: 'BONE',
        triggers: ['kachní krk', 'kachni krk'] },
    { ingredientId: null, nameCs: 'kachní křídla', species: 'DUCK', part: 'BONE',
        triggers: ['kachní křídl', 'kachni kridl'] },
    { ingredientId: null, nameCs: 'masité skelety', species: null, part: 'BONE',
        triggers: ['skelet'] },
    { ingredientId: null, nameCs: 'kachní žaludky', species: 'DUCK', part: 'SECRETORY_OTHER',
        triggers: ['kachní žaludk', 'kachni zaludk', 'kachní bachor'] },
    { ingredientId: null, nameCs: 'kachní hřbety', species: 'DUCK', part: 'BONE',
        triggers: ['kachní hřbet', 'kachni hrbet'] },

    // ---- králík ----
    { ingredientId: null, nameCs: 'králičí kosti', species: 'RABBIT', part: 'BONE',
        triggers: ['králičí kost', 'kralici kost'] },
    { ingredientId: null, nameCs: 'králičí srdce', species: 'RABBIT', part: 'MUSCLE_ORGAN',
        triggers: ['králičí srdce', 'kralici srdce'] },
    { ingredientId: null, nameCs: 'králičí plíce', species: 'RABBIT', part: 'SECRETORY_LUNG',
        triggers: ['králičí plíce', 'kralici plice'] },

    // ---- koňská svalovina ----
    { ingredientId: null, nameCs: 'koňská svalovina', species: 'HORSE', part: 'MUSCLE',
        triggers: ['koňská svalovin', 'konska svalovin', 'koňské maso'] },

    // ---- kuřecí ----
    { ingredientId: 'kureci-prsa-sr-legacy', nameCs: 'kuřecí prsa', species: 'CHICKEN', part: 'MUSCLE',
        triggers: ['kuřecí prsa', 'kureci prsa'] },

    // ---- zvěřina (TUT7: srnec+jelen+daněk, bez kostí) ----
    { ingredientId: null, nameCs: 'srnčí maso', species: 'GAME', part: 'MUSCLE', triggers: ['srnec', 'srnč', 'srnc'] },
    { ingredientId: null, nameCs: 'jelení maso', species: 'GAME', part: 'MUSCLE', triggers: ['jelen'] },
    { ingredientId: null, nameCs: 'daňčí maso', species: 'GAME', part: 'MUSCLE', triggers: ['daněk', 'danek', 'daňč'] },

    // ---- zelenina (TUT223) ----
    { ingredientId: null, nameCs: 'mrkev', species: 'PLANT', part: 'VEGETABLE', triggers: ['mrkev', 'mrkv'] },
    { ingredientId: null, nameCs: 'petržel', species: 'PLANT', part: 'VEGETABLE', triggers: ['petržel', 'petrzel'] },
    { ingredientId: null, nameCs: 'celer', species: 'PLANT', part: 'VEGETABLE', triggers: ['celer'] },
    { ingredientId: null, nameCs: 'zelenina (blíže neurčeno)', species: 'PLANT', part: 'VEGETABLE',
        triggers: ['zelenin'] },

    // ---- krůta (TUT58) ----
    { ingredientId: null, nameCs: 'krůtí svalovina', species: 'TURKEY', part: 'MUSCLE',
        triggers: ['krůt', 'krut'] },
];

/** Explicitní fakt „bez vnitřností"/„bez kostí" — zápis nepřítomnosti, ne mlčení. */
export interface AbsenceClaim {
    part: EdiblePart;
    /** Přesně jak se to v textu píše — pro audit. */
    sourceCs: string;
}

export interface ParsedComposition {
    composition: IngredientComposition[];
    absent: AbsenceClaim[];
}

const TOLERANCE_PCT = 12;

/**
 * Najde surovinu podle textového popisu jedné složky (mezi čárkami
 * nebo v závorce). Vrací první shodu podle pořadí `SUROVINY` — pořadí
 * je zámerně specifičtější-první.
 */
function najdiSurovinu(popisRaw: string): IngredientPattern | null {
    const popis = popisRaw.toLowerCase();
    for (const s of SUROVINY) {
        if (s.triggers.some((t) => popis.includes(t))) return s;
    }
    return null;
}

/**
 * Rozpozná věty typu „bez vnitřností", „bez kostí" — explicitní
 * nepřítomnost, kterou systém zapisuje jako fakt (`organsPresent: false`
 * v duchu zadání), ne jako neznámou.
 */
function parseAbsence(text: string): AbsenceClaim[] {
    const t = text.toLowerCase();
    const out: AbsenceClaim[] = [];
    const vzory: ReadonlyArray<readonly [EdiblePart, readonly string[]]> = [
        ['SECRETORY_OTHER', ['bez vnitřností', 'bez vnitrnosti']],
        ['BONE', ['bez kostí', 'bez kosti']],
        ['SECRETORY_LIVER', ['bez jater']],
    ];
    for (const [part, vzory2] of vzory) {
        for (const v of vzory2) {
            const idx = t.indexOf(v);
            if (idx >= 0) out.push({ part, sourceCs: text.slice(idx, idx + v.length + 20).trim() });
        }
    }
    return out;
}

/**
 * Rozloží text složení na `IngredientComposition[]` — hlavní funkce
 * tohoto souboru.
 *
 * Postup:
 *   1. Najde procenta u jednotlivých složek (stejný regex přístup jako
 *      `parseCompositionParts`, ale nesčítá do `BarfGroup`, hledá
 *      konkrétní surovinu).
 *   2. Když procenta dají dohromady ~100 % → `EXACT` u všech nalezených.
 *   3. Když se najdou pojmenované složky BEZ procent (byť jen některé)
 *      → VŠECHNY složky té úrovně dostanou `PARTIAL` (žádný dopočet).
 *   4. „Bez X" věty se zapisují zvlášť do `absent`.
 *
 * Vrací prázdné `composition`, když se v textu nenajde ani jedna známá
 * surovina — produkt zůstává nerozložený (fallback na `BarfGroup`
 * zůstává v `parseCompositionParts`, beze změny).
 */
export function parseIngredientComposition(text: string | null | undefined): ParsedComposition {
    if (!text) return { composition: [], absent: [] };
    const absent = parseAbsence(text);

    const t = text.toLowerCase();
    const odSlozeni = t.search(/slo[žz]en[íi]/);
    const usek = odSlozeni >= 0 ? text.slice(odSlozeni) : text;

    // Krok 1: hledat "<číslo> % <popis>".
    const nalezyProcent = [...usek.matchAll(/(?:cca\s*)?(\d{1,3})\s*%\s*([^,.;)\n]{2,60})/g)];
    const exact: IngredientComposition[] = [];
    let soucetProcent = 0;

    for (const m of nalezyProcent) {
        const pct = Number(m[1]);
        if (!Number.isFinite(pct) || pct <= 0 || pct > 100) continue;
        const popis = m[2].trim();
        const surovina = najdiSurovinu(popis);
        if (!surovina) continue;

        /**
         * Skupina více surovin za jedním procentem (TUT223: „50 %
         * zelenina (mrkev, petržel, celer)") — text za popisem, v
         * závorce, vyjmenovává druhy BEZ vzájemného poměru. Detekuje
         * se podle slova "zelenina"/"směs" v popisu + nalezení víc
         * než jedné rostlinné suroviny v následující závorce.
         */
        const zavorkaMatch = usek.slice(m.index ?? 0).match(/^[^)]*\(([^)]{3,120})\)/);
        const jeSkupina = /zelenin|směs|smes/.test(popis) && zavorkaMatch;

        if (jeSkupina) {
            const subDruhy = zavorkaMatch![1]
                .split(/[,/]/)
                .map((s) => s.trim())
                .filter(Boolean);
            const subNalezene = subDruhy
                .map((s) => najdiSurovinu(s)?.nameCs ?? s)
                .filter((v, i, arr) => arr.indexOf(v) === i);

            exact.push({
                ingredientId: null,
                nameCs: popis,
                species: 'PLANT',
                part: null,
                role: 'INGREDIENT_GROUP',
                subcomponentsCs: subNalezene,
                subcomponentRatio: 'UNKNOWN',
                percentage: pct,
                certainty: 'EXACT',
                sourceCs: `${pct} % ${popis} (${zavorkaMatch![1]})`.slice(0, 120),
            });
            soucetProcent += pct;
            continue;
        }

        exact.push({
            ingredientId: surovina.ingredientId,
            nameCs: surovina.nameCs,
            species: surovina.species,
            part: surovina.part,
            role: 'INGREDIENT',
            subcomponentsCs: [],
            subcomponentRatio: null,
            percentage: pct,
            certainty: 'EXACT',
            sourceCs: `${pct} % ${popis}`.slice(0, 80),
        });
        soucetProcent += pct;
    }

    if (exact.length > 0 && Math.abs(soucetProcent - 100) <= TOLERANCE_PCT) {
        return { composition: exact, absent };
    }

    // Krok 2: procenta nesedí nebo chybí → hledat POJMENOVANÉ složky bez
    // čísel (výčet oddělený čárkami/závorkou po slově "složení").
    const vyjmenovane = [...usek.matchAll(/[,(]?\s*([a-záéíóúůýčďěňřšťž]{3,40})/gi)]
        .map((m) => m[1].trim())
        .filter(Boolean);

    const nalezenePartial = new Map<string, IngredientPattern>();
    for (const kus of vyjmenovane) {
        const s = najdiSurovinu(kus);
        if (s) nalezenePartial.set(s.nameCs, s);
    }

    if (nalezenePartial.size === 0) return { composition: [], absent };

    const partial: IngredientComposition[] = [...nalezenePartial.values()].map((s) => ({
        ingredientId: s.ingredientId,
        nameCs: s.nameCs,
        species: s.species,
        part: s.part,
        role: 'INGREDIENT' as const,
        subcomponentsCs: [],
        subcomponentRatio: null,
        percentage: null,
        certainty: 'PARTIAL' as CompositionCertainty,
        sourceCs: `nalezeno beze zadaného poměru: „${s.nameCs}"`,
    }));

    return { composition: partial, absent };
}
