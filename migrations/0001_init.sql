-- ============================================================================
-- 0001_init — produktová vrstva katalogu a audit synchronizací
--
-- ROZSAH: TATO migrace pokrývá jen KATALOG (§3 ARCHITEKTURA.md) a audit
-- běhů syncu. Znalostní vrstva (`conditions`, `condition_rules`,
-- `ingredients`, `dose_matrix`, `composition_profile` — §2) žije dnes
-- v JSON rulesetech v `tenants/*/rules/` a do D1 se přenese teprve,
-- až ji bude spravovat admin. Do té doby by prázdné tabulky jen lhaly
-- o tom, kde je zdroj pravdy.
--
-- MULTITENANCE (R4): každý řádek nese `tenant_id`. Worker nikdy
-- nerozhoduje podle jména klienta — filtruje podle `tenant_id`
-- z konfigurace. Druhý Shoptet klient je nový řádek, ne nový kód.
--
-- CO SE ZÁMĚRNĚ NEUKLÁDÁ: `fat_pct` a `is_ground_bone` z §3 tady
-- nejsou. Katalog Tutani ta data nenese (ověřeno dry-runem 2026-09-08,
-- blokátor B6) a sloupec, který je vždy NULL, jen předstírá, že je
-- systém umí — nehádá se (R7). Přidají se, až je klient doplní.
-- ============================================================================

CREATE TABLE IF NOT EXISTS products (
    tenant_id         TEXT    NOT NULL,
    sku               TEXT    NOT NULL,
    name              TEXT    NOT NULL,
    url               TEXT,
    category_path     TEXT,

    -- MUSCLE | BONE | LIVER | ORGAN | PLANT | SUPPLEMENT | OTHER
    -- OTHER = nezařazeno, do doporučení nevstupuje.
    barf_group        TEXT    NOT NULL DEFAULT 'OTHER',

    -- NULL je LEGITIMNÍ stav: gramáž se nikde nedá přečíst. Produkt se
    -- do doporučení nedostane a systém to přizná (R7).
    pack_grams        INTEGER,
    -- DATALAYER | PARAM | NAME | RESOLVED_PRICE — odkud gramáž je.
    -- Bez toho se při reklamaci nedá dohledat, proč se počítalo z 1 kg.
    pack_grams_source TEXT,

    price_czk         REAL,
    -- Pro vložení do košíku Shoptetu (`/action/Cart/addCartItem/`).
    price_id          TEXT,
    product_id        TEXT,

    in_stock          INTEGER NOT NULL DEFAULT 0,
    stock_quantity    INTEGER,

    -- JSON pole id surovin. Filtr alergií se dělá v enginu, ne v SQL —
    -- D1 nemá spolehlivé JSON operátory pro `IN` nad polem.
    ingredients       TEXT    NOT NULL DEFAULT '[]',

    -- Surovinu nelze z názvu ani složení určit. DEFAULT 1 = neznáme:
    -- u zadané alergie se takový produkt NEDOPORUČÍ (fail-closed).
    -- Bezpečnější je vyřadit než tvrdit, že produkt alergen neobsahuje
    -- (nález auditu 2026-09-09 — dřív se `ingredients` ukládalo jako
    -- prázdné pole a filtr alergií neměl na čem pracovat).
    ingredients_unknown INTEGER NOT NULL DEFAULT 1,

    -- Vařené kosti se NIKDY nedoporučují (§7, §9 zadání). Tvrdý filtr
    -- je v enginu; tady je jen zdroj dat.
    is_cooked         INTEGER NOT NULL DEFAULT 0,

    -- Má produkt varianty? U variantních produktů platí `price_id`
    -- z HTML jen pro výchozí variantu — autoritativní je `VARIANT id`
    -- ve feedu (Lucky 2026-09-09). Dnes 0 u všech 264 produktů tutani.
    has_variants      INTEGER NOT NULL DEFAULT 0,

    -- JSON `{authoritative, fromName, decidedGrams, source, reasonCs}`
    -- nebo NULL. Uchovává se, i když je rozpor vyřešen — je to chyba
    -- v datech e-shopu, kterou má klient opravit, a report ji čerpá odsud.
    weight_conflict   TEXT,

    -- Kdy byla data přečtena z e-shopu vs. kdy se zapsal řádek.
    source_feed_at    TEXT,
    updated_at        TEXT    NOT NULL,

    PRIMARY KEY (tenant_id, sku)
);

