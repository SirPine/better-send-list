const path = require("node:path");
const crypto = require("node:crypto");
const express = require("express");
const multer = require("multer");

const PORT = process.env.PORT || 3000;
const MAX_BYTES = 20 * 1024 * 1024; // matches the client-side limit
const SESSION_COOKIE = "sid";
const SESSION_IDLE_MS = 8 * 60 * 60 * 1000; // a session ends after 8 hours without use

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

app.use(express.json());

/* ---------- Sessions ----------
   Kept in memory, so everyone is signed out when the server restarts.
   The browser only gets a random session ID in an HttpOnly cookie. */
const sessions = new Map(); // id -> { id, userId, workflowsToken, expiresAt, sendList, sendListSeq }

function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function setSessionCookie(res, id, maxAgeMs) {
  res.cookie(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: maxAgeMs,
    path: "/",
  });
}

function getSession(req) {
  const id = readCookie(req, SESSION_COOKIE);
  const session = id && sessions.get(id);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(id);
    return null;
  }
  session.expiresAt = Date.now() + SESSION_IDLE_MS; // sliding expiry
  return session;
}

function requireSession(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not signed in." });
  req.session = session;
  setSessionCookie(res, session.id, SESSION_IDLE_MS);
  next();
}

// Drop expired sessions every 10 minutes.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (s.expiresAt < now) sessions.delete(id);
}, 10 * 60 * 1000).unref();

/* ---------- Routes ---------- */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "send-list-builder.html"));
});

// Who is signed in? 200 { userId, sendList: { fileName, fileSize, pageCount } | null } or 401.
app.get("/api/session", requireSession, (req, res) => {
  const list = req.session.sendList;
  res.json({
    userId: req.session.userId,
    sendList: list ? { fileName: list.fileName, fileSize: list.fileSize, pageCount: list.pageCount } : null,
  });
});

// Sign in: POST { userId, password } -> 200 { userId } and a session cookie, or 401.
app.post("/api/session", async (req, res) => {
  const userId = String(req.body?.userId ?? "").trim();
  const password = String(req.body?.password ?? "");
  if (!userId || !password) return res.status(401).json({ error: "Missing user ID or password." });

  // TODO: verify the credentials against WorkFlows and keep the session token it returns
  // (never the password) so later requests can look up items as this user.
  const workflowsToken = null;

  const id = crypto.randomBytes(32).toString("base64url");
  sessions.set(id, { id, userId, workflowsToken, expiresAt: Date.now() + SESSION_IDLE_MS, sendList: null, sendListSeq: 0 });
  setSessionCookie(res, id, SESSION_IDLE_MS);
  res.json({ userId });
});

// Sign out.
app.delete("/api/session", (req, res) => {
  const id = readCookie(req, SESSION_COOKIE);
  if (id) sessions.delete(id);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
  res.status(204).end();
});

/* The latest generated send list is kept with the session, so it survives a page
   refresh and is dropped on sign-out or when the session ends. */

// POST multipart (file, pageCount) -> improved send list PDF. Requires a session.
app.post("/api/send-list", requireSession, upload.single("file"), async (req, res) => {
  const session = req.session;
  if (!req.file) return res.status(400).json({ error: "No file uploaded." });
  if (req.file.buffer.subarray(0, 5).toString() !== "%PDF-") {
    return res.status(400).json({ error: "File is not a PDF." });
  }
  // A new upload replaces the saved list; the seq lets a later upload or a delete win over this one.
  const seq = ++session.sendListSeq;
  session.sendList = null;

  // TODO: build the improved send list using session.workflowsToken.
  // For now, echo the uploaded PDF back.
  const improved = req.file.buffer;

  if (session.sendListSeq === seq && sessions.has(session.id)) {
    session.sendList = {
      fileName: req.file.originalname,
      fileSize: req.file.size,
      pageCount: Number.parseInt(req.body.pageCount, 10) || null,
      pdf: improved,
    };
  }
  sendPdf(res, improved);
});

// The saved send list PDF, or 404 if there isn't one.
app.get("/api/send-list", requireSession, (req, res) => {
  if (!req.session.sendList) return res.status(404).json({ error: "No saved send list." });
  sendPdf(res, req.session.sendList.pdf);
});

// Remove the saved send list.
app.delete("/api/send-list", requireSession, (req, res) => {
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

app.listen(PORT, () => {
  console.log(`Send List Builder running at http://localhost:${PORT}`);
});
