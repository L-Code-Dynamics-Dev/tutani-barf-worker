/**
 * API vrstva Workeru — orchestrace, žádná vlastní logika.
 *
 * ROZDĚLENÍ ODPOVĚDNOSTI (R3): handler validuje vstup, poskládá
 * závislosti a zavolá engine. NEPOČÍTÁ nic sám a nerozhoduje
 * o vhodnosti produktu — to je v `calculateDose` a `matchProducts`.
 * Frontend nepočítá vůbec nic.
 *
 * TENANT MODEL (R4): nikde tady není `if (tenant === 'tutani')`.
 * Cesta je `tenantId → TenantConfiguration → RuleSet → ProductCatalog`
 * a všechny odlišnosti klienta jdou z konfigurace.
 *
 * ŽÁDNÉ LLM (R1). Vysvětlení „proč vyšlo 540 g" je `audit` z enginu.
 */

import type { TenantConfiguration } from '../domain/tenant.js';
import type { ResolvedConstraints } from '../domain/health/Condition.js';
import type { DogProfile } from '../domain/dog/DogProfile.js';
import type { ProductStore, StoredProduct } from '../infrastructure/D1ProductStore.js';
import {
    calculateDose,
    type BarfMethodology,
    type DoseResult,
} from '../engine/feeding-calculator/calculateDose.js';
import {
    matchProducts,
    type CatalogProduct,
    type MatchResult,
} from '../engine/product-matching/matchProducts.js';
import { validateDoseRequest, type ValidationIssue } from './validateInput.js';
import {
    calculateNutrientCoverage,
    type NutrientCoverageDeps,
} from '../engine/nutrient-coverage/calculateNutrientCoverage.js';
import { calculateEnergy, type EnergyInput } from '../domain/nutrition/energy.js';
import { resolveLifeStage } from '../domain/dog/DogProfile.js';

/**
 * DISCLAIMER JE V ODPOVĚDI WORKERU, NE V ŠABLONĚ (§7 ARCHITEKTURA.md).
 *
 * Kdyby byl v šabloně e-shopu, dal by se odstranit úpravou frontendu.
 * Tady ho odstranit nelze — je součástí každé odpovědi `/v1/davka`,
 * i té blokované, i té neúplné.
 */
export const DISCLAIMER_CS =
    'Orientační doporučení sestavené z metodiky BARF a katalogu Tutani. ' +
    'Nejde o veterinární diagnózu ani o individuální krmný plán. ' +
    'Při jakémkoli zdravotním problému doporučujeme konzultaci s veterinářem.';

/**
 * KNOWLEDGE / RULE ENGINE — integrační bod.
 *
 * TODO INTEGRACE (druhý agent, paralelně): sem přijde vrstva, která
 * z `tenants/tutani/rules/tutani-health.json` a `ingredients.json`
 * složí `ResolvedConstraints` — sjednocení zákazů z alergií, limitů
 * z diagnóz, `blocksResult` a varování.
 *
 * Do té doby se používá PRÁZDNÝ výsledek. Je to bezpečná varianta:
 * prázdná omezení znamenají obecnou metodiku BARF bez zdravotních
 * úprav. NENÍ to však správný výsledek pro psa s diagnózou, a proto
 * se to v odpovědi PŘIZNÁVÁ přes `knowledgeEngineReady: false`
 * a varování `KNOWLEDGE_ENGINE_UNAVAILABLE` — konfigurátor nesmí
 * tvrdit, že s diagnózou počítal, když ji zahodil (R7).
 */
export interface RuleEngine {
    resolve(dog: DogProfile, tenant: TenantConfiguration): Promise<ResolvedConstraints>;
    /** `false` = pravidla ještě nejsou nasazená, odpověď to musí říct. */
    readonly ready: boolean;
    /** Seznam diagnóz a alergií pro `GET /v1/knowledge`. */
    catalog(tenant: TenantConfiguration): Promise<KnowledgeCatalog>;
}

export interface KnowledgeCatalogItem {
    id: string;
    /** Co uvidí majitel — bez odborné hantýrky. */
    layNameCs: string;
    /** Odborný název pro dokumentaci a veterináře. */
    nameCs: string;
    explainCs?: string;
    severity?: string;
    requiresVet?: boolean;
}

export interface KnowledgeCatalog {
    ready: boolean;
    ruleSetIds: string[];
    diagnoses: KnowledgeCatalogItem[];
    allergens: KnowledgeCatalogItem[];
}

