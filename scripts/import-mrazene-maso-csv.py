#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Spuštění: python3 scripts/import-mrazene-maso-csv.py
(čte CSV z CSV_PATH níže, zapisuje do tenants/tutani/rules/tutani-products.json)

Idempotentní: re-run se stejným CSV dá stejný výsledek — produkty mimo
CSV kategorii (BARF strava pro psy, dravci, ZOO doplňky, přílohy) se
přebírají ze STÁVAJÍCÍHO tutani-products.json (`kept_from_old`), takže
skript NENÍ samostatný zdroj pravdy pro celý dataset, jen pro kategorii
"Barf mražené maso". Po každém běhu ověřit: `npx tsc --noEmit` a
`npm test` (viz PROGRESS_LOG.md záznam k tomuto importu).

KOMPLETNÍ PŘESTAVBA tutani-products.json z autoritativního scraper
výstupu (CSV, 103 řádků, celá kategorie "mražené maso").

DŮLEŽITÉ ZJIŠTĚNÍ (Lucky poskytl CSV 2026-09-09, po sérii ručně psaných
zpráv se stejným datem): CSV je SKUTEČNÝ scraper výstup, autoritativnější
než ručně přepsané texty z konverzace. Reconciliace odhalila:

1. TUT222 Šemíkova mňamka je DOOPRAVDY 50/35/15 % (potvrzeno CSV).
   Předchozí "oprava" na 50/3,5/1,5 % podle zprávy v konverzaci byla
   CHYBNÁ — vychází z textu, který tvrdil, že vidí "aktuální stránku",
   ale neodpovídá reálnému scraperu. VRACÍME zpět na 50/35/15.

2. TUT9 (bez lomítka) = "Kachní vznášedla", NE "Krůtí vznášedla mletá".
   Suffix /N u kódu Tutani (TUT9/1, TUT9/5, TUT9/13, TUT9/15) znamená
   PĚT RŮZNÝCH produktů, ne gramážové varianty jednoho SKU, jak jsem
   dřív předpokládal. Každý má vlastní composition.

3. Řádek ZP10 v CSV byl chybně rozparsovaný (čárka v "1,5kg" v názvu
   produktu rozbila CSV sloupce) — opraveno ručně při načtení.

