import type { ActivityLevel } from './dog/DogProfile.js';
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
    /**
     * Období, ze kterých zákazník VOLÍ (dny). API jiné hodnoty odmítne —
     * frontend nabízí jen tyhle a ručně upravený požadavek nesmí vyrobit
     * třeba 90denní nákup mraženého masa. Chybí-li, platí jen meze 1–90.
     */
    allowedPeriodDays?: readonly number[];
    /**
     * Recept a PDF jídelníček (Lucky 2026-09-24). Postup přípravy je
     * obecná hygiena syrové stravy BEZ čísel — text schvaluje klient.
     * Chybí-li, odpověď `recept` neobsahuje postup, jen gramy.
     */
    recipe?: {
        stepsCs: readonly string[];
        /** Kontakt do PDF (veřejný kontakt e-shopu). */
        contactCs?: string;
        /** Název pro hlavičku PDF. */
        brandCs?: string;
    };
    /** Mapování kategorie e-shopu na BARF skupinu. Data, ne kód. */
    categoryMap: CategoryMapping[];
    /**
     * Konkrétní aktivity, ze kterých majitel vybírá (Lucky 2026-09-25).
     * Každá je přiřazená k jedné úrovni z tabulky dávek (`level`) — dávka
     * se dál počítá JEN podle úrovně, žádné nové procento nevzniká.
     * Chybí-li, UI nabízí přímo 4 úrovně.
     */
    activityOptions?: readonly ActivityOption[];
    /**
     * Obal na doručení, který si zákazník v e-shopu MUSÍ vybrat (Tutani:
     * Přepravka E2 / Thermobox, 0 Kč). Kalkulačka ho vloží do košíku spolu
     * s nákupem. Chybí-li, volba se nezobrazí.
     */
    packagingOptions?: readonly PackagingOption[];
    /** Co smí podle názvu plnit složku dávky (fail-closed), viz matchProducts. */
    groupNameRules?: Partial<Record<BarfGroup, GroupNameRule>>;
}

export interface PackagingOption {
    productId: string;
    priceId: string;
    labelCs: string;
    /** Co to je — krátce pro zákazníka (fakta ze stránky Doprava, nic domyšleného). */
    hintCs: string;
    /** Cena pro popisek; skutečnou cenu účtuje Shoptet. */
    priceCzk: number;
}

export interface ActivityOption {
    /** Stabilní id do API (`pes.aktivitaDetail`), nemění se s textem. */
    id: string;
    labelCs: string;
    hintCs: string;
    level: ActivityLevel;
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

/**
 * Co smí podle názvu plnit danou složku (Lucky 2026-09-25). Kategorie
 * e-shopu je hrubá — „Barf - Přílohy" obsahuje zeleninu, obiloviny
 * i doplňky (křemelina!), které se nesmí dávkovat jako zelenina.
 * FAIL-CLOSED: produkt bez povoleného slova se vyřadí a přizná
 * v `excluded`; nový zeleninový produkt se doplní slovem do konfigurace.
 */
export interface GroupNameRule {
    /** Název musí obsahovat aspoň jedno (bez ohledu na velikost písmen). */
    requireAny: readonly string[];
    /** Název nesmí obsahovat žádné z nich — má přednost před `requireAny`. */
    forbidAny: readonly string[];
    /** Důvod pro zákazníka/audit, když produkt neprojde. */
    reasonCs: string;
}
