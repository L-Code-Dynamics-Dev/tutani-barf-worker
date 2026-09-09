# BARF znalostní báze — referenční rámec

Autor rámce: **Jan Lančarič (Lucky)**, 2026-09-09.
Rozsah: body 1–96 (základní principy, suroviny, výpočty, bezpečnost).

Tenhle dokument je **zdroj pravdy pro metodiku**. Kód ho jen
interpretuje — když se rozejde s kódem, platí tento dokument a kód se
opraví.

## Zdrojová hierarchie (bod 67)

Priorita při konfliktu: **A > B > C > D**

| úroveň | zdroj | tag v datech |
|---|---|---|
| **A** | FEDIAF 2025 — evropský nutriční standard | `FEDIAF` |
| **B** | WSAVA, Merck Veterinary Manual, odborné studie | `WSAVA`, `MERCK`, `VET_ZDROJ` |
| **C** | BARF literatura — Novosádová, Julia Fritz, Schäfer & Messika | `NOVOSADOVA`, `BARF_TRADICE` |
| **D** | praktické zkušenosti, chovatelé, fóra | `NEJISTE` |
| — | **náš vlastní převod** — NENÍ citace | `L_CODE_INFERENCE` |

**Zásada (Lucky):** FEDIAF 2025 držíme jako referenční vrstvu, BARF
literaturu včetně Novosádové jako samostatnou **praktickou** vrstvu.
Tím se zabrání tomu, aby se tradiční BARF pravidlo omylem vydávalo za
současný nutriční standard.

## Základní pravidlo (bod 1)

> Pes nepotřebuje „ingredience". Potřebuje živiny.

```
SUROVINA → ŽIVINY → POTŘEBA PSA → CELÁ DÁVKA → KONTROLA VYVÁŽENOSTI
```

## Co je implementované a co ne

| vrstva | stav | poznámka |
|---|---|---|
| 01 PES | ✅ | `DogProfile` — chybí BCS a `breedSize` |
| 02 ENERGIE | ✅ | `src/domain/nutrition/energy.ts` — RER/MER s rozmezím a zdroji |
| 03 MAKROŽIVINY | ❌ | katalog Tutani nenese protein, tuk ani energii |
| 04 MINERÁLY (Ca, P, Ca:P…) | ❌ | **Ca:P se nedá spočítat** — nejsou data |
| 05 VITAMINY | ❌ | nejsou data |
| 06 MASTNÉ KYSELINY | ❌ | EPA/DHA nejsou data |
| 07 SUROVINY | ✅ | `detectIngredients` + `parseComposition` (rozpad podle %) |
| 08 ŽIVOTNÍ FÁZE | ✅ | `doseMatrix` + koeficienty energie |
| 09 TERAPEUTICKÉ SITUACE | ⚠️ | 6 diagnóz, 2 blokující; limity jsou `L_CODE_INFERENCE` |
| 10 PŘECHOD | ❌ | texty nejsou |
| 11 BEZPEČNOST | ⚠️ | vařené kosti a toxické ano; bakterie, paraziti, hygiena ne |
| 12 KONTROLA | ⚠️ | jen energie; 17 parametrů z bodu 65 nejde bez dat |

## Klíčové zjištění: nutriční data NEEXISTUJÍ

Bod 66 (databáze suroviny s 30+ živinami) a bod 65 (kontrola 17
parametrů) potřebují hodnoty, které **katalog Tutani nenese ani
u jednoho produktu**. Ověřeno na 7 feedech Shoptetu 2026-09-09.

Dvě cesty, obě s háčkem:

1. **Tabulky složení** (USDA FoodData Central, DTU Frida) — mají
   obecné hodnoty. „Hovězí svalovina" v USDA ≠ „Barf Mletý Bejk
   s droby". Legitimní jen s `source: USDA` a `confidence: TABULKA`.
2. **Laboratorní rozbory** — ~3–5 tis. Kč za produkt, u 90 produktů
   ekonomicky nereálné.

**Dokud data nejsou, systém to musí PŘIZNAT** — bod 95, tři úrovně
výsledku:

- 🟢 **NUTRIČNĚ KONTROLOVANÁ** — data umožňují kontrolu klíčových živin
- 🟡 **ORIENTAČNÍ** — některá data chybí nebo jsou příliš variabilní
- 🔴 **NEVHODNÁ** — významný nedostatek/nadbytek nebo bezpečnostní problém

Dnes je **každá dávka 🟡 ORIENTAČNÍ**. To není nedostatek
implementace, ale pravdivý stav dat.

## Co systém NIKDY nesmí automaticky (bod 94)

- doporučit více jater při každém problému
- doporučit více kostí při každém problému s Ca
- olej „na srst" bez výpočtu
- vitamin D bez kontroly celkové dávky
- jód bez znalosti jeho obsahu
- dietu pro nemocného psa bez znalosti diagnózy
- **štěněcí dávku pouze podle % tělesné hmotnosti**

## Mýty, které systém nesmí podporovat (bod 46)

| tvrzení | stav |
|---|---|
| „80/10/10 automaticky splňuje potřeby psa" | ❌ |
| „Kosti čistí zuby" | ❌ není prokázáno (WSAVA) |
| „Zmrazení zabije všechny bakterie" | ❌ zmrazení ≠ sterilizace |
| „Průjem je detox" | ❌ |
| „BARF vyřeší alergie" | ❌ řeší se eliminační dietou |
| „Více jater je zdravější" | ❌ riziko toxicity vitaminem A |
| „Každý pes má stejnou dávku podle % váhy" | ❌ |
| „Pes potřebuje živiny, ne seznam ingrediencí" | ✅ |

## Otevřené k rozhodnutí

1. **Naplnit surovinovou databázi z tabulek?** (USDA, ~20 surovin)
   → umožní orientační Ca:P a vitamin A, ale je to obecná hodnota.
2. **Bezpečnostní texty** (body 42–45) — mražení, hygiena, kdy jít
   k veterináři. Nepotřebují data, jen napsat.
3. **BCS a `breedSize`** do `DogProfile` — bod 71, 81.
4. **Přechod z granulí** (bod 28) — 7–10 dní podle WSAVA.
