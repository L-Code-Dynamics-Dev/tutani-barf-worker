# Tutani BARF Worker — progress log

Nejnovější záznam nahoře.

## 2026-09-09 (02:00) — NUTRIČNÍ VRSTVA: FEDIAF 2025 + dataset surovin

Lucky dodal kompletní znalostní rámec (body 1–96 + FEDIAF tabulky
+ BARF Ingredient Dataset v0.1). Implementováno to, co jde bez
chybějících dat.

### Napsáno

```
docs/ZNALOSTNI-BAZE.md                    rámec Lucky jako reference
src/domain/nutrition/energy.ts            RER/MER, ověřeno proti tabulce
src/domain/nutrition/assessment.ts        dvě osy + 17 kontrolních bodů
src/domain/nutrition/Ingredient.ts        model surovin, jednotky, evidence
tenants/tutani/rules/fediaf-2025.json     39 živin na 1000 kcal
tenants/tutani/rules/ingredients-nutrition.json  10 surovin z USDA
tenants/tutani/rules/barf-safety.json     rizika + 8 mýtů s citacemi
```

### Ověřeno naostro

**RER** proti referenční tabulce: 5/10/20/30/40 kg → 234/394/662/897/1113 kcal.

**FEDIAF přepočet** na 10kg psa / 500 kcal — **12/12 hodnot sedí**:
protein 26,05 g, tuk 6,875 g, Ca 0,725 g, P 0,58 g, Cu 1,04 mg,
jód 0,15 mg, Fe 5,2 mg, Zn 10,4 mg, vit. A 877 IU, D 79,5 IU,
E 5,2 IU, cholin 237 mg. Ca:P při minimech 1,25:1 (FEDIAF max 2:1).

**Bod 73** (dva psi po 20 kg): senior kastrovaný s nadváhou 560–616
kcal vs. mladý pracovní 1324–1986 kcal → **2,8× rozdíl** při stejné
hmotnosti. Procento z hmotnosti to nerozliší.

**Bod 12** (deficit Ca) spočítán: 400 g kuřecích prsou = 480 kcal,
Ca 20 mg, P 852 mg → **Ca:P 1:43** proti FEDIAF minimu 1,25:1.
Dieta z libového masa má prokazatelný deficit vápníku.

### Čtyři zásadní rozhodnutí v modelu

**1. JEDNOTKY.** FEDIAF udává na **1000 kcal ME**, ne na gramy. Engine
nesmí říct „pes potřebuje 5 mg zinku", ale „X mg na 1000 kcal při jeho
energetické potřebě". Proto se u každé suroviny ukládá `kcal` i voda —
bez nich převod nejde.

**2. `value = 0` ≠ `NOT_ANALYZED`.** Kdyby se neměřená hodnota
počítala jako nula, engine by hlásil nedostatek vitaminu D a doporučil
suplementaci naslepo. `ValueStatus` má `MEASURED | NOT_ANALYZED |
TRACE | NOT_PRESENT` a `contribution()` vrací u `NOT_ANALYZED` `null`,
takže součet přizná neúplnost.

**3. `NOT_SPECIFIED` u FEDIAF.** Kde má tabulka pomlčku, nesmí se
doplnit vymyšlené minimum. Reálný případ: **EPA+DHA u dospělého psa
FEDIAF neuvádí** — 0,13 g/1000 kcal platí pro růst a reprodukci.

**4. VARIANTY podle datasetu.** Táž surovina má v různých datasetech
různé hodnoty — kuřecí prsa: Foundation **1,9 g** tuku vs. SR Legacy
**2,6 g**. Proto se ukládá `dataset` u každé varianty a hodnoty
z různých zdrojů se nikdy nemíchají do jednoho čísla.

### Dvě osy hodnocení (bod 29)

> Nutričně perfektní dieta může být mikrobiologicky riziková.

Bezpečnost byla filtrem UVNITŘ nutričního výpočtu. Teď jsou to dvě
samostatné osy s vlastní úrovní, protože kombinace mají různé závěry:
„nutričně OK / vysoké riziko" se řeší manipulací, „deficit Ca / nízké
riziko" recepturou.

Tři úrovně (bod 95): 🟢 KONTROLOVANÁ, 🟡 ORIENTAČNÍ, 🔴 NEVHODNÁ.

### STAV DAT — proč je dnes každá dávka 🟡 ORIENTAČNÍ

Dataset má **10 surovin, 80 změřených a 10 neměřených hodnot**.

Chybí:
- **suroviny**: krůtí, králičí, jehněčí, koňské, zvěřina, vepřové
  maso, slezina, kuřecí srdce, sardinky, makrela, oleje, veškerá
  zelenina a ovoce, vaječná skořápka, kostní moučka, premix
- **živiny**: vitamin D a E u žádné suroviny, jód u žádné, mangan,
  Mg, Na, K, B-vitaminy, folát, cholin, **EPA/DHA jen jako
  NOT_ANALYZED u lososa**, aminokyseliny

Dokud chybí vitamin D, E, jód a EPA/DHA, **nelze vydat 🟢
KONTROLOVANOU dávku**. To není nedostatek implementace, ale pravdivý
stav dat.

### DALŠÍ KROK (trigger „BARF")

Naplnit nutrient vektor u ~20 surovin — ne jen protein/tuk/Ca/P, ale
celý profil podle FEDIAF 2025: aminokyseliny, linolová kyselina,
EPA/DHA, Mg/Na/K/Cl, mangan, vitaminy D, E, B-komplex, folát, cholin.

Zdroj: **USDA FoodData Central** (má veřejné API, vrací FDC ID,
dataset a analytickou metodu). Kritické je zachovat `dataset`,
`sourceRef`, `sourceDate` a `confidence` u každé hodnoty — a nikdy
nezaměnit neměřenou hodnotu za nulu.

Seznam surovin k doplnění: hovězí/kuřecí/krůtí/králičí/vepřové/
jehněčí/koňské maso, zvěřina, játra (hovězí, kuřecí, vepřová),
ledviny (hovězí, vepřová), slezina, srdce (hovězí, kuřecí), vejce,
sardinky, losos, makrela, rybí/lososový/lněný olej, mrkev, brokolice,
cuketa, dýně, špenát, jablko, borůvky + vaječná skořápka, kostní
moučka, minerální premix.

**204/204 testů, `tsc` čistý.**

## 2026-09-09 (01:30) — OPRAVY PO 5STUPŇOVÉM AUDITU (187/187)

Audit odhalil, že **zdravotní vrstva v produkci vůbec neběžela**.
Opraveno včetně tří chyb, které audit nenašel a vylezly až při
opravování.

### Audit — co proběhlo

| stupeň | výsledek |
|---|---|
| 1 validace vstupu | ✅ 3 kritické |
| 2 výpočet | ✅ 5 kritických |
| 3 bezpečnost a zdraví | ✅ 6 kritických |
| 4 integrace | ❌ spadl (auth) |
| 5 adversariální | ❌ spadl (session limit), ale předtím našel 2 nálezy |

### KRITICKÉ — opraveno

**1. Rule engine nebyl zapojený.** `buildDeps` měl výchozí
`NOOP_RULE_ENGINE`, který vracel prázdná omezení. Nasazený Worker
tedy pro KAŽDÉHO psa ignoroval diagnózy i alergie — pes v pokročilém
renálním selhání by dostal plnou dávku. Znalostní vrstva byla hotová,
jen nikdo nespojil oba konce. Napsán `src/rules/KnowledgeRuleEngine.ts`
a zapojen v `index.ts`.

**2. Nesplnitelné limity → vymyšlená čísla.** Čtyři způsoby:
`MUSCLE maxPct 0` vyhnalo zeleninu na 80 % (metodika 10 %);
`PLANT minPct 30` dalo 9,2 %, ale audit hlásil „→ 30 %";
`max 5 + min 90` oba limity tiše zahodilo; limity na všech složkách
vrátily `grams: 450` s `pct: 0`. `splitComposition` přepsán —
nesplnitelný stav vrací `UNSATISFIABLE_LIMITS`, dávka se nevydá.

**3. Negativní dávka.** `dosePctOverride: {min:-10,max:-10}` vydalo
**-2000 g** se statusem OK. Doplněna sanity kontrola.

**4. `ingredientIds: []` natvrdo v syncu.** Filtr alergií neměl na
čem pracovat — psovi s alergií na kuře se doporučilo kuřecí, cibule
se nabízela každému, a API hlásilo `knowledgeEngineReady: true`.
Napsán `detectIngredients.ts` (surovina z názvu i složení)
+ **fail-closed**: neznámou surovinu nelze prohlásit za bezpečnou.

**5. Vařené produkty jen u BONE.** Vařené kuře zařazené jako MUSCLE
prošlo. Filtr teď platí ve všech skupinách.

