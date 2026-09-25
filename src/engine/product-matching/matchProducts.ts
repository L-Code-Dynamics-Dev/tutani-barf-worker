/**
 * PRODUCT MATCHING — z potřeby v gramech na konkrétní balení z katalogu.
 *
 * Běží AŽ PO výpočtu dávky (§6 zadání, R6). Výpočetní jádro nezná ani
 * jeden produktový kód; tahle vrstva naopak nepočítá dávku. Díky tomu
 * se katalog může měnit denně, aniž by se dotkl metodiky.
 *
 * TVRDÉ PRAVIDLO (R7): doporučuje se VÝHRADNĚ z katalogu Tutani.
 * Žádné externí zdroje, žádné dogenerování produktů, žádná substituce
 * složky jinou složkou. Nepokryje-li se potřeba, výsledek to přizná.
 *
 * Výběr je DETERMINISTICKÝ — dvě stejná volání dají stejný výsledek
 * (řazení má poslední rozhodčí podle SKU). To je nutné, aby zákazník
 * po obnovení stránky neviděl jiné doporučení a aby šel výsledek
 * reprodukovat při reklamaci.
 *
 * SKLAD A ROTACE (Lucky 2026-09-24): „Měli bychom absolutně vždycky umět
 * pracovat s aktuální skladovostí a momentální zásobou … aby se pořád
 * netočilo pár produktů a ostatní se neprodávaly."
 *
 *   1. Nikdy se nedoporučí víc balení, než je skladem. Když jeden
 *      produkt nestačí, dávka se DOPLNÍ rovnocenným produktem ze stejné
 *      složky (klokan dojde → krůtí svalovina). Balíček na X dní se tak
 *      pokryje, dokud to sklad dovolí; zbytek se přizná jako
 *      `INSUFFICIENT_STOCK`.
 *   2. „Rovnocenný" = stejná BARF složka a stejná třída složení: čistý
 *      produkt (≥ 90 % dané složky) se nenahrazuje směsí (70 % svalovina
 *      + 30 % droby), dokud je čistých dost. Filtry alergií, nemocí
 *      a bezpečnosti platí pro náhradu stejně jako pro první volbu.
 *   3. Místo „vždy nejlevnější" se vybírá z PÁSMA přijatelných produktů
 *      (přiměřené balení, cena za kg do +15 % od nejlevnějšího) s vahou
 *      podle zásoby — co je víc skladem, vychází častěji, nic nevypadne.
 *      Pořadí určuje `seed` (profil psa + den), takže je reprodukovatelné.
 */

import Decimal from 'decimal.js';
import type { BarfGroup } from '../../domain/tenant.js';
import type { ResolvedConstraints } from '../../domain/health/Condition.js';
import type { CompositionItem } from '../feeding-calculator/calculateDose.js';

/**
 * Produkt připravený pro doporučení. Vzniká z `ScrapedProduct` po
 * vyřešení gramáže a zařazení do skupiny — matching už neřeší, odkud
 * data jsou.
 */
export interface CatalogProduct {
    sku: string;
    name: string;
    url: string;
    priceCzk: number;
    packGrams: number;
    group: BarfGroup;
    inStock: boolean;
    /** Pro vložení do košíku Shoptetu. */
    productId: string | null;
    priceId: string | null;
    /** Id surovin z `ingredients` — pro filtr alergií. */
    ingredientIds: string[];
    /** Vařené kosti se nikdy nedoporučují (§9 zadání). */
    isCooked: boolean;
    /**
     * Surovinu nelze z dat určit — u zadané alergie se produkt
     * NEDOPORUČÍ (fail-closed, nález auditu 2026-09-09).
     * Volitelné kvůli zpětné kompatibilitě testů; chybějící hodnota
     * se čte jako `false` (suroviny známe).
     */
    ingredientsUnknown?: boolean;
    /**
     * Momentální zásoba v kusech (balení). `null`/chybí = neznámá —
     * produkt se pak omezuje jen příznakem `inStock` (zpětná kompatibilita).
     */
    stockQuantity?: number | null;
    /** Rozpad na BARF složky v % — určuje, co je rovnocenná náhrada. */
    compositionParts?: { group: BarfGroup; pct: number }[];
}

