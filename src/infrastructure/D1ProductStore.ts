/**
 * Perzistence katalogu — rozhraní + implementace nad D1.
 *
 * PROČ ROZHRANÍ A NE PŘÍMÉ VOLÁNÍ `env.DB` (Lucky: modulární vrstvy,
 * žádné narušení jádra): API handlery ani sync nesmí znát SQL. Díky
 * tomu se dá
 *   - testovat handler s falešným storem, bez skutečné D1,
 *   - přenést katalog do Nexu výměnou implementace, ne přepisem
 *     enginu (tenant model, R4).
 *
 * MULTITENANCE: `tenantId` je parametr KAŽDÉ metody, ne stav objektu.
 * Nikde v téhle vrstvě není `if (tenant === 'tutani')` — dotaz je
 * vždy `WHERE tenant_id = ?`.
 */

import type { CompositionPart } from '../adapters/tutani-catalog/parseComposition.js';
import type { BarfGroup } from '../domain/tenant.js';
import type { CatalogProduct } from '../engine/product-matching/matchProducts.js';

/**
 * Produkt tak, jak se ukládá. Nadstavba nad `CatalogProduct` (co
 * potřebuje matching) o data pro audit a report klientovi.
 */
export interface StoredProduct extends Omit<CatalogProduct, 'packGrams'> {
    /**
     * PŘEPISUJE `CatalogProduct.packGrams` na nullable. Matching dostane
     * jen produkty s gramáží (`listUsable` je filtruje v SQL), ale
     * PERZISTENCE musí `null` unést — „gramáž se nedá zjistit" je
     * legitimní stav a produkt s ním má být v reportu pro klienta,
     * ne zahozený s vymyšlenou nulou (R7).
     */
    packGrams: number | null;
    categoryPath: string | null;
    packGramsSource: 'DATALAYER' | 'PARAM' | 'NAME' | 'RESOLVED_PRICE' | 'EXPORT' | null;
    stockQuantity: number | null;
    /** Rozpor v gramáži — uchovává se i po vyřešení, klient ho má opravit. */
    weightConflict: WeightConflictRecord | null;
    /** Kdy byla data přečtena z e-shopu. */
    sourceFeedAt: string | null;
    /**
     * Surovinu produktu nelze z názvu ani složení určit.
     *
     * `matchProducts` takový produkt u zadané alergie NEDOPORUČÍ
     * (fail-closed) — nikdy se netvrdí „neobsahuje alergen", jen
     * „nevíme, co obsahuje". Katalog tutani má složení jen u 17 %
     * produktů, takže tenhle stav je běžný, ne výjimečný.
     */
    ingredientsUnknown: boolean;
    /**
     * Má produkt varianty?
     *
     * Ukládá se kvůli `priceId`: u variantních produktů ho na detailu
     * přepisuje JS podle vybrané varianty, takže hodnota z HTML platí
     * jen pro výchozí. Autoritativní zdroj je pak `VARIANT id` ve
     * feedu (Lucky 2026-09-09). Dnes je `false` u všech 264 produktů
     * tutani; kdyby se objevilo `true`, je potřeba feed s hashem.
     */
    hasVariants: boolean;
    /**
     * Rozpad produktu na BARF složky podle procent ve složení
     * (`70% hovězí ořez, 30% droby`). Prázdné = produkt patří celý
     * do `group` podle kategorie.
     *
     * Zjištěno 2026-09-09: 9 produktů má víc složek a dosud se
     * počítaly celé do jedné skupiny — `kuře mleté s játry` je
     * 70 % MUSCLE + 30 % LIVER, což u hepatopatie (játra max 1 %)
     * dělá rozdíl.
     */
    compositionParts: CompositionPart[];
    /**
     * Rozpad na suroviny (úroveň INGREDIENT v `product_composition`).
     * Volitelné — starší kód a testy ho nevyplňují; chybí-li, zapíšou
     * se jen řádky BARF_GROUP.
     */
    ingredientBreakdown?: IngredientBreakdownRow[];
    /** guid ze Shoptetu — společný exportu i detailu. */
    guid?: string | null;
    /** U varianty kód hlavního produktu, jinak `null`. */
    parentCode?: string | null;
    /** Název varianty z tabulky na detailu. */
    variantName?: string | null;
    /** `false` = produkt je v adminu skrytý, do doporučení nevstupuje. */
    visible?: boolean;
    /** Kdy byla naposledy potvrzena skladová zásoba. */
    stockSyncedAt?: string | null;
}

