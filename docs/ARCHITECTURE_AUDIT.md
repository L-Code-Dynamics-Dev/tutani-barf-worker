# ARCHITECTURE AUDIT — Tutani BARF Worker → Nexus Pet Nutrition Engine

Datum: 2026-09-12
Autor: Claudik (audit před přerodem na multi-tenant Nexus Pet Nutrition Engine)
Zadavatel: Josef Dlouhý (za Nexus)

Cíl dokumentu: popsat současný stav repozitáře fakticky (ne z paměti/PROGRESS_LOG dojmu),
identifikovat co zachovat, co je dluh, co chybí, a navrhnout cílovou architekturu a pořadí prací.
**Žádný kód se v tomto kroku neměnil.**

---

## 0. Ověřeno před psaním auditu

```
npx tsc --noEmit   → 0 chyb
npm test           → 211/211 zelených (11 test souborů, 2613 řádků testů)
```

Repo je v čistém, funkčním stavu. Tohle NENÍ prototyp, který je potřeba přepsat —
je to solidní jednotenantová implementace s dobře navrženými hranicemi, která
zatím nedotáhla vlastní již postavenou nutriční vrstvu do zapojení.

---

## 1. Současná architektura — co skutečně existuje

```
tenants/tutani/
├── config/tenant.ts          TenantConfiguration (jeden tenant, staticky registrovaný)
└── rules/
    ├── barf-core.json            dose matrix + composition profile (% z hmotnosti)
    ├── barf-safety.json          toxické suroviny, obecná bezpečnost
    ├── tutani-health.json        conditions + conditionRules (27 KB)
    ├── ingredients.json          surovinový slovník (BarfGroup, isToxic)
    ├── ingredients-nutrition.json  USDA-style nutriční data surovin (11 klíčů — MALÝ vzorek)
    ├── fediaf-2025.json          FEDIAF nutrient targets (10 KB)
    ├── tutani-catalog-categories.json  stav extrakce kategorií
    ├── tutani-products.json      128 TutaniProduct záznamů (ingredient-level)
    └── tutani-supplements.json   Supplement záznamy (doplňky, oleje, pamlsky)

src/
├── domain/
│   ├── tenant.ts              TenantConfiguration, BarfGroup, CatalogSource — R4 hranice
│   ├── dog/DogProfile.ts      profil psa, LifeStage odvození
│   ├── health/Condition.ts    Condition, ConditionRule, ResolvedConstraints (TVAR, ne data)
│   ├── nutrition/
│   │   ├── Ingredient.ts      NutrientValue s provenance (status/confidence/source) — VYSOKÁ KVALITA
│   │   ├── energy.ts          RER/MER, FEDIAF koeficienty, zdrojová hierarchie
│   │   └── assessment.ts      dvouosé hodnocení (nutrition/safety), CONTROL_POINTS (17 živin)
│   └── products/
│       ├── TutaniProduct.ts   ingredient-level produkt (composition[], evidence)
│       ├── Composition.ts     IngredientComposition s certainty EXACT/DERIVED/PARTIAL/UNKNOWN
│       ├── Supplement.ts      doplňky s declared/derivedPer100g, marketingClaims odděleny
│       └── CatalogCategory.ts extrakční stav kategorie (chybějící ≠ nula)
├── rules/
│   ├── RuleEngine.ts           čistý interpret JSON pravidel → ResolvedConstraints
│   └── KnowledgeRuleEngine.ts  most mezi JSONem a API (fail-closed při chybě načtení)
├── engine/
│   ├── feeding-calculator/     % z hmotnosti → gramy (BarfGroup úroveň), renormalizace, audit
│   └── product-matching/       gramy → balení z D1 katalogu (BarfGroup úroveň)
├── adapters/tutani-catalog/     Shoptet DOM scraper, parsování složení, řešení konfliktu gramáže
├── api/handlers.ts              orchestrace, CORS, disclaimer v odpovědi (ne v šabloně)
└── infrastructure/D1ProductStore.ts   D1 store, multi-tenant SQL (tenant_id vždy v WHERE)
```

### 1.1 Dvě paralelní produktové vrstvy — klíčové zjištění