/** Volby výběru. Vše volitelné — bez nich se chová deterministicky se seedem ''. */
export interface MatchOptions {
    /**
     * Seed rotace. API ho skládá z profilu psa a data: stejný pes ve
     * stejný den = stejný nákup (reklamace, obnovení stránky), jiný pes
     * nebo jiný den = jiné pořadí v rámci pásma.
     */
    seed?: string;
    /** Šířka cenového pásma nad nejlevnějším (0,15 = +15 % Kč/kg). */
    priceBandRatio?: number;
    /** Kolik různých produktů smí pokrýt jednu složku. */
    maxProductsPerGroup?: number;
}

export const DEFAULT_PRICE_BAND_RATIO = 0.15;
const DEFAULT_MAX_PRODUCTS_PER_GROUP = 4;
/** Od kolika % dané složky je produkt „čistý" (rovnocenná náhrada). */
const PURE_THRESHOLD_PCT = 90;

export interface MatchedProduct {
    sku: string;
    name: string;
    url: string;
    group: BarfGroup;
    packGrams: number;
    /** Počet balení na celé zvolené období. */
    packs: number;
    unitPriceCzk: number;
    totalPriceCzk: number;
    productId: string | null;
    priceId: string | null;
    /** Kolik gramů z potřeby tenhle produkt pokrývá. */
    coversGrams: number;
    /** Zásoba v okamžiku výpočtu (`null` = neznámá). */
    stockQuantity: number | null;
    /**
     * `true` = produkt doplňuje složku, protože předchozí volba neměla
     * dost kusů skladem. Frontend může zobrazit „doplněno X".
     */
    fillsShortage: boolean;
}

export type UncoveredReason =
    | 'NO_PRODUCT_IN_GROUP'      // katalog složku vůbec nemá
    | 'ALL_FILTERED_OUT'         // vše vyřazeno alergií/bezpečností
    | 'OUT_OF_STOCK'             // je, ale není skladem
    | 'INSUFFICIENT_STOCK';      // skladem je, ale na celé období nestačí

export interface UncoveredGroup {
    group: BarfGroup;
    labelCs: string;
    gramsPerDay: number;
    reason: UncoveredReason;
    /** Kolik produktů padlo na kterém filtru — pro report klientovi. */
    filteredOut: number;
    /** U `INSUFFICIENT_STOCK`: kolik gramů na celé období chybí. */
    missingGrams?: number;
}

export interface ExcludedProduct {
    sku: string;
    name: string;
    reasonCs: string;
}

export interface MatchResult {
    periodDays: number;
    products: MatchedProduct[];
    uncovered: UncoveredGroup[];
    /** Co bylo vyřazeno a proč — kvůli průhlednosti vůči zákazníkovi. */
    excluded: ExcludedProduct[];
    totalPriceCzk: number;
}

/**
 * Sestaví nákup na období z potřeby po složkách.
 *
 * `periodDays` je volba zákazníka (default z konfigurace tenanta) —
 * mražené maso má limit mrazáku, takže měsíc není vždy vhodný.
 */
