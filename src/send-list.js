const path = require("node:path");
const {
  PDFDocument, PDFObjectCopier, PDFDict, PDFName, StandardFonts, rgb,
  pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject, rectangle, clip, endPath, fill, setFillingGrayscaleColor,
} = require("pdf-lib");
const bwipjs = require("bwip-js");
const { pageContent, chunkContent } = require("./pdf-content");

/* Builds the improved send list from the WorkFlows send list (a Microsoft Access report).
   For each item it adds a line under the item for its circ note, moves "item ID:…" out of
   the item's last line, and puts a Code 128 barcode of the ID beside the item with the
   digits under it:

       J FICTION                                                 Last Discharged:
          Barkley, Callie                                            08/23/2026
          Liz and the sand castle contest / Callie Barkley ;       ||||||||||||||
             copy:1   type:J-FICTION   location:B-OPENSHLF         ||||||||||||||
             Note: Shelved in Openshelf                             0000238447387   <- added

   The report packs items with no room for that line, and starts each location group on a
   new page. So the list is cut into blocks (headings, and each item down to its ID line),
   and the blocks are flowed onto fresh pages at full size: big gaps are closed up, a
   heading is never left alone at the bottom of a page, and each page gets a new footer
   with the report's date and a correct "Page X of N". Every barcode starts at the same
   spot (BARCODE_LEFT) on every page of every list. */

const ID_LABEL = /(?:^|\s)ID:\s*(\d{8,})?/;   // "ID:" with the number in the same text run, or…
const LEADING_DIGITS = /^\s*(\d{8,})/;         // …the number as the next run on the line
const PAGE_NUMBER = /Page\s+\d+\s+of\s+\d+/i;
const PROCESSED_MARK = "better-send-list:processed";   // keyword stamped on lists this tool has already done
const PRINT_MARGIN = 18;                       // keep additions ¼ inch from the paper edge, which every printer can print
const FOOTER_GAP = 8;                          // keep the content at least this far above the page footer
const MAX_GAP_LINES = 1.35;                    // gaps before headings are closed up to at most this many lines…
const ITEM_GAP_LINES = 0.6;                    // …and the blank space after each item to this much
const BARCODE_GAP = 12;                        // space each side of a barcode (≥ the scanner's quiet zone)
const BARCODE_LEFT = 416;                      // where every barcode starts, in points from the page's left edge
                                               // (just right of the widest item text on the real list, 404pt)
const MAX_MODULE = 1.0;                        // widest bar unit, in points
const PRINTER_DOT = 72 / 300;                  // bars and barcode edges snap to 300-dpi dots (also exact at 600 dpi),
                                               // so printers don't round some bars a dot wider than others
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
 * @returns {Promise<{ pdf: Buffer, summary: { items, notes, barcodes, notesShortened, barcodesSkipped, pages, originalPages } }>}
 */
