const crypto = require("node:crypto");

/* In-memory sessions, so the saved send list survives a page refresh but not a
   server restart. Anyone who opens the page gets one; there is no sign-in.
   The browser only gets a random session ID in an HttpOnly cookie. */

const SESSION_COOKIE = "sid";
const SESSION_IDLE_MS = 8 * 60 * 60 * 1000; // a session ends after 8 hours without use

const sessions = new Map(); // id -> { id, expiresAt, sendList, sendListSeq }

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

function createSession() {
  const id = crypto.randomBytes(32).toString("base64url");
  const session = { id, expiresAt: Date.now() + SESSION_IDLE_MS, sendList: null, sendListSeq: 0 };
  sessions.set(id, session);
  return session;
}

// Express middleware: sets req.session, starting a new one if there isn't one, and refreshes the cookie.
function useSession(req, res, next) {
  req.session = getSession(req) || createSession();
  setSessionCookie(res, req.session.id);
  next();
}

function isActive(session) {
  return sessions.has(session.id);
}

// Drop expired sessions every 10 minutes.
setInterval(() => {
  const now = Date.now();
  for (const [id, s] of sessions) if (s.expiresAt < now) sessions.delete(id);
}, 10 * 60 * 1000).unref();

module.exports = { useSession, isActive };
