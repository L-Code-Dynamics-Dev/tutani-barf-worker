# BARF konfigurátor Tutani — architektura

Klient: Ladislav Švihel, tutani.cz
E-shop: `obchod.tutani.cz` — **Shoptet** (ověřeno 2026-09-08)
Zadavatel na naší straně: Josef Dlouhý
Verze návrhu: v1, 2026-09-08

## 0. Rozhodnutí, která platí napříč dokumentem

| # | rozhodnutí | důvod |
|---|---|---|
| R1 | **Žádné LLM nikde v systému** | Lucky 2026-09-08. Krmná dávka je zdravotní doporučení — musí být deterministická, reprodukovatelná a obhajitelná. Vysvětlení „proč 560 g" se skládá z auditní stopy pravidel, ne z modelu. |
| R2 | Konfigurátor, ne dialogový asistent | Údaje se sbírají strukturovaně v UI. Klientův návrh 10 otázek za sebou = odpadlíci a nulová kontrola vstupů. |
| R3 | Výpočet **výhradně na Workeru** | Frontend nesmí počítat dávku ani rozhodovat o vhodnosti produktu. Stejný vzor jako hecmania price engine. |
| R4 | Výpočet potřeby je oddělen od výběru produktů | Katalog se mění denně, metodika BARF ne. Změna sortimentu se nesmí dotknout výpočetního jádra. |
| R5 | Pravidla jsou **data, ne kód** | Nemoci, alergie, procenta, poměry složek — všechno v JSON/D1 s verzí a zdrojem. Přidání diagnózy nesmí znamenat deploy. |
| R6 | Doporučují se **jen produkty Tutani** | Tvrdý požadavek klienta. Žádné externí zdroje, žádné dogenerování neexistujících produktů. Chybí-li údaj, systém ho **nehádá** — řekne, že chybí. |
| R7 | Zdravotní stav má přednost před obecnou metodikou | Při zadané diagnóze se obecný BARF neaplikuje slepě. |

## 1. Vrstvy

```
KONFIGURÁTOR (UI)          strukturovaný vstup, nic nepočítá
        ↓  POST /v1/davka
VALIDACE VSTUPŮ            rozsahy, kombinace, jednotky
        ↓
KNOWLEDGE / RULE ENGINE    nemoci, stavy, alergie → omezení
        ↓
BARF CALCULATOR            % z hmotnosti → gramy, deterministicky
        ↓
INGREDIENT REQUIREMENTS    potřeba po složkách (bez produktů!)
        ↓
PRODUCT MATCHING           pokrytí potřeby z katalogu Tutani
        ↓
FINAL RESULT               dávka + složení + produkty + varování + audit
```

Hranice mezi `INGREDIENT REQUIREMENTS` a `PRODUCT MATCHING` je tvrdá:
výpočetní jádro nezná ani jeden produktový kód.

## 2. Datový model — znalostní vrstva

Samostatná od katalogu (požadavek klienta, §2 zadání).

### 2.1 `conditions` — zdravotní stavy a diagnózy

```sql
CREATE TABLE conditions (
    id                TEXT PRIMARY KEY,      -- 'ckd', 'pankreatitida', 'alergie-kure'
    kind              TEXT NOT NULL,         -- DISEASE | PHYSIOLOGICAL | ALLERGY | INTOLERANCE | BODY_CONDITION
    name_cs           TEXT NOT NULL,         -- 'Chronické onemocnění ledvin'
    lay_name_cs       TEXT,                  -- 'nemocné ledviny' — co uvidí majitel
    explain_cs        TEXT,                  -- vysvětlení bez odborné hantýrky
    severity          TEXT NOT NULL,         -- INFO | CAUTION | SERIOUS | CRITICAL
    requires_vet      INTEGER NOT NULL DEFAULT 0,
    blocks_result     INTEGER NOT NULL DEFAULT 0,  -- 1 = nevydat dávku vůbec
    source            TEXT,                  -- odkud pravidlo je
    source_version    TEXT,
    updated_at        TEXT NOT NULL
);
```

