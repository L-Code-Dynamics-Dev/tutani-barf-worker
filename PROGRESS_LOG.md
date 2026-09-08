# Tutani BARF Worker — progress log

Nejnovější záznam nahoře.

## 2026-09-09 (00:10) — rozpor v gramáži se ŘEŠÍ, nevyřazuje (31/31 testů)

**Lucky zpochybnil moje řešení („proč vyřazením?") a měl pravdu.**
Vyřadit 26 produktů s rozporem by znamenalo vyhodit z konfigurátoru
**16 produktů, které do dávky patří** — vemínko, dršťky, bachory,
droby, chrupavka, mrkev, červená řepa, zeleninová směs. To je zboží,
které klient prodává.

**Nové řešení: rozhodnout CENOU ZA KG**
(`src/adapters/tutani-catalog/resolveWeightConflict.ts`).

Cena je nezávislý třetí zdroj, který jednu variantu obvykle vylučuje:

```
ZP12 „Krájené vemínko 1kg", 50 Kč
  1 kg →  50 Kč/kg  ✅ v pásmu MUSCLE (medián 147)
  5 kg →  10 Kč/kg  ❌ nereálné
→ 1 kg z názvu, produkt ZŮSTÁVÁ
```

Hranice se počítají z **mediánu skupiny** (0,25× až 4×), ne
z natvrdo zapsaných čísel — ceny se mění a pevné hranice by za rok
lhaly. Medián se počítá jen z produktů BEZ konfliktu, aby si
nezkreslil vstup.

### Výsledek na reálných datech: 26/26 vyřešeno, 0 vyřazeno

Naměřené mediány Kč/kg: MUSCLE 147, BONE 76, LIVER 537, ORGAN 122,
PLANT 204, SUPPLEMENT 931.

| SKU | rozhodnuto | Kč/kg | admin by dal |
|---|---|---|---|
| `ZP12` vemínko | **1 kg** | 50 | 10 Kč/kg |
| `TUT117` směs 3kg | **3 kg** | 48 | 144 Kč/kg |
| `TUT196` mrkev | **500 g** | 78 | 390 Kč/kg |
| `ZP28` dršťky 2 kg | **2 kg** | 52 | 104 Kč/kg |
| `TUT9/15` kuřecí vemínko 3kg | **3 kg** | 38 | 115 Kč/kg |

**Ve všech 26 případech vyhrál NÁZEV.** To potvrzuje hypotézu: v
adminu zůstala nepřepsaná výchozí hodnota (1 kg nebo 0,1 kg),
zatímco název píše obchodník ručně. Přesto se rozhoduje cenou, ne
domněnkou — kdyby se někdy spletl název, cena to odchytí.

### Kdy se produkt přesto nedoporučí

- ani jedna varianta cenově neobstojí
- chybí cena nebo medián skupiny
- gramáž není nikde uvedená (52 produktů — poukázky, hračky, kapky
  v ml; do dávky nepatří, správně)

Ve všech případech `UNRESOLVED` → produkt jde do reportu pro klienta,
nedopočítává se (R7).

### Testy: 31/31

`resolveWeightConflict.test.ts` (11) staví na REÁLNÝCH případech
z katalogu, ne na vymyšlených datech.

### Pro klienta zůstává

Rozpor se pořád **reportuje** — je to hodnota pro klienta (26 chyb
v datech, které vidí jeho zákazníci), jen už nám neblokuje
doporučení.

### Další krok

Product matching — z gramů na balení, filtr alergií, sestavení
košíku na období.

## 2026-09-09 (00:00) — výpočetní jádro hotové, 20/20 testů

**Napsáno:**
```
tenants/tutani/rules/barf-core.json           metodika jako DATA (R5)
src/engine/feeding-calculator/resolveDoseRule.ts   řešení překryvů pásem
src/engine/feeding-calculator/calculateDose.ts     výpočet + audit
tests/unit/calculateDose.test.ts              20 testů
```

Ověřeno: dospělý pes 24 kg, střední aktivita → **540 g/den**
(2,25 % z 24 kg), rozpad 405/54/27/27/27 g. Součet složek vždy
přesně odpovídá celkové dávce (zaokrouhlení se dorovná na největší
složce, jinak by drobné rozdíly ovlivnily nákup).

### CHYBA, KTEROU NAŠLY TESTY: kondice vs. aktivita

První verze řešení překryvů řadila podle `specificity` (počtu
omezených dimenzí) a teprve pak podle priority dimenzí. Důsledek:

- `adult-medium` omezuje 2 dimenze (lifeStage + activity)
- `over-weight` omezovalo 1 (bodyCondition)

→ pes s nadváhou dostal **2,25 % místo 1,25 %** a nikdy by nezhubl.

**Oprava:** rozhoduje NEJSILNĚJŠÍ dimenze podle `dimensionPriority`,
specificity až při rovnosti. Priorita dimenzí je zdravotní rozhodnutí,
počet podmínek jen technický detail. Strategie přejmenována na
`DIMENSION_THEN_SPECIFICITY`.

### DRUHÝ NÁLEZ (matice 480 kombinací): štěně s nadváhou

Po opravě začalo `over-weight` vyhrávat i u štěňat → rostoucí štěně
by šlo na redukční dietu 1–1,5 %. To může poškodit vývoj kostí
a kloubů.

**Oprava:** `over-weight` rozděleno na `over-weight-adult`,
`over-weight-senior` a nové `puppy-over-weight` (6–7 %, ze
skutečné hmotnosti, s výslovným varováním „v růstu se nehladoví").
Obojí je v datech, ne v kódu.

### Pokrytí metodiky po opravách (480 kombinací)

| případ | pásmo | % |
|---|---|---|
| nadváha, střední aktivita | `over-weight-adult` | 1–1,5 IDEAL |
| nadváha + laktace | `lactating` | 4–6 ACTUAL |
| kastrovaný + vysoká aktivita | `adult-high` | 2,5–3,5 |
| podváha + vysoká aktivita | `under-weight` | 3–4 |
| **štěně + nadváha** | `puppy-over-weight` | **6–7 ACTUAL** |
| březí + nadváha | `pregnant` | 3–4 |

**Bez pásma zůstává 6 kombinací z 480 (1 %)** — senior se střední,
vysokou nebo pracovní aktivitou. V dodané tabulce má senior jen
„nízká aktivita". Systém vrátí `INCOMPLETE` s odkazem na veterináře,
NEDOPOČÍTÁVÁ (R7). **Otázka na klienta.**

### Co jádro dělá a nedělá

- ✅ audit každého kroku → vysvětlení „proč 540 g" bez LLM (R1)
- ✅ `Decimal`, ne float
- ✅ renormalizace po zdravotním limitu (sníží-li CKD kosti z 10 na
  8 %, ta 2 % se přerozdělí mezi složky, které mají v metodice
  prostor — a nikdy nad jejich `pctMax`)
- ✅ `BLOCKED` u závažné diagnózy — dávka se nevydá
- ✅ `INCOMPLETE` při chybějící ideální hmotnosti u nadváhy
- ❌ nezná ani jeden produktový kód (R6)

### Další krok

Product matching (`engine/product-matching/`) — z gramů na balení
z katalogu Tutani, s filtrem alergií a vyřazením 26 produktů
s rozpornou gramáží.

## 2026-09-08 (23:40) — scraper hotový, dry-run na celém katalogu

**Napsáno:** `src/adapters/tutani-catalog/parseProductPage.ts`,
`tenants/tutani/config/tenant.ts`, `scripts/scrape-dry-run.ts`.

### Výsledek dry-runu (264 produktů, 0 chyb načtení)

| údaj | pokrytí |
|---|---|
| cena | **264/264 (100 %)** |
| gramáž balení | 212/264 (80 %) |
| složení | 45/264 (17 %) |

Zdroj gramáže: `dataLayer` 134, název 78, chybí 52 (poukázky, hračky,
kapky v ml — do dávky nepatří, správně vyřazeny).

### Mapování na BARF skupiny — opraveno po nálezu z dry-runu

**Nález:** 27 produktů z „Barf mražené maso" nemá podkategorii, takže
z cesty kategorie složku poznat nelze. Unikaly věci, které do dávky
jednoznačně patří (`TUT108` Pašíkova játra, `TUT147` Srdce jako kráva,
`TUT218` Mleté kachní maso, `ZP11` Jazyk krmný).

**Řešení:** dvouúrovňové mapování — kategorie (autoritativní), pak
fallback na NÁZEV produktu. Obojí data v `tenant.ts`, ne kód.

| skupina | před | po |
|---|---|---|
| OTHER | 121 | **47** |
| MUSCLE | 45 | **100** |
| BONE | 15 | 23 |
| ORGAN | 13 | 20 |
| LIVER | **0** | **4** |
| PLANT | 24 | 24 |
| SUPPLEMENT | 46 | 46 |

Fantazijní názvy („Gurgle", „Pani Držkatá", „Šemíkova mňamka",
„Kopyto jako kráva", „Krůtí vznášedla") záměrně NEJSOU v mapování —
z nich se složka odvodit nedá. Zůstávají `OTHER`, zařazení musí
potvrdit klient. Nehádá se (R7).

### ⚠ NÁLEZ PRO KLIENTA: 26 produktů má rozpornou hmotnost

Autoritativní zdroj (`dataLayer.weight` + parametr „Hmotnost") si
odporuje s názvem produktu. Ověřeno naostro, **nelze věřit paušálně
ani jednomu zdroji**:

| SKU | admin | název | cena | kdo lže |
|---|---|---|---|---|
| `ZP12` Krájené vemínko 1kg | 5 kg | 1 kg | 50 Kč | **admin** (5 kg za 50 Kč nereálné) |
| `TUT117` Směs paní Krocanové 3kg | 1 kg | 3 kg | — | admin (`TUT216` 3kg má správně 3) |
| `TUT196` Barf Mrkev 500g | 0,1 kg | 500 g | 39 Kč | nejasné |
| `ZP28` Dršťky zelené 2 kg | 1 kg | 2 kg | — | nejasné |

Dalších 22 v reportu dry-runu. Vzor: mořské řasy a doplňky mají
v adminu 100 g, v názvu 200 g; mražené masné směsi mívají 1 kg
v adminu a 2–3 kg v názvu.

**Chování systému:** rozpor se zaznamená do `packGramsConflict`,
produkt se **nedostane do doporučení**. Špatná gramáž = špatný nákup
i špatná cena. Systém to NEOPRAVUJE odhadem — opravit musí klient
v adminu. Je to zároveň hodnota pro klienta: našli jsme mu 26 chyb
v datech e-shopu, které vidí jeho zákazníci.

### Složení jen u 17 % — a je to v pořádku

45 produktů z 264 má v popisu `Složení: …`. Chybí u mražených mas,
kde je surovina zjevná z názvu (`Hovězí svalovina`, `Srdce krmné
vepřové`). Pro filtr alergií to znamená: druhotný zdroj bude
**název + kategorie**, ne jen text složení. Doplnit do znalostní
vrstvy jako mapování surovin, ne hádáním.

### Další krok

Výpočetní jádro (`engine/feeding-calculator/`) — metodika jako data,
včetně ošetření překryvů v procentech.

## 2026-09-08 — založení projektu, architektonická rozhodnutí

**Klient:** Ladislav Švihel, tutani.cz (přes Josefa Dlouhého).
**E-shop:** `obchod.tutani.cz` — **Shoptet**, projectId 92086.
**Kontext:** hledají dlouhodobého partnera, tohle je první zakázka.

### Rozhodnutí Lucky (závazná)

| # | rozhodnutí |
|---|---|
| R1 | **Žádné LLM nikde** — ani jako vysvětlovací nadstavba. Dávka je zdravotní doporučení, musí být deterministická. Vysvětlení „proč 540 g" se skládá z auditní stopy pravidel. |
| R2 | **Konfigurátor, ne chatbot** — klient v e-mailu popsal dialogového asistenta s 10 otázkami za sebou; sbíráme strukturovaně v UI. |
| R3 | **Samostatný Worker**, ne doména v Nexu. Ale **Nexus-compatible canonical model**, aby se dal později přenést bez přepisu. |
| R4 | **Tenant model hned** — Worker nikdy nesmí mít `if (client === 'tutani')`. Cesta je `tenantId → TenantConfiguration → RuleSet → ProductCatalog`. Tutani je první tenant, ne zabudovaný předpoklad. |
| R5 | **Knowledge base nesmí být v TypeScriptu** — nemoci, stavy, alergie, pravidla jsou data (JSON/D1), verzovaná a auditovatelná. Engine je jen interpret. |
| R6 | **Výpočet oddělen od výběru produktů** — jádro nezná ani jeden produktový kód. |
| R7 | **Jen produkty Tutani**, chybí-li údaj, systém ho NEHÁDÁ. |

### Ověřeno naostro proti e-shopu (2026-09-08)

Nejdřív jsem měřil `tutani.cz` a zjistil WordPress/WooCommerce bez
produktů — **mylný závěr, e-shop je na subdoméně** `obchod.tutani.cz`
a je to Shoptet (295 výskytů).

**Shoptet sype na detail produktu `dataLayer.push({shoptet: {...}})`
s kompletními daty.** Ověřeno na ZP9, ZP10, DR46:

| údaj | zdroj | hodnota |
|---|---|---|
| SKU | `product.code` | ZP9 / ZP10 / DR46 |
| cena s DPH | `product.priceWithVat` | 209 / 95 / 289 Kč |
| hmotnost | `product.weight` (kg) | 1 / 1,5 / **0** |
| skladem | `codes[].quantity` + `stocks[]` | 19 ks, Sklad Jeneč |
| kategorie | `product.currentCategory` | plná cesta s `\|` |
| výrobce | `product.manufacturer` | ZOO krmiva Pošvář |
| složení | popis, `Složení: …` | `100% kuřecí srdíčka` |

**Důsledek: feed s hashem od klienta NENÍ potřeba** (Lucky: „můžeme
to vytáhnout z DOMu"). Katalog naplní vlastní scraper přes 281
produktových URL ze `sitemap.xml`, poběží jako Cron ve Workeru.

**Katalog:** 346 URL v sitemap, ~90 produktů v BARF kategoriích.
Kategorie sedí 1:1 na složky dávky: `svalovina*`, `kosti*`,
`vnitrnosti*`, `prilohy`, `ryby`, `mrazene-maso`.

**Dvě věci k ošetření:**
1. `weight: 0` u části produktů (Dromy) — hmotnost je pak v názvu
   (`1000 g`). Kaskáda: `weight` → parametr „Hmotnost" → název →
   `NULL`. Poslední krok se nehádá.
2. Kategoriové URL (`/vnitrnosti/`) nesou náhledy karet, ne produkt.
   Scraper pozná produkt podle `pageType == "productDetail"`.

### Kolize v klientově tabulce procent — ČEKÁ NA KLIENTA

Dodaná pásma se překrývají, systém by hádal:

- kastrovaný dospělý + **vysoká** aktivita → 1,5–2 % i 2,5–3,5 %
- senior + vysoká aktivita → 1,5–2 % vs. 2,5–3,5 %
- nadváha + laktace → 1–1,5 % vs. 4–6 %

**Navržené řešení:** vyhrává řádek s nejvyšší `specificity` (nejvíc
vyplněných polí). Při rovnosti `physiological` > `body_condition` >
`activity` > `life_stage` — fyziologický stav nad kondicí, laktující
fena s nadváhou se nesmí hladovět. **Potvrdit musí klient**, je to
odborné rozhodnutí.

### Infrastruktura

Máme **Workers Paid** → D1 i Cron v ceně, spotřeba tohoto projektu je
promile limitů. Infrastruktura = 0 Kč navíc. Cena je v práci, ne v
provozu; retainer se obhájí údržbou pravidel a sortimentu.

### Nacenění — návrh k odeslání Josefovi (neodesláno)

v1 celkem **65 000 Kč**, fázovatelné: A 18 / B 12 / C 20 / D 15 tis.
Retainer **6 000 Kč/měsíc** (provoz, přidávání diagnóz, ladění pravidel).
Doporučeno nabídnout A+B (30 000) jako první krok, aby klient viděl
výsledek dřív, než schválí celek.

### Hotovo v repu

```
src/domain/tenant.ts              tenant model, BarfGroup, CatalogSource
src/domain/dog/DogProfile.ts      profil psa, resolveLifeStage, base weight
src/domain/health/Condition.ts    Condition, ConditionRule, ResolvedConstraints
docs/ARCHITEKTURA.md              celý návrh 6 vrstev + API kontrakt
```

Struktura složek podle zadání Lucky: `domain/`, `rules/`, `engine/`,
`adapters/tutani-catalog/`, `api/`, `infrastructure/`, `tenants/tutani/`.

### Otevřené otázky

1. **Recept vs. zásoba** — do košíku jde zásoba (Shoptet prodává
   balení, ne 27 g jater), ale klient chce i „jídelníček na týden".
   Navrženo: recept na obrazovku, zásoba do košíku. Nerozhodnuto:
   období nákupu (fixní 30 dní vs. volba), rotace mas, jeden košík
   vs. výběr.
2. **B3** — rozdělení vnitřností na játra vs. ostatní orgány
   (oddělených 5 % + 5 %). Ze složení to většinou půjde automaticky.
3. **B5** — rozsah diagnóz do v1, potřebné pro nacenění.

### Další krok

Scraper katalogu (`adapters/tutani-catalog/`) — ukáže reálná data
dřív, než na předpokladech postavím engine: kolik produktů má složení,
jak se rozpadnou do skupin, kde chybí gramáž.
