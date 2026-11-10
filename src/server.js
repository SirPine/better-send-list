const path = require("node:path");
const express = require("express");
const multer = require("multer");
const { useSession, isActive } = require("./sessions");
const { buildSendList, SendListError } = require("./send-list");
const { getCircNotes } = require("./circ-notes");

const PORT = process.env.PORT || 3000;
const MAX_BYTES = 20 * 1024 * 1024; // matches the client-side limit

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES } });

app.use(express.static(path.join(__dirname, "..", "public")));

/* ---------- Send list ----------
   The latest generated send list is kept with the session for 8 hours after it was
   generated, so it survives a page refresh. Using the page doesn't extend that. */

const SEND_LIST_KEEP_MS = 8 * 60 * 60 * 1000;

app.use("/api", useSession);

// The session's saved send list, or null once it's 8 hours old (it's dropped then).
function savedList(session) {
  if (session.sendList && Date.now() - session.sendList.savedAt >= SEND_LIST_KEEP_MS) session.sendList = null;
  return session.sendList;
}

// The saved send list's details: 200 { fileName, fileSize, pageCount, summary } or 404.
app.get("/api/send-list/info", (req, res) => {
  const list = savedList(req.session);
  if (!list) return res.status(404).json({ error: "No saved send list." });
  res.json({ fileName: list.fileName, fileSize: list.fileSize, pageCount: list.pageCount, summary: list.summary });
});

// POST multipart (file, pageCount) -> improved send list PDF, with what was added in the
// X-Send-List-Summary header (JSON). 422 { error } when the file isn't a usable send list.
app.post("/api/send-list", upload.single("file"), async (req, res) => {
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
      savedAt: Date.now(),
    };
  }
  res.set("X-Send-List-Summary", JSON.stringify(result.summary));
  sendPdf(res, result.pdf);
});

// The saved send list PDF, or 404 if there isn't one.
app.get("/api/send-list", (req, res) => {
  const list = savedList(req.session);
  if (!list) return res.status(404).json({ error: "No saved send list." });
  sendPdf(res, list.pdf);
});

// Remove the saved send list.
app.delete("/api/send-list", (req, res) => {
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
