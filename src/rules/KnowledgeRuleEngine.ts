/**
 * Skutečná implementace `RuleEngine` pro API — spojuje znalostní
 * vrstvu (`RuleEngine.ts`) s handlery.
 *
 * PROČ TENHLE SOUBOR EXISTUJE (nález auditu 2026-09-09): `handlers.ts`
 * měl jako výchozí `NOOP_RULE_ENGINE`, který vracel PRÁZDNÁ omezení.
 * Pes s onemocněním ledvin by tak dostal dávku bez sníženého fosforu
 * a alergik produkt s alergenem — protože se zdravotní pravidla vůbec
 * nevyhodnotila. Znalostní vrstva byla hotová, jen nikdo nespojil oba
 * konce.
 *
 * Pravidla se načítají z JSONu **jednou při startu isolate** a drží se
 * v paměti: jsou to statická data (~35 KB) a načítat je při každém
 * požadavku by znamenalo parsovat JSON pro každého zákazníka.
 *
 * BEZPEČNOSTNÍ ZÁSADA: když se pravidla nepodaří načíst, engine
 * NESMÍ vrátit prázdná omezení a tvářit se, že je vše v pořádku —
 * `ready: false` propíše handler do odpovědi a u psa se zadanou
 * diagnózou se dávka nevydá. Tichý fallback na „žádná omezení" je
 * u zdravotního doporučení horší než odmítnutí.
 */

import type { DogProfile } from '../domain/dog/DogProfile.js';
import type { ResolvedConstraints } from '../domain/health/Condition.js';
import type { TenantConfiguration } from '../domain/tenant.js';
import type { KnowledgeCatalog, RuleEngine } from '../api/handlers.js';
import { buildKnowledgeBase, resolveConstraints, type HealthKnowledgeBase } from './RuleEngine.js';

/**
 * Surové JSONy znalostní vrstvy. Ve Workeru se importují staticky
 * (bundler je vloží do balíčku), v testech se dají podstrčit.
 */
export interface KnowledgeSources {
    health: unknown;
    ingredients: unknown;
    barfCore: unknown;
}

export class KnowledgeRuleEngine implements RuleEngine {
    private readonly kb: HealthKnowledgeBase | null;
    public readonly ready: boolean;

    constructor(sources: KnowledgeSources) {
        let kb: HealthKnowledgeBase | null = null;
        try {
            kb = buildKnowledgeBase(sources.health, sources.ingredients, sources.barfCore);
            // Prázdná znalostní báze není použitelný stav — znamená to
            // rozbitý nebo prázdný JSON, ne „žádné nemoci neexistují".
            if (kb.conditions.length === 0) kb = null;
        } catch {
            kb = null;
        }
        this.kb = kb;
        this.ready = kb !== null;
    }

    async resolve(dog: DogProfile, _tenant: TenantConfiguration): Promise<ResolvedConstraints> {
        if (this.kb === null) {
            // Handler pozná podle `ready: false`, že s pravidly nelze
            // počítat, a u zadané diagnózy dávku nevydá. Tady se jen
            // nesmí vrátit nic, co by vypadalo jako platná omezení.
            throw new Error('znalostní vrstva není načtená');
        }
        return resolveConstraints(dog.conditionIds, dog.allergyIngredientIds, this.kb);
    }

    async catalog(tenant: TenantConfiguration): Promise<KnowledgeCatalog> {
        if (this.kb === null) {
            return { ready: false, ruleSetIds: tenant.ruleSetIds, diagnoses: [], allergens: [] };
        }

        /**
         * Do UI jdou jen stavy, které má vybírat MAJITEL:
         *  - `DISEASE` jako diagnózy,
         *  - `ALLERGY` a `INTOLERANCE` jako alergie.
         *
         * `PHYSIOLOGICAL` (březost, laktace, rekonvalescence) se
         * v konfigurátoru zadává vlastním přepínačem, ne zaškrtávátkem,
         * a `toxicke-potraviny` platí vždy — nabízet je k volbě by
         * znamenalo, že si zákazník může vypnout bezpečnostní filtr.
         */
        const diagnoses = this.kb.conditions
            .filter((c) => c.kind === 'DISEASE')
            .map((c) => ({
                id: c.id,
                layNameCs: c.layNameCs ?? c.nameCs,
                nameCs: c.nameCs,
                explainCs: c.explainCs,
                severity: c.severity,
                requiresVet: c.requiresVet === true,
                /**
                 * `blocksResult` se propisuje přes `severity: 'CRITICAL'`
                 * — handler `KnowledgeCatalogItem` nemá vlastní pole pro
                 * blokaci a domýšlet si ho do kontraktu by rozbilo typ.
                 * UI blokující stav pozná podle `severity`.
                 */
                ...(c.blocksResult === true ? { severity: 'CRITICAL' } : {}),
            }));

        const allergens = this.kb.conditions
            .filter((c) => c.kind === 'ALLERGY' || c.kind === 'INTOLERANCE')
            // Toxické potraviny nejsou volba uživatele — vylučují se vždy.
            .filter((c) => !(c as { alwaysActive?: boolean }).alwaysActive)
            .map((c) => ({
                id: c.id,
                layNameCs: c.layNameCs ?? c.nameCs,
                nameCs: c.nameCs,
                explainCs: c.explainCs,
                severity: c.severity,
            }));

        // Deterministické pořadí — jinak by se seznam v UI přeskládal
        // při každém nasazení.
        diagnoses.sort((a, b) => a.id.localeCompare(b.id));
        allergens.sort((a, b) => a.id.localeCompare(b.id));

        return { ready: true, ruleSetIds: tenant.ruleSetIds, diagnoses, allergens };
    }
}
