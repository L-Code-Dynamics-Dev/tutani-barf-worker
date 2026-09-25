/**
 * BARF konfigurátor Tutani — frontend.
 *
 * ZODPOVĚDNOST TOHOTO SOUBORU: sběr vstupu z UI, zobrazení výsledku,
 * vložení do košíku. NIC VÍC.
 *
 * Frontend NIKDY nepočítá dávku ani nerozhoduje, jestli je produkt
 * vhodný (R3). Všechno počítá Worker — tady se jen posílá profil psa
 * a vykresluje odpověď. Kdyby se sem propašoval výpočet, rozešel by
 * se s metodikou v okamžiku, kdy klient změní pravidla.
 *
 * Vzhled podle klientské předlohy „Tutani BARF Engine" (2026-09-24).
 * Předloha měla vlastní výpočet a vymyšlený katalog jen pro představu —
 * odtud se převzal POUZE vzhled, čísla a produkty jsou z Workeru.
 *
 * Nasazení: vložit jako <script defer src="..."> do šablony Shoptetu
 * a na stránku dát:
 *
 *   <div id="tutani-barf"
 *        data-foto="https://…/pes.webp"          (volitelné — jinak tlapka)
 *        data-telefon="+420605178771"            (volitelné — tlačítko u stavů pro veterináře)
 *        data-kontakt="Mirce"></div>             (volitelné — „Zavolat Mirce")
 */