/** Surovina produktu — řádek `product_composition` s `level = 'INGREDIENT'`. */
export interface IngredientBreakdownRow {
    ingredientId: string | null;
    /** Podíl v %, `null` = zdroj ho neuvádí (NEHÁDÁ se, R7). */
    pct: number | null;
    certainty: 'EXACT' | 'DETECTED';
    source: 'EXPORT_DESCRIPTION' | 'PRODUCT_PAGE' | 'CURATED' | 'NAME';
    sourceCs: string | null;
}

export interface StockState {
    sku: string;
    stockQuantity: number | null;
    visible: boolean;
}

/** Aktualizace skladu z 10minutového syncu — jen to, co se rychle mění. */
export interface StockUpdate {
    sku: string;
    stockQuantity: number;
    priceCzk: number | null;
    visible: boolean;
}

export interface WeightConflictRecord {
    authoritative: number;
    fromName: number;
    /** Co nakonec vyhrálo; `null` = nevyřešeno, produkt je nepoužitelný. */
    decidedGrams: number | null;
    source: 'AUTHORITATIVE' | 'NAME' | null;
    reasonCs: string;
}

/** Záznam o běhu synchronizace. Dry-run se loguje stejně jako ostrý běh. */
export interface SyncRunRecord {
    id: string;
    mode: 'DRY_RUN' | 'LIVE';
    triggerSource: 'CRON' | 'MANUAL' | 'API';
    startedAt: string;
    finishedAt: string | null;
    status: 'OK' | 'PARTIAL' | 'FAILED';
    urlsTotal: number;
    urlsFetched: number;
    urlsFailed: number;
    productsParsed: number;
    added: number;
    changed: number;
    unchanged: number;
    removed: number;
    unusable: number;
    /** JSON-serializovatelný souhrn. Nikdy celý katalog. */
    diffSummary?: unknown;
    errorText?: string | null;
}

export interface CatalogHealth {
    productCount: number;
    /** Kolik produktů reálně může vstoupit do doporučení. */
    usableCount: number;
    /** Nejnovější potvrzení skladu (10min sync). `null` = ještě neproběhl. */
    stockSyncedAt?: string | null;
    lastSync: SyncRunRecord | null;
}

/**
 * Kontrakt perzistence katalogu.
 *
 * Záměrně úzký: čtení po skupinách (co potřebuje matching), dávkový
 * zápis (co potřebuje sync) a audit. Žádné obecné `query` — jinak by
 * SQL prosáklo do handlerů.
 */
export interface ProductStore {
    /**
     * Produkty jedné BARF skupiny. `onlyUsable` vyfiltruje už v SQL to,
     * co do doporučení nemůže (bez gramáže, bez ceny) — engine pak
     * nedostane data, se kterými by musel hádat.
     */
    listByGroup(tenantId: string, group: BarfGroup, onlyUsable?: boolean): Promise<StoredProduct[]>;
    /** Celý použitelný katalog — jedno volání pro celý výpočet dávky. */
    listUsable(tenantId: string): Promise<StoredProduct[]>;
    /** Všechna SKU v katalogu — vstup pro diff synchronizace. */
    listAllSkus(tenantId: string): Promise<string[]>;
    /** Dávkový zápis. Vrací počet skutečně zapsaných řádků. */
    upsertMany(tenantId: string, products: StoredProduct[]): Promise<number>;
    /** Smaže produkty, které v e-shopu už nejsou. */
    deleteBySkus(tenantId: string, skus: string[]): Promise<number>;
    recordSyncRun(tenantId: string, run: SyncRunRecord): Promise<void>;
    /**
     * Rychlá aktualizace skladu a ceny (10min sync z exportu). Mění JEN
     * existující řádky — nový produkt přidává pouze plný sync, protože
     * bez detailu nemá `price_id` a do košíku by nešel vložit.
     * Vrací počet změněných řádků.
     */
    updateStock?(tenantId: string, updates: StockUpdate[], syncedAt: string): Promise<number>;
    /** Aktuální sklad všech produktů — vstup pro diff 10min syncu. */
    listStockState?(tenantId: string): Promise<StockState[]>;
    health(tenantId: string): Promise<CatalogHealth>;
}

