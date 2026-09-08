/**
 * UKÁZKA CELÉHO TOKU proti reálnému katalogu Tutani.
 *
 * Profil psa → dávka → rozpad → konkrétní balení → cena. Bez UI,
 * bez databáze: ověřuje, že vrstvy do sebe pasují a že výsledek
 * dává obchodní smysl.
 *
 * Katalog se bere z JSON, který vypadne z `scrape-dry-run.ts --json`.
 *
 *   npx tsx scripts/scrape-dry-run.ts --all --json /tmp/katalog.json
 *   npx tsx scripts/ukazka-toku.ts /tmp/katalog.json
 */

import {readFileSync} from 'node:fs';
import { calculateDose } from '../src/engine/feeding-calculator/calculateDose.js';
import { matchProducts } from '../src/engine/product-matching/matchProducts.js';
import { resolveBarfGroup } from '../src/adapters/tutani-catalog/parseProductPage.js';
import { resolveWeightConflict, medianPricePerKg } from '../src/adapters/tutani-catalog/resolveWeightConflict.js';
import { TUTANI_TENANT } from '../tenants/tutani/config/tenant.js';
import type { CompositionLimit, ResolvedConstraints } from '../src/domain/health/Condition.js';

const raw=JSON.parse(readFileSync(new URL('../tenants/tutani/rules/barf-core.json', import.meta.url),'utf-8'));
const M={doseMatrix:raw.doseMatrix,conflictResolution:raw.conflictResolution,compositionProfile:raw.compositionProfile,sourceVersion:raw.sourceVersion};
const katalogPath=process.argv[2];
if(!katalogPath){console.error('Použití: npx tsx scripts/ukazka-toku.ts <katalog.json>');process.exit(1);}
const scraped=JSON.parse(readFileSync(katalogPath,'utf-8'));

// katalog -> CatalogProduct
const groupOf=(p:any)=>resolveBarfGroup(p.categoryPath,TUTANI_TENANT.categoryMap,p.name);
const medians=new Map<string,number|null>();
for(const g of ['MUSCLE','BONE','LIVER','ORGAN','PLANT','SUPPLEMENT','OTHER']) medians.set(g,medianPricePerKg(scraped,groupOf,g as any));

const catalog:any[]=[]; let skip=0;
for(const p of scraped){
  const g=groupOf(p);
  const dec=resolveWeightConflict(p,medians.get(g)??null);
  if(dec.kind==='UNRESOLVED'||p.priceWithVat===null){skip++;continue;}
  // ingredience zjednodusene z nazvu (znalostni vrstva prijde pozdeji)
  const n=p.name.toLowerCase();
  const ing:string[]=[];
  for(const [k,v] of [['kuř','kure'],['kuře','kure'],['hověz','hovezi'],['krůt','kruti'],['kachn','kachna'],['vepř','vepr'],['králič','kralik'],['ušák','kralik'],['koňsk','kun'],['ryb','ryba'],['losos','losos'],['mrkev','mrkev'],['řepa','repa']] as const)
    if(n.includes(k)) ing.push(v);
  catalog.push({sku:p.sku,name:p.name,url:p.url,priceCzk:p.priceWithVat,packGrams:dec.grams,group:g,
    inStock:(p.stockQuantity??0)>0,productId:p.productId,priceId:null,ingredientIds:ing,isCooked:false});
}
console.log(`katalog: ${catalog.length} pouzitelnych, ${skip} bez gramaze/ceny\n`);

const C=():ResolvedConstraints=>({useIdealWeight:false,compositionLimits:[] as CompositionLimit[],excludedIngredientIds:new Set<string>(),preferredIngredientIds:new Set<string>(),productAttrFilters:[],warnings:[],blocked:false,blockedBy:[],requiresVet:false});

function run(label:string,dog:any,c=C(),days=30){
  const d=calculateDose(dog,M,c);
  console.log(`━━━ ${label}`);
  if(d.status!=='OK'){console.log(`  ${d.status}: ${d.reason}\n`);return;}
  console.log(`  ${d.ruleLabelCs} → ${d.pctUsed!.toFixed(2)} % z ${d.baseWeightKg} kg = ${d.totalGramsPerDay} g/den (${d.portions!.count}× ${d.portions!.gramsPerPortion} g)`);
  const m=matchProducts(d.composition,catalog,c,days);
  for(const it of d.composition){
    const p=m.products.find((x:any)=>x.group===it.group);
    const u=m.uncovered.find((x:any)=>x.group===it.group);
    if(p) console.log(`    ${it.labelCs.padEnd(18)} ${String(it.grams).padStart(4)} g/den → ${String(p.packs).padStart(2)}× ${p.name.slice(0,34).padEnd(36)} ${String(p.totalPriceCzk).padStart(6)} Kc`);
    else console.log(`    ${it.labelCs.padEnd(18)} ${String(it.grams).padStart(4)} g/den → NEPOKRYTO (${u?.reason})`);
  }
  console.log(`  CELKEM na ${days} dni: ${m.totalPriceCzk} Kc  (${Math.round(m.totalPriceCzk/days)} Kc/den)\n`);
}

const base={name:'Rex',weightKg:24,ageMonths:36,sex:'MALE',neutered:false,activity:'MEDIUM',bodyCondition:'IDEAL',physiologicalState:'NONE',conditionIds:[],allergyIngredientIds:[]};
run('Rex, 24 kg, dospely, stredni aktivita',base);
run('Bela, 8 kg, stene 4 mesice',{...base,name:'Bela',weightKg:8,ageMonths:4});
run('Max, 30 kg, nadvaha (idealne 24)',{...base,name:'Max',weightKg:30,idealWeightKg:24,bodyCondition:'OVER'});
const ca=C(); ca.excludedIngredientIds=new Set(['kure','kruti','kachna']);
run('Rex s alergii na drubez',base,ca);
const ck=C(); ck.compositionLimits=[{group:'BONE',maxPct:8,ruleId:'ckd:bone-limit'}];
run('Rex s onemocnenim ledvin (kosti max 8 %)',base,ck);
run('Rex, tydenni zasoba',base,C(),7);
