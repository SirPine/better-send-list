/* Writes samples/sample-send-list.pdf: a made-up send list laid out like the real
   WorkFlows export (a Microsoft Access report): section headings, items packed one
   after another with "item ID:" on each item's last line, and a date and
   "Page X of N" footer. For testing without real library data.
   Run: npm run sample */

const fs = require("node:fs");
const path = require("node:path");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

// [call number, author, title, item ID, type, location, last discharged]
const SECTIONS = [
  ["Music", [
    ["XX .G704", "Green Day (Musical group)", "Dookie [sound recording]", "000089241749224", "CD", "B-OPENSHLF", "01/14/2025"],
    ["XMAS .C276 M", "Carey, Mariah", "Merry Christmas [sound recording]", "000091562203471", "CD", "B-HOLIDAY", "12/30/2024"],
    ["ROCK .B4425 AB", "Beatles", "Abbey Road [sound recording]", "000090014452318", "CD", "B-OPENSHLF", "07/01/2025"],
    ["ROCK .F598 R", "Fleetwood Mac", "Rumours [sound recording]", "000092230017659", "CD", "B-OPENSHLF", "10/02/2025"],
    ["JAZZ .D251 K", "Davis, Miles", "Kind of blue [sound recording]", "000093310457720", "CD", "B-OPENSHLF", "03/11/2026"],
    ["POP .S9295 F", "Swift, Taylor", "Folklore [sound recording]", "000094405581136", "CD", "B-OPENSHLF", "09/22/2026"],
  ]],
  ["Videos", [
    ["DVD 791.43 GOD", "Coppola, Francis Ford", "The Godfather [videorecording]", "000071143900587", "DVD", "B-OPENSHLF", "02/11/2025"],
    ["DVD 6120", "Gerwig, Greta", "Little women [videorecording] / Columbia Pictures", "000072258100941", "DVD", "B-OPENSHLF", "06/30/2026"],
  ]],
  ["Adult Nonfiction", [
    ["912.747 A881", "DeLorme (Firm)", "Atlas of New York State", "000077310598812", "NONFICTION", "B-REFERENCE", "03/02/2025"],
    ["974.797 B929", "Kowsky, Francis R.", "Buffalo's waterfront : a history", "000083320047195", "NONFICTION", "B-LOCALHIST", "06/18/2025"],
    ["641.5 BITTMAN", "Bittman, Mark", "How to cook everything", "000066190027741", "NONFICTION", "B-OPENSHLF", "04/22/2025"],
  ]],
  ["Fiction", [
    ["FICTION", "King, Stephen", "Holly / Stephen King", "000095018834460", "FICTION", "B-NEARNEW", "09/04/2025"],
    ["FICTION", "Morrison, Toni", "Beloved : a novel / Toni Morrison", "000064428190375", "FICTION", "B-OPENSHLF", "05/27/2025"],
    ["FICTION", "Rutledge, Lynda, 1950-", "West with giraffes : a novel / Lynda Rutledge", "000064500128834", "FICTION", "B-OPENSHLF", "08/09/2025"],
  ]],
];

async function main() {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const black = rgb(0, 0, 0);
  const W = 612, H = 792, bottomLimit = 90;
  const pages = [];
  let page, y;

  const newPage = () => {
    page = doc.addPage([W, H]);
    pages.push(page);
    y = 714;
  };
  const text = (t, x, yy, size = 11, font = regular) => page.drawText(t, { x, y: yy, size, font, color: black });
  const heading = (t, size) => {
    const width = bold.widthOfTextAtSize(t, size);
    const x = (W - width) / 2;
    text(t, x, y, size, bold);
    page.drawLine({ start: { x, y: y - 2 }, end: { x: x + width, y: y - 2 }, thickness: 1, color: black });
  };

  newPage();
  y = 690;   // the first page starts below "Number on List"
  const total = SECTIONS.reduce((n, [, items]) => n + items.length, 0);
  text("Number on List:", 383, 720);
  text(String(total), 472.6, 720);
  text("SAMPLE (made-up items)", 58.7, 740, 9);
  for (const [name, items] of SECTIONS) {
    if (y - 30 - 69 < bottomLimit) newPage();
    heading(name, 14);
    y -= 15;
    for (const [call, author, title, id, type, location, discharged] of items) {
      if (y - 69 < bottomLimit) newPage();
      text(call, 58.7, y);
      text("Last Discharged:", 398, y - 6);
      text(author, 70.7, y - 15);
      text(discharged, 404.1, y - 18, 11, bold);
      text(title, 70.7, y - 30);
      text("copy:1", 79.7, y - 45);
      text(`item ID:${id}`, 123.4, y - 45);
      text(`type:${type}`, 262, y - 45);
      text(`location:${location}`, 340, y - 45);
      y -= 69;
    }
    y -= 12;
  }
  pages.forEach((p, i) => {
    p.drawText("Monday, October 19, 2026", { x: 61.7, y: 34.1, size: 11, font: regular, color: black });
    p.drawText(`Page ${i + 1} of ${pages.length}`, { x: 466.8, y: 34.1, size: 11, font: regular, color: black });
  });

  const out = path.join(__dirname, "..", "samples", "sample-send-list.pdf");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, await doc.save());
  console.log(`Wrote ${path.relative(process.cwd(), out)} (${total} items, ${pages.length} pages)`);
}

main();