async function buildSendList(pdfBytes, getCircNotes) {
  let source;
  try {
    source = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  } catch {
    throw new SendListError("This PDF couldn’t be opened for editing. It may be password-protected.");
  }
  if ((source.getKeywords() ?? "").includes(PROCESSED_MARK)) {
    throw new SendListError("This send list already has circ notes and barcodes added. Upload the original from WorkFlows.");
  }

  const pages = await readPages(pdfBytes);
  // pdf.js only guesses a font's style (it calls embedded Times "sans-serif"), so go by the fonts' real names.
  const family = documentFamily(source);
  if (family) for (const page of pages) for (const t of page.texts) t.family = family;
  const list = analyse(pages, source.getPages().map((p) => p.getMediaBox()));
  if (list.items.length === 0) {
    throw new SendListError("No item IDs were found in this PDF. Upload a send list exported from WorkFlows.");
  }
  const notes = await getCircNotes([...new Set(list.items.map((item) => item.id))]);

  const out = await PDFDocument.create();
  const fonts = new FontSet(out);
  const layout = paginate(list);
  placeBarcodes(list);
  const summary = { items: list.items.length, notes: 0, barcodes: 0, notesShortened: 0, barcodesSkipped: 0, pages: layout.length, originalPages: pages.length };

  // Each block is drawn from only its own pieces of the original page's content, so nothing
  // hidden is left behind (selecting, copying or searching the output finds each line once).
  const sourcePages = source.getPages();
  const content = sourcePages.map((page) => chunkContent(pageContent(page)));
  const copier = PDFObjectCopier.for(source.context, out.context);   // one copier: shared fonts are copied once
  const resources = new Map();
  const resourcesOf = (p) => {
    if (!resources.has(p)) resources.set(p, out.context.register(copier.copy(sourcePages[p].node.Resources())));
    return resources.get(p);
  };
  // Pages whose content couldn't be read are drawn whole and clipped to each block instead.
  let embedded;
  const original = async (p) => (embedded ??= await out.embedPages(sourcePages))[p];

  for (const [index, placed] of layout.entries()) {
    const box = list.box;
    const page = out.addPage([box.width, box.height]);
    page.setMediaBox(box.x, box.y, box.width, box.height);

    for (const { block, dy } of placed) {
      const chunks = content[block.page];
      if (chunks) {
        drawBlock(out, page, block, dy, chunks, resourcesOf(block.page), list.dropped);
        if (block.item?.removeId) redrawIdLine(page, fonts, block.item, dy);
      } else {
        const from = await original(block.page);
        for (const piece of pieces(block)) {
          const { left, right, bottom, top, dx } = piece;
          page.pushOperators(pushGraphicsState(), rectangle(round(left + dx), round(bottom + dy), round(right - left), round(top - bottom)), clip(), endPath());
          page.drawPage(from, { x: round(block.box.x + dx), y: round(block.box.y + dy) });
          page.pushOperators(popGraphicsState());
        }
      }

      const item = block.item;
      if (!item) continue;
      const note = notes.get(item.id);
      if (note) {
        if (drawNote(page, fonts, item, dy, note, list)) summary.notesShortened++;
        summary.notes++;
      }
      if (drawBarcode(page, fonts, item, dy, list)) summary.barcodes++;
      else summary.barcodesSkipped++;
    }

    drawFooter(page, fonts, list.footer, index + 1, layout.length);
  }

  out.setTitle(source.getTitle() ?? "Send list");
  out.setKeywords([...(source.getKeywords() ?? "").split(/\s+/).filter(Boolean), PROCESSED_MARK]);
  out.setProducer("Send List Builder");
  return { pdf: Buffer.from(await out.save()), summary };
}

/* ---------- Reading the text and where it sits ---------- */

// "serif", "sans-serif" or "monospace", from the names of the fonts the list uses (most common wins).
function documentFamily(doc) {
  const votes = { serif: 0, "sans-serif": 0, monospace: 0 };
  const seen = new Set();
  for (const page of doc.getPages()) {
    const fonts = page.node.Resources()?.lookupMaybe(PDFName.of("Font"), PDFDict);
    for (const [, ref] of fonts?.entries() ?? []) {
      const font = doc.context.lookup(ref, PDFDict);
      const name = String(font.get(PDFName.of("BaseFont")) ?? "").replace(/^\/([A-Z]{6}\+)?/, "");
      if (!name || seen.has(name)) continue;
      seen.add(name);
      if (/courier|mono|consol/i.test(name)) votes.monospace++;
      else if (/sans|arial|helvetica|calibri|verdana|tahoma|segoe|gothic/i.test(name)) votes["sans-serif"]++;
      else if (/times|roman|serif|georgia|garamond|cambria|palatino|century|book/i.test(name)) votes.serif++;
    }
  }
  const [best, count] = Object.entries(votes).sort((a, b) => b[1] - a[1])[0];
  return count ? best : null;
}

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
      pages.push({ texts, lines: groupIntoLines(texts) });
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
  for (const line of lines) {
    line.items.sort((p, q) => p.x - q.x);
    line.top = Math.max(...line.items.map(top));
    line.bottom = Math.min(...line.items.map(bottom));
  }
  return lines.sort((p, q) => q.y - p.y);
}

