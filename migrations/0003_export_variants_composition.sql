-- ============================================================================
-- 0003_export_variants_composition — produktová DB napojená na admin export
-- Shoptetu, varianty jako samostatné řádky a rozpad každého produktu.
--
-- ROZHODNUTÍ (Lucky 2026-09-24): katalog v D1 je JEDINÝ zdroj pravdy pro
-- výběr produktů — včetně `price_id`, `product_id`, aktuální skladové
-- zásoby a rozpadu na složky. Konfigurátor musí vždy pracovat s tím, co je
-- MOMENTÁLNĚ skladem, a rozkládat doporučení po celém sortimentu.
--
-- ZDROJE HODNOT (zapisuje se do `*_source`, aby šlo při reklamaci dohledat):
--   admin XLSX export  → gramáž (`packageAmount`), sklad, cena, složení, guid
--   detail produktu    → `product_id`, `price_id` (u variant z řádku tabulky)
--
-- VARIANTY: každá varianta je vlastní řádek s vlastním SKU (`1066/500`)
-- a vlastním `price_id`. `parent_code` je spojuje pro zobrazení; výběr
-- produktů s nimi pracuje jako s běžnými produkty (jiná gramáž = jiné
-- balení).
--
-- NIC SE NEMAŽE: jen ADD COLUMN a nová tabulka. Rollback = sloupce
-- ignorovat (starý kód je nečte) a `DROP TABLE product_composition`.
-- ============================================================================

-- guid je společný exportu i detailu — záložní klíč párování, když by se
-- kód produktu v adminu přejmenoval.
ALTER TABLE products ADD COLUMN guid TEXT;

-- U varianty kód hlavního produktu (skupina variant), jinak NULL.
ALTER TABLE products ADD COLUMN parent_code TEXT;

-- Název varianty z tabulky na detailu („Pivovarské kvasnice: 1 kg").
ALTER TABLE products ADD COLUMN variant_name TEXT;

-- Kdy byla naposledy potvrzena skladová zásoba (10min stock sync).
-- Výběr produktů podle ní pozná, že data o skladu zestárla.
ALTER TABLE products ADD COLUMN stock_synced_at TEXT;

-- 0 = produkt je v adminu skrytý. Do doporučení nevstupuje.
ALTER TABLE products ADD COLUMN visible INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_products_guid ON products (tenant_id, guid);
CREATE INDEX IF NOT EXISTS idx_products_parent ON products (tenant_id, parent_code)
    WHERE parent_code IS NOT NULL;

-- ----------------------------------------------------------------------------
-- product_composition — rozpad produktu po řádcích.
--
-- Dvě úrovně v jedné tabulce (`level`):
--   BARF_GROUP  — podíl složky dávky (MUSCLE/BONE/LIVER/ORGAN/PLANT/…).
--                 Z toho se určuje, které produkty jsou rovnocenná náhrada.
--   INGREDIENT  — surovina (kuřecí, hovězí, losos…) pro filtr alergií
--                 a nutriční výpočet. `pct` je NULL, když ho zdroj neuvádí.
--
-- `certainty`:
--   EXACT     — procento výslovně v textu složení / kurátorských datech
--   CATEGORY  — produkt bez rozpadu, celý přiřazen podle kategorie
--   DETECTED  — surovina poznaná z názvu/popisu, podíl neznámý
--
-- Proč tabulka a ne JSON sloupec: dotaz „které produkty skladem obsahují
-- játra" nebo „čím nahradit klokana" musí jít udělat v SQL a v reportu
-- pro klienta, ne jen v paměti Workeru.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS product_composition (
    tenant_id      TEXT    NOT NULL,
    sku            TEXT    NOT NULL,
    ordinal        INTEGER NOT NULL,
    -- BARF_GROUP | INGREDIENT
    level          TEXT    NOT NULL,
    barf_group     TEXT,
    ingredient_id  TEXT,
    pct            REAL,
    -- EXACT | CATEGORY | DETECTED
    certainty      TEXT    NOT NULL,
    -- EXPORT_DESCRIPTION | PRODUCT_PAGE | CURATED | CATEGORY | NAME
    source         TEXT    NOT NULL,
    source_cs      TEXT,
    updated_at     TEXT    NOT NULL,
    PRIMARY KEY (tenant_id, sku, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_composition_group
    ON product_composition (tenant_id, level, barf_group);
CREATE INDEX IF NOT EXISTS idx_composition_ingredient
    ON product_composition (tenant_id, ingredient_id)
    WHERE ingredient_id IS NOT NULL;