**6. `priceId: null` v syncu.** Ukládá se z hidden inputu, párováno
na `productId` hlavního produktu (na homepage je 36 párů, na detailu
1 — ověřeno).

**7. 108 bound params při limitu D1 = 100.** Konstanta říkala 16
sloupců, SQL i `bind` posílaly 18. Počet se teď DERIVUJE ze seznamu
`UPSERT_COLUMNS` a nemůže se rozejít. Nyní 20 sloupců × 4 = 80.

### TŘI CHYBY, které audit nenašel

**A. Rozpojený kontrakt alergií.** `/v1/knowledge` posílá do UI id
podmínek (`alergie-kure`), backend je dostával jako id SUROVIN —
vyloučila se neexistující surovina `alergie-kure`, zatímco produkty
mají `kure`. **Filtr by nevyřadil nic.** Engine teď přijímá obojí
a `alergie-drubez` správně vyřadí kuře, krůtu i kachnu naráz.

**B. Vlastní regrese: CKD přestalo fungovat.** Moje kontrola
splnitelnosti označila `BONE ≤ 8 %` za nesplnitelné, protože metodika
má kosti pevně `10–10`. Opraveno: **zdravotní limit metodiku PŘEBÍJÍ**,
nekoliduje s ní.

**C. Fail-closed vyřadil celý katalog.** `excludedIngredientIds`
obsahuje 8 toxických surovin VŽDY, takže podmínka `size > 0` platila
i u zdravého psa a vypadlo by všech 219 produktů bez složení.
Doplněna `ownerExcludedIngredientIds` (jen zadané alergie), `alwaysActive`
se do ní nepočítá.

### FEEDY SHOPTETU — podnět Lucky, změřeno

`obchod.tutani.cz` má **6 feedů bez hashe**: `universal.xml`,
`heureka`, `seznam`, `google`, `facebook`, `glami`, `arukereso`.

| přínos | dopad |
|---|---|
| popis z `universal.xml` | **+25 produktů** pro filtr alergií (61 % → 70 %) |
| dostupnost z Google feedu | +31 produktů, kde scraper sklad nepřečetl |
| `priceId` | ❌ v žádném feedu není → scraper zůstává |

**DŮLEŽITÉ ZJIŠTĚNÍ:** Google feed u všech 26 konfliktů v gramáži
„potvrzoval admin" — tedy opak toho, co vybírá `resolveWeightConflict`.
Chvíli to vypadalo na 26 chyb. Prověření cenou ale ukázalo, že **feed
pravdu nemá**: mrkev by měla 390 Kč/kg, zeleninová směs 1 440 Kč/kg,
vemínko 10 Kč/kg. Důvod: `g:shipping_weight` se plní z TÉHOŽ pole
v adminu jako `dataLayer.weight` — není to nezávislý zdroj, jen druhý
výstup stejného nevyplněného údaje. **Cena zůstává jediným nezávislým
zdrojem.** Zapsáno do kódu, aby to nikdo „neopravil" podle feedu.

### Stav

**187/187 testů** (9 souborů), `tsc --noEmit` čistý. Nový test
`alergieKontrakt.test.ts` hlídá, aby se kontrakt UI↔filtr znovu
nerozešel.

Ověřeno naostro: zdravý pes 856 Kč/30 dní, CKD 839 Kč + 2 varování,
pokročilé CKD BLOCKED, alergie na drůbež přehodí produkty.

### ZBÝVÁ z auditu (neblokuje, ale řešit)

1. **Limity nejsou citace** — `BONE ≤ 8 %` u CKD je `L-CODE-INFERENCE`,
   převod z g/1000 kcal. **Musí potvrdit veterinář.**
2. **Disclaimer se u BLOCKED a INCOMPLETE nevykreslí** — frontend má
   `return` před tím řádkem.
3. **Štěně do 6 měsíců s nadváhou → 2700 g/den** z nadvážné hmotnosti
   (`puppy-over-weight` je jen pro PUPPY_6_12).
4. **`warningCs` z metodiky se nikde nepropisuje** do odpovědi —
   text „ROSTOUCÍ ŠTĚNĚ SE NEHLADOVÍ" zákazník neuvidí.
5. **Samec může být březí/laktující** — chybí křížová validace
   (1200 g místo 540 g).
6. **Frontend hádá ideální hmotnost** 0,85× — porušuje R7.
7. **Frontend neumí zobrazit chybové kódy** — čte `data.error`,
   backend posílá `data.code` + `issues[]`.
8. Sync může smazat katalog, když parser vrátí málo produktů
   (chybí procentní pojistka).

## 2026-09-09 (00:40) — BLOKÁTOR KOŠÍKU VYŘEŠEN (178/178)

Agent hlásil, že `priceId` je vždy NULL a blokuje tlačítko „Vložit
vše do košíku". **Vyřešeno: `priceId` v `dataLayer` skutečně není,
ale JE v hidden inputu formuláře na detailu produktu.**

```html
<input type="hidden" name="productId" value="868">
<input type="hidden" name="priceId" value="973">
```

Doplněno `parsePriceId()` do parseru. Ověřeno naostro na 4 produktech
napříč skupinami:

| SKU | productId | priceId |
|---|---|---|
| ZP9 Hovězí svalovina 1kg | 868 | **973** |
| TUT196 Barf Mrkev 500g | 5425 | **8281** |
| TUT108 Pašíkova játra 1kg | 4783 | **7207** |
| SF2 MAX deluxe kostky 800g | 1987 | **2497** |

Parser bere **PRVNÍ výskyt** — stránka má i formuláře upsellu
a „podobných produktů", které nesou cizí `priceId`; kdyby se vzal
poslední, zákazník by si vložil jiný produkt. Na to je test.

`scripts/overit-priceid.ts` to kdykoli přeověří naostro.

**Testy 178/178** (8 souborů), `tsc --noEmit` čistý.

### Co zbývá k nasazení

1. **`wrangler d1 create tutani-barf`** → vyplnit `database_id`
   ve `wrangler.jsonc`.
2. Zapojit frontend na reálnou adresu Workeru.
3. Naplnit D1 (`syncCatalog` bez `dryRun`) a ověřit ostrý běh.

Nic z toho není programátorská práce — jsou to nasazovací kroky, které
potřebují Cloudflare účet.

## 2026-09-09 (00:35) — API + D1 hotové, celý systém funguje (172/172)

API vrstva a D1 dodány (paralelní agent). **Všechny vrstvy hotové**,
celý tok od validace po košík ověřen proti reálnému katalogu.

```
migrations/0001_init.sql                 products, category_map, sync_runs
src/infrastructure/D1ProductStore.ts     upsert po 6 (limit 100 bound params)
src/adapters/tutani-catalog/syncCatalog.ts  sitemap → D1, dryRun + diff
src/api/handlers.ts                      /v1/davka, /v1/knowledge, /v1/health
src/api/validateInput.ts                 rozsahy, enumy, chybové KÓDY
src/index.ts                             routing, CORS, cron
wrangler.jsonc                           cron 3:15, D1 binding, observability
scripts/ukazka-api.ts                    celý API tok bez HTTP
```

**Testy 172/172** (7 souborů), `tsc --noEmit` čistý,
`wrangler deploy --dry-run` prošel (138 KiB / gzip 39 KiB).

### Dry-run synchronizace naostro

```
stav OK | 281 URL | načteno 281 | selhalo 0 | 22 s
diff: přidat 264, změnit 0, odebrat 0, nepoužitelné 52
```

### Ověřený API tok (`scripts/ukazka-api.ts`)

| případ | výsledek |
|---|---|
| zdravý pes | 540 g/den, 856 Kč/30 dní |
| CKD počáteční | 540 g/den, 839 Kč, 2 varování SERIOUS |
| CKD pokročilé | **BLOCKED** |
| alergie na drůbež | 540 g/den, 864 Kč, produkty přehozené |
| nadváha bez ideální hmotnosti | validace odmítla `MISSING_IDEAL_WEIGHT` |
| nadváha s ideální | 250 g/den (redukční dieta) |
| `pohlavi: "PES"` | odmítnuto `UNKNOWN_ENUM_VALUE` |
| hmotnost 500 kg | odmítnuto `OUT_OF_RANGE` |

### Rozhodnuto podle nálezů agenta

**1. `SF*` „MAX deluxe" jde do dávky.** 18 použitelných produktů
sedělo v OTHER, protože kategorie „BARF na cesty - barf granule"
v mapování chyběla. Ověřil jsem detail SF2: jsou to **mražené kostky
svaloviny** (800 g/205 Kč), celé i dělené kuře, srnec/daněk/jelen —
slovo „granule" znamená kostky, ne suché granule. MUSCLE 55 → **62**.

