const fs = require("node:fs/promises");
const path = require("node:path");

/* Circulation notes, by item ID.

   TEMPORARY: notes come from data/circ-notes.json until the server can read them
   from Symphony Web Services. Replace getCircNotes with the Symphony lookup and
   keep its shape (item IDs in, Map of item ID -> note out); nothing else changes. */

const NOTES_FILE = path.join(__dirname, "..", "data", "circ-notes.json");

// Returns a Map of item ID -> circ note for the IDs that have one.
async function getCircNotes(itemIds) {
  // Read on every call, so edits to the file show up without a restart.
  const notes = JSON.parse(await fs.readFile(NOTES_FILE, "utf8"));
  const found = new Map();
  for (const id of itemIds) {
    const note = notes[id];
    if (typeof note === "string" && note.trim()) found.set(id, note.trim());
  }
  return found;
}

module.exports = { getCircNotes };
