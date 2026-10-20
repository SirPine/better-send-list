const path = require("node:path");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");
const bwipjs = require("bwip-js");

/* Builds the improved send list: for each item on the uploaded WorkFlows send list,
   adds a "Circ note:" line under the item's ID column and a Code 128 barcode of the
   item ID in the space to the right of the item. Nothing on the original is moved;
   everything is drawn into empty space, using the list's own font, size and line spacing.

   Item layout this expects (two columns per item, from the WorkFlows export):
       Call Number: XX .G704                 Type: Compact Disc
       Title: Dookie                         Location: Open Shelf
       Author: Green Day (Musical group)     ID: 000089241749224
       Last discharged: 1/14/2025            Circ note: Rock under "Gr"   <- added */

const ID_LABEL = /(?:^|\s)ID:\s*(\d{8,})?/;   // "ID:" with the number in the same text run, or…
const LEADING_DIGITS = /^\s*(\d{8,})/;         // …the number as the next run on the line
const BARCODE_GAP = 12;                        // space each side of a barcode (≥ the scanner's quiet zone)
const NOTE_LABEL = /^\s*Circ note:/i;
const PROCESSED_MARK = "better-send-list:processed";   // keyword stamped on lists this tool has already done
const PRINT_MARGIN = 18;                       // keep additions ¼ inch from the paper edge, which every printer can print
const MAX_MODULE = 1.0;                        // widest bar unit, in points
const MIN_MODULE = 0.55;                       // narrowest that still scans reliably when printed
const BLACK = rgb(0, 0, 0);

const STANDARD_FONT_DATA = path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts") + path.sep;
let pdfjsModule;
const loadPdfjs = () => (pdfjsModule ??= import("pdfjs-dist/legacy/build/pdf.mjs"));

// An error whose message is safe to show to the person who uploaded the file.
class SendListError extends Error {}

/**
 * @param {Buffer} pdfBytes  the uploaded send list
 * @param {(ids: string[]) => Promise<Map<string, string>>} getCircNotes
 * @returns {Promise<{ pdf: Buffer, summary: { items, notes, barcodes, notesSkipped, barcodesSkipped } }>}
 */
async function buildSendList(pdfBytes, getCircNotes) {
  let doc;
  try {
    doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  } catch {
    throw new SendListError("This PDF couldn’t be opened for editing. It may be password-protected.");
  }
  const keywords = doc.getKeywords() ?? "";
  if (keywords.includes(PROCESSED_MARK)) {
    throw new SendListError("This send list already has circ notes and barcodes added. Upload the original from WorkFlows.");
  }

  const pages = await readPages(pdfBytes);
  const found = pages.flatMap((page, pageIndex) => findItems(page).map((item) => ({ ...item, pageIndex })));
  if (found.length === 0) {
    throw new SendListError("No item IDs were found in this PDF. Upload a send list exported from WorkFlows.");
  }

  const notes = await getCircNotes([...new Set(found.map((item) => item.id))]);
  const fonts = new FontSet(doc);
  const summary = { items: found.length, notes: 0, barcodes: 0, notesSkipped: 0, barcodesSkipped: 0 };

  const spots = found.map((item) => layoutFor(pages[item.pageIndex], item));
  alignBarcodes(found, spots);

  found.forEach((item, i) => {
    const out = doc.getPage(item.pageIndex);
    const spot = spots[i];

    const note = notes.get(item.id);
    if (note && !spot.hasNote) {   // an item that already shows a circ note keeps it
      if (spot.noteY !== null) {
        drawNote(out, fonts, item, spot, note);
        summary.notes++;
      } else {
        summary.notesSkipped++;
      }
    }

    if (drawBarcode(out, spot)) summary.barcodes++;
    else summary.barcodesSkipped++;
  });

  doc.setKeywords([...keywords.split(/\s+/).filter(Boolean), PROCESSED_MARK]);
  return { pdf: Buffer.from(await doc.save()), summary };
}

/* ---------- Reading the text and where it sits ---------- */