**2. `MYS` vyřazena.** „Myš mražená 16-22g 25ks" — parser vzal 22 g
za JEDEN kus, ale balení je 25 ks za 405 Kč. To by dalo 18 400 Kč/kg.
Navíc je to „Barf pro dravce" (sokolnictví), ne krmivo pro psy. Celá
kategorie „pro dravce" i „pro kočky" → OTHER.

**3. `pohlavi` v dokumentaci opraveno** na `MALE|FEMALE`. Kód i
frontend enum používaly správně, chyba byla jen v ARCHITEKTURA.md §6.

### OPRAVA MÉHO DŘÍVĚJŠÍHO TVRZENÍ

Napsal jsem, že rozpor v gramáži „vyřešila cena 26/26". **Změřeno:
cena rozhodla jen 6 z 26**, u zbývajících 20 obě varianty prošly
a rozhodl tie-break „vyhrává název". Výsledek je správný, ale moje
odůvodnění bylo silnější než realita.

**Zkoušel jsem hranice zpřísnit z 0,25×–4× na 0,4×–2,5×. Bylo to
HORŠÍ:** u `TUT196` „Barf Mrkev 500g" vypadla správná varianta
78 Kč/kg pod dolní hranici (0,4 × medián PLANT 204 = 82) a vyhrálo
nesprávných 100 g = **390 Kč/kg**. Zpřísnění tedy vybralo špatně tam,
kde široké pásmo vybralo dobře — mediány skupin jsou zkreslené drahým
sortimentem (SUPPLEMENT 931 Kč/kg kvůli řasám a olejům).

Vráceno na 0,25×–4× a **v kódu je poznámka, proč se to nesmí
opakovat**. Role ceny je úzká a záměrná: vyloučit variantu mimo
o násobek. Kde nerozhodne, `reasonCs` výslovně uvede, že rozhodl
tie-break.

### Dvě rozhodnutí agenta, která schvaluju

- **selhání rule enginu vrací `BLOCKED`/503**, ne dávku bez
  zdravotních omezení. Tichý fallback na prázdná omezení by u psa
  s CKD byl horší než nevydat nic.
- **`knowledgeEngineReady: false`** se přidá jen když majitel zadal
  diagnózu nebo alergii — aby konfigurátor netvrdil, že s nimi
  počítal.

### ZBÝVÁ K NASAZENÍ

1. **`wrangler d1 create tutani-barf`** → vyplnit `database_id`
   ve `wrangler.jsonc` (agent ho záměrně nevymyslel).
2. **`priceId` je vždy NULL** — v `dataLayer` na detailu není.
   `matchProducts` ho ve výstupu očekává a frontend ho potřebuje pro
   vložení do košíku. Řešení: buď `productId` + formulář Shoptetu,
   nebo scrapovat `priceId` z HTML formuláře na detailu. **Blokuje
   tlačítko „Vložit vše do košíku".**
3. Zapojit frontend na reálný Worker (dnes míří na
   `tutani-barf.hlancaric.workers.dev`, který neexistuje).

## 2026-09-09 (00:40) — API vrstva Workeru, D1 schéma a Cron sync (172/172)

**Napsáno:** `migrations/0001_init.sql`, `src/infrastructure/D1ProductStore.ts`,
`src/adapters/tutani-catalog/syncCatalog.ts`, `src/api/handlers.ts`,
`src/api/validateInput.ts`, `src/index.ts`, `wrangler.jsonc`,
`tsconfig.json` + `tsconfig.node.json`, `scripts/sync-dry-run.ts`,
`tests/unit/{validateInput,api,syncCatalog}.test.ts`.

Tím je hotová **celá serverová část**: katalog v D1, noční sync,
tři endpointy. Chybí jen napojení znalostní vrstvy (integrační bod
připravený) a frontend.

### DRY-RUN proti reálnému e-shopu — 281 URL, 0 selhání, 22 s

```
stav: OK   URL 281   načteno 281   selhalo 0   produktů 264
diff: přidat 264, změnit 0, odebrat 0, nepoužitelné 52

skupina      celkem  použitelných      zdroj gramáže
OTHER          104           68        DATALAYER      108
MUSCLE          55           54        NAME            78
SUPPLEMENT      46           32        CHYBÍ           52
PLANT           24           24        RESOLVED_PRICE  26
BONE            17           16
ORGAN           14           14
LIVER            4            4
```

52 nepoužitelných je **správně**: poukázky, hračky, míčky, oleje
v ml. Do doporučení nepatří a systém si je nedomýšlí (R7).

### Co drží katalog klienta v bezpečí

- **dry-run nic nezapíše** a diff se přesto zaznamená do `sync_runs` —
  schválený diff musí být dohledatelný, ne jen v konzoli
- **prázdný výsledek běh PŘERUŠÍ** — kdyby se změnila struktura
  stránky, konfigurátor by jinak přišel o všechna doporučení
- **produkty se neodebírají při PARTIAL běhu** — chybějící SKU
  znamená „nepřečetli jsme ho", ne „přestal se prodávat"
- `ON CONFLICT` místo `DELETE`+`INSERT` — katalog není ani na okamžik
  prázdný, i kdyby zákazník počítal dávku ve stejnou chvíli
- concurrency 4, rozestup 150 ms, retry — e-shop v provozu to nesmí
  poznat

### Bezpečnost v odpovědi, ne v šabloně

- **disclaimer je v odpovědi Workeru** u OK, BLOCKED, INCOMPLETE
  i u chyby validace — úpravou frontendu se odstranit nedá (4 testy)
- **selhání rule enginu vrátí BLOCKED**, ne dávku bez zdravotních
  omezení — tichý fallback na prázdná omezení by byl horší než
  nevydat nic
- **nehotová znalostní vrstva se PŘIZNÁ**: zadal-li majitel diagnózu
  a pravidla neběží, přidá se `KNOWLEDGE_ENGINE_UNAVAILABLE`
  se `requiresVet: true`. Konfigurátor nesmí mlčky tvrdit, že
  s onemocněním ledvin počítal.
- CORS na **přesný výčet** originů, ne `endsWith('tutani.cz')` —
  tím by prošel `zlytutani.cz`

### Na co jsem narazil (potřebuje rozhodnutí)

1. **18 použitelných produktů v OTHER je reálné maso.** Celá řada
   `SF*` „MAX deluxe" (kostky hovězí svaloviny, 3/4 kuřete
   s dršťkami) je v kategorii **„BARF na cesty - barf granule"**,
   která v `categoryMap` není. Do dávky patří, ale nedoporučí se.
   Rozhodnout: doplnit mapování, nebo je klient nechce v BARF dávce?
2. **`MYS` „Myš mražená 16-22g 25ks" → 22 g za 405 Kč.** Parser vzal
   gramáž JEDNÉ myši, balení je 25 ks. Kdyby se dostala do dávky,
   doporučí nesmyslné množství. Podobně `TUT35` „6ks",
   `TUT60` „2 ks" — u těch aspoň gramáž chybí a vypadnou samy.
3. **20 z 26 rozporů v gramáži rozhodl tie-break, ne cena.** Obě
   varianty jsou cenově možné, takže vyhrál název. U `DR23`
   „Dromy Krill pure 130g" to dává 1169 Kč/kg proti 304 Kč/kg
   z adminu — cena tady nerozhodla a název nemusí být správně.
4. **`priceId` je vždy NULL** — v `dataLayer` na detailu produktu
   není (ověřeno). Vložení do košíku se bude muset opřít
   o `productId` a formulář, jinak potřebujeme jiný zdroj.
5. **`database_id` ve `wrangler.jsonc` je prázdné** — čeká na
   `wrangler d1 create tutani-barf`. Nevymýšlím si ho.

### Stav projektu

| vrstva | stav |
|---|---|
| D1 schéma + migrace | ✅ ověřeno proti sqlite3 |
| store (rozhraní + D1) | ✅ dávkový zápis, limit parametrů ošetřen |
| sync katalogu + Cron | ✅ dry-run naostro, 264/264 |
| API `/v1/davka`, `/knowledge`, `/health` | ✅ |
| validace vstupu | ✅ kódy, ne texty |
| napojení znalostní vrstvy | ⬜ integrační bod hotový, čeká na výměnu `NOOP_RULE_ENGINE` |

**Testy: 172/172** (50 původních nedotčeno), `tsc --noEmit` čistý.


## 2026-09-09 (00:35) — zdravotní volby v UI, blokace ověřená v prohlížeči

Doplněno po nálezu ze znalostní vrstvy: **konfigurátor se musí ptát
na stadium CKD**, jinak nelze rozlišit `ckd-early` (dávka se vydá) od
`ckd-advanced` (nevydá).

### Co se změnilo

- **vysvětlení pod každou zdravotní volbou**, ne v `title` — na mobilu
  se `title` nezobrazí vůbec a majitel by nepoznal, které stadium
  vybrat. Texty přicházejí z Workeru ze znalostní databáze
  (`explainCs`), nejsou ve frontendu natvrdo.
