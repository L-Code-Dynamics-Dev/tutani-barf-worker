/**
 * Syntetický `productsComplete.xml` ve tvaru admin exportu Shoptetu
 * (ověřeno na exportu Tutani 2026-09-24). Skutečný export do repa nesmí —
 * obsahuje nákupní ceny a repo je veřejné.
 *
 * Záměrně obsahuje i pasti ze skutečných dat: FLAGS s vlastními <CODE>,
 * RELATED_PRODUCTS s kódy cizích produktů a PURCHASE_PRICE.
 */

export interface XmlItem {
    id: string;
    name: string;
    code?: string;
    stock?: number;
    amount?: string;
    unit?: string;
    price?: number;
    visibility?: 'visible' | 'hidden';
    description?: string;
    related?: string[];
    variants?: { id: string; code: string; stock: number; amount: string; unit: string; price: number; param?: string; visible?: 0 | 1 }[];
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function priced(o: { code: string; stock: number; amount: string; unit: string; price: number; visible?: 0 | 1 }): string {
    return `<CODE>${esc(o.code)}</CODE><PRICE_VAT>${o.price}</PRICE_VAT><PURCHASE_PRICE>11.11</PURCHASE_PRICE>
<STOCK><AMOUNT>${o.stock}</AMOUNT><LOCATION></LOCATION></STOCK><VISIBLE>${o.visible ?? 1}</VISIBLE>
<UNIT_OF_MEASURE><PACKAGE_AMOUNT>${o.amount}</PACKAGE_AMOUNT><PACKAGE_AMOUNT_UNIT>${o.unit}</PACKAGE_AMOUNT_UNIT><MEASURE_AMOUNT>1</MEASURE_AMOUNT><MEASURE_AMOUNT_UNIT>pcs</MEASURE_AMOUNT_UNIT></UNIT_OF_MEASURE>`;
}

export function buildCompleteXml(items: XmlItem[]): string {
    const body = items
        .map((it) => {
            const head = `<SHOPITEM id="${it.id}"><NAME>${esc(it.name)}</NAME><GUID>guid-${it.id}</GUID>
<SHORT_DESCRIPTION><![CDATA[${it.description ?? ''}]]></SHORT_DESCRIPTION><MANUFACTURER>Tutani</MANUFACTURER>
<ITEM_TYPE>product</ITEM_TYPE><CATEGORIES><DEFAULT_CATEGORY id="1">Barf mražené maso</DEFAULT_CATEGORY></CATEGORIES>
<FLAGS><FLAG><CODE>action</CODE><ACTIVE>0</ACTIVE></FLAG><FLAG><CODE>new</CODE><ACTIVE>0</ACTIVE></FLAG></FLAGS>
<VISIBILITY>${it.visibility ?? 'visible'}</VISIBILITY>`;
            const related = it.related
                ? `<RELATED_PRODUCTS>${it.related.map((c) => `<CODE>${c}</CODE>`).join('')}</RELATED_PRODUCTS>`
                : '';
            const inner = it.variants
                ? `<VARIANTS>${it.variants
                      .map(
                          (v) =>
                              `<VARIANT id="${v.id}">${priced(v)}${
                                  v.param ? `<PARAMETERS><PARAMETER><NAME>${esc(it.name)}</NAME><VALUE>${esc(v.param)}</VALUE></PARAMETER></PARAMETERS>` : ''
                              }</VARIANT>`
                      )
                      .join('')}</VARIANTS>`
                : priced({ code: it.code!, stock: it.stock ?? 0, amount: it.amount ?? '', unit: it.unit ?? '', price: it.price ?? 100 });
            // RELATED_PRODUCTS PŘED vlastním kódem — přesně pořadí, které
            // v reálném exportu rozbilo naivní parser (TUT10 → TUT20/1).
            return `${head}${related}${inner}</SHOPITEM>`;
        })
        .join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<SHOP>\n${body}\n</SHOP>`;
}
