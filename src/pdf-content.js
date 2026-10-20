const { PDFArray, PDFRawStream, decodePDFRawStream } = require("pdf-lib");

/* Reads a page's content stream (its drawing instructions) and splits it into chunks:
   self-contained pieces such as one text object or one line, each with where it sits on
   the page. The send list builder copies only the chunks that belong to each block, so the
   output carries no hidden leftovers of the original page.

   Understood: text positioned with Tm/Td/T*, simple paths and clips, and cm transforms
   (WorkFlows' Access report, and browser "print to PDF" copies of it). Anything else (a
   nested drawing, an inline image, a shading) returns null, and the caller falls back to
   drawing the whole page clipped. */

const PATH_BUILD = new Set(["m", "l", "c", "v", "y", "h", "re"]);
const PATH_PAINT = new Set(["S", "s", "f", "F", "f*", "B", "B*", "b", "b*", "n"]);
const TEXT_SHOW = new Set(["Tj", "TJ", "'", '"']);
const UNSUPPORTED = new Set(["Do", "BI", "sh"]);

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

// Text and colour state that later text depends on. Each kept text piece starts by restating
// it, so dropping an earlier piece (which may have set the font) can't change how a later one looks.
const CARRIED = {
  Tf: "Tf", Tc: "Tc", Tw: "Tw", Tz: "Tz", TL: "TL", Ts: "Ts", Tr: "Tr", gs: "gs",
  cs: "fillSpace", rg: "fill", g: "fill", k: "fill", sc: "fill", scn: "fill",
  CS: "strokeSpace", RG: "stroke", G: "stroke", K: "stroke", SC: "stroke", SCN: "stroke",
};
const CARRY_ORDER = ["gs", "fillSpace", "fill", "strokeSpace", "stroke", "Tf", "Tc", "Tw", "Tz", "TL", "Ts", "Tr"];
const LINE_SETTERS = new Set(["Tm", "Td", "TD", "T*"]);
const IDENTITY = [1, 0, 0, 1, 0, 0];

// m then n, as PDF matrices [a b c d e f].
const multiply = (m, n) => [
  m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5],
];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/**
 * Splits a page's content into chunks, in order. Each chunk is
 *   { text: string, kind: "state" | "text" | "path", box?: { minX, maxX, minY, maxY }, lines?: [{ x, y, size }] }
 * with positions in page space. "state" chunks draw nothing (q/Q, transforms, line width,
 * colours, clips) and are kept everywhere, in order, so later chunks look as they did.
 *
 * A q…Q group that draws one thing (the Access report's pattern: clip, one line of text)
 * stays whole. A group that draws several things is opened up, and a text object with several
 * lines (as browser "print to PDF" files have) is split into one piece per line.
 * Returns null if the content uses anything not understood.
 */
function chunkContent(src) {
  if (src === null) return null;
  const ops = operations(src);
  if (!ops) return null;
  const chunks = [];
  const state = { ctm: IDENTITY, carry: {}, leading: 0, fontSize: 0 };
  return walk(src, ops, 0, ops.length, state, chunks) ? chunks : null;
}

function walk(src, ops, from, to, state, chunks) {
  const slice = (i, j) => src.slice(ops[i].start, ops[j].end);
  let i = from;
  while (i < to) {
    const { op, args } = ops[i];
    if (UNSUPPORTED.has(op)) return false;

    if (op === "q") {
      const j = matching(ops, i, to, "q", "Q");
      if (j < 0) return false;
      if (countDrawn(ops, i + 1, j) <= 1) {
        const measured = simulate(ops, i, j, { ...state });
        if (!measured) return false;
        chunks.push({ text: slice(i, j), ...measured.chunk });
      } else {
        chunks.push({ text: "q", kind: "state" });
        if (!walk(src, ops, i + 1, j, { ...state, carry: { ...state.carry } }, chunks)) return false;
        chunks.push({ text: "Q", kind: "state" });
      }
      i = j + 1;
    } else if (op === "BT") {
      const j = matching(ops, i, to, "BT", "ET");
      if (j < 0) return false;
      if (!splitText(src, ops, i, j, state, chunks)) return false;
      i = j + 1;
    } else if (PATH_BUILD.has(op)) {
      let j = i;
      while (j < to && !PATH_PAINT.has(ops[j].op)) j++;
      if (j >= to) return false;
      const measured = simulate(ops, i, j, { ...state });
      if (!measured) return false;
      chunks.push({ text: slice(i, j), ...measured.chunk });
      i = j + 1;
    } else if (op === "Q" || op === "ET") {
      return false;   // unbalanced
    } else {
      chunks.push({ text: slice(i, i), kind: "state" });
      if (op === "cm") state.ctm = multiply(args.map((a) => a.num), state.ctm);
      if (CARRIED[op]) state.carry[CARRIED[op]] = slice(i, i);
      if (op === "Tf") state.fontSize = args[1]?.num ?? state.fontSize;
      if (op === "TL") state.leading = args[0]?.num ?? state.leading;
      i++;
    }
  }
  return true;
}

function matching(ops, i, to, open, close) {
  for (let depth = 0, j = i; j < to; j++) {
    if (ops[j].op === open) depth++;
    else if (ops[j].op === close && --depth === 0) return j;
  }
  return -1;
}