- **stavy, které dávku zablokují, jsou označené PŘEDEM** oranžovým
  textem „U tohoto stavu dávku nepočítáme" — zákazník to má vědět,
  než klikne, ne až po odeslání.
- náhled dostal obě stadia CKD i jaterní shunt, aby se blokace dala
  předvést klientovi.

### Ověřeno v Chrome, 0 chyb v konzoli

| test | výsledek |
|---|---|
| 5 diagnóz s vysvětlením | ✅ 2 označené jako blokující |
| pokročilé CKD | ✅ dávka **i nákup se skryjí**, zobrazí se „Tady si netroufáme radit" |
| počáteční CKD | ✅ 338 g, kosti 8 %, 1 varování |
| mobil 390 px | ✅ scrollWidth 390, popisy se vejdou |

### Zbývá rozhodnout (nezablokovalo vývoj)

Co dělat, když majitel **stadium nezná**. Návrh agenta byl použít
`ckd-advanced` (bezpečnější), ale znamená to, že části zákazníků
systém dávku nedá. Zatím se nic nepředvolí — zákazník musí vybrat
sám. **Rozhodnutí Lucky/klient.**

## 2026-09-09 (00:25) — znalostní vrstva nemocí HOTOVÁ (88/88 testů)

Znalostní databáze a rule engine dodány (paralelní agent), ověřeno
proti reálnému katalogu. **`tsc --noEmit` čistý, 88/88 testů.**

```
tenants/tutani/rules/tutani-health.json    15 stavů, 42 pravidel
tenants/tutani/rules/ingredients.json      28 surovin
src/rules/RuleEngine.ts                    interpret (buildKnowledgeBase, resolveConstraints)
tests/unit/RuleEngine.test.ts              38 testů
scripts/ukazka-nemoci.ts                   ukázka celého toku s nemocemi
```

### Co znalostní vrstva pokrývá

| stav | dopad na dávku |
|---|---|
| `ckd-early` | kosti ≤ 8 % (fosfor), 3 porce, vet |
| `ckd-advanced` | **BLOCKED** — dávka se nevydá |
| `pankreatitida` | preferuje libové, vylučuje tučné, 3 porce |
| `onemocneni-jater` | játra ≤ 3 %; bílkovina ZÁMĚRNĚ neomezená |
| `portosystemovy-shunt` | **BLOCKED** |
| `med-hepatopatie` | játra ≤ 1 %, orgány ≤ 3 % |
| alergie kuřecí / hovězí / drůbež / ryby / vepřové | vyloučení surovin |
| `toxicke-potraviny` | `alwaysActive` — 8 surovin vyloučeno i bez zadání |

Ověřeno naostro: dvojí limit na měď se **skládá** (játra 1 %, orgány
3 %), renormalizace poslala svalovinu na 78 % a zeleninu na 8 %.
Neznámá diagnóza se **přizná** varováním + `requiresVet`, neignoruje
se tiše.

### DVĚ CHYBY V MAPOVÁNÍ, které vylezly až s nemocemi — OPRAVENO

**1. Pamlsek se doporučoval jako složka dávky.**
`2927 Rolka sushi králičí játra-100g` je v kategorii „Barf pamlsky",
ale název obsahuje „játra" → mapoval se na LIVER. Systém pak
u pankreatitidy doporučil pamlsek za **630 Kč/kg** místo jater za
69 Kč/kg. Oprava: pamlsky, hračky, obojky, poukázky a „na cesty" jsou
v `categoryMap` PRVNÍ, takže vypadnou dřív, než je trefí slovo ze
složky dávky.

**2. Kachní jatýrka padala na ORGAN, ne LIVER.**
`TUT22 Barf Kachní jatýrka 500g` je v kategorii „Barf - Kachní
vnitřnosti". U hepatopatie s ukládáním měďi (játra max 1 %) by se měď
dostala přesně tam, odkud ji vyřazujeme. Oprava: **játra podle názvu
mají přednost i před kategorií** (`resolveBarfGroup`, krok 0) — jsou
to zdravotně oddělené složky s vlastním limitem. Výjimka platí jen
tehdy, když kategorie nemapuje na OTHER, aby se pamlsek nepřeklopil
zpátky na LIVER.

Rozpad po opravách: OTHER 104, MUSCLE 55, SUPPLEMENT 46, PLANT 24,
BONE 17, ORGAN 14, **LIVER 4** (dřív 1).

### OTEVŘENÉ OTÁZKY z dodané znalostní vrstvy — POTŘEBUJÍ ROZHODNUTÍ

1. **BONE 8 % u CKD není citace, je to náš převod.** Veterinární
   literatura udává fosfor v **g/1000 kcal**, ne v procentu kostí.
   V JSONu označeno `source: "L-CODE-INFERENCE"`. Musí potvrdit
   veterinář. Totéž LIVER 3 % / 1 % a ORGAN 3 %.
2. **Konfigurátor se MUSÍ ptát na stadium CKD** — bez toho nelze
   rozlišit `ckd-early` (dávka se vydá) od `ckd-advanced` (nevydá).
   Návrh agenta: když majitel stadium nezná, použít `ckd-advanced`
   (bezpečnější) — ale znamená to, že části zákazníků systém dávku
   nedá. **Rozhodnutí Lucky/klient.**
3. **Preference přebíjí cenu** — u pankreatitidy vybral `pickBest`
   králičí játra za 444 Kč místo 69 Kč, protože `INGREDIENT_PREFER`
   řadí před cenou. Buď má cena preferenci u drahých produktů přebít,
   nebo mají být preference jen pro MUSCLE, kde o tuk skutečně jde.
   (Po opravě mapování je konkrétní případ vyřešený — pamlsek vypadl —
   ale princip zůstává.)
4. **Pankreatitida nemá jak filtrovat tuk** — katalog nenese `fatPct`,
   pravidlo se hlásí jako `NO_DATA_FOR_PRODUCT_ATTR` a filtruje se jen
   po surovinách. Aby to bylo skutečně nízkotučné, musí klient doplnit
   obsah tuku.
5. **Alergie na drůbež plošně vylučuje kachní a krůtí** — konzervativní
   volba, křížová reaktivita mezi ptáky nemá v literatuře pevná čísla.
   Jemnější dělení = čistě datová změna.
6. **Kuskus je z pšeničné semoliny** — má `commonAllergen: true`,
   ale podmínka „alergie na obiloviny" ve v1 není.

### Zdroje veterinárních hodnot (v JSONu, blok `sources`)

IRIS Kidney / Today's Veterinary Practice ACVN 2016, Merck Vet Manual
(Nutrition in Hepatic Disease — bílkovina se automaticky NEomezuje),
TVP Copper Hepatopathy, SASH Vets (pankreatitida < 10 % tuku),
VCA přehled 297 psů (alergeny), ASPCA APCC (toxické).

### Stav projektu

| vrstva | stav |
|---|---|
| tenant model, scraper, konflikty gramáže | ✅ |
| výpočet dávky, product matching | ✅ |
| frontend konfigurátoru | ✅ ověřen v Chrome |
| **znalostní vrstva nemocí** | ✅ 15 stavů, 42 pravidel |
| API Workeru + D1 | 🔄 běží agent |

## 2026-09-09 (00:30) — frontend konfigurátoru, ověřený v prohlížeči

**Napsáno:** `frontend/konfigurator.js` (27 KB), `konfigurator.css`,
`nahled.html` (náhled pro klienta bez nasazení).

### Ověřeno v REÁLNÉM Chrome (Playwright), 0 chyb v konzoli

| test | výsledek |
|---|---|
| výchozí 15 kg | 338 g/den, 2× 169 g, 621 Kč/30 dní |
| posuvník na 24 kg | **540 g** — sedí na engine |
| nadváha | vyžádá cílovou hmotnost, 1,25 % z 20,5 kg, varování |
| nemocné ledviny | kosti 10 → **8 %**, zelenina 5 → **7 %** (renormalizace), 2 hodnoty oranžově |
| alergie na kuřecí | maso se překlopilo na **Barf Mletý Salmo Salar** |
| „proč právě 540 g?" | 4 kroky auditu, bez AI |
| zásoba na týden | 320 Kč (46 Kč/den) vs. měsíc 839 Kč (28 Kč/den) |
| mobil 390 px | scrollWidth 390 = **bez horizontálního scrollu**, výsledek nahoře |

### Rozhodnutí ve frontendu

- **jedna obrazovka, dva sloupce** — vlevo pes, vpravo dávka;
  přepočítává se při každé změně, žádné tlačítko „Vypočítat"
- **na mobilu je výsledek PRVNÍ** (`order: -1`) — zákazník musí
  vidět číslo bez scrollování
- **debounce 250 ms** + pořadové číslo požadavku, aby starší odpověď
  nepřebila novější při tahání posuvníkem
- při přepočtu výsledek **zešedne, ale zůstane vidět** — obrazovka
  nebliká