const top = (t) => t.y + t.size * 0.8;       // ascenders
const bottom = (t) => t.y - t.size * 0.25;   // descenders

// The "ID: <number>" on a line, if it has one.
function itemOn(line) {
  for (const [i, run] of line.items.entries()) {
    const match = run.str.match(ID_LABEL);
    if (!match) continue;
    const id = match[1] ?? line.items[i + 1]?.str.match(LEADING_DIGITS)?.[1];
    if (id) return { id, run, line };
  }
  return null;
}

/* ---------- Cutting the list into blocks ---------- */

function analyse(pages, boxes) {
  const allIds = pages.flatMap((page) => page.lines.map(itemOn).filter(Boolean));
  const size = allIds[0]?.run.size ?? 11;
  const lineHeight = measureLineHeight(pages, allIds, size);
  const blocks = [];
  const items = [];
  let footer = null;
  let topLimit = Infinity;
  const dropped = [];   // lines left out (stray letters, repeated headings), so their content chunks are skipped too
  let previousHeading = null;   // the last line, if it was a heading, for spotting a repeat right after it

  pages.forEach((page, p) => {
    const box = boxes[p];
    const lines = page.lines;

    // A page footer (date, "Page X of N") is the bottom line, if it has a page number or is set well
    // apart from the rest. It's redrawn on every new page.
    const last = lines[lines.length - 1];
    const aboveLast = lines[lines.length - 2];
    const isFooter = Boolean(last && !itemOn(last) &&
      (last.items.some((t) => PAGE_NUMBER.test(t.str)) || (aboveLast && aboveLast.y - last.y > lineHeight * 3)));
    if (isFooter) footer ??= last;
    // A line that's just one stray letter (the report prints a lone "T" in its header) is left out.
    // Left out: a line that's just one stray letter (the report prints a lone "T" in its header),
    // and a heading that repeats the heading right before it (the report prints each location
    // twice, large then smaller; the first is kept).
    const textOf = (line) => line.items.map((t) => t.str).join(" ").replace(/\s+/g, " ").trim().toLowerCase();
    const isHeading = (line) => line.size >= size * 1.15;
    const leaveOut = (line) => {
      if (line.items.length === 1 && /^[A-Za-z]$/.test(line.items[0].str.trim())) return true;
      const repeat = isHeading(line) && previousHeading !== null && textOf(line) === previousHeading;
      previousHeading = isHeading(line) ? textOf(line) : null;
      return repeat;
    };
    const kept = [];
    for (const line of isFooter ? lines.slice(0, -1) : lines) {
      if (!leaveOut(line)) { kept.push(line); continue; }
      dropped.push({ page: p, x0: Math.min(...line.items.map((t) => t.x)), x1: Math.max(...line.items.map((t) => t.x + t.width)), y: line.y, size: line.size });
    }
    const content = kept;
    if (!content.length) return;
    if (topLimit === Infinity) topLimit = content[0].top;   // pages start where the report's first page does

    // A block ends after an item's ID line, or where a gap of more than a line and a half opens up.
    const pageBlocks = [];
    let current = [];
    const close = (item) => {
      if (current.length) pageBlocks.push({ page: p, box, lines: current, item, top: Math.max(...current.map((l) => l.top)), bottom: Math.min(...current.map((l) => l.bottom)) });
      current = [];
    };
    content.forEach((line, i) => {
      if (i > 0 && content[i - 1].y - line.y > lineHeight * 1.4) close(null);
      current.push(line);
      const found = itemOn(line);
      if (found) close(describeItem(found, current, lineHeight));
    });
    close(null);

    // Each block's clip reaches halfway to its neighbours (so heading underlines come along), at most 6pt past its text.
    pageBlocks.forEach((block, i) => {
      const above = pageBlocks[i - 1], below = pageBlocks[i + 1];
      block.clipTop = above ? Math.min(block.top + 6, (above.bottom + block.top) / 2) : block.top + 6;
      block.clipBottom = below ? Math.max(block.bottom - 6, (block.bottom + below.top) / 2) : Math.max(block.bottom - 6, isFooter ? last.top + 1 : box.y);
      if (block.item) items.push(block.item);
    });
    blocks.push(...pageBlocks);
  });

  // How close the report sets a heading above an item's first line (measured where they share a block).
  const headingGaps = blocks.flatMap((b) => b.lines.slice(1).map((line, i) => [b.lines[i], line]))
    .filter(([above, below]) => above.size >= size * 1.15 && below.size < size * 1.15)
    .map(([above, below]) => above.bottom - below.top)
    .filter((g) => g >= 0)
    .sort((a, b) => a - b);
  const headingGap = headingGaps.length ? headingGaps[Math.floor(headingGaps.length / 2)] : null;

  const box = boxes[0];
  const footerTop = footer ? footer.top : null;
  return {
    blocks, items, lineHeight, box, dropped, headingGap, headingSize: size * 1.15,
    footer: footer && { runs: footer.items },
    topLimit: Math.min(topLimit, box.y + box.height - PRINT_MARGIN),
    bottomLimit: footerTop !== null ? footerTop + FOOTER_GAP : box.y + PRINT_MARGIN,
    barRight: box.x + box.width - PRINT_MARGIN,
  };
}

