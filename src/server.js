const path = require("node:path");
const express = require("express");
const multer = require("multer");
const { requireSession, createSession, endSession, isActive } = require("./sessions");
const { buildSendList, SendListError } = require("./send-list");
const { getCircNotes } = require("./circ-notes");
const { authenticate, getUser, warmUp, DB_PATH } = require("./users");
const throttle = require("./login-throttle");

const PORT = process.env.PORT || 3000;
const MAX_BYTES = 20 * 1024 * 1024; // matches the client-side limit

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

/* ---------- Sessions ---------- */

// Signed in, and the account still exists with the password the session was started with.
// Removing an account or resetting its password (npm run users) ends its sessions this way.
function requireAccount(req, res, next) {
  const user = getUser(req.session.userId);
  if (!user || user.passwordChangedAt > req.session.createdAt) {
    endSession(req, res);
    return res.status(401).json({ error: "Not signed in." });
  }
  next();
}
const signedIn = [requireSession, requireAccount];

// Who is signed in? 200 { userId, sendList: { fileName, fileSize, pageCount, summary } | null } or 401.
app.get("/api/session", signedIn, (req, res) => {
  const list = req.session.sendList;
  res.json({
    userId: req.session.userId,
    sendList: list ? { fileName: list.fileName, fileSize: list.fileSize, pageCount: list.pageCount, summary: list.summary } : null,
  });
});

// Sign in: POST { userId, password } -> 200 { userId } and a session cookie,
// 401 for a wrong user ID or password (same answer for both), or 429 after too many tries.
app.post("/api/session", async (req, res) => {
  const userId = String(req.body?.userId ?? "").trim().slice(0, 200);
  const password = String(req.body?.password ?? "").slice(0, 1000);
  if (!userId || !password) return res.status(401).json({ error: "Invalid user ID or password." });

  const wait = throttle.retryAfter(req.ip, userId);
  if (wait) {
    const minutes = Math.ceil(wait / 60000);
    res.set("Retry-After", String(Math.ceil(wait / 1000)));
    return res.status(429).json({ error: `Too many sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` });
  }

  const user = await authenticate(userId, password);
  if (!user) {
    throttle.recordFailure(req.ip, userId);
    return res.status(401).json({ error: "Invalid user ID or password." });
  }
  throttle.recordSuccess(req.ip, userId);
  endSession(req, res);              // never reuse a session from before sign-in
  createSession(res, user.id);       // the ID as the account was created, whatever case was typed
  res.json({ userId: user.id });
});

// Sign out.
app.delete("/api/session", (req, res) => {
  endSession(req, res);
  res.status(204).end();
});

/* ---------- Send list ----------
   The latest generated send list is kept with the session, so it survives a page
   refresh and is dropped on sign-out or when the session ends. */

// POST multipart (file, pageCount) -> improved send list PDF, with what was added in the
// X-Send-List-Summary header (JSON). 422 { error } when the file isn't a usable send list.
app.post("/api/send-list", signedIn, upload.single("file"), async (req, res) => {
  const session = req.session;
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  if (req.file.buffer.subarray(0, 5).toString() !== "%PDF-") {
    return res.status(400).json({ error: "File is not a PDF." });
  }
  // A new upload replaces the saved list; the seq lets a later upload or a delete win over this one.
  const seq = ++session.sendListSeq;
  session.sendList = null;

  let result;
  try {
    result = await buildSendList(req.file.buffer, getCircNotes);
  } catch (err) {
    if (err instanceof SendListError) return res.status(422).json({ error: err.message });
    throw err;
  }

  if (session.sendListSeq === seq && isActive(session)) {
    session.sendList = {
      fileName: req.file.originalname,
      fileSize: req.file.size,
      pageCount: Number.parseInt(req.body.pageCount, 10) || null,
      summary: result.summary,
      pdf: result.pdf,
    };
  }
  res.set("X-Send-List-Summary", JSON.stringify(result.summary));
  sendPdf(res, result.pdf);
});

// The saved send list PDF, or 404 if there isn't one.
app.get("/api/send-list", signedIn, (req, res) => {
  if (!req.session.sendList) return res.status(404).json({ error: "No saved send list." });
  sendPdf(res, req.session.sendList.pdf);
});

// Remove the saved send list.
app.delete("/api/send-list", signedIn, (req, res) => {
  req.session.sendListSeq++;
  req.session.sendList = null;
  res.status(204).end();
});

function sendPdf(res, pdf) {
  res.type("application/pdf");
  res.set("Content-Disposition", 'inline; filename="improved-send-list.pdf"');
  res.set("Cache-Control", "no-store");
  res.send(pdf);
}

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const status = err.code === "LIMIT_FILE_SIZE" ? 413 : 400;
    return res.status(status).json({ error: err.message });
  }
  console.error(err);
  res.status(500).json({ error: "Internal server error." });
});

warmUp().then(() => {
  app.listen(PORT, () => {
    console.log(`Send List Builder running at http://localhost:${PORT}`);
    console.log(`Accounts: ${DB_PATH} (manage with npm run users)`);
  });
});