- **věk lidsky**: štěňata v měsících, dospělí v letech, se správným
  skloňováním
- **ideální hmotnost se ukáže jen při nadvázi**; předvyplní se odhad
  (85 %), který zákazník musí potvrdit — systém si hodnotu nevymýšlí
- **březost a laktace jen u fen**
- **diagnózy a alergie se tahají z `/v1/knowledge`** — frontend je
  nemá natvrdo; když endpoint selže, konfigurátor funguje dál bez
  zdravotních voleb
- **vložení do košíku SEKVENČNĚ** — Shoptet nemá dávkové vložení
  a paralelní volání si přepisují stav košíku
- **disclaimer se vykresluje z odpovědi Workeru**, ne ze šablony →
  nedá se odstranit úpravou frontendu (§9 zadání)
- **tisk**: formulář a tlačítka se skryjí, jídelníček se dá vzít
  k veterináři

### Náhled pro klienta

`frontend/nahled.html` podvrhne `fetch` a ukáže konfigurátor bez
Workeru — na odsouhlasení vzhledu. Zjednodušený výpočet v náhledu je
označený jako náhledový, aby nevznikla druhá neautoritativní
implementace.

### Poznámka k testování

Playwright nepodporuje Chromium na tomhle macOS (Darwin 21.6 /
macOS 12) — použit systémový Chrome přes `channel="chrome"`.
Testovací skript: `/tmp/tb_test.py` (mimo repo, jednorázový).

### Stav projektu

| vrstva | stav |
|---|---|
| tenant model, scraper, konflikty gramáže | ✅ |
| výpočet dávky, product matching | ✅ 50 testů |
| **frontend konfigurátoru** | ✅ ověřen v prohlížeči |
| knowledge engine (nemoci) | 🔄 běží agent |
| API Workeru + D1 | 🔄 běží agent |

### Další krok

Počkat na oba agenty, zapojit `/v1/knowledge` a `/v1/davka` na reálný
Worker, nasadit.

## 2026-09-09 (00:10) — product matching hotový, celý tok jede naostro (50/50)

**Napsáno:** `src/engine/product-matching/matchProducts.ts`,
`tests/unit/matchProducts.test.ts` (19), `scripts/ukazka-toku.ts`.

Tím jsou hotové **všechny výpočetní vrstvy**: profil psa → dávka →
rozpad → konkrétní balení → cena. Bez UI, bez databáze.

### Ukázka toku proti REÁLNÉMU katalogu (212 použitelných produktů)

```
Rex, 24 kg, dospělý, střední aktivita → 540 g/den (2× 270 g)
  svalové maso      405 g/den →  5× Barf Mleté kuře 3kg          545 Kč
  mleté kosti        54 g/den →  1× Barf Kuřecí vemínko 3kg      115 Kč
  játra              27 g/den →  1× Pašíkova játra mletá 1kg      69 Kč
  ostatní orgány     27 g/den →  1× Plíce jako kráva mleté 1kg    49 Kč
  zelenina a ovoce   27 g/den →  2× Barf Mrkev 500g               78 Kč
  CELKEM na 30 dní: 856 Kč (29 Kč/den)
```

Další ověřené scénáře:

| pes | dávka | cena/30 dní |
|---|---|---|
| Bela, štěně 4 měsíce, 8 kg | 720 g/den (9 %) | 1 122 Kč |
| Max, 30 kg, nadváha (ideál 24) | 300 g/den (1,25 %) | 599 Kč |
| Rex s alergií na drůbež | 540 g/den | 864 Kč — **maso vyměněno na Salmo Salar, kosti na Pašíkovy** |
| Rex s onemocněním ledvin | 540 g/den, kosti 54 → 43 g | 856 Kč |
| Rex, týdenní zásoba | 540 g/den | 381 Kč |

Filtr alergií funguje: při vyloučení drůbeže se doporučení samo
překlopilo na rybí a vepřové produkty, bez zásahu do výpočtu.

### Přiměřenost balení (nová podmínka)

Ukázka toku vypadala, že se doporučuje předimenzovaný nákup, tak jsem
do výběru přidal strop `MAX_OVERSHOOT = 2.0` — balení nesmí potřebu
překročit víc než dvojnásobně, pokud existuje menší alternativa.

**Prověření ale ukázalo, že původní doporučení bylo správné:**
`TUT9/15` Kuřecí vemínko má po vyřešení konfliktu 3 kg za 115 Kč =
**38 Kč/kg, nejlevnější v kategorii BONE** (ostatní 49–115 Kč/kg).
Overshoot 1,85 je pod limitem. Podmínka tedy nic nezměnila a zůstává
jako pojistka pro případ, kdy klient zavede opravdu velká balení.

Zároveň jsem si ověřil druhou domněnku: „Kuřecí vemínko jako kosti"
není chyba mapování — klient ho má v kategorii **„Barf - Drůbeží
kosti"**, takže BONE je jeho vlastní zařazení.

### Pravidla, která matching drží

- **celá balení, zaokrouhlení nahoru** — maso se nekrájí na gramy
  a zákazník musí mít na celé období
- **cena za kilogram**, ne cena balení
- **deterministický výběr** (poslední rozhodčí SKU) — po obnovení
  stránky stejný výsledek, dohledatelné při reklamaci
- **vařené kosti nikdy** (tvrdý filtr)
- **nepokrytá složka se PŘIZNÁ**, nikdy nesubstituuje jinou složkou
  (ověřeno testem: chybí-li játra, svalovina se nenavýší)
- **`priceId` + `productId`** ve výstupu pro vložení do košíku

### Stav projektu

| vrstva | stav |
|---|---|
| tenant model | ✅ bez `if (client === …)` |
| scraper katalogu | ✅ 264 produktů, 0 chyb |
| řešení konfliktů gramáže | ✅ 26/26, cenou za kg |
| výpočet dávky | ✅ metodika jako data |
| product matching | ✅ včetně alergií a bezpečnosti |
| knowledge engine (nemoci) | ⬜ typy hotové, pravidla chybí |
| API Workeru | ⬜ |
| UI konfigurátoru | ⬜ |

**Testy: 50/50.**

### Další krok

Knowledge / rule engine — `ResolvedConstraints` z diagnóz a alergií.
Do matchingu i výpočtu už jsou zapojené, chybí jen vrstva, která je
z pravidel v JSONu složí.

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

## 2026-09-09 — Nutriční dataset v0.2: doplnění mikronutrientů

Doplněna data od Lucky (USDA FoodData Central) do
`tenants/tutani/rules/ingredients-nutrition.json`, `sourceVersion` 0.1 → 0.2:

**Doplněné živiny u existujících surovin** (vitamin A, D, E, B1, B2, B3,
B5, B6, B12, folát, cholin — dle dostupnosti u zdroje):
- Kuřecí prsa (SR Legacy): A, E, B1–B12, folát, cholin. D chybí u zdroje →
  `NOT_ANALYZED`.
- Hovězí ledvina: A, D, E, B1–B12, folát. Cholin chybí u zdroje →
  `NOT_ANALYZED`.
- Vepřová játra: A upřesněno na 6502 µg RAE (nahrazuje starší odhad),
  B1–B12, folát. D a cholin chybí u zdroje → `NOT_ANALYZED`.
- Losos atlantský farmovaný: A, D, E, B2–B12, folát, cholin. B1 chybí u
  zdroje → `NOT_ANALYZED`. **EPA/DHA zůstávají `NOT_ANALYZED`** — nový
  zdroj pro ně číslo nedodal.
- Celé vejce: doplněn D (2,0 µg).

**Nová surovina:** `hovezi-mlete-80-20` (Hovězí mleté 80/20) — plný sadu
makro/mikro dle USDA SR Legacy.

**Upřesnění:** `hovezi-srdce` byl `NEURCENO`/odhad, nahrazen rozsahovými
hodnotami ze zdroje (~107–112 kcal atd.), uložena středová hodnota,
`confidence` → `TABULKA` (pořád ne jednobodové měření, proto ne
`DATABAZE`).

**Stále chybí napříč katalogem** (aktualizováno v `gaps`): jód, mangan,
hořčík, sodík, draslík, chlorid, EPA/DHA (mimo NOT_ANALYZED u lososa),
aminokyseliny. Dokud tyhle živiny nemají aspoň jeden zdroj, engine nesmí
vydat 🟢 NUTRIČNĚ KONTROLOVANOU dávku (jen 🟡 ORIENTAČNÍ) — pravidlo je
v `Ingredient.ts` (`contribution()`, `NOT_ANALYZED` ≠ 0) a je beze změny,
jen dataset teď pokrývá víc živin.

Ověřeno: `npm test` 204/204 zelených, JSON validní. Žádný test nebyl
potřeba upravovat — `NutrientMap` je otevřený typ, nová pole neláme
schéma.

