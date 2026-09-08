# Tutani BARF Worker

Konfigurátor krmné dávky BARF pro **tutani.cz** (e-shop
`obchod.tutani.cz`, Shoptet). Zákazník zadá údaje o psovi, systém
deterministicky spočítá denní dávku, rozpad na složky a sestaví nákup
z produktů Tutani.

L-Code Dynamics, 2026. Klient: Ladislav Švihel (přes Josefa Dlouhého).

## Zásadní rozhodnutí

| # | rozhodnutí | proč |
|---|---|---|
| R1 | **Žádné LLM nikde** | Krmná dávka je zdravotní doporučení — musí být deterministická, reprodukovatelná a obhajitelná. Vysvětlení „proč 540 g" se skládá z auditní stopy pravidel, ne z modelu. |
| R2 | Konfigurátor, ne chatbot | Údaje se sbírají strukturovaně v UI, ne dialogem. |
| R3 | Výpočet **jen na Workeru** | Frontend nesmí počítat dávku ani rozhodovat o vhodnosti produktu. |
| R4 | **Tenant model** | Worker nikdy nesmí obsahovat `if (client === 'tutani')`. Cesta: `tenantId → TenantConfiguration → RuleSet → ProductCatalog`. |
| R5 | **Knowledge base nesmí být v TypeScriptu** | Nemoci, alergie, procenta a poměry jsou JSON s verzí a zdrojem. Engine je jen interpret — přidání diagnózy nevyžaduje deploy. |
| R6 | Výpočet oddělen od výběru produktů | Katalog se mění denně, metodika ne. Jádro nezná ani jeden produktový kód. |
| R7 | **Nikdy se nehádá** | Chybí-li údaj, systém to přizná. Radši nedoporučit než doporučit špatně. |

## Struktura

```
src/
├── domain/            kanonické entity (tenant, pes, zdravotní stavy)
├── rules/             interpret znalostní vrstvy
├── engine/
│   ├── feeding-calculator/   % z hmotnosti → gramy, řešení překryvů pásem
│   ├── composition/          rozpad na složky
│   └── product-matching/     gramy → balení z katalogu
├── adapters/
│   └── tutani-catalog/       scraper Shoptetu (dataLayer), řešení konfliktů gramáže
├── api/               HTTP vrstva Workeru
└── infrastructure/    D1

tenants/tutani/
├── config/tenant.ts   vše specifické pro Tutani (data, ne kód)
└── rules/*.json       metodika a znalostní databáze

frontend/              konfigurátor do šablony Shoptetu + náhled
scripts/               dry-run scraperu, ukázka celého toku
tests/                 vitest + fixture reálného katalogu
docs/                  architektura, dokument pro klienta
```

## Jak to funguje

```
KONFIGURÁTOR (UI)          strukturovaný vstup, nic nepočítá
        ↓  POST /v1/davka
VALIDACE VSTUPŮ            rozsahy, kombinace, jednotky
        ↓
RULE ENGINE                nemoci, stavy, alergie → omezení
        ↓
BARF CALCULATOR            % z hmotnosti → gramy, deterministicky
        ↓
INGREDIENT REQUIREMENTS    potřeba po složkách (bez produktů!)
        ↓
PRODUCT MATCHING           pokrytí z katalogu Tutani
        ↓
VÝSLEDEK                   dávka + složení + produkty + varování + audit
```

Hranice mezi výpočtem a produkty je tvrdá: výpočetní jádro nezná
produktové kódy, matching nepočítá dávku.

## Vývoj

```bash
npm install

npm test                                    # vitest
npx tsc --noEmit                            # typová kontrola

# dry-run scraperu proti reálnému e-shopu (nic nezapisuje)
npx tsx scripts/scrape-dry-run.ts           # vzorek 25 produktů
npx tsx scripts/scrape-dry-run.ts --all --json /tmp/katalog.json

# celý tok od psa po košík, proti uloženému katalogu
npx tsx scripts/ukazka-toku.ts tests/fixtures/katalog-2026-09-09.json
```

Náhled frontendu bez Workeru: otevřít `frontend/nahled.html`
v prohlížeči.

## Katalog Tutani — jak se čte

Shoptet nemá pro tenhle e-shop REST API, ale sype na detail produktu
`dataLayer.push({ shoptet: {...} })` s kompletními daty: kód, cena,
hmotnost, dostupnost po skladech, kategorie, výrobce. Složení bývá
v popisu (`Složení: 100% kuřecí srdíčka`).

**Klient nám tedy nemusí nic exportovat** — scraper projde 281
produktových URL ze `sitemap.xml` a katalog se aktualizuje sám.

Naměřeno 2026-09-09: 264 produktů, cena 100 %, gramáž 80 %,
složení 17 %.

### Rozpor v gramáži

U 26 produktů si `dataLayer.weight` odporuje s gramáží v názvu
(v adminu zůstala nepřepsaná výchozí hodnota). Řeší se **cenou za
kilogram** proti mediánu skupiny — cena je nezávislý třetí zdroj
a jednu variantu obvykle vylučuje:

```
ZP12 „Krájené vemínko 1kg", 50 Kč
  1 kg →  50 Kč/kg  ✅ v pásmu MUSCLE (medián 147)
  5 kg →  10 Kč/kg  ❌ nereálné
→ 1 kg z názvu, produkt zůstává v doporučeních
```

Vyřešeno 26/26, žádný produkt se nevyřazuje. Rozpor se přesto
reportuje klientovi k opravě.

## Bezpečnost

Vynucená v enginu, ne v UI:

- **vařené kosti nikdy** — tvrdý filtr (nebezpečí střepů)
- **toxické potraviny** jako data (`isToxic`), ne seznam v kódu
- **alergie** vyřadí každý produkt s danou surovinou
- **závažná diagnóza** → dávka se nevydá (`status: BLOCKED`), odkaz na
  veterinárního nutričního specialistu
- **disclaimer je v odpovědi Workeru**, ne v šabloně — nedá se
  odstranit úpravou frontendu

## Otevřené otázky na klienta

1. **Senior se střední/vysokou aktivitou** — v dodané tabulce má
   senior jen „nízkou aktivitu". 6 kombinací z 480 nemá pásmo, systém
   vrací `INCOMPLETE`. Jaké procento má aktivní senior?
2. **Překryvy v tabulce procent** — kastrovaný s vysokou aktivitou,
   nadváha + laktace. Navržené řešení (nejsilnější dimenze rozhoduje,
   fyziologický stav nad kondicí) potřebuje potvrzení.
3. **Štěně s nadváhou** — doplněno pásmo 6–7 % (v růstu se nehladoví),
   potvrdit s veterinářem.
4. **Fantazijní názvy** — „Gurgle", „Pani Držkatá", „Šemíkova mňamka",
   „Kopyto jako kráva" nelze zařadit do složky dávky. Zůstávají mimo
   doporučení, dokud klient nedoplní zařazení.
5. **26 produktů s rozpornou gramáží** k opravě v adminu.

Průběžný stav a rozhodnutí: `PROGRESS_LOG.md` (nejnovější nahoře).
