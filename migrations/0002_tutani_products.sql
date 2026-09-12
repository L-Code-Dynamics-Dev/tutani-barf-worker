-- ============================================================================
-- 0002_tutani_products — ingredient-level nutriční katalog (TutaniProduct,
-- Supplement) — ODDĚLENÝ od `products` z 0001_init.sql.
--
-- DECISION (Lucky 2026-09-09, NON-INTERFERENCE): `products` z 0001 je
-- BarfGroup-level matching engine v OSTRÉM PROVOZU — sync, cron, výpočet
-- dávky, košík zákazníka na něm už stojí a je otestovaný (172+ testů).
-- NESMÍ se přepisovat kvůli nové vrstvě, která teprve vzniká.
--
-- Tahle migrace přidává PARALELNÍ, jemnější vrstvu:
--   `tutani_products`    — katalogový záznam + odkaz na složení surovin
--                          (`TutaniProduct`, ingredient-level, ne
--                          BarfGroup-level jako `products.barf_group`)
--   `tutani_supplements` — vitaminové/minerální přípravky a přílohy
--                          (`Supplement`), se štítkovou hodnotou
--                          zachovanou beze změny vedle odvozené.
--
-- Vazbu mezi starým `products` (matching, ostrý provoz) a novým
-- `tutani_products`/`tutani_supplements` (nutriční výpočet) řeší
-- `barf/composeProduct.ts` (aplikační vrstva) — ŽÁDNÁ z tabulek
-- druhou nepřepisuje ani nenahrazuje.
--
-- Sloupce JSON (`composition`, `analytical`, `claims`, `declared`,
-- `derived_per_100g`, `ingredient_list`, `mineral_assay`) se ukládají
-- jako serializovaný text stejně jako `ingredients`/`composition_parts`
-- v 0001 — D1/SQLite nemá spolehlivé JSON operátory a filtrování nad
-- složením se dělá v aplikační vrstvě, ne v SQL.
--
-- R7 (nic se nedomýšlí/nehádá): kdekoliv smí produkt/doplněk legitimně
-- chybět hodnotu (cena, gramáž, značka, seznam ingrediencí, mineralAssay…),
-- sloupec je nullable BEZ DEFAULT. Chybějící hodnota je NULL, nikdy tichá
-- nula nebo prázdný řetězec, který by vypadal jako zjištěný údaj.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- tutani_products — `TutaniProduct` (src/domain/products/TutaniProduct.ts).
--
-- `evidence_*` sloupce jsou plochý rozpad `Evidence` (Composition.ts)
-- — stejný vzor jako `weight_conflict`/`source_feed_at` v 0001: audit
-- musí jít dohledat i bez parsování JSONu.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tutani_products (
    tenant_id                TEXT    NOT NULL,
    product_id               TEXT    NOT NULL,
    code                     TEXT    NOT NULL,
    name_cs                  TEXT    NOT NULL,
    brand                    TEXT,
    category_path            TEXT,

    -- Pomocné zařazení pro navigaci v datasetu — NENÍ vstup do výpočtu
    -- (na rozdíl od `products.barf_group` v 0001). Viz TutaniProduct.ts.
    top_category             TEXT    NOT NULL DEFAULT 'OTHER',

    -- NULL je legitimní stav: cena/gramáž se nikde nedá přečíst (R7).
    price_with_vat_czk       REAL,
    pack_grams               INTEGER,

    -- IN_STOCK | OUT_OF_STOCK | UNKNOWN — enum jako text, ne 0/1, protože
    -- „neznámo" je třetí legitimní stav, ne default k dostupnosti (R7).
    availability             TEXT    NOT NULL DEFAULT 'UNKNOWN',
    url                      TEXT    NOT NULL,

    -- SINGLE_INGREDIENT | COMPOSITE | SUPPLEMENT (ProductKind).
    kind                     TEXT    NOT NULL,

    -- JSON pole `IngredientComposition[]` — rozpad na suroviny s mírou
    -- jistoty (EXACT/DERIVED/PARTIAL/UNKNOWN). Prázdné pole = složení
    -- neznámé, NE „produkt je z ničeho".
    composition              TEXT    NOT NULL DEFAULT '[]',

    -- Součet `percentage` u složek EXACT/DERIVED (viz `accountedPct`
    -- v TutaniProduct.ts). Legitimně < 100, když jsou složky PARTIAL —
    -- to se má vidět, ne dopočítat na 100 (R7).
    composition_accounted_pct REAL   NOT NULL DEFAULT 0,

    -- JSON pole `AnalyticalValue[]` — hodnoty ze štítku výrobce,
    -- ZÁMĚRNĚ oddělené evidence od USDA nutrientů (Composition.ts).
    analytical               TEXT    NOT NULL DEFAULT '[]',

    -- JSON `ProductClaims` — věcná tvrzení z popisu (věková kategorie,
    -- dietní tvrzení), ne nutriční hodnota.
    claims                   TEXT    NOT NULL DEFAULT '{"rawDescriptionCs":null,"ageCategory":null,"dietaryClaimsCs":[]}',

    -- Plochý rozpad `Evidence` — zdroj+datum+jistota celého záznamu.
    evidence_source          TEXT    NOT NULL,
    evidence_source_date     TEXT    NOT NULL,
    evidence_confidence      TEXT    NOT NULL,
    evidence_note_cs         TEXT,

    updated_at               TEXT    NOT NULL,

    PRIMARY KEY (tenant_id, code)
);