**Další krok:** jód, mangan a EPA/DHA jsou teď jediné chybějící vitamin/
minerál kategorie blokující 🟢 status — najít zdroj (USDA nebo NRC) a
doplnit, ideálně u lososa/rybího oleje pro EPA/DHA a u mořských/jodovaných
surovin pro jód. Pak rozšířit katalog o krůtí/králičí/jehněčí maso a
zeleninu/ovoce (viz `gaps.missingIngredients`).

## 2026-09-09 — Tutani produktový katalog: ingredient-level composition vrstva

Nová vrstva vedle stávajícího BarfGroup-level matching enginu
(`products` z 0001_init.sql, beze změny — NON-INTERFERENCE). Cíl:
z Tutani katalogu udělat skutečnou BARF surovinovou databázi, kde jde
vzít konkrétní produkt a použít ho jako vstup do nutričního výpočtu,
ne jen do matchingu podle kategorie.

### Rozdělení vrstev (zadání Lucky)

```
PRODUCTS     — co Tutani prodává (TutaniProduct)
INGREDIENTS  — nutriční surovina (domain/nutrition, beze změny)
COMPOSITIONS — přesná vazba produkt→surovina (IngredientComposition)
NUTRIENTS    — USDA hodnoty (domain/nutrition, beze změny)
ANALYTICAL   — hodnoty deklarované VÝROBCEM (AnalyticalValue)
SUPPLEMENTS  — vitaminy/minerály/oleje/přílohy (Supplement)
EVIDENCE     — zdroj+datum+confidence napříč vším
```

**Zásadní oddělení:** „Tutani tvrdí X" (`AnalyticalValue`) vs. „náš
výpočet z komponent vychází na Y" (`CalculatedNutritionValue`) — nikdy
sloučené do jednoho čísla, i když se rozcházejí.

### Nové soubory

```
src/domain/products/Composition.ts        IngredientComposition, AnalyticalValue,
                                           CalculatedNutritionValue, Evidence
src/domain/products/TutaniProduct.ts      kanonický produkt katalogu
src/domain/products/Supplement.ts         doplňky se štítkovou hodnotou (declared)
                                           + odvozenou (derivedPer100g), nikdy sloučené
src/domain/barf/parseIngredientComposition.ts
                                           rozklad textu složení na part-level suroviny
                                           (ne jen BarfGroup jako stávající parseComposition.ts)
migrations/0002_tutani_products.sql       tutani_products + tutani_supplements (D1)
src/infrastructure/TutaniProductStore.ts  D1TutaniProductStore
tests/unit/parseIngredientComposition.test.ts   7 testů, TUT175/155/223/58 case
tenants/tutani/rules/tutani-products.json      28 produktů (dvě dávky zadání)
tenants/tutani/rules/tutani-supplements.json   4 doplňky (Nutrin, TUT198, TUT202, TUT143)
```

### Certainty model (EXACT/PARTIAL/DERIVED/UNKNOWN)

- **EXACT** — TUT175 „40 % plíce / 30 % ledviny / 30 % játra"
- **PARTIAL** — TUT155 stejné tři suroviny, ale BEZ poměru → `percentage: null`,
  systém NEDOPOČÍTÁVÁ rovnoměrný rozpad (R7)
- **INGREDIENT_GROUP role** — TUT223 „50 % zelenina (mrkev, petržel, celer)":
  50 % je EXACT za celou skupinu, ale `subcomponentRatio: 'UNKNOWN'` uvnitř
- **explicitní nepřítomnost** — TUT58 „bez vnitřností" se zapisuje jako fakt
  (`absent: [{part: 'SECRETORY_OTHER', ...}]`), ne jako mezera

### EdiblePart rozšířen (aditivně, non-breaking)

`domain/nutrition/Ingredient.ts`: přidány `SECRETORY_LUNG` (plíce),
`SECRETORY_TRIPE` (dršťky/bachor), `SKIN` (kůže odděleně od SKIN_FAT).
Typ je string-tag bez switch-exhaustiveness kontroly jinde v kódu,
takže přidání je bezpečné — ověřeno `npx tsc --noEmit` čistě.

### Chybějící part v nutričním katalogu

`beef_lung`/hovězí plíce zatím nemá záznam v `ingredients-nutrition.json`
(viz `gaps.missingIngredients`) — rozklad produktu proběhne i tak
(`ingredientId: null`), nutriční výpočet u té složky zůstane neúplný,
stejný mechanismus jako `NOT_ANALYZED`. Rozhodnutí padlo takhle záměrně
(rozklad s dírou, ne blokace celého produktu) — díra se nemaskuje.

### Nález při psaní dat (ponechán otevřený, ne tiše opraven)

TUT198 (extrudovaná příloha): selen na štítku je 0,2 µg/kg, ale
v `tutani-supplements.json` je momentálně uložen s `basis: MG_PER_KG` →
`derivedPer100g` vychází 1000× výš než realita. Zapsáno do `noteCs`
u té položky jako otevřený nález — potřeba opravit `basis` na
mikrogramovou variantu, než se hodnota použije ve výpočtu.

### Duplicitní kód od Tutani

TUT9 a TUT13 mají v zadání stejné složení (krůtí křídla mletá) — uloženy
jako dvě položky, dokud scraper nepotvrdí, zda jde o gramážní varianty
stejného produktu nebo o chybu v číslování.

### Práce rozdělena s agentem

D1 migrace + `TutaniProductStore.ts` napsal paralelní subagent podle
zadání (existující styl `D1ProductStore.ts`). Během souběhu došlo
k dočasnému nesouladu typů (agent typecheckoval dřív, než jsem dokončil
`Composition.ts` rozšíření o `role`/`subcomponentsCs`) — po dokončení
obou stran `npx tsc --noEmit` nad celým repem čistý, `npm test`
211/211 (204 stávajících + 7 nových).

### Ověřeno

- `npx tsc --noEmit` — 0 chyb
- `npm test` — 211/211 zelených
- JSON datasety (`tutani-products.json`, `tutani-supplements.json`) validní

### Další krok

1. Napojit `tutani-products.json`/`tutani-supplements.json` na D1
   (`D1TutaniProductStore.upsertProduct`/`upsertSupplement`) — teď je
   to jen statický JSON v `tenants/`, žádný import skript zatím neběžel.
2. Opravit jednotku selenu u TUT198 (µg/kg, ne mg/kg).
3. Doplnit `hovezi-plice` (beef lung) do `ingredients-nutrition.json`
   z USDA, ať TUT175/TUT155 rozklad má plné nutriční pokrytí.
4. Projet zbytek kategorií Tutani (drůbež, vepřové, ryby, telecí —
   zatím pokryty jen částečně) a rozšířit `tutani-products.json`.
5. Napsat `barf/composeProduct.ts` — výpočet `calculated_nutrition`
   z rozloženého `composition[]` + USDA dat, s `confidence: COMPLETE
   | INCOMPLETE` podle toho, zda všechny složky měly EXACT/DERIVED podíl
   a všechny živiny byly MEASURED.

## 2026-09-09 (pokrač.) — Tutani katalog rozšířen na 80 produktů + 28 doplňků + kategorie

Navazuje na předchozí záznam ze stejného dne (ingredient-level composition
vrstva). Zpracováno šest dalších dávek dat od Lucky — postupné vytěžení
17 BARF větví katalogové navigace Tutani.

### Nový soubor

```
tenants/tutani/rules/tutani-catalog-categories.json
```

`CatalogCategoryRecord` (nový typ `src/domain/products/CatalogCategory.ts`)
— stav vytěžení každé ze 17 větví (drůbeží, hovězí, kachní, klokaní,
konina, králičí, jehněčí/skopové, krůtí, ryby, telecí, vepřové, zvěřina,
Graf Barf, balíčky, kočky, dravci, gurmáni, strava pro psy).

**Klíčový nový stav:** `CATALOG_CATEGORY_PRESENT_PRODUCTS_NOT_EXTRACTED`
— odlišuje „kategorie prokazatelně existuje, ale crawler z ní nevytáhl
SKU" od „kategorie má 0 produktů". Graf Barf je typický případ: Tutani
popisuje technologii (šokové zmrazení −48 °C, kostky svalovina+kosti/
chrupavky+droby, nemleté, lidská kvalita), ale aktuální výpis produktů
je prázdný — engine to NESMÍ interpretovat jako „Tutani Graf Barf
neprodává". Barf pro dravce prošel opačným směrem: dřív jen
`CATALOG_CATEGORY_PRESENT`, dnes `PRODUCTS_EXTRACTED` (TUT122 kuřátka,
MYS myši potvrzeny konkrétně).

### tutani-products.json: 28 → 80 (v0.1 → v0.2)