V repu **existují dvě nezávislé produktové reprezentace**, které dnes nejsou propojené:

| | `D1ProductStore` / `products` tabulka | `TutaniProduct` / `tutani-products.json` |
|---|---|---|
| úroveň | `BarfGroup` (MUSCLE/BONE/LIVER/…) | `ingredientId` (konkrétní surovina) |
| zdroj | živý Shoptet scraper (cron, denně) | ruční/agentní import z popisků (jednorázový) |
| používá ho | `calculateDose` + `matchProducts` (OSTRÝ PROVOZ) | nic v `src/engine/` — zatím žádný spotřebitel |
| nutriční hodnoty | žádné | odkaz na `Ingredient.nutrients` (USDA), ale nenapojeno |
| composition | `ingredients: string[]` (jen ID, bez %) | `composition: IngredientComposition[]` s procenty a jistotou |

**Důsledek:** dnešní produkční výpočet dávky pracuje jen s "kolik gramů masa/kostí/orgánů/zeleniny"
a vůbec neví, kolik je v tom vápníku, fosforu, EPA/DHA. `CONTROL_POINTS` v `assessment.ts` to
sám přiznává — 16 z 17 kontrolovaných živin je `available: false`. `TutaniProduct` +
`Ingredient.nutrients` + `fediaf-2025.json` existují přesně proto, aby se tohle vyplnilo,
ale **žádný engine soubor je zatím nečte**. Je to nejdůležitější "co chybí pro skutečný produkt"
z celého auditu — základ pro Nutrient Engine (bod 6 zadání) je z 60 % postavený jako data a typy,
z 0 % zapojený do výpočtu.

---

## 2. Co zachovat beze změny (R1-R7 už jsou v kódu, ne jen v hlavě)

Zadání žádá přesně tyhle principy — a všechny už existují a jsou otestované:

1. **Determinismus, žádné LLM** — `calculateDose`, `RuleEngine`, `matchProducts` jsou čisté
   funkce, `Decimal` místo float, deterministické řazení (SKU jako poslední rozhodčí).
2. **Výpočet na serveru** — frontend (`frontend/konfigurator.js`) posílá jen strukturovaný vstup.
3. **Knowledge base jako data** — žádná nemoc/alergie/limit není v TS, všechno v `tenants/*/rules/*.json`.
4. **Oddělení výpočtu a katalogu** — `calculateDose` nezná SKU, `matchProducts` nepočítá dávku (R6).
   Hranice je vynucená typově (`CompositionItem` nemá produktové pole).
5. **Tenant model bez `if`** — `TenantConfiguration`, `TenantRegistry` rozhraní, `resolveTenant()`
   háže chybu na neznámý tenant místo tichého fallbacku. Ověřeno: `grep -r "tenant ==="` — nic.
6. **Fail-safe stavy** — `DoseStatus`: `OK | BLOCKED | INCOMPLETE`, `UnappliedRule`,
   `unknownConditionIds`, `ownerExcludedIngredientIds` (fail-closed u neznámé suroviny).
   `ValueStatus`: `MEASURED | NOT_ANALYZED | TRACE | NOT_PRESENT` — přesně to, co bod 6 zadání žádá.
7. **Auditní stopa místo black boxu** — `AuditEntry[]` u každého kroku výpočtu, `ResolveResult`
   nese `appliedConditionIds`, `unappliedRules`, `ruleSetId`.
8. **Bezpečnostní ventil** — `blocksResult` je datové pole u `Condition`, ne kód; `status: BLOCKED`
   vrací `HTTP 200` (validní požadavek, jen se dávka nevydává) — správný kontrakt.
9. **PROGRESS_LOG.md** dokumentuje nálezy auditů a jejich opravy datovaně — hodnotný artefakt,
   zachovat konvenci.

