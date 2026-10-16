const path = require("node:path");
const express = require("express");
const multer = require("multer");
const { requireSession, createSession, endSession, isActive } = require("./sessions");

const PORT = process.env.PORT || 3000;
const MAX_BYTES = 20 * 1024 * 1024; // matches the client-side limit

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

/* ---------- Sessions ---------- */

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

  // TODO: placeholder that accepts any non-empty login. People will sign in to this
  // server's own accounts (not WorkFlows); that design isn't decided yet. See AGENTS.md.
  createSession(res, userId);
  res.json({ userId });
});

// Sign out.
app.delete("/api/session", (req, res) => {
  endSession(req, res);
  res.status(204).end();
});

/* ---------- Send list ----------
   The latest generated send list is kept with the session, so it survives a page
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

  // TODO: add each item's circ note (from Symphony) and a Code 128 barcode of its item ID.
  // For now, echo the uploaded PDF back.
  const improved = req.file.buffer;

  if (session.sendListSeq === seq && isActive(session)) {
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