/** Prázdná omezení — bezpečný stav, dokud znalostní vrstva nedorazí. */
export function emptyConstraints(): ResolvedConstraints {
    return {
        useIdealWeight: false,
        compositionLimits: [],
        excludedIngredientIds: new Set<string>(),
        preferredIngredientIds: new Set<string>(),
        productAttrFilters: [],
        warnings: [],
        blocked: false,
        blockedBy: [],
        requiresVet: false,
    };
}

/**
 * Zástupná implementace rule enginu. Nahradí ji druhý agent výměnou
 * jedné závislosti v `src/index.ts` — nic dalšího se nemění.
 */
export const NOOP_RULE_ENGINE: RuleEngine = {
    ready: false,
    async resolve() {
        return emptyConstraints();
    },
    async catalog(tenant) {
        return { ready: false, ruleSetIds: tenant.ruleSetIds, diagnoses: [], allergens: [] };
    },
};

/** Závislosti handlerů. Injektované, aby se daly testovat bez D1 a sítě. */
export interface Deps {
    tenant: TenantConfiguration;
    store: ProductStore;
    methodology: BarfMethodology;
    rules: RuleEngine;
    /** Injektovatelný čas kvůli deterministickým testům. */
    now?: () => Date;
    /**
     * Nutriční vrstva (FEDIAF cíle + `TutaniProduct` katalog + surovinová
     * databáze) — VOLITELNÁ (nález auditu 2026-09-12, D-1: propojka).
     * Chybí-li, `/v1/davka` funguje přesně jako dřív (jen `BarfGroup`
     * úroveň) a nutriční pole v odpovědi se prostě nevygeneruje —
     * nejde o chybu, jen o nezapojenou vrstvu (R7: neexistuje ticho
     * předstíraná nutriční kontrola bez dat).
     */
    nutrition?: Omit<NutrientCoverageDeps, 'dietKcalPerDay'>;
}

/** Kód chyby na úrovni požadavku. Text si drží frontend. */
export type ApiErrorCode =
    | 'VALIDATION_FAILED'
    | 'METHOD_NOT_ALLOWED'
    | 'NOT_FOUND'
    | 'BODY_TOO_LARGE'
    | 'INVALID_JSON'
    | 'INTERNAL_ERROR';

/** Maximální velikost těla požadavku. Profil psa je pár set bajtů. */
const MAX_BODY_BYTES = 8 * 1024;

/**
 * `POST /v1/davka` — hlavní endpoint.
 *
 * Pořadí je závazné: validace → pravidla → dávka → produkty. Nikdy
 * naopak: doporučovat produkty bez spočítané potřeby nemá smysl
 * a výpočet nesmí být ovlivněný tím, co je na skladě.
 */
export async function handleDose(request: Request, deps: Deps): Promise<Response> {
    const raw = await readJsonBody(request);
    if (!raw.ok) return apiError(raw.code, 400, raw.issues);

    const validation = validateDoseRequest(raw.value, deps.tenant.defaultPeriodDays);
    if (!validation.ok) {
        return apiError('VALIDATION_FAILED', 422, validation.issues);
    }
    const { dog, periodDays } = validation.value;

    // ---- RULE ENGINE ----
    // Selhání pravidel NESMÍ vydat dávku bez zdravotních omezení —
    // to by bylo horší než nevydat nic. Proto se chyba propíše jako
    // BLOCKED, ne jako tichý fallback na prázdná omezení.
    let constraints: ResolvedConstraints;
    try {
        constraints = await deps.rules.resolve(dog, deps.tenant);
    } catch (e) {
        logError('rules.resolve_failed', e, { tenantId: deps.tenant.tenantId });
        return jsonResponse(
            {
                v: 1,
                status: 'BLOCKED',
                reason: 'RULE_ENGINE_FAILED',
                pes: dogEcho(dog),
                slozeni: [],
                produkty: [],
                nepokryto: [],
                upozorneni: [
                    {
                        severity: 'CRITICAL',
                        kod: 'RULE_ENGINE_FAILED',
                        text:
                            'Zdravotní pravidla se nepodařilo vyhodnotit, proto jsme dávku ' +
                            'nevydali. Zkuste to prosím znovu později.',
                        requiresVet: false,
                    },
                ],
                audit: [],
                disclaimer: DISCLAIMER_CS,
            },
            503
        );
    }

    // ---- VÝPOČET DÁVKY ----
    const dose = calculateDose(dog, deps.methodology, constraints);

    // BLOCKED i INCOMPLETE se vrací s HTTP 200: požadavek byl v pořádku,
    // jen výsledkem je „dávku nevydáváme". Chybný vstup je 422, tohle ne.
    if (dose.status !== 'OK') {
        return jsonResponse(buildResponse(dog, dose, null, periodDays, constraints, deps), 200);
    }

    // ---- PRODUKTY ----
    // Katalog se čte AŽ po výpočtu — potřeba nesmí záležet na tom,
    // co je skladem.
    let match: MatchResult | null = null;
    try {
        const catalog = await loadCatalog(deps.store, deps.tenant.tenantId);
        match = matchProducts(dose.composition, catalog, constraints, periodDays);
    } catch (e) {
        // Katalog nedostupný: dávka je platná a vydá se, jen bez
        // konkrétních balení. Lepší než nic — a je to přiznané.
        logError('catalog.load_failed', e, { tenantId: deps.tenant.tenantId });
        match = null;
    }

    return jsonResponse(buildResponse(dog, dose, match, periodDays, constraints, deps), 200);
}

