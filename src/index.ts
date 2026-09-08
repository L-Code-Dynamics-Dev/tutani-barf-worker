/**
 * Worker entry — routing, CORS, cron.
 *
 * Jediné místo, kde se skládají závislosti. Engine, store ani rule
 * engine se navzájem neznají — potkají se tady. Díky tomu jde celý
 * handler testovat s falešným storem, bez D1 a bez sítě.
 *
 * TENANT MODEL (R4): tenant se vybírá podle konfigurace, ne podle
 * `if`u. Dnes je nakonfigurovaný jeden (`DEFAULT_TENANT_ID`), zítra
 * se přidá druhý řádek do registru a Worker se nezmění.
 */

import barfCore from '../tenants/tutani/rules/barf-core.json';
import tutaniHealth from '../tenants/tutani/rules/tutani-health.json';
import ingredients from '../tenants/tutani/rules/ingredients.json';
import { TUTANI_TENANT } from '../tenants/tutani/config/tenant.js';
import { KnowledgeRuleEngine } from './rules/KnowledgeRuleEngine.js';
import type { TenantConfiguration } from './domain/tenant.js';
import type { BarfMethodology } from './engine/feeding-calculator/calculateDose.js';
import type { ConflictResolution, DoseRule } from './engine/feeding-calculator/resolveDoseRule.js';
import type { CompositionGroupProfile } from './engine/feeding-calculator/calculateDose.js';
import { D1ProductStore } from './infrastructure/D1ProductStore.js';
import { syncCatalog } from './adapters/tutani-catalog/syncCatalog.js';
import {
    apiError,
    handleDose,
    handleHealth,
    handleKnowledge,
    jsonResponse,
    type Deps,
    type RuleEngine,
} from './api/handlers.js';

export interface Env {
    DB: D1Database;
    /** Volitelný override tenanta — pro staging bez změny kódu. */
    TENANT_ID?: string;
}

/**
 * CORS — POVOLENÉ ORIGINY, ne `*`.
 *
 * Konfigurátor běží v šabloně Shoptetu, takže žádost přijde z domény
 * e-shopu. `*` by dovolilo komukoli postavit nad naším Workerem svůj
 * konfigurátor a zatížit ho — a šlo by to i na účet klienta.
 *
 * Origin se porovnává PŘESNĚ. Žádné `endsWith('tutani.cz')` —
 * `zlytutani.cz` by tím prošel.
 */
const ALLOWED_ORIGINS: readonly string[] = [
    'https://obchod.tutani.cz',
    'https://tutani.cz',
    'https://www.tutani.cz',
];

/** Kolik hodin drží prohlížeč preflight. Den je bezpečné maximum. */
const CORS_MAX_AGE_SECONDS = 86_400;

const DEFAULT_TENANT_ID = TUTANI_TENANT.tenantId;

/** Registr tenantů. Data, ne kód — druhý klient je nový záznam. */
const TENANTS: Record<string, TenantConfiguration> = {
    [TUTANI_TENANT.tenantId]: TUTANI_TENANT,
};

/**
 * Metodika z rulesetu. Načte se jednou při startu isolátu — je to
 * statická konfigurace a číst ji na každý požadavek by byla zbytečná
 * práce.
 */
const METHODOLOGY: BarfMethodology = {
    doseMatrix: barfCore.doseMatrix as unknown as DoseRule[],
    conflictResolution: barfCore.conflictResolution as unknown as ConflictResolution,
    compositionProfile: {
        groups: barfCore.compositionProfile.groups as unknown as CompositionGroupProfile[],
    },
    sourceVersion: barfCore.sourceVersion,
};

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        const origin = request.headers.get('Origin');
        const corsHeaders = buildCorsHeaders(origin);

        // Preflight — odpovídá se před jakoukoli prací.
        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        const url = new URL(request.url);
        const path = url.pathname.replace(/\/+$/, '') || '/';

        try {
            const response = await route(request, path, env);
            return withHeaders(response, corsHeaders);
        } catch (e) {
            // Poslední záchytná síť: nezachycená chyba se nesmí dostat
            // k zákazníkovi jako stack trace.
            console.error(
                JSON.stringify({
                    level: 'error',
                    event: 'worker.unhandled',
                    path,
                    method: request.method,
                    error: e instanceof Error ? e.message : String(e),
                    stack: e instanceof Error ? e.stack : undefined,
                })
            );
            return withHeaders(apiError('INTERNAL_ERROR', 500), corsHeaders);
        }
    },

    /**
     * CRON — noční synchronizace katalogu.
     *
     * Běží OSTŘE (`dryRun: false`), protože dry-run se schvaluje ručně
     * před nasazením. Pojistky proti rozbití katalogu jsou v
     * `syncCatalog`: prázdný výsledek běh přeruší a odebrání produktů
     * se přeskočí, když část URL selhala.
     *
     * Chyba se NEPOLYKÁ — vyhodí se, aby ji Cloudflare zaznamenala
     * jako neúspěšný běh a bylo to vidět v observability.
     */
    async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
        const tenant = resolveTenant(env);
        const store = new D1ProductStore(env.DB);

        const task = (async () => {
            const result = await syncCatalog(tenant, store, {
                dryRun: false,
                triggerSource: 'CRON',
            });
            console.log(
                JSON.stringify({
                    level: result.run.status === 'FAILED' ? 'error' : 'info',
                    event: 'cron.sync_done',
                    cron: event.cron,
                    tenantId: tenant.tenantId,
                    status: result.run.status,
                    productsParsed: result.run.productsParsed,
                    added: result.run.added,
                    changed: result.run.changed,
                    removed: result.run.removed,
                    unusable: result.run.unusable,
                    urlsFailed: result.run.urlsFailed,
                    error: result.run.errorText,
                })
            );
            if (result.run.status === 'FAILED') {
                throw new Error(result.run.errorText ?? 'sync selhal');
            }
        })();

        // `waitUntil` drží isolát naživu i po návratu z handleru —
        // sync nad 300+ URL se do jednoho tiku nevejde.
        ctx.waitUntil(task);
        await task;
    },
};

