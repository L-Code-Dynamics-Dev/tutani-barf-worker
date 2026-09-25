#!/usr/bin/env node
/**
 * Statický (indexovatelný) obsah stránky /barf-kalkulacka/ — pro Google, AI crawlery
 * i lidi. Vkládá se do obsahu stránky v Shoptetu POD kontejner #tutani-barf.
 *
 * PROČ POD KONTEJNER: konfigurator.js při každém překreslení volá
 * `root.textContent = ''` — cokoli uvnitř #tutani-barf by smazal. Blok pod ním
 * zůstává, takže člověk i crawler (s JS i bez JS) dostanou STEJNÝ obsah
 * (žádný cloaking). Kalkulačka se nemění.
 *
 * ZDROJ PRAVDY: nic se nepíše ručně. Čísla jsou z metodiky (barf-core.json),
 * aktivity/nemoci/alergie/obaly z živého /v1/knowledge, příklad a postup z živého
 * /v1/davka, produkty z D1 (stejná podmínka jako USABLE_CONDITION ve Workeru).
 * Při změně metodiky nebo katalogu se skript pustí znovu.
 *
 * Použití:
 *   npx wrangler d1 execute tutani-barf --remote --json --command "<SQL z README>" > produkty.json
 *   node scripts/seo-obsah.mjs produkty.json > frontend/shoptet/5-seo-obsah.html
 */
import { readFileSync } from 'node:fs';

const WORKER = 'https://tutani-barf.hlancaric.workers.dev';
const PAGE_URL = 'https://obchod.tutani.cz/barf-kalkulacka/';
const GROUP_ORDER = ['MUSCLE', 'BONE', 'LIVER', 'ORGAN', 'PLANT'];

const produktyPath = process.argv[2];
if (!produktyPath) {
    console.error('Chybí cesta k JSONu produktů (výstup wrangler d1 execute --json).');
    process.exit(2);
}

const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const cz = (n) => String(n).replace('.', ',');
const pct = (a, b) => (a === b ? `${cz(a)} %` : `${cz(a)}–${cz(b)} %`);

async function getJson(url, init, tries = 3) {
    for (let i = 1; ; i++) {
        try {
            const r = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers || {}) } });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            return await r.json();
        } catch (e) {
            if (i >= tries) throw new Error(`${url}: ${e.message}`);
            await new Promise((res) => setTimeout(res, 500 * i));
        }
    }
}

const core = JSON.parse(readFileSync(new URL('../tenants/tutani/rules/barf-core.json', import.meta.url), 'utf-8'));
const rawProdukty = JSON.parse(readFileSync(produktyPath, 'utf-8'));
const produkty = (Array.isArray(rawProdukty) ? rawProdukty[0]?.results : rawProdukty.results) ?? [];
if (produkty.length < 20) throw new Error(`Podezřele málo produktů (${produkty.length}) — nic negeneruji.`);

const knowledge = await getJson(`${WORKER}/v1/knowledge`);
const PRIKLAD_PES = {
    jmeno: null, hmotnostKg: 15, idealniHmotnostKg: null, vekMesicu: 36, pohlavi: 'MALE', kastrovany: false,
    aktivita: 'MEDIUM', aktivitaDetail: 'hodina-venku', kondice: 'IDEAL', fyziologickyStav: 'NONE',
    diagnozy: [], alergie: [], problemSeZuby: false, velkePlemenoStene: false, prechodZGranuli: false,
};
const priklad = await getJson(`${WORKER}/v1/davka`, { method: 'POST', body: JSON.stringify({ pes: PRIKLAD_PES, obdobiDni: 7 }) });
if (priklad.status !== 'OK') throw new Error(`Ukázkový výpočet nevyšel: ${priklad.status}`);

const skupinyNazvy = Object.fromEntries(core.compositionProfile.groups.map((g) => [g.group, g.labelCs]));
const nemoci = knowledge.diagnoses.filter((d) => d.severity !== 'CRITICAL').map((d) => d.layNameCs).sort((a, b) => a.localeCompare(b, 'cs'));
const nemociStop = knowledge.diagnoses.filter((d) => d.severity === 'CRITICAL').map((d) => d.layNameCs).sort((a, b) => a.localeCompare(b, 'cs'));
const alergie = knowledge.allergens.map((a) => a.layNameCs.replace(/^nesnáší\s+/, '')).sort((a, b) => a.localeCompare(b, 'cs'));
const dv = priklad.davka;
const porce = core.doseMatrix;
const porceStene = porce.find((r) => r.id === 'puppy-0-6');
const porceStene2 = porce.find((r) => r.id === 'puppy-6-12');
const porceDosp = porce.find((r) => r.id === 'adult-medium');
const postup = priklad.recept?.postup ?? [];