Doplněny kompletní větve: krůtí (15 SKU), konina (3), vepřové (11),
zvěřina (5), ryby (7), drůbeží doplnění (7), dravci (TUT122), ZOO Pošvář
hlodavci (MYS/MYS3), BARF strava pro psy (ETUT1/ETUT4 kompozity +
TUT214/TUT216B/losos varianty).

**Oprava:** TUT222 Šemíkova mňamka měla ŠPATNÝ dřívější odhad 50/35/15 %
— aktuální produktová stránka uvádí 50 % / 3,5 % / 1,5 %. Opraveno,
`compositionAccountedPct` teď správně 55 (ne 100) — zbylých ~45 %
Tutani nedeklaruje a systém to NEDOPOČÍTÁVÁ (R7).

**Nový certainty case:** `UNKNOWN` poprvé použit naostro (TUT214 „Hovězí
kostky" — jen název, ani vyjmenované složky jako u PARTIAL).

**Produkt bez kódu:** „Držkaté kuře" (40 % hovězí dršťky / 60 % kuřecí
skelety) — Tutani kód není v aktuálním výpisu vidět, uloženo pod
zástupným `productId` s explicitní poznámkou, URL neklikatelná do
potvrzení skutečného kódu.

**Nález:** TUT156 „Srdce jako Kráva mleté" má VEPŘOVÝ katalogový prefix,
ale surovina je HOVĚZÍ srdce (název to potvrzuje) — topCategory zůstává
VEPROVE (katalogová sekce Tutani), composition správně BEEF/hovezi-srdce.

**Nová EdiblePart potřeba:** hovězí vemeno (TUT187 Kuřecí vemínko,
ETUT1/ETUT4 ECM směsi) mapováno na `SECRETORY_OTHER` — nejbližší
existující part, mléčná žláza nemá vlastní enum hodnotu.

### tutani-supplements.json: 4 → 28 (v0.1 → v0.2)

**Nové pole `marketingClaims`** (`MarketingClaim[]`) — textová tvrzení
výrobce ODDĚLENÁ od `declared` (číselné hodnoty). Zásadní pravidlo
(Lucky): „Omegavet budeme evidovat jako zdroj EPA/DHA POUZE tehdy, když
máme skutečné deklarované množství EPA+DHA, ne jen tvrzení 'obsahuje
omega-3'." Stejně tak TUT134 kelpa — zdravotní účinky v popisu se
NIKDY automaticky nestávají nutričním faktem; TUT202 křemelina —
antiparazitický/detox claim stejně odděleně.

Rozšířen `SupplementCategory` o `FIBER`, `TREAT`, `THERAPEUTIC_SUPPLEMENT`.
Přidán `SupplementBasis.UG_PER_KG` — oprava nálezu: TUT198 selen byl
0,2 µg/kg, ne mg/kg (1000× rozdíl), zapsáno jako otevřený nález
v minulém záznamu, teď opraveno.

Nové položky: Dromy řada (DR1/DR3/DR4/DR8/DR16/DR24), Energy řada
(E11/E12/E13/E15/E17/E19 — cílené terapeutické doplňky, VEDENY MIMO
základní nutriční balancování), pamlsky (TUT146/K4/KUR/1618/TUT189),
MAX deluxe BARF-na-cesty balení (2553/07/2559/9493).

**Confidence `ESTIMATED`:** položky, kde známe jen katalogovou citaci
(název/gramáž/cena), ne deklarované složení — `declared: []`, NIKDY
dopočet z podobnosti k jinému produktu stejné řady (R7).

### Nový typ v Supplement.ts

`MarketingClaim { claimCs, backedByDeclaredNutrient }` — `Supplement`
teď má povinné pole `marketingClaims: MarketingClaim[]`. D1 schéma
(0002_tutani_products.sql) i `TutaniProductStore.ts` (upsert/select)
doplněny o sloupec `marketing_claims` — agent, který psal store, dokončil
svou práci PŘED tímhle rozšířením typu, takže jsem to dopsal sám
(aditivní diff, stejný vzor jako zbytek souboru).

### Ověřeno

- `npx tsc --noEmit` — 0 chyb
- `npm test` — 211/211 zelených (beze změny počtu — nová data jsou JSON,
  žádný nový test kód kromě již zapsaného `parseIngredientComposition.test.ts`)
- JSON datasety validní, `TUT222` `compositionAccountedPct` opraveno na 55
- Dedup podle `code` ověřen (81 vstupů → 80 unikátních, TUT133 byl
  zapsán dvakrát se stejným obsahem, žádná ztráta dat)

### Další krok

1. Potvrdit skutečný kód „Držkatého kuřete" a nahradit zástupné productId.
2. Ověřit, zda TUT216 (drůbeží sekce, bez ceny) a TUT216B (Barf strava
   pro psy, 109 Kč) jsou totéž SKU napříč kategoriemi — pokud ano,
   sloučit na jeden záznam.
3. Doplnit deklarované hodnoty (Ca/P/vitaminy) do TUT181 Multivitamín,
   jakmile bude znám přesný štítek — teď je jen ingredientList s procenty.
4. Zbývající CATALOG_CATEGORY_PRESENT_PRODUCTS_NOT_EXTRACTED větve
   (klokaní, jehněčí/skopové, telecí, balíčky, gurmáni) — vytěžit stejným
   postupem, jakým se povedlo doplnit dravce.
5. `barf/composeProduct.ts` (výpočet calculated_nutrition) — čeká na
   dostatečné pokrytí ingredient katalogu (viz gaps v ingredients-nutrition.json).

## 2026-09-09 (pokrač. 2) — Reconciliace s autoritativním scraper CSV, oprava chyb

Lucky dodal `~/Downloads/tutani_mrazene_maso_extracted_2026-09-09.csv` —
skutečný scraper výstup celé kategorie „Barf mražené maso" (103 unikátních
SKU, sloupce `kod,produkt,baleni,cena_kc,slozeni,zdroj`). Tohle je
AUTORITATIVNĚJŠÍ zdroj než ručně přepsané texty z konverzace stejného dne.

### Kritické opravy nalezené reconciliací

