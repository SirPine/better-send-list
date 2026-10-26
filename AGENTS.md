# AGENTS.md

Notes for AI coding agents (and people) working on this repo.

## Goal

Staff at the Hon. Shirley Chisholm Library (a branch of the Buffalo & Erie County Public Library) pull items from a daily **send list** PDF exported from SirsiDynix WorkFlows. This tool takes that PDF and gives it back with two additions for each item:

1. **The item's circulation note** (the Symphony "Circ Note"), added as one extra line.
2. **A scannable barcode of the item ID** (for example `00021428194821`), so staff can scan it at a computer instead of typing the digits.

That is the whole job. The PDF already has the title, call number, location and everything else staff need. **Do not look up or add other book data.**

## What needs the library system and what doesn't

- **Barcodes need no library access.** The item IDs are already printed on the send list. Read them from the PDF and draw the barcode locally. Use Code 128 unless the user says their scanners need something else (Codabar is the other common library format).
- **Only the circulation notes need Symphony.** That's one lookup per item, by item ID, through SirsiDynix Symphony Web Services (ILSWS).

## Current state

- `src/server.js`: Express app and API routes. It serves `public/` as static files and accepts the PDF upload. It keeps the latest generated list with the session, so a page refresh restores it.
  - **Sign-in checks real accounts** (`POST /api/session`). Every signed-in route also checks that the account still exists and that its password hasn't changed since the session started.
  - **Generating works.** `POST /api/send-list` returns the improved PDF, with counts in the `X-Send-List-Summary` header, or 422 with a message when the file has no item IDs.
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
- `src/circ-notes.js`: **temporary.** It reads notes from `data/circ-notes.json` (item ID → note). Replace `getCircNotes` with the Symphony lookup and keep its shape: item IDs in, a `Map` of ID → note out.
- `src/users.js`: accounts in SQLite (`node:sqlite`, file `data/users.db` or `DB_PATH`). Passwords are salted and hashed with scrypt (N=2^17, r=8, p=1); the stored string carries its parameters. Unknown user IDs are checked against a stand-in hash so they take as long as wrong passwords.
- `src/login-throttle.js`: 5 wrong passwords for one user ID from one address, or 20 from one address in total, block sign-in from there for 15 minutes. It's in memory.
- `scripts/users.js` (`npm run users`): the only way to add, reset, remove or list accounts.
- `src/sessions.js`: in-memory sessions (an HttpOnly cookie, 8-hour idle timeout).
- `public/`: the front end. `index.html` has the markup (sign-in view, then the upload and preview view), `styles.css` the styles, and `app.js` the behavior. It previews with PDF.js.
- Run it with `npm run dev`, which restarts when files in `src/` change, or `npm start`. It serves http://localhost:3000. Restarting clears all sessions. Changes in `public/` need only a browser refresh.

## Connecting to Symphony (blocked on library IT)

- The public catalog is SirsiDynix Enterprise, hosted by SirsiDynix at `bepl.ent.sirsi.net`, and reachable from outside the library.
- The ILSWS base URL and a **client ID** must come from the library system's central IT. They are not known yet. `bepl.sirsi.net` does not exist.
- **Do not guess hostnames or client IDs or attempt logins against the live system.** Wait for IT to provide them.
- When they arrive, `src/server.js` uses them to read each item's circ note. How the server signs in to Symphony (for example a dedicated library account held by the server) is not decided yet.

## Sign-in

- People sign in to **this server's own accounts**, not to WorkFlows or Symphony.
- **Only the administrator (the user) creates accounts**, with `npm run users` on the server. Don't add sign-up, self-service password reset, or account management to the website without asking.
- Never store or log passwords, and never commit `data/users.db`; it's in `.gitignore`.

## Testing without real data

- The layout was checked against a real 17-page, 127-item export (not in the repo; it holds real library data). Never commit real send lists.
- Check barcodes by decoding a rendered page, not just by looking at it.

## UI decisions to keep

These came from the user; don't undo them without asking.

- **One screen on desktop.** The page fits the window with no page scroll, and only the PDF preview scrolls. Below 900px wide, the cards stack and the page may scroll.
- **Two views.**
  - Sign-in: a centered card with "Need help?" centered at its bottom.
  - Upload: the upload card on the left and the preview on the right, with an even 24px around and between the cards.
  - **The preview gets the space:** side margins shrink with the window (`clamp(16px, 4vw, 80px)`) and the upload column flexes from 280 to 380px, so on a ~900px split-screen window the preview stays usable. The preview opens fitted to its width, and in a narrow preview the toolbar stays on one line ("Fit width" becomes icon-only, via a container query).
- **Generation starts on upload.** There is no Generate button; a spinner shows in the preview while it runs.
- **The sign-in card never resizes** when a message appears; its message line is always reserved.
- **"Signed in as … / Sign out" is in the header, on the right.**
- **Downloads are named `YYYY-MM-DD - Send List.pdf`.**
- **Palette:** one gray (`--page`, also behind the PDF pages), the logo's indigo (`--accent`) for buttons and links, and white for cards and the header. Check text contrast on the gray.
