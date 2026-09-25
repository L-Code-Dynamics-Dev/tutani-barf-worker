/**
 * Rozpad produktu na BARF složky podle PROCENT ve složení.
 *
 * Objev z detailu produktu (Lucky 2026-09-09, `TUT161`):
 *
 *   „Složení: 70% hovězí ořez, 30% hovězí droby (játra, plíce, ledviny)"
 *
 * Takový produkt NENÍ čistá svalovina — je to 70 % MUSCLE a 30 %
 * ORGAN, z toho část LIVER. Dosud se celý počítal do jedné skupiny
 * podle kategorie, takže pes s omezením jater (max 1 % u hepatopatie
 * s měďí) mohl dostat produkt, který je z 30 % droby včetně jater.
 *
 * Změřeno na `universal.xml`: **63 z 269 produktů** má v popisu
 * procenta, 34 má slovo „složení".
 *
 * ZÁSADA (R7): parsuje se jen to, co je v textu explicitně. Nic se
 * nedopočítává a nedomýšlí — když procenta nedávají ~100 %, výsledek
 * se zahodí a produkt zůstane v jedné skupině podle kategorie.
 * Nesprávný rozpad by byl horší než žádný.
 */

import type { BarfGroup } from '../../domain/tenant.js';

/** Jedna složka produktu s podílem v procentech. */
export interface CompositionPart {
    group: BarfGroup;
    pct: number;
    /** Text, ze kterého se to odvodilo — pro audit a kontrolu. */
    sourceCs: string;
}

/**
 * Slova, která určují BARF skupinu. Pořadí ROZHODUJE — specifičtější
 * dřív, protože „hovězí droby (játra…)" musí trefit `LIVER` i `ORGAN`
 * a „ořez" nesmí být zaměněn za orgán.
 *
 * Mimo kód (v `tenant.ts`) to není záměrně: jde o jazykový parser
 * složení, ne o konfiguraci sortimentu.
 */
const SKUPINY: ReadonlyArray<readonly [BarfGroup, readonly string[]]> = [
    // Játra mají v metodice vlastních 5 % a u hepatopatie limit 1 %.
    ['LIVER', ['játra', 'jatra', 'jatýrk', 'jatyrk']],

    ['ORGAN', [
        'drob', 'vnitřnost', 'vnitrnost', 'orgán', 'organ',
        'srdíčk', 'srdicek', 'srdce', 'žaludk', 'zaludk', 'žaludek',
        'plíce', 'plice', 'ledvin', 'slezin', 'bachor', 'dršťk', 'drstk',
        'brzlík', 'brzlik', 'vemínk', 'vemink',
    ]],

    ['BONE', [
        'kost', 'chrupavk', 'krk', 'napínák', 'napinak', 'šlach', 'slach',
        'krční', 'krcni', 'ocas',
    ]],

    ['MUSCLE', [
        'svalovin', 'ořez', 'orez', 'maso', 'masa', 'filé', 'file',
        'stehn', 'prsa', 'jazyk', 'kuře', 'kure', 'krůt', 'krut',
        'hověz', 'hovez', 'vepřov', 'veprov', 'králič', 'kralic',
    ]],

    ['PLANT', [
        'zelenin', 'ovoc', 'mrkev', 'mrkv', 'řepa', 'repa', 'dýn', 'dyn',
        'špenát', 'spenat', 'jablk', 'bylin', 'pohank', 'jáhl', 'jahl',
        'kuskus', 'rýž', 'ryz', 'vlочk', 'vločk', 'vlock',
    ]],

    ['SUPPLEMENT', ['řasa', 'rasa', 'kelp', 'spirulin', 'chlorel', 'olej', 'kvasnic']],
];

/** Tolerance součtu procent — popisy uvádějí „cca 65 %". */
const TOLERANCE_PCT = 12;

/**
 * Vytáhne rozpad na složky ze textu složení.
 *
 * Vrací prázdné pole, když se rozpad nedá určit spolehlivě. To NENÍ
 * chyba — 206 z 269 produktů procenta neuvádí a pro ty platí zařazení
 * podle kategorie.
 */
