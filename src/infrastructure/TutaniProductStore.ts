/**
 * Perzistence nutriční vrstvy (`TutaniProduct`, `Supplement`) nad D1.
 *
 * PROČ SAMOSTATNÝ STORE, NE ROZŠÍŘENÍ `D1ProductStore` (NON-INTERFERENCE):
 * `D1ProductStore`/`products` je BarfGroup-level matching engine v ostrém
 * provozu (0001_init.sql). Tenhle store čte a zapisuje jen nové tabulky
 * `tutani_products`/`tutani_supplements` z 0002_tutani_products.sql —
 * ingredient-level nutriční vrstvu. Otestovaný kód se nemění, nová vrstva
 * vzniká vedle něj (viz DECISION komentář v migraci).
 *
 * STEJNÝ STYL jako `D1ProductStore`: rozhraní odděluje SQL od handlerů,
 * `tenantId` je parametr každé metody (multitenance, R4), prepared
 * statements, JSON.stringify/parse pro JSON sloupce, try/catch s čitelnými
 * chybami (observabilita — structured log, ne stack trace do prázdna).
 */

import type {
    TutaniProduct,
    ProductKind,
} from '../domain/products/TutaniProduct.js';
import type {
    IngredientComposition,
    AnalyticalValue,
    ProductClaims,
    Evidence,
} from '../domain/products/Composition.js';
import type {
    Supplement,
    DeclaredValue,
    DerivedPer100g,
    MarketingClaim,
    SupplementIngredientList,
    MineralAssay,
    SupplementCategory,
} from '../domain/products/Supplement.js';

/**
 * `TutaniProduct` tak, jak se ukládá — DB row shape 1:1 s doménovým
 * typem (na rozdíl od `StoredProduct` v `D1ProductStore.ts` tu není
 * potřeba žádná dodatečná nadstavba, nutriční vrstva nic dalšího
 * neukládá navíc).
 */
export type StoredTutaniProduct = TutaniProduct;

/** `Supplement` tak, jak se ukládá — DB row shape 1:1 s doménovým typem. */
export type StoredSupplement = Supplement;

/**
 * Volitelný filtr pro `listProducts` — čtení podle pomocné kategorie
 * nebo druhu produktu. Záměrně úzké (žádné obecné `where`), stejný
 * duch jako `ProductStore.listByGroup` v `D1ProductStore.ts`: SQL
 * nesmí prosáknout do handlerů.
 */
export interface TutaniProductFilter {
    topCategory?: TutaniProduct['topCategory'];
    kind?: ProductKind;
}

/**
 * Kontrakt perzistence nutriční vrstvy. Záměrně úzký — čtení jednoho
 * záznamu (co potřebuje výpočet dávky pro konkrétní produkt), výpis
 * s volitelným filtrem (report/import) a upsert jednoho záznamu
 * (import z USDA/Tutani je řízený a auditovaný krok, ne dávkový sync
 * jako u `products`, takže dávkový upsert tu zatím není potřeba).
 */
export interface TutaniProductStore {
    upsertProduct(tenantId: string, product: StoredTutaniProduct): Promise<void>;
    upsertSupplement(tenantId: string, supplement: StoredSupplement): Promise<void>;
    getProduct(tenantId: string, code: string): Promise<StoredTutaniProduct | null>;
    getSupplement(tenantId: string, code: string): Promise<StoredSupplement | null>;
    listProducts(tenantId: string, filter?: TutaniProductFilter): Promise<StoredTutaniProduct[]>;
    listSupplements(tenantId: string): Promise<StoredSupplement[]>;
}

export class D1TutaniProductStore implements TutaniProductStore {
    constructor(private readonly db: D1Database) {}