`blocks_result` je bezpečnostní ventil: u stavů, kde by orientační
dávka mohla uškodit (CKD ve fázi 3+, jaterní shunt), systém dávku
nevydá a odkáže na veterinárního nutričního specialistu. Tohle je
záměrně datové rozhodnutí, ne rozhodnutí v kódu.

### 2.2 `condition_rules` — co z podmínky plyne

Nemoc **není** textové upozornění (§3 zadání). Každá nese pravidla:

```sql
CREATE TABLE condition_rules (
    id                TEXT PRIMARY KEY,
    condition_id      TEXT NOT NULL REFERENCES conditions(id),
    rule_type         TEXT NOT NULL,   -- viz tabulka níže
    target            TEXT,            -- složka dávky / ingredience / atribut produktu
    op                TEXT,            -- LTE | GTE | EQ | EXCLUDE | REQUIRE | SCALE
    value             TEXT,            -- '0.8' | 'fosfor' | 'kure'
    unit              TEXT,            -- PCT_OF_DIET | G_PER_KG | RATIO | NONE
    priority          INTEGER NOT NULL DEFAULT 100,
    note_cs           TEXT,
    source            TEXT,
    source_version    TEXT,
    updated_at        TEXT NOT NULL
);
```

| `rule_type` | co dělá | příklad |
|---|---|---|
| `DOSE_PCT_OVERRIDE` | přepíše % z hmotnosti | redukční dieta → 1–1,5 % |
| `DOSE_BASE_WEIGHT` | z jaké hmotnosti počítat | nadváha → z **ideální**, ne aktuální |
| `COMPOSITION_LIMIT` | strop/minimum složky | CKD → kosti max 8 % (fosfor) |
| `NUTRIENT_LIMIT` | limit na živinu | CKD → fosfor ↓, bílkovina ↓ |
| `INGREDIENT_EXCLUDE` | zakázaná surovina | alergie na kuřecí → `kure` |
| `INGREDIENT_PREFER` | preferovaná surovina | pankreatitida → nízkotučné |
| `PRODUCT_ATTR_EXCLUDE` | filtr na atribut produktu | vylouč `tuk_pct > 10` |
| `PORTIONS_OVERRIDE` | počet porcí denně | štěně → 3–4× |
| `WARNING` | povinné upozornění | vždy s textem a severity |

Kombinace se řeší **skládáním, ne přepisem**: CKD + alergie na kuřecí
= sjednocení zákazů a nejtvrdší z limitů (§3 zadání). Pořadí dané
`priority`, u konfliktu vyhrává striktnější hodnota.

### 2.3 `ingredients` — surovinový slovník

Mezivrstva mezi pravidly a produkty. Bez ní by alergie musela znát
produktové kódy, což by rozbilo R4.

```sql
CREATE TABLE ingredients (
    id           TEXT PRIMARY KEY,   -- 'kure', 'hovezi', 'losos', 'mrkev'
    name_cs      TEXT NOT NULL,
    species      TEXT,               -- POULTRY | BEEF | LAMB | FISH | GAME | PLANT
    barf_group   TEXT,               -- MUSCLE | BONE | LIVER | ORGAN | PLANT | SUPPLEMENT
    fat_level    TEXT,               -- LOW | MEDIUM | HIGH
    is_toxic     INTEGER DEFAULT 0,  -- hrozny, cibule, česnek, xylitol, čokoláda…
    updated_at   TEXT NOT NULL
);
```

Toxické potraviny (§9 zadání) žijí tady jako data — `is_toxic = 1`.
Filtr je pak jedno pravidlo, ne seznam v kódu.

### 2.4 `dose_matrix` — procenta z hmotnosti

Metodika klienta jako data (R5):