Tři samostatné testy (`alergieKontrakt.test.ts`) existují SPECIFICKY proti regresi nálezu, kdy
`/v1/knowledge` posílalo id podmínky a `matchProducts` čekalo id suroviny — to je přesně ten typ
"tichého selhání bezpečnostního pravidla", kterého se zadání bojí. Historie PROGRESS_LOG ukazuje,
že tenhle tým už minimálně 4× našel a opravil přesně tenhle druh chyby (NOOP rule engine v produkci,
negativní procenta, fail-open na neznámé surovině, `BONE`-only cooked filtr). To je silný signál,
že bezpečnostní disciplína je zavedená a funguje — stavět na tom, ne přepisovat.

---

## 3. Technický dluh

### 3.1 Nutriční vrstva nezapojená do výpočtu (D-1, kritické)
Popsáno v 1.1. `energy.ts`, `Ingredient.ts`, `assessment.ts`, `fediaf-2025.json`, `TutaniProduct`
existují, ale `calculateDose`/`matchProducts` je nepoužívají. Nutrient Engine, Reference Standards
vrstva (FEDIAF) a Confidence Engine (bod 22 zadání) jsou tu z většiny navržené — chybí propojka.

### 3.2 Single-tenant registry (D-2)
`TENANTS: Record<string, TenantConfiguration>` v `src/index.ts` má jeden hardcoded záznam
(`TUTANI_TENANT`). `TenantRegistry` interface existuje, ale žádná implementace ho nečte z D1/KV —
přidání druhého tenanta dnes znamená edit `src/index.ts`, ne datovou operaci. To porušuje R4 v duchu
(ne v liteře — pořád nikde není `if tenant===`), protože registr sám není data, je kompilovaný.

### 3.3 Rule engine nezná NUTRIENT_LIMIT (D-3)
`RuleEngine.ts` řádek 325-347: `NUTRIENT_LIMIT` se VŽDY zapíše jako `unappliedRules` — engine
nemá žádnou cestu k vyhodnocení limitu na živinu, protože nemá po ruce nutriční data produktu.
Přímý důsledek D-1: dokud se nenapojí `Ingredient.nutrients`, CKD dieta nemůže reálně omezit fosfor,
jen to řekne jako "neuplatnilo se".

### 3.4 Product matching na úrovni skupiny, ne suroviny (D-4)
`matchProducts` filtruje/vybírá produkty podle `BarfGroup` (5 skupin). Cílová architektura
(Product Matching Engine, bod 13 zadání) potřebuje matching na úrovni `ingredientId` a nutričního
pokrytí, ne jen "MUSCLE vs BONE". `TutaniProduct.composition` už tenhle detail nese — matching ho
nečte.

### 3.5 Duplicitní/rozestavěná data z posledních importů (D-5, menší)
PROGRESS_LOG.md poslední zápisy popisují otevřené nálezy k rozhodnutí: 4 kódy (07/2559/9493/2553)
strukturálně patří do `tutani-products.json`, ale zůstaly v `tutani-supplements.json`; slug/název
nesrovnalost u `dromy-ascokelp-360-g`; možná duplicita Konopný olej. Žádné z toho neblokuje
architekturu, ale je to čekající úklid dat — neřešit v rámci Fáze 1 (audit/refactor), zmínit
klientovi/Luckymu jako otevřené položky.

### 3.6 `ingredients-nutrition.json` pokrývá jen 11 surovin (D-6)
Malý vzorek proti stovkám SKU v katalogu. I po zapojení nutriční vrstvy (D-1) bude většina
produktů bez nutričních dat → `ORIENTACNI`/`NEZNAME` stavy budou převažovat. To je SPRÁVNÉ chování
podle R7 (nehádat), ale znamená to, že "produkčně použitelný" nutriční engine bude zpočátku
transparentně orientační, ne kontrolovaný — nutné komunikovat klientovi, ne skrývat.

### 3.7 Zero-width space v komentářích (D-7, kosmetické)
`src/rules/RuleEngine.ts:4` a `src/domain/health/Condition.ts:6` obsahují neviditelný
U+200B uvnitř `tenants/*​/rules/` — vzniklo zjevně kopírováním z jiného zdroje. Bez bezpečnostního
dopadu (jen v komentáři), ale stojí za drobný úklid při příští editaci souboru.

---

## 4. Rizika

