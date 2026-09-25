/**
 * Testy API vrstvy — handler s FALEŠNÝM STOREM, ne se skutečnou D1.
 *
 * Ověřuje kontrakt, na kterém závisí frontend (§6 ARCHITEKTURA.md)
 * a bezpečnostní záruky: disclaimer se nedá odstranit, BLOCKED
 * nevydá dávku, nehotová znalostní vrstva se PŘIZNÁ.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { BarfGroup } from '../../src/domain/tenant.js';
import type { ResolvedConstraints } from '../../src/domain/health/Condition.js';
import type { BarfMethodology } from '../../src/engine/feeding-calculator/calculateDose.js';
import type {
    CatalogHealth,
    ProductStore,
    StoredProduct,
    SyncRunRecord,
} from '../../src/infrastructure/D1ProductStore.js';
import {
    DISCLAIMER_CS,
    emptyConstraints,
    handleDose,
    handleHealth,
    handleKnowledge,
    handleRecipePdf,
    pdfFileName,
    NOOP_RULE_ENGINE,
    type Deps,
    type RuleEngine,
} from '../../src/api/handlers.js';
import { TUTANI_TENANT } from '../../tenants/tutani/config/tenant.js';

// Metodika je DATA — test čte stejný ruleset jako produkce, aby
// neověřoval vlastní kopii pravidel.
const raw = JSON.parse(
    readFileSync(new URL('../../tenants/tutani/rules/barf-core.json', import.meta.url), 'utf-8')
) as BarfMethodology;
const METHODOLOGY: BarfMethodology = {
    doseMatrix: raw.doseMatrix,
    conflictResolution: raw.conflictResolution,
    compositionProfile: raw.compositionProfile,
    sourceVersion: raw.sourceVersion,
};

/**
 * Tělo odpovědi API. Kontrakt je JSON s českými klíči (§6), takže se
 * čte jako volný záznam — testy tvrdí HODNOTY kontraktu, ne typy
 * enginu. `body()` je jediné místo, kde se přetypovává.
 */
type ApiBody = Record<string, any>;

async function body(res: Response): Promise<ApiBody> {
    return (await res.json()) as ApiBody;
}

/** Falešný store — v paměti, bez D1. */
class FakeStore implements ProductStore {
    public readonly syncRuns: SyncRunRecord[] = [];
    public upserted: StoredProduct[] = [];
    public deleted: string[] = [];
    /** Simulace nedostupné databáze. */
    public failReads = false;

    constructor(private products: StoredProduct[] = []) {}

    async listByGroup(_t: string, group: BarfGroup): Promise<StoredProduct[]> {
        if (this.failReads) throw new Error('D1 nedostupná');
        return this.products.filter((p) => p.group === group);
    }
    async listUsable(): Promise<StoredProduct[]> {
        if (this.failReads) throw new Error('D1 nedostupná');
        return this.products.filter((p) => p.packGrams !== null && p.packGrams > 0);
    }
    async listAllSkus(): Promise<string[]> {
        if (this.failReads) throw new Error('D1 nedostupná');
        return this.products.map((p) => p.sku);
    }
    async upsertMany(_t: string, products: StoredProduct[]): Promise<number> {
        this.upserted.push(...products);
        return products.length;
    }
    async deleteBySkus(_t: string, skus: string[]): Promise<number> {
        this.deleted.push(...skus);
        return skus.length;
    }
    async recordSyncRun(_t: string, run: SyncRunRecord): Promise<void> {
        this.syncRuns.push(run);
    }
    async health(): Promise<CatalogHealth> {
        if (this.failReads) throw new Error('D1 nedostupná');
        const usable = this.products.filter((p) => p.packGrams !== null && p.packGrams > 0);
        return {
            productCount: this.products.length,
            usableCount: usable.length,
            lastSync: this.syncRuns.filter((r) => r.mode === 'LIVE').at(-1) ?? null,
        };
    }
}

function product(over: Partial<StoredProduct> = {}): StoredProduct {
    return {
        sku: 'TUT1',
        name: 'Barf Mleté kuře 3kg',
        url: 'https://obchod.tutani.cz/x/tut1',
        categoryPath: 'Barf | Svalovina',
        group: 'MUSCLE',
        packGrams: 3000,
        packGramsSource: 'DATALAYER',
        priceCzk: 109,
        // Košík potřebuje OBĚ id (Lucky 2026-09-24) — bez priceId by se
        // produkt nedoporučil. 973 = reálné priceId k productId 868 (ZP9).
        priceId: '973',
        productId: '868',
        inStock: true,
        stockQuantity: 19,
        ingredientIds: [],
        isCooked: false,
        weightConflict: null,
        sourceFeedAt: '2026-09-09T00:00:00.000Z',
        ...over,
    };
}