export function matchProducts(
    composition: CompositionItem[],
    catalog: CatalogProduct[],
    constraints: ResolvedConstraints,
    periodDays: number,
    options: MatchOptions = {}
): MatchResult {
    const products: MatchedProduct[] = [];
    const uncovered: UncoveredGroup[] = [];
    const excluded: ExcludedProduct[] = [];

    for (const item of composition) {
        // SUPPLEMENT a OTHER nejsou složky dávky — doplňky se řeší
        // zvlášť, ne jako povinná část gramáže.
        if (item.grams <= 0) continue;

        const inGroup = catalog.filter((p) => p.group === item.group);
        if (inGroup.length === 0) {
            uncovered.push({
                group: item.group,
                labelCs: item.labelCs,
                gramsPerDay: item.grams,
                reason: 'NO_PRODUCT_IN_GROUP',
                filteredOut: 0,
            });
            continue;
        }

        // ---- FILTRY ----
        const usable: CatalogProduct[] = [];
        let hadStockIssueOnly = true;

        for (const p of inGroup) {
            const reason = filterReason(p, item.group, constraints);
            if (reason === null) {
                usable.push(p);
                hadStockIssueOnly = false;
                continue;
            }
            excluded.push({ sku: p.sku, name: p.name, reasonCs: reason });
            if (!reason.startsWith('není skladem')) hadStockIssueOnly = false;
        }

        if (usable.length === 0) {
            uncovered.push({
                group: item.group,
                labelCs: item.labelCs,
                gramsPerDay: item.grams,
                reason: hadStockIssueOnly ? 'OUT_OF_STOCK' : 'ALL_FILTERED_OUT',
                filteredOut: inGroup.length,
            });
            continue;
        }

        // ---- POKRYTÍ ----
        // Celá balení, zaokrouhlení NAHORU: maso se nekrájí na gramy
        // a zákazník musí mít na celé období, ne o den méně.
        const needGrams = new Decimal(item.grams).mul(periodDays);

        // ---- VÝBĚR A ALOKACE PODLE SKLADU ----
        // Potřeba vstupuje do výběru, aby se nedoporučilo balení
        // o mnoho větší, než zákazník na období spotřebuje.
        const ordered = rankCandidates(usable, item.group, constraints, needGrams.toNumber(), options);
        const maxProducts = options.maxProductsPerGroup ?? DEFAULT_MAX_PRODUCTS_PER_GROUP;

        let remaining = needGrams.toNumber();
        let used = 0;
        for (const chosen of ordered) {
            if (remaining <= 0 || used >= maxProducts) break;
            const packsNeeded = Math.max(1, Math.ceil(remaining / chosen.packGrams));
            const stock = knownStock(chosen);
            const packs = stock === null ? packsNeeded : Math.min(packsNeeded, stock);
            if (packs <= 0) continue;

            const covers = Math.min(packs * chosen.packGrams, remaining);
            products.push({
                sku: chosen.sku,
                name: chosen.name,
                url: chosen.url,
                group: chosen.group,
                packGrams: chosen.packGrams,
                packs,
                unitPriceCzk: chosen.priceCzk,
                totalPriceCzk: round2(new Decimal(chosen.priceCzk).mul(packs)),
                productId: chosen.productId,
                priceId: chosen.priceId,
                coversGrams: covers,
                stockQuantity: stock,
                fillsShortage: used > 0,
            });
            remaining -= packs * chosen.packGrams;
            used++;
        }

        if (remaining > 0) {
            // Sklad celé období nepokryje — PŘIZNAT, ne dopočítat (R7).
            uncovered.push({
                group: item.group,
                labelCs: item.labelCs,
                gramsPerDay: round2(new Decimal(remaining).div(periodDays)),
                reason: 'INSUFFICIENT_STOCK',
                filteredOut: 0,
                missingGrams: Math.round(remaining),
            });
        }
    }

    const total = products.reduce((a, p) => a.plus(p.totalPriceCzk), new Decimal(0));

    return {
        periodDays,
        products,
        uncovered,
        excluded,
        totalPriceCzk: round2(total),
    };
}

/**
 * Proč produkt nelze doporučit. `null` = lze.
 *
 * Pořadí kontrol je od nejzávažnější: bezpečnost, pak zdraví, pak
 * dostupnost. Text je pro zákazníka, ne pro log.
 */
