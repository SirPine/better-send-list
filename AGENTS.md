# AGENTS.md

Notes for AI coding agents (and people) working on this repo.

## Goal

Staff at the Hon. Shirley Chisholm Library (a branch of the Buffalo & Erie County Public Library) pull items from a daily **send list** PDF exported from SirsiDynix WorkFlows. This tool takes that PDF and gives it back with two additions for each item:

1. **The item's circulation note** (the Symphony "Circ Note"), added as one extra line.
2. **A scannable barcode of the item ID** (for example `00021428194821`), so staff can scan it at a computer instead of typing the digits.

That is the whole job. The PDF already has the title, call number, location and everything else staff need. **Do not look up or add other book data.**

## What needs the library system and what doesn't

- **Barcodes need no library access.** The item IDs are already printed on the send list. Read them from the PDF and draw the barcode locally. Use Code 128 unless the user says their scanners need something else (Codabar is the other common library format).
- **Only the circulation notes come from Symphony,** and not live: each week library IT drops a text file of every item and its note, which the server imports into SQLite.

## Current state

- `src/server.js`: Express app and API routes. It serves `public/` as static files and accepts the PDF upload. **There is no sign-in** (the user removed it; library IT hosts the app). It keeps the latest generated list with an anonymous session for **8 hours after it was generated** (the user's choice; using the page doesn't extend it), so a page refresh restores it (`GET /api/send-list/info`, then `GET /api/send-list`).
  - **Generating works.** `POST /api/send-list` returns the improved PDF, with counts in the `X-Send-List-Summary` header, or 422 with a message when the file has no item IDs.
  - **Upload limits** (the user asked for server-side protection): one file of at most 20 MB and one short field (`pageCount`), enforced by multer before anything is read into memory; at most 100 pages and 2,000 items (`MAX_PAGES`, `MAX_ITEMS` in `send-list.js`, 422 otherwise); and lists are built **one at a time in a queue** (the user's choice, so several branches uploading together all get their lists): later uploads wait their turn without their file being read yet, someone who gives up leaves the line, and only when 10 are already waiting (`MAX_WAITING`) is the next one refused with 503 and a "try again" message. Without these, a 1 MB, 2,000-page PDF took 25 s and 741 MB.
- `src/send-list.js`: builds the improved list. The real send list is a **Microsoft Access report** with items packed one after another and no empty line between them (each item ends with a `copy:1  item ID:0000214440471  type:…  location:…` line). So:
  - **Re-layout by blocks:** the list is cut into blocks: headings, and each item down to its ID line (a block also ends at any gap over 1.4 lines). The blocks are flowed onto fresh pages at **full size, never scaled** (the user's choice; scaling was tried and rejected).
  - **Only each block's own content is copied:** `src/pdf-content.js` splits a page's content stream into chunks (one text object, one line, or a style setting), each with its position. A block becomes a small form XObject holding just its chunks, plus every style chunk in order. So nothing hidden is left behind, and selecting, copying or searching finds each line once. The item's ID line is left out and redrawn without "item ID:…" (`redrawIdLine`). It also handles browser "print to PDF" copies (a page-wide `cm` flip, several lines in one text object, which it splits into one piece per line, restating the font and absolute position). Pages using anything else (XObjects, inline images, shadings) fall back to drawing the whole page clipped per block, which leaves hidden text and can't drop stray letters.
  - **Fonts for added text** are chosen from the source fonts' real names (Times/Nimbus Roman → Times, Arial/Helvetica → Helvetica), because pdf.js reports embedded Times as "sans-serif".
  - **Condensing and spacing:** the gap before a heading is at most 1.35 lines, a heading sits above its first item with the report's own snug spacing (measured from the list), and the blank space after each item is at most 0.6 lines.
  - **Repeated headings:** a heading that repeats the heading right before it (the report prints each location large, then smaller) is left out with its underline; the first is kept. The user asked for this. The Access report's page break per location group is dropped. A heading (with any headings right after it) only goes on a page with room for at least the first item below it; otherwise it moves to the next page. On the real list this keeps 17 pages even with the added lines.
  - **Stray letters:** a line that's just one letter (the report prints a lone "T" in its page-1 header) is dropped, at the user's request. Dropped lines are listed in `dropped`, and their text and underline chunks are skipped.
  - **Footers:** the report's footer (detected by "Page X of N", or as a bottom line set well apart) is dropped from the blocks and redrawn on every new page with the date and a correct "Page X of N".
  - **Circ note:** labeled "Note: …" (the user's wording) on the added line, starting under "copy:". It's cut short with "…" only if it would run into the barcode.
  - **Item ID moves under the barcode** (the user's choice): "item ID:…" is removed from the ID line by drawing that band in two pieces, with the part after the ID slid left to close the gap. The ID's digits are printed centered under the barcode on the added line. This is skipped (the ID stays in the line) if other text shares that band.
  - **Barcode:** Code 128 vector bars to the right of the title line and the ID line. **Every barcode starts at the same spot on every page of every list** (the user asked for this): `BARCODE_LEFT`, 416pt from the left edge, where the real list's barcodes sat when they followed its widest item text (404pt, after "item ID:…" is removed). The user chose this spot. Only an item whose text reaches into that space has its barcode start after its own text instead. Bar widths and the barcode's left edge snap to 300-dpi printer dots (0.96pt bars = 4 dots at 300 dpi, 8 at 600), because off-grid bars once caused a misread. All 127 barcodes on the real list decode with no misreads at 200, 300 and 600 dpi. At 150 dpi (screen resolution) some don't, so always check at print resolution and treat any unexpected decode as a failure.
  - **Checking output:** render pages to look at them, and use `pdftotext` to confirm the text layer: each item ID should appear exactly once (under its barcode), with no "item ID:" and one footer per page.
  - **Already processed:** the output PDF gets a `better-send-list:processed` keyword, and uploading such a file again is refused with a message.
- `src/circ-notes.js`: circ notes in SQLite (`node:sqlite`, `NOTES_DB`, default `data/notes.db`, never committed). Each week IT drops a new pipe-separated export of every item into `NOTES_DIR` (default `data/notes-import/`). The real file (`ChiAllMat.txt`, ~151k lines, 8.5 MB, never commit it) has one line per item: `itemID   |date|date|noteA|noteB|noteC|call number|`. Kept as light as possible (the user's ask):
  - On startup and then hourly, the newest `.txt` there is checked; if its name, size and modified time match the last import, nothing else happens. A file changed in the last minute is left until it settles (it may still be copying).
  - Only items **with** a note are stored. The file is streamed a line at a time, written to a fresh table, and swapped in with one transaction, so lookups never see half an import. The real file imports ~24.6k notes in ~0.5 s into a ~1 MB database.
  - An export with no notes in it (wrong or empty file) is not imported; the old notes stay. A failed import also keeps the old notes. Each import is logged in the `imports` table.
  - Parsing: the note is the **first two note fields** (4th and 5th) joined with "; ", with empty fields and repeats ("POP|POP") left out. The 6th field (staff comments like ".COMMENT. MISSING INSERT") is left out: the user said it doesn't help find material. IDs are trimmed (they're space-padded) and matched without leading zeros. A line whose first field has no digits is skipped (one real line has `DORA'S PICNIC-RI` as its ID).
  - `getCircNotes` keeps its shape: item IDs in, a `Map` of ID → note out.
- `src/sessions.js`: in-memory anonymous sessions (an HttpOnly cookie, 8-hour idle timeout), started on the first API request. They only hold the saved list.
- `public/`: the front end. `index.html` has the markup (one upload and preview view), `styles.css` the styles, and `app.js` the behavior. It previews with PDF.js.
- Run it with `npm run dev`, which restarts when files in `src/` change, or `npm start`. It serves http://localhost:3000. Restarting clears all saved lists. Changes in `public/` need only a browser refresh.

## Circ notes from library IT

- There is no live Symphony (ILSWS) connection. Library IT supplies the weekly export file and hosts the app.
- **Do not guess hostnames or client IDs or attempt logins against the live system.**

## Sign-in

- **There is none,** at the user's request: the page opens straight to the upload view. Anyone who can reach the server can use it, so it belongs on the library's internal network. Don't add accounts or sign-in back without asking.

## Testing without real data

- The layout was checked against a real 17-page, 127-item export (not in the repo; it holds real library data). Never commit real send lists.
- Check barcodes by decoding a rendered page, not just by looking at it.

## UI decisions to keep

These came from the user; don't undo them without asking.

- **One screen on desktop.** The page fits the window with no page scroll, and only the PDF preview scrolls. Below 900px wide, the cards stack and the page may scroll.
- **One view:** the upload card on the left and the preview on the right, with an even 24px around and between the cards.
  - **The preview gets the space:** side margins shrink with the window (`clamp(16px, 4vw, 80px)`) and the upload column flexes from 280 to 380px, so on a ~900px split-screen window the preview stays usable. The preview opens fitted to its width but **no bigger than 100%** (the user asked to see more of the list; on a wide window full width was ~126%), and the "Fit width" button fills the whole width, and in a narrow preview the toolbar stays on one line ("Fit width" becomes icon-only, via a container query).
- **Generation starts on upload.** There is no Generate button; a spinner shows in the preview while it runs.
- **"Need help?" is in the header, on the right.**
- **Downloads are named `YYYY-MM-DD - Send List.pdf`.**
- **Palette:** one gray (`--page`, also behind the PDF pages), the logo's indigo (`--accent`) for buttons and links, and white for cards and the header. Check text contrast on the gray.
