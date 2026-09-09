/**
 * ENERGETICKÁ POTŘEBA — `RER` a `MER`.
 *
 * Zdroj metodiky: znalostní báze Lucky, body 69–77.
 * Referenční vrstva: **FEDIAF 2025**.
 *
 * PROČ TENHLE MODUL EXISTUJE (bod 73): dva psi o 20 kg mohou mít
 * úplně jinou energetickou potřebu — senior kastrovaný s nadváhou
 * proti mladému sportovci. Procento z hmotnosti to nerozliší, protože
 * pracuje s hmotností, ne s energií.
 *
 * `RER` (Resting Energy Requirement) je klidová potřeba a **není to
 * denní příjem** (bod 69). Denní potřeba `MER` = `RER × koeficient`
 * podle životní fáze, aktivity, kastrace a kondice.
 *
 * ZÁSADNÍ (bod 69): systém nesmí říct „20kg pes = 662 kcal". Musí
 * říct „RER je přibližně 662 kcal, skutečná potřeba se stanoví podle
 * jeho situace" — proto se vždy vrací i rozmezí, ne jen jedno číslo.
 *
 * Tenhle výpočet **nenahrazuje** dávku v gramech z metodiky BARF.
 * Je to DRUHÝ, nezávislý pohled: když se oba rozejdou, je to signál
 * pro majitele i pro nás (bod 70 — energetická kontrola v praxi).
 */

import Decimal from 'decimal.js';
import type {
    ActivityLevel,
    BodyCondition,
    LifeStage,
    PhysiologicalState,
} from '../dog/DogProfile.js';

/** Odkud hodnota je. Bod 67 — zdrojová hierarchie A > B > C > D. */
export type SourceTier =
    | 'FEDIAF'          // A — evropský nutriční standard 2025
    | 'WSAVA'           // B — veterinární evidence
    | 'MERCK'           // B
    | 'VET_ZDROJ'       // B — odborné studie
    | 'NOVOSADOVA'      // C — BARF literatura
    | 'BARF_TRADICE'    // C
    | 'L_CODE_INFERENCE'// náš převod — NENÍ citace
    | 'NEJISTE';        // D / neověřeno

export interface EnergyResult {
    /** Klidová potřeba v kcal. NENÍ denní příjem. */
    rerKcal: number;
    /** Denní potřeba — rozmezí, ne jedno číslo (bod 69). */
    merMinKcal: number;
    merMaxKcal: number;
    /** Střed rozmezí pro orientaci. */
    merKcal: number;
    /** Koeficienty, které se použily — pro auditní stopu. */
    factors: EnergyFactor[];
    /** Z jaké hmotnosti se počítalo. */
    baseWeightKg: number;
    baseWeightSource: 'ACTUAL' | 'IDEAL';
    /** Věta pro zákazníka, aby si RER nepletl s denní dávkou. */
    noteCs: string;
}

export interface EnergyFactor {
    reasonCs: string;
    min: number;
    max: number;
    source: SourceTier;
}

/**
 * Koeficienty `MER = RER × k`.
 *
 * Hodnoty odpovídají rozmezím, která FEDIAF a veterinární literatura
 * uvádějí pro udržovací potřebu. Držíme je ZÁMĚRNĚ jako rozmezí —
 * jedno číslo by předstíralo přesnost, kterou u konkrétního psa nemáme
 * (bod 72: „nechci do databáze zapsat falešnou přesnost").
 *
 * Zdroj je u každého koeficientu, protože audit našel, že naše limity
 * se v odpovědi tváří jako citace, i když jsou to převody.
 */
const KOEFICIENTY = {
    lifeStage: {
        PUPPY_0_6: { min: 2.5, max: 3.0, cs: 'štěně do 6 měsíců (rychlý růst)', src: 'FEDIAF' },
        PUPPY_6_12: { min: 1.8, max: 2.0, cs: 'štěně 6–12 měsíců', src: 'FEDIAF' },
        JUNIOR: { min: 1.6, max: 1.8, cs: 'mladý pes 1–2 roky', src: 'FEDIAF' },
        ADULT: { min: 1.4, max: 1.6, cs: 'dospělý pes, udržovací', src: 'FEDIAF' },
        SENIOR: { min: 1.2, max: 1.4, cs: 'senior', src: 'FEDIAF' },
    },
    activity: {
        LOW: { min: -0.2, max: -0.2, cs: 'nízká aktivita', src: 'FEDIAF' },
        MEDIUM: { min: 0, max: 0, cs: 'střední aktivita', src: 'FEDIAF' },
        HIGH: { min: 0.4, max: 0.6, cs: 'vysoká aktivita', src: 'FEDIAF' },
        WORKING: { min: 0.6, max: 1.4, cs: 'pracovní pes', src: 'FEDIAF' },
    },
    /** Kastrace snižuje potřebu — bod 2 znalostní báze. */
    neutered: { min: -0.2, max: -0.1, cs: 'kastrovaný / sterilizovaný', src: 'FEDIAF' },
    physiological: {
        PREGNANT: { min: 0.6, max: 1.0, cs: 'březí fena (pozdní fáze)', src: 'FEDIAF' },
        LACTATING: { min: 1.0, max: 2.6, cs: 'kojící fena (podle počtu štěňat)', src: 'FEDIAF' },
        RECOVERY: { min: 0.2, max: 0.4, cs: 'rekonvalescence', src: 'VET_ZDROJ' },
        NONE: { min: 0, max: 0, cs: '', src: 'FEDIAF' },
    },
} as const;