// ---------------------------------------------------------------- FAQ (stejný text jde do HTML i do JSON-LD)
const FAQ = [
    ['Co je BARF?',
        'BARF je krmení psa syrovou stravou: svalové maso, masité a mleté kosti, játra a další vnitřnosti a malý podíl zeleniny a ovoce. Kalkulačka skládá misku v poměru ' +
        core.compositionProfile.groups.map((g) => `${g.pctDefault} % ${g.labelCs}`).join(', ') + '.'],
    ['Kolik BARFu má pes dostat denně?',
        `Záleží hlavně na hmotnosti, věku a aktivitě. Dospělý pes se střední aktivitou dostane ${pct(porceDosp.pctMin, porceDosp.pctMax)} své hmotnosti denně, štěně do 6 měsíců ${pct(porceStene.pctMin, porceStene.pctMax)}. Například pes s hmotností ${dv.zakladHmotnostiKg} kg (${dv.pravidloPopis}) dostane ${dv.celkemGDen} g denně.`],
    ['Kolikrát denně psa krmit?',
        `Dospělého psa obvykle ${porceDosp.portions}× denně, štěně do 6 měsíců ${porceStene.portions}× a štěně od 6 do 12 měsíců ${porceStene2.portions}× denně. Kalkulačka rozdělí dávku na porce a u každé ukáže gramy jednotlivých surovin.`],
    ['Jak přejít z granulí na BARF?',
        'Postupně, během několika dnů přidávejte syrovou stravu a sledujte trávení psa. V kalkulačce zaškrtněte „Právě přechází z granulí“ a dostanete k tomu doporučení.'],
    ['Jak BARF rozmrazovat a skladovat?',
        postup.filter((t) => /rozmraz|lednic|mraz/i.test(t)).join(' ') || 'Rozmrazujte v lednici, ne při pokojové teplotě, a rozmražené maso znovu nezamrazujte.'],
    ['Proč kalkulačka u některých nemocí dávku nespočítá?',
        `U ${nemociStop.length} zdravotních stavů (například ${nemociStop.slice(0, 3).join(', ')}) potřebuje pes krmný plán od veterináře. Kalkulačka proto dávku nevydá a doporučí konzultaci. U dalších stavů dávku spočítá a surovinám upraví podíl.`],
    ['Nahradí kalkulačka veterináře?', priklad.disclaimer],
];

// ---------------------------------------------------------------- HTML
const o = [];
o.push('<!-- L-CODE BARF SEO START — generuje scripts/seo-obsah.mjs, ručně neupravovat (přepíše se). -->');
o.push('<section class="tb-seo" aria-labelledby="tb-seo-nadpis">');
o.push('<h2 id="tb-seo-nadpis">BARF kalkulačka pro psy: kolik syrového masa dát psovi denně</h2>');
o.push(`<p>BARF kalkulačka spočítá denní dávku syrové stravy pro vašeho psa podle hmotnosti, věku, aktivity, kondice a zdravotního stavu. Rozdělí ji na svalové maso, kosti, játra, vnitřnosti a zeleninu, sestaví z produktů Tutani konkrétní nákup na týden, 14 dní nebo měsíc a vloží ho do košíku. K výsledku si můžete stáhnout jídelníček v PDF.</p>`);

o.push('<h3>Co do kalkulačky zadáte</h3>');
o.push('<ul>');
o.push('<li><strong>Hmotnost psa</strong> v kilogramech a u psa s nadváhou i jeho ideální hmotnost.</li>');
o.push('<li><strong>Věk</strong> – štěně, mladý pes, dospělý pes nebo senior mají jinou potřebu.</li>');
o.push('<li><strong>Pohlaví a kastrace</strong>, u feny také březost nebo kojení štěňat.</li>');
o.push(`<li><strong>Aktivita</strong> – ${knowledge.aktivity.map((a) => esc(a.nazev)).join(', ')}.</li>`);
o.push('<li><strong>Kondice</strong> – hubený, v pořádku, nadváha.</li>');
o.push('<li><strong>Zdraví</strong> – zdravotní stavy potvrzené veterinářem a alergie na druhy masa.</li>');
o.push('<li><strong>Zuby a trávení</strong> – problém se zuby nebo polykáním, štěně velkého plemene, přechod z granulí.</li>');
o.push('<li><strong>Období nákupu</strong> – týden, 14 dní nebo měsíc.</li>');
o.push('</ul>');

o.push('<h3>Jak se počítá denní dávka</h3>');
o.push('<p>Denní dávka je procento z hmotnosti psa. U psa s nadváhou se počítá z ideální (cílové) hmotnosti, aby pozvolna zhubl.</p>');
o.push('<table class="tb-seo-tabulka"><thead><tr><th scope="col">Pes</th><th scope="col">Denně z hmotnosti</th><th scope="col">Porcí denně</th></tr></thead><tbody>');
for (const r of porce) {
    o.push(`<tr><td>${esc(r.labelCs)}</td><td>${pct(r.pctMin, r.pctMax)}</td><td>${r.portions}×</td></tr>`);
}
o.push('</tbody></table>');

