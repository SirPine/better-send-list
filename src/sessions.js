const crypto = require("node:crypto");

/* In-memory sessions, so everyone is signed out when the server restarts.
   The browser only gets a random session ID in an HttpOnly cookie. */

const SESSION_COOKIE = "sid";
const SESSION_IDLE_MS = 8 * 60 * 60 * 1000; // a session ends after 8 hours without use

const sessions = new Map(); // id -> { id, userId, expiresAt, sendList, sendListSeq }

function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function setSessionCookie(res, id) {
  res.cookie(SESSION_COOKIE, id, {
    httpOnly: true,
    sameSite: "strict",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_IDLE_MS,
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

// Express middleware: 401 unless signed in; otherwise sets req.session and refreshes the cookie.
function requireSession(req, res, next) {
  const session = getSession(req);
  if (!session) return res.status(401).json({ error: "Not signed in." });
  req.session = session;
  setSessionCookie(res, session.id);
  next();
}

function createSession(res, userId) {
  const id = crypto.randomBytes(32).toString("base64url");
  sessions.set(id, { id, userId, expiresAt: Date.now() + SESSION_IDLE_MS, sendList: null, sendListSeq: 0 });
  setSessionCookie(res, id);
}

function endSession(req, res) {
  const id = readCookie(req, SESSION_COOKIE);
  if (id) sessions.delete(id);
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

function isActive(session) {
  return sessions.has(session.id);
}

// Drop expired sessions every 10 minutes.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (s.expiresAt < now) sessions.delete(id);
}, 10 * 60 * 1000).unref();

module.exports = { requireSession, createSession, endSession, isActive };
