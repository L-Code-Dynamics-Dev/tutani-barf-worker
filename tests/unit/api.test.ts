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
    NOOP_RULE_ENGINE,
    type Deps,
    type RuleEngine,
} from '../../src/api/handlers.js';
import { TUTANI_TENANT } from '../../tenants/tutani/config/tenant.js';

// Metodika je DATA — test čte stejný ruleset jako produkce, aby
// neověřoval vlastní kopii pravidel.
const raw = JSON.parse(
    readFileSync(new URL('../../tenants/tutani/rules/barf-core.json', import.meta.url), 'utf-8')
) as Record<string, never>;
const METHODOLOGY: BarfMethodology = {
    doseMatrix: raw.doseMatrix,
    conflictResolution: raw.conflictResolution,
    compositionProfile: raw.compositionProfile,
    sourceVersion: raw.sourceVersion,
};

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
        priceId: null,
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
        const body = (await res.json()) as Record<string, never>;

        expect(body.status).toBe('OK');
        // 24 kg, dospělý, střední aktivita → 2,25 % → 540 g/den.
        expect(body.davka.celkemGDen).toBe(540);
        expect(body.davka.porce.pocet).toBe(2);
        expect(body.slozeni).toHaveLength(5);
        expect(body.produkty.length).toBeGreaterThan(0);
        expect(body.cena.naDni).toBe(30);
        expect(body.obdobiDni).toBe(30);
    });

    it('audit vysvětluje výpočet bez LLM (R1)', async () => {
        const res = await handleDose(doseRequest(REX), deps({ rules: fakeRules() }));
        const body = (await res.json()) as Record<string, never>;
        const steps = (body.audit as { krok: string }[]).map((a) => a.krok);
        expect(steps).toContain('LIFE_STAGE');
        expect(steps).toContain('DOSE_RULE');
        expect(steps).toContain('BASE_WEIGHT');
        expect(steps).toContain('TOTAL_DOSE');
    });

    it('produkty nesou productId pro vložení do košíku', async () => {
        const res = await handleDose(doseRequest(REX), deps({ rules: fakeRules() }));
        const body = (await res.json()) as Record<string, never>;
        expect((body.produkty as { productId: string }[])[0].productId).toBe('868');
    });

    it('respektuje kratší období', async () => {
        const res = await handleDose(
            doseRequest({ ...REX, obdobiDni: 7 }),
            deps({ rules: fakeRules() })
        );
        const body = (await res.json()) as Record<string, never>;
        expect(body.cena.naDni).toBe(7);
    });
});

describe('POST /v1/davka — DISCLAIMER se nedá odstranit', () => {
    it('je v odpovědi u OK', async () => {
        const res = await handleDose(doseRequest(REX), deps({ rules: fakeRules() }));
        const body = (await res.json()) as Record<string, never>;
        expect(body.disclaimer).toBe(DISCLAIMER_CS);
        expect(String(body.disclaimer)).toMatch(/veterinář/i);
    });

    it('je v odpovědi i u BLOCKED', async () => {
        const rules = fakeRules({ blocked: true, blockedBy: ['ckd-3'] });
        const res = await handleDose(doseRequest(REX), deps({ rules }));
        const body = (await res.json()) as Record<string, never>;
        expect(body.disclaimer).toBe(DISCLAIMER_CS);
    });

    it('je v odpovědi i u INCOMPLETE', async () => {
        // Senior s vysokou aktivitou — v metodice pro něj pásmo není.
        const res = await handleDose(
            doseRequest({ ...REX, pes: { ...REX.pes, vekMesicu: 120, aktivita: 'HIGH' } }),
            deps({ rules: fakeRules() })
        );
        const body = (await res.json()) as Record<string, never>;
        expect(body.status).toBe('INCOMPLETE');
        expect(body.disclaimer).toBe(DISCLAIMER_CS);
    });

    it('je i v chybové odpovědi validace', async () => {
        const res = await handleDose(doseRequest({ pes: {} }), deps());
        const body = (await res.json()) as Record<string, never>;
        expect(body.disclaimer).toBe(DISCLAIMER_CS);
    });
});

