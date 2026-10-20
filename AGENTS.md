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
- `src/send-list.js`: builds the improved list. It finds each `ID: <number>` with pdf.js, works out that item's column, line spacing and font, and draws with pdf-lib into empty space, never moving the original text:
  - **Circ note:** a "Circ note:" line on the row right below the item's ID column. If that row is taken, the note is skipped and counted. An item that already shows a "Circ note:" doesn't get a second one.
  - **Barcode:** a Code 128 barcode, drawn as vector bars, to the right of the item, from the top of its first line to the bottom of its ID line. On each page, barcodes share one left edge and bar width so they line up. They may use space up to ¼ inch from the paper edge. If there's no room for one that scans, it's skipped and counted.
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

- `samples/sample-send-list.pdf` is a made-up two-page list in the layout from the user's proof of concept. Six of its items have notes in `data/circ-notes.json`. Regenerate it with `npm run sample`.
- The layout was built against that sample, **not a real WorkFlows export**. When the user provides a real send list (with patron data removed), test against it first; the "ID:" matching and the row and column detection in `src/send-list.js` are what might need adjusting.
- Check barcodes by decoding a rendered page, not just by looking at it.

## UI decisions to keep

These came from the user; don't undo them without asking.

- **One screen on desktop.** The page fits the window with no page scroll, and only the PDF preview scrolls. Below 900px wide, the cards stack and the page may scroll.
- **Two views.**
  - Sign-in: a centered card with "Need help?" centered at its bottom.
  - Upload: the upload card on the left and the preview on the right, with an even 24px around and between the cards.
- **Generation starts on upload.** There is no Generate button; a spinner shows in the preview while it runs.
- **The sign-in card never resizes** when a message appears; its message line is always reserved.
- **"Signed in as … / Sign out" is in the header, on the right.**
- **Downloads are named `YYYY-MM-DD - Send List.pdf`.**
- **Palette:** one gray (`--page`, also behind the PDF pages), the logo's indigo (`--accent`) for buttons and links, and white for cards and the header. Check text contrast on the gray.
