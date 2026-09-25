/**
 * Karta „Zuby a trávení" (klient Tutani 25. 9. 2026): údaje o psovi,
 * které nejsou nemocí, ale mění, co smíme doporučit. Fáze 1 = bez čísel.
 */
import { describe, expect, it } from 'vitest';
import { validateDoseRequest } from '../../src/api/validateInput.js';
import { applyDogProfileFlags } from '../../src/rules/applyDogProfileFlags.js';
import { matchProducts, type CatalogProduct } from '../../src/engine/product-matching/matchProducts.js';
import type { CompositionItem } from '../../src/engine/feeding-calculator/calculateDose.js';
import type { ResolvedConstraints } from '../../src/domain/health/Condition.js';
import type { DogProfile } from '../../src/domain/dog/DogProfile.js';

function body(dogOver: Record<string, unknown> = {}) {
    return {
        pes: {
            hmotnostKg: 24, vekMesicu: 36, pohlavi: 'MALE', kastrovany: false,
            aktivita: 'MEDIUM', kondice: 'IDEAL', fyziologickyStav: 'NONE',
            diagnozy: [], alergie: [], ...dogOver,
        },
    };
}
const EMPTY: ResolvedConstraints = {
    useIdealWeight: false, compositionLimits: [], excludedIngredientIds: new Set(),
    preferredIngredientIds: new Set(), productAttrFilters: [], warnings: [],
    blocked: false, blockedBy: [], requiresVet: false,
};
const DOG: DogProfile = {
    weightKg: 24, ageMonths: 36, sex: 'MALE', neutered: false, activity: 'MEDIUM',
    bodyCondition: 'IDEAL', physiologicalState: 'NONE', conditionIds: [], allergyIngredientIds: [],
} as DogProfile;

describe('validace', () => {
    it('přepínače chybí → false (zpětná kompatibilita)', () => {
        const r = validateDoseRequest(body(), 30);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.dog.dentalProblem).toBe(false);
            expect(r.value.dog.largeBreedPuppy).toBe(false);
            expect(r.value.dog.switchingFromKibble).toBe(false);
        }
    });
    it('přepínače se načtou', () => {
        const r = validateDoseRequest(body({ problemSeZuby: true, velkePlemenoStene: true, prechodZGranuli: true }), 30);
        expect(r.ok && r.value.dog.dentalProblem && r.value.dog.largeBreedPuppy && r.value.dog.switchingFromKibble).toBe(true);
    });
    it('ne-boolean hodnota = chyba vstupu, ne tiché true', () => {
        const r = validateDoseRequest(body({ problemSeZuby: 'ano' }), 30);
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.issues).toContainEqual({ field: 'pes.problemSeZuby', code: 'NOT_A_BOOLEAN' });
    });
});

describe('applyDogProfileFlags', () => {
    it('bez přepínačů nic nemění', () => {
        const r = applyDogProfileFlags(EMPTY, DOG);
        expect(r.warnings).toEqual([]);
        expect(r.groundBoneOnly).toBe(false);
        expect(r.requiresVet).toBe(false);
    });
    it('zuby → jen mleté kosti + upozornění, vstup nezměněn', () => {
        const r = applyDogProfileFlags(EMPTY, { ...DOG, dentalProblem: true });
        expect(r.groundBoneOnly).toBe(true);
        expect(r.warnings.map((w) => w.conditionId)).toEqual(['zuby-polykani']);
        expect(EMPTY.warnings).toEqual([]);
    });
    it('štěně velkého plemene → veterinář; u dospělého psa se ignoruje', () => {
        const stene = applyDogProfileFlags(EMPTY, { ...DOG, ageMonths: 5, largeBreedPuppy: true });
        expect(stene.requiresVet).toBe(true);
        expect(stene.warnings.map((w) => w.conditionId)).toEqual(['velke-plemeno-stene']);
        const dospely = applyDogProfileFlags(EMPTY, { ...DOG, ageMonths: 36, largeBreedPuppy: true });
        expect(dospely.warnings).toEqual([]);
    });
    it('přechod z granulí → jen informace, nic neblokuje', () => {
        const r = applyDogProfileFlags(EMPTY, { ...DOG, switchingFromKibble: true });
        expect(r.blocked).toBe(false);
        expect(r.warnings[0].conditionId).toBe('prechod-z-granuli');
    });
    it('blokaci z nemoci nikdy nezruší', () => {
        const r = applyDogProfileFlags({ ...EMPTY, blocked: true, blockedBy: ['cukrovka'], requiresVet: true }, { ...DOG, switchingFromKibble: true });
        expect(r.blocked).toBe(true);
        expect(r.requiresVet).toBe(true);
    });
});

describe('matchProducts: jen mleté kosti', () => {
    const BONE: CompositionItem[] = [{ group: 'BONE', labelCs: 'kosti', grams: 50, pct: 10, adjusted: false }];
    const prod = (sku: string, name: string, over: Partial<CatalogProduct> = {}): CatalogProduct => ({
        sku, name, url: '#', priceCzk: 100, packGrams: 1000, group: 'BONE', inStock: true,
        productId: '1', priceId: '10', ingredientIds: ['kure'], isCooked: false, ...over,
    });
    const krky = prod('KRKY', 'Kuřecí krky celé 1kg');
    const mlete = prod('MLETE', 'Barf Pašíkovy kosti mleté 1kg');

    it('bez problému se zuby se celé krky doporučit smí', () => {
        const r = matchProducts(BONE, [krky], EMPTY, 30);
        expect(r.products.map((p) => p.sku)).toEqual(['KRKY']);
    });
    it('s problémem se zuby se celé krky vyřadí s důvodem', () => {
        const r = matchProducts(BONE, [krky], { ...EMPTY, groundBoneOnly: true }, 30);
        expect(r.products).toEqual([]);
        expect(JSON.stringify(r.excluded)).toMatch(/KRKY[^}]*zub/);
    });
    it('s problémem se zuby mleté kosti projdou', () => {
        const r = matchProducts(BONE, [krky, mlete], { ...EMPTY, groundBoneOnly: true }, 30);
        expect(r.products.map((p) => p.sku)).toEqual(['MLETE']);
    });
    it('maso s kostí ve složení (MUSCLE + BONE část) se vyřadí, čisté maso ne', () => {
        const MUSCLE: CompositionItem[] = [{ group: 'MUSCLE', labelCs: 'maso', grams: 300, pct: 75, adjusted: false }];
        const r = matchProducts(MUSCLE, [
            prod('KRIDLA', 'Kuřecí křídla', { group: 'MUSCLE', compositionParts: [{ group: 'MUSCLE', pct: 70 }, { group: 'BONE', pct: 30 }] }),
            prod('SVALOVINA', 'Hovězí svalovina', { group: 'MUSCLE', ingredientIds: ['hovezi'] }),
        ], { ...EMPTY, groundBoneOnly: true }, 30);
        expect(r.products.map((p) => p.sku)).toEqual(['SVALOVINA']);
    });
});
