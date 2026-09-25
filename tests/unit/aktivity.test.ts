/**
 * Konkrétní aktivity (Lucky 2026-09-25): majitel vybírá „psí sporty",
 * „tažný pes"… Úroveň pro dávku určuje SERVER z konfigurace tenanta
 * a musí to být úroveň, pro kterou má tabulka dávek pravidlo.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateDoseRequest } from '../../src/api/validateInput.js';
import { TUTANI_TENANT } from '../../tenants/tutani/config/tenant.js';

const OPTS = TUTANI_TENANT.activityOptions!;
const CORE = JSON.parse(readFileSync(new URL('../../tenants/tutani/rules/barf-core.json', import.meta.url), 'utf8'));

function body(dogOver: Record<string, unknown> = {}) {
    const pes: Record<string, unknown> = {
        hmotnostKg: 24, vekMesicu: 36, pohlavi: 'MALE', kastrovany: false,
        aktivita: 'MEDIUM', kondice: 'IDEAL', fyziologickyStav: 'NONE',
        diagnozy: [], alergie: [], ...dogOver,
    };
    for (const k of Object.keys(pes)) if (pes[k] === undefined) delete pes[k];
    return { pes };
}
const run = (over: Record<string, unknown>) => validateDoseRequest(body(over), 30, undefined, OPTS);

describe('konfigurace aktivit Tutani', () => {
    it('základní sada: 9 aktivit, unikátní id, všechny 4 úrovně zastoupené', () => {
        expect(OPTS).toHaveLength(9);
        expect(new Set(OPTS.map((o) => o.id)).size).toBe(9);
        expect(new Set(OPTS.map((o) => o.level))).toEqual(new Set(['LOW', 'MEDIUM', 'HIGH', 'WORKING']));
    });

    it('každá úroveň má v tabulce dávek pravidlo pro dospělého psa (žádné nové procento)', () => {
        const levels = new Set<string>();
        (function walk(x: unknown) {
            if (Array.isArray(x)) x.forEach(walk);
            else if (x && typeof x === 'object') {
                const r = x as Record<string, unknown>;
                if (r.lifeStage === 'ADULT' && typeof r.activity === 'string') levels.add(r.activity);
                Object.values(r).forEach(walk);
            }
        })(CORE);
        for (const o of OPTS) expect(levels.has(o.level), `${o.id} → ${o.level}`).toBe(true);
    });
});

describe('validace pes.aktivitaDetail', () => {
    it('úroveň určí server z konfigurace, aktivita od klienta není potřeba', () => {
        const r = run({ aktivita: undefined, aktivitaDetail: 'psi-sporty' });
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.dog.activity).toBe('HIGH');
            expect(r.value.dog.activityDetailId).toBe('psi-sporty');
        }
    });

    it('tažný pes → pracovní úroveň', () => {
        const r = run({ aktivita: undefined, aktivitaDetail: 'tazny' });
        expect(r.ok && r.value.dog.activity).toBe('WORKING');
    });

    it('rozpor aktivita × aktivitaDetail = chyba, ne tichá volba', () => {
        const r = run({ aktivita: 'LOW', aktivitaDetail: 'tazny' });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.issues).toContainEqual({ field: 'pes.aktivita', code: 'ACTIVITY_MISMATCH' });
    });

    it('neznámá aktivita i ne-řetězec → UNKNOWN_ACTIVITY', () => {
        for (const v of ['kulečník', 42]) {
            const r = run({ aktivita: undefined, aktivitaDetail: v });
            expect(r.ok).toBe(false);
            if (!r.ok) expect(r.issues).toContainEqual({ field: 'pes.aktivitaDetail', code: 'UNKNOWN_ACTIVITY' });
        }
    });

    it('bez aktivitaDetail beze změny (zpětná kompatibilita)', () => {
        const r = run({});
        expect(r.ok && r.value.dog.activity).toBe('MEDIUM');
        expect(r.ok && r.value.dog.activityDetailId).toBeUndefined();
    });

    it('tenant bez activityOptions: aktivitaDetail se odmítne', () => {
        const r = validateDoseRequest(body({ aktivita: undefined, aktivitaDetail: 'tazny' }), 30);
        expect(r.ok).toBe(false);
    });
});