o.push('<h3>Složení misky</h3>');
o.push('<ul>');
for (const g of core.compositionProfile.groups) o.push(`<li><strong>${g.pctDefault} %</strong> ${esc(g.labelCs)}</li>`);
o.push('</ul>');
o.push('<p>Při některých zdravotních stavech kalkulačka poměr upraví, třeba sníží podíl kostí nebo jater.</p>');

o.push('<h3>Příklad výsledku</h3>');
o.push(`<p>Pes s hmotností ${dv.zakladHmotnostiKg} kg, ${esc(dv.pravidloPopis)} (${esc(priklad.pes.aktivita)}): <strong>${dv.celkemGDen} g denně</strong>, ${dv.porce.pocet} porce po ${dv.porce.gramyNaPorci} g. Z toho ${priklad.slozeni.map((s) => `${esc(s.nazev)} ${s.gramy} g`).join(', ')}.</p>`);

o.push('<h3>Co dostanete jako výsledek</h3>');
o.push('<ul>');
o.push('<li>Denní dávku v gramech a rozdělení do porcí (ráno, večer…).</li>');
o.push('<li>Gramy každé suroviny v misce, abyste mohli vážit na kuchyňské váze.</li>');
o.push('<li>Konkrétní produkty Tutani a počet balení na zvolené období, včetně ceny.</li>');
o.push(`<li>Vložení celého nákupu do košíku jedním tlačítkem. Maso vozíme zmražené ${knowledge.obaly.map((b) => `v obalu ${esc(b.nazev)} (${esc(b.popis)})`).join(' nebo ')}.</li>`);
o.push('<li>Jídelníček v PDF s postupem krmení.</li>');
o.push('<li>Upozornění, na co si dát pozor u vašeho psa.</li>');
o.push('</ul>');

o.push('<h3>Zdravotní stavy a alergie</h3>');
o.push(`<p>Dávku spočítáme a suroviny upravíme u těchto stavů: ${nemoci.map(esc).join(', ')}.</p>`);
o.push(`<p>Dávku nevydáme a doporučíme veterináře u těchto stavů: ${nemociStop.map(esc).join(', ')}.</p>`);
o.push(`<p>Při alergii vyřadíme maso, které pes nesnáší: ${alergie.map(esc).join(', ')}.</p>`);

o.push('<h3>Produkty, ze kterých kalkulačka skládá misku</h3>');
o.push('<p>Kalkulačka vybírá jen z produktů, které jsou skladem a dají se vložit do košíku.</p>');
const podleSkupin = {};
for (const p of produkty) (podleSkupin[p.barf_group] ||= []).push(p);
for (const g of GROUP_ORDER) {
    const list = (podleSkupin[g] || []).sort((a, b) => a.name.localeCompare(b.name, 'cs'));
    if (!list.length) continue;
    const nazev = skupinyNazvy[g] ?? g;
    // <details>: na mobilu 5 řádků místo 122; obsah je v HTML, Google ho indexuje.
    o.push(`<details class="tb-seo-skupina"><summary>${esc(nazev.charAt(0).toUpperCase() + nazev.slice(1))} <span>(${list.length})</span></summary>`);
    o.push('<ul class="tb-seo-produkty">');
    for (const p of list) o.push(`<li><a href="${esc(p.url)}">${esc(p.name)}</a></li>`);
    o.push('</ul></details>');
}

o.push('<h3>Časté otázky</h3>');
for (const [q, a] of FAQ) {
    o.push(`<h4>${esc(q)}</h4>`);
    o.push(`<p>${esc(a)}</p>`);
}
o.push('</section>');

// JSON-LD — stejná data jako text výše (žádný obsah navíc jen pro roboty).
const ld = [
    {
        '@context': 'https://schema.org',
        '@type': 'WebApplication',
        name: 'BARF kalkulačka pro psy',
        url: PAGE_URL,
        applicationCategory: 'LifestyleApplication',
        operatingSystem: 'Všechny (webový prohlížeč)',
        inLanguage: 'cs',
        description: 'Spočítá denní dávku syrové stravy (BARF) pro psa podle hmotnosti, věku, aktivity, kondice a zdravotního stavu a sestaví nákup z produktů Tutani.',
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'CZK' },
        publisher: { '@type': 'Organization', name: 'Tutani', url: 'https://obchod.tutani.cz/' },
    },
    {
        '@context': 'https://schema.org',
        '@type': 'FAQPage',
        mainEntity: FAQ.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
    },
];
o.push(`<script type="application/ld+json">${JSON.stringify(ld).replace(/</g, '\\u003c')}</script>`);
o.push('<!-- L-CODE BARF SEO END -->');

const vystup = o.join('\n') + '\n';
if (/undefined|null|NaN/.test(vystup.replace(/<script[\s\S]*?<\/script>/, ''))) throw new Error('Ve výstupu je undefined/null/NaN — chybí data, nic negeneruji.');
process.stdout.write(vystup);
console.error(`OK: ${produkty.length} produktů, ${knowledge.diagnoses.length} stavů, ${knowledge.allergens.length} alergií, ${porce.length} pásem dávek, ${FAQ.length} otázek.`);
