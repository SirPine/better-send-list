/* ---------- API endpoints on this server (see src/server.js) ---------- */
const API = {
  session:  "/api/session",    // GET -> { userId } if signed in; POST { userId, password } signs in; DELETE signs out
  sendList: "/api/send-list",  // POST multipart: file, pageCount -> improved PDF; GET the saved one; DELETE removes it
};
const MAX_BYTES = 20 * 1024 * 1024;

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

/* ---------- Elements ---------- */
const $ = (id) => document.getElementById(id);
const signinView = $("signin-view"), buildView = $("build-view");
const userEl = $("wf-user"), passEl = $("wf-pass"), statusEl = $("wf-status"), signinBtn = $("signin-btn");
const dropzone = $("dropzone"), fileInput = $("file-input"), fileError = $("file-error");
const fileChip = $("file-chip"), fileNameEl = $("file-name"), fileMetaEl = $("file-meta");
const generateError = $("generate-error"), generateErrorText = $("generate-error-text"), loadingEl = $("loading");
const summaryEl = $("result-summary");
const printBtn = $("print-btn"), downloadBtn = $("download-btn");
const toolbar = $("toolbar"), viewport = $("viewport"), pagesEl = $("pages"), emptyEl = $("empty"), emptyText = $("empty-text");
const pageInput = $("page-input"), pageCount = $("page-count"), zoomSelect = $("zoom-select");

/* ---------- State ---------- */
let uploadedFile = null;     // the send list the user uploaded (null after a restore from the session)
let uploadedPages = 0;
let previewBlob = null;      // the PDF currently shown in the preview
let pdfDoc = null;
let scale = 1;               // 1 = 100%
let fitMode = false;
let renderToken = 0;
let generateToken = 0;       // bumped when a new generate starts or the file is removed
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2];

/* ---------- Helpers ---------- */
const formatSize = (b) => b < 1024 * 1024 ? `${Math.round(b / 1024)} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`;
const credsFilled = () => userEl.value.trim() !== "" && passEl.value !== "";

function setStatus(text, kind) {
  statusEl.className = "status " + (kind || "");
  statusEl.textContent = text;
}

/* ---------- WorkFlows ---------- */
function showView(userId) {
  const signedIn = !!userId;
  signinView.hidden = signedIn;
  buildView.hidden = !signedIn;
  $("header-account").hidden = !signedIn;
  $("signed-in-user").textContent = signedIn ? userId : "";
}

// Called when the server says the session is gone (expired, or the server restarted).
function sessionExpired() {
  clearFile();
  showView(null);
  setStatus("Your session expired. Please sign in again.", "err");
  passEl.focus();
}

[userEl, passEl].forEach(el => el.addEventListener("input", () => setStatus("")));

$("signin-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!credsFilled()) { setStatus("Enter your user ID and password.", "err"); return; }
  setStatus("Signing in…", "pending");
  signinBtn.disabled = true;
  try {
    const res = await fetch(API.session, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: userEl.value.trim(), password: passEl.value }),
    });
    if (res.status === 401 || res.status === 429) {
      const { error } = await res.json().catch(() => ({}));
      throw Object.assign(new Error(error || "Invalid user ID or password."), { shown: true });
    }
    if (!res.ok) throw new Error();
    const { userId } = await res.json();
    passEl.value = "";   // the server keeps the session; the password isn't needed again
    setStatus("");
    showView(userId);
  } catch (e) {
    setStatus(e.shown ? e.message : "Couldn’t reach the server. Try again in a moment.", "err");
  } finally {
    signinBtn.disabled = false;
  }
});

$("signout-btn").addEventListener("click", async () => {
  try { await fetch(API.session, { method: "DELETE" }); } catch { /* signed out locally either way */ }
  passEl.value = "";
  clearFile();
  showView(null);
  passEl.focus();
});

/* ---------- Upload & validation ---------- */
async function isRealPdf(file) {
  // Check the "%PDF-" signature at the start of the file
  const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
  return String.fromCharCode(...head) === "%PDF-";
}

