# better-send-list

Improve the send list at the Hon. Shirley Chisholm Library.

Staff upload the send list PDF exported from WorkFlows, and get it back with each item's circulation note and a scannable barcode of its item ID. See [AGENTS.md](AGENTS.md) for the full goal and current status.

## Running locally

Requires Node.js 22.13+ (for the built-in SQLite).

```sh
npm install
npm run users -- add <your-user-id>   # create your first account
npm start        # or `npm run dev` to restart when server files change
```

Then open http://localhost:3000 (set `PORT` to change it) and sign in.

## Accounts

Only the administrator creates accounts, from a terminal on the server. There is no sign-up page.

```sh
npm run users -- add <user-id>      # create an account (asks for the password twice, hidden)
npm run users -- reset <user-id>    # set a new password; signs that person out everywhere
npm run users -- remove <user-id>   # delete an account; signs that person out everywhere
npm run users -- list               # show all accounts
```

- Accounts live in `data/users.db`, a SQLite file (set `DB_PATH` to keep it somewhere else). It is ignored by git; back it up separately.
- Passwords need at least 10 characters. Each one is salted and hashed with scrypt; the passwords themselves are never stored.
- User IDs are case-insensitive. A wrong user ID and a wrong password get the same message.
- After 5 wrong passwords for one user ID from one address, that address has to wait 15 minutes.

## Project layout

```
public/            what the browser loads (served as static files)
  index.html       page markup: sign-in view, then upload and preview
  styles.css       page styles
  app.js           page behavior: sign-in, upload, PDF preview, print and download
src/
  server.js        Express app and API routes
  send-list.js     adds circ notes and item-ID barcodes to the uploaded PDF
  circ-notes.js    looks up circ notes (temporary: reads data/circ-notes.json)
  users.js         accounts in SQLite, with salted scrypt password hashes
  login-throttle.js  locks out repeated wrong passwords
  sessions.js      in-memory sessions and cookie helpers
data/
  circ-notes.json  temporary circ notes by item ID, until Symphony is connected
scripts/
  users.js         the account admin tool (npm run users)
AGENTS.md          goal, status and decisions, for people and AI agents
```

To try it, sign in and upload a send list. To change a note, edit `data/circ-notes.json`; the next upload picks it up without a restart.

Changes in `public/` show up on a browser refresh. Changes in `src/` need a server restart, which `npm run dev` does for you (restarting signs everyone out).
