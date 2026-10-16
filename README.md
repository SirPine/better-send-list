# better-send-list

Improve the send list at the Hon. Shirley Chisholm Library.

Staff upload the send list PDF exported from WorkFlows, and get it back with each item's circulation note and a scannable barcode of its item ID. See [AGENTS.md](AGENTS.md) for the full goal and current status.

## Running locally

Requires Node.js 20+.

```sh
npm install
npm start        # or `npm run dev` to restart when server files change
```

Then open http://localhost:3000 (set `PORT` to change it).

## Project layout

```
public/            what the browser loads (served as static files)
  index.html       page markup: sign-in view, then upload and preview
  styles.css       page styles
  app.js           page behavior: sign-in, upload, PDF preview, print and download
src/
  server.js        Express app and API routes
  sessions.js      in-memory sessions and cookie helpers
AGENTS.md          goal, status and decisions, for people and AI agents
```

Changes in `public/` show up on a browser refresh. Changes in `src/` need a server restart, which `npm run dev` does for you (restarting signs everyone out).