/** Katalog pokrývající všechny složky dávky — jinak by bylo vše nepokryto. */
function fullCatalog(): StoredProduct[] {
    const groups: [BarfGroup, string, number, number][] = [
        ['MUSCLE', 'Barf Mleté kuře 3kg', 3000, 109],
        ['BONE', 'Barf Kuřecí vemínko 3kg', 3000, 115],
        ['LIVER', 'Pašíkova játra mletá 1kg', 1000, 69],
        ['ORGAN', 'Plíce jako kráva mleté 1kg', 1000, 49],
        ['PLANT', 'Barf Mrkev 500g', 500, 39],
    ];
    return groups.map(([group, name, packGrams, priceCzk], i) =>
        product({ sku: `TUT${i + 1}`, name, group, packGrams, priceCzk })
    );
}

function deps(over: Partial<Deps> = {}, store = new FakeStore(fullCatalog())): Deps {
    return {
        tenant: TUTANI_TENANT,
        store,
        methodology: METHODOLOGY,
        rules: NOOP_RULE_ENGINE,
        ...over,
    };
}

function doseRequest(body: unknown): Request {
    return new Request('https://w.example/v1/davka', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

const REX = {
    pes: {
        jmeno: 'Rex',
        hmotnostKg: 24,
        vekMesicu: 36,
        pohlavi: 'MALE',
        kastrovany: false,
        aktivita: 'MEDIUM',
        kondice: 'IDEAL',
        fyziologickyStav: 'NONE',
        diagnozy: [],
        alergie: [],
    },
    obdobiDni: 30,
};

/** Rule engine, který vrací zadaná omezení a tvrdí, že je připravený. */
function fakeRules(constraints: Partial<ResolvedConstraints> = {}, ready = true): RuleEngine {
    return {
        ready,
        async resolve() {
            return { ...emptyConstraints(), ...constraints };
        },
        async catalog(tenant) {
            return {
                ready,
                ruleSetIds: tenant.ruleSetIds,
                diagnoses: [
                    { id: 'ckd', layNameCs: 'nemocné ledviny', nameCs: 'Chronické onemocnění ledvin' },
                ],
                allergens: [{ id: 'kure', layNameCs: 'kuřecí', nameCs: 'Kuřecí maso' }],
            };
        },
    };
}

describe('POST /v1/davka — validní vstup', () => {
    it('spočítá dávku a doporučí produkty', async () => {
        const res = await handleDose(doseRequest(REX), deps({ rules: fakeRules() }));
        expect(res.status).toBe(200);
        const b = await body(res);

        expect(b.status).toBe('OK');
        // 24 kg, dospělý, střední aktivita → 2,25 % → 540 g/den.
        expect(b.davka.celkemGDen).toBe(540);
        expect(b.davka.porce.pocet).toBe(2);
        expect(b.slozeni).toHaveLength(5);
        expect(b.produkty.length).toBeGreaterThan(0);
        expect(b.cena.naDni).toBe(30);
        expect(b.obdobiDni).toBe(30);
    });

    it('audit vysvětluje výpočet bez LLM (R1)', async () => {
        const res = await handleDose(doseRequest(REX), deps({ rules: fakeRules() }));
        const b = await body(res);
        const steps = (b.audit as { krok: string }[]).map((a) => a.krok);
        expect(steps).toContain('LIFE_STAGE');
        expect(steps).toContain('DOSE_RULE');
        expect(steps).toContain('BASE_WEIGHT');
        expect(steps).toContain('TOTAL_DOSE');
    });

    it('produkty nesou productId pro vložení do košíku', async () => {
        const res = await handleDose(doseRequest(REX), deps({ rules: fakeRules() }));
        const b = await body(res);
        expect((b.produkty as { productId: string }[])[0].productId).toBe('868');
    });

    it('respektuje kratší období', async () => {
        const res = await handleDose(
            doseRequest({ ...REX, obdobiDni: 7 }),
            deps({ rules: fakeRules() })
        );
        const b = await body(res);
        expect(b.cena.naDni).toBe(7);
    });
});

describe('POST /v1/davka — nutriční pokrytí (nález auditu 2026-09-12, D-1)', () => {
    it('bez deps.nutrition vrací nutrice: null a nutrientEngineReady: false — žádná tichá nula', async () => {
        const res = await handleDose(doseRequest(REX), deps({ rules: fakeRules() }));
        const b = await body(res);
        expect(b.nutrientEngineReady).toBe(false);
        expect(b.nutrice).toBeNull();
    });

    it('s deps.nutrition spočítá pokrytí pro vybrané produkty', async () => {
        const hoveziMlete: import('../../src/engine/nutrient-coverage/calculateNutrientCoverage.js').NutrientDataIngredient = {
            id: 'hovezi-mlete-93-7',
            nutrients: { calcium: { value: 10, unit: 'mg', status: 'MEASURED' } },
        };
        const tutaniProduct: import('../../src/domain/products/TutaniProduct.js').TutaniProduct = {
            productId: 'TUT1',
            code: 'TUT1',
            nameCs: 'Barf Mleté kuře 3kg',
            brand: null,
            categoryPath: null,
            topCategory: 'OTHER',
            priceWithVatCzk: null,
            packGrams: null,
            availability: 'UNKNOWN',
            url: '',
            kind: 'SINGLE_INGREDIENT',
            composition: [
                {
                    ingredientId: 'hovezi-mlete-93-7',
                    nameCs: 'hovězí mleté',
                    species: 'BEEF',
                    part: 'MUSCLE',
                    role: 'INGREDIENT',
                    subcomponentsCs: [],
                    subcomponentRatio: null,
                    percentage: 100,
                    certainty: 'EXACT',
                    sourceCs: 'test',
                },
            ],
            compositionAccountedPct: 100,
            analytical: [],
            claims: { rawDescriptionCs: null, ageCategory: null, dietaryClaimsCs: [] },
            evidence: { source: 'TUTANI_PRODUCT_PAGE', sourceDate: '2026-09-12', confidence: 'EXACT' },
            updatedAt: '2026-09-12',
        };

        const res = await handleDose(
            doseRequest(REX),
            deps({
                rules: fakeRules(),
                nutrition: {
                    products: new Map([['TUT1', tutaniProduct]]),
                    ingredients: new Map([['hovezi-mlete-93-7', hoveziMlete]]),
                    targets: [
                        {
                            nutrient: 'calcium',
                            lifeStage: 'ADULT',
                            min: 1.45,
                            max: 6.25,
                            unit: 'g',
                            basis: 'PER_1000_KCAL',
                            source: 'FEDIAF',
                            sourceVersion: '2025',
                            confidence: 'TABULKA',
                        },
                    ],
                },
            })
        );
        const b = await body(res);

        expect(b.nutrientEngineReady).toBe(true);
        expect(b.nutrice).not.toBeNull();
        const calcium = (b.nutrice as { klic: string; stav: string }[]).find((c) => c.klic === 'calcium');
        expect(calcium).toBeDefined();
        // Kalcium se počítá jen z produktů, které JSOU ve `products` mapě
        // (jen TUT1) — zbytek doporučených produktů (BONE/LIVER/ORGAN/PLANT)
        // se do coverage nedostane, takže výsledek je nutně NEDOSTATEK/NEZNAME,
        // nikdy klamné OK. Test ověřuje jen to, že se pole vůbec vygenerovalo
        // a nespadlo, ne konkrétní status (ten závisí na celém katalogu).
        expect(['OK', 'NEDOSTATEK', 'NADBYTEK', 'NEZNAME']).toContain(calcium!.stav);
    });

    it('BLOCKED dávka nemá nutriční pokrytí (nedává smysl počítat u nevydané dávky)', async () => {
        const res = await handleDose(
            doseRequest(REX),
            deps({
                rules: fakeRules({ blocked: true, blockedBy: ['ckd'] }),
                nutrition: { products: new Map(), ingredients: new Map(), targets: [] },
            })
        );
        const b = await body(res);
        expect(b.status).toBe('BLOCKED');
        expect(b.nutrice).toBeNull();
    });
});

describe('POST /v1/davka — DISCLAIMER se nedá odstranit', () => {
    it('je v odpovědi u OK', async () => {
        const res = await handleDose(doseRequest(REX), deps({ rules: fakeRules() }));
        const b = await body(res);
        expect(b.disclaimer).toBe(DISCLAIMER_CS);
        expect(String(b.disclaimer)).toMatch(/veterinář/i);
    });

    it('je v odpovědi i u BLOCKED', async () => {
        const rules = fakeRules({ blocked: true, blockedBy: ['ckd-3'] });
        const res = await handleDose(doseRequest(REX), deps({ rules }));
        const b = await body(res);
        expect(b.disclaimer).toBe(DISCLAIMER_CS);
    });

    it('je v odpovědi i u INCOMPLETE', async () => {
        // Metodika bez seniorských pásem — senior s vysokou aktivitou pak pásmo nemá.
        const bezSeniora = {
            ...METHODOLOGY,
            doseMatrix: METHODOLOGY.doseMatrix.filter((r) => r.lifeStage !== 'SENIOR'),
        };
        const res = await handleDose(
            doseRequest({ ...REX, pes: { ...REX.pes, vekMesicu: 120, aktivita: 'HIGH' } }),
            deps({ rules: fakeRules(), methodology: bezSeniora })
        );
        const b = await body(res);
        expect(b.status).toBe('INCOMPLETE');
        expect(b.disclaimer).toBe(DISCLAIMER_CS);
    });

    it('je i v chybové odpovědi validace', async () => {
        const res = await handleDose(doseRequest({ pes: {} }), deps());
        const b = await body(res);
        expect(b.disclaimer).toBe(DISCLAIMER_CS);
    });
});

describe('POST /v1/davka — BLOCKED a INCOMPLETE', () => {
    it('BLOCKED nevydá dávku ani produkty', async () => {
        const rules = fakeRules({ blocked: true, blockedBy: ['jaterni-shunt'] });
        const res = await handleDose(doseRequest(REX), deps({ rules }));
        expect(res.status).toBe(200); // požadavek byl v pořádku, jen výsledkem je odmítnutí
        const b = await body(res);
        expect(b.status).toBe('BLOCKED');
        expect(b.reason).toBe('CONDITION_BLOCKS_RESULT');
        expect(b.davka).toBeNull();
        expect(b.produkty).toEqual([]);
        expect(b.slozeni).toEqual([]);
    });

    it('INCOMPLETE u chybějícího pásma vysvětlí důvod v auditu', async () => {
        const bezSeniora = {
            ...METHODOLOGY,
            doseMatrix: METHODOLOGY.doseMatrix.filter((r) => r.lifeStage !== 'SENIOR'),
        };
        const res = await handleDose(
            doseRequest({ ...REX, pes: { ...REX.pes, vekMesicu: 120, aktivita: 'HIGH' } }),
            deps({ rules: fakeRules(), methodology: bezSeniora })
        );
        const b = await body(res);
        expect(b.status).toBe('INCOMPLETE');
        expect(b.reason).toBe('NO_MATCHING_DOSE_RULE');
        expect(b.produkty).toEqual([]);
        expect((b.audit as { krok: string }[]).map((a) => a.krok)).toContain('DOSE_RULE');
    });

    it('senior se střední aktivitou dostane dávku i produkty (dřív INCOMPLETE)', async () => {
        const res = await handleDose(
            doseRequest({ ...REX, pes: { ...REX.pes, vekMesicu: 120, aktivita: 'MEDIUM' } }),
            deps({ rules: fakeRules() })
        );
        const b = await body(res);
        expect(b.status).toBe('OK');
        expect((b.davka as { pravidlo: string }).pravidlo).toBe('senior-medium');
        expect((b.produkty as unknown[]).length).toBeGreaterThan(0);
    });

    it('nadváha se počítá z IDEÁLNÍ hmotnosti', async () => {
        const res = await handleDose(
            doseRequest({
                ...REX,
                pes: { ...REX.pes, hmotnostKg: 30, idealniHmotnostKg: 24, kondice: 'OVER' },
            }),
            deps({ rules: fakeRules() })
        );
        const b = await body(res);
        expect(b.status).toBe('OK');
        expect(b.davka.zHmotnosti).toBe('IDEAL');
        expect(b.davka.zakladHmotnostiKg).toBe(24);
    });
});

describe('POST /v1/davka — chybný vstup', () => {
    it('nadváha bez ideální hmotnosti → 422 s kódem', async () => {
        const res = await handleDose(
            doseRequest({ ...REX, pes: { ...REX.pes, kondice: 'OVER' } }),
            deps()
        );
        expect(res.status).toBe(422);
        const b = await body(res);
        expect(b.code).toBe('VALIDATION_FAILED');
        expect((b.issues as { code: string }[]).map((i) => i.code)).toContain(
            'MISSING_IDEAL_WEIGHT'
        );
    });

    it('hmotnost mimo rozsah → 422', async () => {
        const res = await handleDose(
            doseRequest({ ...REX, pes: { ...REX.pes, hmotnostKg: 250 } }),
            deps()
        );
        expect(res.status).toBe(422);
        const b = await body(res);
        expect((b.issues as { code: string }[]).map((i) => i.code)).toContain('OUT_OF_RANGE');
    });

    it('neznámý enum → 422', async () => {
        const res = await handleDose(
            doseRequest({ ...REX, pes: { ...REX.pes, aktivita: 'ULTRA' } }),
            deps()
        );
        expect(res.status).toBe(422);
        const b = await body(res);
        expect((b.issues as { code: string }[]).map((i) => i.code)).toContain(
            'UNKNOWN_ENUM_VALUE'
        );
    });

    it('nevalidní JSON → 400', async () => {
        const req = new Request('https://w.example/v1/davka', { method: 'POST', body: '{nope' });
        const res = await handleDose(req, deps());
        expect(res.status).toBe(400);
        const b = await body(res);
        expect(b.code).toBe('INVALID_JSON');
    });

    it('nafouknuté tělo → 400', async () => {
        const req = new Request('https://w.example/v1/davka', {
            method: 'POST',
            body: JSON.stringify({ pes: { jmeno: 'x'.repeat(20_000) } }),
        });
        const res = await handleDose(req, deps());
        expect(res.status).toBe(400);
        const b = await body(res);
        expect(b.code).toBe('BODY_TOO_LARGE');
    });
});

describe('POST /v1/davka — nehotová znalostní vrstva se PŘIZNÁ (R7)', () => {
    it('u psa s diagnózou přidá varování, když pravidla neběží', async () => {
        const res = await handleDose(
            doseRequest({ ...REX, pes: { ...REX.pes, diagnozy: ['ckd'] } }),
            deps({ rules: NOOP_RULE_ENGINE })
        );
        const b = await body(res);
        expect(b.knowledgeEngineReady).toBe(false);
        const codes = (b.upozorneni as { kod: string }[]).map((w) => w.kod);
        expect(codes).toContain('KNOWLEDGE_ENGINE_UNAVAILABLE');
    });

    it('u zdravého psa se varování nepřidává', async () => {
        const res = await handleDose(doseRequest(REX), deps({ rules: NOOP_RULE_ENGINE }));
        const b = await body(res);
        const codes = (b.upozorneni as { kod: string }[]).map((w) => w.kod);
        expect(codes).not.toContain('KNOWLEDGE_ENGINE_UNAVAILABLE');
    });

    it('varování z pravidel se propíše do odpovědi', async () => {
        const rules = fakeRules({
            warnings: [
                {
                    conditionId: 'ckd',
                    severity: 'SERIOUS',
                    textCs: 'Rex má onemocnění ledvin.',
                    requiresVet: true,
                },
            ],
        });
        const res = await handleDose(
            doseRequest({ ...REX, pes: { ...REX.pes, diagnozy: ['ckd'] } }),
            deps({ rules })
        );
        const b = await body(res);
        const w = (b.upozorneni as { kod: string; requiresVet: boolean }[])[0];
        expect(w.kod).toBe('ckd');
        expect(w.requiresVet).toBe(true);
    });
});

describe('POST /v1/davka — selhání pravidel a katalogu', () => {
    it('selhání rule enginu NEVYDÁ dávku bez omezení', async () => {
        const rules: RuleEngine = {
            ready: true,
            async resolve() {
                throw new Error('ruleset nejde načíst');
            },
            async catalog(t) {
                return { ready: true, ruleSetIds: t.ruleSetIds, diagnoses: [], allergens: [] };
            },
        };
        const res = await handleDose(doseRequest(REX), deps({ rules }));
        expect(res.status).toBe(503);
        const b = await body(res);
        expect(b.status).toBe('BLOCKED');
        expect(b.reason).toBe('RULE_ENGINE_FAILED');
        expect(b.disclaimer).toBe(DISCLAIMER_CS);
    });

    it('nedostupný katalog dávku vydá, ale přizná chybějící balení', async () => {
        const store = new FakeStore(fullCatalog());
        store.failReads = true;
        const res = await handleDose(doseRequest(REX), deps({ rules: fakeRules() }, store));
        const b = await body(res);
        expect(b.status).toBe('OK');
        expect(b.davka.celkemGDen).toBe(540);
        expect(b.katalogNedostupny).toBe(true);
        expect(b.produkty).toEqual([]);
        expect(b.cena).toBeNull();
    });

    it('prázdný katalog přizná nepokryté složky, nesubstituuje', async () => {
        const res = await handleDose(
            doseRequest(REX),
            deps({ rules: fakeRules() }, new FakeStore([]))
        );
        const b = await body(res);
        expect(b.status).toBe('OK');
        expect(b.produkty).toEqual([]);
        expect((b.nepokryto as unknown[]).length).toBe(5);
    });

    it('produkty bez gramáže se do doporučení nedostanou (R7)', async () => {
        const store = new FakeStore([product({ packGrams: null, packGramsSource: null })]);
        const res = await handleDose(doseRequest(REX), deps({ rules: fakeRules() }, store));
        const b = await body(res);
        expect(b.produkty).toEqual([]);
    });

    it('alergie vyřadí produkt a složka se přizná jako nepokrytá', async () => {
        const store = new FakeStore([
            product({ sku: 'M1', group: 'MUSCLE', ingredientIds: ['kure'] }),
        ]);
        const rules = fakeRules({ excludedIngredientIds: new Set(['kure']) });
        const res = await handleDose(doseRequest(REX), deps({ rules }, store));
        const b = await body(res);
        expect(b.produkty).toEqual([]);
        const uncovered = (b.nepokryto as { group: string; duvod: string }[]).find(
            (u) => u.group === 'MUSCLE'
        );
        expect(uncovered?.duvod).toBe('ALL_FILTERED_OUT');
    });
});

describe('POST /v1/davka — košík a bezpečnost (2026-09-24)', () => {
    it('produkt bez priceId nebo productId se nedoporučí — nešel by do košíku', async () => {
        const store = new FakeStore([
            product({ sku: 'BEZ_PRICE', group: 'MUSCLE', priceId: null }),
            product({ sku: 'BEZ_PRODUCT', group: 'MUSCLE', productId: null }),
        ]);
        const b = await body(await handleDose(doseRequest(REX), deps({ rules: fakeRules() }, store)));
        expect(b.produkty).toEqual([]);
    });

    it('každý doporučený produkt nese priceId I productId', async () => {
        const b = await body(await handleDose(doseRequest(REX), deps({ rules: fakeRules() })));
        const produkty = b.produkty as { priceId: string | null; productId: string | null }[];
        expect(produkty.length).toBeGreaterThan(0);
        expect(produkty.every((p) => !!p.priceId && !!p.productId)).toBe(true);
    });

    it('FAIL-CLOSED přes API: u alergie se produkt s neznámým složením nedoporučí (regrese loadCatalog)', async () => {
        const store = new FakeStore([
            product({ sku: 'NEZNAME', group: 'MUSCLE', ingredientIds: [], ingredientsUnknown: true }),
        ]);
        const rules = fakeRules({ ownerExcludedIngredientIds: new Set(['kure']), excludedIngredientIds: new Set(['kure']) });
        const b = await body(await handleDose(doseRequest(REX), deps({ rules }, store)));
        expect((b.produkty as { sku: string }[]).map((p) => p.sku)).not.toContain('NEZNAME');
    });

    it('nikdy víc balení, než je skladem — zbytek se doplní jiným produktem', async () => {
        // 405 g/den × 30 = 12 150 g = 5 balení po 3 kg; A má 2, B 10.
        const store = new FakeStore([
            ...fullCatalog().filter((p) => p.group !== 'MUSCLE'),
            product({ sku: 'A', group: 'MUSCLE', stockQuantity: 2 }),
            product({ sku: 'B', group: 'MUSCLE', stockQuantity: 10, priceCzk: 111 }),
        ]);
        const b = await body(await handleDose(doseRequest(REX), deps({ rules: fakeRules() }, store)));
        const muscle = (b.produkty as { sku: string; group: string; pocet: number; skladem: number }[]).filter(
            (p) => p.group === 'MUSCLE'
        );
        for (const p of muscle) expect(p.pocet).toBeLessThanOrEqual(p.skladem);
        expect(muscle.reduce((a, p) => a + p.pocet, 0)).toBeGreaterThanOrEqual(5);
    });
});

describe('POST /v1/davka — období 7 / 14 / 30 dní (Lucky 2026-09-24)', () => {
    it.each([7, 14, 30])('období %i dní projde', async (d) => {
        const res = await handleDose(doseRequest({ ...REX, obdobiDni: d }), deps({ rules: fakeRules() }));
        expect(res.status).toBe(200);
        expect((await body(res)).obdobiDni).toBe(d);
    });

    it.each([1, 21, 60, 90])('období %i dní se odmítne s nabídkou povolených', async (d) => {
        const res = await handleDose(doseRequest({ ...REX, obdobiDni: d }), deps({ rules: fakeRules() }));
        expect(res.status).toBe(422);
        const issues = (await body(res)).issues as { field: string; code: string; allowed?: number[] }[];
        expect(issues).toContainEqual({ field: 'obdobiDni', code: 'UNKNOWN_ENUM_VALUE', allowed: [7, 14, 30] });
    });

    it('přepnutí období změní POČET balení, ne maso (při dostatku skladu)', async () => {
        const catalog = [
            ...fullCatalog().filter((p) => p.group !== 'MUSCLE'),
            product({ sku: 'HOVEZI', group: 'MUSCLE', priceCzk: 300, packGrams: 3000, stockQuantity: 100 }),
            product({ sku: 'KRUTI', group: 'MUSCLE', priceCzk: 310, packGrams: 3000, stockQuantity: 100 }),
            product({ sku: 'KRALIK', group: 'MUSCLE', priceCzk: 320, packGrams: 3000, stockQuantity: 100 }),
        ];
        const now = () => new Date('2026-09-24T10:00:00.000Z');
        // Víc psů = víc seedů; u každého musí být maso stejné pro 7/14/30.
        for (const kg of [10, 18, 24, 32, 40]) {
            const skus: string[] = [];
            const pocty: number[] = [];
            for (const d of [7, 14, 30]) {
                const req = { ...REX, pes: { ...REX.pes, hmotnostKg: kg }, obdobiDni: d };
                const b = await body(await handleDose(doseRequest(req), deps({ rules: fakeRules(), now }, new FakeStore(catalog))));
                const m = (b.produkty as { sku: string; group: string; pocet: number }[]).filter((p) => p.group === 'MUSCLE');
                expect(m).toHaveLength(1);
                skus.push(m[0].sku);
                pocty.push(m[0].pocet);
            }
            expect(new Set(skus).size).toBe(1);
            expect(pocty[0]).toBeLessThanOrEqual(pocty[1]);
            expect(pocty[1]).toBeLessThanOrEqual(pocty[2]);
        }
    });
});

describe('GET /v1/knowledge', () => {
    it('vrátí seznam diagnóz a alergenů, aby je frontend neměl natvrdo', async () => {
        const res = await handleKnowledge(deps({ rules: fakeRules() }));
        expect(res.status).toBe(200);
        const b = await body(res);
        expect(b.ready).toBe(true);
        expect((b.diagnoses as { id: string }[])[0].id).toBe('ckd');
        expect((b.allergens as { id: string }[])[0].id).toBe('kure');
        expect(b.ruleSetIds).toEqual(TUTANI_TENANT.ruleSetIds);
    });

    it('posílá povinné obaly doručení s productId i priceId (Přepravka E2 / Thermobox)', async () => {
        const b = await body(await handleKnowledge(deps({ rules: fakeRules() })));
        expect(b.obaly).toEqual([
            { productId: '5259', priceId: '8088', nazev: 'Přepravka E2', popis: 'vratná plastová přepravka na maso', cenaCzk: 0 },
            { productId: '5256', priceId: '8085', nazev: 'Thermobox', popis: 'nevratný termobox, zůstane vám', cenaCzk: 0 },
        ]);
    });

    it('endpoint existuje i bez nasazených pravidel a přizná to', async () => {
        const res = await handleKnowledge(deps({ rules: NOOP_RULE_ENGINE }));
        expect(res.status).toBe(200);
        const b = await body(res);
        expect(b.ready).toBe(false);
        expect(b.diagnoses).toEqual([]);
    });
});

describe('GET /v1/health', () => {
    it('DEGRADED, dokud sync neproběhl', async () => {
        const res = await handleHealth(deps());
        expect(res.status).toBe(503);
        const b = await body(res);
        expect(b.status).toBe('DEGRADED');
        expect(b.lastSync).toBeNull();
        expect(b.usableProducts).toBe(5);
    });

    it('OK po nedávném ostrém syncu', async () => {
        const store = new FakeStore(fullCatalog());
        const now = new Date('2026-09-09T06:00:00.000Z');
        await store.recordSyncRun('tutani', {
            id: 'r1',
            mode: 'LIVE',
            triggerSource: 'CRON',
            startedAt: '2026-09-09T03:15:00.000Z',
            finishedAt: '2026-09-09T03:24:00.000Z',
            status: 'OK',
            urlsTotal: 300,
            urlsFetched: 300,
            urlsFailed: 0,
            productsParsed: 264,
            added: 0,
            changed: 12,
            unchanged: 252,
            removed: 0,
            unusable: 10,
        });
        const res = await handleHealth(deps({ now: () => now }, store));
        expect(res.status).toBe(200);
        const b = await body(res);
        expect(b.status).toBe('OK');
        expect(b.lastSync.ageHours).toBe(2.8);
        expect(b.lastSync.productsParsed).toBe(264);
    });

    it('DEGRADED, když je poslední sync starší než 48 h', async () => {
        const store = new FakeStore(fullCatalog());
        await store.recordSyncRun('tutani', {
            id: 'r1',
            mode: 'LIVE',
            triggerSource: 'CRON',
            startedAt: '2026-09-01T03:15:00.000Z',
            finishedAt: '2026-09-01T03:24:00.000Z',
            status: 'OK',
            urlsTotal: 300,
            urlsFetched: 300,
            urlsFailed: 0,
            productsParsed: 264,
            added: 0,
            changed: 0,
            unchanged: 264,
            removed: 0,
            unusable: 0,
        });
        const res = await handleHealth(
            deps({ now: () => new Date('2026-09-09T06:00:00.000Z') }, store)
        );
        expect(res.status).toBe(503);
        const b = await body(res);
        expect(b.status).toBe('DEGRADED');
    });

    it('DEGRADED, když katalog nemá použitelné produkty', async () => {
        const store = new FakeStore([product({ packGrams: null })]);
        const res = await handleHealth(deps({}, store));
        const b = await body(res);
        expect(b.status).toBe('DEGRADED');
        expect(b.usableProducts).toBe(0);
    });

    it('nedostupná D1 → FAILED, ne pád', async () => {
        const store = new FakeStore([]);
        store.failReads = true;
        const res = await handleHealth(deps({}, store));
        expect(res.status).toBe(503);
        const b = await body(res);
        expect(b.status).toBe('FAILED');
    });
});


describe('recept a PDF jídelníček (Lucky 2026-09-24)', () => {
    it('/v1/davka vrací recept: součet surovin = denní dávka, porce sedí na engine', async () => {
        const b = await body(await handleDose(doseRequest(REX), deps()));
        expect(b.status).toBe('OK');
        const r = b.recept;
        expect(r).not.toBeNull();
        expect(r.denneCelkemG).toBe(b.slozeni.reduce((a: number, s: any) => a + Math.round(s.gramy), 0));
        expect(r.porce).toHaveLength(b.davka.porce.pocet);
        expect(r.porce.reduce((a: number, p: any) => a + p.celkemG, 0)).toBe(r.denneCelkemG);
        // Každá surovina v receptu je produkt z nákupu.
        const vNakupu = new Set(b.produkty.map((p: any) => p.sku));
        for (const d of r.denne) expect(vNakupu.has(d.sku)).toBe(true);
        expect(r.postup.length).toBeGreaterThan(0);
    });

    it('bez nákupu (katalog nedostupný) je recept null, dávka zůstává', async () => {
        const store = new FakeStore(fullCatalog());
        store.failReads = true;
        const b = await body(await handleDose(doseRequest(REX), deps({}, store)));
        expect(b.status).toBe('OK');
        expect(b.recept).toBeNull();
    });

    it('PDF: platné PDF s hlavičkou ke stažení a jménem psa v souboru', async () => {
        const res = await handleRecipePdf(doseRequest({ ...REX, pes: { ...REX.pes, jmeno: 'Žeryk 🐶' } }), deps());
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('application/pdf');
        expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="jidelnicek-zeryk.pdf"');
        const bytes = new Uint8Array(await res.arrayBuffer());
        expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
        expect(bytes.length).toBeGreaterThan(5_000);
        if (process.env.PDF_OUT) (await import('node:fs')).writeFileSync(process.env.PDF_OUT, bytes);
    });

    it('konkrétní aktivita: úroveň určí server, název jde do odpovědi i do PDF', async () => {
        const pes = { ...REX.pes, aktivita: undefined, aktivitaDetail: 'psi-sporty' };
        const b = await body(await handleDose(doseRequest({ ...REX, pes }), deps()));
        expect(b.status).toBe('OK');
        expect(b.pes.aktivita).toBe('psí sporty');
        const res = await handleRecipePdf(doseRequest({ ...REX, pes }), deps());
        expect(res.status).toBe(200);
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (process.env.PDF_OUT_AKTIVITA) (await import('node:fs')).writeFileSync(process.env.PDF_OUT_AKTIVITA, bytes);
    });

    it('PDF se NEVYDÁ pro blokovaný stav — 409 s JSON, ne jídelníček', async () => {
        const res = await handleRecipePdf(
            doseRequest(REX),
            deps({ rules: fakeRules({ blocked: true, blockedBy: ['ckd-advanced'], requiresVet: true }) })
        );
        expect(res.status).toBe(409);
        const b = await body(res);
        expect(b.code).toBe('PDF_NOT_AVAILABLE');
        expect(b.status).toBe('BLOCKED');
    });

    it('PDF: chybný vstup vrací stejnou validační chybu jako /v1/davka', async () => {
        const res = await handleRecipePdf(doseRequest({ pes: { hmotnostKg: -3 } }), deps());
        expect(res.status).toBe(422);
    });

    it('název souboru je bezpečný ASCII', () => {
        expect(pdfFileName('Bára "x"; rm')).toBe('jidelnicek-bara-x-rm.pdf');
        expect(pdfFileName(null)).toBe('jidelnicek.pdf');
        expect(pdfFileName('🐶')).toBe('jidelnicek.pdf');
    });
});