```sql
CREATE TABLE dose_matrix (
    id             TEXT PRIMARY KEY,
    life_stage     TEXT,      -- PUPPY_0_6 | PUPPY_6_12 | JUNIOR | ADULT | SENIOR
    activity       TEXT,      -- LOW | MEDIUM | HIGH | WORKING | NULL = jakákoli
    body_condition TEXT,      -- UNDER | IDEAL | OVER | NULL
    physiological  TEXT,      -- NONE | PREGNANT | LACTATING | RECOVERY
    neutered       INTEGER,   -- 0 | 1 | NULL = nerozhoduje
    pct_min        REAL NOT NULL,
    pct_max        REAL NOT NULL,
    base_weight    TEXT NOT NULL DEFAULT 'ACTUAL',  -- ACTUAL | IDEAL
    specificity    INTEGER NOT NULL,   -- kolik polí je vyplněných
    source         TEXT, source_version TEXT, updated_at TEXT NOT NULL
);
```

**Kolize v klientově tabulce (musí se vyřešit, jinak systém hádá).**
Klient dodal pásma, která se překrývají. Příklady:

- *kastrovaný dospělý s vysokou aktivitou* → padne do „nízká aktivita /
  kastrovaný: 1,5–2 %" i do „vysoká aktivita: 2,5–3,5 %"
- *senior s vysokou aktivitou* → „senior: 1,5–2 %" vs. „vysoká: 2,5–3,5 %"
- *nadváha + laktace* → 1–1,5 % vs. 4–6 %

Řešení: vyhrává řádek s **nejvyšší `specificity`** (nejvíc vyplněných
polí = nejkonkrétnější popis psa). Při rovnosti rozhoduje
`physiological` > `body_condition` > `activity` > `life_stage`.
Fyziologický stav je vždy nad kondicí — laktující fena s nadváhou se
nesmí hladovět.

Tyhle kolizní kombinace **předložím klientovi k potvrzení**. Jsou to
jeho odborná rozhodnutí, ne naše.

### 2.5 `composition_profile` — poměry složek

```sql
CREATE TABLE composition_profile (
    id            TEXT PRIMARY KEY,   -- 'default'
    barf_group    TEXT NOT NULL,      -- MUSCLE | BONE | LIVER | ORGAN | PLANT
    pct_min       REAL NOT NULL,
    pct_max       REAL NOT NULL,
    pct_default   REAL NOT NULL,
    source TEXT, source_version TEXT, updated_at TEXT NOT NULL
);
```

Default podle klienta: MUSCLE 70–80 (75), BONE 10, LIVER 5, ORGAN 5,
PLANT 5–10 (7). Součet defaultů musí dát 100 % — hlídá to validace
při načtení konfigurace (stejný vzor jako `assertNoCrossFileConflicts`
v okfish enginu).

## 3. Datový model — produkty Tutani

```sql
CREATE TABLE products (
    sku            TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    url            TEXT,
    category_path  TEXT,        -- 'svalovina-2/hovezi-svalovina'
    barf_group     TEXT,        -- MUSCLE | BONE | LIVER | ORGAN | PLANT | SUPPLEMENT | OTHER
    pack_grams     INTEGER,     -- 1000, 1500, 500 — NULL = neznámé, NEHÁDAT
    price_czk      REAL,
    price_id       TEXT,        -- pro vložení do košíku
    product_id     TEXT,
    in_stock       INTEGER,
    ingredients    TEXT,        -- JSON pole id z `ingredients`
    fat_pct        REAL,        -- NULL = neznámé
    is_ground_bone INTEGER,     -- mleté kosti vs. celé
    is_cooked      INTEGER DEFAULT 0,   -- vařené kosti = NIKDY (§9)
    source_feed_at TEXT,
    updated_at     TEXT NOT NULL
);
```

**Co je z katalogu ověřeno (2026-09-08) — všechno jde z HTML**

Shoptet sype na detail produktu `dataLayer.push({shoptet: {...}})`
s kompletními strukturovanými daty. Ověřeno na ZP9, ZP10, DR46:

| údaj | zdroj v HTML | ověřená hodnota |
|---|---|---|
| SKU | `product.code` | `ZP9`, `ZP10`, `DR46` |
| cena s DPH | `product.priceWithVat` | 209 / 95 / 289 Kč |
| hmotnost balení | `product.weight` (kg) | 1 / 1,5 / **0** |
| skladem | `product.codes[].quantity` + `stocks[]` | 19 ks, Sklad Jeneč |
| kategorie | `product.currentCategory` | plná cesta s `|` |
| výrobce | `product.manufacturer` | ZOO krmiva Pošvář |
| id / guid | `product.id`, `product.guid` | 868 / `9b0dadca…` |
| varianty | `product.hasVariants` | false |
| parametry | tabulka v HTML | `Hmotnost = 1 kg` |
| **složení** | popis produktu, `Složení: …` | `100% kuřecí srdíčka`; `pohankové vločky, mrkev, pastinák, celer, pór, petržel, špenát` |

Složení je v popisu ve tvaru, který rule engine přímo potřebuje —
z `100% kuřecí srdíčka` vznikne ingredience `kure` + skupina `ORGAN`.

**Proto NENÍ potřeba feed s hashem od klienta.** Katalog se naplní
vlastním scraperem přes 281 URL ze `sitemap.xml` (Lucky 2026-09-08:
„můžeme to vytáhnout z DOMu").

**Dvě věci k ošetření, obojí naměřené:**

1. `weight: 0` u části produktů (Dromy) — hmotnost je pak v názvu
   (`1000 g`). Kaskáda: `product.weight` → parametr „Hmotnost" →
   parsing názvu → `NULL`. Poslední krok se **nehádá** (R6).
2. Kategoriové URL (`/vnitrnosti/`) nesou náhledy karet, ne produkt.
   Scraper musí jít výhradně po produktových URL a poznat je podle
   `pageType == "productDetail"` v `dataLayer`.

`pack_grams = NULL` je legitimní stav. Produkt s neznámou gramáží se
do doporučení nedostane a systém to řekne — nehádá (R6, §5 zadání).

### 3.1 Mapování kategorie → `barf_group`

Konfigurační tabulka, ne kód:

```sql
CREATE TABLE category_map (
    category_prefix TEXT PRIMARY KEY,   -- 'svalovina', 'kosti', 'vnitrnosti'
    barf_group      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
);
```

Pozor: `vnitrnosti` se musí rozpadnout na `LIVER` a `ORGAN` — játra
mají vlastních 5 %. Podle názvu produktu to jde odhadnout, ale
**odhad nestačí** (R6): u vnitřností potřebujeme od klienta potvrzení,
co jsou játra a co ostatní orgány.

## 4. Výpočetní jádro

Čistá funkce, žádné I/O, žádný produkt:

```ts
function vypocitejDavku(
    pes: DogProfile,
    omezeni: ResolvedConstraints,   // výstup rule enginu
    matrix: DoseMatrix,
    profil: CompositionProfile
): DoseResult
```

Kroky:

1. **Základní hmotnost** — `ACTUAL`, nebo `IDEAL` když pravidlo řekne
   (nadváha). Chybí-li ideální hmotnost u nadváhy → chyba vstupu, ne odhad.
2. **Procento** — řádek `dose_matrix` s nejvyšší `specificity`;
   `DOSE_PCT_OVERRIDE` z pravidel má přednost.
3. **Denní dávka** = `hmotnost × pct`. Vrací se rozmezí i střední hodnota.
4. **Rozpad na složky** — `composition_profile`, upravený o
   `COMPOSITION_LIMIT`. Po úpravě se **renormalizuje na 100 %**
   (sníží-li CKD kosti z 10 na 8 %, ty 2 % se musí někam přerozdělit).
5. **Porce** — `PORTIONS_OVERRIDE`, jinak podle věku (štěně 3–4×,
   dospělý 2×).
6. **Audit** — každý krok si zapíše, které pravidlo ho ovlivnilo.
   Z toho se skládá odpověď na „proč mi vyšlo 560 g" bez LLM.

Aritmetika v **decimal**, ne float (gramy a koruny — stejný důvod jako
v pricing enginu).

## 5. Product matching

Až po výpočtu (§6 zadání). Vstup: potřeba v gramech po složkách +
`ResolvedConstraints`. Postup:

1. **Filtr** — vyhoď produkty, které: nejsou skladem; `is_cooked = 1`
   u kostí; obsahují zakázanou ingredienci (alergie, toxické);
   nesplní `PRODUCT_ATTR_EXCLUDE`; mají `pack_grams IS NULL`.
2. **Seskup** podle `barf_group`.
3. **Pokrytí** — kolik balení pokryje potřebu na zvolené období
   (default 30 dní). Celá balení, zaokrouhlení nahoru, protože maso
   se nekrájí na gramy.
4. **Výběr** — preferuj `INGREDIENT_PREFER`, pak dostupné, pak nižší
   cenu za kg. Deterministické řazení (při shodě podle SKU), aby dvě
   volání dala stejný výsledek.
5. **Výstup** — seznam `{sku, název, balení, počet, cena}` + celková
   cena + na kolik dní.

Nepokryje-li se složka (třeba nejsou skladem játra), výsledek to
**přizná** — nesubstituuje se jinou složkou.

## 6. API kontrakt

### `POST /v1/davka`

```jsonc
{
  "pes": {
    "jmeno": "Rex",
    "hmotnostKg": 24.0,
    "idealniHmotnostKg": null,      // povinné při nadváze
    "vekMesicu": 36,
    "pohlavi": "MALE",              // MALE | FEMALE (kanonický enum z DogProfile.ts)
    "kastrovany": false,
    "aktivita": "MEDIUM",           // LOW | MEDIUM | HIGH | WORKING
    "kondice": "IDEAL",             // UNDER | IDEAL | OVER
    "fyziologickyStav": "NONE",     // NONE | PREGNANT | LACTATING | RECOVERY
    "diagnozy": ["ckd"],
    "alergie": ["kure"]
  },
  "obdobiDni": 30
}
```

Odpověď:

```jsonc
{
  "v": 1,
  "status": "OK",                   // OK | BLOCKED | INCOMPLETE
  "pes": { "jmeno": "Rex", "hmotnostKg": 24.0 },
  "davka": {
    "pctMin": 2.0, "pctMax": 2.5, "pctPouzito": 2.25,
    "zHmotnosti": "ACTUAL",
    "celkemGDen": 540,
    "porce": { "pocet": 2, "gramyNaPorci": 270 }
  },
  "slozeni": [
    { "group": "MUSCLE", "nazev": "Svalové maso",    "gramy": 405, "pct": 75 },
    { "group": "BONE",   "nazev": "Mleté kosti",     "gramy": 43,  "pct": 8,
      "upraveno": true, "duvod": "ckd:COMPOSITION_LIMIT" },
    { "group": "LIVER",  "nazev": "Játra",           "gramy": 27,  "pct": 5 },
    { "group": "ORGAN",  "nazev": "Ostatní orgány",  "gramy": 27,  "pct": 5 },
    { "group": "PLANT",  "nazev": "Zelenina a ovoce","gramy": 38,  "pct": 7 }
  ],
  "produkty": [
    { "sku": "…", "nazev": "Hovězí svalovina 1kg", "group": "MUSCLE",
      "packGrams": 1000, "pocet": 13, "cenaCelkem": 754.0, "priceId": "…" }
  ],
  "nepokryto": [
    { "group": "LIVER", "gramy": 27, "duvod": "NO_MATCHING_PRODUCT" }
  ],
  "cena": { "celkemCzk": 2340.0, "naDni": 30 },
  "upozorneni": [
    { "severity": "SERIOUS", "kod": "ckd",
      "text": "Rex má onemocnění ledvin. Snížili jsme podíl kostí…",
      "requiresVet": true }
  ],
  "audit": [
    { "krok": "DOSE_PCT", "pravidlo": "dose_matrix:adult-medium", "vysledek": "2.0-2.5 %" },
    { "krok": "COMPOSITION", "pravidlo": "ckd:bone-limit-8", "vysledek": "BONE 10 % → 8 %" }
  ],
  "disclaimer": "Orientační doporučení. Doporučujeme konzultaci s veterinářem."
}
```

`audit` je náhrada LLM vysvětlení (R1) — UI z něj postaví „proč
vyšlo 540 g" jako čitelný seznam kroků.

Ostatní endpointy: `GET /v1/knowledge` (seznam diagnóz a alergií pro
UI, aby je frontend neměl natvrdo), `GET /v1/health`.

## 7. Bezpečnostní vrstva

Vynucená v enginu, ne v UI:

- **vařené kosti nikdy** — `is_cooked = 1` je tvrdý filtr u `BONE`
- **toxické potraviny** — `ingredients.is_toxic = 1` vyloučí produkt
  a vypíše varování
- `blocks_result = 1` u závažné diagnózy → `status: BLOCKED`, dávka
  se nevydá, jen odkaz na veterinárního nutričního specialistu
- `requires_vet` se propíše do `upozorneni`
- disclaimer je **v odpovědi Workeru**, ne v šabloně — nedá se
  odstranit úpravou frontendu

## 8. Nasazení

Shoptet, tedy stejný vzor jako hecmania:

- **Worker** (Cloudflare) — engine, D1 se znalostní i produktovou vrstvou
- **Frontend** — jeden JS + CSS do šablony, jen vstup a zobrazení
- **Košík** — Shoptet `/action/Cart/addCartItem/`, `priceId` z feedu
- **Sync katalogu** — plánovaný běh z feedu s hashem do D1

## 9. Co potřebujeme od klienta (blokátory)

| # | co | proč blokuje |
|---|---|---|
| ~~B1~~ | ~~feed katalogu s hashem~~ | **PADÁ** — cena, SKU, sklad i kategorie jsou v `dataLayer`, scrapujeme z HTML |
| ~~B2~~ | ~~složení produktů~~ | **PADÁ** — složení je v popisu (`Složení: 100% kuřecí srdíčka`) |
| B3 | **Rozdělení vnitřností** na játra vs. ostatní orgány | mají oddělených 5 % + 5 %. Ze složení to často půjde (`srdíčka` → ORGAN, `játra` → LIVER), ale u nejednoznačných případů potřebujeme potvrzení |
| B4 | **Potvrzení kolizí v tabulce procent** (§2.4) | kastrovaný + vysoká aktivita, senior + vysoká aktivita, nadváha + laktace — odborné rozhodnutí klienta |
| B5 | **Rozsah diagnóz do v1** | „nemoci" je otevřený seznam; potřebujeme konkrétní záběr pro nacenění |
| B6 | Obsah tuku u produktů (volitelné) | bez něj nelze dělat nízkotučná doporučení (pankreatitida) |

B1 a B2 padly — katalog si vytáhneme sami. Zbývá B3 (částečně
automatizovatelné) a B4–B5, které blokují jen nacenění, ne vývoj.

## 10. Fáze

| fáze | obsah | závislost |
|---|---|---|
| **A** | znalostní model + výpočetní jádro + testy (bez katalogu) | žádná — jde začít hned |
| **B** | scraper katalogu z HTML → D1, product matching | žádná — odblokováno |
| **C** | zdravotní pravidla a filtr alergií | B3 (částečně), B5 |
| **D** | UI konfigurátoru, vložení do košíku | A–C |

Fáze A i B jsou odblokované a nezávisí na klientovi — metodika i kolize
procent se dají implementovat a otestovat proti dodané tabulce.