-- Navigace datasetem podle pomocné kategorie (dashboard/report, ne engine).
CREATE INDEX IF NOT EXISTS idx_tutani_products_top_category
    ON tutani_products (tenant_id, top_category);

-- Kolik produktů je SINGLE_INGREDIENT vs. COMPOSITE vs. SUPPLEMENT —
-- potřeba při každém importu na kontrolu pokrytí datasetu (viz
-- PROGRESS_LOG „STAV DAT" sekce).
CREATE INDEX IF NOT EXISTS idx_tutani_products_kind
    ON tutani_products (tenant_id, kind);

-- ----------------------------------------------------------------------------
-- tutani_supplements — `Supplement` (src/domain/products/Supplement.ts).
--
-- Vlastní tabulka, NE řádek v `tutani_products` s `kind = 'SUPPLEMENT'`:
-- doplněk nemá `composition`/`analytical` v gramech masa, ale štítkovou
-- hodnotu na jiném základu (`%`, `mg/kg`, `IU/kg`) a jednotku i základ
-- musí přežít beze změny vedle odvozené (`declared` vs. `derived_per_100g`,
-- viz Supplement.ts hlavička). Natlačit to do `tutani_products.analytical`
-- by ztratilo přesně to rozlišení, které Lucky výslovně chtěl zachovat.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tutani_supplements (
    tenant_id                TEXT    NOT NULL,
    product_id               TEXT    NOT NULL,
    code                     TEXT    NOT NULL,
    name_cs                  TEXT    NOT NULL,
    brand                    TEXT,

    -- VITAMIN_MINERAL_PREMIX | EXTRUDED_SIDE_DISH | OIL | MINERAL_ASSAY | OTHER
    category                 TEXT    NOT NULL,

    -- JSON `DeclaredValue[]` — přesně jak na štítku (jednotka i základ
    -- beze změny). Nikdy needitovat na místě, viz `derived_per_100g`.
    declared                 TEXT    NOT NULL DEFAULT '[]',

    -- JSON `DerivedPer100g[]` — odvozeno z `declared` pro engine
    -- (`derivePer100g`), nikdy ruční vstup.
    derived_per_100g         TEXT    NOT NULL DEFAULT '[]',

    -- JSON `MarketingClaim[]` — textová tvrzení výrobce (zdravotní
    -- účinky, "obsahuje omega-3"…), ZÁMĚRNĚ oddělená od `declared`.
    -- Engine z nich NIKDY automaticky neodvodí nutriční hodnotu (viz
    -- Supplement.ts hlavička, příklad kelpa/Omegavet, Lucky 2026-09-09).
    marketing_claims         TEXT    NOT NULL DEFAULT '[]',

    -- JSON `SupplementIngredientList` nebo NULL — Tutani u příloh
    -- procenta neuvádí a systém je nevymýšlí (R7).
    ingredient_list          TEXT,

    -- JSON `MineralAssay[]` nebo NULL — oxidový rozbor (křemelina).
    -- NULL u všeho, co není minerální produkt evidovaný jako MINERAL_ASSAY.
    mineral_assay            TEXT,

    -- Text přesně jak výrobce uvádí (ne dopočet dávky).
    dosage_instruction_cs    TEXT,

    pack_grams               INTEGER,
    price_with_vat_czk       REAL,
    availability             TEXT    NOT NULL DEFAULT 'UNKNOWN',
    url                      TEXT    NOT NULL,

    -- Plochý rozpad `Supplement.evidence` (MANUFACTURER_LABEL |
    -- TUTANI_PRODUCT_PAGE, `confidence` je v typu vždy 'EXACT', ale
    -- sloupec zůstává textem, aby se DB schéma nemuselo měnit, pokud
    -- typ v budoucnu jistotu rozšíří).
    evidence_source          TEXT    NOT NULL,
    evidence_source_date     TEXT    NOT NULL,
    evidence_confidence      TEXT    NOT NULL,
    evidence_note_cs         TEXT,

    updated_at               TEXT    NOT NULL,

    PRIMARY KEY (tenant_id, code)
);

-- Navigace podle kategorie doplňku (premix/olej/příloha/minerál).
CREATE INDEX IF NOT EXISTS idx_tutani_supplements_category
    ON tutani_supplements (tenant_id, category);