/**
 * D1 má limit na počet vázaných parametrů v jednom dotazu (100)
 * a na velikost SQL.
 *
 * CHYBA NALEZENÁ AUDITEM 2026-09-09: konstanta říkala 16 sloupců,
 * ale SQL i `bind()` posílaly 18 → 18 × 6 = **108 parametrů**, tedy
 * nad limitem. Komentář tvrdil „96, pod limitem s rezervou", zatímco
 * skutečnost byla přes. Dávka se nesmí počítat z konstanty, kterou
 * někdo zapomene aktualizovat — proto se teď počet DERIVUJE ze
 * seznamu sloupců a `bind` se proti němu kontroluje.
 *
 * Zápis se posílá přes `batch()`, což je jedna transakce: sync buď
 * projde celý, nebo se katalog nezmění vůbec. Půlka katalogu by
 * znamenala doporučení z nekonzistentních dat.
 */
/**
 * Sloupce zápisu v PŘESNÉM pořadí, v jakém je posílá `productToBind`.
 * Jediný zdroj pravdy — z něj se generuje SQL i počet parametrů.
 */
const UPSERT_COLUMNS = [
    'tenant_id', 'sku', 'name', 'url', 'category_path', 'barf_group',
    'pack_grams', 'pack_grams_source', 'price_czk', 'price_id', 'product_id',
    'in_stock', 'stock_quantity', 'ingredients', 'ingredients_unknown',
    'is_cooked', 'has_variants', 'composition_parts', 'weight_conflict', 'source_feed_at', 'updated_at',
    'guid', 'parent_code', 'variant_name', 'visible', 'stock_synced_at',
] as const;

/**
 * Placeholdery jednoho řádku — GENEROVANÉ ze `UPSERT_COLUMNS`.
 *
 * CHYBA NALEZENÁ 2026-09-24: řetězec byl natvrdo s 18 `?`, zatímco
 * sloupců bylo 21. Testy běžely proti falešnému storu, takže to
 * neodhalily — ostrý zápis do D1 by spadl na „column count mismatch"
 * a noční sync by nezapsal ani jeden produkt. Teď test
 * `D1ProductStore.sqlite.test.ts` pouští skutečné SQL proti SQLite
 * se všemi migracemi.
 */
const ROW_PLACEHOLDERS = `(${UPSERT_COLUMNS.map(() => '?').join(', ')})`;

/** Sloupce `product_composition` — stejný princip jediného zdroje pravdy. */
const COMPOSITION_COLUMNS = [
    'tenant_id', 'sku', 'ordinal', 'level', 'barf_group', 'ingredient_id',
    'pct', 'certainty', 'source', 'source_cs', 'updated_at',
] as const;
const COMPOSITION_ROW_PLACEHOLDERS = `(${COMPOSITION_COLUMNS.map(() => '?').join(', ')})`;
const COMPOSITION_CHUNK = Math.max(1, Math.floor(96 / COMPOSITION_COLUMNS.length));

const COLUMNS_PER_PRODUCT = UPSERT_COLUMNS.length;
/** Skutečný limit D1 je 100; rezerva na jistotu. */
const MAX_BOUND_PARAMS = 96;
const UPSERT_CHUNK = Math.max(1, Math.floor(MAX_BOUND_PARAMS / COLUMNS_PER_PRODUCT));

/** Kolik SKU se vejde do jednoho `DELETE ... IN (?)`. */
const DELETE_CHUNK = 90;

const UPSERT_SQL_HEAD = `INSERT INTO products (\n    ${UPSERT_COLUMNS.join(', ')}\n) VALUES `;

/**
 * `ON CONFLICT` místo `DELETE` + `INSERT`: katalog nesmí být ani na
 * okamžik prázdný, protože ve stejnou chvíli může běžet dotaz
 * zákazníka. `updated_at` se nastavuje serverovým časem, ne z dat.
 */
/**
 * `ON CONFLICT` se generuje ze `UPSERT_COLUMNS` bez klíčových sloupců —
 * nový sloupec se tak nemůže zapomenout v UPDATE větvi.
 */