describe('POST /v1/davka — BLOCKED a INCOMPLETE', () => {
    it('BLOCKED nevydá dávku ani produkty', async () => {
        const rules = fakeRules({ blocked: true, blockedBy: ['jaterni-shunt'] });
        const res = await handleDose(doseRequest(REX), deps({ rules }));
        expect(res.status).toBe(200); // požadavek byl v pořádku, jen výsledkem je odmítnutí
        const body = (await res.json()) as Record<string, never>;
        expect(body.status).toBe('BLOCKED');
        expect(body.reason).toBe('CONDITION_BLOCKS_RESULT');
        expect(body.davka).toBeNull();
        expect(body.produkty).toEqual([]);
        expect(body.slozeni).toEqual([]);
    });

    it('INCOMPLETE u chybějícího pásma vysvětlí důvod v auditu', async () => {
        const res = await handleDose(
            doseRequest({ ...REX, pes: { ...REX.pes, vekMesicu: 120, aktivita: 'HIGH' } }),
            deps({ rules: fakeRules() })
        );
        const body = (await res.json()) as Record<string, never>;
        expect(body.status).toBe('INCOMPLETE');
        expect(body.reason).toBe('NO_MATCHING_DOSE_RULE');
        expect(body.produkty).toEqual([]);
        expect((body.audit as { krok: string }[]).map((a) => a.krok)).toContain('DOSE_RULE');
    });

    it('nadváha se počítá z IDEÁLNÍ hmotnosti', async () => {
        const res = await handleDose(
            doseRequest({
                ...REX,
                pes: { ...REX.pes, hmotnostKg: 30, idealniHmotnostKg: 24, kondice: 'OVER' },
            }),
            deps({ rules: fakeRules() })
        );
        const body = (await res.json()) as Record<string, never>;
        expect(body.status).toBe('OK');
        expect(body.davka.zHmotnosti).toBe('IDEAL');
        expect(body.davka.zakladHmotnostiKg).toBe(24);
    });
});

describe('POST /v1/davka — chybný vstup', () => {
    it('nadváha bez ideální hmotnosti → 422 s kódem', async () => {
        const res = await handleDose(
            doseRequest({ ...REX, pes: { ...REX.pes, kondice: 'OVER' } }),
            deps()
        );
        expect(res.status).toBe(422);
        const body = (await res.json()) as Record<string, never>;
        expect(body.code).toBe('VALIDATION_FAILED');
        expect((body.issues as { code: string }[]).map((i) => i.code)).toContain(
            'MISSING_IDEAL_WEIGHT'
        );
    });

    it('hmotnost mimo rozsah → 422', async () => {
        const res = await handleDose(
            doseRequest({ ...REX, pes: { ...REX.pes, hmotnostKg: 250 } }),
            deps()
        );
        expect(res.status).toBe(422);
        const body = (await res.json()) as Record<string, never>;
        expect((body.issues as { code: string }[]).map((i) => i.code)).toContain('OUT_OF_RANGE');
    });

    it('neznámý enum → 422', async () => {
        const res = await handleDose(
            doseRequest({ ...REX, pes: { ...REX.pes, aktivita: 'ULTRA' } }),
            deps()
        );
        expect(res.status).toBe(422);
        const body = (await res.json()) as Record<string, never>;
        expect((body.issues as { code: string }[]).map((i) => i.code)).toContain(
            'UNKNOWN_ENUM_VALUE'
        );
    });

    it('nevalidní JSON → 400', async () => {
        const req = new Request('https://w.example/v1/davka', { method: 'POST', body: '{nope' });
        const res = await handleDose(req, deps());
        expect(res.status).toBe(400);
        const body = (await res.json()) as Record<string, never>;
        expect(body.code).toBe('INVALID_JSON');
    });

    it('nafouknuté tělo → 400', async () => {
        const req = new Request('https://w.example/v1/davka', {
            method: 'POST',
            body: JSON.stringify({ pes: { jmeno: 'x'.repeat(20_000) } }),
        });
        const res = await handleDose(req, deps());
        expect(res.status).toBe(400);
        const body = (await res.json()) as Record<string, never>;
        expect(body.code).toBe('BODY_TOO_LARGE');
    });
});