// Where an item's pieces go: its ID line, the title line above it, and the "item ID:…" text to take out.
function describeItem({ id, run, line }, blockLines, lineHeight) {
  const size = run.size;
  const i = blockLines.indexOf(line);
  const title = i > 0 && blockLines[i - 1].y - line.y <= lineHeight * 1.4 ? blockLines[i - 1] : null;
  const next = line.items.find((t) => t !== run && t.x >= run.x + run.width - 0.5 && t.str.trim());
  const gap = next ? next.x - run.x : run.width;
  const bandTop = top(run) + 0.5;
  // Only take the ID out if nothing else in the block reaches into the ID line's band.
  const removeId = !blockLines.some((l) => l !== line && l.bottom < bandTop);
  const lineRight = Math.max(...line.items.map((t) => t.x + t.width)) - (removeId ? gap : 0);
  return {
    id, run, line, size, removeId, bandTop,
    idStart: run.x, idEnd: run.x + gap,
    lineX: line.items[0].x,
    barTop: title ? title.y + size * 0.45 : line.y + size * 0.72,   // a little below the top of the title, clear of the date above
    textRight: Math.max(lineRight, ...(title ? title.items.map((t) => t.x + t.width) : [])),
  };
}

// The parts of a block to draw: all of it, or, when the ID comes out, the ID line in two pieces
// with the part after "item ID:…" slid left to close the gap.
function pieces(block) {
  const left = block.box.x, right = block.box.x + block.box.width;
  const item = block.item;
  if (!item?.removeId) return [{ left, right, bottom: block.clipBottom, top: block.clipTop, dx: 0 }];
  return [
    { left, right, bottom: item.bandTop, top: block.clipTop, dx: 0 },
    { left, right: item.idStart, bottom: block.clipBottom, top: item.bandTop, dx: 0 },
    { left: item.idEnd, right, bottom: block.clipBottom, top: item.bandTop, dx: item.idStart - item.idEnd },
  ];
}

// The spacing between lines inside an item, from the line above each ID line.
function measureLineHeight(pages, ids, size) {
  const gaps = [];
  for (const page of pages) {
    for (const { line } of ids) {
      const i = page.lines.indexOf(line);
      if (i > 0) gaps.push(page.lines[i - 1].y - line.y);
    }
  }
  const usable = gaps.filter((g) => g >= size * 0.9 && g <= size * 2.2).sort((a, b) => a - b);
  return usable.length ? usable[Math.floor(usable.length / 2)] : size * 1.35;
}

/* ---------- Flowing blocks onto pages ---------- */