const UPSERT_SQL_TAIL = `
ON CONFLICT (tenant_id, sku) DO UPDATE SET
${UPSERT_COLUMNS.filter((c) => c !== 'tenant_id' && c !== 'sku')
    .map((c) => `    ${c} = excluded.${c}`)
    .join(',\n')}`;

/**
 * Použitelný produkt = má gramáž i cenu a gramáž je kladná.
 * Podmínka je TADY na jednom místě, ne rozkopírovaná po handlerech —
 * jinak by se za rok rozešla.
 */
const USABLE_CONDITION =
    'pack_grams IS NOT NULL AND pack_grams > 0 AND price_czk IS NOT NULL AND visible = 1' +
    // Košík potřebuje OBĚ id (Lucky 2026-09-24) — bez nich produkt nejde koupit.
    " AND price_id IS NOT NULL AND price_id <> '' AND product_id IS NOT NULL AND product_id <> ''";

export class D1ProductStore implements ProductStore {
    constructor(private readonly db: D1Database) {}

    async listByGroup(
        tenantId: string,
        group: BarfGroup,
        onlyUsable = true
    ): Promise<StoredProduct[]> {
        const sql =
            `SELECT * FROM products WHERE tenant_id = ? AND barf_group = ?` +
            (onlyUsable ? ` AND ${USABLE_CONDITION}` : '') +
            // Deterministické řazení už z databáze — engine na něj sice
            // nespoléhá (řadí si sám), ale reprodukovatelnost výsledku
            // začíná u vstupu.
            ` ORDER BY sku`;
        const res = await this.db.prepare(sql).bind(tenantId, group).all();
        return (res.results ?? []).map(rowToProduct);
    }

    async listUsable(tenantId: string): Promise<StoredProduct[]> {
        const res = await this.db
            .prepare(
                `SELECT * FROM products WHERE tenant_id = ? AND ${USABLE_CONDITION} ORDER BY sku`
            )
            .bind(tenantId)
            .all();
        return (res.results ?? []).map(rowToProduct);
    }

    async listAllSkus(tenantId: string): Promise<string[]> {
        const res = await this.db
            .prepare('SELECT sku FROM products WHERE tenant_id = ? ORDER BY sku')
            .bind(tenantId)
            .all<{ sku: string }>();
        return (res.results ?? []).map((r) => r.sku);
    }

    async upsertMany(tenantId: string, products: StoredProduct[]): Promise<number> {
        if (products.length === 0) return 0;

        const now = new Date().toISOString();
        const statements: D1PreparedStatement[] = [];

        for (let i = 0; i < products.length; i += UPSERT_CHUNK) {
            const chunk = products.slice(i, i + UPSERT_CHUNK);
            const placeholders = chunk.map(() => ROW_PLACEHOLDERS).join(', ');
            const binds: (string | number | null)[] = [];
            for (const p of chunk) {
                const row = productToBinds(tenantId, p, now);
                // Pojistka proti návratu chyby z 2026-09-24: počet hodnot
                // musí přesně sedět na sloupce, jinak se nic neposílá.
                if (row.length !== COLUMNS_PER_PRODUCT) {
                    throw new Error(
                        `productToBinds vrací ${row.length} hodnot, sloupců je ${COLUMNS_PER_PRODUCT}`
                    );
                }
                binds.push(...row);
            }
            statements.push(
                this.db.prepare(UPSERT_SQL_HEAD + placeholders + UPSERT_SQL_TAIL).bind(...binds)
            );
        }

        /**
         * Rozpad se přepisuje CELÝ pro zapsaná SKU (smazat + vložit) ve
         * STEJNÉ transakci jako produkty. Rozpad a produkt se tak nikdy
         * nerozejdou — ani na okamžik, ani po pádu uprostřed.
         */
        const compositionRows: (string | number | null)[][] = [];
        for (const p of products) compositionRows.push(...compositionToRows(tenantId, p, now));

        for (let i = 0; i < products.length; i += DELETE_CHUNK) {
            const skus = products.slice(i, i + DELETE_CHUNK).map((p) => p.sku);
            statements.push(
                this.db
                    .prepare(
                        `DELETE FROM product_composition WHERE tenant_id = ? AND sku IN (${skus.map(() => '?').join(', ')})`
                    )
                    .bind(tenantId, ...skus)
            );
        }
        for (let i = 0; i < compositionRows.length; i += COMPOSITION_CHUNK) {
            const chunk = compositionRows.slice(i, i + COMPOSITION_CHUNK);
            statements.push(
                this.db
                    .prepare(
                        `INSERT INTO product_composition (${COMPOSITION_COLUMNS.join(', ')}) VALUES ` +
                            chunk.map(() => COMPOSITION_ROW_PLACEHOLDERS).join(', ')
                    )
                    .bind(...chunk.flat())
            );
        }

        // Jedna transakce pro celý zápis — konzistentní katalog nebo žádná změna.
        const results = await this.db.batch(statements);
        // Počítají se jen řádky produktů, ne rozpadu — volající chce vědět,
        // kolik produktů se zapsalo.
        return results
            .slice(0, Math.ceil(products.length / UPSERT_CHUNK))
            .reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
    }