/**
 * `GET /v1/knowledge` — seznam diagnóz a alergenů pro UI.
 *
 * PROČ ENDPOINT (§6 ARCHITEKTURA.md): aby frontend neměl seznam
 * natvrdo. Přidání diagnózy je pak datová operace bez deploye
 * frontendu (R5).
 */
export async function handleKnowledge(deps: Deps): Promise<Response> {
    try {
        const catalog = await deps.rules.catalog(deps.tenant);
        return jsonResponse({ v: 1, ...catalog }, 200, { 'Cache-Control': 'public, max-age=300' });
    } catch (e) {
        logError('knowledge.load_failed', e, { tenantId: deps.tenant.tenantId });
        return apiError('INTERNAL_ERROR', 503);
    }
}

/**
 * `GET /v1/health` — stav služby.
 *
 * Odpovídá na to, co se v provozu reálně ptáme: běží sync, kdy naposled
 * a kolik produktů se dá doporučit. `usableProducts` je důležitější než
 * `products` — katalog s 264 produkty a 3 použitelnými je rozbitý.
 */
export async function handleHealth(deps: Deps): Promise<Response> {
    const now = (deps.now ?? (() => new Date()))();
    try {
        const health = await deps.store.health(deps.tenant.tenantId);
        const last = health.lastSync;
        const ageHours =
            last === null
                ? null
                : Math.round(((now.getTime() - Date.parse(last.startedAt)) / 3_600_000) * 10) / 10;

        /**
         * Stav je DEGRADED, ne OK, když katalog nemá co doporučit nebo
         * sync neproběhl přes 48 h (noční běh smí jednou vypadnout,
         * dvakrát ne). Monitoring se nemá dozvídat z počtů, ale ze stavu.
         */
        const stale = ageHours === null || ageHours > 48;
        const status = health.usableCount === 0 || stale ? 'DEGRADED' : 'OK';

        return jsonResponse(
            {
                v: 1,
                status,
                tenantId: deps.tenant.tenantId,
                knowledgeEngineReady: deps.rules.ready,
                products: health.productCount,
                usableProducts: health.usableCount,
                lastSync:
                    last === null
                        ? null
                        : {
                              id: last.id,
                              startedAt: last.startedAt,
                              finishedAt: last.finishedAt,
                              status: last.status,
                              ageHours,
                              productsParsed: last.productsParsed,
                              added: last.added,
                              changed: last.changed,
                              removed: last.removed,
                              unusable: last.unusable,
                              urlsFailed: last.urlsFailed,
                          },
                checkedAt: now.toISOString(),
            },
            // 503 při DEGRADED, aby to monitoring viděl bez parsování těla.
            status === 'OK' ? 200 : 503,
            { 'Cache-Control': 'no-store' }
        );
    } catch (e) {
        logError('health.failed', e, { tenantId: deps.tenant.tenantId });
        return jsonResponse(
            { v: 1, status: 'FAILED', tenantId: deps.tenant.tenantId, checkedAt: now.toISOString() },
            503,
            { 'Cache-Control': 'no-store' }
        );
    }
}

/**
 * Katalog pro matching. Produkty bez gramáže jsou odfiltrované už
 * v SQL, takže se `packGrams` dá bezpečně zúžit na `number`.
 */