export function parseCompositionParts(text: string | null | undefined): CompositionPart[] {
    if (!text) return [];
    const t = text.toLowerCase();

    /**
     * Zajímá nás jen část za slovem „složení", pokud tam je —
     * v popisech bývá i „krmná dávka: 2 % hmotnosti", což by se jinak
     * načetlo jako složka.
     */
    const odSlozeni = t.search(/slo[žz]en[íi]/);
    const usek = odSlozeni >= 0 ? t.slice(odSlozeni) : t;

    /**
     * Hledá se `<číslo> % <text až do oddělovače>`. „cca" před číslem
     * se toleruje, protože popisy ho používají.
     */
    const nalezy = [...usek.matchAll(/(?:cca\s*)?(\d{1,3})\s*%\s*([^,.;)\n]{2,60})/g)];
    if (nalezy.length === 0) return [];

    const parts: CompositionPart[] = [];
    for (const m of nalezy) {
        const pct = Number(m[1]);
        if (!Number.isFinite(pct) || pct <= 0 || pct > 100) continue;

        const popis = m[2].trim();
        const group = urciSkupinu(popis);
        if (group === null) continue;

        parts.push({ group, pct, sourceCs: `${pct} % ${popis}`.slice(0, 80) });
    }
    if (parts.length === 0) return [];

    /**
     * Součet musí dát přibližně 100 %. Když ne, text popisuje něco
     * jiného (obsah bílkovin, „100 % kvalita") a rozpad se zahodí —
     * nesprávný rozpad je horší než žádný.
     *
     * Jednoprvkový rozpad „100 % X" je legitimní a častý.
     */
    const soucet = parts.reduce((a, p) => a + p.pct, 0);
    if (Math.abs(soucet - 100) > TOLERANCE_PCT) return [];

    // Sloučení stejných skupin (např. dvě masa) + normalizace na 100 %.
    const podleSkupiny = new Map<BarfGroup, CompositionPart>();
    for (const p of parts) {
        const stav = podleSkupiny.get(p.group);
        if (stav) {
            stav.pct += p.pct;
            stav.sourceCs = `${stav.sourceCs}; ${p.sourceCs}`.slice(0, 160);
        } else {
            podleSkupiny.set(p.group, { ...p });
        }
    }

    const slouceno = [...podleSkupiny.values()];
    const celkem = slouceno.reduce((a, p) => a + p.pct, 0);
    for (const p of slouceno) p.pct = Math.round((p.pct / celkem) * 1000) / 10;

    // Deterministické pořadí podle podílu, pak podle skupiny.
    slouceno.sort((a, b) => b.pct - a.pct || a.group.localeCompare(b.group));
    return slouceno;
}

/**
 * Skupina podle textu. `null` = nelze určit, složka se přeskočí.
 *
 * Pozor na pořadí u „hovězí droby (játra, plíce, ledviny)": trefí to
 * `LIVER` (játra jsou první v seznamu), i když je to primárně ORGAN.
 * Proto se u textu, který obsahuje obojí, vrací ORGAN — játra jsou
 * jeho součástí a jejich přesný podíl v textu není.
 */
function urciSkupinu(popis: string): BarfGroup | null {
    const jeOrgan = SKUPINY.find(([g]) => g === 'ORGAN')![1].some((v) => popis.includes(v));
    const jeLiver = SKUPINY.find(([g]) => g === 'LIVER')![1].some((v) => popis.includes(v));

    // „droby (játra, plíce, ledviny)" → ORGAN, protože podíl jater
    // v textu není a nesmí se domyslet (R7).
    if (jeOrgan && jeLiver) return 'ORGAN';

    for (const [group, vzory] of SKUPINY) {
        if (vzory.some((v) => popis.includes(v))) return group;
    }
    return null;
}

/**
 * Deklarovaný podíl kostí v popisu („cca 70 % kostí a chrupavky").
 * Vrací nejvyšší nalezené procento, `null` = popis kosti v % neuvádí.
 * Slouží jen k zařazení produktu, když úplný rozpad sestavit nejde.
 */
export function declaredBonePct(text: string | null | undefined): number | null {
    if (!text) return null;
    const t = text.toLowerCase();
    let max: number | null = null;
    for (const m of t.matchAll(/(?:cca\s*)?(\d{1,3})\s*%\s*(?:mlet[ýéých]*\s+)?(?:kost|chrupav)/g)) {
        const pct = Number(m[1]);
        if (Number.isFinite(pct) && pct > 0 && pct <= 100) max = max === null ? pct : Math.max(max, pct);
    }
    return max;
}