function showFileError(msg) {
  fileError.textContent = msg;
  fileError.hidden = false;
}

async function handleFile(file) {
  fileError.hidden = true;
  if (!file) return;
  if (file.size > MAX_BYTES) return showFileError("That file is larger than 20 MB.");
  if (!(file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")) || !(await isRealPdf(file))) {
    return showFileError("That doesn’t look like a PDF. Please upload the send list PDF from WorkFlows.");
  }
  let doc;
  try {
    doc = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
  } catch {
    return showFileError("This PDF couldn’t be opened. It may be damaged or password-protected.");
  }
  uploadedFile = file;
  uploadedPages = doc.numPages;
  showFileChip(file.name, file.size, doc.numPages);
  generate();
}

function showFileChip(name, size, pages) {
  fileNameEl.textContent = name;
  fileMetaEl.textContent = formatSize(size) + (pages ? ` · ${pages} page${pages === 1 ? "" : "s"}` : "");
  fileChip.hidden = false;
  dropzone.hidden = true;
}

function clearFile() {
  uploadedFile = null;
  fileInput.value = "";
  fileChip.hidden = true;
  dropzone.hidden = false;
  fileError.hidden = true;
  generateError.hidden = true;
  showSummary(null);
  generateToken++;
  setLoading(false);
  clearPreview();
}

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener("change", () => handleFile(fileInput.files[0]));
["dragenter", "dragover"].forEach(ev => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.add("dragover"); }));
["dragleave", "drop"].forEach(ev => dropzone.addEventListener(ev, (e) => { e.preventDefault(); dropzone.classList.remove("dragover"); }));
dropzone.addEventListener("drop", (e) => handleFile(e.dataTransfer.files[0]));
$("remove-file").addEventListener("click", () => {
  fetch(API.sendList, { method: "DELETE" }).catch(() => {});   // so a refresh doesn't bring it back
  clearFile();
});

/* ---------- Generate (calls the server) ---------- */
function setLoading(on) {
  loadingEl.hidden = !on;
  if (on) emptyEl.hidden = true;
}

// e.g. "12 items found. Added 6 circ notes and 12 barcodes."
function showSummary(summary) {
  summaryEl.hidden = !summary;
  if (!summary) return;
  const count = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  let text = `${count(summary.items, "item")} found. Added ${count(summary.notes, "circ note")} and ${count(summary.barcodes, "barcode")}.`;
  if (summary.notesShortened) text += ` ${count(summary.notesShortened, "circ note")} had to be cut short to fit.`;
  if (summary.barcodesSkipped) text += ` ${count(summary.barcodesSkipped, "barcode")} didn’t fit on the page.`;
  if (summary.pages && summary.originalPages && summary.pages !== summary.originalPages) {
    text += ` The list is now ${count(summary.pages, "page")} (was ${summary.originalPages}).`;
  }
  summaryEl.textContent = text;
}

async function generate() {
  const token = ++generateToken;
  generateError.hidden = true;
  showSummary(null);
  clearPreview();
  setLoading(true);
  try {
    const form = new FormData();
    form.append("file", uploadedFile);
    form.append("pageCount", String(uploadedPages));
    const res = await fetch(API.sendList, { method: "POST", body: form });
    if (res.status === 401) { if (token === generateToken) sessionExpired(); return; }
    if (res.status === 422) {   // the file isn't a usable send list; trying again won't help
      const { error } = await res.json().catch(() => ({}));
      throw Object.assign(new Error(error || "This PDF couldn’t be used as a send list."), { retry: false });
    }
    if (!res.ok) throw new Error();
    let summary = null;
    try { summary = JSON.parse(res.headers.get("X-Send-List-Summary")); } catch { /* shown without a summary */ }
    const blob = await res.blob();
    if (token !== generateToken) return;   // file was removed or replaced meanwhile
    setLoading(false);
    showSummary(summary);
    await loadPreview(blob);
  } catch (err) {
    if (token !== generateToken) return;
    setLoading(false);
    clearPreview("The send list couldn’t be generated.");
    const known = err.retry === false;
    generateErrorText.textContent = known ? err.message : "Couldn’t generate the send list. Check your connection and try again.";
    $("retry-btn").hidden = known;
    generateError.hidden = false;
  }
}