function filterReason(
    p: CatalogProduct,
    group: BarfGroup,
    constraints: ResolvedConstraints
): string | null {
    /**
     * BEZPEČNOST: vařený produkt se nedoporučí NIKDY, ne jen u kostí.
     *
     * NÁLEZ AUDITU 2026-09-09: podmínka byla `group === 'BONE' &&
     * p.isCooked`, takže vařené celé kuře nebo vařený krk zařazený
     * jako MUSCLE prošel bez námitky. Kostní střep ale nezávisí na
     * tom, do jaké skupiny produkt zařadil `resolveBarfGroup` z názvu
     * — a mražené maso s kostí se do MUSCLE dostává běžně.
     */
    /**
     * Problém se zuby / polykáním: jen MLETÉ kosti. Produkt s kostí
     * (skupina BONE nebo kost ve složení), který podle názvu není mletý,
     * se nedoporučí — fail-closed, neznámou formu nebereme za bezpečnou.
     */
    if (constraints.groundBoneOnly === true) {
        const hasBone = group === 'BONE' || (p.compositionParts ?? []).some((x) => x.group === 'BONE' && x.pct > 0);
        if (hasBone && !/ml[eé]t|mlet|drcen/i.test(p.name)) {
            return 'celá kost — pes s problémem se zuby nebo polykáním ji nemusí rozkousat, doporučujeme jen mleté kosti';
        }
    }

    if (p.isCooked) {
        return group === 'BONE'
            ? 'vařené kosti se nikdy nedoporučují — hrozí střepy a poranění zažívacího traktu'
            : 'vařený produkt se do surové dávky nezařazuje — může obsahovat vařenou kost';
    }

    /**
     * ALERGIE a toxické suroviny. `excludedIngredientIds` už obsahuje
     * sjednocení alergií zadaných majitelem, zákazů z diagnóz
     * a toxických potravin — matching sám nerozhoduje, co je zakázané.
     */
    for (const ing of p.ingredientIds) {
        if (constraints.excludedIngredientIds.has(ing)) {
            return `obsahuje ${ing}, který má pes vyloučený`;
        }
    }

    /**
     * FAIL-CLOSED: neznámou surovinu nelze prohlásit za bezpečnou.
     *
     * NÁLEZ AUDITU 2026-09-09: filtr výše je allowlist nad
     * `ingredientIds` — u produktu s prázdným polem neudělá nic.
     * Psovi s alergií na kuře se tak doporučilo kuřecí maso, protože
     * se surovina nedala určit. Katalog tutani má složení jen u 17 %
     * produktů, takže to není hraniční případ, ale běžný stav.
     *
     * Když má pes vyloučenou aspoň jednu surovinu a u produktu
     * nevíme, co obsahuje, produkt se NEDOPORUČÍ. Zákazník uvidí
     * v `excluded` proč — je to poctivější než tichá záměna.
     *
     * U psa BEZ alergií a diagnóz se nic nemění: `excludedIngredientIds`
     * obsahuje jen toxické suroviny, které se z názvu poznají.
     */
    /**
     * Řídí se `ownerExcludedIngredientIds` (zadané alergie a diagnózy),
     * NE celou `excludedIngredientIds`.
     *
     * Ta totiž obsahuje 8 toxických surovin VŽDY, takže by byla
     * neprázdná i u zdravého psa — a fail-closed by vyřadil všech 219
     * produktů bez určeného složení. Konfigurátor by nedoporučil nic.
     * Odchyceno testem 2026-09-09.
     *
     * Toxické suroviny se přitom pořád filtrují: mají charakteristické
     * názvy (cibule, česnek, hrozny), takže `detectIngredients` je
     * z názvu i popisu pozná — u nich se na fail-closed nespoléhá.
     */
    const zadaneAlergie = constraints.ownerExcludedIngredientIds;
    if (p.ingredientsUnknown === true && zadaneAlergie !== undefined && zadaneAlergie.size > 0) {
        return 'nevíme, z jaké suroviny je — u psa s vyloučenou potravinou ho nedoporučujeme';
    }

    // Filtry na atributy produktu ze zdravotních pravidel
    // (např. nízkotučné u pankreatitidy) — vyhodnocuje je
    // `applyProductAttrFilters`, aby matching neznal názvy atributů.
    const attrReason = applyProductAttrFilters(p, constraints);
    if (attrReason !== null) return attrReason;

    /**
     * KOŠÍK (Lucky 2026-09-24): vkládá se přes `/action/Cart/addCartItem/`
     * a KAŽDÁ položka musí nést `priceId` (id varianty) I `productId`.
     * Produkt bez nich by šel doporučit, ale ne koupit — zákazník by
     * dostal nákup, který se do košíku nevloží celý.
     */
    if (!p.priceId || !p.productId) return 'nejde vložit do košíku — chybí priceId nebo productId';

    if (!p.inStock) return 'není skladem';
    // Momentální zásoba má přednost před příznakem z nočního syncu.
    if (knownStock(p) === 0) return 'není skladem';

    return null;
}

