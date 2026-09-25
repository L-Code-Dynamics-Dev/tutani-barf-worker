/**
 * Karta „Zuby a trávení" (klient Tutani 25. 9. 2026).
 *
 * Údaje o psovi, které nejsou nemocí, ale mění, co smíme doporučit.
 * FÁZE 1: žádná vlastní čísla — jen bezpečné omezení (mleté kosti)
 * a upozornění. Přesná pravidla (např. Ca:P u štěňat velkých plemen)
 * patří do 2. fáze po potvrzení veterinářem.
 *
 * Čistá funkce: vrací NOVÝ objekt, vstup nemění.
 */

import type { DogProfile } from '../domain/dog/DogProfile.js';
import { resolveLifeStage } from '../domain/dog/DogProfile.js';
import type { ResolvedConstraints, ResolvedWarning } from '../domain/health/Condition.js';

export function applyDogProfileFlags(c: ResolvedConstraints, dog: DogProfile): ResolvedConstraints {
    const warnings: ResolvedWarning[] = [...c.warnings];
    let groundBoneOnly = c.groundBoneOnly === true;
    let requiresVet = c.requiresVet;

    if (dog.dentalProblem === true) {
        groundBoneOnly = true;
        warnings.push({
            conditionId: 'zuby-polykani',
            severity: 'CAUTION',
            textCs: 'Kvůli zubům nebo polykání vybíráme jen mleté kosti. Celé kosti a maso s celou kostí do nákupu nedáváme — pes by je nemusel rozkousat a hrozilo by udušení.',
            requiresVet: false,
        });
    }

    const stage = resolveLifeStage(dog.ageMonths);
    const isPuppy = stage === 'PUPPY_0_6' || stage === 'PUPPY_6_12' || stage === 'JUNIOR';
    if (dog.largeBreedPuppy === true && isPuppy) {
        requiresVet = true;
        warnings.push({
            conditionId: 'velke-plemeno-stene',
            severity: 'SERIOUS',
            textCs: 'Štěně velkého plemene roste rychle a jeho kosti jsou citlivé na poměr vápníku a fosforu v krmení. Dávku berte jako orientační a jídelníček prosím nechte zkontrolovat veterinářem.',
            requiresVet: true,
        });
    }

    if (dog.switchingFromKibble === true) {
        warnings.push({
            conditionId: 'prechod-z-granuli',
            severity: 'INFO',
            textCs: 'Při přechodu z granulí měňte stravu postupně a sledujte trávení. Začněte jedním druhem masa a další přidávejte, až si na něj pes zvykne.',
            requiresVet: false,
        });
    }

    return { ...c, warnings, groundBoneOnly, requiresVet };
}
