/**
 * Profil psa — strukturovaný vstup konfigurátoru.
 *
 * Tohle je JEDINÝ vstup, ze kterého se dávka počítá. Konfigurátor ho
 * posbírá v UI (ne dialogem — Lucky 2026-09-08), Worker ho zvaliduje a
 * dál už se pracuje jen s validovaným profilem.
 *
 * Enumy jsou úmyslně kanonické a jazykově neutrální: UI si k nim
 * překlady drží samo, engine nikdy nerozhoduje podle českého textu.
 */

/** Životní fáze. Odvozuje se z věku, neposílá ji frontend. */
export type LifeStage =
    | 'PUPPY_0_6'    // štěně do 6 měsíců
    | 'PUPPY_6_12'   // štěně 6–12 měsíců
    | 'JUNIOR'       // 1–2 roky
    | 'ADULT'        // dospělý
    | 'SENIOR';      // senior

export type ActivityLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'WORKING';

/** Tělesná kondice. Majitel ji v UI vybírá obrázkem, ne BCS číslem. */
export type BodyCondition = 'UNDER' | 'IDEAL' | 'OVER';

export type PhysiologicalState = 'NONE' | 'PREGNANT' | 'LACTATING' | 'RECOVERY';

export type Sex = 'MALE' | 'FEMALE';

export interface DogProfile {
    /** Jen pro zobrazení ve výsledku, do výpočtu nevstupuje. */
    name?: string;
    /** Aktuální hmotnost v kg. */
    weightKg: number;
    /**
     * Ideální hmotnost v kg. POVINNÁ při `bodyCondition: 'OVER'` —
     * redukční dieta se počítá z ideální, ne aktuální hmotnosti.
     * Chybí-li, validace vstup odmítne. Systém ji NEHÁDÁ.
     */
    idealWeightKg?: number;
    /** Věk v měsících. Jedna jednotka, ať se nemíchají roky a měsíce. */
    ageMonths: number;
    sex: Sex;
    neutered: boolean;
    activity: ActivityLevel;
    /** Konkrétní aktivita z `tenant.activityOptions` (jen pro zobrazení), úroveň je v `activity`. */
    activityDetailId?: string;
    bodyCondition: BodyCondition;
    physiologicalState: PhysiologicalState;
    /** Id z `conditions` (kind DISEASE), např. `ckd`. */
    conditionIds: string[];
    /** Id z `ingredients`, na které je pes alergický, např. `kure`. */
    allergyIngredientIds: string[];
    /**
     * Karta „Zuby a trávení" (klient 25. 9.). Volitelné kvůli zpětné
     * kompatibilitě; chybějící = `false`.
     *
     * `dentalProblem`: chybějící/bolavé zuby, senior, hltání, dávení →
     * do nákupu jen MLETÉ kosti (celou kost nemusí rozkousat).
     */
    dentalProblem?: boolean;
    /** Štěně plemene, které v dospělosti přesáhne 25 kg (majitel sám označí). */
    largeBreedPuppy?: boolean;
    /** Pes právě přechází z granulí na syrovou stravu. */
    switchingFromKibble?: boolean;
}

/**
 * Životní fáze z věku. Hranice jsou tady, ne v UI ani v pravidlech —
 * jedno místo, kde se to dá změnit.
 *
 * SENIOR se z věku odvodit nedá jednoznačně (velké rasy stárnou dřív),
 * proto je hranice 96 měsíců (8 let) záměrně konzervativní a majitel
 * může seniora označit i dřív přes nízkou aktivitu.
 */
export function resolveLifeStage(ageMonths: number): LifeStage {
    if (ageMonths < 6) return 'PUPPY_0_6';
    if (ageMonths < 12) return 'PUPPY_6_12';
    if (ageMonths < 24) return 'JUNIOR';
    if (ageMonths < 96) return 'ADULT';
    return 'SENIOR';
}

/**
 * Hmotnost, ze které se má počítat. Nadváha se počítá z IDEÁLNÍ
 * hmotnosti — jinak by pes s nadváhou dostával dávku odpovídající
 * jeho nadváze a hubnul by jen náhodou.
 *
 * Vrací `null`, když je potřeba ideální hmotnost a chybí. Volající to
 * musí ohlásit jako chybu vstupu, ne dopočítat.
 */
export function resolveBaseWeightKg(
    profile: DogProfile,
    useIdeal: boolean
): number | null {
    if (!useIdeal) return profile.weightKg;
    return profile.idealWeightKg ?? null;
}