    async updateStock(tenantId: string, updates: StockUpdate[], syncedAt: string): Promise<number> {
        if (updates.length === 0) return 0;
        /**
         * `price_czk` se přepíše jen když export cenu má (COALESCE) —
         * chybějící cena v exportu nesmí vynulovat známou cenu.
         */
        const stmt = this.db.prepare(
            `UPDATE products
                SET stock_quantity = ?, in_stock = ?, price_czk = COALESCE(?, price_czk),
                    visible = ?, stock_synced_at = ?
              WHERE tenant_id = ? AND sku = ?`
        );
        const statements = updates.map((u) =>
            stmt.bind(
                u.stockQuantity,
                u.stockQuantity > 0 ? 1 : 0,
                u.priceCzk,
                u.visible ? 1 : 0,
                syncedAt,
                tenantId,
                u.sku
            )
        );
        const results = await this.db.batch(statements);
        return results.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
    }

    async listStockState(tenantId: string): Promise<StockState[]> {
        const res = await this.db
            .prepare('SELECT sku, stock_quantity, visible FROM products WHERE tenant_id = ? ORDER BY sku')
            .bind(tenantId)
            .all<{ sku: string; stock_quantity: number | null; visible: number | null }>();
        return (res.results ?? []).map((r) => ({
            sku: String(r.sku),
            stockQuantity: r.stock_quantity === null ? null : Number(r.stock_quantity),
            visible: r.visible === null ? true : Number(r.visible) === 1,
        }));
    }

    async deleteBySkus(tenantId: string, skus: string[]): Promise<number> {
        if (skus.length === 0) return 0;
        const statements: D1PreparedStatement[] = [];
        for (let i = 0; i < skus.length; i += DELETE_CHUNK) {
            const chunk = skus.slice(i, i + DELETE_CHUNK);
            const q = chunk.map(() => '?').join(', ');
            statements.push(
                this.db
                    .prepare(`DELETE FROM products WHERE tenant_id = ? AND sku IN (${q})`)
                    .bind(tenantId, ...chunk)
            );
            statements.push(
                this.db
                    .prepare(`DELETE FROM product_composition WHERE tenant_id = ? AND sku IN (${q})`)
                    .bind(tenantId, ...chunk)
            );
        }
        const results = await this.db.batch(statements);
        // Liché příkazy jsou rozpad — do počtu smazaných produktů nepatří.
        return results
            .filter((_, i) => i % 2 === 0)
            .reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
    }

