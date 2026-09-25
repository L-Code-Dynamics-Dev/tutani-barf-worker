# Otázky k BARF Enginu — Tutani

Dobrý den,

Engine pro výpočet dávek je hotový a otestovaný. Než ho ale spustíme naostro, potřebujeme od Vás potvrdit několik věcí. Rozdělil jsem je na dvě části: první je pro Vašeho veterináře (odborná rozhodnutí, která nemůžeme udělat za něj), druhá je na Vás (informace o produktech a metodice).

Rozsah: 8 otázek na veterináře, 5 na Vás. U každé píšu, co jsme zatím nastavili a proč, abyste to mohli jen odsouhlasit nebo opravit.

---

## ČÁST 1 — Otázky pro veterináře

### 1. Nemocné ledviny: kolik kostí je ještě bezpečné?

Psi s chronickým onemocněním ledvin nesmí dostávat moc fosforu. Ten je v BARF stravě hlavně v mletých kostech.

Odborné zdroje udávají limit fosforu v jednotkách, které se na množství kostí nedají přepočítat přímo. My jsme proto odhadli, že u takového psa snížíme podíl mletých kostí z běžných 10 % na 8 % (tedy zhruba o pětinu méně fosforu z kostí).

**Je tenhle odhad odborně v pořádku, nebo máte vlastní hodnotu, kterou máme použít?**

Dokud to nepotvrdíte, bereme toto pravidlo jen jako orientační.

---

### 2. Nemocné ledviny: má se Engine ptát na stadium nemoci?

Onemocnění ledvin se dělí na čtyři stadia podle závažnosti. Náš systém s tím počítá takto:

- **Stadium 1 a 2** (lehčí) — dávku spočítáme, ale s omezením fosforu podle otázky výše.
- **Stadium 3 a 4** (těžší) — dávku vůbec nevydáme a odkážeme majitele na veterináře, protože tam už je potřeba speciální dieta, ne BARF podle Enginu.

Problém je, že tohle předpokládá, že majitel stadium psa zná.

**Má se Engine na stadium ptát? A když majitel odpoví „nevím" — má systém raději zvolit bezpečnější variantu a dávku nevydat?**

---

### 3. Zánět slinivky: jaká je hranice tuku?

Psi po zánětu slinivky nesmí dostávat tučné krmivo. Odborné zdroje mluví o hranici zhruba 10 % tuku v sušině, u těžších případů 5–8 %.

Problém: **v katalogu Tutani u produktů není uveden obsah tuku.** Engine proto dnes rozhoduje jen podle druhu suroviny — preferuje libové maso a vylučuje to, o čem víme, že je tučné. Přesně počítat to zatím neumí.

**Jakou hranici máme nastavit, až budou čísla o tuku k dispozici?**

(Doplnění tuku k produktům je na straně Tutani — viz otázka 9 v druhé části.)

---

### 4. Nemocná játra: máme omezovat bílkoviny?

Tohle nelze rozhodnout plošně. Záleží na konkrétní diagnóze — jiný postup je u hromadění mědi v játrech, jiný u zkratu jaterní žíly, jiný u zánětu.

**Engine proto dnes bílkoviny neomezuje vůbec** a místo toho majitele odkáže na veterináře. Důvod: plošné omezení bílkovin může psovi ublížit víc, než pomoct.

**Potvrzujete tento opatrný postup, nebo si přejete něco nastavit jinak?**

---

### 5. Alergie na drůbež: řešit ptáky dohromady, nebo zvlášť?

Když majitel zadá, že pes má alergii na drůbež, Engine dnes vyřadí **kuřecí, krůtí i kachní najednou.**

Zvolili jsme to takhle záměrně, protože odborná literatura nemá jasná čísla o tom, jestli pes alergický na kuřecí snese krůtí. Radši jsme opatrní.

**Souhlasíte s tím, nebo se mají jednotlivé druhy drůbeže rozlišovat samostatně?**

---

### 6. Jód a chlór: chybí nám zdrojová data

Engine kontroluje, jestli dávka pokrývá potřebné živiny. U dvou z nich — **jódu a chlóru** — ale nemáme čísla, protože je mezinárodní potravinové databáze u masa, vajec a ryb systematicky neměří. Není to naše chyba, ta data prostě nikde nejsou.