async function route(request: Request, path: string, env: Env): Promise<Response> {
    const deps = buildDeps(env);

    if (path === '/v1/davka') {
        if (request.method !== 'POST') return apiError('METHOD_NOT_ALLOWED', 405);
        return handleDose(request, deps);
    }
    if (path === '/v1/knowledge') {
        if (request.method !== 'GET') return apiError('METHOD_NOT_ALLOWED', 405);
        return handleKnowledge(deps);
    }
    if (path === '/v1/health') {
        if (request.method !== 'GET') return apiError('METHOD_NOT_ALLOWED', 405);
        return handleHealth(deps);
    }
    // Kořen jen řekne, co Worker je — bez výčtu vnitřností.
    if (path === '/') {
        return jsonResponse({ v: 1, service: 'tutani-barf', endpoints: ['/v1/davka', '/v1/knowledge', '/v1/health'] });
    }
    return apiError('NOT_FOUND', 404);
}

/**
 * Znalostní vrstva — postaví se JEDNOU na isolate a drží se v paměti.
 *
 * KRITICKÝ NÁLEZ AUDITU 2026-09-09: `buildDeps` měl jako výchozí
 * `NOOP_RULE_ENGINE`, který vracel prázdná omezení. Nasazený Worker
 * tedy pro KAŽDÉHO psa ignoroval diagnózy i alergie — pes v pokročilém
 * renálním selhání by dostal plnou dávku a alergik produkt
 * s alergenem, přičemž API hlásilo, že s nimi počítalo.
 *
 * Znalostní vrstva byla hotová, jen nikdo nespojil oba konce. Tady se
 * spojují.
 */
const RULES: RuleEngine = new KnowledgeRuleEngine({
    health: tutaniHealth,
    ingredients,
    barfCore,
});

export function buildDeps(env: Env, rules: RuleEngine = RULES): Deps {
    return {
        tenant: resolveTenant(env),
        store: new D1ProductStore(env.DB),
        methodology: METHODOLOGY,
        rules,
    };
}

/**
 * Tenant z konfigurace. Neznámé `TENANT_ID` je konfigurační chyba —
 * NEspadne se tiše na default, protože to by znamenalo obsluhovat
 * cizího klienta pravidly Tutani.
 */
function resolveTenant(env: Env): TenantConfiguration {
    const id = env.TENANT_ID ?? DEFAULT_TENANT_ID;
    const tenant = TENANTS[id];
    if (!tenant) throw new Error(`neznámý tenant: ${id}`);
    return tenant;
}

/**
 * CORS hlavičky. Neznámý origin nedostane `Access-Control-Allow-Origin`
 * vůbec — prohlížeč požadavek zamítne sám a Worker nemusí nic řešit.
 *
 * `Vary: Origin` je povinné: bez něj by cache vrátila hlavičku
 * povoleného originu i neoprávněnému.
 */
function buildCorsHeaders(origin: string | null): Record<string, string> {
    const headers: Record<string, string> = { Vary: 'Origin' };
    if (origin !== null && ALLOWED_ORIGINS.includes(origin)) {
        headers['Access-Control-Allow-Origin'] = origin;
        headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
        headers['Access-Control-Allow-Headers'] = 'Content-Type';
        headers['Access-Control-Max-Age'] = String(CORS_MAX_AGE_SECONDS);
    }
    return headers;
}

function withHeaders(response: Response, headers: Record<string, string>): Response {
    const merged = new Headers(response.headers);
    for (const [k, v] of Object.entries(headers)) merged.set(k, v);
    return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: merged,
    });
}