(function () {
    'use strict';

    var WORKER_BASE = 'https://tutani-barf.hlancaric.workers.dev';
    var API_DAVKA = WORKER_BASE + '/v1/davka';
    var API_KNOWLEDGE = WORKER_BASE + '/v1/knowledge';
    var API_PDF = WORKER_BASE + '/v1/jidelnicek.pdf';
    var ADD_TO_CART_URL = '/action/Cart/addCartItem/';

    var KONTEJNER_ID = 'tutani-barf';
    var FONTY_URL =
        'https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700;800' +
        '&family=Source+Sans+3:wght@400;500;600;700&display=swap';

    /** Výchozí kontakt pro stavy, u kterých dávku nevydáváme (veřejný kontakt z hlavičky e-shopu). */
    var VYCHOZI_TELEFON = '+420605178771';
    var VYCHOZI_KONTAKT = 'Mirce';

    /** Barvy složek podle předlohy. Názvy složek posílá Worker. */
    var BARVY_SKUPIN = {
        MUSCLE: ['#D7282F', '#fff'],
        BONE: ['#EADBC4', '#231815'],
        LIVER: ['#7A1F1F', '#fff'],
        ORGAN: ['#E88A8A', '#231815'],
        PLANT: ['#86A63F', '#fff'],
        SUPPLEMENT: ['#F2965A', '#231815'],
        OTHER: ['#CFC2B5', '#231815'],
    };

    /**
     * Stav formuláře. Jediný zdroj pravdy pro UI; po každé změně se
     * pošle na Worker a překreslí výsledek.
     */
    var stav = {
        jmeno: '',
        hmotnostKg: 15,
        idealniHmotnostKg: null,
        vekMesicu: 36,
        pohlavi: 'MALE',
        kastrovany: false,
        aktivita: 'MEDIUM',
        // Konkrétní aktivita z /v1/knowledge (id); úroveň pro dávku určí Worker.
        aktivitaDetail: null,
        kondice: 'IDEAL',
        fyziologickyStav: 'NONE',
        diagnozy: [],
        alergie: [],
        // Karta 04 Zuby a trávení (klient 25. 9.)
        problemSeZuby: false,
        velkePlemenoStene: false,
        prechodZGranuli: false,
        obdobiDni: 30,
    };

    /** Štěně velkého plemene dává smysl jen do 2 let (JUNIOR). */
    var VEK_STENE_DO_MESICU = 24;

    /** Poslední odpověď Workeru — vykresluje se z ní, nepočítá se. */
    var vysledek = null;
    var chyba = null;
    var beziPozadavek = false;
    /** Diagnózy a alergie z Workeru; frontend je nemá natvrdo. */
    var knowledge = { diagnozy: [], alergie: [], aktivity: [], obaly: [] };
    // Obal doručení (priceId) — e-shop ho vyžaduje u každé objednávky.
    var zvolenyObal = null;
    // Obal, který už je v košíku z předchozího vložení — podruhé se nepřidává.
    var obalVKosiku = null;
    /** Čistě UI stav — přežije překreslení. */
    var ui = { procOtevreno: false, postupOtevreno: false, zobrazenoG: null, animace: 0, toastCasovac: null };
    /** Logo Tutani z jejich vlastního CDN (klient 24. 9.: „nahrát naše logo"). */
    var VYCHOZI_LOGO = 'https://cdn.myshoptet.com/usr/obchod.tutani.cz/user/documents/upload/tutani-logo-do-hlavicky-normal@2x.png';
    var nastaveni = { foto: null, logo: VYCHOZI_LOGO, telefon: VYCHOZI_TELEFON, kontakt: VYCHOZI_KONTAKT };

    // ---------------------------------------------------------------
    // Komunikace s Workerem
    // ---------------------------------------------------------------

    /**
     * Debounce: zákazník tahá posuvníkem hmotnosti a nechceme na každý
     * pixel volat Worker. 250 ms je pod hranicí, kdy to působí líně.
     */
    var casovac = null;
    function naplanujPrepocet() {
        aktualizujKartuZuby();
        if (casovac) clearTimeout(casovac);
        casovac = setTimeout(prepocitej, 250);
    }

    /** Pořadové číslo požadavku — starší odpověď nesmí přebít novější. */
    var poradi = 0;

    function prepocitej() {
        var moje = ++poradi;
        beziPozadavek = true;
        oznacStary();

        fetch(API_DAVKA, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pes: profilZeStavu(), obdobiDni: stav.obdobiDni }),
        })
            .then(function (res) {
                return res.json().then(function (data) {
                    return { ok: res.ok, data: data };
                });
            })
            .then(function (r) {
                // Mezitím přišla novější změna — tuhle odpověď zahodit.
                if (moje !== poradi) return;
                beziPozadavek = false;

                if (!r.ok) {
                    chyba = chybovyText(r.data);
                    vysledek = null;
                } else {
                    chyba = null;
                    vysledek = r.data;
                }
                vykresliVysledek();
            })
            .catch(function () {
                if (moje !== poradi) return;
                beziPozadavek = false;
                chyba = 'Výpočet se nepodařilo načíst. Zkuste to prosím za chvíli.';
                vysledek = null;
                vykresliVysledek();
            });
    }

    /**
     * Chybová hláška pro zákazníka. Worker vrací KÓDY, ne texty —
     * překlad je tady, aby se dal měnit bez zásahu do backendu.
     */
    function chybovyText(data) {
        var kod = data && (data.error || data.reason);
        var texty = {
            MISSING_IDEAL_WEIGHT: 'Pro psa s nadváhou potřebujeme znát jeho ideální hmotnost.',
            invalid_weight: 'Zkontrolujte prosím hmotnost psa.',
            invalid_age: 'Zkontrolujte prosím věk psa.',
            invalid_request: 'Některý z údajů není vyplněný správně.',
        };
        return texty[kod] || 'Údaje se nepodařilo zpracovat. Zkontrolujte prosím vyplněné hodnoty.';
    }

    function profilZeStavu() {
        return {
            jmeno: stav.jmeno || null,
            hmotnostKg: stav.hmotnostKg,
            idealniHmotnostKg: stav.kondice === 'OVER' ? stav.idealniHmotnostKg : null,
            vekMesicu: stav.vekMesicu,
            pohlavi: stav.pohlavi,
            kastrovany: stav.kastrovany,
            aktivita: stav.aktivita,
            aktivitaDetail: stav.aktivitaDetail,
            kondice: stav.kondice,
            fyziologickyStav: stav.fyziologickyStav,
            diagnozy: stav.diagnozy,
            alergie: stav.alergie,
            problemSeZuby: stav.problemSeZuby,
            velkePlemenoStene: stav.velkePlemenoStene && stav.vekMesicu < VEK_STENE_DO_MESICU,
            prechodZGranuli: stav.prechodZGranuli,
        };
    }

    // ---------------------------------------------------------------
    // Vložení do košíku
    // ---------------------------------------------------------------

    /**
     * Potvrzení vložení z odpovědi Shoptetu (tvar ověřen naživo 2026-09-24):
     * `{ code: 200, payload: { cartItems: [{ priceId: 1751, quantity: 2, … }] } }`.
     * `quantity` je celkové množství položky v košíku, proto „aspoň".
     */
    function jeVlozeno(json, polozka) {
        if (!json || json.code !== 200 || !json.payload) return false;
        var items = json.payload.cartItems;
        if (!items || !items.length) return false;
        for (var k = 0; k < items.length; k++) {
            if (String(items[k].priceId) === String(polozka.priceId) &&
                Number(items[k].quantity) >= Number(polozka.pocet)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Vloží všechny doporučené produkty. Shoptet nemá dávkové vložení,
     * takže se posílají po jednom SEKVENČNĚ — paralelní volání si
     * navzájem přepisují stav košíku a část položek se ztratí.
     */
    function vlozVseDoKosiku(tlacitko, popisek) {
        if (!vysledek || !vysledek.produkty || !vysledek.produkty.length) return;

        // Košík potřebuje VŽDY priceId (id varianty) I productId (Lucky
        // 2026-09-24). Backend jiné produkty nedoporučí; tady je to pojistka.
        var polozky = vysledek.produkty.filter(function (p) {
            return p.priceId && p.productId && p.pocet > 0;
        });
        if (!polozky.length) {
            alert('Produkty se nepodařilo připravit k vložení do košíku.');
            return;
        }

        // Obal doručení je v e-shopu povinný — bez něj Tutani objednávku
        // nezabalí. Nevybraný = nic nevkládat a ukázat, co chybí.
        if (knowledge.obaly.length) {
            var obal = knowledge.obaly.filter(function (o) { return o.priceId === zvolenyObal; })[0];
            var volbaObalu = document.getElementById('tb-obal');
            if (!obal) {
                if (volbaObalu) {
                    volbaObalu.classList.add('tb-obal--chyba');
                    volbaObalu.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                return;
            }
            if (obalVKosiku !== obal.priceId) {
                polozky = polozky.concat([{ productId: obal.productId, priceId: obal.priceId, pocet: 1, nazev: obal.nazev, jeObal: true }]);
            }
        }

        tlacitko.disabled = true;
        var puvodni = popisek.textContent;
        var vlozeno = 0;
        var vlozenoKusu = 0;
        var selhalo = [];
        var hotovo = false;

        function dalsi(i) {
            if (i >= polozky.length) {
                hotovo = true;
                if (selhalo.length) {
                    // Zákazník musí vědět, co v košíku chybí — jinak by
                    // objednal neúplnou dávku v domnění, že je celá.
                    alert(
                        'Tyto produkty se nepodařilo přidat do košíku:\n- ' +
                            selhalo.join('\n- ') +
                            (vlozeno ? '\n\nOstatní jsou v košíku.' : '')
                    );
                }
                if (vlozeno) {
                    tlacitko.classList.add('tb-tlacitko--hotovo');
                    popisek.textContent = '✓ V košíku';
                    ukazToast(vlozenoKusu + ' ' + sklonuj(vlozenoKusu, 'balení', 'balení', 'balení') +
                        ' pro ' + jmenoZobrazene() + ' je v košíku');
                    // Bez automatického přesměrování (Lucky 2026-09-25): zákazník
                    // může zůstat (PDF, jiné období) a do košíku jde tlačítkem.
                    // Hlavička Shoptetu (počet/cena) se obnoví až načtením košíku.
                    var jdi = document.getElementById('tb-prejit-do-kosiku');
                    if (jdi) {
                        jdi.classList.add('tb-tlacitko--kosik-pripraven');
                        jdi.focus();
                    }
                } else {
                    popisek.textContent = puvodni;
                    tlacitko.disabled = false;
                }
                return;
            }
            popisek.textContent = 'Přidávám… (' + (i + 1) + '/' + polozky.length + ')';

            var telo = new URLSearchParams();
            telo.append('productId', String(polozky[i].productId));
            telo.append('priceId', String(polozky[i].priceId));
            telo.append('amount', String(polozky[i].pocet));
            telo.append('language', 'cs');
            // Shoptet má zapnutou CSRF ochranu (shoptet.csrf.enabled). Jeho
            // vlastní formuláře token vkládají jako pole `__csrf__`
            // (injectToken v shared JS) — bez něj addCartItem požadavek odmítne.
            var csrf = window.shoptet && window.shoptet.csrf;
            if (csrf && csrf.enabled && csrf.token) telo.append('__csrf__', csrf.token);

            /**
             * AJAX varianta (`X-Requested-With`) — OVĚŘENO NAŽIVO 2026-09-24:
             *   - bez ní Shoptet i při CHYBĚ vrací 302 (třeba „víc kusů,
             *     než je skladem") a nic nevloží → navenek úspěch;
             *   - s ní vrací JSON: `code: 200` + `payload.cartItems`, nebo
             *     `code: 500` + `message` (sklad, CSRF) pro zákazníka.
             * Úspěch = code 200 A naše priceId v košíku v aspoň požadovaném
             * množství. Nic jiného se za vložené nepovažuje.
             */
            var polozka = polozky[i];
            fetch(ADD_TO_CART_URL, {
                method: 'POST',
                credentials: 'same-origin',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest',
                },
                body: telo.toString(),
            })
                .then(function (res) {
                    return res.json().catch(function () {
                        return null;
                    });
                })
                .then(function (json) {
                    if (jeVlozeno(json, polozka)) {
                        if (polozka.jeObal) {
                            obalVKosiku = polozka.priceId;
                        } else {
                            vlozeno++;
                            vlozenoKusu += Number(polozka.pocet);
                        }
                    } else {
                        var duvod = json && json.message ? ' (' + json.message + ')' : '';
                        selhalo.push(polozka.nazev + duvod);
                    }
                    dalsi(i + 1);
                })
                .catch(function () {
                    // Jedna položka selhala — pokračujeme, ať zákazník
                    // nepřijde o celý košík kvůli jednomu produktu.
                    selhalo.push(polozka.nazev);
                    dalsi(i + 1);
                });
        }

        dalsi(0);

        // Pojistka: kdyby Shoptet neodpověděl, tlačítko se nesmí zaseknout.
        setTimeout(function () {
            if (!hotovo && vlozeno === 0) {
                tlacitko.disabled = false;
                popisek.textContent = puvodni;
            }
        }, 15000);
    }

    // ---------------------------------------------------------------
    // Stavební prvky
    // ---------------------------------------------------------------

    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined && text !== null) e.textContent = text;
        return e;
    }

    var SVG_NS = 'http://www.w3.org/2000/svg';
    var TLAPKA_ELIPSY = [[32, 44, 15, 12], [13, 28, 6, 8], [24.5, 15, 6, 8.5], [39.5, 15, 6, 8.5], [51, 28, 6, 8]];

    /** Tlapka z předlohy (viewBox 64×64), barva přes `currentColor`. */
    function tlapka(velikost, cls) {
        var s = document.createElementNS(SVG_NS, 'svg');
        s.setAttribute('viewBox', '0 0 64 64');
        s.setAttribute('width', String(velikost));
        s.setAttribute('height', String(velikost));
        s.setAttribute('fill', 'currentColor');
        s.setAttribute('aria-hidden', 'true');
        s.setAttribute('focusable', 'false');
        s.setAttribute('class', 'tb-tlapka' + (cls ? ' ' + cls : ''));
        TLAPKA_ELIPSY.forEach(function (e) {
            var x = document.createElementNS(SVG_NS, 'ellipse');
            x.setAttribute('cx', String(e[0]));
            x.setAttribute('cy', String(e[1]));
            x.setAttribute('rx', String(e[2]));
            x.setAttribute('ry', String(e[3]));
            s.appendChild(x);
        });
        return s;
    }

    function karta(cls) {
        return el('div', 'tb-karta' + (cls ? ' ' + cls : ''));
    }

    /** Hlavička kroku: tlapka s číslem + nadpis (+ volitelný popis). */
    function hlavickaKroku(cislo, nadpis, popis) {
        var h = el('div', 'tb-krok');
        var ikona = el('span', 'tb-krok-ikona');
        ikona.appendChild(tlapka(54));
        ikona.appendChild(el('span', 'tb-krok-cislo', cislo));
        h.appendChild(ikona);
        var texty = el('div', 'tb-krok-texty');
        texty.appendChild(el('h2', 'tb-h2', nadpis));
        if (popis) texty.appendChild(el('span', 'tb-krok-popis', popis));
        h.appendChild(texty);
        return h;
    }

    function polePole(label, prvek, napoveda) {
        var wrap = el('div', 'tb-pole');
        wrap.appendChild(el('span', 'tb-label', label));
        wrap.appendChild(prvek);
        if (napoveda) wrap.appendChild(el('p', 'tb-napoveda', napoveda));
        return wrap;
    }

    function vstupText(hodnota, onChange, placeholder, aria) {
        var i = el('input', 'tb-input');
        i.type = 'text';
        i.value = hodnota;
        i.maxLength = 40;
        i.autocomplete = 'off';
        if (placeholder) i.placeholder = placeholder;
        if (aria) i.setAttribute('aria-label', aria);
        i.addEventListener('input', function () {
            onChange(i.value);
        });
        return i;
    }

    /**
     * Dlaždice s velkou hodnotou a posuvníkem (hmotnost, věk).
     * `krokTlacitek` přidá −/+ (u hmotnosti po 0,5 kg).
     */
    function dlazdicePosuvnik(o) {
        var d = el('div', 'tb-dlazdice');
        var hlava = el('div', 'tb-dlazdice-hlava');
        hlava.appendChild(el('span', 'tb-label', o.label));
        var hodnota = el('span', 'tb-dlazdice-hodnota');
        hlava.appendChild(hodnota);
        d.appendChild(hlava);

        var i = el('input', 'tb-range');
        i.type = 'range';
        i.min = String(o.min);
        i.max = String(o.max);
        i.step = String(o.krok);
        i.value = String(o.hodnota);
        i.setAttribute('aria-label', o.label);

        function vypis(v) {
            hodnota.textContent = '';
            if (o.jednotka) {
                hodnota.appendChild(document.createTextNode(formatCislo(v) + ' '));
                hodnota.appendChild(el('small', null, o.jednotka));
            } else {
                hodnota.textContent = o.formatter(v);
            }
            i.setAttribute('aria-valuetext', o.jednotka ? formatCislo(v) + ' ' + o.jednotka : o.formatter(v));
        }
        function nastav(v) {
            v = Math.max(o.min, Math.min(o.max, Math.round(v / o.krok) * o.krok));
            v = Math.round(v * 100) / 100;
            i.value = String(v);
            vypis(v);
            o.onChange(v);
        }
        vypis(o.hodnota);
        i.addEventListener('input', function () {
            nastav(parseFloat(i.value));
        });
        d.appendChild(i);

        if (o.krokTlacitek) {
            var krokO = function (smer) {
                return typeof o.krokTlacitek === 'function' ? o.krokTlacitek(parseFloat(i.value), smer) : o.krokTlacitek;
            };
            var k = el('div', 'tb-krokovani');
            var minus = el('button', null, '−');
            minus.type = 'button';
            minus.setAttribute('aria-label', o.label + ' méně');
            minus.addEventListener('click', function () {
                nastav(parseFloat(i.value) - krokO(-1));
            });
            var plus = el('button', null, '+');
            plus.type = 'button';
            plus.setAttribute('aria-label', o.label + ' více');
            plus.addEventListener('click', function () {
                nastav(parseFloat(i.value) + krokO(1));
            });
            k.appendChild(minus);
            k.appendChild(plus);
            d.appendChild(k);
        }
        if (o.poznamka) d.appendChild(o.poznamka);
        return d;
    }

    /**
     * Segmentový přepínač. Volba = [hodnota, popisek, podtitulek?, šířkaPilulky?].
     * `sloupcu` vynutí mřížku (2 nebo 3), jinak auto-fit.
     */
    function prepinac(volby, aktivni, onChange, o) {
        o = o || {};
        var wrap = el('div', 'tb-prepinac' + (o.sloupcu ? ' tb-prepinac--' + o.sloupcu : '') + (o.trida ? ' ' + o.trida : ''));
        wrap.setAttribute('role', 'group');
        if (o.aria) wrap.setAttribute('aria-label', o.aria);
        volby.forEach(function (v) {
            var je = String(v[0]) === String(aktivni);
            var b = el('button', 'tb-volba' + (o.postava ? ' tb-volba--postava' : '') + (je ? ' tb-volba--aktivni' : ''));
            b.type = 'button';
            b.setAttribute('aria-pressed', je ? 'true' : 'false');
            if (o.postava && v[3]) {
                var p = el('span', 'tb-postava-pilulka');
                p.style.width = v[3] + 'px';
                b.appendChild(p);
            }
            b.appendChild(el('span', 'tb-volba-titulek', v[1]));
            if (v[2]) b.appendChild(el('span', 'tb-volba-pod', v[2]));
            b.addEventListener('click', function () {
                // Zvýraznění se přepne hned, ať UI nečeká na Worker.
                Array.prototype.forEach.call(wrap.children, function (c) {
                    c.classList.remove('tb-volba--aktivni');
                    c.setAttribute('aria-pressed', 'false');
                });
                b.classList.add('tb-volba--aktivni');
                b.setAttribute('aria-pressed', 'true');
                onChange(v[0]);
            });
            wrap.appendChild(b);
        });
        return wrap;
    }

    /** Řádek se zaškrtávacím čtverečkem (role=checkbox, ovládá i klávesnice). */
    function radekCheck(nazev, popis, zapnuto, onToggle, o) {
        o = o || {};
        var r = el('div', 'tb-radek-check' + (o.jednoduchy ? ' tb-radek-check--jednoduchy' : ''));
        r.setAttribute('role', 'checkbox');
        r.setAttribute('tabindex', '0');
        r.setAttribute('aria-checked', zapnuto ? 'true' : 'false');
        var box = el('span', 'tb-check-box', zapnuto ? '✓' : '');
        box.setAttribute('aria-hidden', 'true');
        r.appendChild(box);
        var texty = el('div', 'tb-check-texty');
        texty.appendChild(el('span', 'tb-check-nazev', nazev));
        if (popis) texty.appendChild(el('span', 'tb-check-popis' + (o.varovani ? ' tb-check-popis--varovani' : ''), popis));
        r.appendChild(texty);

        function prepni() {
            var nove = r.getAttribute('aria-checked') !== 'true';
            r.setAttribute('aria-checked', nove ? 'true' : 'false');
            box.textContent = nove ? '✓' : '';
            onToggle(nove);
        }
        r.addEventListener('click', prepni);
        r.addEventListener('keydown', function (e) {
            if (e.key === ' ' || e.key === 'Enter') {
                e.preventDefault();
                prepni();
            }
        });
        return r;
    }

    function prepniVSeznamu(seznam, id, zapnout) {
        var nove = seznam.slice();
        var idx = nove.indexOf(id);
        if (zapnout && idx === -1) nove.push(id);
        if (!zapnout && idx !== -1) nove.splice(idx, 1);
        return nove;
    }

    // ---------------------------------------------------------------
    // Hlavička (hero)
    // ---------------------------------------------------------------

    function jmenoZobrazene() {
        var j = (stav.jmeno || '').trim();
        return j || 'váš pes';
    }

    function vykresliHero(root) {
        var hero = el('section', 'tb-hero');

        var text = el('div', 'tb-hero-text');
        // Pravý sloupec: logo nad fotkou psa (Lucky 2026-09-25).
        var prava = el('div', 'tb-hero-prava');
        if (nastaveni.logo) {
            var logo = el('img', 'tb-logo');
            logo.src = nastaveni.logo;
            logo.alt = 'Tutani';
            logo.decoding = 'async';
            // Nedostupné logo nesmí nechat rozbitý obrázek.
            logo.addEventListener('error', function () { logo.remove(); });
            prava.appendChild(logo);
        }
        text.appendChild(el('div', 'tb-eyebrow', 'Výpočet krmné dávky · 60 sekund'));
        var h1 = el('h1', 'tb-h1');
        h1.appendChild(document.createTextNode('Kolik masa '));
        var jm = el('span', 'tb-zvyrazneni', jmenoZobrazene());
        jm.id = 'tb-hero-jmeno';
        h1.appendChild(jm);
        h1.appendChild(document.createTextNode(' sní každý den?'));
        text.appendChild(h1);
        text.appendChild(el('p', 'tb-perex',
            'Vyplňte pár údajů. Dávku, složení misky i nákup na celé období spočítáme ' +
            'okamžitě — a jedním klikem je máte v košíku.'));
        hero.appendChild(text);

        var foto = el('div', 'tb-hero-foto');
        var prstenec = el('div', 'tb-hero-prstenec');
        var vnitrek = el('div', 'tb-hero-vnitrek');
        if (nastaveni.foto) {
            var img = el('img');
            img.src = nastaveni.foto;
            img.alt = '';
            img.loading = 'lazy';
            img.decoding = 'async';
            // Rozbitá fotka nesmí nechat prázdný kruh.
            img.addEventListener('error', function () {
                vnitrek.textContent = '';
                vnitrek.appendChild(tlapka(140));
            });
            vnitrek.appendChild(img);
        } else {
            vnitrek.appendChild(tlapka(140));
        }
        prstenec.appendChild(vnitrek);
        foto.appendChild(prstenec);

        var pes = el('div', 'tb-odznak tb-odznak--pes');
        pes.appendChild(tlapka(26));
        var sl = el('div', 'tb-odznak-sloupec');
        var oj = el('span', 'tb-odznak-jmeno');
        oj.id = 'tb-odznak-jmeno';
        var op = el('span', 'tb-odznak-popis');
        op.id = 'tb-odznak-popis';
        sl.appendChild(oj);
        sl.appendChild(op);
        pes.appendChild(sl);
        foto.appendChild(pes);

        var davka = el('div', 'tb-odznak tb-odznak--davka');
        davka.setAttribute('aria-live', 'polite');
        var og = el('span', 'tb-odznak-gramy', '–');
        og.id = 'tb-odznak-gramy';
        davka.appendChild(og);
        davka.appendChild(el('span', 'tb-odznak-denne', 'denně'));
        foto.appendChild(davka);

        prava.appendChild(foto);
        hero.appendChild(prava);
        root.appendChild(hero);
        aktualizujHero();
    }

    /** Hero se aktualizuje bez překreslení — ať posuvník neztratí fokus. */
    function aktualizujHero() {
        var j = document.getElementById('tb-hero-jmeno');
        if (j) j.textContent = jmenoZobrazene();
        var oj = document.getElementById('tb-odznak-jmeno');
        if (oj) oj.textContent = jmenoZobrazene();
        var op = document.getElementById('tb-odznak-popis');
        if (op) op.textContent = formatCislo(stav.hmotnostKg) + ' kg · ' + formatVek(stav.vekMesicu);
        var og = document.getElementById('tb-odznak-gramy');
        if (og) {
            var ok = vysledek && vysledek.status === 'OK' && vysledek.davka;
            og.textContent = ok ? formatCislo(vysledek.davka.celkemGDen) + ' g' : '–';
        }
    }

    // ---------------------------------------------------------------
    // Formulář
    // ---------------------------------------------------------------

    function vykresliFormular(root) {
        // ---- 01 VÁŠ PES ----
        var k1 = karta();
        k1.appendChild(hlavickaKroku('01', 'Váš pes'));

        // Jméno — jen pro zobrazení, do výpočtu nevstupuje, nepřepočítává se.
        k1.appendChild(polePole('Jméno psa', vstupText(stav.jmeno, function (v) {
            stav.jmeno = v;
            aktualizujHero();
            var t = document.getElementById('tb-davka-titulek');
            if (t) t.textContent = 'Denní dávka · ' + jmenoZobrazene();
        }, 'např. Rex', 'Jméno psa')));

        var dl = el('div', 'tb-dlazdice-mrizka');
        dl.appendChild(dlazdicePosuvnik({
            label: 'Hmotnost', min: 1, max: 80, krok: 0.5, krokTlacitek: 0.5,
            hodnota: stav.hmotnostKg, jednotka: 'kg',
            onChange: function (v) {
                stav.hmotnostKg = v;
                // Cílová hmotnost nesmí být vyšší než aktuální.
                if (stav.kondice === 'OVER' && stav.idealniHmotnostKg > v) stav.idealniHmotnostKg = v;
                aktualizujHero();
                naplanujPrepocet();
            },
        }));
        // Poznámka pod věkem je popis pravidla, podle kterého Worker
        // dávku spočítal — ne vlastní odhad frontendu.
        var pozn = el('div', 'tb-dlazdice-pozn');
        pozn.id = 'tb-vek-pozn';
        dl.appendChild(dlazdicePosuvnik({
            label: 'Věk', min: 1, max: 240, krok: 1,
            // Pod 2 roky po měsíci (štěně), výš po roce — věk se tam ukazuje v letech.
            krokTlacitek: function (v, smer) { return (smer > 0 ? v >= 24 : v > 24) ? 12 : 1; },
            hodnota: stav.vekMesicu, formatter: formatVek, poznamka: pozn,
            onChange: function (v) {
                stav.vekMesicu = v;
                aktualizujHero();
                naplanujPrepocet();
            },
        }));
        k1.appendChild(dl);

        k1.appendChild(polePole('Pohlaví', prepinac(
            [['MALE', 'pes'], ['FEMALE', 'fena']],
            stav.pohlavi,
            function (v) {
                stav.pohlavi = v;
                if (v === 'MALE' && stav.fyziologickyStav !== 'NONE' && stav.fyziologickyStav !== 'RECOVERY') {
                    stav.fyziologickyStav = 'NONE';
                }
                prekresliVse();
                naplanujPrepocet();
            },
            { sloupcu: 2, aria: 'Pohlaví' }
        )));

        k1.appendChild(radekCheck('Kastrovaný / kastrovaná', null, stav.kastrovany, function (v) {
            stav.kastrovany = v;
            naplanujPrepocet();
        }, { jednoduchy: true }));
        root.appendChild(k1);

        // ---- 02 ŽIVOTNÍ STYL ----
        var k2 = karta();
        k2.appendChild(hlavickaKroku('02', 'Životní styl'));

        if (knowledge.aktivity.length) {
            // Konkrétní aktivity z konfigurace e-shopu; úroveň (a tím dávku)
            // určuje Worker, `aktivita` posíláme jen jako kontrolu shody.
            k2.appendChild(polePole('Co váš pes nejčastěji dělá?', prepinac(
                knowledge.aktivity.map(function (a) { return [a.id, a.nazev, a.popis]; }),
                stav.aktivitaDetail,
                function (id) {
                    var a = knowledge.aktivity.filter(function (x) { return x.id === id; })[0];
                    if (!a) return;
                    stav.aktivitaDetail = a.id;
                    stav.aktivita = a.uroven;
                    naplanujPrepocet();
                },
                { aria: 'Aktivita', sloupcu: 3, trida: 'tb-prepinac--aktivity' }
            ), 'Vyberte to, co odpovídá běžnému týdnu, ne výjimečnému víkendu.'));
        } else {
            k2.appendChild(polePole('Aktivita', prepinac(
                [
                    ['LOW', 'nízká', 'krátké venčení'],
                    ['MEDIUM', 'střední', 'hodina venku'],
                    ['HIGH', 'vysoká', 'sport, běh'],
                    ['WORKING', 'pracovní', 'lovecký, služební'],
                ],
                stav.aktivita,
                function (v) {
                    stav.aktivita = v;
                    stav.aktivitaDetail = null;
                    naplanujPrepocet();
                },
                { aria: 'Aktivita' }
            ), 'Nízká = krátké venčení. Vysoká = denně sport nebo dlouhé běhání.'));
        }

        k2.appendChild(polePole('Postava', prepinac(
            [
                ['UNDER', 'hubený', null, 26],
                ['IDEAL', 'v pořádku', null, 40],
                ['OVER', 'nadváha', null, 56],
            ],
            stav.kondice,
            function (v) {
                stav.kondice = v;
                if (v === 'OVER' && stav.idealniHmotnostKg === null) {
                    // Předvyplní se rozumný odhad, ale zákazník ho
                    // musí potvrdit — hodnotu si systém nevymýšlí.
                    stav.idealniHmotnostKg = Math.max(1, Math.round(stav.hmotnostKg * 0.85 * 2) / 2);
                }
                prekresliVse();
                naplanujPrepocet();
            },
            { sloupcu: 3, postava: true, aria: 'Postava' }
        ), 'Poznáte to podle žeber: mají být hmatatelná, ale ne vidět.'));

        // Ideální hmotnost — jen při nadváze, jinak nemá smysl.
        if (stav.kondice === 'OVER') {
            k2.appendChild(dlazdicePosuvnik({
                label: 'Jakou hmotnost by měl mít', min: 1, max: Math.max(1.5, stav.hmotnostKg), krok: 0.5,
                krokTlacitek: 0.5,
                hodnota: stav.idealniHmotnostKg || Math.max(1, Math.round(stav.hmotnostKg * 0.85)),
                jednotka: 'kg',
                poznamka: el('div', 'tb-dlazdice-pozn', 'Dávka se počítá z cílové hmotnosti, aby pes mohl zhubnout.'),
                onChange: function (v) {
                    stav.idealniHmotnostKg = v;
                    naplanujPrepocet();
                },
            }));
        }

        // Fyziologický stav — březost a laktace jen u fen.
        var stavy = [['NONE', 'nic zvláštního'], ['RECOVERY', 'po nemoci']];
        if (stav.pohlavi === 'FEMALE') {
            stavy.splice(1, 0, ['PREGNANT', 'březí'], ['LACTATING', 'kojí štěňata']);
        }
        k2.appendChild(polePole('Zvláštní stav', prepinac(stavy, stav.fyziologickyStav, function (v) {
            stav.fyziologickyStav = v;
            naplanujPrepocet();
        }, { sloupcu: 2, aria: 'Zvláštní stav' })));
        root.appendChild(k2);

        // ---- 03 ZDRAVÍ ---- (seznamy z Workeru, ne natvrdo)
        if (knowledge.diagnozy.length || knowledge.alergie.length) {
            var k3 = karta();
            k3.appendChild(hlavickaKroku('03', 'Zdraví', 'Vyberte jen to, co pes skutečně má potvrzené od veterináře.'));

            if (knowledge.diagnozy.length) {
                var seznam = el('div', 'tb-seznam-check');
                var vazne = el('div', 'tb-seznam-check tb-seznam-check--vazne');
                knowledge.diagnozy.forEach(function (m) {
                    /**
                     * Stav, který dávku zablokuje, se označí předem — zákazník
                     * má vědět, že u něj výsledek nedostane, ještě než klikne.
                     * Popis je vidět vždy (ne v `title`, na mobilu by zmizel):
                     * rozdíl mezi počátečním a pokročilým stadiem rozhoduje,
                     * jestli se dávka vůbec vydá.
                     */
                    var popis = m.blokuje
                        ? 'U tohoto stavu dávku nepočítáme — je potřeba individuální plán od veterináře.'
                        : m.popis || null;
                    var radek = radekCheck(m.nazev, popis, stav.diagnozy.indexOf(m.id) !== -1, function (zap) {
                        stav.diagnozy = prepniVSeznamu(stav.diagnozy, m.id, zap);
                        naplanujPrepocet();
                    }, { varovani: !!m.blokuje });
                    (m.blokuje ? vazne : seznam).appendChild(radek);
                });
                /**
                 * Stavy, kde dávku nevydáme, jsou schované v rozbalovátku
                 * (Lucky 2026-09-25) — ale v nabídce zůstávají: kdyby chyběly,
                 * majitel psa s cukrovkou by nic nezaškrtl a dostal dávku.
                 * Když je některý zaškrtnutý, rozbalovátko zůstane otevřené.
                 */
                if (vazne.childNodes.length) {
                    var rozbal = el('details', 'tb-rozbal');
                    if (knowledge.diagnozy.some(function (m) { return m.blokuje && stav.diagnozy.indexOf(m.id) !== -1; })) rozbal.open = true;
                    rozbal.appendChild(el('summary', 'tb-rozbal-hlava', 'Jiné vážné onemocnění (' + vazne.childNodes.length + ') — tady rozhoduje veterinář'));
                    rozbal.appendChild(vazne);
                    seznam.appendChild(rozbal);
                }
                k3.appendChild(polePole('Zdravotní potíže', seznam));
            }

            if (knowledge.alergie.length) {
                var cipy = el('div', 'tb-cipy');
                knowledge.alergie.forEach(function (m) {
                    var b = el('button', 'tb-cip');
                    b.type = 'button';
                    var zap = stav.alergie.indexOf(m.id) !== -1;
                    b.setAttribute('aria-pressed', zap ? 'true' : 'false');
                    var t = el('span', 'tb-cip-text', m.nazev);
                    var x = el('span', null, zap ? '✕' : '');
                    x.setAttribute('aria-hidden', 'true');
                    b.appendChild(t);
                    b.appendChild(x);
                    b.addEventListener('click', function () {
                        var nove = b.getAttribute('aria-pressed') !== 'true';
                        b.setAttribute('aria-pressed', nove ? 'true' : 'false');
                        x.textContent = nove ? '✕' : '';
                        stav.alergie = prepniVSeznamu(stav.alergie, m.id, nove);
                        naplanujPrepocet();
                    });
                    cipy.appendChild(b);
                });
                k3.appendChild(polePole('Nesnáší / alergie', cipy,
                    'Přeškrtnuté bílkoviny z nákupu vyřadíme a nahradíme jinými.'));
            }
            root.appendChild(k3);
        }

        // ---- 04 ZUBY A TRÁVENÍ ---- (údaje o psovi, které nejsou nemocí)
        var k4 = karta();
        k4.appendChild(hlavickaKroku('04', 'Zuby a trávení', 'Pomůže nám vybrat suroviny, které pes bezpečně zvládne.'));
        var s4 = el('div', 'tb-seznam-check');
        s4.appendChild(radekCheck('Problém se zuby nebo polykáním',
            'Chybějící či bolavé zuby, senior, hltá nebo se dáví. Vybereme jen mleté kosti.',
            stav.problemSeZuby, function (v) {
                stav.problemSeZuby = v;
                naplanujPrepocet();
            }));
        var steneRadek = radekCheck('Štěně velkého plemene',
            'V dospělosti bude vážit přes 25 kg. Upozorníme na to, co je potřeba ohlídat s veterinářem.',
            stav.velkePlemenoStene, function (v) {
                stav.velkePlemenoStene = v;
                naplanujPrepocet();
            });
        steneRadek.id = 'tb-radek-velke-plemeno';
        s4.appendChild(steneRadek);
        s4.appendChild(radekCheck('Právě přechází z granulí',
            'Poradíme, jak změnit stravu postupně, aby trávení nestávkovalo.',
            stav.prechodZGranuli, function (v) {
                stav.prechodZGranuli = v;
                naplanujPrepocet();
            }));
        k4.appendChild(s4);
        root.appendChild(k4);
        aktualizujKartuZuby();
    }

    /** Řádek „štěně velkého plemene" jen u psa mladšího 2 let. */
    function aktualizujKartuZuby() {
        var r = document.getElementById('tb-radek-velke-plemeno');
        if (r) r.style.display = stav.vekMesicu < VEK_STENE_DO_MESICU ? '' : 'none';
    }

    // ---------------------------------------------------------------
    // Výsledek
    // ---------------------------------------------------------------

    function oznacStary() {
        var box = document.getElementById('tb-vysledek');
        if (!box) return;
        if (beziPozadavek && vysledek) box.classList.add('tb-je-stary');
        if (!vysledek && !chyba) vykresliVysledek();
    }

    function vykresliVysledek() {
        var box = document.getElementById('tb-vysledek');
        if (!box) return;
        box.textContent = '';
        box.classList.remove('tb-je-stary');
        aktualizujPoznamkuVeku();
        aktualizujHero();

        if (chyba) {
            box.appendChild(kartaChyby('Ještě něco chybí', chyba));
            return;
        }

        if (!vysledek) {
            box.appendChild(el('div', 'tb-karta tb-nacitani', beziPozadavek ? 'Počítám…' : 'Vyplňte údaje o psovi.'));
            return;
        }

        // BLOCKED — dávka se záměrně nevydává.
        if (vysledek.status === 'BLOCKED') {
            ui.zobrazenoG = null;
            box.appendChild(kartaBlokovano());
            vykresliUpozorneni(box);
            vykresliDisclaimer(box);
            return;
        }

        if (vysledek.status === 'INCOMPLETE') {
            ui.zobrazenoG = null;
            box.appendChild(kartaChyby('Nemáme dost údajů', popisNeuplnosti(vysledek.reason)));
            vykresliDisclaimer(box);
            return;
        }

        box.appendChild(kartaDavky());
        vykresliUpozorneni(box);
        vykresliNakup(box);
        vykresliRecept(box);
        vykresliDisclaimer(box);
    }

    function aktualizujPoznamkuVeku() {
        var p = document.getElementById('tb-vek-pozn');
        if (!p) return;
        var d = vysledek && vysledek.status === 'OK' && vysledek.davka;
        p.textContent = d && d.pravidloPopis ? 'Počítáme jako: ' + d.pravidloPopis : '';
    }

    function kartaChyby(nadpis, text) {
        var e = karta('tb-chyba');
        e.setAttribute('role', 'alert');
        e.appendChild(el('strong', null, nadpis));
        e.appendChild(el('p', null, text));
        return e;
    }

    function kartaBlokovano() {
        var b = el('div', 'tb-davka tb-blok');
        b.appendChild(el('span', 'tb-nadtitulek', 'Individuální plán'));
        b.appendChild(el('h3', 'tb-blok-titulek', 'Tady musí rozhodnout veterinář'));
        b.appendChild(el('p', null,
            'Zdravotní stav vašeho psa vyžaduje jídelníček sestavený veterinárním nutričním ' +
            'specialistou — obecné doporučení by mohlo uškodit. Rádi s ním pomůžeme sestavit ' +
            'jídelníček z našich surovin.'));
        if (nastaveni.telefon) {
            var a = el('a', 'tb-tlacitko-volat',
                (nastaveni.kontakt ? 'Zavolat ' + nastaveni.kontakt + ' · ' : 'Zavolat · ') +
                formatTelefon(nastaveni.telefon));
            a.href = 'tel:' + nastaveni.telefon.replace(/[^\d+]/g, '');
            b.appendChild(a);
        }
        return b;
    }

    function kartaDavky() {
        var d = vysledek.davka;
        var k = el('div', 'tb-davka');
        k.appendChild(el('div', 'tb-davka-zar'));
        var wm = tlapka(260);
        wm.setAttribute('class', 'tb-tlapka tb-davka-vodoznak');
        k.appendChild(wm);

        // Hlavička: jméno + „x % z y kg".
        var hlava = el('div', 'tb-davka-hlava');
        var tit = el('span', 'tb-nadtitulek', 'Denní dávka · ' + jmenoZobrazene());
        tit.id = 'tb-davka-titulek';
        hlava.appendChild(tit);
        hlava.appendChild(el('span', 'tb-cip-procenta',
            formatProcento(d.pctPouzito) + ' % z ' + formatCislo(d.zakladHmotnostiKg) + ' kg' +
            (d.zHmotnosti === 'IDEAL' ? ' (cílová)' : '')));
        k.appendChild(hlava);

        // Velké číslo s náběhem.
        var velke = el('div', 'tb-velke-cislo');
        var gramy = el('span', 'tb-gramy');
        gramy.setAttribute('aria-label', formatCislo(d.celkemGDen) + ' gramů denně');
        velke.appendChild(gramy);
        velke.appendChild(el('span', 'tb-za-den', 'g / den'));
        var tv = el('span', 'tb-tlapka-vaha');
        // Čistě dekorativní: tlapka roste s hmotností psa.
        var vel = Math.round(30 + Math.min(80, stav.hmotnostKg) * 0.75);
        tv.style.width = vel + 'px';
        tv.style.height = vel + 'px';
        tv.appendChild(tlapka('100%'));
        velke.appendChild(tv);
        k.appendChild(velke);
        animujCislo(gramy, d.celkemGDen);

        // Složení: pruh + řádky.
        if (vysledek.slozeni && vysledek.slozeni.length) {
            var sl = el('div', 'tb-slozeni');
            var pruh = el('div', 'tb-pruh');
            pruh.setAttribute('aria-hidden', 'true');
            var radky = el('div', 'tb-slozeni-radky');
            vysledek.slozeni.forEach(function (s) {
                var barva = barvaSkupiny(s.group);
                var dil = el('div', 'tb-pruh-dil');
                dil.style.flex = Math.max(0, Number(s.pct) || 0) + ' 1 0';
                dil.style.background = barva[0];
                pruh.appendChild(dil);

                var r = el('div', 'tb-slozeni-radek');
                var c = el('span', 'tb-ctverec');
                c.style.background = barva[0];
                r.appendChild(c);
                var n = el('span', 'tb-slozeni-nazev', s.nazev);
                if (s.upraveno) {
                    var u = el('span', 'tb-upraveno', 'upraveno');
                    u.title = 'Podíl jsme upravili kvůli zdravotnímu stavu psa.';
                    n.appendChild(u);
                }
                r.appendChild(n);
                r.appendChild(el('span', 'tb-slozeni-gramy', formatCislo(s.gramy) + ' g'));
                r.appendChild(el('span', 'tb-slozeni-pct', formatProcento(s.pct) + ' %'));
                radky.appendChild(r);
            });
            sl.appendChild(pruh);
            sl.appendChild(radky);
            k.appendChild(sl);
        }

        // Porce.
        if (d.porce && d.porce.pocet > 0) {
            var p = el('div', 'tb-porce');
            p.appendChild(el('span', 'tb-porce-popis',
                d.porce.pocet + '× denně po ' + formatCislo(d.porce.gramyNaPorci) + ' g'));
            var dl = el('div', 'tb-porce-dlazdice');
            nazvyPorci(d.porce.pocet).forEach(function (kdy) {
                var t = el('div');
                t.appendChild(el('span', 'tb-porce-kdy', kdy));
                t.appendChild(el('span', 'tb-porce-g', formatCislo(d.porce.gramyNaPorci) + ' g'));
                dl.appendChild(t);
            });
            p.appendChild(dl);
            k.appendChild(p);
        }

        // Vysvětlení z auditní stopy — BEZ AI, jen výpis pravidel.
        var audit = (vysledek.audit || []).filter(function (a) {
            return a && a.vysledek;
        });
        if (audit.length) {
            var btn = el('button', 'tb-proc-tlacitko');
            btn.type = 'button';
            btn.setAttribute('aria-expanded', ui.procOtevreno ? 'true' : 'false');
            btn.setAttribute('aria-controls', 'tb-proc-obsah');
            btn.appendChild(el('span', 'tb-sipka', '▸'));
            btn.appendChild(document.createTextNode(' Proč právě ' + formatCislo(d.celkemGDen) + ' g?'));
            var ul = el('ul', 'tb-proc-obsah');
            ul.id = 'tb-proc-obsah';
            ul.hidden = !ui.procOtevreno;
            audit.forEach(function (a, idx) {
                ul.appendChild(el('li', idx === audit.length - 1 && a.krok === 'TOTAL_DOSE' ? 'tb-proc-souhrn' : null, a.vysledek));
            });
            btn.addEventListener('click', function () {
                ui.procOtevreno = !ui.procOtevreno;
                btn.setAttribute('aria-expanded', ui.procOtevreno ? 'true' : 'false');
                ul.hidden = !ui.procOtevreno;
            });
            k.appendChild(btn);
            k.appendChild(ul);
        }

        return k;
    }

    /** Náběh čísla (450 ms, ease-out) z poslední zobrazené hodnoty. */
    function animujCislo(uzel, cil) {
        cil = Number(cil) || 0;
        var od = ui.zobrazenoG === null ? cil : ui.zobrazenoG;
        var id = ++ui.animace;
        var bezPohybu = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (od === cil || bezPohybu || !window.requestAnimationFrame) {
            uzel.textContent = formatCislo(cil);
            ui.zobrazenoG = cil;
            return;
        }
        var start = null;
        uzel.textContent = formatCislo(od);
        function krok(t) {
            if (id !== ui.animace) return;
            if (start === null) start = t;
            var k = Math.min(1, (t - start) / 450);
            var e = 1 - Math.pow(1 - k, 3);
            var v = Math.round(od + (cil - od) * e);
            uzel.textContent = formatCislo(v);
            ui.zobrazenoG = v;
            if (k < 1) window.requestAnimationFrame(krok);
            else {
                uzel.textContent = formatCislo(cil);
                ui.zobrazenoG = cil;
            }
        }
        window.requestAnimationFrame(krok);
    }

    function vykresliUpozorneni(root) {
        if (!vysledek || !vysledek.upozorneni || !vysledek.upozorneni.length) return;
        vysledek.upozorneni.forEach(function (u) {
            var zav = String(u.severity || 'INFO').toLowerCase();
            var e = el('div', 'tb-upozorneni tb-upozorneni--' + zav);
            if (zav === 'serious' || zav === 'critical') e.setAttribute('role', 'alert');
            e.appendChild(el('p', null, u.text));
            if (u.requiresVet) e.appendChild(el('p', 'tb-vet', 'Doporučujeme probrat s veterinářem.'));
            root.appendChild(e);
        });
    }

    function vykresliNakup(root) {
        var panel = karta('tb-nakup');
        panel.appendChild(el('h2', 'tb-h2', 'Nákup z našich produktů'));

        // Volba období — zákazník vybírá týden, 14 dní nebo měsíc
        // (povolené hodnoty hlídá i Worker: tenant allowedPeriodDays).
        var obd = el('div', 'tb-obdobi');
        obd.setAttribute('role', 'group');
        obd.setAttribute('aria-label', 'Zásoba na');
        [[7, 'týden'], [14, '14 dní'], [30, 'měsíc']].forEach(function (v) {
            var b = el('button', null, v[1]);
            b.type = 'button';
            b.setAttribute('aria-pressed', stav.obdobiDni === v[0] ? 'true' : 'false');
            b.addEventListener('click', function () {
                if (stav.obdobiDni === v[0]) return;
                stav.obdobiDni = v[0];
                Array.prototype.forEach.call(obd.children, function (c) {
                    c.setAttribute('aria-pressed', 'false');
                });
                b.setAttribute('aria-pressed', 'true');
                prepocitej();
            });
            obd.appendChild(b);
        });
        panel.appendChild(polePole('Zásoba na', obd));

        if (vysledek.katalogNedostupny) {
            panel.appendChild(el('p', 'tb-chybi',
                'Nabídku produktů se teď nepodařilo načíst. Dávka výše platí — zkuste prosím nákup za chvíli.'));
            root.appendChild(panel);
            return;
        }

        var produkty = vysledek.produkty || [];
        var seznam = el('div', 'tb-polozky');
        var nazvySkupin = {};
        (vysledek.slozeni || []).forEach(function (s) {
            nazvySkupin[s.group] = s.nazev;
        });

        produkty.forEach(function (p) {
            var barva = barvaSkupiny(p.group);
            var r = el('div', 'tb-polozka');
            var pocet = el('span', 'tb-polozka-pocet', p.pocet + '×');
            pocet.style.background = barva[0];
            pocet.style.color = barva[1];
            r.appendChild(pocet);

            var texty = el('div', 'tb-polozka-texty');
            var a = el('a', 'tb-polozka-nazev', p.nazev);
            if (p.url) {
                a.href = p.url;
                a.target = '_blank';
                a.rel = 'noopener';
            }
            texty.appendChild(a);
            var popis = [];
            if (p.packGrams > 0) popis.push('celkem ' + formatKg(p.pocet * p.packGrams));
            if (nazvySkupin[p.group]) popis.push(nazvySkupin[p.group]);
            if (p.doplneni) popis.push('doplňuje zásobu');
            texty.appendChild(el('span', 'tb-polozka-potreba', popis.join(' · ')));
            r.appendChild(texty);

            r.appendChild(el('span', 'tb-polozka-cena', formatCislo(p.cenaCelkem) + ' Kč'));
            seznam.appendChild(r);
        });

        if (!produkty.length) {
            seznam.appendChild(el('div', 'tb-chybi', 'Pro tuto kombinaci teď nemáme skladem vhodné produkty.'));
        }

        // Nepokryté složky se PŘIZNAJÍ, nezametají se pod koberec.
        (vysledek.nepokryto || []).forEach(function (n) {
            // INSUFFICIENT_STOCK = část je v nákupu, jen sklad nestačí
            // na celé období. Říct přesně, kolik chybí — ne „nemáme".
            var text =
                n.duvod === 'INSUFFICIENT_STOCK' && n.chybiGramu
                    ? 'Pro „' + n.nazev + '“ máme skladem jen část období — chybí ' + formatKg(n.chybiGramu) + '.'
                    : 'Pro „' + n.nazev + '“ (' + formatCislo(n.gramy) + ' g denně) teď nemáme vhodný produkt — ozvěte se nám.';
            seznam.appendChild(el('div', 'tb-chybi', text));
        });
        panel.appendChild(seznam);

        if (produkty.length && vysledek.cena) {
            var soucet = el('div', 'tb-soucet');
            var levy = el('div', 'tb-soucet-levy');
            levy.appendChild(el('span', 'tb-label', 'Zásoba na ' + popisObdobi(stav.obdobiDni)));
            if (stav.obdobiDni > 0) {
                levy.appendChild(el('span', 'tb-na-den',
                    'to je ' + formatCislo(Math.round(vysledek.cena.celkemCzk / stav.obdobiDni)) + ' Kč na den'));
            }
            soucet.appendChild(levy);
            soucet.appendChild(el('span', 'tb-soucet-cena', formatCislo(vysledek.cena.celkemCzk) + ' Kč'));
            panel.appendChild(soucet);

            if (knowledge.obaly.length) {
                var obalBox = el('div', 'tb-obal');
                obalBox.id = 'tb-obal';
                obalBox.appendChild(el('span', 'tb-label', 'Obal na doručení (povinný, 0 Kč)'));
                obalBox.appendChild(prepinac(knowledge.obaly.map(function (o) { return [o.priceId, o.nazev]; }), zvolenyObal, function (v) {
                    zvolenyObal = String(v);
                    obalBox.classList.remove('tb-obal--chyba');
                }, { aria: 'Obal na doručení' }));
                obalBox.appendChild(el('span', 'tb-obal-chyba', 'Vyberte prosím obal — bez něj objednávku nezabalíme.'));
                panel.appendChild(obalBox);
            }

            var btn = el('button', 'tb-tlacitko');
            btn.type = 'button';
            btn.appendChild(tlapka(22));
            var popisek = el('span', null, 'Vložit vše do košíku · ' + formatCislo(vysledek.cena.celkemCzk) + ' Kč');
            btn.appendChild(popisek);
            btn.addEventListener('click', function () {
                vlozVseDoKosiku(btn, popisek);
            });
            panel.appendChild(btn);

            var doKosiku = el('a', 'tb-tlacitko tb-tlacitko--druhe tb-tlacitko--kosik', 'Přejít do košíku →');
            doKosiku.id = 'tb-prejit-do-kosiku';
            doKosiku.href = '/kosik/';
            panel.appendChild(doKosiku);
        }

        root.appendChild(panel);
    }

    /**
     * Recept „co dát do misky" — gramy po produktech a porcích spočítal
     * Worker (`vysledek.recept`), tady se jen vykreslí.
     */
    function vykresliRecept(root) {
        var r = vysledek && vysledek.recept;
        if (!r || !r.porce || !r.porce.length) return;
        var k = karta('tb-recept');
        k.appendChild(hlavickaKroku('✓', 'Co dát do misky', 'Gramy z produktů ve vašem nákupu. Vážte na kuchyňské váze.'));

        var mrizka = el('div', 'tb-recept-porce');
        r.porce.forEach(function (p) {
            var box = el('div', 'tb-recept-box');
            var h = el('div', 'tb-recept-hlava');
            h.appendChild(el('span', 'tb-recept-kdy', p.nazev));
            h.appendChild(el('span', 'tb-recept-celkem', formatCislo(p.celkemG) + ' g'));
            box.appendChild(h);
            var ul = el('ul', 'tb-recept-seznam');
            p.suroviny.forEach(function (s) {
                var li = el('li');
                var c = el('span', 'tb-ctverec');
                c.style.background = barvaSkupiny(s.group)[0];
                li.appendChild(c);
                li.appendChild(el('span', 'tb-recept-nazev', s.nazev));
                li.appendChild(el('span', 'tb-recept-g', formatCislo(s.gramy) + ' g'));
                ul.appendChild(li);
            });
            box.appendChild(ul);
            mrizka.appendChild(box);
        });
        k.appendChild(mrizka);

        (r.chybi || []).forEach(function (c) {
            k.appendChild(el('div', 'tb-chybi',
                'Chybí ' + c.nazev + ' (' + formatCislo(c.gramyDen) + ' g denně) — teď ji nemáme skladem v potřebném množství.'));
        });

        if (r.postup && r.postup.length) {
            var det = el('button', 'tb-proc-tlacitko');
            det.type = 'button';
            det.setAttribute('aria-expanded', ui.postupOtevreno ? 'true' : 'false');
            det.appendChild(el('span', 'tb-sipka', '▸'));
            det.appendChild(document.createTextNode(' Jak misku připravit'));
            var ol = el('ol', 'tb-proc-obsah tb-postup');
            ol.hidden = !ui.postupOtevreno;
            r.postup.forEach(function (krok) {
                ol.appendChild(el('li', null, krok));
            });
            det.addEventListener('click', function () {
                ui.postupOtevreno = !ui.postupOtevreno;
                det.setAttribute('aria-expanded', ui.postupOtevreno ? 'true' : 'false');
                ol.hidden = !ui.postupOtevreno;
            });
            k.appendChild(det);
            k.appendChild(ol);
        }

        var btn = el('button', 'tb-tlacitko tb-tlacitko--druhe');
        btn.type = 'button';
        var popisek = el('span', null, 'Stáhnout jídelníček (PDF)');
        btn.appendChild(popisek);
        btn.addEventListener('click', function () {
            stahniPdf(btn, popisek);
        });
        k.appendChild(btn);
        root.appendChild(k);
    }

    /**
     * PDF generuje Worker ze STEJNÉHO výpočtu jako /v1/davka — posílá se
     * stejný profil, frontend do PDF nic nedopočítává.
     */
    function stahniPdf(btn, popisek) {
        var puvodni = popisek.textContent;
        btn.disabled = true;
        popisek.textContent = 'Připravuji PDF…';
        fetch(API_PDF, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pes: profilZeStavu(), obdobiDni: stav.obdobiDni }),
        })
            .then(function (res) {
                var typ = res.headers.get('Content-Type') || '';
                if (!res.ok || typ.indexOf('application/pdf') === -1) throw new Error('pdf ' + res.status);
                return res.blob();
            })
            .then(function (blob) {
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = nazevPdf();
                document.body.appendChild(a);
                a.click();
                a.remove();
                setTimeout(function () {
                    URL.revokeObjectURL(url);
                }, 30000);
                popisek.textContent = puvodni;
                btn.disabled = false;
            })
            .catch(function () {
                popisek.textContent = puvodni;
                btn.disabled = false;
                alert('Jídelníček se nepodařilo připravit. Zkuste to prosím za chvíli.');
            });
    }

    function nazevPdf() {
        var slug = (stav.jmeno || '')
            .normalize('NFD')
            .replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 30);
        return 'jidelnicek' + (slug ? '-' + slug : '') + '.pdf';
    }

    function vykresliDisclaimer(root) {
        // Disclaimer přichází z Workeru — nesmí se dát odstranit
        // úpravou frontendu, proto se nepíše sem natvrdo.
        if (vysledek && vysledek.disclaimer) {
            root.appendChild(el('p', 'tb-disclaimer', vysledek.disclaimer));
        }
    }

    function popisNeuplnosti(reason) {
        var t = {
            MISSING_IDEAL_WEIGHT: 'Doplňte prosím, jakou hmotnost by pes měl mít.',
            NO_MATCHING_DOSE_RULE:
                'Pro tuto kombinaci věku a aktivity nemáme ověřené doporučení. ' +
                'Obraťte se prosím na veterináře, rádi vám pak pomůžeme s výběrem.',
        };
        return t[reason] || 'Zkontrolujte prosím vyplněné údaje.';
    }

    function ukazToast(text) {
        var t = document.getElementById('tb-toast');
        if (!t) return;
        t.textContent = '';
        var i = el('span', 'tb-toast-ikona', '✓');
        i.setAttribute('aria-hidden', 'true');
        t.appendChild(i);
        t.appendChild(document.createTextNode(text));
        t.hidden = false;
        if (ui.toastCasovac) clearTimeout(ui.toastCasovac);
        ui.toastCasovac = setTimeout(function () {
            t.hidden = true;
        }, 3200);
    }

    // ---------------------------------------------------------------
    // Formátování
    // ---------------------------------------------------------------

    function barvaSkupiny(g) {
        return BARVY_SKUPIN[g] || BARVY_SKUPIN.OTHER;
    }

    function nazvyPorci(n) {
        if (n === 1) return ['denně'];
        if (n === 2) return ['ráno', 'večer'];
        if (n === 3) return ['ráno', 'poledne', 'večer'];
        if (n === 4) return ['ráno', 'dopol.', 'odpol.', 'večer'];
        var v = [];
        for (var i = 1; i <= n; i++) v.push(i + '.');
        return v;
    }

    function popisObdobi(dni) {
        if (dni === 7) return 'týden';
        if (dni === 30) return 'měsíc';
        return dni + ' dní';
    }

    function formatCislo(n) {
        if (n === null || n === undefined || isNaN(Number(n))) return '?';
        var zaokrouhlene = Math.round(Number(n) * 10) / 10;
        var text = zaokrouhlene % 1 === 0 ? String(zaokrouhlene) : zaokrouhlene.toFixed(1).replace('.', ',');
        // Tisíce se oddělují nezlomitelnou mezerou (české pravidlo).
        return text.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    }

    function formatKg(gramy) {
        return formatCislo(Math.round(Number(gramy) / 100) / 10) + ' kg';
    }

    function formatProcento(n) {
        if (n === null || n === undefined) return '?';
        return String(Math.round(Number(n) * 100) / 100).replace('.', ',');
    }

    function formatTelefon(t) {
        var c = String(t).replace(/[^\d+]/g, '');
        var m = c.match(/^(\+420)(\d{3})(\d{3})(\d{3})$/);
        return m ? m[1] + ' ' + m[2] + ' ' + m[3] + ' ' + m[4] : String(t);
    }

    /** Věk lidsky: štěňata v měsících, dospělí v letech. */
    function formatVek(mesice) {
        if (mesice < 24) return mesice + ' ' + sklonuj(mesice, 'měsíc', 'měsíce', 'měsíců');
        var roky = Math.floor(mesice / 12);
        return roky + ' ' + sklonuj(roky, 'rok', 'roky', 'let');
    }

    function sklonuj(n, jeden, dva, pet) {
        if (n === 1) return jeden;
        if (n >= 2 && n <= 4) return dva;
        return pet;
    }

    // ---------------------------------------------------------------
    // Start
    // ---------------------------------------------------------------

    function vykresliPozadi(root) {
        var p = el('div', 'tb-pozadi-vrstva');
        p.setAttribute('aria-hidden', 'true');
        for (var i = 1; i <= 4; i++) p.appendChild(el('div', 'tb-skvrna tb-skvrna--' + i));
        [180, 90, 120, 70, 150].forEach(function (v, idx) {
            var t = tlapka(v);
            t.setAttribute('class', 'tb-tlapka tb-tlapka-pozadi tb-tlapka-pozadi--' + (idx + 1));
            p.appendChild(t);
        });
        root.appendChild(p);
    }

    function prekresliVse() {
        var root = document.getElementById(KONTEJNER_ID);
        if (!root) return;
        root.textContent = '';
        vykresliPozadi(root);
        vykresliHero(root);

        var mrizka = el('div', 'tb-mrizka');
        var levy = el('div', 'tb-formular');
        vykresliFormular(levy);
        var pravy = el('aside', 'tb-vysledky');
        pravy.setAttribute('aria-label', 'Výsledek výpočtu');
        var vysl = el('div', null);
        vysl.id = 'tb-vysledek';
        vysl.setAttribute('aria-live', 'polite');
        pravy.appendChild(vysl);
        mrizka.appendChild(levy);
        mrizka.appendChild(pravy);
        root.appendChild(mrizka);

        var toast = el('div', 'tb-toast');
        toast.id = 'tb-toast';
        toast.setAttribute('role', 'status');
        toast.hidden = true;
        root.appendChild(toast);

        vykresliVysledek();
    }

    function nactiFonty() {
        if (document.querySelector('link[data-tb-fonty]')) return;
        var l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = FONTY_URL;
        l.setAttribute('data-tb-fonty', '');
        document.head.appendChild(l);
    }

    function nactiNastaveni(root) {
        var d = root.dataset || {};
        // Fotka jen z https — nic jiného se do `src` nepustí.
        if (d.foto && /^https:\/\//i.test(d.foto)) nastaveni.foto = d.foto;
        // Logo: jen https; prázdný atribut logo vypne.
        if (d.logo !== undefined) nastaveni.logo = /^https:\/\//i.test(d.logo) ? d.logo : null;
        if (d.telefon !== undefined) nastaveni.telefon = /^[+\d\s]{9,20}$/.test(d.telefon) ? d.telefon : null;
        if (d.kontakt !== undefined) nastaveni.kontakt = d.kontakt.slice(0, 30) || null;
    }

    function start() {
        var root = document.getElementById(KONTEJNER_ID);
        if (!root) return;

        nactiFonty();
        nactiNastaveni(root);
        prekresliVse();

        // Seznam diagnóz a alergií z Workeru. Výpočet na něm nezávisí,
        // takže se nečeká — formulář je použitelný hned a zdravotní
        // volby se doplní, až odpověď přijde.
        fetch(API_KNOWLEDGE, { cache: 'no-store' })
            .then(function (r) {
                return r.ok ? r.json() : null;
            })
            .then(function (d) {
                if (!d) return;
                /**
                 * Worker posílá `diagnoses`/`allergens` s poli layNameCs,
                 * explainCs, severity (CRITICAL = dávku nevydáme). Náhled
                 * a starší mock mají české klíče — sjednotí se na jeden tvar.
                 * CHYBA 25. 9.: frontend četl jen `diagnozy`, na produkci tak
                 * nemoci ani alergie nebyly vidět vůbec.
                 */
                function sjednot(m) {
                    return {
                        id: m.id,
                        nazev: m.nazev || m.layNameCs || m.nameCs,
                        popis: m.popis || m.explainCs || null,
                        blokuje: m.blokuje === true || m.severity === 'CRITICAL',
                    };
                }
                // Nahoře nemoci, u kterých dávku spočítáme; ty, kde ji nevydáme,
                // až dole (Lucky 2026-09-25). V obou skupinách abecedně.
                knowledge.diagnozy = (d.diagnozy || d.diagnoses || []).map(sjednot).sort(function (a, b) {
                    if (a.blokuje !== b.blokuje) return a.blokuje ? 1 : -1;
                    return String(a.nazev).localeCompare(String(b.nazev), 'cs');
                });
                knowledge.alergie = (d.alergie || d.allergens || []).map(sjednot);
                knowledge.aktivity = d.aktivity || [];
                knowledge.obaly = (d.obaly || []).filter(function (o) { return o.priceId && o.productId; });
                // Výchozí volba = první konkrétní aktivita se stejnou úrovní,
                // jakou má formulář teď (střední → „hodina venku").
                if (!stav.aktivitaDetail && knowledge.aktivity.length) {
                    var vychozi = knowledge.aktivity.filter(function (a) { return a.uroven === stav.aktivita; })[0];
                    if (vychozi) stav.aktivitaDetail = vychozi.id;
                }
                prekresliVse();
            })
            .catch(function () {
                // Bez seznamu diagnóz konfigurátor funguje dál, jen bez
                // zdravotních voleb — lepší než rozbitá stránka.
            });

        prepocitej();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', start);
    } else {
        start();
    }
})();