async function readPages(pdfBytes) {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: Uint8Array.from(pdfBytes),   // a copy: pdf.js takes ownership of the bytes it's given
    isEvalSupported: false,
    disableFontFace: true,
    standardFontDataUrl: STANDARD_FONT_DATA,
    verbosity: 0,
  });
  let doc;
  try {
    doc = await task.promise;
  } catch {
    await task.destroy();
    throw new SendListError("This PDF couldn’t be read. It may be damaged or password-protected.");
  }

  try {
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const { items, styles } = await page.getTextContent();
      const texts = items
        .filter((t) => t.str && t.str.trim())
        .map((t) => {
          const [a, b, c, d, x, y] = t.transform;
          return { str: t.str, x, y, width: t.width, size: Math.hypot(c, d) || Math.hypot(a, b), family: styles[t.fontName]?.fontFamily ?? "sans-serif" };
        });
      const [, bottom, right] = page.view;
      pages.push({ texts, lines: groupIntoLines(texts), bottom, right: right - PRINT_MARGIN });
    }
    return pages;
  } finally {
    await task.destroy();
  }
}

// Text runs on the same baseline form a line; lines run top to bottom, runs left to right.
function groupIntoLines(texts) {
  const lines = [];
  for (const t of [...texts].sort((p, q) => q.y - p.y || p.x - q.x)) {
    const line = lines.find((l) => Math.abs(l.y - t.y) <= Math.max(l.size, t.size) * 0.35);
    if (line) line.items.push(t);
    else lines.push({ y: t.y, size: t.size, items: [t] });
  }
  for (const line of lines) line.items.sort((p, q) => p.x - q.x);
  return lines.sort((p, q) => q.y - p.y);
}

// Every "ID: <number>" on the page, with the text run holding the label and its line.
function findItems(page) {
  const found = [];
  for (const line of page.lines) {
    line.items.forEach((run, i) => {
      const match = run.str.match(ID_LABEL);
      if (!match) return;
      const id = match[1] ?? line.items[i + 1]?.str.match(LEADING_DIGITS)?.[1];
      if (id) found.push({ id, label: run, line });
    });
  }
  return found;
}

/* ---------- Working out where the additions go ---------- */

function layoutFor(page, item) {
  const { label, line } = item;
  const size = label.size;
  const colX = label.x;
  const inColumn = (l) => l.items.some((t) => Math.abs(t.x - colX) <= size * 0.6);
  const hasOtherId = (l) => l !== line && l.items.some((t) => ID_LABEL.test(t.str) && Math.abs(t.x - colX) <= size * 0.6);

  // The lines of this item's column, and the spacing between them.
  const col = page.lines.filter(inColumn);
  const at = col.indexOf(line);
  const gapAbove = at > 0 ? col[at - 1].y - line.y : Infinity;
  const gapBelow = at < col.length - 1 ? line.y - col[at + 1].y : Infinity;
  const nearest = Math.min(gapAbove, gapBelow);
  const lineHeight = nearest >= size * 0.9 && nearest <= size * 2.2 ? nearest : size * 1.3;
  const sameBlock = (upper, lower) => upper.y - lower.y <= lineHeight * 1.35;

  // Rows of this item in the ID's column: up to 3 above the ID and 2 below, stopping at a gap or another item.
  let top = at;
  while (top > 0 && at - top < 3 && sameBlock(col[top - 1], col[top]) && !hasOtherId(col[top - 1])) top--;
  let bottom = at;
  while (bottom < col.length - 1 && bottom - at < 2 && sameBlock(col[bottom], col[bottom + 1]) && !hasOtherId(col[bottom + 1])) bottom++;
  const rows = col.slice(top, bottom + 1);
  const hasNote = rows.some((r) => r.items.some((t) => NOTE_LABEL.test(t.str) && Math.abs(t.x - colX) <= size * 0.6));

  // The note goes on the row right below the item's last row in this column. If that row is
  // taken, it's skipped rather than placed further down, where it could look like part of the next item.
  const candidate = rows[rows.length - 1].y - lineHeight;
  const noteY = candidate >= page.bottom + size && isFree(page, colX - 2, page.right, candidate - size * 0.3, candidate + size * 0.9) ? candidate : null;

  // The barcode sits right of the column, from the top of the item's first line to the bottom of its ID line.
  const columnRight = Math.max(...rows.flatMap((r) => r.items.filter((t) => t.x >= colX - size * 0.6).map((t) => t.x + t.width)));
  const barTop = rows[0].y + size * 0.7;     // cap height
  const barBottom = line.y - size * 0.2;     // descenders
  let right = page.right;
  for (const t of page.texts) {   // stop short of anything already printed in that space
    if (t.x > columnRight && t.x < right && t.y + t.size * 0.8 > barBottom && t.y - t.size * 0.25 < barTop) right = t.x;
  }

  return {
    size, colX, lineHeight, noteY, hasNote,
    textRight: page.right,
    barcode: { widths: barcodeWidths(item.id), columnRight, right: right - BARCODE_GAP, top: barTop, bottom: barBottom, x: null, module: null },
  };
}