| riziko | dopad | dnešní stav |
|---|---|---|
| Nutriční doporučení se tváří jako "vypočtené", ale reálně je to jen % z hmotnosti | zdravotní | `assessment.ts` to už řeší (`ORIENTACNI` level, `NEZNAME` per-živina) — riziko je OŠETŘENÉ, dokud se komunikace nezmění |
| Multi-tenant rozšíření bez datové vrstvy pro registry | bezpečnost/izolace | zatím 1 tenant, žádný reálný cross-tenant risk, ale při 2. tenantovi bez D1/KV registru hrozí, že přidání klienta = deploy, ne konfigurace |
| `NUTRIENT_LIMIT` pravidla v `tutani-health.json` jsou napsaná, ale tiše se nevyhodnocují | zdravotní (CKD fosfor) | přiznané přes `unappliedRules`, ne skryté — ale klinicky neúčinné, dokud se nezapojí D-1 |
| Rozšíření na víc tenantů/e-shopů bez abstrakce `CatalogProvider` | technický dluh | `CatalogSource.kind` existuje (`SHOPTET_DOM|SHOPTET_FEED|WOO_REST|STATIC`), ale jen `SHOPTET_DOM` má implementaci — abstrakce je připravená, ne naplněná |
| Secrets/env | bezpečnost | `wrangler.jsonc` nemá žádné hardcoded secrets, `TENANT_ID` je jediná env var, D1 binding bez credentials v kódu — čisté |

---

## 5. Cílová architektura (přizpůsobená realitě repa, ne přepis od nuly)

Zadání navrhuje 12 core enginů. Realita: 4 z nich už existují jako moduly, zbytek se dá stavět
jako INKREMENT nad nimi, ne jako paralelní systém.

```
CORE (existuje → cílový název)
├── Animal Profile         DogProfile.ts → rozšířit (BCS, growth tracking, feeding method)
├── Energy Engine          energy.ts → beze změny, je hotový a správně navržený
├── Nutrition Engine       Ingredient.ts + assessment.ts + fediaf-2025.json → PROPOJIT s calculateDose
├── Rule Engine            RuleEngine.ts + KnowledgeRuleEngine.ts → rozšířit NUTRIENT_LIMIT o reálné vyhodnocení
├── Safety Engine          už fakticky existuje (blocksResult, toxic, alergie) → vyčlenit z RuleEngine
│                          do vlastního modulu jen pokud to zpřehlední, NE přepis kvůli jménu
├── Diet Composition Engine   calculateDose.ts (splitComposition) → beze změny principu, napojit nutrienty
├── Recipe Engine          NOVÝ — nad Composition Engine, výstup nese nutrient coverage
├── Optimization Engine    NOVÝ — Fáze 4, ne teď
├── Product Matching Engine   matchProducts.ts → rozšířit z BarfGroup na ingredient-level (D-4)
├── Recommendation Engine  fakticky handleDose dnes — formalizovat jako vlastní vrstvu při SDK/multi-tenant
├── Explainability Engine  AuditEntry[] už existuje — stačí ho standardizovat přes všechny enginy
└── Confidence Engine      NOVÝ, ale `DataConfidence`/`ValueStatus`/`CompositionCertainty` typy
                           už nesou přesně tenhle koncept — potřeba jen agregace do jednoho skóre

DATA (existuje)
├── Nutrient Database      Ingredient.ts + ingredients-nutrition.json (11 → potřeba rozšířit)
├── Ingredient Database    ingredients.json
├── Product Database       products (D1) + tutani-products.json + tutani-supplements.json (SLOUČIT CESTU, D-1/D-4)
├── Disease/Allergy DB     tutani-health.json
├── Standards              fediaf-2025.json (FEDIAF) — NRC/AAFCO NEJSOU, přidat při reálné poptávce
└── Knowledge Base         barf-core.json, barf-safety.json

INTEGRATIONS
├── Tutani/Shoptet adapter    tutani-catalog/* → ponechat, je to referenční implementace CatalogProvider
├── Generic catalog adapter   NOVÝ — extrahovat `CatalogProvider` interface z `ProductStore`+syncCatalog
└── Nexus Commerce adapter    budoucí — až Nexus bude mít vlastní commerce vrstvu

APPLICATION
└── dnešní 3 endpointy (/v1/davka, /v1/knowledge, /v1/health) → verzovat na /v1/ pevně,
    nová funkcionalita jde do nových cest, ne přepisem starých
```