    async recordSyncRun(tenantId: string, run: SyncRunRecord): Promise<void> {
        await this.db
            .prepare(
                `INSERT INTO sync_runs (
                    id, tenant_id, mode, trigger_source, started_at, finished_at, status,
                    urls_total, urls_fetched, urls_failed, products_parsed,
                    added, changed, unchanged, removed, unusable,
                    diff_summary, error_text
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
                run.id,
                tenantId,
                run.mode,
                run.triggerSource,
                run.startedAt,
                run.finishedAt,
                run.status,
                run.urlsTotal,
                run.urlsFetched,
                run.urlsFailed,
                run.productsParsed,
                run.added,
                run.changed,
                run.unchanged,
                run.removed,
                run.unusable,
                run.diffSummary === undefined ? null : JSON.stringify(run.diffSummary),
                run.errorText ?? null
            )
            .run();
    }

    async health(tenantId: string): Promise<CatalogHealth> {
        const counts = await this.db
            .prepare(
                `SELECT COUNT(*) AS total,
                        SUM(CASE WHEN ${USABLE_CONDITION} THEN 1 ELSE 0 END) AS usable,
                        MAX(stock_synced_at) AS stock_synced_at
                 FROM products WHERE tenant_id = ?`
            )
            .bind(tenantId)
            .first<{ total: number; usable: number | null; stock_synced_at: string | null }>();

        // Poslední OSTRÝ běh — dry-run o stavu katalogu nic neříká.
        const last = await this.db
            .prepare(
                `SELECT * FROM sync_runs
                 WHERE tenant_id = ? AND mode = 'LIVE'
                 ORDER BY started_at DESC LIMIT 1`
            )
            .bind(tenantId)
            .first();

        return {
            productCount: counts?.total ?? 0,
            usableCount: counts?.usable ?? 0,
            stockSyncedAt: counts?.stock_synced_at ?? null,
            lastSync: last ? rowToSyncRun(last) : null,
        };
    }
}

/** Řádek D1 → produkt. Nezpracované JSON pole nesmí shodit celý dotaz. */
function rowToProduct(row: Record<string, unknown>): StoredProduct {
    return {
        sku: String(row.sku),
        name: String(row.name ?? ''),
        url: row.url === null || row.url === undefined ? '' : String(row.url),
        categoryPath: row.category_path === null ? null : String(row.category_path ?? ''),
        priceCzk: Number(row.price_czk ?? 0),
        packGrams: Number(row.pack_grams ?? 0),
        packGramsSource: (row.pack_grams_source as StoredProduct['packGramsSource']) ?? null,
        group: (row.barf_group as BarfGroup) ?? 'OTHER',
        inStock: Number(row.in_stock ?? 0) === 1,
        stockQuantity: row.stock_quantity === null ? null : Number(row.stock_quantity),
        productId: row.product_id === null ? null : String(row.product_id ?? ''),
        priceId: row.price_id === null ? null : String(row.price_id ?? ''),
        ingredientIds: parseJsonArray(row.ingredients),
        isCooked: Number(row.is_cooked ?? 0) === 1,
        weightConflict: parseJsonObject<WeightConflictRecord>(row.weight_conflict),
        sourceFeedAt: row.source_feed_at === null ? null : String(row.source_feed_at ?? ''),
        /**
         * Chybějící sloupec (starší schéma) se čte jako „suroviny
         * neznáme" — bezpečnější strana: produkt se u zadané alergie
         * vyřadí, místo aby se tvářil jako bezpečný.
         */
        ingredientsUnknown:
            row.ingredients_unknown === undefined || row.ingredients_unknown === null
                ? true
                : Number(row.ingredients_unknown) === 1,
        hasVariants: Number(row.has_variants ?? 0) === 1,
        compositionParts: parseCompositionPartsJson(row.composition_parts),
        guid: row.guid === null || row.guid === undefined ? null : String(row.guid),
        parentCode:
            row.parent_code === null || row.parent_code === undefined ? null : String(row.parent_code),
        variantName:
            row.variant_name === null || row.variant_name === undefined ? null : String(row.variant_name),
        visible: row.visible === undefined || row.visible === null ? true : Number(row.visible) === 1,
        stockSyncedAt:
            row.stock_synced_at === null || row.stock_synced_at === undefined
                ? null
                : String(row.stock_synced_at),
    };
}

/**
 * Rozpad produktu → řádky `product_composition`.
 *
 * BARF_GROUP: z `compositionParts` (procenta ze složení). Bez nich jeden
 * řádek 100 % podle kategorie s `certainty = 'CATEGORY'` — je vidět, že
 * rozpad je jen předpoklad z kategorie, ne zjištěné složení.
 *
 * INGREDIENT: z `ingredientBreakdown`, jinak z `ingredientIds`
 * (poznané z názvu/popisu, podíl neznámý → `pct = NULL`).
 */
function compositionToRows(
    tenantId: string,
    p: StoredProduct,
    now: string
): (string | number | null)[][] {
    const rows: (string | number | null)[][] = [];
    let ordinal = 0;

    if (p.compositionParts.length > 0) {
        for (const part of p.compositionParts) {
            rows.push([
                tenantId, p.sku, ordinal++, 'BARF_GROUP', part.group, null,
                part.pct, 'EXACT', 'EXPORT_DESCRIPTION', part.sourceCs, now,
            ]);
        }
    } else {
        rows.push([
            tenantId, p.sku, ordinal++, 'BARF_GROUP', p.group, null,
            100, 'CATEGORY', 'CATEGORY', p.categoryPath, now,
        ]);
    }

    const ingredients: IngredientBreakdownRow[] =
        p.ingredientBreakdown && p.ingredientBreakdown.length > 0
            ? p.ingredientBreakdown
            : (p.ingredientIds ?? []).map((id) => ({
                  ingredientId: id,
                  pct: null,
                  certainty: 'DETECTED' as const,
                  source: 'NAME' as const,
                  sourceCs: null,
              }));
    for (const ing of ingredients) {
        rows.push([
            tenantId, p.sku, ordinal++, 'INGREDIENT', null, ing.ingredientId,
            ing.pct, ing.certainty, ing.source, ing.sourceCs, now,
        ]);
    }
    return rows;
}

function productToBinds(
    tenantId: string,
    p: StoredProduct,
    now: string
): (string | number | null)[] {
    return [
        tenantId,
        p.sku,
        p.name,
        p.url || null,
        p.categoryPath,
        p.group,
        p.packGrams,
        p.packGramsSource,
        p.priceCzk,
        p.priceId,
        p.productId,
        p.inStock ? 1 : 0,
        p.stockQuantity,
        JSON.stringify(p.ingredientIds ?? []),
        p.ingredientsUnknown ? 1 : 0,
        p.isCooked ? 1 : 0,
        p.hasVariants ? 1 : 0,
        JSON.stringify(p.compositionParts ?? []),
        p.weightConflict ? JSON.stringify(p.weightConflict) : null,
        p.sourceFeedAt,
        now,
        p.guid ?? null,
        p.parentCode ?? null,
        p.variantName ?? null,
        p.visible === false ? 0 : 1,
        p.stockSyncedAt ?? null,
    ];
}

function rowToSyncRun(row: Record<string, unknown>): SyncRunRecord {
    return {
        id: String(row.id),
        mode: row.mode as SyncRunRecord['mode'],
        triggerSource: row.trigger_source as SyncRunRecord['triggerSource'],
        startedAt: String(row.started_at),
        finishedAt: row.finished_at === null ? null : String(row.finished_at),
        status: row.status as SyncRunRecord['status'],
        urlsTotal: Number(row.urls_total ?? 0),
        urlsFetched: Number(row.urls_fetched ?? 0),
        urlsFailed: Number(row.urls_failed ?? 0),
        productsParsed: Number(row.products_parsed ?? 0),
        added: Number(row.added ?? 0),
        changed: Number(row.changed ?? 0),
        unchanged: Number(row.unchanged ?? 0),
        removed: Number(row.removed ?? 0),
        unusable: Number(row.unusable ?? 0),
        diffSummary: parseJsonObject<unknown>(row.diff_summary) ?? undefined,
        errorText: row.error_text === null ? null : String(row.error_text ?? ''),
    };
}

/**
 * Poškozený JSON v jednom řádku nesmí shodit celý katalog — vrátí se
 * prázdno a produkt prostě nemá vyplněné suroviny. Chyba je čitelná
 * v logu, ne v podobě 500 pro zákazníka (observabilita).
 */
/**
 * Rozpad na složky z JSONu. Poškozený nebo cizí tvar se zahodí —
 * produkt pak platí celý do své `group` podle kategorie, což je
 * bezpečný default.
 */
function parseCompositionPartsJson(raw: unknown): CompositionPart[] {
    if (typeof raw !== 'string' || raw.length === 0) return [];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (x): x is CompositionPart =>
                x !== null &&
                typeof x === 'object' &&
                typeof (x as CompositionPart).group === 'string' &&
                typeof (x as CompositionPart).pct === 'number' &&
                Number.isFinite((x as CompositionPart).pct)
        );
    } catch {
        return [];
    }
}

function parseJsonArray(raw: unknown): string[] {
    if (typeof raw !== 'string' || raw.length === 0) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
    } catch {
        console.warn(JSON.stringify({ level: 'warn', event: 'products.ingredients_json_invalid', raw }));
        return [];
    }
}

function parseJsonObject<T>(raw: unknown): T | null {
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        console.warn(JSON.stringify({ level: 'warn', event: 'products.json_invalid', raw }));
        return null;
    }
}