// On each page, barcodes share one left edge and one bar width, so they line up in a neat column.
// Pages where that doesn't leave room fall back to fitting each barcode on its own.
function alignBarcodes(found, spots) {
  const byPage = new Map();
  found.forEach((item, i) => byPage.set(item.pageIndex, [...(byPage.get(item.pageIndex) ?? []), spots[i].barcode]));
  for (const bars of byPage.values()) {
    const x = Math.max(...bars.map((b) => b.columnRight)) + BARCODE_GAP;
    const module = Math.min(MAX_MODULE, ...bars.map((b) => (b.right - x) / modules(b.widths)));
    for (const b of bars) {
      if (module >= MIN_MODULE) {
        b.x = x;
        b.module = module;
      } else {
        b.x = b.columnRight + BARCODE_GAP;
        b.module = Math.min(MAX_MODULE, (b.right - b.x) / modules(b.widths));
      }
    }
  }
}

function barcodeWidths(id) {
  return bwipjs.raw("code128", id, {})[0].sbs;   // bar, space, bar, … in modules
}
const modules = (widths) => widths.reduce((sum, w) => sum + w, 0);

function isFree(page, x0, x1, y0, y1) {
  return !page.texts.some((t) => t.x < x1 && t.x + t.width > x0 && t.y < y1 && t.y + t.size * 0.8 > y0);
}

/* ---------- Drawing ---------- */

function drawNote(out, fonts, item, spot, note) {
  const { regular, bold } = fonts.for(item.label.family);
  const size = spot.size;
  const label = "Circ note:";
  const labelWidth = bold.widthOfTextAtSize(label, size);
  const valueX = spot.colX + labelWidth + bold.widthOfTextAtSize(" ", size);
  const value = fitText(regular, size, safeText(regular, note), spot.textRight - valueX);

  out.drawText(label, { x: spot.colX, y: spot.noteY, size, font: bold, color: BLACK });
  out.drawText(value, { x: valueX, y: spot.noteY, size, font: regular, color: BLACK });
}

// Draws the bars as vector rectangles. Returns false when there isn't room for a scannable barcode.
function drawBarcode(out, spot) {
  const { widths, x, module, top, bottom } = spot.barcode;
  if (!(module >= MIN_MODULE)) return false;

  const height = Math.min(Math.max(top - bottom, spot.size * 1.8), 42);
  let y = top - height;   // hangs from the top of the item's first line
  if (spot.noteY !== null) y = Math.max(y, spot.noteY + spot.size * 0.9);   // never over this item's note
  let cursor = x;
  widths.forEach((w, i) => {
    if (i % 2 === 0) out.drawRectangle({ x: cursor, y, width: w * module, height, color: BLACK });
    cursor += w * module;
  });
  return true;
}

// Standard PDF fonts matched to the list's own font style; embedded once per document.
class FontSet {
  constructor(doc) {
    this.doc = doc;
    this.cache = new Map();
  }
  for(family) {
    const key = /mono/i.test(family) ? "mono" : /serif/i.test(family) && !/sans/i.test(family) ? "serif" : "sans";
    if (!this.cache.has(key)) {
      const [regular, bold] = {
        serif: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold],
        sans: [StandardFonts.Helvetica, StandardFonts.HelveticaBold],
        mono: [StandardFonts.Courier, StandardFonts.CourierBold],
      }[key];
      this.cache.set(key, { regular: this.doc.embedStandardFont(regular), bold: this.doc.embedStandardFont(bold) });
    }
    return this.cache.get(key);
  }
}

// Standard fonts only cover Latin characters; anything else becomes "?" rather than failing.
function safeText(font, text) {
  const supported = new Set(font.getCharacterSet());
  return [...text.replace(/\s+/g, " ")].map((ch) => (supported.has(ch.codePointAt(0)) ? ch : "?")).join("");
}

function fitText(font, size, text, maxWidth) {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && font.widthOfTextAtSize(cut + "…", size) > maxWidth) cut = cut.slice(0, -1);
  return cut.trimEnd() + "…";
}

module.exports = { buildSendList, SendListError };