**Má veterinář přístup k jinému spolehlivému zdroji těchto hodnot, nebo počítáme s laboratorním rozborem konkrétních surovin?**

Dokud to nevyřešíme, u těchto dvou živin Engine nikdy neřekne „v pořádku" — vždycky napíše „neznámé".

---

### 7. Je rozsah nemocí správný?

Engine dnes umí pracovat s těmito stavy:

| Kategorie | Co konkrétně |
|---|---|
| Ledviny | stadium 1–2, stadium 3–4 |
| Slinivka | zánět slinivky |
| Játra | jaterní onemocnění, zkrat jaterní žíly, hromadění mědi |
| Alergie | 5 typů (drůbež, hovězí, obiloviny a další) |
| Ostatní | toxické potraviny, rekonvalescence, březost, laktace |

Celkem 15 stavů, 42 pravidel.

**Je tento rozsah pro první verzi ten správný? Chybí něco důležitého, nebo je něco navíc?**

---

### 8. Kdo pravidla odborně schválí?

Všech 42 pravidel je hotových a naprogramovaných, ale zatím je **neschválil nikdo s veterinární autoritou.** Sestavili jsme je podle odborné literatury, ale to pro ostré spuštění nestačí.

**Projde je Váš veterinář a podepíše se pod ně jako odborný garant?**

Tohle považujeme za podmínku spuštění — Engine radí lidem, čím krmit nemocného psa, a za tím musí stát odborník.

---

## ČÁST 2 — Otázky na Vás (Tutani)

### 9. Doplnit obsah tuku k produktům

Bez čísel o obsahu tuku nemůžeme zapnout přesné filtrování pro psy se zánětem slinivky (viz otázka 3). Můžete tyto údaje doplnit do e-shopu?

---

### 10. Překryvy v tabulce procent (tohle je nejdůležitější)

Tohle jsme se ptali už 8. září a zatím nemáme odpověď. **Bez toho Engine u části psů neví, kolik má vydat.**

V tabulce, kterou jste nám dodali, spadá jeden pes někdy do dvou různých pásem zároveň. Například:

- **Kastrovaný dospělý pes s vysokou aktivitou** → sedí do pásma „kastrovaný" (1,5–2 %) i do pásma „vysoká aktivita" (2,5–3,5 %). To je rozdíl skoro na dvojnásobek dávky.
- **Senior s vysokou aktivitou**
- **Laktující fena s nadváhou**

**Náš návrh:** rozhoduje ten popis, který psa vystihuje nejpřesněji. A fyziologický stav (březost, kojení) má přednost před kondicí (nadváha, hubenost) — protože březá fena prostě potřebuje jíst.

**Potvrdíte tento návrh, nebo máte vlastní pravidlo?**

---

### 11. Senior s vysokou aktivitou nemá v tabulce místo

V dodané tabulce je senior uveden jen v kombinaci s nízkou aktivitou. Aktivní starší pes tam prostě chybí.

**Takový pes dnes od Enginu nedostane žádnou dávku.** Nechtěli jsme to odhadovat sami — jaké procento má platit?

---

### 12. Nejasnosti u tří produktů

- **Dromy Ascokelp 360 g** — v adrese produktu je „Ascokelp 360 g", ale na stránce „Dromy D-Tox 300g". Nesouhlasí název ani gramáž. Který údaj je správný?
- **Konopný olej 500 ml** — máte v katalogu „Dromy Konopný olej" a „Konopný olej pro psy". Je to jeden produkt, nebo dvě různé značky?
- **TUT181 Multivitamín** — chybí nám údaje ze štítku (vápník, fosfor, vitaminy). Můžete poslat?

---

### 13. Jak rozlišovat játra a ostatní orgány?

Metodika BARF počítá játra a ostatní vnitřnosti odděleně (5 % a 5 %). U některých produktů z katalogu nejde jednoznačně určit, do které skupiny patří. Projdeme je společně?

---

## Co bude následovat

Jakmile dostaneme odpovědi, potřebujeme ještě z naší strany:

.
Nasadit systém na ostrý provoz (zatím běžel jen u nás v testech).
a otestovat funknost vuci kosiku, katalogu atd.

S pozdravem
Jan Lančarič, L-Code Dynamics