$("retry-btn").addEventListener("click", () => { if (uploadedFile) generate(); });

/* ---------- Preview / viewer ---------- */
async function loadPreview(blob) {
  try {
    pdfDoc = await pdfjsLib.getDocument({ data: await blob.arrayBuffer() }).promise;
  } catch {
    clearPreview("The preview couldn’t be loaded.");
    return;
  }
  previewBlob = blob;
  emptyEl.hidden = true;
  toolbar.classList.remove("disabled");
  printBtn.disabled = false;
  downloadBtn.disabled = false;
  pageCount.textContent = `of ${pdfDoc.numPages}`;
  pageInput.value = "1";
  fitMode = false;
  setScale(1);
  viewport.scrollTop = 0;
}

function clearPreview(message) {
  pdfDoc = null;
  previewBlob = null;
  renderToken++;
  pagesEl.innerHTML = "";
  emptyText.textContent = message || "Upload a send list PDF to preview it here";
  emptyEl.hidden = false;
  toolbar.classList.add("disabled");
  printBtn.disabled = true;
  downloadBtn.disabled = true;
  pageInput.value = "–";
  pageCount.textContent = "of –";
}

async function renderPages() {
  if (!pdfDoc) return;
  const token = ++renderToken;
  const keepPage = currentPage();
  pagesEl.innerHTML = "";
  const dpr = window.devicePixelRatio || 1;
  for (let n = 1; n <= pdfDoc.numPages; n++) {
    const page = await pdfDoc.getPage(n);
    if (token !== renderToken) return;   // a newer render started
    const vp = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.dataset.page = n;
    canvas.width = Math.floor(vp.width * dpr);
    canvas.height = Math.floor(vp.height * dpr);
    canvas.style.width = `${Math.floor(vp.width)}px`;
    canvas.style.height = `${Math.floor(vp.height)}px`;
    pagesEl.appendChild(canvas);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null }).promise;
    if (n === keepPage) goToPage(keepPage, false);
  }
}

function setScale(s) {
  scale = Math.min(3, Math.max(0.25, s));
  const match = ZOOM_STEPS.find(z => Math.abs(z - scale) < 0.001);
  if (match && !fitMode) {
    zoomSelect.value = String(match);
  } else {
    const fitOpt = zoomSelect.querySelector('option[value="fit"]');
    fitOpt.textContent = `${Math.round(scale * 100)}%`;
    zoomSelect.value = "fit";
  }
  renderPages();
}

async function fitWidth() {
  if (!pdfDoc) return;
  const page = await pdfDoc.getPage(1);
  const natural = page.getViewport({ scale: 1 }).width;
  const available = viewport.clientWidth - 64 - 16; // padding + scrollbar
  fitMode = true;
  setScale(available / natural);
}

function currentPage() {
  const canvases = [...pagesEl.querySelectorAll("canvas")];
  const mid = viewport.scrollTop + viewport.clientHeight / 3;
  let current = 1;
  for (const c of canvases) if (c.offsetTop <= mid) current = Number(c.dataset.page);
  return current;
}

function goToPage(n, smooth = true) {
  if (!pdfDoc) return;
  n = Math.min(pdfDoc.numPages, Math.max(1, n));
  const target = pagesEl.querySelector(`canvas[data-page="${n}"]`);
  if (target) viewport.scrollTo({ top: target.offsetTop - 24, behavior: smooth ? "smooth" : "auto" });
  pageInput.value = String(n);
  updateNavButtons(n);
}

function updateNavButtons(n) {
  $("prev-page").disabled = !pdfDoc || n <= 1;
  $("next-page").disabled = !pdfDoc || n >= pdfDoc.numPages;
}