// Returns pages of { block, dy }, where dy moves the block from its place on the original page.
function paginate(list) {
  const { blocks, lineHeight, topLimit, bottomLimit } = list;
  const itemGap = lineHeight * ITEM_GAP_LINES;
  const sectionGap = lineHeight * MAX_GAP_LINES;
  const startsWithHeading = (b) => b.lines[0].size >= list.headingSize;
  const height = (b) => b.top - b.bottom + (b.item ? lineHeight : 0);   // items get one added line
  // Even spacing: a section gap before every heading, the report's own snug gap from a heading
  // to its first item, and the tightened item gap between items.
  const gapBefore = (b, prev) => {
    const original = prev && prev.page === b.page ? prev.bottom - b.top : Infinity;
    if (startsWithHeading(b)) return Math.min(original, sectionGap);
    if (!prev?.item && list.headingGap !== null) return list.headingGap;
    return Math.min(original, prev?.item ? itemGap : sectionGap);
  };

  const pages = [[]];
  let y = topLimit;
  blocks.forEach((block, i) => {
    let gap = pages.at(-1).length ? gapBefore(block, blocks[i - 1]) : 0;
    let need = gap + height(block);
    // A heading must have room below it, on the same page, for any headings right after it
    // and at least the first item that follows them.
    if (!block.item) {
      for (let k = i + 1, before = block; k < blocks.length; before = blocks[k++]) {
        need += gapBefore(blocks[k], before) + height(blocks[k]);
        if (blocks[k].item) break;
      }
    }
    if (pages.at(-1).length && y - need < bottomLimit) {
      pages.push([]);
      y = topLimit;
      gap = 0;
    }
    const dy = y - gap - block.top;
    pages.at(-1).push({ block, dy });
    y = block.bottom + dy - (block.item ? lineHeight : 0);
  });
  return pages;
}

// Every barcode starts at the same spot on every page of every list: BARCODE_LEFT from the left
// edge. Only an item whose text reaches into that spot has its barcode start after its own text
// instead (narrower, or left out if it would be too narrow to scan).
function placeBarcodes(list) {
  const fixed = list.box.x + BARCODE_LEFT;
  for (const item of list.items) item.barLeft = Math.max(fixed, item.textRight + BARCODE_GAP);
}

const round = (n) => Math.round(n * 1000) / 1000;   // 1/1000 pt is far finer than any printer

const barcodeWidths = (id) => bwipjs.raw("code128", id, {})[0].sbs;   // bar, space, bar, … in modules
const modules = (widths) => widths.reduce((sum, w) => sum + w, 0);

/* ---------- Drawing ---------- */

// Copies the block's own chunks of the original page into a small form, drawn moved by dy.
// Settings that draw nothing (line width, colours) are kept in order so lines look as before.
// When the item's ID is coming out, its ID line is left out here and redrawn by redrawIdLine.
function drawBlock(out, page, block, dy, chunks, resourcesRef, dropped) {
  const item = block.item;
  const anchor = (c) => (c.kind === "text" ? c.lines[0].y + c.lines[0].size * 0.3 : (c.box.minY + c.box.maxY) / 2);
  const isIdLine = (c) => item?.removeId && c.kind === "text" && c.lines.some((l) => Math.abs(l.y - item.line.y) < 1);
  // A left-out line's text, and its underline (a line or bar just under its baseline, within its width).
  const isDropped = (c) => dropped.some((d) => d.page === block.page && (c.kind === "text"
    ? c.lines.every((l) => Math.abs(l.y - d.y) < 1 && l.x >= d.x0 - 1 && l.x <= d.x1)
    : c.box.minX >= d.x0 - 2 && c.box.maxX <= d.x1 + 2 && c.box.maxY <= d.y + 1 && c.box.minY >= d.y - d.size * 0.45));
  const mine = chunks.filter((c) => c.kind === "state" || (anchor(c) >= block.clipBottom && anchor(c) <= block.clipTop && !isIdLine(c) && !isDropped(c)));

  const { x, y, width, height } = block.box;
  const form = out.context.flateStream(Buffer.from(mine.map((c) => c.text).join("\n"), "latin1"), {
    Type: "XObject",
    Subtype: "Form",
    BBox: [x, y, x + width, y + height],
    Resources: resourcesRef,
  });
  const name = page.node.newXObject("Block", out.context.register(form));
  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, 0, round(dy)), drawObject(name), popGraphicsState());
}

