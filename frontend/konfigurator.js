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
 * Nasazení: vložit jako <script defer src="..."> do šablony Shoptetu
 * a na stránku dát <div id="tutani-barf"></div>.
 */
(function () {
    'use strict';

    var WORKER_BASE = 'https://tutani-barf.hlancaric.workers.dev';
    var API_DAVKA = WORKER_BASE + '/v1/davka';
    var API_KNOWLEDGE = WORKER_BASE + '/v1/knowledge';
    var ADD_TO_CART_URL = '/action/Cart/addCartItem/';

    var KONTEJNER_ID = 'tutani-barf';

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
        kondice: 'IDEAL',
        fyziologickyStav: 'NONE',
        diagnozy: [],
        alergie: [],
        obdobiDni: 30,
    };

    /** Poslední odpověď Workeru — vykresluje se z ní, nepočítá se. */
    var vysledek = null;
    var chyba = null;
    var beziPozadavek = false;
    /** Diagnózy a alergie z Workeru; frontend je nemá natvrdo. */
    var knowledge = { diagnozy: [], alergie: [] };

    // ---------------------------------------------------------------
    // Komunikace s Workerem
    // ---------------------------------------------------------------

    /**
     * Debounce: zákazník tahá posuvníkem hmotnosti a nechceme na každý
     * pixel volat Worker. 250 ms je pod hranicí, kdy to působí líně.
     */
    var casovac = null;
    function naplanujPrepocet() {
        if (casovac) clearTimeout(casovac);
        casovac = setTimeout(prepocitej, 250);
    }

    /** Pořadové číslo požadavku — starší odpověď nesmí přebít novější. */
    var poradi = 0;

    function prepocitej() {
        var moje = ++poradi;
        beziPozadavek = true;
        vykresliVysledek();

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
            kondice: stav.kondice,
            fyziologickyStav: stav.fyziologickyStav,
            diagnozy: stav.diagnozy,
            alergie: stav.alergie,
        };
    }

    // ---------------------------------------------------------------
    // Vložení do košíku
    // ---------------------------------------------------------------

    /**
     * Vloží všechny doporučené produkty. Shoptet nemá dávkové vložení,
     * takže se posílají po jednom SEKVENČNĚ — paralelní volání si
     * navzájem přepisují stav košíku a část položek se ztratí.
     */
    function vlozVseDoKosiku(tlacitko) {
        if (!vysledek || !vysledek.produkty || !vysledek.produkty.length) return;

        var polozky = vysledek.produkty.filter(function (p) {
            return p.priceId && p.pocet > 0;
        });
        if (!polozky.length) {
            alert('Produkty se nepodařilo připravit k vložení do košíku.');
            return;
        }

        tlacitko.disabled = true;
        var puvodni = tlacitko.textContent;
        var vlozeno = 0;

        function dalsi(i) {
            if (i >= polozky.length) {
                tlacitko.textContent = 'Přidáno do košíku';
                window.location.href = '/kosik/';
                return;
            }
            tlacitko.textContent = 'Přidávám… (' + (i + 1) + '/' + polozky.length + ')';

            var telo = new URLSearchParams();
            telo.append('priceId', polozky[i].priceId);
            telo.append('amount', String(polozky[i].pocet));

            fetch(ADD_TO_CART_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                body: telo.toString(),
            })
                .then(function () {
                    vlozeno++;
                    dalsi(i + 1);
                })
                .catch(function () {
                    // Jedna položka selhala — pokračujeme, ať zákazník
                    // nepřijde o celý košík kvůli jednomu produktu.
                    dalsi(i + 1);
                });
        }

        dalsi(0);

        // Pojistka: kdyby Shoptet neodpověděl, tlačítko se nesmí zaseknout.
        setTimeout(function () {
            if (tlacitko.disabled && vlozeno === 0) {
                tlacitko.disabled = false;
                tlacitko.textContent = puvodni;
            }
        }, 15000);
    }

    // ---------------------------------------------------------------
    // Vykreslení
    // ---------------------------------------------------------------

    function el(tag, cls, text) {
        var e = document.createElement(tag);
        if (cls) e.className = cls;
        if (text !== undefined && text !== null) e.textContent = text;
        return e;
    }

    function vykresliFormular(root) {
        var panel = el('div', 'tb-panel tb-panel--form');
        panel.appendChild(el('h2', 'tb-h2', 'Váš pes'));

        // Jméno — jen pro zobrazení, do výpočtu nevstupuje.
        panel.appendChild(
            polePole('Jméno psa', vstupText(stav.jmeno, function (v) {
                stav.jmeno = v;
                // Jméno výpočet neovlivní, takže se nepřepočítává —
                // jen se překreslí titulek výsledku.
                vykresliVysledek();
            }, 'např. Rex'))
        );

        // Hmotnost.
        panel.appendChild(
            polePole(
                'Hmotnost',
                vstupPosuvnik(stav.hmotnostKg, 1, 80, 0.5, ' kg', function (v) {
                    stav.hmotnostKg = v;
                    naplanujPrepocet();
                })
            )
        );

        // Věk. Zobrazuje se srozumitelně (měsíce u štěňat, roky u dospělých).
        panel.appendChild(
            polePole(
                'Věk',
                vstupPosuvnik(stav.vekMesicu, 1, 240, 1, '', function (v) {
                    stav.vekMesicu = v;
                    naplanujPrepocet();
                }, formatVek)
            )
        );

        panel.appendChild(
            polePole('Aktivita', prepinac(
                [
                    ['LOW', 'nízká'],
                    ['MEDIUM', 'střední'],
                    ['HIGH', 'vysoká'],
                    ['WORKING', 'pracovní'],
                ],
                stav.aktivita,
                function (v) {
                    stav.aktivita = v;
                    naplanujPrepocet();
                }
            ), 'Nízká = krátké venčení. Vysoká = denně sport nebo dlouhé běhání.')
        );

        panel.appendChild(
            polePole('Postava', prepinac(
                [
                    ['UNDER', 'hubený'],
                    ['IDEAL', 'v pořádku'],
                    ['OVER', 'nadváha'],
                ],
                stav.kondice,
                function (v) {
                    stav.kondice = v;
                    if (v === 'OVER' && stav.idealniHmotnostKg === null) {
                        // Předvyplní se rozumný odhad, ale zákazník ho
                        // musí potvrdit — hodnotu si systém nevymýšlí.
                        stav.idealniHmotnostKg = Math.round(stav.hmotnostKg * 0.85 * 2) / 2;
                    }
                    prekresliVse();
                    naplanujPrepocet();
                }
            ), 'Poznáte to podle žeber: mají být hmatatelná, ale ne vidět.')
        );

        // Ideální hmotnost — jen při nadvázi, protože jinak nemá smysl.
        if (stav.kondice === 'OVER') {
            panel.appendChild(
                polePole(
                    'Jakou hmotnost by měl mít',
                    vstupPosuvnik(
                        stav.idealniHmotnostKg || Math.round(stav.hmotnostKg * 0.85),
                        1,
                        Math.max(2, stav.hmotnostKg),
                        0.5,
                        ' kg',
                        function (v) {
                            stav.idealniHmotnostKg = v;
                            naplanujPrepocet();
                        }
                    ),
                    'Dávka se počítá z cílové hmotnosti, aby pes mohl zhubnout.'
                )
            );
        }

        panel.appendChild(
            polePole('Pohlaví', prepinac(
                [['MALE', 'pes'], ['FEMALE', 'fena']],
                stav.pohlavi,
                function (v) {
                    stav.pohlavi = v;
                    if (v === 'MALE' && stav.fyziologickyStav !== 'NONE' && stav.fyziologickyStav !== 'RECOVERY') {
                        stav.fyziologickyStav = 'NONE';
                    }
                    prekresliVse();
                    naplanujPrepocet();
                }
            ))
        );

        panel.appendChild(
            polePole('Kastrovaný', zaskrtavatko(stav.kastrovany, function (v) {
                stav.kastrovany = v;
                naplanujPrepocet();
            }))
        );

        // Fyziologický stav — březost a laktace jen u fen.
        var stavy = [['NONE', 'nic zvláštního'], ['RECOVERY', 'po nemoci']];
        if (stav.pohlavi === 'FEMALE') {
            stavy.splice(1, 0, ['PREGNANT', 'březí'], ['LACTATING', 'kojí štěňata']);
        }
        panel.appendChild(
            polePole('Zvláštní stav', prepinac(stavy, stav.fyziologickyStav, function (v) {
                stav.fyziologickyStav = v;
                naplanujPrepocet();
            }))
        );

        // Zdraví a alergie — seznam z Workeru, ne natvrdo.
        if (knowledge.diagnozy.length) {
            panel.appendChild(
                polePole('Zdravotní potíže', vicenasobnyVyber(
                    knowledge.diagnozy, stav.diagnozy, function (vybrane) {
                        stav.diagnozy = vybrane;
                        naplanujPrepocet();
                    }
                ), 'Vyberte jen to, co pes skutečně má potvrzené od veterináře.')
            );
        }
        if (knowledge.alergie.length) {
            panel.appendChild(
                polePole('Nesnáší / alergie', vicenasobnyVyber(
                    knowledge.alergie, stav.alergie, function (vybrane) {
                        stav.alergie = vybrane;
                        naplanujPrepocet();
                    }
                ))
            );
        }

        root.appendChild(panel);
    }

    function vykresliVysledek() {
        var box = document.getElementById('tb-vysledek');
        if (!box) return;
        box.innerHTML = '';

        if (chyba) {
            var e = el('div', 'tb-chyba');
            e.appendChild(el('strong', null, 'Ještě něco chybí'));
            e.appendChild(el('p', null, chyba));
            box.appendChild(e);
            return;
        }

        if (!vysledek) {
            box.appendChild(el('div', 'tb-nacitani', beziPozadavek ? 'Počítám…' : 'Vyplňte údaje o psovi.'));
            return;
        }

        if (beziPozadavek) box.classList.add('tb-je-stary');
        else box.classList.remove('tb-je-stary');

        // BLOCKED — dávka se záměrně nevydává.
        if (vysledek.status === 'BLOCKED') {
            var b = el('div', 'tb-blok');
            b.appendChild(el('h3', 'tb-h3', 'Tady si netroufáme radit'));
            b.appendChild(el('p', null,
                'Zdravotní stav vašeho psa vyžaduje jídelníček sestavený veterinárním ' +
                'nutričním specialistou. Obecné doporučení by mohlo uškodit.'));
            vykresliUpozorneni(b);
            box.appendChild(b);
            return;
        }

        if (vysledek.status === 'INCOMPLETE') {
            var i = el('div', 'tb-chyba');
            i.appendChild(el('strong', null, 'Nemáme dost údajů'));
            i.appendChild(el('p', null, popisNeuplnosti(vysledek.reason)));
            box.appendChild(i);
            return;
        }

        // ---- DÁVKA ----
        var d = vysledek.davka;
        var hlavni = el('div', 'tb-panel tb-panel--davka');
        hlavni.appendChild(el('h2', 'tb-h2', stav.jmeno ? 'Denní dávka pro ' + stav.jmeno : 'Denní dávka'));

        var velke = el('div', 'tb-velke-cislo');
        velke.appendChild(el('span', 'tb-gramy', formatCislo(d.celkemGDen) + ' g'));
        velke.appendChild(el('span', 'tb-za-den', 'na den'));
        hlavni.appendChild(velke);

        hlavni.appendChild(el('p', 'tb-podrobnost',
            formatProcento(d.pctPouzito) + ' % z ' + formatCislo(d.zHmotnostiKg) + ' kg' +
            (d.zHmotnosti === 'IDEAL' ? ' (cílová hmotnost)' : '')));

        hlavni.appendChild(el('p', 'tb-porce',
            d.porce.pocet + '× denně po ' + formatCislo(d.porce.gramyNaPorci) + ' g'));

        // ---- SLOŽENÍ ----
        var tab = el('table', 'tb-tabulka');
        var tbody = document.createElement('tbody');
        vysledek.slozeni.forEach(function (s) {
            var tr = document.createElement('tr');
            tr.appendChild(el('td', 'tb-nazev', s.nazev));
            tr.appendChild(el('td', 'tb-gram', formatCislo(s.gramy) + ' g'));
            var pct = el('td', 'tb-pct', formatProcento(s.pct) + ' %');
            if (s.upraveno) {
                pct.classList.add('tb-upraveno');
                pct.title = 'Podíl jsme upravili kvůli zdravotnímu stavu psa.';
            }
            tr.appendChild(pct);
            tbody.appendChild(tr);
        });
        tab.appendChild(tbody);
        hlavni.appendChild(tab);

        // Vysvětlení z auditní stopy — BEZ AI, jen výpis pravidel.
        if (vysledek.audit && vysledek.audit.length) {
            var det = el('details', 'tb-proc');
            det.appendChild(el('summary', null, 'Proč právě ' + formatCislo(d.celkemGDen) + ' g?'));
            var ul = el('ul', 'tb-proc-seznam');
            vysledek.audit.forEach(function (a) {
                if (a.vysledek) ul.appendChild(el('li', null, a.vysledek));
            });
            det.appendChild(ul);
            hlavni.appendChild(det);
        }

        box.appendChild(hlavni);
        vykresliUpozorneni(box);
        vykresliNakup(box);

        // Disclaimer přichází z Workeru — nesmí se dát odstranit
        // úpravou frontendu, proto se nepíše sem natvrdo.
        if (vysledek.disclaimer) {
            box.appendChild(el('p', 'tb-disclaimer', vysledek.disclaimer));
        }
    }

    function vykresliUpozorneni(root) {
        if (!vysledek || !vysledek.upozorneni || !vysledek.upozorneni.length) return;
        var wrap = el('div', 'tb-upozorneni-blok');
        vysledek.upozorneni.forEach(function (u) {
            var cls = 'tb-upozorneni tb-upozorneni--' + String(u.severity || 'INFO').toLowerCase();
            var e = el('div', cls);
            e.appendChild(el('p', null, u.text));
            if (u.requiresVet) {
                e.appendChild(el('p', 'tb-vet', 'Doporučujeme probrat s veterinářem.'));
            }
            wrap.appendChild(e);
        });
        root.appendChild(wrap);
    }

    function vykresliNakup(root) {
        var panel = el('div', 'tb-panel tb-panel--nakup');
        panel.appendChild(el('h2', 'tb-h2', 'Nákup z našich produktů'));

        // Volba období — mražené maso má limit mrazáku, takže měsíc
        // nemusí každému vyhovovat.
        panel.appendChild(
            polePole('Zásoba na', prepinac(
                [[7, 'týden'], [14, '14 dní'], [30, 'měsíc']],
                stav.obdobiDni,
                function (v) {
                    stav.obdobiDni = Number(v);
                    prepocitej();
                }
            ))
        );

        var produkty = vysledek.produkty || [];
        if (!produkty.length) {
            panel.appendChild(el('p', 'tb-podrobnost',
                'Pro tuto kombinaci teď nemáme skladem vhodné produkty.'));
            root.appendChild(panel);
            return;
        }

        var tab = el('table', 'tb-tabulka tb-tabulka--nakup');
        var tbody = document.createElement('tbody');
        produkty.forEach(function (p) {
            var tr = document.createElement('tr');
            var nazev = el('td', 'tb-nazev');
            var a = el('a', null, p.nazev);
            a.href = p.url;
            a.target = '_blank';
            a.rel = 'noopener';
            nazev.appendChild(a);
            tr.appendChild(nazev);
            tr.appendChild(el('td', 'tb-pocet', p.pocet + '×'));
            tr.appendChild(el('td', 'tb-cena', formatCislo(p.cenaCelkem) + ' Kč'));
            tbody.appendChild(tr);
        });
        tab.appendChild(tbody);
        panel.appendChild(tab);

        // Nepokryté složky se PŘIZNAJÍ, nezametají se pod koberec.
        if (vysledek.nepokryto && vysledek.nepokryto.length) {
            var np = el('div', 'tb-nepokryto');
            np.appendChild(el('strong', null, 'Co teď nemáme:'));
            var ul = el('ul', null);
            vysledek.nepokryto.forEach(function (n) {
                ul.appendChild(el('li', null, n.nazev + ' (' + formatCislo(n.gramy) + ' g denně)'));
            });
            np.appendChild(ul);
            panel.appendChild(np);
        }

        var soucet = el('div', 'tb-soucet');
        soucet.appendChild(el('span', 'tb-soucet-popis',
            'Zásoba na ' + stav.obdobiDni + ' dní'));
        soucet.appendChild(el('span', 'tb-soucet-cena',
            formatCislo(vysledek.cena.celkemCzk) + ' Kč'));
        panel.appendChild(soucet);

        var naDen = Math.round(vysledek.cena.celkemCzk / stav.obdobiDni);
        panel.appendChild(el('p', 'tb-na-den', 'To je ' + naDen + ' Kč na den.'));

        var btn = el('button', 'tb-tlacitko', 'Vložit vše do košíku');
        btn.type = 'button';
        btn.addEventListener('click', function () {
            vlozVseDoKosiku(btn);
        });
        panel.appendChild(btn);

        root.appendChild(panel);
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

    // ---------------------------------------------------------------
    // Ovládací prvky
    // ---------------------------------------------------------------

    function polePole(label, prvek, napoveda) {
        var wrap = el('div', 'tb-pole');
        wrap.appendChild(el('label', 'tb-label', label));
        wrap.appendChild(prvek);
        if (napoveda) wrap.appendChild(el('p', 'tb-napoveda', napoveda));
        return wrap;
    }

    function vstupText(hodnota, onChange, placeholder) {
        var i = el('input', 'tb-input');
        i.type = 'text';
        i.value = hodnota;
        if (placeholder) i.placeholder = placeholder;
        i.addEventListener('input', function () {
            onChange(i.value);
        });
        return i;
    }

    function vstupPosuvnik(hodnota, min, max, krok, jednotka, onChange, formatter) {
        var wrap = el('div', 'tb-posuvnik');
        var vypis = el('span', 'tb-hodnota',
            formatter ? formatter(hodnota) : formatCislo(hodnota) + jednotka);
        var i = el('input', 'tb-range');
        i.type = 'range';
        i.min = String(min);
        i.max = String(max);
        i.step = String(krok);
        i.value = String(hodnota);
        i.addEventListener('input', function () {
            var v = parseFloat(i.value);
            vypis.textContent = formatter ? formatter(v) : formatCislo(v) + jednotka;
            onChange(v);
        });
        wrap.appendChild(i);
        wrap.appendChild(vypis);
        return wrap;
    }

    function prepinac(volby, aktivni, onChange) {
        var wrap = el('div', 'tb-prepinac');
        volby.forEach(function (v) {
            var b = el('button', 'tb-volba' + (String(v[0]) === String(aktivni) ? ' tb-volba--aktivni' : ''), v[1]);
            b.type = 'button';
            b.addEventListener('click', function () {
                onChange(v[0]);
                // Zvýraznění se přepne hned, ať UI nečeká na Worker.
                Array.prototype.forEach.call(wrap.children, function (c) {
                    c.classList.remove('tb-volba--aktivni');
                });
                b.classList.add('tb-volba--aktivni');
            });
            wrap.appendChild(b);
        });
        return wrap;
    }

    function zaskrtavatko(hodnota, onChange) {
        var wrap = el('label', 'tb-zaskrt');
        var i = el('input');
        i.type = 'checkbox';
        i.checked = !!hodnota;
        i.addEventListener('change', function () {
            onChange(i.checked);
        });
        wrap.appendChild(i);
        wrap.appendChild(el('span', null, 'ano'));
        return wrap;
    }

    /**
     * Vícenásobný výběr se VYSVĚTLENÍM u každé volby.
     *
     * U zdravotních stavů nestačí název — majitel musí poznat, který
     * vybrat. Rozdíl mezi počátečním a pokročilým stadiem onemocnění
     * ledvin rozhoduje o tom, jestli systém dávku vůbec vydá, takže
     * text nesmí být schovaný v `title` (na mobilu se nezobrazí vůbec).
     *
     * Texty přicházejí z Workeru ze znalostní databáze — nejsou tady
     * natvrdo, aby se daly upravit bez zásahu do frontendu.
     */
    function vicenasobnyVyber(moznosti, vybrane, onChange) {
        var wrap = el('div', 'tb-multi');
        moznosti.forEach(function (m) {
            var polozka = el('div', 'tb-multi-radek');
            var lbl = el('label', 'tb-multi-item');
            var i = el('input');
            i.type = 'checkbox';
            i.checked = vybrane.indexOf(m.id) !== -1;
            i.addEventListener('change', function () {
                var nove = vybrane.slice();
                var idx = nove.indexOf(m.id);
                if (i.checked && idx === -1) nove.push(m.id);
                if (!i.checked && idx !== -1) nove.splice(idx, 1);
                onChange(nove);
            });
            lbl.appendChild(i);
            lbl.appendChild(el('span', null, m.nazev));
            polozka.appendChild(lbl);

            // Stav, který dávku zablokuje, se označí předem — zákazník
            // má vědět, že u něj výsledek nedostane, ještě než klikne.
            if (m.blokuje) {
                polozka.appendChild(el('p', 'tb-multi-blok',
                    'U tohoto stavu dávku nepočítáme — je potřeba individuální plán od veterináře.'));
            } else if (m.popis) {
                polozka.appendChild(el('p', 'tb-multi-popis', m.popis));
            }
            wrap.appendChild(polozka);
        });
        return wrap;
    }

    // ---------------------------------------------------------------
    // Formátování
    // ---------------------------------------------------------------

    function formatCislo(n) {
        if (n === null || n === undefined) return '?';
        var zaokrouhlene = Math.round(Number(n) * 10) / 10;
        var text = (zaokrouhlene % 1 === 0 ? String(zaokrouhlene) : zaokrouhlene.toFixed(1).replace('.', ','));
        // Tisíce se oddělují nezlomitelnou mezerou (české pravidlo).
        return text.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    }

    function formatProcento(n) {
        if (n === null || n === undefined) return '?';
        return String(Math.round(Number(n) * 100) / 100).replace('.', ',');
    }

    /** Věk lidsky: štěňata v měsících, dospělí v letech. */
    function formatVek(mesice) {
        if (mesice < 24) {
            return mesice + ' ' + skloňujMesic(mesice);
        }
        var roky = Math.floor(mesice / 12);
        return roky + ' ' + skloňujRok(roky);
    }

    function skloňujMesic(n) {
        if (n === 1) return 'měsíc';
        if (n >= 2 && n <= 4) return 'měsíce';
        return 'měsíců';
    }

    function skloňujRok(n) {
        if (n === 1) return 'rok';
        if (n >= 2 && n <= 4) return 'roky';
        return 'let';
    }

    // ---------------------------------------------------------------
    // Start
    // ---------------------------------------------------------------

    function prekresliVse() {
        var root = document.getElementById(KONTEJNER_ID);
        if (!root) return;
        root.innerHTML = '';
        var mrizka = el('div', 'tb-mrizka');
        var levy = el('div', 'tb-sloupec');
        vykresliFormular(levy);
        var pravy = el('div', 'tb-sloupec');
        var vysl = el('div', null);
        vysl.id = 'tb-vysledek';
        pravy.appendChild(vysl);
        mrizka.appendChild(levy);
        mrizka.appendChild(pravy);
        root.appendChild(mrizka);
        vykresliVysledek();
    }

    function start() {
        var root = document.getElementById(KONTEJNER_ID);
        if (!root) return;

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
                knowledge.diagnozy = d.diagnozy || [];
                knowledge.alergie = d.alergie || [];
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
