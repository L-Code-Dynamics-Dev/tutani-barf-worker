# Nasazení kalkulačky na obchod.tutani.cz (varianta A, schváleno Lucky 25. 9. 2026)

Upoutávka na homepage → stránka /barf-kalkulacka/ (v menu) → kalkulačka.

1. FTP e-shopu `upload/lcode/`: `konfigurator.js`, `konfigurator.css`, `pes-zlaty-retrivr.webp` (z `frontend/`).
   Před nahráním `node --check konfigurator.js`, po nahrání ověřit CDN curlem.
2. Admin → HTML kódy → Zápatí: `3-zapati-zavadec.html`.
3. Admin → Stránky → nová „BARF kalkulačka“, URL `/barf-kalkulacka/`, zaškrtnout **zobrazit v hlavním menu** a v pořadí menu ji dát **na první místo** (hned za domeček, před „Mražené maso“); červenou barvu dělá styl v zápatí: `2-stranka-barf-kalkulacka.html`.
4. Admin → úvodní text homepage (zdrojový kód): `1-upoutavka-homepage.html` úplně nahoru
   a odstavce s logy (od loga Tutani po Zelenku, poskládané mezerami) nahradit `4-loga-homepage.html`.
   Před úpravou uložit zálohu celého textu.

Předpoklad: nasazený Worker `tutani-barf.hlancaric.workers.dev` (Workers Paid kvůli PDF).
Rollback: smazat bloky mezi značkami L-CODE … START/END, stránku skrýt.