describe('POST /v1/davka — nehotová znalostní vrstva se PŘIZNÁ (R7)', () => {
    it('u psa s diagnózou přidá varování, když pravidla neběží', async () => {
        const res = await handleDose(
            doseRequest({ ...REX, pes: { ...REX.pes, diagnozy: ['ckd'] } }),
            deps({ rules: NOOP_RULE_ENGINE })
        );
        const body = (await res.json()) as Record<string, never>;
        expect(body.knowledgeEngineReady).toBe(false);
        const codes = (body.upozorneni as { kod: string }[]).map((w) => w.kod);
        expect(codes).toContain('KNOWLEDGE_ENGINE_UNAVAILABLE');
    });

    it('u zdravého psa se varování nepřidává', async () => {
        const res = await handleDose(doseRequest(REX), deps({ rules: NOOP_RULE_ENGINE }));
        const body = (await res.json()) as Record<string, never>;
        const codes = (body.upozorneni as { kod: string }[]).map((w) => w.kod);
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
        const body = (await res.json()) as Record<string, never>;
        const w = (body.upozorneni as { kod: string; requiresVet: boolean }[])[0];
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
        const body = (await res.json()) as Record<string, never>;
        expect(body.status).toBe('BLOCKED');
        expect(body.reason).toBe('RULE_ENGINE_FAILED');
        expect(body.disclaimer).toBe(DISCLAIMER_CS);
    });

    it('nedostupný katalog dávku vydá, ale přizná chybějící balení', async () => {
        const store = new FakeStore(fullCatalog());
        store.failReads = true;
        const res = await handleDose(doseRequest(REX), deps({ rules: fakeRules() }, store));
        const body = (await res.json()) as Record<string, never>;
        expect(body.status).toBe('OK');
        expect(body.davka.celkemGDen).toBe(540);
        expect(body.katalogNedostupny).toBe(true);
        expect(body.produkty).toEqual([]);
        expect(body.cena).toBeNull();
    });

    it('prázdný katalog přizná nepokryté složky, nesubstituuje', async () => {
        const res = await handleDose(
            doseRequest(REX),
            deps({ rules: fakeRules() }, new FakeStore([]))
        );
        const body = (await res.json()) as Record<string, never>;
        expect(body.status).toBe('OK');
        expect(body.produkty).toEqual([]);
        expect((body.nepokryto as unknown[]).length).toBe(5);
    });

    it('produkty bez gramáže se do doporučení nedostanou (R7)', async () => {
        const store = new FakeStore([product({ packGrams: null, packGramsSource: null })]);
        const res = await handleDose(doseRequest(REX), deps({ rules: fakeRules() }, store));
        const body = (await res.json()) as Record<string, never>;
        expect(body.produkty).toEqual([]);
    });

    it('alergie vyřadí produkt a složka se přizná jako nepokrytá', async () => {
        const store = new FakeStore([
            product({ sku: 'M1', group: 'MUSCLE', ingredientIds: ['kure'] }),
        ]);
        const rules = fakeRules({ excludedIngredientIds: new Set(['kure']) });
        const res = await handleDose(doseRequest(REX), deps({ rules }, store));
        const body = (await res.json()) as Record<string, never>;
        expect(body.produkty).toEqual([]);
        const uncovered = (body.nepokryto as { group: string; duvod: string }[]).find(
            (u) => u.group === 'MUSCLE'
        );
        expect(uncovered?.duvod).toBe('ALL_FILTERED_OUT');
    });
});

describe('GET /v1/knowledge', () => {
    it('vrátí seznam diagnóz a alergenů, aby je frontend neměl natvrdo', async () => {
        const res = await handleKnowledge(deps({ rules: fakeRules() }));
        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, never>;
        expect(body.ready).toBe(true);
        expect((body.diagnoses as { id: string }[])[0].id).toBe('ckd');
        expect((body.allergens as { id: string }[])[0].id).toBe('kure');
        expect(body.ruleSetIds).toEqual(TUTANI_TENANT.ruleSetIds);
    });

    it('endpoint existuje i bez nasazených pravidel a přizná to', async () => {
        const res = await handleKnowledge(deps({ rules: NOOP_RULE_ENGINE }));
        expect(res.status).toBe(200);
        const body = (await res.json()) as Record<string, never>;
        expect(body.ready).toBe(false);
        expect(body.diagnoses).toEqual([]);
    });
});

describe('GET /v1/health', () => {
    it('DEGRADED, dokud sync neproběhl', async () => {
        const res = await handleHealth(deps());
        expect(res.status).toBe(503);
        const body = (await res.json()) as Record<string, never>;
        expect(body.status).toBe('DEGRADED');
        expect(body.lastSync).toBeNull();
        expect(body.usableProducts).toBe(5);
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
        const body = (await res.json()) as Record<string, never>;
        expect(body.status).toBe('OK');
        expect(body.lastSync.ageHours).toBe(2.8);
        expect(body.lastSync.productsParsed).toBe(264);
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
        const body = (await res.json()) as Record<string, never>;
        expect(body.status).toBe('DEGRADED');
    });

    it('DEGRADED, když katalog nemá použitelné produkty', async () => {
        const store = new FakeStore([product({ packGrams: null })]);
        const res = await handleHealth(deps({}, store));
        const body = (await res.json()) as Record<string, never>;
        expect(body.status).toBe('DEGRADED');
        expect(body.usableProducts).toBe(0);
    });

    it('nedostupná D1 → FAILED, ne pád', async () => {
        const store = new FakeStore([]);
        store.failReads = true;
        const res = await handleHealth(deps({}, store));
        expect(res.status).toBe(503);
        const body = (await res.json()) as Record<string, never>;
        expect(body.status).toBe('FAILED');
    });
});
