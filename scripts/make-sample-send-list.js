/* Writes samples/sample-send-list.pdf: a made-up send list laid out like the WorkFlows
   export (two columns per item, "ID:" in the right column), for testing without real data.
   Run: npm run sample */

const fs = require("node:fs");
const path = require("node:path");
const { PDFDocument, StandardFonts, rgb } = require("pdf-lib");

const ITEMS = [
  ["XX .G704", "Dookie", "Green Day (Musical group)", "Compact Disc", "Open Shelf", "000089241749224", "1/14/2025"],
  ["XMAS .M37", "Merry Christmas", "Carey, Mariah", "Compact Disc", "Open Shelf", "000091562203471", "12/30/2024"],
  ["912.747 A881", "Atlas of New York State", "DeLorme (Firm)", "Book", "Reference", "000077310598812", "3/2/2025"],
  ["974.797 B929", "Buffalo's Waterfront", "Kowsky, Francis R.", "Book", "Open Shelf", "000083320047195", "6/18/2025"],
  ["FIC KING", "Holly", "King, Stephen", "Book", "New Books", "000095018834460", "9/4/2025"],
  ["DVD 791.43 GOD", "The Godfather", "Coppola, Francis Ford", "DVD", "Open Shelf", "000071143900587", "2/11/2025"],
  ["FIC MORRISON", "Beloved", "Morrison, Toni", "Book", "Open Shelf", "000064428190375", "5/27/2025"],
  ["J 811 SIL", "Where the Sidewalk Ends", "Silverstein, Shel", "Book", "Children's", "000058877301264", "8/9/2025"],
  ["XX .B4425", "Abbey Road", "Beatles", "Compact Disc", "Open Shelf", "000090014452318", "7/1/2025"],
  ["641.5 BITTMAN", "How to Cook Everything", "Bittman, Mark", "Book", "Open Shelf", "000066190027741", "4/22/2025"],
  ["B OBAMA", "Becoming", "Obama, Michelle", "Book", "Open Shelf", "000087745510296", "1/30/2025"],
  ["XX .S6125", "Rumours", "Fleetwood Mac", "Compact Disc", "Open Shelf", "000092230017659", "10/2/2025"],
];

async function main() {
  const doc = await PDFDocument.create();
  const regular = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  const size = 9.5, lineHeight = 13, blockGap = 13;
  const left = 115, right = 298, top = 720, bottom = 72;

  let page, y;
  const newPage = (n) => {
    page = doc.addPage([612, 792]);
    page.drawText("SAMPLE SEND LIST (made-up items for testing)", { x: 72, y: 750, size: 11, font: bold, color: rgb(0, 0, 0) });
    page.drawText(`Hon. Shirley Chisholm Library · page ${n}`, { x: 72, y: 736, size: 9, font: regular, color: rgb(0.3, 0.3, 0.3) });
    y = top;
  };
  const field = (x, y, label, value) => {
    page.drawText(label, { x, y, size, font: bold });
    page.drawText(value, { x: x + bold.widthOfTextAtSize(label + " ", size), y, size, font: regular });
  };

  let pageNo = 1;
  newPage(pageNo);
  for (const [call, title, author, type, location, id, discharged] of ITEMS) {
    if (y - lineHeight * 3 < bottom) newPage(++pageNo);
    field(left, y, "Call Number:", call);               field(right, y, "Type:", type);
    field(left, y - lineHeight, "Title:", title);       field(right, y - lineHeight, "Location:", location);
    field(left, y - lineHeight * 2, "Author:", author); field(right, y - lineHeight * 2, "ID:", id);
    field(left, y - lineHeight * 3, "Last discharged:", discharged);
    y -= lineHeight * 4 + blockGap;
  }

  const out = path.join(__dirname, "..", "samples", "sample-send-list.pdf");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, await doc.save());
  console.log(`Wrote ${path.relative(process.cwd(), out)} (${ITEMS.length} items, ${pageNo} pages)`);
}

main();