**Klíčový architektonický závěr:** tohle NENÍ "postav Nexus Pet Nutrition Engine vedle Tutani
Workeru". Je to "dokonči propojení nutriční vrstvy, kterou už repo má, pak zobecni tenant registry
z compiled na datový, pak přidej multi-tenant SDK vrstvu". Přepis od nuly by zahodil 2613 řádků
otestované, bezpečnostně prověřené logiky a znovu by se muselo objevovat to, co PROGRESS_LOG.md
ukazuje, že už bylo objeveno a opraveno (fail-open bugy, negativní procenta, NOOP rule engine).

---

## 6. Konkrétní implementační plán (fázovaný, žádný obří commit)

### Fáze 1 — Nutrient Engine propojení (nejvyšší hodnota, nejnižší riziko)
1. Napojit `TutaniProduct.composition` + `Ingredient.nutrients` do nové čisté funkce
   `calculateNutrientCoverage(composition: CompositionItem[], products: TutaniProduct[], targets: NutrientTarget[])`
   — vrací `NutrientCheck[]` kompatibilní s existujícím `assessNutrition()`.
2. Zapojit výstup do `buildResponse()` v `handlers.ts` jako nové pole (NEPŘEPISOVAT `slozeni`/`produkty`).
3. Testy: golden case s produktem, který MÁ kompletní composition+nutrienty (ověřit číslo),
   a produktem s `PARTIAL`/`NOT_ANALYZED` (ověřit, že se propíše jako neúplné, ne jako nula).
4. `npm test` + `tsc --noEmit` musí zůstat zelené po každém kroku.

### Fáze 2 — NUTRIENT_LIMIT reálné vyhodnocení
1. `RuleEngine.ts`: jakmile `availableNutrients` (dnes prázdné pole) dostane obsah z Fáze 1,
   `NUTRIENT_LIMIT` pravidla (CKD fosfor) se přestanou zapisovat jako `unappliedRules` a začnou
   reálně omezovat výběr produktů.
2. Rozšířit `ingredients-nutrition.json` o klíčové chybějící suroviny (vitamin D, E, jód, EPA/DHA —
   to je přesně otevřený bod z paměti "BARF" tag) z USDA FoodData Central, se `sourceRef`.

### Fáze 3 — Tenant registry na data
1. `TenantRegistry` implementace nad D1/KV místo `Record<string, TenantConfiguration>`.
2. `resolveTenant()` čte z registru async — beze změny signatur volajících.
3. Přidání druhého tenanta = insert do D1, ne deploy.

### Fáze 4 — CatalogProvider abstrakce
1. Extrahovat `interface CatalogProvider { getProducts(), getProduct(), getAvailability() }`
   z dnešního `syncCatalog.ts` + `ProductStore`.
2. `SHOPTET_DOM` adapter implementuje `CatalogProvider` — beze změny chování.
3. Teprve TEĎ dává smysl druhý adapter (generic feed/WooCommerce), pokud přijde druhý klient.

### Fáze 5+ — Optimization/Recipe/SDK/multi-tenant dashboard
Podle zadání bodů 10, 24-26 — ale až po Fázi 1-4, protože bez nutričních dat nemá optimalizace
co optimalizovat (dnes by optimalizovala jen gramáž skupin, což už dělá `splitComposition`).

**Po každé fázi:** `npm test && npx tsc --noEmit`, zápis do `PROGRESS_LOG.md` s datem a nálezy —
konzistentně s dosavadní praxí repa.

---

## 7. Co se v tomto kroku NEDĚLALO (záměrně)

Podle zadání (bod 37, 41) a podle Non-Interference pravidla: žádný kód nebyl měněn, žádná
data nebyla migrována, žádný refactor nezačal. Tenhle dokument je vstup pro rozhodnutí, ne
proveden krok. Čeká na schválení směru (zejména pořadí Fáze 1 vs. jiné priority) před tím,
než se začne cokoliv implementovat.
