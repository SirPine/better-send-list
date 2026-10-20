const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const { DatabaseSync } = require("node:sqlite");

/* Staff accounts, in a SQLite file (data/users.db by default; set DB_PATH to move it).
   Accounts are created only by the administrator, with `npm run users` on the server.
   There is no sign-up and no account management through the website.

   Passwords are never stored. Each one gets its own random salt and is hashed with
   scrypt; the stored string records the parameters, so they can be raised later
   without breaking existing passwords. */

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "..", "data", "users.db");

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 2 ** 17, r: 8, p: 1 };   // OWASP's recommended minimum; ~0.4 s per hash
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const MIN_PASSWORD_LENGTH = 10;
const USER_ID = /^[A-Za-z0-9._-]{1,64}$/;

let db;
function database() {
  if (!db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new DatabaseSync(DB_PATH);
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS users (
        id                  TEXT PRIMARY KEY COLLATE NOCASE,  -- user IDs are case-insensitive
        password_hash       TEXT NOT NULL,
        created_at          INTEGER NOT NULL,                 -- ms since epoch
        password_changed_at INTEGER NOT NULL
      );
    `);
  }
  return db;
}

/* ---------- Password hashing ---------- */

async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = await derive(password, salt, SCRYPT);
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, key] = stored.split("$");
  if (scheme !== "scrypt") return false;
  const expected = Buffer.from(key, "base64");
  const actual = await derive(password, Buffer.from(salt, "base64"), { N: +N, r: +r, p: +p }, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function derive(password, salt, { N, r, p }, length = KEY_LENGTH) {
  return scrypt(password.normalize("NFC"), salt, length, { N, r, p, maxmem: 256 * N * r });
}

// Checked against when a user ID doesn't exist, so a wrong ID takes as long as a wrong password.
let dummyHash;
const getDummyHash = async () => (dummyHash ??= await hashPassword(crypto.randomBytes(16).toString("hex")));

/* ---------- Accounts ---------- */

function validateUserId(id) {
  if (!USER_ID.test(id)) throw new Error("User IDs are 1–64 letters, numbers, dots, dashes or underscores.");
}

function validatePassword(password) {
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`Passwords need at least ${MIN_PASSWORD_LENGTH} characters.`);
}

function getUser(id) {
  const row = database().prepare("SELECT id, created_at, password_changed_at FROM users WHERE id = ?").get(id);
  return row ? { id: row.id, createdAt: row.created_at, passwordChangedAt: row.password_changed_at } : null;
}

function listUsers() {
  return database().prepare("SELECT id, created_at, password_changed_at FROM users ORDER BY id")
    .all().map((row) => ({ id: row.id, createdAt: row.created_at, passwordChangedAt: row.password_changed_at }));
}

async function createUser(id, password) {
  validateUserId(id);
  validatePassword(password);
  if (getUser(id)) throw new Error(`There's already an account called "${id}".`);
  const now = Date.now();
  database().prepare("INSERT INTO users (id, password_hash, created_at, password_changed_at) VALUES (?, ?, ?, ?)")
    .run(id, await hashPassword(password), now, now);
}

// Also signs the person out everywhere: sessions older than the change stop working.
async function setPassword(id, password) {
  validatePassword(password);
  if (!getUser(id)) throw new Error(`There's no account called "${id}".`);
  database().prepare("UPDATE users SET password_hash = ?, password_changed_at = ? WHERE id = ?")
    .run(await hashPassword(password), Date.now(), id);
}

function removeUser(id) {
  const { changes } = database().prepare("DELETE FROM users WHERE id = ?").run(id);
  if (!changes) throw new Error(`There's no account called "${id}".`);
}

// The account if the user ID and password match, otherwise null.
async function authenticate(id, password) {
  const row = USER_ID.test(id) ? database().prepare("SELECT id, password_hash FROM users WHERE id = ?").get(id) : undefined;
  if (!row) {
    await verifyPassword(password, await getDummyHash());
    return null;
  }
  return (await verifyPassword(password, row.password_hash)) ? getUser(row.id) : null;
}

// Prepares the stand-in hash ahead of time, so the first unknown user ID isn't slower than the rest.
const warmUp = () => getDummyHash();

module.exports = { DB_PATH, MIN_PASSWORD_LENGTH, warmUp, validateUserId, getUser, listUsers, createUser, setPassword, removeUser, authenticate };