    async upsertProduct(tenantId: string, product: StoredTutaniProduct): Promise<void> {
        try {
            const now = new Date().toISOString();
            await this.db
                .prepare(
                    `INSERT INTO tutani_products (
                        tenant_id, product_id, code, name_cs, brand, category_path,
                        top_category, price_with_vat_czk, pack_grams, availability, url,
                        kind, composition, composition_accounted_pct, analytical, claims,
                        evidence_source, evidence_source_date, evidence_confidence, evidence_note_cs,
                        updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (tenant_id, code) DO UPDATE SET
                        product_id = excluded.product_id,
                        name_cs = excluded.name_cs,
                        brand = excluded.brand,
                        category_path = excluded.category_path,
                        top_category = excluded.top_category,
                        price_with_vat_czk = excluded.price_with_vat_czk,
                        pack_grams = excluded.pack_grams,
                        availability = excluded.availability,
                        url = excluded.url,
                        kind = excluded.kind,
                        composition = excluded.composition,
                        composition_accounted_pct = excluded.composition_accounted_pct,
                        analytical = excluded.analytical,
                        claims = excluded.claims,
                        evidence_source = excluded.evidence_source,
                        evidence_source_date = excluded.evidence_source_date,
                        evidence_confidence = excluded.evidence_confidence,
                        evidence_note_cs = excluded.evidence_note_cs,
                        updated_at = excluded.updated_at`
                )
                .bind(
                    tenantId,
                    product.productId,
                    product.code,
                    product.nameCs,
                    product.brand,
                    product.categoryPath,
                    product.topCategory,
                    product.priceWithVatCzk,
                    product.packGrams,
                    product.availability,
                    product.url,
                    product.kind,
                    JSON.stringify(product.composition ?? []),
                    product.compositionAccountedPct,
                    JSON.stringify(product.analytical ?? []),
                    JSON.stringify(product.claims),
                    product.evidence.source,
                    product.evidence.sourceDate,
                    product.evidence.confidence,
                    product.evidence.noteCs ?? null,
                    now
                )
                .run();
        } catch (err) {
            throw new Error(
                `TutaniProductStore.upsertProduct selhal (tenant=${tenantId}, code=${product.code}): ${describeError(err)}`
            );
        }
    }

    async upsertSupplement(tenantId: string, supplement: StoredSupplement): Promise<void> {
        try {
            const now = new Date().toISOString();
            await this.db
                .prepare(
                    `INSERT INTO tutani_supplements (
                        tenant_id, product_id, code, name_cs, brand, category,
                        declared, derived_per_100g, marketing_claims, ingredient_list, mineral_assay,
                        dosage_instruction_cs, pack_grams, price_with_vat_czk, availability, url,
                        evidence_source, evidence_source_date, evidence_confidence, evidence_note_cs,
                        updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT (tenant_id, code) DO UPDATE SET
                        product_id = excluded.product_id,
                        name_cs = excluded.name_cs,
                        brand = excluded.brand,
                        category = excluded.category,
                        declared = excluded.declared,
                        derived_per_100g = excluded.derived_per_100g,
                        marketing_claims = excluded.marketing_claims,
                        ingredient_list = excluded.ingredient_list,
                        mineral_assay = excluded.mineral_assay,
                        dosage_instruction_cs = excluded.dosage_instruction_cs,
                        pack_grams = excluded.pack_grams,
                        price_with_vat_czk = excluded.price_with_vat_czk,
                        availability = excluded.availability,
                        url = excluded.url,
                        evidence_source = excluded.evidence_source,
                        evidence_source_date = excluded.evidence_source_date,
                        evidence_confidence = excluded.evidence_confidence,
                        evidence_note_cs = excluded.evidence_note_cs,
                        updated_at = excluded.updated_at`
                )
                .bind(
                    tenantId,
                    supplement.productId,
                    supplement.code,
                    supplement.nameCs,
                    supplement.brand,
                    supplement.category,
                    JSON.stringify(supplement.declared ?? []),
                    JSON.stringify(supplement.derivedPer100g ?? []),
                    JSON.stringify(supplement.marketingClaims ?? []),
                    supplement.ingredientList ? JSON.stringify(supplement.ingredientList) : null,
                    supplement.mineralAssay ? JSON.stringify(supplement.mineralAssay) : null,
                    supplement.dosageInstructionCs,
                    supplement.packGrams,
                    supplement.priceWithVatCzk,
                    supplement.availability,
                    supplement.url,
                    supplement.evidence.source,
                    supplement.evidence.sourceDate,
                    supplement.evidence.confidence,
                    supplement.evidence.noteCs ?? null,
                    now
                )
                .run();
        } catch (err) {
            throw new Error(
                `TutaniProductStore.upsertSupplement selhal (tenant=${tenantId}, code=${supplement.code}): ${describeError(err)}`
            );
        }
    }

    async getProduct(tenantId: string, code: string): Promise<StoredTutaniProduct | null> {
        try {
            const row = await this.db
                .prepare(`SELECT * FROM tutani_products WHERE tenant_id = ? AND code = ?`)
                .bind(tenantId, code)
                .first<Record<string, unknown>>();
            return row ? rowToTutaniProduct(row) : null;
        } catch (err) {
            throw new Error(
                `TutaniProductStore.getProduct selhal (tenant=${tenantId}, code=${code}): ${describeError(err)}`
            );
        }
    }