async function loadCatalog(store: ProductStore, tenantId: string): Promise<CatalogProduct[]> {
    const stored = await store.listUsable(tenantId);
    return stored
        .filter((p): p is StoredProduct & { packGrams: number } => p.packGrams !== null && p.packGrams > 0)
        .map((p) => ({
            sku: p.sku,
            name: p.name,
            url: p.url,
            priceCzk: p.priceCzk,
            packGrams: p.packGrams,
            group: p.group,
            inStock: p.inStock,
            productId: p.productId,
            priceId: p.priceId,
            ingredientIds: p.ingredientIds,
            isCooked: p.isCooked,
        }));
}

/**
 * Odpověď podle §6 ARCHITEKTURA.md. Klíče jsou české, protože je
 * konzumuje český frontend a kontrakt je už takhle publikovaný.
 */
function buildResponse(
    dog: DogProfile,
    dose: DoseResult,
    match: MatchResult | null,
    periodDays: number,
    constraints: ResolvedConstraints,
    deps: Deps
) {
    const warnings = constraints.warnings.map((w) => ({
        severity: w.severity,
        kod: w.conditionId,
        text: w.textCs,
        requiresVet: w.requiresVet,
    }));

    /**
     * PŘIZNÁNÍ NEHOTOVÉ ZNALOSTNÍ VRSTVY (R7).
     *
     * Zadal-li majitel diagnózu nebo alergii a pravidla ještě nejsou
     * nasazená, dávka je spočítaná BEZ nich. To se musí říct — jinak by
     * konfigurátor mlčky tvrdil, že s onemocněním ledvin počítal.
     */
    if (!deps.rules.ready && (dog.conditionIds.length > 0 || dog.allergyIngredientIds.length > 0)) {
        warnings.unshift({
            severity: 'SERIOUS',
            kod: 'KNOWLEDGE_ENGINE_UNAVAILABLE',
            text:
                'Zdravotní údaje jsme zaznamenali, ale pravidla pro jejich vyhodnocení ' +
                'ještě nejsou v provozu — dávka je spočítaná podle obecné metodiky BARF. ' +
                'Než ji použijete, projděte ji prosím s veterinářem.',
            requiresVet: true,
        });
    }

    const nutrice = calculateNutrition(dog, dose, match, periodDays, deps);

    return {
        v: 1,
        status: dose.status,
        reason: dose.reason,
        knowledgeEngineReady: deps.rules.ready,
        nutrientEngineReady: nutrice !== null,
        pes: dogEcho(dog),
        davka:
            dose.status === 'OK'
                ? {
                      pctMin: dose.pctMin,
                      pctMax: dose.pctMax,
                      pctPouzito: dose.pctUsed,
                      zHmotnosti: dose.baseWeightSource,
                      zakladHmotnostiKg: dose.baseWeightKg,
                      celkemGDen: dose.totalGramsPerDay,
                      porce: dose.portions
                          ? { pocet: dose.portions.count, gramyNaPorci: dose.portions.gramsPerPortion }
                          : null,
                      pravidlo: dose.ruleId,
                      pravidloPopis: dose.ruleLabelCs,
                  }
                : null,
        slozeni: dose.composition.map((c) => ({
            group: c.group,
            nazev: c.labelCs,
            gramy: c.grams,
            pct: c.pct,
            upraveno: c.adjusted,
            duvod: c.adjustedBy,
        })),
        produkty: (match?.products ?? []).map((p) => ({
            sku: p.sku,
            nazev: p.name,
            url: p.url,
            group: p.group,
            packGrams: p.packGrams,
            pocet: p.packs,
            cenaZaBaleni: p.unitPriceCzk,
            cenaCelkem: p.totalPriceCzk,
            productId: p.productId,
            priceId: p.priceId,
        })),
        nepokryto: (match?.uncovered ?? []).map((u) => ({
            group: u.group,
            nazev: u.labelCs,
            gramy: u.gramsPerDay,
            duvod: u.reason,
        })),
        /**
         * NUTRIČNÍ POKRYTÍ (nález auditu 2026-09-12, D-1) — `null`, dokud
         * `deps.nutrition` není nakonfigurováno NEBO dokud nejsou vybrané
         * produkty (BLOCKED/INCOMPLETE dávka, chybějící katalog). Nikdy
         * se nevrací prázdné pole místo `null` — to by vypadalo jako
         * "zkontrolovali jsme 0 živin a je to OK", ne jako "nekontrolovalo se".
         */
        nutrice: nutrice === null ? null : nutrice.map((c) => ({
            klic: c.key,
            nazev: c.labelCs,
            stav: c.status,
            hodnota: c.value ?? null,
            jednotka: c.unit ?? null,
            cilMin: c.targetMin ?? null,
            cilMax: c.targetMax ?? null,
            zdroj: c.source,
            duvod: c.reasonCs ?? null,
        })),
        cena:
            match === null
                ? null
                : { celkemCzk: match.totalPriceCzk, naDni: match.periodDays },
        /** Katalog byl nedostupný — dávka platí, balení chybí. */
        katalogNedostupny: dose.status === 'OK' && match === null,
        obdobiDni: periodDays,
        upozorneni: warnings,
        audit: dose.audit.map((a) => ({ krok: a.step, pravidlo: a.ruleId, vysledek: a.resultCs })),
        /** Nedá se odstranit úpravou frontendu — je součástí odpovědi. */
        disclaimer: DISCLAIMER_CS,
    };
}

