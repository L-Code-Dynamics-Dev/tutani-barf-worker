# Výpočet krmné dávky pro tutani.cz — jak to postavíme a proč

Pro: Ladislav Švihel, tutani.cz
Od: L-Code Dynamics
Datum: 8. 9. 2026

## Váš podklad je dobrý základ

Metodika, kterou jste poslal, je použitelná — procenta podle věku
a aktivity, rozpad na svalovinu, kosti, játra, orgány a zeleninu,
i pořadí otázek. Z toho vycházíme a zůstáváte autorem odborné části.

Tři věci se ale v ChatGPT vyřešit nedají, a jsou to přesně ty, na
které jste narazil:

1. **Napojení na váš katalog.** Sám píšete, že to má hledat výhradne
   ve vašich produktech. To umělá inteligence zaručit neumí — pokud
   nějaký produkt nezná, vymyslí si ho, nebo doporučí obecně
   „kvalitní hovězí svalovinu" a zákazník ji koupí u konkurence.
2. **Spolehlivý výpočet.** Jazykové modely v počtech chybují a nikdy
   se nepřiznají. U krmné dávky pro nemocného psa to není detail.
3. **Kam to nahrát.** ChatGPT vám dalo text pokynů, ne aplikaci.
   Neexistuje k tomu program, který by šel umístit na váš web.

## Proč to stavíme bez umělé inteligence

Tohle je nejdůležitější rozhodnutí celého projektu, tak ho vysvětlíme
polopaticky.

### Umělá inteligence hádá. Náš systém ví.

Když se zeptáte ChatGPT na dávku pro psa s nemocnými ledvinami,
dostanete odpověď, která zní odborně. Vypadá to jako znalost. Ale
model si ji skládá z toho, co kdysi viděl na internetu — a nikdy
vám neřekne, odkud ji má, jakým pravidlem se řídil, ani že si
polovinu domyslel.

Náš systém to má naopak. Každé číslo má důvod, který jde ukázat:

```
Rex, 24 kg → 540 g na den
├─ 2,25 % z tělesné hmotnosti   ← dospělý pes, střední aktivita
├─ kosti sníženy z 10 % na 8 %  ← pravidlo pro nemocné ledviny (fosfor)
├─ kuřecí maso vyloučeno        ← alergie zadaná majitelem
└─ zdroj: metodika Tutani v1.0, aktualizováno 8. 9. 2026
```

To není slabší než umělá inteligence. Je to **silnější, protože se
to dá obhájit** — před zákazníkem i před veterinářem.

### Znalost bude ve pravidlech, ne v modelu

Tady je pointa: **pravidla píše člověk, který tomu rozumí — vy,
případně váš veterinář.** Ne model, který někde přečetl fórum.

Když víte, že se u nemocných ledvin snižuje fosfor, zapíšeme to jako
pravidlo. To pravidlo pak platí vždycky, stejně, pro každého psa.
Nikdy se nezmění tím, jak zákazník otázku napsal, a nikdy se
neztratí v dlouhém rozhovoru.

Jazykový model vám tu samou věc odpoví desetkrát a bude to desetkrát
trochu jinak.

**Vaše odbornost je ta inteligence. Systém je jen způsob, jak ji
spolehlivě zopakovat tisíckrát denně.** Umělá inteligence by ji
nahradila něčím průměrným, posbíraným odjinud.

### Tři věci, které náš systém umí a AI ne

**Neporadí špatně, protože si nemá z čeho vymýšlet.**
Když pro nějaký stav pravidlo neexistuje, systém řekne „na tohle
potřebujete veterináře". Model v té situaci odpoví — a odpověď si
vymyslí. Právě u zdravotních věcí je „nevím" správná odpověď, a AI
ji neumí.

**Prodává jen to, co máte na skladě.**
Systém vybírá z vašeho katalogu, protože jiný nezná. Navíc vidí
dostupnost — co není skladem, nedoporučí.

**Dá se zkontrolovat a opravit.**
Když se v pravidle najde chyba, opraví se jedno pravidlo a je to
vyřešené u všech budoucích výpočtů. U modelu není co opravit — jen
doufáte, že příště odpoví jinak.

### Kde umělou inteligenci naopak používat

Aby to nebyla ideologie: AI je dobrá tam, kde je nepřesnost
v pořádku — přeformulovat text, navrhnout popisek produktu, roztřídit
e-maily. Tam má smysl.

Krmná dávka pro nemocné zvíře tam nepatří. Není to o tom, že AI je
špatná — je to špatný nástroj na tuhle práci. Kalkulačku taky
nenahradíte někým, kdo dobře tipuje.

## Jak to bude fungovat pro zákazníka

Místo deseti otázek za sebou dostane **jednu obrazovku**, kde vyplní
údaje o psovi a hned vedle vidí výsledek, který se přepočítává při
každé změně:

