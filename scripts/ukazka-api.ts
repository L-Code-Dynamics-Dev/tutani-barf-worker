/**
 * UKÁZKA CELÉHO API TOKU — validace → pravidla → výpočet → produkty.
 *
 * Přesně to, co dělá `POST /v1/davka`, ale bez HTTP a bez D1. Slouží
 * k ověření, že vrstvy do sebe pasují po každé změně pravidel nebo
 * katalogu.
 *
 *   npx tsx scripts/ukazka-api.ts
 */

import { readFileSync } from 'node:fs';
import { validateDoseRequest } from '../src/api/validateInput.js';
import { resolveConstraints, buildKnowledgeBase } from '../src/rules/RuleEngine.js';
import { calculateDose } from '../src/engine/feeding-calculator/calculateDose.js';
import { matchProducts } from '../src/engine/product-matching/matchProducts.js';
import { resolveBarfGroup } from '../src/adapters/tutani-catalog/parseProductPage.js';
import { resolveWeightConflict, medianPricePerKg } from '../src/adapters/tutani-catalog/resolveWeightConflict.js';
import { TUTANI_TENANT } from '../tenants/tutani/config/tenant.js';

const raw = JSON.parse(readFileSync(new URL('../tenants/tutani/rules/barf-core.json', import.meta.url),'utf-8'));
const M = { doseMatrix: raw.doseMatrix, conflictResolution: raw.conflictResolution, compositionProfile: raw.compositionProfile, sourceVersion: raw.sourceVersion };
const kb = buildKnowledgeBase(
  JSON.parse(readFileSync(new URL('../tenants/tutani/rules/tutani-health.json', import.meta.url),'utf-8')),
  JSON.parse(readFileSync(new URL('../tenants/tutani/rules/ingredients.json', import.meta.url),'utf-8')), raw);
const scraped = JSON.parse(readFileSync(new URL('../tests/fixtures/katalog-2026-09-09.json', import.meta.url),'utf-8'));
const g=(p:any)=>resolveBarfGroup(p.categoryPath,TUTANI_TENANT.categoryMap,p.name);
const med=new Map<string,number|null>();
for(const k of ['MUSCLE','BONE','LIVER','ORGAN','PLANT','SUPPLEMENT','OTHER'] as const) med.set(k,medianPricePerKg(scraped,g,k));
const catalog:any[]=[];
for(const p of scraped){const k=g(p);const d:any=resolveWeightConflict(p,med.get(k)??null);
  if(d.kind==='UNRESOLVED'||p.priceWithVat===null)continue;
  const n=p.name.toLowerCase();const ing:string[]=[];
  for(const [a,b] of [['kuř','kure'],['hověz','hovezi'],['krůt','kruti'],['kachn','kachna'],['vepř','vepr'],['králič','kralik'],['ušák','kralik'],['ryb','ryba'],['losos','losos'],['mrkev','mrkev'],['srnec','zverina'],['jelen','zverina']] as const) if(n.includes(a)&&!ing.includes(b))ing.push(b);
  catalog.push({sku:p.sku,name:p.name,url:p.url,priceCzk:p.priceWithVat,packGrams:d.grams,group:k,
    inStock:(p.stockQuantity??0)>0,productId:p.productId,priceId:p.productId,ingredientIds:ing,isCooked:false});}

// TOK JAKO V API: validace -> pravidla -> vypocet -> produkty
function tok(label:string, telo:any){
  console.log('━━━',label);
  const v:any = validateDoseRequest(telo);
  if(!v.ok){console.log('  VALIDACE ODMITLA:',JSON.stringify(v.issues).slice(0,140));console.log();return;}
  const dog=v.value.dog;
  const c=resolveConstraints(dog.conditionIds,dog.allergyIngredientIds,kb);
  const d=calculateDose(dog,M,c);
  if(d.status!=='OK'){console.log(`  ${d.status} (${d.reason})`);console.log();return;}
  const m=matchProducts(d.composition,catalog,c,v.value.periodDays);
  console.log(`  ${d.totalGramsPerDay} g/den (${d.ruleLabelCs}) | ${m.totalPriceCzk} Kc / ${v.value.periodDays} dni | produktu ${m.products.length}`);
  if(m.uncovered.length) console.log('  NEPOKRYTO:',m.uncovered.map((u:any)=>u.labelCs).join(', '));
  if(c.warnings.length) console.log(`  varovani: ${c.warnings.length}× (${c.warnings[0].severity})`);
  console.log();
}
const p=(o:any={})=>({pes:{jmeno:'Rex',hmotnostKg:24,vekMesicu:36,pohlavi:'MALE',kastrovany:false,aktivita:'MEDIUM',kondice:'IDEAL',fyziologickyStav:'NONE',diagnozy:[],alergie:[],...o},obdobiDni:30});
tok('zdravý pes', p());
tok('CKD počáteční', p({diagnozy:['ckd-early']}));
tok('CKD pokročilé (blok)', p({diagnozy:['ckd-advanced']}));
tok('alergie na drůbež', p({alergie:['kure','kruti','kachna']}));
tok('nadváha bez ideální hmotnosti', p({kondice:'OVER'}));
tok('nadváha s ideální', p({kondice:'OVER',idealniHmotnostKg:20}));
tok('CHYBA: pohlaví PES', p({pohlavi:'PES'}));
tok('CHYBA: hmotnost 500 kg', p({hmotnostKg:500}));