/**
 * Nutriční pokrytí dávky — `null` když se nedá spočítat (chybí nutriční
 * vrstva, dávka není OK, nebo nejsou vybrané žádné produkty). NIKDY se
 * nevrací výsledek s tichým podhodnocením (R7) — proto se hned na
 * vstupu odmítne cokoliv, u čeho by výpočet neměl solidní základ.
 */
function calculateNutrition(
    dog: DogProfile,
    dose: DoseResult,
    match: MatchResult | null,
    periodDays: number,
    deps: Deps
): ReturnType<typeof calculateNutrientCoverage> | null {
    if (!deps.nutrition) return null;
    if (dose.status !== 'OK' || !match || match.products.length === 0) return null;

    const energyInput: EnergyInput = {
        weightKg: dog.weightKg,
        idealWeightKg: dog.idealWeightKg,
        lifeStage: resolveLifeStage(dog.ageMonths),
        activity: dog.activity,
        bodyCondition: dog.bodyCondition,
        physiologicalState: dog.physiologicalState,
        neutered: dog.neutered,
    };
    const energy = calculateEnergy(energyInput);

    const selected = match.products.map((p) => ({
        sku: p.sku,
        // `coversGrams` je za CELÉ období (`periodDays`), potřeba je gramy/den.
        gramsPerDay: p.coversGrams / periodDays,
    }));

    return calculateNutrientCoverage(selected, {
        ...deps.nutrition,
        dietKcalPerDay: energy.merKcal,
    });
}

function dogEcho(dog: DogProfile) {
    return {
        jmeno: dog.name ?? null,
        hmotnostKg: dog.weightKg,
        idealniHmotnostKg: dog.idealWeightKg ?? null,
        vekMesicu: dog.ageMonths,
    };
}

/**
 * Čtení těla požadavku. Limit na velikost je ochrana Workeru — profil
 * psa má pár set bajtů a nic většího nemá důvod přijít.
 */
async function readJsonBody(
    request: Request
): Promise<{ ok: true; value: unknown } | { ok: false; code: ApiErrorCode; issues?: ValidationIssue[] }> {
    const declared = request.headers.get('content-length');
    if (declared !== null && Number(declared) > MAX_BODY_BYTES) {
        return { ok: false, code: 'BODY_TOO_LARGE' };
    }
    let text: string;
    try {
        text = await request.text();
    } catch {
        return { ok: false, code: 'INVALID_JSON' };
    }
    // Chunked požadavek `content-length` nemá — kontroluje se i po přečtení.
    if (text.length > MAX_BODY_BYTES) return { ok: false, code: 'BODY_TOO_LARGE' };
    try {
        return { ok: true, value: JSON.parse(text) as unknown };
    } catch {
        return { ok: false, code: 'INVALID_JSON' };
    }
}

export function apiError(
    code: ApiErrorCode,
    status: number,
    issues?: ValidationIssue[]
): Response {
    return jsonResponse(
        {
            v: 1,
            status: 'ERROR',
            code,
            // Kódy, ne texty k parsování.
            issues: issues ?? [],
            disclaimer: DISCLAIMER_CS,
        },
        status
    );
}

export function jsonResponse(
    body: unknown,
    status = 200,
    extraHeaders: Record<string, string> = {}
): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...extraHeaders,
        },
    });
}

/** Strukturovaný log chyby — čitelný bez dolování (observabilita). */
function logError(event: string, e: unknown, data: Record<string, unknown> = {}): void {
    console.error(
        JSON.stringify({
            level: 'error',
            event,
            error: e instanceof Error ? e.message : String(e),
            stack: e instanceof Error ? e.stack : undefined,
            ...data,
        })
    );
}
