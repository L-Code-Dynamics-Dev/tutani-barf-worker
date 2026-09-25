/**
 * PDF jídelníček — „stáhnout jedním kliknutím" (Lucky 2026-09-24).
 *
 * VSTUP JE HOTOVÁ ODPOVĚĎ `/v1/davka` (DoseResponseForPdf), ne profil
 * psa. PDF tedy nic nepočítá — jen vysází čísla, která spočítal engine.
 * Web i PDF tak ukazují vždy totéž (R3 / jediný zdroj pravdy).
 *
 * Fonty: Barlow Condensed + Source Sans 3 (OFL), ořezané na latinku
 * CZ/SK. Znaky mimo sadu (emoji v jménu psa…) se nahradí, aby
 * PDF nevykreslilo prázdné čtverečky ani nespadlo.
 */

import { PDFDocument, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { BARLOW_BOLD, BARLOW_EXTRABOLD, SOURCE_SANS_REGULAR, SOURCE_SANS_SEMIBOLD } from './fonts.generated.js';

// ---- Tvar vstupu (podmnožina odpovědi /v1/davka) ----

export interface PdfIngredient { nazev: string; group: string; skupina: string; gramy: number }

export interface DoseResponseForPdf {
    status: string;
    pes: { jmeno: string | null; hmotnostKg: number; idealniHmotnostKg: number | null; vekMesicu: number; aktivita?: string | null };
    davka: {
        pctPouzito: number;
        zHmotnosti: string;
        zakladHmotnostiKg: number;
        celkemGDen: number;
        porce: { pocet: number; gramyNaPorci: number } | null;
        pravidloPopis?: string;
    } | null;
    slozeni: { group: string; nazev: string; gramy: number; pct: number; upraveno: boolean }[];
    produkty: { nazev: string; group: string; packGrams: number; pocet: number; cenaCelkem: number }[];
    nepokryto: { nazev: string; gramy: number; duvod: string; chybiGramu: number | null }[];
    cena: { celkemCzk: number; naDni: number } | null;
    obdobiDni: number;
    upozorneni: { severity: string; text: string; requiresVet: boolean }[];
    recept: {
        denneCelkemG: number;
        porce: { nazev: string; celkemG: number; suroviny: PdfIngredient[] }[];
        baleni: { nazev: string; gramyBaleni: number; pocet: number; gramyDen: number; dniNaBaleni: number | null }[];
        chybi: { nazev: string; gramyDen: number }[];
        postup: readonly string[];
    } | null;
    disclaimer: string;
}

export interface PdfBranding {
    brandCs: string;
    contactCs?: string;
}

export class RecipePdfUnavailableError extends Error {
    constructor(reason: string) {
        super(reason);
        this.name = 'RecipePdfUnavailableError';
    }
}

// ---- Vzhled ----

const hex = (h: string): RGB => {
    const n = parseInt(h.slice(1), 16);
    return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

const C = {
    text: hex('#231815'),
    text2: hex('#5B4D44'),
    muted: hex('#8A7B70'),
    red: hex('#D7282F'),
    redText: hex('#C8232B'),
    cream: hex('#F3E9DF'),
    creamDark: hex('#EADBC4'),
    line: hex('#E4DAD0'),
    green: hex('#3F7A2E'),
    greenBg: hex('#EAF3E3'),
    white: rgb(1, 1, 1),
};

const GROUP_COLORS: Record<string, string> = {
    MUSCLE: '#D7282F',
    BONE: '#EADBC4',
    LIVER: '#7A1F1F',
    ORGAN: '#E88A8A',
    PLANT: '#86A63F',
    SUPPLEMENT: '#F2965A',
    OTHER: '#CFC2B5',
};

const A4: [number, number] = [595.28, 841.89];
const M = 42; // okraj
const W = A4[0] - 2 * M;

/** Povolené znaky = to, co pokrývá ořez fontu (viz scripts/build-pdf-fonts.py). */
const SUPPORTED = /[ -~ -ſ–—‘’‚“”„•…€→−×]/;

export function safeText(s: unknown): string {
    return Array.from(String(s ?? ''))
        .map((ch) => (ch === '\n' || ch === '\t' ? ' ' : SUPPORTED.test(ch) ? ch : ''))
        .join('')
        .replace(/\s+/g, ' ')
        .trim();
}

function fmt(n: number | null | undefined, decimals = 1): string {
    if (n === null || n === undefined || !Number.isFinite(Number(n))) return '?';
    const f = 10 ** decimals;
    const r = Math.round(Number(n) * f) / f;
    const t = r % 1 === 0 ? String(r) : r.toFixed(decimals).replace(/0+$/, '').replace('.', ',');
    return t.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function fmtKg(g: number): string {
    return fmt(g / 1000, 1) + ' kg';
}

function vek(m: number): string {
    const skl = (n: number, a: string, b: string, c: string) => (n === 1 ? a : n >= 2 && n <= 4 ? b : c);
    if (m < 24) return `${m} ${skl(m, 'měsíc', 'měsíce', 'měsíců')}`;
    const r = Math.floor(m / 12);
    return `${r} ${skl(r, 'rok', 'roky', 'let')}`;
}

function obdobi(d: number): string {
    return d === 7 ? 'týden' : d === 30 ? 'měsíc' : `${d} dní`;
}

// ---- Sazba ----

interface Fonts { h: PDFFont; hb: PDFFont; r: PDFFont; sb: PDFFont }

class Layout {
    page!: PDFPage;
    y = 0;
    pageNo = 0;
    constructor(private readonly doc: PDFDocument, readonly f: Fonts, private readonly footer: (p: PDFPage, n: number) => void) {
        this.newPage();
    }
    newPage(): void {
        if (this.page) this.footer(this.page, this.pageNo);
        this.page = this.doc.addPage(A4);
        this.pageNo++;
        this.y = A4[1] - M;
    }
    /** Zajistí místo; když není, nová stránka. */
    need(h: number): void {
        if (this.y - h < M + 58) this.newPage();
    }
    finish(): void {
        this.footer(this.page, this.pageNo);
    }
    text(t: string, x: number, y: number, size: number, font: PDFFont, color: RGB = C.text): void {
        this.page.drawText(safeText(t), { x, y, size, font, color });
    }
    right(t: string, xRight: number, y: number, size: number, font: PDFFont, color: RGB = C.text): void {
        const s = safeText(t);
        this.page.drawText(s, { x: xRight - font.widthOfTextAtSize(s, size), y, size, font, color });
    }
    width(t: string, size: number, font: PDFFont): number {
        return font.widthOfTextAtSize(safeText(t), size);
    }
    wrap(t: string, size: number, font: PDFFont, maxW: number): string[] {
        const words = safeText(t).split(' ').filter(Boolean);
        const lines: string[] = [];
        let cur = '';
        for (const w of words) {
            const cand = cur ? `${cur} ${w}` : w;
            if (font.widthOfTextAtSize(cand, size) <= maxW || !cur) cur = cand;
            else {
                lines.push(cur);
                cur = w;
            }
        }
        if (cur) lines.push(cur);
        return lines;
    }
    rect(x: number, y: number, w: number, h: number, color: RGB): void {
        this.page.drawRectangle({ x, y, width: w, height: h, color });
    }
    hline(y: number, color: RGB = C.line): void {
        this.page.drawLine({ start: { x: M, y }, end: { x: M + W, y }, thickness: 0.6, color });
    }
    heading(t: string): void {
        this.need(40);
        this.y -= 22;
        this.text(t.toUpperCase(), M, this.y, 15, this.f.h, C.text);
        this.y -= 10;
    }
}

function base64ToBytes(b64: string): Uint8Array {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

/**
 * Vysází jídelníček. Vyhodí `RecipePdfUnavailableError`, když dávka
 * není OK nebo chybí recept — PDF se v takovém případě NEVYDÁVÁ
 * (u blokovaného stavu by „jídelníček" byl nebezpečný).
 */
export async function renderRecipePdf(
    r: DoseResponseForPdf,
    brand: PdfBranding,
    now: Date = new Date()
): Promise<Uint8Array> {
    if (r.status !== 'OK' || !r.davka) throw new RecipePdfUnavailableError(`status ${r.status}`);
    if (!r.recept) throw new RecipePdfUnavailableError('recept chybí (nákup není k dispozici)');

    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const f: Fonts = {
        h: await doc.embedFont(base64ToBytes(BARLOW_EXTRABOLD), { subset: true }),
        hb: await doc.embedFont(base64ToBytes(BARLOW_BOLD), { subset: true }),
        r: await doc.embedFont(base64ToBytes(SOURCE_SANS_REGULAR), { subset: true }),
        sb: await doc.embedFont(base64ToBytes(SOURCE_SANS_SEMIBOLD), { subset: true }),
    };

    const jmeno = safeText(r.pes.jmeno) || 'váš pes';
    const datum = new Intl.DateTimeFormat('cs-CZ', { timeZone: 'Europe/Prague', day: 'numeric', month: 'numeric', year: 'numeric' }).format(now);
    doc.setTitle(`Jídelníček BARF – ${jmeno}`);
    doc.setAuthor(safeText(brand.brandCs));
    doc.setCreator('Tutani BARF Engine');
    doc.setLanguage('cs-CZ');
    doc.setCreationDate(now);

    const footer = (p: PDFPage, n: number) => {
        const disc = safeText(r.disclaimer);
        const lines = wrapStatic(disc, 7.5, f.r, W);
        let yy = M + 4 + (lines.length - 1) * 9.5;
        for (const l of lines) {
            p.drawText(l, { x: M, y: yy, size: 7.5, font: f.r, color: C.muted });
            yy -= 9.5;
        }
        const left = safeText(`${brand.brandCs}${brand.contactCs ? ' · ' + brand.contactCs : ''}`);
        p.drawText(left, { x: M, y: M - 14, size: 7.5, font: f.sb, color: C.text2 });
        const right = safeText(`Vytvořeno ${datum} · strana ${n}`);
        p.drawText(right, { x: M + W - f.r.widthOfTextAtSize(right, 7.5), y: M - 14, size: 7.5, font: f.r, color: C.muted });
    };

    const L = new Layout(doc, f, footer);
    const d = r.davka;

    // ---- HLAVIČKA ----
    L.rect(0, A4[1] - 150, A4[0], 150, C.cream);
    L.text(brand.brandCs.toUpperCase(), M, L.y - 6, 9, f.sb, C.red);
    L.y -= 42;
    const titul = `JÍDELNÍČEK · ${jmeno.toUpperCase()}`;
    const titulSize = Math.min(34, (W * 34) / Math.max(1, L.width(titul, 34, f.h)));
    L.text(titul, M, L.y, titulSize, f.h, C.text);
    L.y -= 20;
    const profil = [
        `${fmt(r.pes.hmotnostKg)} kg`,
        vek(r.pes.vekMesicu),
        r.pes.aktivita ? safeText(r.pes.aktivita) : null,
        d.pravidloPopis ?? null,
        d.zHmotnosti === 'IDEAL' && r.pes.idealniHmotnostKg ? `cílová hmotnost ${fmt(r.pes.idealniHmotnostKg)} kg` : null,
    ].filter(Boolean).join(' · ');
    L.text(profil, M, L.y, 11, f.r, C.text2);

    // Velké číslo vpravo v hlavičce.
    const gramy = fmt(d.celkemGDen, 0);
    L.right(gramy, M + W - 58, A4[1] - 96, 54, f.h, C.red);
    L.text('g / den', M + W - 52, A4[1] - 96, 16, f.hb, C.redText);
    const podNadpis = `${fmt(d.pctPouzito, 2)} % z ${fmt(d.zakladHmotnostiKg)} kg` +
        (d.porce ? ` · ${d.porce.pocet}× denně po ${fmt(d.porce.gramyNaPorci, 0)} g` : '');
    L.right(podNadpis, M + W, A4[1] - 118, 10, f.sb, C.text2);
    L.y = A4[1] - 150 - 6;

    // ---- SLOŽENÍ ----
    L.heading('Složení denní dávky');
    const total = r.slozeni.reduce((a, s) => a + Math.max(0, s.pct), 0) || 1;
    let x = M;
    L.need(14);
    for (const s of r.slozeni) {
        const w = (Math.max(0, s.pct) / total) * W;
        L.rect(x, L.y - 12, Math.max(0, w - 1.5), 12, hex(GROUP_COLORS[s.group] ?? GROUP_COLORS.OTHER));
        x += w;
    }
    L.y -= 30;
    for (const s of r.slozeni) {
        L.need(18);
        L.rect(M, L.y - 1, 8, 8, hex(GROUP_COLORS[s.group] ?? GROUP_COLORS.OTHER));
        L.text(s.nazev + (s.upraveno ? '  (upraveno kvůli zdraví)' : ''), M + 16, L.y, 10.5, f.r);
        L.right(`${fmt(s.gramy, 0)} g`, M + W - 60, L.y, 12, f.hb);
        L.right(`${fmt(s.pct, 2)} %`, M + W, L.y, 10, f.r, C.muted);
        L.y -= 5;
        L.hline(L.y);
        L.y -= 13;
    }

    // ---- CO DÁT DO MISKY ----
    const rec = r.recept;
    L.heading('Co dát do misky');
    L.text('Gramy jsou přepočtené na produkty z vašeho nákupu. Vážte na kuchyňské váze.', M, L.y, 9.5, f.r, C.muted);
    L.y -= 14;
    const cols = Math.min(rec.porce.length, 2);
    const gap = 12;
    const colW = (W - gap * (cols - 1)) / cols;
    for (let i = 0; i < rec.porce.length; i += cols) {
        const row = rec.porce.slice(i, i + cols);
        // Výška řádku = nejvyšší karta.
        const heights = row.map((p) => 34 + p.suroviny.reduce((a, s) => a + 14 * L.wrap(s.nazev, 9.5, f.r, colW - 70).length, 0) + 8);
        const h = Math.max(...heights);
        L.need(h + 8);
        row.forEach((p, k) => {
            const cx = M + k * (colW + gap);
            const top = L.y;
            L.rect(cx, top - h, colW, h, C.cream);
            L.rect(cx, top - 3, colW, 3, C.red);
            L.text(p.nazev.toUpperCase(), cx + 12, top - 20, 12, f.h);
            L.right(`${fmt(p.celkemG, 0)} g`, cx + colW - 12, top - 20, 13, f.h, C.red);
            let yy = top - 38;
            for (const s of p.suroviny) {
                const lines = L.wrap(s.nazev, 9.5, f.r, colW - 70);
                L.rect(cx + 12, yy - 0.5, 6, 6, hex(GROUP_COLORS[s.group] ?? GROUP_COLORS.OTHER));
                lines.forEach((ln, li) => L.text(ln, cx + 22, yy - li * 12, 9.5, f.r));
                L.right(`${fmt(s.gramy, 0)} g`, cx + colW - 12, yy, 10.5, f.sb);
                yy -= 14 * lines.length;
            }
        });
        L.y -= h + 10;
    }
    for (const c of rec.chybi) {
        L.need(14);
        L.text(`Chybí: ${c.nazev} ${fmt(c.gramyDen, 0)} g denně — teď ji nemáme skladem v potřebném množství.`, M, L.y, 9.5, f.sb, C.redText);
        L.y -= 13;
    }

    // ---- NÁKUP ----
    L.heading(`Nákup na ${obdobi(r.obdobiDni)}`);
    L.need(16);
    L.text('PRODUKT', M, L.y, 8, f.sb, C.muted);
    L.right('KS', M + W - 190, L.y, 8, f.sb, C.muted);
    L.right('1 BALENÍ VYSTAČÍ', M + W - 80, L.y, 8, f.sb, C.muted);
    L.right('CENA', M + W, L.y, 8, f.sb, C.muted);
    L.y -= 6;
    L.hline(L.y);
    L.y -= 13;
    rec.baleni.forEach((b, i) => {
        const p = r.produkty[i];
        const lines = L.wrap(b.nazev, 10, f.r, W - 240);
        L.need(12 * lines.length + 8);
        lines.forEach((ln, li) => L.text(ln, M, L.y - li * 12, 10, f.r));
        L.right(`${b.pocet}×`, M + W - 190, L.y, 11, f.hb);
        L.right(b.dniNaBaleni ? `na ${b.dniNaBaleni} ${b.dniNaBaleni === 1 ? 'den' : b.dniNaBaleni <= 4 ? 'dny' : 'dní'}` : '—', M + W - 80, L.y, 10, f.r, C.text2);
        L.right(p ? `${fmt(p.cenaCelkem, 0)} Kč` : '', M + W, L.y, 11, f.hb);
        L.y -= 12 * lines.length - 12 + 6;
        L.hline(L.y);
        L.y -= 13;
    });
    for (const n of r.nepokryto) {
        L.need(14);
        const t = n.duvod === 'INSUFFICIENT_STOCK' && n.chybiGramu
            ? `${n.nazev}: skladem jen na část období, chybí ${fmtKg(n.chybiGramu)}.`
            : `${n.nazev}: teď nemáme vhodný produkt (${fmt(n.gramy, 0)} g denně).`;
        L.text(t, M, L.y, 9.5, f.sb, C.redText);
        L.y -= 13;
    }
    if (r.cena) {
        L.need(34);
        L.y -= 8;
        L.text(`Zásoba na ${obdobi(r.obdobiDni)}`, M, L.y, 10, f.sb, C.muted);
        L.right(`${fmt(r.cena.celkemCzk, 0)} Kč`, M + W, L.y - 4, 24, f.h);
        if (r.obdobiDni > 0) {
            const perDay = `to je ${fmt(Math.round(r.cena.celkemCzk / r.obdobiDni), 0)} Kč na den`;
            const pw = L.width(perDay, 9.5, f.sb) + 14;
            L.rect(M, L.y - 20, pw, 14, C.greenBg);
            L.text(perDay, M + 7, L.y - 16, 9.5, f.sb, C.green);
        }
        L.y -= 34;
    }

    // ---- POSTUP ----
    if (rec.postup.length) {
        // Postup se nedělí mezi strany — i s nadpisem se vejde celý, nebo jde na další.
        const blok = 42 + rec.postup.reduce((acc, st) => acc + 12.5 * L.wrap(st, 10, f.r, W - 26).length + 6, 0);
        L.need(blok);
        L.heading('Příprava krok za krokem');
        L.y -= 10;
        rec.postup.forEach((step, i) => {
            const lines = L.wrap(step, 10, f.r, W - 26);
            L.need(12 * lines.length + 6);
            L.page.drawCircle({ x: M + 8, y: L.y + 3.5, size: 8, color: C.red });
            const num = String(i + 1);
            L.text(num, M + 8 - L.width(num, 9, f.hb) / 2, L.y, 9, f.hb, C.white);
            lines.forEach((ln, li) => L.text(ln, M + 24, L.y - li * 12.5, 10, f.r));
            L.y -= 12.5 * lines.length + 6;
        });
    }

    // ---- UPOZORNĚNÍ ----
    if (r.upozorneni.length) {
        L.heading('Upozornění');
        L.y -= 6;
        for (const u of r.upozorneni) {
            const txt = u.text + (u.requiresVet ? ' Doporučujeme probrat s veterinářem.' : '');
            const lines = L.wrap(txt, 9.5, f.r, W - 16);
            L.need(12 * lines.length + 8);
            const h = 12 * lines.length + 6;
            L.rect(M, L.y - h + 10, 3, h, u.severity === 'INFO' ? C.muted : C.red);
            lines.forEach((ln, li) => L.text(ln, M + 10, L.y - li * 12, 9.5, f.r, C.text2));
            L.y -= h + 4;
        }
    }

    L.finish();
    return doc.save({ useObjectStreams: true });
}

/** Zalomení pro patičku (mimo Layout — kreslí se na hotové stránky). */
function wrapStatic(t: string, size: number, font: PDFFont, maxW: number): string[] {
    const words = t.split(' ').filter(Boolean);
    const out: string[] = [];
    let cur = '';
    for (const w of words) {
        const c = cur ? `${cur} ${w}` : w;
        if (font.widthOfTextAtSize(c, size) <= maxW || !cur) cur = c;
        else {
            out.push(cur);
            cur = w;
        }
    }
    if (cur) out.push(cur);
    return out;
}
