const path = require("node:path");
const express = require("express");
const multer = require("multer");
const { useSession, isActive } = require("./sessions");
const { buildSendList, SendListError } = require("./send-list");
const { getCircNotes } = require("./circ-notes");

const PORT = process.env.PORT || 3000;
const MAX_BYTES = 20 * 1024 * 1024; // matches the client-side limit

const app = express();
// An upload is one file and one short field (pageCount); anything more is refused before it's read into memory.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1, fields: 1, fieldSize: 100, parts: 2, fieldNameSize: 100 },
});

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

// Building a list takes the server's full attention for a moment, so lists are built one at a
// time and the rest wait in line. A waiting upload isn't read into memory until its turn.
// Only when the line is full is anyone told to try again.
const MAX_WAITING = 10;
let building = false;
const line = []; // { res, next } in the order they arrived

function startBuild(res, next) {
  building = true;
  res.on("close", () => {   // finished, failed, or the person gave up
    building = false;
    const turn = line.shift();
    if (turn) startBuild(turn.res, turn.next);
  });
  next();
}

function waitInLine(_req, res, next) {
  if (!building) return startBuild(res, next);
  if (line.length >= MAX_WAITING) {
    res.set("Retry-After", "5");
    return res.status(503).json({ error: "The server is busy with other send lists. Try again in a moment." });
  }
  const turn = { res, next };
  line.push(turn);
  res.on("close", () => {   // gave up before their turn: leave the line
    const i = line.indexOf(turn);
    if (i !== -1) line.splice(i, 1);
  });
}

// POST multipart (file, pageCount) -> improved send list PDF, with what was added in the
// X-Send-List-Summary header (JSON). 422 { error } when the file isn't a usable send list,
// 503 { error } when the line of waiting lists is full.
app.post("/api/send-list", waitInLine, upload.single("file"), async (req, res) => {
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