    async getSupplement(tenantId: string, code: string): Promise<StoredSupplement | null> {
        try {
            const row = await this.db
                .prepare(`SELECT * FROM tutani_supplements WHERE tenant_id = ? AND code = ?`)
                .bind(tenantId, code)
                .first<Record<string, unknown>>();
            return row ? rowToSupplement(row) : null;
        } catch (err) {
            throw new Error(
                `TutaniProductStore.getSupplement selhal (tenant=${tenantId}, code=${code}): ${describeError(err)}`
            );
        }
    }

    async listProducts(
        tenantId: string,
        filter?: TutaniProductFilter
    ): Promise<StoredTutaniProduct[]> {
        try {
            const conditions = ['tenant_id = ?'];
            const binds: (string | number)[] = [tenantId];

            if (filter?.topCategory) {
                conditions.push('top_category = ?');
                binds.push(filter.topCategory);
            }
            if (filter?.kind) {
                conditions.push('kind = ?');
                binds.push(filter.kind);
            }

            const sql = `SELECT * FROM tutani_products WHERE ${conditions.join(' AND ')} ORDER BY code`;
            const res = await this.db.prepare(sql).bind(...binds).all<Record<string, unknown>>();
            return (res.results ?? []).map(rowToTutaniProduct);
        } catch (err) {
            throw new Error(`TutaniProductStore.listProducts selhal (tenant=${tenantId}): ${describeError(err)}`);
        }
    }

    async listSupplements(tenantId: string): Promise<StoredSupplement[]> {
        try {
            const res = await this.db
                .prepare(`SELECT * FROM tutani_supplements WHERE tenant_id = ? ORDER BY code`)
                .bind(tenantId)
                .all<Record<string, unknown>>();
            return (res.results ?? []).map(rowToSupplement);
        } catch (err) {
            throw new Error(`TutaniProductStore.listSupplements selhal (tenant=${tenantId}): ${describeError(err)}`);
        }
    }
}

/**
 * Řádek D1 → `TutaniProduct`. Poškozený JSON v jednom řádku nesmí
 * shodit celý report — spadne se na bezpečný prázdný/nulový default
 * a chyba se čitelně zaloguje (observabilita, stejný vzor jako
 * `D1ProductStore.parseJsonArray`).
 */
function rowToTutaniProduct(row: Record<string, unknown>): StoredTutaniProduct {
    return {
        productId: String(row.product_id),
        code: String(row.code),
        nameCs: String(row.name_cs ?? ''),
        brand: row.brand === null || row.brand === undefined ? null : String(row.brand),
        categoryPath: row.category_path === null || row.category_path === undefined ? null : String(row.category_path),
        topCategory: (row.top_category as StoredTutaniProduct['topCategory']) ?? 'OTHER',

        priceWithVatCzk: row.price_with_vat_czk === null || row.price_with_vat_czk === undefined
            ? null
            : Number(row.price_with_vat_czk),
        packGrams: row.pack_grams === null || row.pack_grams === undefined ? null : Number(row.pack_grams),
        availability: (row.availability as StoredTutaniProduct['availability']) ?? 'UNKNOWN',
        url: String(row.url ?? ''),

        kind: row.kind as ProductKind,
        composition: parseJsonArrayOrEmpty<IngredientComposition>(row.composition, 'tutani_products.composition'),
        compositionAccountedPct: Number(row.composition_accounted_pct ?? 0),

        analytical: parseJsonArrayOrEmpty<AnalyticalValue>(row.analytical, 'tutani_products.analytical'),
        claims: parseJsonObjectOrDefault<ProductClaims>(
            row.claims,
            { rawDescriptionCs: null, ageCategory: null, dietaryClaimsCs: [] },
            'tutani_products.claims'
        ),

        evidence: {
            source: row.evidence_source as Evidence['source'],
            sourceDate: String(row.evidence_source_date ?? ''),
            confidence: row.evidence_confidence as Evidence['confidence'],
            noteCs: row.evidence_note_cs === null || row.evidence_note_cs === undefined
                ? undefined
                : String(row.evidence_note_cs),
        },
        updatedAt: String(row.updated_at ?? ''),
    };
}