// The item's ID line without "item ID:…": the text after it slides left to close the gap.
function redrawIdLine(page, fonts, item, dy) {
  const shift = item.idEnd - item.idStart;
  for (const run of item.line.items) {
    if (run === item.run || !run.str.trim()) continue;
    const { regular } = fonts.for(run.family);
    const x = run.x >= item.idEnd - 0.5 ? run.x - shift : run.x;
    page.drawText(safeText(regular, run.str), { x: round(x), y: round(item.line.y + dy), size: round(run.size), font: regular, color: BLACK });
  }
}

// Returns true if the note had to be shortened to fit.
function drawNote(page, fonts, item, dy, note, list) {
  const { regular, bold } = fonts.for(item.run.family);
  const size = item.size;
  const y = item.line.y - list.lineHeight + dy;
  const label = "Note:";
  const valueX = item.lineX + bold.widthOfTextAtSize(label + " ", size);
  const text = safeText(regular, note);
  const value = fitText(regular, size, text, item.barLeft - BARCODE_GAP - valueX);

  page.drawText(label, { x: round(item.lineX), y: round(y), size: round(size), font: bold, color: BLACK });
  page.drawText(value, { x: round(valueX), y: round(y), size: round(size), font: regular, color: BLACK });
  return value !== text;
}

// Draws the bars as vector rectangles beside the title and ID lines, with the ID's digits
// centered under them on the added line. Returns false when there isn't room for a barcode that scans.
function drawBarcode(page, fonts, item, dy, list) {
  const widths = barcodeWidths(item.id);
  const left = Math.ceil(item.barLeft / PRINTER_DOT) * PRINTER_DOT;
  const module = Math.floor(Math.min(MAX_MODULE, (list.barRight - left) / modules(widths)) / PRINTER_DOT) * PRINTER_DOT;
  if (!(module >= MIN_MODULE)) return false;

  const barTop = item.barTop + dy;
  const barBottom = item.line.y - item.size * 0.22 + dy;
  // All the bars as one filled shape: much smaller in the file than a separate rectangle per bar.
  const bars = [];
  let x = left;
  widths.forEach((w, i) => {
    if (i % 2 === 0) bars.push(rectangle(round(x), round(barBottom), round(w * module), round(barTop - barBottom)));
    x += w * module;
  });
  page.pushOperators(pushGraphicsState(), setFillingGrayscaleColor(0), ...bars, fill(), popGraphicsState());

  const barWidth = x - left;
  const { regular } = fonts.for(item.run.family);
  const digitSize = Math.min(item.size, item.size * barWidth / regular.widthOfTextAtSize(item.id, item.size));
  const digitsWidth = regular.widthOfTextAtSize(item.id, digitSize);
  page.drawText(item.id, { x: round(left + (barWidth - digitsWidth) / 2), y: round(item.line.y - list.lineHeight + dy), size: round(digitSize), font: regular, color: BLACK });
  return true;
}

// The original footer's text in its original place, with "Page X of N" updated for the new page count.
function drawFooter(page, fonts, footer, number, total) {
  if (!footer) return;
  for (const run of footer.runs) {
    const { regular } = fonts.for(run.family);
    const text = safeText(regular, run.str.replace(PAGE_NUMBER, `Page ${number} of ${total}`));
    const right = run.x + run.width;   // page numbers stay right-aligned where they were
    const x = PAGE_NUMBER.test(run.str) ? right - regular.widthOfTextAtSize(text, run.size) : run.x;
    page.drawText(text, { x: round(x), y: round(run.y), size: round(run.size), font: regular, color: BLACK });
  }
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
