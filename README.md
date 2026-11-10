# better-send-list

Improve the send list at the Hon. Shirley Chisholm Library.

Staff upload the send list PDF exported from WorkFlows, and get it back with each item's circulation note and a scannable barcode of its item ID. See [AGENTS.md](AGENTS.md) for the full goal and current status.

## Running locally

Requires Node.js 22.13+ (for PDF.js).

```sh
npm install
npm start        # or `npm run dev` to restart when server files change
```

Then open http://localhost:3000 (set `PORT` to change it). There is no sign-in: anyone who can reach the server can use it, so keep it on the library's internal network.

## Project layout

```
public/            what the browser loads (served as static files)
  index.html       page markup: upload and preview
  styles.css       page styles
  app.js           page behavior: upload, PDF preview, print and download
src/
  server.js        Express app and API routes
  send-list.js     adds circ notes and item-ID barcodes to the uploaded PDF
  circ-notes.js    imports the weekly circ notes file into SQLite and looks notes up
  sessions.js      in-memory sessions that keep the last list for 8 hours
data/
  notes-import/    put the weekly circ notes .txt file from IT here (not in git)
  notes.db         the imported notes (SQLite, not in git)
AGENTS.md          goal, status and decisions, for people and AI agents
```

To try it, upload a send list.

**Circ notes:** put the weekly export from IT (`ChiAllMat.txt`: one item per line, its first two note fields joined as its note) in `data/notes-import/`, or the folder named by `NOTES_DIR`. The server imports the newest `.txt` file there on startup and checks for a new one every hour; a restart imports a new file right away. Older files can be deleted.

Changes in `public/` show up on a browser refresh. Changes in `src/` need a server restart, which `npm run dev` does for you (restarting clears everyone's saved list).
