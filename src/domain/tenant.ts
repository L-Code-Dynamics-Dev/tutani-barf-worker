/**
 * Tenant model — hranice mezi samostatným Workerem a budoucím Nexem.
 *
 * ZÁSADA (Lucky 2026-09-08): Worker NIKDY nesmí obsahovat
 * `if (client === 'tutani')`. Veškeré odlišnosti tenanta jdou přes
 * konfiguraci:
 *
 *     tenantId → TenantConfiguration → RuleSet → ProductCatalog
 *
 * Tutani je první tenant, ne zabudovaný předpoklad. Až se model osvědčí,
 * doména se přenese do Nexu bez přepisu — proto jsou typy tvarované jako
 * canonical entity (`core/canonical/entities/` v Nexu), ne jako ad-hoc
 * DTO tohohle projektu.
 */

/** Identifikátor tenanta. Jediný vstupní bod pro rozlišení klientů. */
export type TenantId = string;

/**
 * Kde tenant bere katalog. Adaptér se vybírá podle `kind`, ne podle
 * jména tenanta — druhý Shoptet klient nepotřebuje ani řádku nového kódu.
 */
export interface CatalogSource {
    /** SHOPTET_DOM = scraping `dataLayer` z detailu produktu (Tutani). */
    kind: 'SHOPTET_DOM' | 'SHOPTET_FEED' | 'WOO_REST' | 'STATIC';
    /** Základ e-shopu, např. `https://obchod.tutani.cz`. */
    baseUrl: string;
    /** Sitemapa pro výčet produktových URL (SHOPTET_DOM). */
    sitemapUrl?: string;
    /** URL feedu s hashem, je-li k dispozici (SHOPTET_FEED). */
    feedUrl?: string;
}

/**
 * Konfigurace tenanta. Všechno, co se mezi klienty může lišit, je tady —
 * nikdy v `if`u v enginu.
 */
export interface TenantConfiguration {
    tenantId: TenantId;
    /** Jméno pro logy a UI, ne pro rozhodování. */
    displayName: string;
    locale: string;
    currency: string;
    catalog: CatalogSource;
    /**
     * Které sady pravidel se pro tenanta načtou. Verze je součástí
     * identity — pravidla se verzují, ne přepisují (auditovatelnost
     * zdravotního doporučení).
     */
    ruleSetIds: string[];
    /** Default období, na které se počítá nákup (dny). */
    defaultPeriodDays: number;
    /** Mapování kategorie e-shopu na BARF skupinu. Data, ne kód. */
    categoryMap: CategoryMapping[];
}

export interface CategoryMapping {
    /** Podle čeho se v cestě kategorie poznává, např. `svalovina`. */
    match: string;
    barfGroup: BarfGroup;
}

/**
 * Složky BARF dávky. Kanonický výčet — pravidla, produkty i výpočet
 * mluví tímhle jazykem, aby se dala měnit metodika bez dotčení katalogu.
 */
export type BarfGroup =
    | 'MUSCLE'      // svalové maso
    | 'BONE'        // mleté kosti
    | 'LIVER'       // játra (vlastních 5 %)
    | 'ORGAN'       // ostatní orgány
    | 'PLANT'       // zelenina a ovoce
    | 'SUPPLEMENT'  // oleje, doplňky
    | 'OTHER';      // nezařazeno — do doporučení nevstupuje

/**
 * Registr tenantů. Rozhraní, ne konkrétní implementace — dnes čte
 * statické konfigurace z `tenants/`, v Nexu to bude D1 nebo KV.
 */
export interface TenantRegistry {
    get(tenantId: TenantId): Promise<TenantConfiguration | null>;
    list(): Promise<TenantId[]>;
}