/** Řádek D1 → `Supplement`. Stejná zásada jako u `rowToTutaniProduct`. */
function rowToSupplement(row: Record<string, unknown>): StoredSupplement {
    return {
        productId: String(row.product_id),
        code: String(row.code),
        nameCs: String(row.name_cs ?? ''),
        brand: row.brand === null || row.brand === undefined ? null : String(row.brand),
        category: row.category as SupplementCategory,

        declared: parseJsonArrayOrEmpty<DeclaredValue>(row.declared, 'tutani_supplements.declared'),
        derivedPer100g: parseJsonArrayOrEmpty<DerivedPer100g>(row.derived_per_100g, 'tutani_supplements.derived_per_100g'),
        marketingClaims: parseJsonArrayOrEmpty<MarketingClaim>(row.marketing_claims, 'tutani_supplements.marketing_claims'),

        // `null` je legitimní stav (R7) — na rozdíl od `composition`/`declared`
        // se tu chybějící hodnota NEnahrazuje prázdným polem, protože
        // „seznam ingrediencí neznáme" ≠ „seznam ingrediencí je prázdný".
        ingredientList: parseJsonObjectOrNull<SupplementIngredientList>(row.ingredient_list, 'tutani_supplements.ingredient_list'),
        mineralAssay: parseJsonArrayOrNull<MineralAssay>(row.mineral_assay, 'tutani_supplements.mineral_assay'),

        dosageInstructionCs: row.dosage_instruction_cs === null || row.dosage_instruction_cs === undefined
            ? null
            : String(row.dosage_instruction_cs),

        packGrams: row.pack_grams === null || row.pack_grams === undefined ? null : Number(row.pack_grams),
        priceWithVatCzk: row.price_with_vat_czk === null || row.price_with_vat_czk === undefined
            ? null
            : Number(row.price_with_vat_czk),
        availability: (row.availability as StoredSupplement['availability']) ?? 'UNKNOWN',
        url: String(row.url ?? ''),

        evidence: {
            source: row.evidence_source as StoredSupplement['evidence']['source'],
            sourceDate: String(row.evidence_source_date ?? ''),
            confidence: row.evidence_confidence as StoredSupplement['evidence']['confidence'],
            noteCs: row.evidence_note_cs === null || row.evidence_note_cs === undefined
                ? undefined
                : String(row.evidence_note_cs),
        },
        updatedAt: String(row.updated_at ?? ''),
    };
}

/**
 * JSON pole → typované pole, s bezpečným pádem na `[]` při poškozeném
 * nebo chybějícím obsahu. Používá se tam, kde je prázdné pole legitimní
 * default (`composition: []` = „složení neznáme", ne chyba).
 */
function parseJsonArrayOrEmpty<T>(raw: unknown, fieldForLog: string): T[] {
    if (typeof raw !== 'string' || raw.length === 0) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as T[]) : [];
    } catch {
        console.warn(JSON.stringify({ level: 'warn', event: 'tutani_products.json_invalid', field: fieldForLog, raw }));
        return [];
    }
}

/**
 * JSON pole, kde `null` je legitimní odlišný stav od prázdného pole
 * (`mineralAssay: null` = „není minerální produkt", ne „bez záznamů").
 * Poškozený JSON spadne na `null`, ne na `[]` — nesmí předstírat
 * prázdný, ale existující rozbor.
 */
function parseJsonArrayOrNull<T>(raw: unknown, fieldForLog: string): T[] | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as T[]) : null;
    } catch {
        console.warn(JSON.stringify({ level: 'warn', event: 'tutani_products.json_invalid', field: fieldForLog, raw }));
        return null;
    }
}

/** JSON objekt s bezpečným pádem na dodaný default (nikdy vyhodí výjimku). */
function parseJsonObjectOrDefault<T>(raw: unknown, fallback: T, fieldForLog: string): T {
    if (typeof raw !== 'string' || raw.length === 0) return fallback;
    try {
        return JSON.parse(raw) as T;
    } catch {
        console.warn(JSON.stringify({ level: 'warn', event: 'tutani_products.json_invalid', field: fieldForLog, raw }));
        return fallback;
    }
}

/** JSON objekt, kde `null` je legitimní odlišný stav od chybějícího záznamu. */
function parseJsonObjectOrNull<T>(raw: unknown, fieldForLog: string): T | null {
    if (raw === null || raw === undefined) return null;
    if (typeof raw !== 'string' || raw.length === 0) return null;
    try {
        return JSON.parse(raw) as T;
    } catch {
        console.warn(JSON.stringify({ level: 'warn', event: 'tutani_products.json_invalid', field: fieldForLog, raw }));
        return null;
    }
}

/** Čitelná chyba pro logy — `Error.message`, ne celý stack do výjimky navrch. */
function describeError(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