/** Vstup pro výpočet — jen to, co energie potřebuje. */
export interface EnergyInput {
    weightKg: number;
    idealWeightKg?: number;
    lifeStage: LifeStage;
    activity: ActivityLevel;
    bodyCondition: BodyCondition;
    physiologicalState: PhysiologicalState;
    neutered: boolean;
}

/**
 * `RER = 70 × kg^0.75` (bod 69).
 *
 * Ověřeno proti tabulce ze znalostní báze: 5 kg → 234, 10 kg → 394,
 * 20 kg → 662, 30 kg → 897, 40 kg → 1115 kcal.
 */
export function calculateRER(weightKg: number): number {
    if (!Number.isFinite(weightKg) || weightKg <= 0) return 0;
    // `Decimal` nemá mocninu s desetinným exponentem, proto `Math.pow`;
    // výsledek se ale hned zaokrouhlí, takže se chyba nenabaluje.
    return Math.round(70 * Math.pow(weightKg, 0.75));
}

/**
 * Denní energetická potřeba jako ROZMEZÍ.
 *
 * Redukční dieta se počítá z IDEÁLNÍ hmotnosti (bod 82) — z aktuální
 * by pes dostal energii odpovídající své nadváze a nezhubl by.
 */
export function calculateEnergy(input: EnergyInput): EnergyResult {
    const factors: EnergyFactor[] = [];

    // ---- Základní hmotnost ----
    const pouzitIdealni =
        input.bodyCondition === 'OVER' &&
        typeof input.idealWeightKg === 'number' &&
        input.idealWeightKg > 0;
    const baseWeight = pouzitIdealni ? input.idealWeightKg! : input.weightKg;

    const rer = calculateRER(baseWeight);

    // ---- Koeficient životní fáze (základ) ----
    const ls = KOEFICIENTY.lifeStage[input.lifeStage];
    let min = new Decimal(ls.min);
    let max = new Decimal(ls.max);
    factors.push({ reasonCs: ls.cs, min: ls.min, max: ls.max, source: ls.src as SourceTier });

    /**
     * Aktivita a kastrace se u ŠTĚŇAT nepřičítají: jejich potřeba je
     * daná růstem, ne pohybem, a kastrované štěně je vzácnost.
     * U dospělých a seniorů se přičítají.
     */
    const dospely = input.lifeStage === 'ADULT' || input.lifeStage === 'SENIOR';

    if (dospely) {
        const act = KOEFICIENTY.activity[input.activity];
        if (act.min !== 0 || act.max !== 0) {
            min = min.plus(act.min);
            max = max.plus(act.max);
            factors.push({ reasonCs: act.cs, min: act.min, max: act.max, source: act.src as SourceTier });
        }
        if (input.neutered) {
            const n = KOEFICIENTY.neutered;
            min = min.plus(n.min);
            max = max.plus(n.max);
            factors.push({ reasonCs: n.cs, min: n.min, max: n.max, source: n.src as SourceTier });
        }
    }

    /**
     * Fyziologický stav PŘEBÍJÍ aktivitu i kastraci — laktace zvyšuje
     * potřebu natolik, že ostatní korekce jsou vedle ní šum (bod 86).
     */
    if (input.physiologicalState !== 'NONE') {
        const ph = KOEFICIENTY.physiological[input.physiologicalState];
        min = min.plus(ph.min);
        max = max.plus(ph.max);
        factors.push({ reasonCs: ph.cs, min: ph.min, max: ph.max, source: ph.src as SourceTier });
    }

    // Pod klidovou potřebu se nejde ani při redukci — hladovění není dieta.
    if (min.lessThan(1)) min = new Decimal(1);
    if (max.lessThan(min)) max = min;

    const merMin = Math.round(new Decimal(rer).mul(min).toNumber());
    const merMax = Math.round(new Decimal(rer).mul(max).toNumber());

    return {
        rerKcal: rer,
        merMinKcal: merMin,
        merMaxKcal: merMax,
        merKcal: Math.round((merMin + merMax) / 2),
        factors,
        baseWeightKg: baseWeight,
        baseWeightSource: pouzitIdealni ? 'IDEAL' : 'ACTUAL',
        noteCs:
            `Klidová potřeba (RER) je přibližně ${rer} kcal. Skutečná denní ` +
            `potřeba se u konkrétního psa stanoví podle jeho situace a ověří ` +
            `sledováním hmotnosti a kondice po 2–4 týdnech.`,
    };
}