-- Hlavní dotaz matchingu: produkty jedné složky, které jsou skladem.
-- `pack_grams` v indexu, protože produkty bez gramáže se filtrují
-- rovnou v dotazu, ne až v paměti.
CREATE INDEX IF NOT EXISTS idx_products_group_stock
    ON products (tenant_id, barf_group, in_stock, pack_grams);

-- Report pro klienta: co je rozporuplné nebo nepoužitelné.
CREATE INDEX IF NOT EXISTS idx_products_conflict
    ON products (tenant_id, weight_conflict)
    WHERE weight_conflict IS NOT NULL;

-- ----------------------------------------------------------------------------
-- category_map — kategorie e-shopu → složka BARF dávky.
--
-- Dnes je zdroj pravdy `tenants/tutani/config/tenant.ts` (typová
-- kontrola při buildu). Tabulka existuje proto, aby klient mohl
-- zařazení přepsat BEZ DEPLOYE — což je přesně to, co §9 blokátor B3
-- (rozdělení vnitřností na LIVER a ORGAN) potřebuje. Řádek tady
-- PŘEBIJE konfiguraci v kódu.
--
-- `priority` rozhoduje pořadí: nižší číslo se vyhodnocuje dřív, aby
-- „játra" trefila dřív než obecné „vnitrnosti".
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS category_map (
    tenant_id       TEXT    NOT NULL,
    match_text      TEXT    NOT NULL,
    barf_group      TEXT    NOT NULL,
    priority        INTEGER NOT NULL DEFAULT 100,
    -- 0 = shoda se hledá v cestě kategorie, 1 = i v názvu produktu.
    match_name_too  INTEGER NOT NULL DEFAULT 0,
    note_cs         TEXT,
    updated_at      TEXT    NOT NULL,
    PRIMARY KEY (tenant_id, match_text)
);

-- ----------------------------------------------------------------------------
-- sync_runs — audit synchronizací.
--
-- Bez tohohle se po měsíci nedá říct, kdy katalog naposledy prošel
-- a proč zmizel produkt z doporučení. `GET /v1/health` čte odsud.
--
-- Dry-run běhy se ukládají TAKY (`mode = 'DRY_RUN'`) — schválený diff
-- musí být dohledatelný, ne jen vypsaný do konzole.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_runs (
    id                TEXT    PRIMARY KEY,
    tenant_id         TEXT    NOT NULL,
    -- DRY_RUN | LIVE
    mode              TEXT    NOT NULL,
    -- CRON | MANUAL | API
    trigger_source    TEXT    NOT NULL,
    started_at        TEXT    NOT NULL,
    finished_at       TEXT,
    -- OK | PARTIAL | FAILED — PARTIAL = část URL selhala, ale zbytek
    -- se zapsal. Rozdíl je podstatný: PARTIAL katalog není neplatný.
    status            TEXT    NOT NULL,

    urls_total        INTEGER NOT NULL DEFAULT 0,
    urls_fetched      INTEGER NOT NULL DEFAULT 0,
    urls_failed       INTEGER NOT NULL DEFAULT 0,
    products_parsed   INTEGER NOT NULL DEFAULT 0,

    added             INTEGER NOT NULL DEFAULT 0,
    changed           INTEGER NOT NULL DEFAULT 0,
    unchanged         INTEGER NOT NULL DEFAULT 0,
    removed           INTEGER NOT NULL DEFAULT 0,
    -- Produkty bez gramáže nebo s nevyřešeným rozporem — nevstoupí
    -- do doporučení a klient je má vidět.
    unusable          INTEGER NOT NULL DEFAULT 0,

    -- JSON souhrn diffu (vzorek změn + agregace). Nikdy celý katalog:
    -- řádek v D1 má limit a audit není záloha.
    diff_summary      TEXT,
    -- Čitelná chyba, ne stack trace do prázdna (observabilita).
    error_text        TEXT
);

-- „Kdy naposled proběhl sync" pro `/v1/health`.
CREATE INDEX IF NOT EXISTS idx_sync_runs_tenant_started
    ON sync_runs (tenant_id, started_at DESC);
