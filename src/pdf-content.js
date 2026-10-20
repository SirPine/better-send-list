const { PDFArray, PDFRawStream, decodePDFRawStream } = require("pdf-lib");

/* Reads a page's content stream (its drawing instructions) and splits it into chunks:
   self-contained pieces such as one text object or one line, each with where it sits on
   the page. The send list builder copies only the chunks that belong to each block, so the
   output carries no hidden leftovers of the original page.

   Only what the WorkFlows (Access) report uses is understood: text objects positioned with
   Tm/Td, and simple paths. Anything else (a cm transform, a nested drawing, an inline image)
   returns null, and the caller falls back to drawing the whole page clipped. */

const PATH_BUILD = new Set(["m", "l", "c", "v", "y", "h", "re"]);
const PATH_PAINT = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"]);
const TEXT_SHOW = new Set(["Tj", "TJ", "'", '"']);
const UNSUPPORTED = new Set(["cm", "Do", "BI", "sh"]);

// The page's content as one string (latin1 keeps every byte as-is), or null if it can't be decoded.
function pageContent(page) {
  const contents = page.node.Contents();
  if (!contents) return "";
  const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
  let text = "";
  for (const ref of refs) {
    const stream = page.doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) return null;
    try {
      text += Buffer.from(decodePDFRawStream(stream).decode()).toString("latin1") + "\n";
    } catch {
      return null;
    }
  }
  return text;
}

/* ---------- Tokenizing ---------- */

const WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);
const DELIMITERS = new Set([...("()<>[]{}/%")].map((c) => c.charCodeAt(0)));

// Operations with their operands and where they sit in the text: [{ op, args, start, end }].
function operations(src) {
  const ops = [];
  let args = [];
  let argsStart = -1;
  let i = 0;
  const n = src.length;

  while (i < n) {
    const c = src.charCodeAt(i);
    if (WHITESPACE.has(c)) { i++; continue; }
    if (c === 37 /* % */) { while (i < n && src[i] !== "\n" && src[i] !== "\r") i++; continue; }
    const start = i;

    if (c === 40 /* ( */) {                       // literal string, with nesting and escapes
      let depth = 1;
      i++;
      while (i < n && depth) {
        const ch = src[i];
        if (ch === "\\") i += 2;
        else { if (ch === "(") depth++; else if (ch === ")") depth--; i++; }
      }
      pushArg(start, { str: true });
    } else if (src.startsWith("<<", i) || src.startsWith(">>", i)) {
      i += 2;
      pushArg(start, {});
    } else if (c === 60 /* < */) {                // hex string
      i = src.indexOf(">", i) + 1 || n;
      pushArg(start, { str: true });
    } else if (c === 91 /* [ */ || c === 93 /* ] */ || c === 123 || c === 125) {
      i++;
      pushArg(start, {});
    } else if (c === 47 /* / */) {                // name
      i++;
      while (i < n && !WHITESPACE.has(src.charCodeAt(i)) && !DELIMITERS.has(src.charCodeAt(i))) i++;
      pushArg(start, { name: src.slice(start, i) });
    } else {                                      // number or operator
      while (i < n && !WHITESPACE.has(src.charCodeAt(i)) && !DELIMITERS.has(src.charCodeAt(i))) i++;
      const word = src.slice(start, i);
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
        pushArg(start, { num: Number(word) });
      } else {
        if (word === "BI") return null;           // inline images aren't supported
        ops.push({ op: word, args, start: argsStart >= 0 ? argsStart : start, end: i });
        args = [];
        argsStart = -1;
      }
    }
  }
  return ops;

  function pushArg(start, value) {
    if (argsStart < 0) argsStart = start;
    args.push(value);
  }
}

/* ---------- Chunking ---------- */

/**
 * Splits a page's content into chunks, in order. Each chunk is
 *   { text: string, kind: "state" | "text" | "path", box?: { minX, maxX, minY, maxY }, lines?: [{ x, y, size }] }
 * "state" chunks draw nothing (line width, colours…) and are kept everywhere so later
 * chunks look as they did. Returns null if the content uses anything not understood.
 */
function chunkContent(src) {
  if (src === null) return null;
  const ops = operations(src);
  if (!ops) return null;

  const chunks = [];
  let i = 0;
  while (i < ops.length) {
    const { op } = ops[i];
    let j = i;
    if (op === "q") {
      for (let depth = 0; j < ops.length; j++) {
        if (ops[j].op === "q") depth++;
        else if (ops[j].op === "Q" && --depth === 0) break;
      }
    } else if (op === "BT") {
      while (j < ops.length && ops[j].op !== "ET") j++;
    } else if (PATH_BUILD.has(op)) {
      while (j < ops.length && !PATH_PAINT.has(ops[j].op)) j++;
    }
    if (j >= ops.length) return null;   // unbalanced q/Q, BT/ET or an unfinished path

    const group = ops.slice(i, j + 1);
    const measured = measure(group);
    if (!measured) return null;
    chunks.push({ text: src.slice(group[0].start, group[group.length - 1].end), ...measured });
    i = j + 1;
  }
  return chunks;
}

// Where a group of operations draws: text lines (from Tm/Td and the font size) and path points.
function measure(group) {
  const lines = [];
  const points = [];
  let size = 0, leading = 0;
  let lineX = 0, lineY = 0, scaleY = 1;
  let draws = false;

  for (const { op, args } of group) {
    if (UNSUPPORTED.has(op)) return null;
    const num = args.map((a) => a.num);
    switch (op) {
      case "Tf": size = num[1] ?? size; break;
      case "TL": leading = num[0] ?? leading; break;
      case "BT": lineX = 0; lineY = 0; scaleY = 1; break;
      case "Tm": [, , , scaleY, lineX, lineY] = num; scaleY = Math.abs(scaleY) || 1; break;
      case "Td": lineX += num[0]; lineY += num[1]; break;
      case "TD": lineX += num[0]; lineY += num[1]; leading = -num[1]; break;
      case "T*": lineY -= leading; break;
      case "'": case '"': lineY -= leading; break;
    }
    if (TEXT_SHOW.has(op)) {
      lines.push({ x: lineX, y: lineY, size: size * scaleY });
      draws = true;
    }
    if (op === "re") {
      points.push([num[0], num[1]], [num[0] + num[2], num[1] + num[3]]);
    } else if (PATH_BUILD.has(op)) {
      for (let k = 0; k + 1 < num.length; k += 2) points.push([num[k], num[k + 1]]);
    }
    if (PATH_PAINT.has(op) && op !== "n") draws = true;
  }

  if (!draws) return { kind: "state" };
  if (lines.length) {
    return { kind: "text", lines, box: box(lines.flatMap((l) => [[l.x, l.y - l.size * 0.25], [l.x, l.y + l.size * 0.8]])) };
  }
  return { kind: "path", box: box(points) };
}

function box(points) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

module.exports = { pageContent, chunkContent };