// How many separate things a run of operations draws: text lines and painted paths.
function countDrawn(ops, from, to) {
  let count = 0, lineHasShow = false;
  for (let i = from; i < to; i++) {
    const { op } = ops[i];
    if (LINE_SETTERS.has(op) || op === "BT") lineHasShow = false;
    if (TEXT_SHOW.has(op)) {
      if (!lineHasShow || op === "'" || op === '"') count++;
      lineHasShow = true;
    }
    if (PATH_PAINT.has(op) && op !== "n") count++;
  }
  return count;
}

// Splits a BT…ET text object into one chunk per line, each restating its font and absolute position.
function splitText(src, ops, bt, et, state, chunks) {
  const text = (i) => src.slice(ops[i].start, ops[i].end);
  let lineMatrix = IDENTITY;
  let piece = null;   // { matrix, carry, parts: [op text], lines: [] }

  const close = () => {
    if (piece?.lines.length) {
      const preamble = CARRY_ORDER.map((key) => piece.carry[key]).filter(Boolean);
      const tm = piece.matrix.map((n) => Math.round(n * 1e6) / 1e6).join(" ") + " Tm";
      const lines = piece.lines;
      chunks.push({
        text: ["BT", ...preamble, tm, ...piece.parts, "ET"].join("\n"),
        kind: "text",
        lines,
        box: box(lines.flatMap((l) => [[l.x, l.y - l.size * 0.25], [l.x, l.y + l.size * 0.8]])),
      });
    }
    piece = null;
  };
  const open = () => { piece = { matrix: lineMatrix, carry: { ...state.carry }, parts: [], lines: [] }; };

  for (let i = bt + 1; i < et; i++) {
    const { op, args } = ops[i];
    const num = args.map((a) => a.num);
    if (UNSUPPORTED.has(op)) return false;

    if (LINE_SETTERS.has(op)) {
      close();
      if (op === "Tm") lineMatrix = num;
      else if (op === "T*") lineMatrix = multiply([1, 0, 0, 1, 0, -state.leading], lineMatrix);
      else {
        if (op === "TD") state.leading = -num[1];
        lineMatrix = multiply([1, 0, 0, 1, num[0], num[1]], lineMatrix);
      }
      continue;
    }
    if (op === "'" || op === '"') {
      close();
      open();   // the piece starts on the line before; the operator itself moves down and shows
      if (op === '"') { state.carry.Tw = `${num[0]} Tw`; state.carry.Tc = `${num[1]} Tc`; }
      lineMatrix = multiply([1, 0, 0, 1, 0, -state.leading], lineMatrix);
    }
    if (!piece) open();

    if (CARRIED[op]) state.carry[CARRIED[op]] = text(i);
    if (op === "Tf") state.fontSize = num[1] ?? state.fontSize;
    if (op === "TL") state.leading = num[0] ?? state.leading;
    piece.parts.push(text(i));
    if (TEXT_SHOW.has(op)) {
      const m = multiply(lineMatrix, state.ctm);
      const [x, y] = apply(m, 0, 0);
      piece.lines.push({ x, y, size: state.fontSize * Math.hypot(m[2], m[3]) });
    }
  }
  close();
  return true;
}

// Where a self-contained run of operations draws (a q…Q group or a path), following
// transforms and text positioning inside it.
function simulate(ops, from, to, state) {
  const lines = [], points = [];
  let ctm = state.ctm, fontSize = state.fontSize, leading = state.leading;
  let lineMatrix = IDENTITY;
  const stack = [];
  let draws = false;

  for (let i = from; i <= to; i++) {
    const { op, args } = ops[i];
    if (UNSUPPORTED.has(op)) return null;
    const num = args.map((a) => a.num);
    switch (op) {
      case "q": stack.push(ctm); break;
      case "Q": ctm = stack.pop() ?? ctm; break;
      case "cm": ctm = multiply(num, ctm); break;
      case "Tf": fontSize = num[1] ?? fontSize; break;
      case "TL": leading = num[0] ?? leading; break;
      case "BT": lineMatrix = IDENTITY; break;
      case "Tm": lineMatrix = num; break;
      case "Td": lineMatrix = multiply([1, 0, 0, 1, num[0], num[1]], lineMatrix); break;
      case "TD": leading = -num[1]; lineMatrix = multiply([1, 0, 0, 1, num[0], num[1]], lineMatrix); break;
      case "T*": case "'": case '"': lineMatrix = multiply([1, 0, 0, 1, 0, -leading], lineMatrix); break;
    }
    if (TEXT_SHOW.has(op)) {
      const m = multiply(lineMatrix, ctm);
      const [x, y] = apply(m, 0, 0);
      lines.push({ x, y, size: fontSize * Math.hypot(m[2], m[3]) });
      draws = true;
    }
    if (op === "re") {
      points.push(apply(ctm, num[0], num[1]), apply(ctm, num[0] + num[2], num[1] + num[3]));
    } else if (PATH_BUILD.has(op)) {
      for (let k = 0; k + 1 < num.length; k += 2) points.push(apply(ctm, num[k], num[k + 1]));
    }
    if (PATH_PAINT.has(op) && op !== "n") draws = true;
  }

  if (!draws) return { chunk: { kind: "state" } };
  if (lines.length) {
    return { chunk: { kind: "text", lines, box: box(lines.flatMap((l) => [[l.x, l.y - l.size * 0.25], [l.x, l.y + l.size * 0.8]])) } };
  }
  return { chunk: { kind: "path", box: box(points) } };
}

function box(points) {
  const xs = points.map((p) => p[0]), ys = points.map((p) => p[1]);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}

module.exports = { pageContent, chunkContent };