viewport.addEventListener("scroll", () => {
  if (!pdfDoc) return;
  const n = currentPage();
  if (document.activeElement !== pageInput) pageInput.value = String(n);
  updateNavButtons(n);
});
$("prev-page").addEventListener("click", () => goToPage(currentPage() - 1));
$("next-page").addEventListener("click", () => goToPage(currentPage() + 1));
pageInput.addEventListener("keydown", (e) => { if (e.key === "Enter") { goToPage(parseInt(pageInput.value, 10) || 1); pageInput.blur(); } });
pageInput.addEventListener("blur", () => { if (pdfDoc) pageInput.value = String(currentPage()); });

$("zoom-in").addEventListener("click", () => { fitMode = false; setScale(ZOOM_STEPS.find(z => z > scale + 0.001) ?? scale); });
$("zoom-out").addEventListener("click", () => { fitMode = false; setScale([...ZOOM_STEPS].reverse().find(z => z < scale - 0.001) ?? scale); });
zoomSelect.addEventListener("change", () => { if (zoomSelect.value !== "fit") { fitMode = false; setScale(parseFloat(zoomSelect.value)); } });
$("fit-width").addEventListener("click", fitWidth);
let resizeTimer;
window.addEventListener("resize", () => { if (fitMode) { clearTimeout(resizeTimer); resizeTimer = setTimeout(fitWidth, 150); } });

/* ---------- Print & download ---------- */
printBtn.addEventListener("click", () => {
  if (!previewBlob) return;
  const url = URL.createObjectURL(previewBlob);
  const frame = document.createElement("iframe");
  frame.style.cssText = "position:fixed;width:0;height:0;border:0;right:0;bottom:0;";
  frame.src = url;
  frame.onload = () => {
    try { frame.contentWindow.focus(); frame.contentWindow.print(); }
    catch { window.open(url, "_blank"); }   // some browsers block printing a PDF from an iframe
    setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 60000);
  };
  document.body.appendChild(frame);
});

// e.g. "2026-10-15 - Send List.pdf", using the viewer's local date
function sendListFileName() {
  const d = new Date();
  const ymd = [d.getFullYear(), d.getMonth() + 1, d.getDate()].map(n => String(n).padStart(2, "0")).join("-");
  return `${ymd} - Send List.pdf`;
}

downloadBtn.addEventListener("click", () => {
  if (!previewBlob) return;
  const url = URL.createObjectURL(previewBlob);
  const a = document.createElement("a");
  a.href = url;
  a.download = sendListFileName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

/* ---------- Help ---------- */
const helpDialog = $("help-dialog");
document.querySelectorAll("[data-help]").forEach(btn => btn.addEventListener("click", () => helpDialog.showModal()));
// Clicking the dimmed backdrop (outside the dialog box) closes it.
helpDialog.addEventListener("click", (e) => { if (e.target === helpDialog) helpDialog.close(); });

/* ---------- Init ---------- */
updateNavButtons(1);

// Resume an existing session so a refresh doesn't sign the user out,
// and bring back the send list saved with it.
(async () => {
  let session = null;
  try {
    const res = await fetch(API.session);
    if (res.ok) session = await res.json();
  } catch { /* server unreachable: show sign-in */ }
  showView(session?.userId);
  if (session?.sendList) restoreSendList(session.sendList);
})();

async function restoreSendList({ fileName, fileSize, pageCount, summary }) {
  const token = ++generateToken;
  showFileChip(fileName, fileSize, pageCount);
  showSummary(summary);
  clearPreview();
  setLoading(true);
  try {
    const res = await fetch(API.sendList);
    if (!res.ok) throw new Error();
    const blob = await res.blob();
    if (token !== generateToken) return;
    setLoading(false);
    await loadPreview(blob);
  } catch {
    if (token === generateToken) clearFile();   // nothing usable saved: start fresh
  }
}
