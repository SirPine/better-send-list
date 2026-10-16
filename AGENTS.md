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

- `server.js`: Express server. It serves the page, handles in-memory sessions (an HttpOnly cookie, 8-hour idle timeout) and accepts the PDF upload. It keeps the latest generated list with the session, so a page refresh restores it.
  - **Sign-in is a placeholder.** It accepts any non-empty user ID and password (`TODO` in `POST /api/session`).
  - **Generating is a placeholder.** It returns the uploaded PDF unchanged (`TODO` in `POST /api/send-list`).
- `send-list-builder.html`: the whole front end (sign-in view, then the upload and preview view). It previews with PDF.js.
- Run it with `npm run dev`, which restarts on `server.js` changes, or `npm start`. It serves http://localhost:3000. Restarting clears all sessions.

## Connecting to Symphony (blocked on library IT)

- The public catalog is SirsiDynix Enterprise, hosted by SirsiDynix at `bepl.ent.sirsi.net`, and reachable from outside the library.
- The ILSWS base URL and a **client ID** must come from the library system's central IT. They are not known yet. `bepl.sirsi.net` does not exist.
- **Do not guess hostnames or client IDs or attempt logins against the live system.** Wait for IT to provide them.
- When they arrive, the server uses them to read each item's circ note. How the server signs in to Symphony (for example a dedicated library account held by the server) is not decided yet.

## Sign-in (needs rework, not decided yet)

- People sign in to **this server**, not to WorkFlows. The current page and session code are a placeholder for that.
- **Don't build a real login or change how sign-in works** until the user decides the design: who has accounts, how they're created, and how passwords are stored.

## Next work that doesn't need IT

- Parse item IDs out of a real WorkFlows send list PDF. Ask the user for a sample with no patron data.
- Write the new PDF: add a circ note line and a Code 128 barcode for each item. Until the lookup exists, use a stand-in for circ notes.

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