POSTUP: CSV je zdroj pravdy pro VŠECHNY produkty kategorie mražené
maso (103 SKU). Produkty z jiných kategorií (BARF strava pro psy,
BARF pro dravce, ZOO doplňky, BARF přílohy), které NEJSOU v CSV,
zůstávají zachované ze stávajícího datasetu — nejsou touto kategorií
pokryté a CSV o nich nic netvrdí.
"""
import csv, json

DATE = "2026-09-09"
CSV_PATH = "/Users/lucky/Downloads/tutani_mrazene_maso_extracted_2026-09-09.csv"
DATASET_PATH = "/Users/lucky/tutani-barf-worker/tenants/tutani/rules/tutani-products.json"

# --- Ingredient pattern catalog (zjednodušená verze parseIngredientComposition.ts) ---
# (ingredient_id, name_cs, species, part, [trigger substrings])
PATTERNS = [
    ("hovezi-jatra", "hovězí játra", "BEEF", "SECRETORY_LIVER", ["hovězí játra", "hovezi jatra"]),
    ("hovezi-ledvina", "hovězí ledviny", "BEEF", "SECRETORY_KIDNEY", ["ledvin"]),
    (None, "hovězí plíce", "BEEF", "SECRETORY_LUNG", ["plíce", "plice"]),
    ("hovezi-srdce", "hovězí srdce", "BEEF", "MUSCLE_ORGAN", ["srdíčk", "srdicek", "srdce"]),
    (None, "dršťky", None, "SECRETORY_TRIPE", ["dršťk", "drstk", "držk"]),
    (None, "žaludky", None, "SECRETORY_OTHER", ["žaludk", "zaludk", "žaludek"]),
    (None, "vemeno/vemínko", "BEEF", "SECRETORY_OTHER", ["vemínk", "vemink", "vemeno"]),
    ("hovezi-mlete-93-7", "hovězí ořez/svalovina", "BEEF", "MUSCLE",
        ["hovězí ořez", "hovezi orez", "ořez jako kráva", "hovězí maso", "hovězí mleté", "hovězí svalovin", "svalovina v kuse", "výběrová hovězí"]),
    ("hovezi-jatra", "hovězí jazyk", "BEEF", "MUSCLE_ORGAN", ["hovězí jazyk", "jazyk jako kráva"]),
    (None, "kosti", None, "BONE", ["kost"]),
    (None, "svalovina (druh neurčen z tohoto textu)", None, "MUSCLE", ["svalovin"]),
    (None, "játra (druh neurčen z tohoto textu)", None, "SECRETORY_LIVER", ["játra", "jatra"]),
    (None, "chrupavka", None, "CARTILAGE", ["chrupavk"]),
    (None, "kůže", None, "SKIN", ["kůže", "kuze", "kůži", "kuzi"]),
    (None, "šlachy", None, "CARTILAGE", ["šlach", "slach"]),
    (None, "kachní krky", "DUCK", "BONE", ["kachní krk", "kachni krk"]),
    (None, "kachní křídla", "DUCK", "BONE", ["kachní křídl", "kachni kridl"]),
    (None, "kachní běháky", "DUCK", "BONE", ["kachní běhák", "kachni behak"]),
    (None, "kachní čtvrtky/stehna s biskupem", "DUCK", None, ["kachní čtvrtk", "kachni ctvrtk", "stehna s biskupem"]),
    (None, "masité skelety", None, "BONE", ["skelet"]),
    (None, "stehna (druh neurčen z tohoto textu)", None, "MUSCLE", ["stehna", "stehýnk"]),
    (None, "krky (druh neurčen z tohoto textu)", None, "BONE", ["krky", "krk "]),
    (None, "křídla (druh neurčen z tohoto textu)", None, "BONE", ["křídl", "kridl"]),
    (None, "kachní žaludky", "DUCK", "SECRETORY_OTHER", ["kachní žaludk", "kachni zaludk", "kachní bachor"]),
    (None, "kachní hřbety", "DUCK", "BONE", ["kachní hřbet", "kachni hrbet"]),
    (None, "kachní srdce", "DUCK", "MUSCLE_ORGAN", ["kachní srdce", "kachni srdce", "kachní srdéčk"]),
    (None, "kachní hlavy", "DUCK", None, ["kachní hlav", "kachni hlav", "kachní mozkovn"]),
    (None, "kachní svalovina", "DUCK", "MUSCLE", ["kachní svalovin", "kachni svalovin", "mletá kachní"]),
    (None, "mletý králík (svalovina)", "RABBIT", "MUSCLE", ["mletý králík", "mlety kralik", "králičí maso mleté"]),
    (None, "králičí kosti", "RABBIT", "BONE", ["králičí kost", "kralici kost"]),
    (None, "králičí srdce a plíce", "RABBIT", "MUSCLE_ORGAN", ["králičí srdce a plíce", "kralici srdce a plice", "srdce a plíce", "králičí srdce", "kralici srdce"]),
    (None, "králičí stehna, žebra, hřbety", "RABBIT", "BONE", ["stehna, žebra", "stehna, zebra"]),
    (None, "koňská svalovina", "HORSE", "MUSCLE", ["koňská svalovin", "konska svalovin", "koňské mleté", "koňské maso"]),
    ("kureci-prsa-sr-legacy", "kuřecí prsa", "CHICKEN", "MUSCLE", ["kuřecí prsa", "kureci prsa"]),
    (None, "kuřecí krky", "CHICKEN", "BONE", ["kuřecí krk", "kureci krk"]),
    (None, "kuřecí letky/křídla", "CHICKEN", "BONE", ["kuřecí letky", "kureci letky", "kuřecí křídl", "kureci kridl", "vznášedla"]),
    (None, "kuřecí běháky", "CHICKEN", "BONE", ["kuřecí běhák", "kureci behak"]),
    (None, "kuřecí srdce", "CHICKEN", "MUSCLE_ORGAN", ["kuřecí srdce", "kureci srdce", "kuřecí srdéčk"]),
    (None, "kuřecí žaludky", "CHICKEN", "SECRETORY_OTHER", ["kuřecí žaludk", "kureci zaludk"]),
    (None, "kuřecí maso, kosti, kůže, šlachy", "CHICKEN", "MUSCLE", ["kuřecí maso/kosti", "kureci maso/kosti", "mleté kuřecí maso/kosti"]),
    (None, "mleté kuře", "CHICKEN", "MUSCLE", ["mleté kuře", "mlete kure", "mleté kuřecí"]),
    ("hovezi-jatra", "srnčí maso", "GAME", "MUSCLE", ["srnec", "srnč", "srnc"]),
    (None, "jelení maso", "GAME", "MUSCLE", ["jelen"]),
    (None, "daňčí maso", "GAME", "MUSCLE", ["daněk", "danek", "daňč"]),
    (None, "zvěřinový skelet", "GAME", "BONE", ["masitý krůtí skelet", "masity kruti skelet"]),
    (None, "zvěřinová chrupavka", "GAME", "CARTILAGE", ["kloubní pouzdro", "kloubni pouzdro"]),
    (None, "zvěřinové šlachy", "GAME", "CARTILAGE", ["šlachy ze srnčí", "slachy ze srnci"]),
    (None, "mrkev", "PLANT", "VEGETABLE", ["mrkev", "mrkv"]),
    (None, "petržel", "PLANT", "VEGETABLE", ["petržel", "petrzel"]),
    (None, "celer", "PLANT", "VEGETABLE", ["celer"]),
    (None, "mix zeleniny", "PLANT", "VEGETABLE", ["mix zeleniny", "zelenin"]),
    (None, "krůtí svalovina", "TURKEY", "MUSCLE", ["krůtí ořez", "kruti orez", "krůtí prsní", "kruti prsni", "krůtí mletá směs", "kruti mleta smes"]),
    (None, "krůtí krky", "TURKEY", "BONE", ["krůtí krk", "kruti krk"]),
    (None, "krůtí kůže", "TURKEY", "SKIN", ["včetně kůže", "vcetne kuze"]),
    (None, "krůtí žaludky", "TURKEY", "SECRETORY_OTHER", ["krůtí žaludk", "kruti zaludk", "krůtí bachor"]),
    ("krůtí játra", "krůtí játra", "TURKEY", "SECRETORY_LIVER", ["krůtí játra", "kruti jatra"]),
    (None, "krůtí ořez a chrupavky", "TURKEY", "MUSCLE", ["ořez a chrupavky", "orez a chrupavky"]),
    (None, "krůtí biskupy", "TURKEY", "SECRETORY_OTHER", ["biskup"]),
    (None, "krůtí srdce", "TURKEY", "MUSCLE_ORGAN", ["krůtí srdce", "kruti srdce", "krůtí srdéčk"]),
    (None, "krůtí křídla", "TURKEY", "BONE", ["krůtí křídl", "kruti kridl"]),
    (None, "krůtí skelet", "TURKEY", "BONE", ["krůtí skelet", "kruti skelet"]),
    (None, "vepřová svalovina", "PORK", "MUSCLE", ["vepřová svalovin", "veprova svalovin", "výběrová vepřová"]),
    (None, "vepřová kůže", "PORK", "SKIN", ["kůže", "kuze"]),
    (None, "vepřové hrtany, uši, jícny", "PORK", "CARTILAGE", ["hrtany, uši", "hrtany, usi"]),
    ("veprova-jatra", "vepřová játra", "PORK", "SECRETORY_LIVER", ["vepřová mletá játra", "veprova mleta jatra", "vepřová játra", "veprova jatra"]),
    (None, "vepřová jazylka", "PORK", "CARTILAGE", ["jazylka"]),
    (None, "vepřové nožičky/kopýtka", "PORK", "BONE", ["vepřové nožičky", "veprove nozicky", "kopýtk"]),
    (None, "vepřová žebra", "PORK", "BONE", ["vepřová žebra", "veprova zebra"]),
    (None, "vepřové srdce", "PORK", "MUSCLE_ORGAN", ["vepřové srdce", "veprove srdce", "srdce krmné vepřové"]),
    (None, "vepřové kosti, masitá žebra", "PORK", "BONE", ["vepřové kosti", "veprove kosti"]),
    (None, "vepřové ledviny", "PORK", "SECRETORY_KIDNEY", ["vepřové ledviny", "veprove ledviny"]),
    (None, "vepřový jazyk s podjazyčím", "PORK", "MUSCLE_ORGAN", ["vepřový jazyk", "veprovy jazyk", "jazyk krmný", "jazyk s podjazyčím"]),
    (None, "vepřový hrtan", "PORK", "CARTILAGE", ["hrtan"]),
    (None, "vepřový salám", "PORK", "MUSCLE", ["salám syrový", "salam syrovy"]),
    (None, "makrela celá", "FISH", "FISH_WHOLE", ["makrela"]),
    ("losos-farmovany", "losos mletý", "FISH", "FISH_FILLET", ["mletý losos", "mlety losos", "losos mletý"]),
    ("losos-farmovany", "lososový ořez", "FISH", "FISH_FILLET", ["lososov", "salmo salar - ořez", "salmo salar - orez"]),
    ("losos-farmovany", "losos škrábaná svalovina", "FISH", "FISH_FILLET", ["škrábaná svalovina", "skrabana svalovina"]),
    (None, "šprot celý", "FISH", "FISH_WHOLE", ["šprot", "sprot"]),
    (None, "rybí filé", "FISH", "FISH_FILLET", ["rybí filé", "rybi file", "mleté filé", "mlete file"]),
    (None, "myš celá", "OTHER", "WHOLE_PREY", ["myš", "mys "]),
    (None, "hovězí noha", "BEEF", "BONE", ["hovězí noha", "hovezi noha", "kopyto jako kráva"]),
    (None, "hovězí salám", "BEEF", "MUSCLE", ["salám syrový 1kg", "hovězí salám"]),
    (None, "hovězí mleté s červenou řepou", "BEEF", "MUSCLE", ["červenou řepou", "cervenou repou"]),
    (None, "hrubě mletá směs vepřové a hovězí", None, "MUSCLE", ["hrubě mletá směs", "hrube mleta smes"]),
    (None, "masová směs s hovězím", "BEEF", "MUSCLE", ["masová směs s hovězím", "masova smes s hovezim"]),
]

def norm(s):
    return s.lower().strip()

def find_pattern(popis_raw):
    """Vybírá pattern podle NEJDELŠÍ shodné trigger fráze napříč celým seznamem,
    ne podle prvního nalezeného v pořadí (oprava nálezu při reconciliaci: "králičí
    kosti" musí trefit specifický pattern, ne obecné "kosti" jen proto, že je výš
    v seznamu — substring match bez ohledu na délku je nespolehlivý)."""
    popis = norm(popis_raw)
    best = None  # (trigger_len, ingredient_id, name_cs, species, part)
    for ingredient_id, name_cs, species, part, triggers in PATTERNS:
        for trig in triggers:
            nt = norm(trig)
            if nt in popis:
                if best is None or len(nt) > best[0]:
                    best = (len(nt), ingredient_id, name_cs, species, part)
    if best is not None:
        return best[1], best[2], best[3], best[4]
    # OPRAVA: fallback musí vracet `ingredient_id: None`, ne text — jinak by string
    # skončil v poli, které engine čte jako odkaz do nutričního katalogu (bug nalezen
    # při reconciliaci: "30% játra" → ingredientId='játra', místo správného None).
    return None, popis_raw.strip(), None, None


def ingr(name_cs, species, part, pct, certainty, source_cs, ingredient_id=None,
          role="INGREDIENT", subcomponents=None, subcomponent_ratio=None):
    return {
        "ingredientId": ingredient_id, "nameCs": name_cs, "species": species, "part": part,
        "role": role, "subcomponentsCs": subcomponents or [], "subcomponentRatio": subcomponent_ratio,
        "percentage": pct, "certainty": certainty, "sourceCs": source_cs,
    }

TOLERANCE_PCT = 12

def parse_slozeni(text):
    """Vrací (composition_list, kind). Stejná logika jako parseIngredientComposition.ts:
    EXACT pokud VŠECHNY segmenty mají procenta a sedí na ~100 %, jinak PARTIAL rozpad
    podle vyjmenovaných částí, jinak jediný SINGLE_INGREDIENT blok bez procent.

    OPRAVA (nález při reconciliaci s CSV, viz TUT10/TUT9/5): "Mletý králík; cca 70 %
    kosti a chrupavky" má JEDEN segment BEZ procenta (Mletý králík) a JEDEN S (cca 70%).
    Původní verze počítala segment s % jako EXACT a TICHY ZAHODILA segment bez % —
    to by tvrdilo 70 % kostí = 100 % složení, což je nesprávné (R7 porušení). Oprava:
    pokud NĚKTERÝ segment procento nemá, CELÝ produkt jde do PARTIAL větve (žádné
    číslo se nepoužije jako by bylo úplné)."""
    import re
    t = text

    # segmenty oddělené strednikem
    segments = [s.strip() for s in re.split(r';', t) if s.strip()]

    # OPRAVA (nález při reconciliaci: TUT7 "100% srnec, jelen a daněk; bez kostí",
    # TUT212 "100% škrábaná svalovina z lososa; bez kostí"): "bez X" je EXPLICITNÍ
    # NEPŘÍTOMNOST (viz `parseAbsence` v TS verzi), NE další composition segment.
    # Dřív se "bez kostí" počítalo jako segment BEZ procenta → celý produkt spadl
    # do PARTIAL větve A NAVÍC "kosti" pattern uvnitř "bez kostí" vytvořil FALEŠNOU
    # položku "kosti" v composition, jako by kost byla přítomná surovina — přesný
    # opak toho, co text říká. "bez X" segmenty se teď filtrují PŘED analýzou procent
    # a nikdy nevstupují do žádného ingredient patternu.
    absent_segments = [s for s in segments if re.match(r'^bez\s+', s, re.I)]
    segments = [s for s in segments if not re.match(r'^bez\s+', s, re.I)]

    def match_pct(seg):
        # "cca 70% kosti" i "70% kosti" — "cca " je tolerovaný prefix, ne součást čísla.
        return re.match(r'^(?:cca\.?\s*)?(\d{1,3})\s*%\s*(.+)$', seg, re.I)

    all_have_pct = len(segments) > 0 and all(match_pct(s) for s in segments)

    if all_have_pct:
        exact = []
        soucet = 0
        for seg in segments:
            m = match_pct(seg)
            pct = float(m.group(1))
            popis = m.group(2)

            # zeleninová/skupinová podskupina "50% mix zeleniny: mrkev, petržel, celer"
            if ':' in popis and re.search(r'zelenin|směs|smes|mix', popis, re.I):
                head, rest = popis.split(':', 1)
                subs = [s.strip() for s in rest.split(',') if s.strip()]
                exact.append(ingr(head.strip(), "PLANT", "VEGETABLE", pct, "EXACT",
                                   f"{pct:.0f}% {popis}", ingredient_id=None,
                                   role="INGREDIENT_GROUP", subcomponents=subs, subcomponent_ratio="UNKNOWN"))
                soucet += pct
                continue

            # "30% hovězí droby: játra, plíce, ledviny" — droby s rozpisem
            if ':' in popis and re.search(r'drob', popis, re.I):
                head, rest = popis.split(':', 1)
                subs = [s.strip() for s in rest.split(',') if s.strip()]
                exact.append(ingr("hovězí droby", "BEEF", "SECRETORY_OTHER", pct, "EXACT",
                                   f"{pct:.0f}% {popis}", ingredient_id=None,
                                   role="INGREDIENT_GROUP", subcomponents=subs, subcomponent_ratio="UNKNOWN"))
                soucet += pct
                continue

            # OPRAVA (nález: TUT58/TUT117 "100% celá mletá krůta: svalovina, kosti,
            # kůže, chrupavka") — obecný dvojtečkový výčet (ne zelenina, ne droby):
            # hlavička PŘED dvojtečkou popisuje CELEK (100 % z něj), výčet ZA dvojtečkou
            # jsou PARTIAL složky BEZ vzájemného poměru. Bez tohohle větve by `find_pattern`
            # vzal jen NEJDELŠÍ jeden match z celého "popis" stringu a zbytek (kosti/kůže/
            # chrupavka) tiše zmizel — přesně chyba, kterou reconciliace odhalila.
            if ':' in popis:
                head, rest = popis.split(':', 1)
                subs_raw = [s.strip() for s in rest.split(',') if s.strip()]
                if len(subs_raw) > 1:
                    for sub in subs_raw:
                        ingredient_id, name_cs, species, part = find_pattern(sub)
                        exact.append(ingr(name_cs, species, part, None, "PARTIAL", sub,
                                           ingredient_id=ingredient_id))
                    # Hlavička (celek, "100 %") se do sumy NEPOČÍTÁ jako samostatná
                    # položka — je to popis celku, ne přidaná surovina navíc.
                    soucet += pct
                    continue

            ingredient_id, name_cs, species, part = find_pattern(popis)
            exact.append(ingr(name_cs, species, part, pct, "EXACT", f"{pct:.0f}% {popis}", ingredient_id=ingredient_id))
            soucet += pct

        if abs(soucet - 100) <= TOLERANCE_PCT:
            return exact, "COMPOSITE" if len(exact) > 1 else "SINGLE_INGREDIENT"
        # procenta nesedí na ~100 % — spadává do PARTIAL větve níže (nedopočítávat)

    # Bez procent, NEBO smíšené segmenty (jen část má %), NEBO procenta nedávají ~100 %:
    # PARTIAL rozpad — R7, žádné číslo se nepoužije jako by bylo kompletní.
    #
    # OPRAVA (nález při reconciliaci): "Mletý králík; cca 70% kosti a chrupavky" má
    # DVĚ suroviny ve DVOU různých fragmentech (král, kosti+chrupavka) — původní verze
    # brala JEDEN `find_pattern` match na celý spojený text a zbytek slov TICHO ZTRATILA
    # (jen "chrupavka" přežilo, "Mletý králík" i "kosti" zmizely beze stopy). Oprava:
    # hledá se KAŽDÝ pattern, který se v textu vyskytuje (ne jen jeden na fragment),
    # a překrývající se/vnořené shody (např. "kosti" uvnitř "králičí kosti") se
    # deduplikují podle rozsahu — nejdelší/specifičtější vyhrává na daném úseku textu.
    #
    # "100% celá mletá krůta: svalovina, kosti, kůže, chrupavka" — nadpis PŘED
    # dvojtečkou ("celá mletá krůta") popisuje CELEK, ne jednotlivou surovinu, a
    # zahazuje se explicitně (jinak by "celá mletá krůta" skončila jako falešná
    # pátá PARTIAL složka vedle svalovina/kosti/kůže/chrupavka).
    joined = ' '.join(segments) if segments else t

    # Nadpis před dvojtečkou pryč, pokud existuje (typicky "<pct>% <celek>: <výčet>").
    if ':' in joined:
        head, _, rest = joined.partition(':')
        search_text = rest
    else:
        search_text = joined

    norm_search = norm(search_text)
    matches = []  # (start, end, ingredient_id, name_cs, species, part)
    for ingredient_id, name_cs, species, part, triggers in PATTERNS:
        for trig in triggers:
            nt = norm(trig)
            start = 0
            while True:
                idx = norm_search.find(nt, start)
                if idx == -1:
                    break
                matches.append((idx, idx + len(nt), ingredient_id, name_cs, species, part))
                start = idx + 1

    # Nejdelší match vyhrává tam, kde se rozsahy překrývají (např. "králičí kosti"
    # pohltí dílčí "kosti" na stejném místě v textu).
    matches.sort(key=lambda m: (m[0], -(m[1] - m[0])))
    accepted = []
    covered = []  # list of (start, end) already accepted
    for m in matches:
        s, e = m[0], m[1]
        if any(s < ce and cs < e for cs, ce in covered):
            continue
        accepted.append(m)
        covered.append((s, e))

    accepted.sort(key=lambda m: m[0])

    found = []
    seen = set()
    for _, _, ingredient_id, name_cs, species, part in accepted:
        if name_cs in seen:
            continue
        seen.add(name_cs)
        found.append(ingr(name_cs, species, part, None, "PARTIAL", search_text.strip()))

    if len(found) == 0:
        # žádný rozpoznaný vzor vůbec — jedna položka s celým textem, PARTIAL
        return [ingr(joined.strip(), None, None, None, "PARTIAL", joined.strip())], "COMPOSITE"

    if len(found) == 1:
        # jediná surovina bez procenta — pořád SINGLE_INGREDIENT, ale bez EXACT 100%
        # protože Tutani to explicitně na 100 % neřekl (pokud nebylo "100%" v textu)
        if re.search(r'\b100\s*%', text):
            found[0]["percentage"] = 100
            found[0]["certainty"] = "EXACT"
            return found, "SINGLE_INGREDIENT"
        return found, "SINGLE_INGREDIENT"

    return found, "COMPOSITE"


def parse_baleni_to_grams(baleni):
    baleni = baleni.strip()
    m = re.match(r'^([\d,\.]+)\s*(kg|g)$', baleni, re.I)
    if not m:
        return None
    num = float(m.group(1).replace(',', '.'))
    unit = m.group(2).lower()
    return int(num * 1000) if unit == 'kg' else int(num)

def claims(desc, dietary=None):
    return {"rawDescriptionCs": desc, "ageCategory": None, "dietaryClaimsCs": dietary or []}

def ev(note=None, confidence="EXACT"):
    o = {"source": "TUTANI_PRODUCT_PAGE", "sourceDate": DATE, "confidence": confidence}
    if note:
        o["noteCs"] = note
    return o

import re

# --- Kategorizace kódu na topCategory (heuristika podle prefixu/jména) ---
def guess_top_category(code, name, slozeni):
    n = (name + ' ' + slozeni).lower()
    if code.startswith('ZP') or code.startswith('MYS'):
        return "ZOO_KRMIVO"
    if 'krůt' in n or 'kruti' in n:
        return "KRUTA"
    if 'kachn' in n:
        return "KACHNA"
    if 'králič' in n or 'kralic' in n or 'ušák' in n or 'usak' in n:
        return "KRALIK"
    if 'koňsk' in n or 'konsk' in n or 'šemík' in n or 'semik' in n:
        return "KONINA"
    if 'kuřec' in n or 'kureci' in n or 'kuře' in n:
        return "DRUBEZ"
    if 'srnec' in n or 'jelen' in n or 'daněk' in n or 'zvěřin' in n or 'zverin' in n or 'muflon' in n or 'vysoká' in n or 'vysoka' in n:
        return "ZVERINA"
    if 'vepřov' in n or 'veprov' in n or 'pašík' in n or 'pasik' in n or 'prase' in n:
        return "VEPROVE"
    if 'losos' in n or 'salmo' in n or 'makrela' in n or 'šprot' in n or 'sprot' in n or 'ryb' in n:
        return "RYBY"
    if 'hověz' in n or 'hovez' in n or 'kráva' in n or 'krava' in n or 'bejk' in n:
        return "HOVEZI"
    return "OTHER"


def guess_species_from_name(name):
    """Odvodí druh zvířete z NÁZVU produktu (ne z composition textu) — pro doplnění
    composition položek, kde part-level pattern rozpozná typ tkáně (játra/svalovina/
    kosti…), ale sám composition text neříká druh (TUT175 'Hovězí droby kusové' →
    composition '40% plíce; 30% ledviny; 30% játra' neříká 'hovězí' u jater samotných,
    ale NÁZEV produktu ano). Tohle NENÍ dohad nad rámec dat — produktový název je
    stejně tak deklarovaný Tutani jako composition text, jen v jiném poli."""
    n = name.lower()
    if 'hověz' in n or 'hovez' in n or 'kráva' in n or 'krava' in n or 'bejk' in n:
        return 'BEEF'
    if 'krůt' in n or 'kruti' in n:
        return 'TURKEY'
    if 'kachn' in n:
        return 'DUCK'
    if 'králič' in n or 'kralic' in n or 'ušák' in n or 'usak' in n:
        return 'RABBIT'
    if 'koňsk' in n or 'konsk' in n or 'šemík' in n or 'semik' in n:
        return 'HORSE'
    if 'kuřec' in n or 'kureci' in n or 'kuře' in n:
        return 'CHICKEN'
    if 'vepřov' in n or 'veprov' in n or 'pašík' in n or 'pasik' in n:
        return 'PORK'
    if 'srnec' in n or 'jelen' in n or 'daněk' in n or 'zvěřin' in n or 'zverin' in n or 'muflon' in n:
        return 'GAME'
    if 'losos' in n or 'salmo' in n or 'makrela' in n or 'šprot' in n or 'sprot' in n:
        return 'FISH'
    return None


def fill_species_from_product_name(composition, name, slozeni_text):
    """Doplní `species: None` položky composition odvozeným druhem — nejdřív z NÁZVU
    produktu, a když ten je fantazijní (TUT58 'Směs paní Krocanové' neobsahuje 'krůt'),
    z composition TEXTU samotného (ten obsahuje 'celá mletá krůta' explicitně).
    Nemění `certainty` — jen dodává KTERÝ druh, ne KOLIK/JISTOTU."""
    guessed = guess_species_from_name(name) or guess_species_from_name(slozeni_text)
    if guessed is None:
        return composition
    for c in composition:
        if c['species'] is None:
            c['species'] = guessed
            c['sourceCs'] = f"{c['sourceCs']} [druh odvozen z {'názvu produktu' if guess_species_from_name(name) else 'textu složení'}: {name if guess_species_from_name(name) else slozeni_text}]"
    return composition


# --- Load CSV ---
with open(CSV_PATH, encoding='utf-8') as f:
    csv_rows = list(csv.DictReader(f))

# Fix broken ZP10 row (comma in product name split the CSV fields)
for r in csv_rows:
    if r['kod'] == 'ZP10':
        r['produkt'] = 'Hrubomletá směs 1,5kg'
        r['baleni'] = '1,5 kg'
        r['cena_kc'] = '95'
        r['slozeni'] = 'Hrubě mletá směs vepřové a hovězí'

csv_products = []
warnings = []

for r in csv_rows:
    code = r['kod']
    name = r['produkt']
    slozeni_text = r['slozeni']
    price = float(r['cena_kc']) if r['cena_kc'] else None
    pack_grams = parse_baleni_to_grams(r['baleni'])

    composition, kind = parse_slozeni(slozeni_text)
    composition = fill_species_from_product_name(composition, name, slozeni_text)
    accounted = round(sum(
        c['percentage'] for c in composition
        if c['percentage'] is not None and c['certainty'] in ('EXACT', 'DERIVED')
    ), 1)

    dietary = []
    if re.search(r'bez kost', slozeni_text, re.I):
        dietary.append('bez kostí')
    if re.search(r'bez vnitřnost|bez vnitrnost', slozeni_text, re.I):
        dietary.append('bez vnitřností')

    note = None
    if code == 'TUT222':
        note = ("OPRAVA 2026-09-09 (podruhé): autoritativní scraper CSV potvrzuje "
                "50/35/15 % — PŮVODNÍ hodnota z první dávky zadání byla SPRÁVNĚ. "
                "Mezitím provedená 'oprava' na 50/3,5/1,5 % (podle ručně psané zprávy "
                "tvrdící, že vidí 'aktuální stránku') byla CHYBNÁ a tímto se VRACÍ zpět. "
                "Poučení: scraper výstup > ručně přepsaný text, i když ten druhý tvrdí "
                "vyšší aktuálnost.")
    if code == 'TUT9':
        note = ("Kód BEZ lomítka — 'Kachní vznášedla', NE krůtí. TUT9/1, TUT9/5, "
                "TUT9/13, TUT9/15 jsou SAMOSTATNÉ produkty (jiný suffix = jiné SKU, "
                "ne gramážová varianta), potvrzeno scraper CSV 2026-09-09.")

    top_category = guess_top_category(code, name, slozeni_text)

    csv_products.append({
        "productId": code,
        "code": code,
        "nameCs": name,
        "brand": None,
        "categoryPath": "Barf mražené maso",
        "topCategory": top_category,
        "priceWithVatCzk": price,
        "packGrams": pack_grams,
        "availability": "UNKNOWN",
        "url": r['zdroj'],
        "kind": kind,
        "composition": composition,
        "compositionAccountedPct": accounted,
        "analytical": [],
        "claims": claims(name, dietary),
        "evidence": ev(note=note),
        "updatedAt": DATE,
    })

print(f"CSV → {len(csv_products)} produktů zpracováno")

# --- Load existing dataset, keep only products NOT covered by CSV (jiné kategorie) ---
with open(DATASET_PATH, encoding='utf-8') as f:
    old_dataset = json.load(f)

csv_codes = set(p['code'] for p in csv_products)
kept_from_old = [p for p in old_dataset['products'] if p['code'] not in csv_codes]

print(f"Ponecháno ze starého datasetu (mimo CSV kategorii): {len(kept_from_old)}")
for p in kept_from_old:
    print(f"  {p['code']:12s} {p['nameCs']} ({p['topCategory']})")

final_products = csv_products + kept_from_old

with open(DATASET_PATH, "w", encoding="utf-8") as f:
    json.dump({
        "datasetId": "tutani-products",
        "displayName": "Tutani — produktový katalog (ingredient-level composition)",
        "source": "TUTANI_PRODUCT_PAGE",
        "sourceVersion": "0.3",
        "updatedAt": DATE,
        "note": (
            "v0.3: KOMPLETNÍ PŘESTAVBA kategorie 'Barf mražené maso' (103 SKU) z "
            "autoritativního scraper CSV (tutani_mrazene_maso_extracted_2026-09-09.csv), "
            "nahrazuje ruční přepisy z konverzace. Reconciliace odhalila a opravila dvě "
            "chyby: (1) TUT222 Šemíkova mňamka byla mezitím nesprávně upravena na "
            "50/3,5/1,5 % podle ručně psané zprávy — CSV potvrzuje SPRÁVNOU původní "
            "hodnotu 50/35/15 %, vráceno zpět; (2) TUT9 (bez lomítka) je 'Kachní "
            "vznášedla', ne krůtí — kódy TUT9/1, TUT9/5, TUT9/13, TUT9/15 jsou "
            "SAMOSTATNÉ produkty, ne gramážové varianty jednoho SKU. "
            "Produkty mimo tuto kategorii (BARF strava pro psy, dravci, ZOO doplňky mimo "
            "mražené maso, BARF přílohy) zůstávají ze staršího datasetu beze změny — "
            "CSV o nich nic netvrdí. R7: kde Tutani neuvedl poměr, percentage je null "
            "a certainty PARTIAL/UNKNOWN — nikdy dopočet rovnoměrným rozdělením."
        ),
        "products": final_products,
    }, f, ensure_ascii=False, indent=2)
    f.write("\n")

print(f"\nCELKEM zapsáno: {len(final_products)} produktů")
