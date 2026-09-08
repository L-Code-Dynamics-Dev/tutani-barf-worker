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
}

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
}

export type UncoveredReason =
    | 'NO_PRODUCT_IN_GROUP'      // katalog složku vůbec nemá
    | 'ALL_FILTERED_OUT'         // vše vyřazeno alergií/bezpečností
    | 'OUT_OF_STOCK';            // je, ale není skladem

export interface UncoveredGroup {
    group: BarfGroup;
    labelCs: string;
    gramsPerDay: number;
    reason: UncoveredReason;
    /** Kolik produktů padlo na kterém filtru — pro report klientovi. */
    filteredOut: number;
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
    periodDays: number
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

        // ---- VÝBĚR ----
        // Potřeba vstupuje do výběru, aby se nedoporučilo balení
        // o mnoho větší, než zákazník na období spotřebuje.
        const chosen = pickBest(usable, constraints, needGrams.toNumber());
        const packs = Math.max(1, Math.ceil(needGrams.div(chosen.packGrams).toNumber()));
        const totalPrice = new Decimal(chosen.priceCzk).mul(packs);

        products.push({
            sku: chosen.sku,
            name: chosen.name,
            url: chosen.url,
            group: chosen.group,
            packGrams: chosen.packGrams,
            packs,
            unitPriceCzk: chosen.priceCzk,
            totalPriceCzk: round2(totalPrice),
            productId: chosen.productId,
            priceId: chosen.priceId,
            coversGrams: needGrams.toNumber(),
        });
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

    if (!p.inStock) return 'není skladem';

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
 * Vybere nejvhodnější produkt ze skupiny.
 *
 * Kritéria v pořadí:
 *  1. preferovaná surovina ze zdravotního pravidla (např. nízkotučné)
 *  2. balení, které se nepřebije o víc než `MAX_OVERSHOOT` — jinak
 *     zákazník platí za zásobu, kterou si neobjednal
 *  3. nižší cena za kilogram — nemá platit víc za totéž
 *  4. SKU jako poslední rozhodčí → deterministický výsledek
 *
 * PROČ BOD 2 (zjištěno ukázkou toku 2026-09-09): u malé denní potřeby
 * vyhrálo velké balení, protože mělo nejlepší cenu za kg. Konkrétně
 * 54 g kostí/den na 30 dní = 1,6 kg, ale doporučilo se balení 3 kg —
 * zásoba na 55 dní. U mraženého masa navíc naráží na kapacitu mrazáku.
 *
 * Kritérium je poměrové, ne absolutní: velké balení není zakázané,
 * jen nesmí potřebu překročit víc než dvojnásobně. Když menší balení
 * neexistuje, velké se použije (a je to lepší než nedoporučit nic).
 *
 * ZÁMĚRNĚ se nevybírá „největší balení" ani „nejdražší": cena za kg
 * a přiměřenost jsou jediná kritéria, která jde obhájit před
 * zákazníkem.
 */
const MAX_OVERSHOOT = 2.0;

function pickBest(
    candidates: CatalogProduct[],
    constraints: ResolvedConstraints,
    neededGrams: number
): CatalogProduct {
    const preferred = (p: CatalogProduct) =>
        p.ingredientIds.some((i) => constraints.preferredIngredientIds.has(i)) ? 0 : 1;

    const pricePerKg = (p: CatalogProduct) => (p.priceCzk / p.packGrams) * 1000;

    /** Kolikrát celá balení překročí potřebu. */
    const overshoot = (p: CatalogProduct) => {
        const packs = Math.max(1, Math.ceil(neededGrams / p.packGrams));
        return (packs * p.packGrams) / neededGrams;
    };

    const sorted = [...candidates].sort((a, b) => {
        const prefDiff = preferred(a) - preferred(b);
        if (prefDiff !== 0) return prefDiff;

        // Přiměřená balení mají přednost před nepřiměřenými, ale mezi
        // sebou se řadí až cenou — jinak by vyhrálo nejmenší balení
        // za každou cenu.
        const aFits = overshoot(a) <= MAX_OVERSHOOT ? 0 : 1;
        const bFits = overshoot(b) <= MAX_OVERSHOOT ? 0 : 1;
        if (aFits !== bFits) return aFits - bFits;

        const priceDiff = pricePerKg(a) - pricePerKg(b);
        if (Math.abs(priceDiff) > 0.005) return priceDiff;

        return a.sku.localeCompare(b.sku);
    });

    return sorted[0];
}

function round2(d: Decimal): number {
    return Number(d.toDecimalPlaces(2).toString());
}
