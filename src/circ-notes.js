const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { DatabaseSync } = require("node:sqlite");

/* Circulation notes, by item ID, kept in SQLite.

   Each week library IT drops a new text file listing every item into NOTES_DIR
   (default data/notes-import/). One item per line, fields separated by "|":

     0000138332879   |shelved under QE 521 .O43 1988|VOLCANOES*Ollier, Cliff|
     item ID          two note fields (the line ends with "|")

   An item's note is its two note fields joined with "; ", leaving out empty ones
   and repeats ("POP|POP" gives "POP"). A line of any other shape (such as the
   older export, with dates and a call number) is skipped, so a file in the wrong
   format imports nothing and the notes already stored are kept.

   On startup and then once an hour the newest .txt file there is checked. If it's
   the one already imported, nothing else happens. Otherwise only the items that
   have a note are stored, in a fresh table that replaces the old one in a single
   step, so a list being built never sees half an import.

   IDs are padded with spaces and some are missing leading zeros, so they're
   matched trimmed and without leading zeros. A line whose first field has no
   digits (a header) is skipped, and several lines for one item are joined. */

const DATA_DIR = path.join(__dirname, "..", "data");
const NOTES_DIR = process.env.NOTES_DIR || path.join(DATA_DIR, "notes-import");
const DB_PATH = process.env.NOTES_DB || path.join(DATA_DIR, "notes.db");
const CHECK_EVERY_MS = 60 * 60 * 1000;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, note TEXT NOT NULL) WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS imports (file TEXT NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL,
                                      notes INTEGER NOT NULL, imported_at TEXT NOT NULL);
`);
const findNote = db.prepare("SELECT note FROM notes WHERE id = ?");

// The same item ID with or without leading zeros gives the same key.
function normalizeId(id) {
  return id.trim().toUpperCase().replace(/^0+(?=.)/, "");
}

const FIELD_COUNT = 4;        // id|note|note| splits into four pieces, the last one empty
const NOTE_FIELDS = [1, 2];   // 2nd and 3rd fields of a line

// Joins notes with "; ", leaving out repeats (ignoring case).
function joinNotes(notes) {
  const kept = [];
  for (const note of notes) if (!kept.some((k) => k.toLowerCase() === note.toLowerCase())) kept.push(note);
  return kept.join("; ");
}

// One line of the export -> [id, note], or null for a header, a blank line or an item without a note.
function parseLine(line) {
  const fields = line.replace(/^﻿/, "").split("|");
  if (fields.length !== FIELD_COUNT) return null;
  const id = fields[0].trim();
  if (!/\d/.test(id)) return null;
  const note = joinNotes(NOTE_FIELDS.map((i) => fields[i].replace(/\s+/g, " ").trim()).filter(Boolean));
  return note ? [normalizeId(id), note] : null;
}

// The newest .txt file in NOTES_DIR, or null if there isn't one.
function newestExport() {
  let newest = null;
  let names;
  try {
    names = fs.readdirSync(NOTES_DIR);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  for (const name of names) {
    if (!name.toLowerCase().endsWith(".txt")) continue;
    const stat = fs.statSync(path.join(NOTES_DIR, name));
    if (stat.isFile() && (!newest || stat.mtimeMs > newest.mtime)) newest = { file: name, size: stat.size, mtime: stat.mtimeMs };
  }
  return newest;
}

function alreadyImported({ file, size, mtime }) {
  const last = db.prepare("SELECT file, size, mtime FROM imports ORDER BY rowid DESC LIMIT 1").get();
  return !!last && last.file === file && last.size === size && last.mtime === mtime;
}

// Reads the file a line at a time, keeping only the items with a note.
async function readNotes(file) {
  const notes = new Map();
  const lines = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of lines) {
    const parsed = parseLine(line);
    if (!parsed) continue;
    const [id, note] = parsed;
    const earlier = notes.get(id);
    notes.set(id, earlier ? joinNotes([...earlier.split("; "), ...note.split("; ")]) : note);
  }
  return notes;
}

// Replaces every note with the ones from this export, all in one transaction.
function replaceNotes(notes, source) {
  db.exec("BEGIN");
  try {
    db.exec("DROP TABLE IF EXISTS notes_new; CREATE TABLE notes_new (id TEXT PRIMARY KEY, note TEXT NOT NULL) WITHOUT ROWID");
    const insert = db.prepare("INSERT INTO notes_new (id, note) VALUES (?, ?)");
    for (const [id, note] of notes) insert.run(id, note);
    db.exec("DROP TABLE notes; ALTER TABLE notes_new RENAME TO notes");
    db.prepare("INSERT INTO imports (file, size, mtime, notes, imported_at) VALUES (?, ?, ?, ?, ?)")
      .run(source.file, source.size, source.mtime, notes.size, new Date().toISOString());
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

const SETTLE_MS = 60 * 1000;   // a file changed more recently than this may still be being copied in
let importing = false;
let skipped = null;            // "file:size:mtime" of an export with no notes, so it's only reported once

// Imports the newest export if it hasn't been imported yet.
async function checkForNewExport() {
  if (importing) return;
  importing = true;
  try {
    const source = newestExport();
    if (!source || alreadyImported(source)) return;
    const age = Date.now() - source.mtime;
    if (age < SETTLE_MS) {
      setTimeout(checkForNewExport, SETTLE_MS - age + 1000).unref();
      return;
    }
    const key = `${source.file}:${source.size}:${source.mtime}`;
    if (key === skipped) return;
    const notes = await readNotes(path.join(NOTES_DIR, source.file));
    if (notes.size === 0) {
      // Most likely a wrong or empty file: keep the notes we have rather than wipe them.
      console.warn(`Circ notes: ${source.file} has no notes in it, so it wasn't imported.`);
      skipped = key;
      return;
    }
    replaceNotes(notes, source);
    console.log(`Circ notes: imported ${notes.size} notes from ${source.file}.`);
  } catch (err) {
    console.error("Circ notes: import failed; the previous notes are still in use.", err);
  } finally {
    importing = false;
  }
}

// Checks for a new export now and then every hour.
function startNotesImport() {
  checkForNewExport();
  setInterval(checkForNewExport, CHECK_EVERY_MS).unref();
}

// Returns a Map of item ID -> circ note for the IDs that have one.
async function getCircNotes(itemIds) {
  const found = new Map();
  for (const id of itemIds) {
    const row = findNote.get(normalizeId(id));
    if (row) found.set(id, row.note);
  }
  return found;
}

module.exports = { getCircNotes, startNotesImport, checkForNewExport, NOTES_DIR, DB_PATH };