```
┌─ VÁŠ PES ───────────────┐  ┌─ DENNÍ DÁVKA ────────────┐
│ Jméno    Rex            │  │      540 g / den          │
│ Váha     24 kg          │  │   2,25 % z 24 kg          │
│ Věk      3 roky         │  ├───────────────────────────┤
│ Aktivita střední        │  │ Svalové maso      405 g   │
│ Kondice  ideální        │  │ Mleté kosti        43 g   │
│ Kastrovaný  ne          │  │ Játra              27 g   │
│ Zdraví, alergie …       │  │ Ostatní orgány     27 g   │
└─────────────────────────┘  │ Zelenina a ovoce   38 g   │
                             │ 2 porce po 270 g          │
                             └───────────────────────────┘
      ┌─ NÁKUP Z VAŠICH PRODUKTŮ ───────────────┐
      │ Hovězí svalovina 1 kg   × 13   2 717 Kč │
      │ Drůbeží kosti           × 2      162 Kč │
      │ …                                        │
      │ Zásoba na 30 dní        CELKEM 3 240 Kč │
      │           [ Vložit vše do košíku ]       │
      └──────────────────────────────────────────┘
```

Zákazník tedy neodejde s číslem, ale **s naplněným košíkem**. To je
pro vás ten rozdíl mezi kalkulačkou a prodejním nástrojem.

Kdo chce vysvětlení, rozklikne si „proč právě 540 g" a uvidí ty
kroky výše. Bez umělé inteligence, jen výpis pravidel, která se
uplatnila.

## Bezpečnost a odpovědnost

Zabudováno v systému, ne jen v textu na stránce:

- **nikdy vařené kosti** — nebezpečí střepů, tvrdý zákaz ve výpočtu
- **toxické potraviny** (hrozny, rozinky, cibule, česnek, čokoláda,
  xylitol, avokádo, makadamové ořechy) jsou vedeny jako data a
  automaticky vylučují produkt
- **alergie** zadaná majitelem vyřadí každý produkt s danou surovinou
- **u závažných onemocnění** systém dávku nevydá a odkáže na
  veterinárního nutričního specialistu — je lepší neporadit nic než
  poradit špatně
- **každý výsledek** je označen jako orientační s doporučením
  konzultace s veterinářem, a nedá se to odstranit úpravou stránky

## Co už máme ověřené

Prošli jsme váš e-shop a dobrá zpráva: **je na to připravený lépe,
než jsme čekali.**

- vaše kategorie odpovídají složkám BARF dávky 1:1 (svalovina, kosti,
  vnitřnosti, přílohy, ryby)
- u produktů umíme automaticky přečíst kód, cenu, hmotnost balení,
  dostupnost i výrobce
- u části produktů je v popisu i složení (`Složení: 100% kuřecí
  srdíčka`) — to je přesně to, co potřebujeme pro filtr alergií

**Nemusíte nám tedy nic exportovat ani posílat.** Katalog si systém
načte sám a bude se aktualizovat každou noc. Když přidáte produkt,
objeví se v doporučeních bez vaší práce.

## Co od vás potřebujeme

Tři věci, a všechny jsou odborné rozhodnutí, které nechceme udělat
za vás:

**1. Vyjasnit překryvy v tabulce procent.**
Ve vaší metodice se některá pásma potkávají a systém by musel hádat:

| situace | pásmo A | pásmo B |
|---|---|---|
| kastrovaný dospělý s **vysokou** aktivitou | 1,5–2 % (kastrovaný) | 2,5–3,5 % (vysoká aktivita) |
| senior s vysokou aktivitou | 1,5–2 % (senior) | 2,5–3,5 % (vysoká aktivita) |
| fena v laktaci s nadváhou | 1–1,5 % (nadváha) | 4–6 % (laktace) |

Navrhujeme pravidlo: rozhoduje vždy nejkonkrétnější popis psa, a
fyziologický stav (březost, laktace) má přednost před kondicí —
laktující fena s nadváhou se nesmí hladovět. **Potřebujeme vaše
potvrzení, nebo vaši verzi.**

**2. Rozsah nemocí do první verze.**
„Nemoci" je otevřený seznam. Řekněte nám, které stavy mají být
v první verzi (typicky ledviny, slinivka, jaterní potíže, alergie),
ať víme, co nacenit. Další se přidávají kdykoli později bez
programování.

**3. U vnitřností rozlišit játra a ostatní orgány.**
V metodice mají oddělených 5 % a 5 %. U většiny produktů to poznáme
ze složení, u nejednoznačných budeme potřebovat vaše zařazení.

## Postup

Rozdělíme to do fází, ať vidíte výsledek dřív, než schválíte celek:

| fáze | co dostanete |
|---|---|
| **A** | výpočet dávky podle vaší metodiky, včetně ošetření překryvů |
| **B** | automatické napojení na váš katalog, doporučení konkrétních produktů a naplnění košíku |
| **C** | zdravotní pravidla, alergie, bezpečnostní vrstva |
| **D** | konfigurátor na webu v designu vašeho e-shopu |

Po fázích A+B máte funkční nástroj, který počítá dávku a plní košík
z vašich produktů. C a D navazují.

## Provoz

Systém běží na Cloudflare, na naší existující infrastruktuře —
**žádné náklady na hosting ani server na vaší straně**, žádná zátěž
pro váš e-shop. Katalog se synchronizuje automaticky.

---

Rádi to probereme telefonicky. Nacenění pošleme zvlášť, podle
rozsahu nemocí, na kterém se dohodneme v bodě 2.
