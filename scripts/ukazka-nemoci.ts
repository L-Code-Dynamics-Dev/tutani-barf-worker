/**
 * UKÁZKA ZDRAVOTNÍCH PRAVIDEL — celý tok včetně nemocí a alergií.
 *
 * Ověřuje, že rule engine, výpočet a matching do sebe pasují na
 * reálném katalogu. Bez UI, bez databáze.
 *
 *   npx tsx scripts/ukazka-nemoci.ts tests/fixtures/katalog-2026-09-09.json
 */

import { readFileSync } from 'node:fs';
import { resolveConstraints, buildKnowledgeBase } from '../src/rules/RuleEngine.js';
import { calculateDose } from '../src/engine/feeding-calculator/calculateDose.js';
import { matchProducts } from '../src/engine/product-matching/matchProducts.js';
import { resolveBarfGroup } from '../src/adapters/tutani-catalog/parseProductPage.js';
import { resolveWeightConflict, medianPricePerKg } from '../src/adapters/tutani-catalog/resolveWeightConflict.js';
import { TUTANI_TENANT } from '../tenants/tutani/config/tenant.js';

const raw = JSON.parse(readFileSync(new URL('../tenants/tutani/rules/barf-core.json', import.meta.url), 'utf-8'));
const M = { doseMatrix: raw.doseMatrix, conflictResolution: raw.conflictResolution, compositionProfile: raw.compositionProfile, sourceVersion: raw.sourceVersion };

const path = process.argv[2];
if (!path) { console.error('Použití: npx tsx scripts/ukazka-nemoci.ts <katalog.json>'); process.exit(1); }
const scraped = JSON.parse(readFileSync(path, 'utf-8'));

const groupOf = (p: any) => resolveBarfGroup(p.categoryPath, TUTANI_TENANT.categoryMap, p.name);
const medians = new Map<string, number | null>();
for (const g of ['MUSCLE','BONE','LIVER','ORGAN','PLANT','SUPPLEMENT','OTHER'] as const) {
    medians.set(g, medianPricePerKg(scraped, groupOf, g));
}

const catalog: any[] = [];
for (const p of scraped) {
    const g = groupOf(p);
    const dec = resolveWeightConflict(p, medians.get(g) ?? null);
    if (dec.kind === 'UNRESOLVED' || p.priceWithVat === null) continue;
    const n = p.name.toLowerCase();
    const ing: string[] = [];
    for (const [k, v] of [['kuř','kure'],['kuře','kure'],['hověz','hovezi'],['krůt','kruti'],['kachn','kachna'],['vepř','vepr'],['králič','kralik'],['ušák','kralik'],['koňsk','kun'],['ryb','ryba'],['losos','losos'],['mrkev','mrkev'],['řep','repa']] as const) {
        if (n.includes(k) && !ing.includes(v)) ing.push(v);
    }
    catalog.push({ sku: p.sku, name: p.name, url: p.url, priceCzk: p.priceWithVat, packGrams: (dec as any).grams,
        group: g, inStock: (p.stockQuantity ?? 0) > 0, productId: p.productId, priceId: null, ingredientIds: ing, isCooked: false });
}

const kb = buildKnowledgeBase(
    JSON.parse(readFileSync(new URL('../tenants/tutani/rules/tutani-health.json', import.meta.url), 'utf-8')),
    JSON.parse(readFileSync(new URL('../tenants/tutani/rules/ingredients.json', import.meta.url), 'utf-8')),
    raw
);
console.log(`katalog: ${catalog.length} produktů | znalostní báze: ${kb.conditions.length} stavů, ${kb.conditionRules.length} pravidel, ${kb.ingredientIds.length} surovin, ${kb.alwaysExcludedIngredientIds.length} vždy zakázaných\n`);

const pes = (o: any = {}) => ({ name:'Rex', weightKg:24, ageMonths:36, sex:'MALE' as const, neutered:false,
    activity:'MEDIUM' as const, bodyCondition:'IDEAL' as const, physiologicalState:'NONE' as const,
    conditionIds:[] as string[], allergyIngredientIds:[] as string[], ...o });

function run(label: string, dog: any, dni = 30) {
    console.log('━━━', label);
    const c = resolveConstraints(dog.conditionIds, dog.allergyIngredientIds, kb);
    console.log(`  omezení: zakázáno ${c.excludedIngredientIds.size} surovin, ${c.compositionLimits.length} limitů, vet=${c.requiresVet}, blokováno=${c.blocked}`);
    const d = calculateDose(dog, M, c);
    if (d.status !== 'OK') { console.log(`  ${d.status}: ${d.reason}`); if (c.warnings.length) c.warnings.forEach(w=>console.log(`   ⚠ ${w.textCs.slice(0,90)}`)); console.log(); return; }
    console.log(`  ${d.ruleLabelCs} → ${d.totalGramsPerDay} g/den`);
    for (const it of d.composition) {
        const mark = it.adjusted ? ` ← ${it.adjustedBy}` : '';
        console.log(`    ${it.labelCs.padEnd(18)} ${String(it.grams).padStart(4)} g  ${String(it.pct).padStart(4)} %${mark}`);
    }
    const m = matchProducts(d.composition, catalog, c, dni);
    console.log(`  nákup na ${dni} dní: ${m.totalPriceCzk} Kč`);
    for (const p of m.products) console.log(`    ${p.packs}× ${p.name.slice(0,42)}`);
    if (m.uncovered.length) for (const u of m.uncovered) console.log(`    ⛔ ${u.labelCs} NEPOKRYTO (${u.reason})`);
    for (const w of c.warnings) console.log(`   ⚠ [${w.severity}] ${w.textCs.slice(0,100)}`);
    console.log();
}

run('zdravý pes', pes());
run('nemocné ledviny, počáteční stadium', pes({ conditionIds: ['ckd-early'] }));
run('nemocné ledviny, POKROČILÉ (musí zablokovat)', pes({ conditionIds: ['ckd-advanced'] }));
run('onemocnění jater', pes({ conditionIds: ['onemocneni-jater'] }));
run('ukládání měďi (nejtvrdší limit na játra)', pes({ conditionIds: ['med-hepatopatie'] }));
run('CKD + jaterní: KOMBINACE dvou limitů', pes({ conditionIds: ['ckd-early','onemocneni-jater'] }));
run('CKD + alergie na kuřecí', pes({ conditionIds: ['ckd-early'], allergyIngredientIds: ['kure'] }));
run('neznámá diagnóza (nesmí projít tiše)', pes({ conditionIds: ['vymyslena-nemoc'] }));