/**
 * Zdravotní filtry na atributy produktu.
 *
 * Dnes se vyhodnocuje jen to, co katalog Tutani reálně nese. Obsah
 * tuku v katalogu NENÍ (dry-run 2026-09-08), takže pravidlo na `fatPct`
 * by nemělo z čeho rozhodnout — a NEHÁDÁ se (R7): filtr, který nemá
 * data, produkt nevyřadí, ale zapíše se do `constraints.warnings`
 * jako neuplatněný. Řeší se ve vrstvě pravidel, ne tady.
 */
function applyProductAttrFilters(
    _p: CatalogProduct,
    _constraints: ResolvedConstraints
): string | null {
    return null;
}

/**
 * Seřadí kandidáty jedné složky do pořadí, v jakém se z nich plní potřeba.
 *
 * VRSTVY (dřívější vrstva se vyčerpá celá, než přijde na řadu další):
 *   A. preferovaná surovina ze zdravotního pravidla (např. nízkotučné)
 *   B. čistý produkt dané složky (≥ 90 %) před směsí — náhrada musí být
 *      rovnocenná, ne „něco ze stejné kategorie"
 *
 * UVNITŘ VRSTVY:
 *   1. PÁSMO = přiměřené balení (nepřebije potřebu víc než 2×, viz
 *      `MAX_OVERSHOOT`) a cena za kg do `priceBandRatio` nad nejlevnějším
 *      přiměřeným. Mimo pásmo nic nevypadne — jen jde až za pásmo.
 *   2. V pásmu nejdřív produkty, které SAMY pokryjí celé období
 *      (dost kusů skladem) — zákazník nemá dostat tři sáčky, když
 *      stačí jeden. Dělí se jen, když to sklad jinak nedovolí.
 *   3. Pořadí v pásmu: vážený los (Efraimidis–Spirakis) se seedem.
 *      Váha = kolikrát zásoba pokryje potřebu (0,25–8) — co leží
 *      na skladě, vychází častěji; nic nemá nulovou šanci.
 *   4. Mimo pásmo postaru: přiměřenost, cena za kg, SKU.
 *
 * PROČ NE „VŽDY NEJLEVNĚJŠÍ" (Lucky 2026-09-24): pro všechny psy by
 * vyšel pořád stejný produkt na složku a zbytek skladu by stál.
 * Pásmo +15 % drží doporučení cenově obhajitelné před zákazníkem.
 */
const MAX_OVERSHOOT = 2.0;

function rankCandidates(
    candidates: CatalogProduct[],
    group: BarfGroup,
    constraints: ResolvedConstraints,
    neededGrams: number,
    options: MatchOptions
): CatalogProduct[] {
    const band = options.priceBandRatio ?? DEFAULT_PRICE_BAND_RATIO;
    const seed = options.seed ?? '';

    const preferred = (p: CatalogProduct) =>
        p.ingredientIds.some((i) => constraints.preferredIngredientIds.has(i));
    const pure = (p: CatalogProduct) => purityPct(p, group) >= PURE_THRESHOLD_PCT;
    const layerOf = (p: CatalogProduct) => (preferred(p) ? 0 : 2) + (pure(p) ? 0 : 1);

    const layers = new Map<number, CatalogProduct[]>();
    for (const p of candidates) {
        const l = layerOf(p);
        const arr = layers.get(l) ?? [];
        arr.push(p);
        layers.set(l, arr);
    }

    const out: CatalogProduct[] = [];
    for (const l of [...layers.keys()].sort((a, b) => a - b)) {
        out.push(...rankLayer(layers.get(l)!, group, neededGrams, band, seed));
    }
    return out;
}

