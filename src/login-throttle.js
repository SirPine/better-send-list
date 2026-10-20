/* Slows down password guessing. After 5 wrong passwords for one user ID from one address,
   that address can't try that user ID for 15 minutes; after 20 wrong passwords from one
   address (for any user IDs), it can't sign in at all for 15 minutes. Keyed by address as
   well as user ID, so someone elsewhere can't lock a staff member out. Kept in memory. */

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_USER = 5;
const MAX_PER_ADDRESS = 20;

const failures = new Map();   // key -> { count, resetAt }

const keysFor = (ip, userId) => [[`user:${ip}:${userId.toLowerCase()}`, MAX_PER_USER], [`addr:${ip}`, MAX_PER_ADDRESS]];

// Milliseconds until this address may try this user ID again, or 0 if it may try now.
function retryAfter(ip, userId) {
  const now = Date.now();
  let wait = 0;
  for (const [key, max] of keysFor(ip, userId)) {
    const entry = failures.get(key);
    if (entry && entry.resetAt > now && entry.count >= max) wait = Math.max(wait, entry.resetAt - now);
  }
  return wait;
}

function recordFailure(ip, userId) {
  const now = Date.now();
  for (const [key] of keysFor(ip, userId)) {
    const entry = failures.get(key);
    if (!entry || entry.resetAt <= now) failures.set(key, { count: 1, resetAt: now + WINDOW_MS });
    else entry.count++;
  }
}

function recordSuccess(ip, userId) {
  failures.delete(keysFor(ip, userId)[0][0]);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of failures) if (entry.resetAt <= now) failures.delete(key);
}, WINDOW_MS).unref();

module.exports = { retryAfter, recordFailure, recordSuccess };