1. **TUT222 Šemíkova mňamka**: CSV potvrzuje **50 % / 35 % / 15 %**
   (koňská svalovina / králičí kosti / králičí srdce a plíce) — PŮVODNÍ
   hodnota z první dávky zadání byla SPRÁVNĚ. Mezitím provedená "oprava"
   na 50/3,5/1,5 % (podle ručně psané zprávy tvrdící "aktuální stránka
   uvádí") byla CHYBNÁ. Vráceno zpět na 50/35/15.
   **Poučení zapsané do note pole datasetu:** scraper výstup > ručně
   přepsaný text, i když ten druhý tvrdí vyšší aktuálnost — přijal jsem
   tvrzení o "aktuálnosti" bez ověření a přepsal správná data špatnými.

2. **TUT9 vs. TUT9/1, TUT9/5, TUT9/13, TUT9/15**: kód BEZ lomítka je
   "Kachní vznášedla" (100 % kachní křídla), NE "Krůtí vznášedla mletá",
   jak jsem měl dřív. Suffix `/N` znamená PĚT SAMOSTATNÝCH produktů,
   ne gramážové varianty jednoho SKU — chybný předpoklad z dřívějška
   opraven.

### Přestavba datového toku

Nový `scripts/import-mrazene-maso-csv.py` — parsuje CSV composition text
(`slozeni` sloupec) na `IngredientComposition[]` stejnou logikou jako
`src/domain/barf/parseIngredientComposition.ts` (přenesena do Pythonu
pro dávkové zpracování 103 řádků najednou). Idempotentní: re-run
nahrazuje jen produkty pokryté touto CSV kategorií, zbytek datasetu
(BARF strava pro psy, dravci, ZOO doplňky, přílohy — 20 SKU) se
přebírá ze stávajícího `tutani-products.json` beze změny.

**Chyby nalezené a opravené BĚHEM psaní parseru** (self-audit, ne
nahlášeno zvenčí):

- **"bez X" segmenty** (`bez kostí`, `bez vnitřností`) se PŮVODNĚ
  počítaly jako composition segment bez procenta → (a) celý produkt
  spadl do PARTIAL větve zbytečně, (b) `find_pattern` na "bez kostí"
  vytvořil FALEŠNOU položku "kosti", jako by kost byla PŘÍTOMNÁ
  surovina — přesný opak toho, co text říká. Opraveno: "bez X" segmenty
  se filtrují před analýzou a jdou do `claims.dietaryClaimsCs`.
- **Smíšené segmenty** ("Mletý králík; cca 70% kosti a chrupavky" — jeden
  segment BEZ %, jeden S %) — původní kód tiše zahodil segment bez
  procenta a vzal jen ten s %, což by tvrdilo "70 % kostí = 100 %
  složení". Opraveno: pokud NĚKTERÝ segment procento nemá, celý produkt
  jde do PARTIAL větve.
- **Dvojtečkový výčet u EXACT segmentu** ("100% celá mletá krůta:
  svalovina, kosti, kůže, chrupavka") — algoritmus bral jen JEDEN
  nejdelší pattern match z celého stringu a zbytek slov tiše zmizel
  (TUT58/TUT117 měly vyjít jako 4 PARTIAL složky, vyšla jen 1). Opraveno:
  obecný dvojtečkový výčet (mimo zelenina/droby case) se rozpadne na
  PARTIAL vnitřní seznam.
- **`find_pattern` fallback bug**: když text nenajde žádný pattern,
  funkce vracela `(popis_raw.strip(), popis_raw.strip(), None, None)` —
  DRUHÁ hodnota (`ingredient_id`) byla text, ne `None`. To by v produkci
  znamenalo, že engine dostane neplatné `ingredientId` jako by šlo
  o skutečný odkaz do nutričního katalogu. Opraveno na `None`.
- **Substring pattern kolize** ("králičí kosti" chytilo obecné "kosti",
  protože bylo výš v seznamu) — přepsáno na výběr NEJDELŠÍHO shodného
  triggeru napříč celým seznamem, ne prvního nalezeného v pořadí.
- Doplněny chybějící obecné (species-neutral) patterny: "stehna", "krky",
  "křídla", "svalovina", "játra" bez druhu — s druhem doplněným
  samostatně z názvu produktu NEBO z composition textu (TUT58 "Směs
  paní Krocanové" je fantazijní jméno bez "krůt", ale composition text
  "celá mletá krůta" druh potvrzuje).

**Ověřovací metoda:** napsán `full_audit.py` — automaticky porovnává
počet `%` v CSV textu vs. v parsovaném výsledku a hledá "ztracená slova"
(slova ze zdrojového textu, která se neobjeví v žádném `nameCs`/`sourceCs`
výsledku). Z 103 řádků zůstalo po opravách jen 5 flagů, všechny ověřeny
jako očekávané (nadpis celku typu "celé kuře", nebo "bez X" claim
správně mimo composition).

### Výsledek

`tutani-products.json` v0.2 → v0.3, 80 → 123 produktů (103 z CSV + 20
z předchozích zdrojů, které CSV nepokrývá).

### Ověřeno

- `npx tsc --noEmit` — 0 chyb
- `npm test` — 211/211 zelených
- JSON validní, 123 unikátních kódů
- Automatický audit (`full_audit.py`) — 0 skutečných problémů po opravách

### Reflexe k zapamatování

Tahle session obsahovala sérii ručně psaných zpráv tvrdících stále
aktuálnější/přesnější data ("aktuální stránka uvádí...", "opravuji svůj
dřívější údaj..."), které jsem bez ověření bral jako novější pravdu
a přepisoval jimi už zapsaná, ve skutečnosti správná data (TUT222).
Skutečný scraper výstup (CSV) je vždy silnější důkaz než přepis z
konverzace, i formulovaný s vysokou jistotou. Příště: u čísel, která už
jednou byla ověřená z jiného zdroje, žádat konkrétní důkaz (screenshot,
URL, syrový výstup) před přepsáním, ne jen přijmout tvrzení o
aktuálnosti.

### Další krok

1. Zbylých 20 produktů mimo CSV kategorii (dravci, BARF strava pro psy,
   ZOO doplňky, přílohy) — počkat na podobný autoritativní scraper
   export těch kategorií, než se jim bude věřit stejnou měrou.
2. `TUT133` duplicitní historie (byl zapsán 2× v předchozí manuální
   dávce) — teď plně nahrazen CSV verzí, staré ruční záznamy zahozeny.
3. `barf/composeProduct.ts` — čeká na dostatečné pokrytí ingredient
   katalogu (gaps v `ingredients-nutrition.json`), teď má smysl začít,
   protože produktová vrstva má výrazně vyšší datovou kvalitu.

## 2026-09-09 (pokrač. 3) — Inventární doplnění: doplňky, přílohy, BARF na cesty (crawler existence-only)

Zpracován `tutani_full_catalog_2026-09-09.json` crawler export — scraper
potvrdil jen NÁZEV+URL u kategorií „doplňky" (46 položek), „přílohy"
(24 položek) a „barf-na-cesty" (9 položek), BEZ composition/ceny/kódu/
analytických hodnot. Zapsáno jako inventární záznamy s
`evidence.confidence: 'ESTIMATED'`, `declared: []` — žádná fabrikovaná
čísla (R7).

Souběh s paralelním agentem, který ve stejnou dobu zapisoval pamlsky
(TREAT) do `tutani-supplements.json` — žádný konflikt nenastal
(read-modify-write proběhl čistě), všech 62 TREAT položek zůstalo
netknutých.

### tutani-supplements.json: 85 → 137 (v0.3 → v0.4)

52 nových záznamů (doplňky OTHER/OIL/THERAPEUTIC_SUPPLEMENT/
VITAMIN_MINERAL_PREMIX/FIBER dle typu + přílohy EXTRUDED_SIDE_DISH).
16 existujících položek anotováno poznámkou o potvrzené duplicitě
(TUT142, DR4, TUT181, TUT134, DR1, DR8, DR16, E11, E12, E13, E17, DR24,
TUT198, TUT143, TUT202, NUT1) — NEDUPLIKOVÁNO, nový záznam nepřidán.

**Otevřený nález (neopraveno, jen zapsáno):** slug
`dromy-ascokelp-360-g` odkazuje na produkt se zadaným názvem
„Dromy D-Tox 300g" — nesrovnalost mezi slugem (360 g, jiný produktový
název „Ascokelp") a názvem stránky (300 g, „D-Tox"). `packGrams`
záměrně `null`, dokud nebude ověřeno, která hodnota je správná.

**Vynecháno (ne produkt):** „Grafikon pro výběr optimálního preparátu
Energy Vet" — poradenská/marketingová stránka výrobce, ne SKU.

**Pravděpodobná duplicita bez jistoty:** „Dromy Konopný olej 500 ml"
vs. „Konopný olej pro psy 500 ml" — stejný objem a surovina, ale jiná
značka/název stránky nebyla potvrzena jako odlišná. Zapsáno JEN JEDNOU
(`konopny-olej-pro-psy-500-ml`), druhá stránka NEPŘIDÁNA jako
samostatný záznam.

**R7 přísně dodrženo u `dromy-omega-epa-dha-oil-500-ml`:** název
naznačuje EPA/DHA obsah, ale scraper nezískal konkrétní mg — zapsáno
JEN jako `marketingClaim`, `declared` zůstává `[]` (stejné pravidlo
jako Omegavet/kelpa precedent z předchozích záznamů).

### tutani-products.json: 123 → 128 (v0.4 → v0.5)

5 nových `TutaniProduct` záznamů (`topCategory: 'BARF_NA_CESTY'`) —
MAX deluxe balení, `kind: 'COMPOSITE'`, composition `certainty: 'PARTIAL'`
bez procent (scraper nezískal poměr).

4 položky vyhodnoceny jako pravděpodobná duplicita se STÁVAJÍCÍMI
záznamy (07, 2559, 9493, 2553) — tyhle 4 kódy ale AKTUÁLNĚ žijí
v `tutani-supplements.json` jako `Supplement`/`OTHER`, ne v
`tutani-products.json` jako `TutaniProduct`, ačkoliv věcně jde o hotová
masná balení „na cesty". Anotováno poznámkou u těch 4 existujících
záznamů (v supplements.json), NEDUPLIKOVÁNO, žádný nový záznam
nepřidán ani do products.json.

**Otevřený nález k dořešení příště:** kódy 07/2559/9493/2553 by
strukturálně patřily do `tutani-products.json` jako `TutaniProduct`
(BARF na cesty = maso, ne doplněk — stejná logika jako u zbytku úkolu C),
ale byly zapsány dřív do `tutani-supplements.json`. Non-interference —
NEPŘESOUVÁNO bez výslovného schválení Lucky, jen zaznamenáno jako
otevřená otázka.

### Ověřeno

- `npx tsc --noEmit` — 0 chyb
- `npm test` — 211/211 zelených
- JSON validní, žádné duplicitní `code` v ani jednom souboru
- `git status` potvrzuje, že paralelní agentův zápis (62 TREAT položek)
  zůstal beze změny

### Další krok

1. Rozhodnout, zda 07/2559/9493/2553 (MAX deluxe BARF na cesty) přesunout
   z `tutani-supplements.json` do `tutani-products.json` jako
   `TutaniProduct` — vyžaduje schválení Lucky (non-interference).
2. Ověřit nesrovnalost slug/název u `dromy-ascokelp-360-g` vs.
   „D-Tox 300g" proti skutečné produktové stránce.
3. Ověřit, zda „Dromy Konopný olej 500 ml" je skutečně tentýž produkt
   jako „Konopný olej pro psy 500 ml", nebo jiná značka/receptura.