function rankLayer(
    layer: CatalogProduct[],
    group: BarfGroup,
    neededGrams: number,
    band: number,
    seed: string
): CatalogProduct[] {
    const pricePerKg = (p: CatalogProduct) => (p.priceCzk / p.packGrams) * 1000;
    const packsFor = (p: CatalogProduct) => Math.max(1, Math.ceil(neededGrams / p.packGrams));
    const fits = (p: CatalogProduct) => (packsFor(p) * p.packGrams) / neededGrams <= MAX_OVERSHOOT;

    /**
     * Pásmo se počítá z přiměřených balení. Když přiměřené NENÍ ŽÁDNÉ
     * (malý pes na 7 dní a nejmenší balení 3 kg), počítá se ze všech —
     * jinak by se rotace vypnula a vyšel by „nejlevnější", zatímco na
     * 30 dní (kde už balení přiměřené je) by vyšlo jiné maso. Zákazník
     * by při přepnutí období viděl výměnu masa bez důvodu (odchyceno
     * testem 2026-09-24).
     */
    const fitting = layer.filter(fits);
    const pool = fitting.length > 0 ? fitting : layer;
    const cheapest = pool.length > 0 ? Math.min(...pool.map(pricePerKg)) : null;
    const inPool = new Set(pool);
    const inBand = (p: CatalogProduct) =>
        cheapest !== null && inPool.has(p) && pricePerKg(p) <= cheapest * (1 + band) + 0.005;

    const bandSet = layer.filter(inBand);
    const rest = layer.filter((p) => !inBand(p));

    const coversAlone = (p: CatalogProduct) => {
        const s = knownStock(p);
        return s === null || s >= packsFor(p);
    };
    const weight = (p: CatalogProduct) => {
        const s = knownStock(p);
        if (s === null) return 1;
        return Math.min(8, Math.max(0.25, (s * p.packGrams) / neededGrams));
    };
    // Efraimidis–Spirakis: klíč u^(1/w), vyšší vyhrává. Deterministické
    // díky hashi místo Math.random.
    const lotteryKey = (p: CatalogProduct) => Math.pow(hash01(`${seed}|${group}|${p.sku}`), 1 / weight(p));
    const byLottery = (a: CatalogProduct, b: CatalogProduct) =>
        lotteryKey(b) - lotteryKey(a) || a.sku.localeCompare(b.sku);

    const bandFull = bandSet.filter(coversAlone).sort(byLottery);
    const bandPartial = bandSet.filter((p) => !coversAlone(p)).sort(byLottery);

    const restSorted = [...rest].sort((a, b) => {
        const fitDiff = (fits(a) ? 0 : 1) - (fits(b) ? 0 : 1);
        if (fitDiff !== 0) return fitDiff;
        const priceDiff = pricePerKg(a) - pricePerKg(b);
        if (Math.abs(priceDiff) > 0.005) return priceDiff;
        return a.sku.localeCompare(b.sku);
    });

    return [...bandFull, ...bandPartial, ...restSorted];
}

/** Podíl dané složky v produktu (%). Bez rozpadu = celý produkt (100 %). */
function purityPct(p: CatalogProduct, group: BarfGroup): number {
    const parts = p.compositionParts;
    if (!parts || parts.length === 0) return 100;
    return parts.filter((c) => c.group === group).reduce((a, c) => a + c.pct, 0);
}

/** Zásoba v celých kusech; `null` = neznámá. Záporná (Shoptet to umí) = 0. */
function knownStock(p: CatalogProduct): number | null {
    const s = p.stockQuantity;
    if (s === null || s === undefined || !Number.isFinite(s)) return null;
    return Math.max(0, Math.floor(s));
}

/**
 * Deterministické číslo z (0, 1] z řetězce — FNV-1a 32 bit.
 * Nejde o kryptografii: jen rovnoměrné a reprodukovatelné pořadí.
 */
function hash01(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    // Dodatečné promíchání bitů — FNV má u krátkých podobných řetězců
    // (SKU lišící se posledním znakem) slabší rozptyl v horních bitech.
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    return ((h >>> 0) + 1) / 4294967297;
}

function round2(d: Decimal): number {
    return Number(d.toDecimalPlaces(2).toString());
}
