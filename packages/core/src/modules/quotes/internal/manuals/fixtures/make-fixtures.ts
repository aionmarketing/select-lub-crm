/**
 * Writes the committed test PDFs for manual ingestion (ingest-harvested-manuals). They are
 * authored here, never downloaded: no real manual is committed (copyright), and no test
 * reaches the network.
 *
 * - `manual-5-pages.pdf`: a fake five-page owner's manual. Page 3 carries the capacities table
 *   the page locator must find; the other pages are filler about something else.
 * - `no-text-layer.pdf`: two pages with only a drawn rectangle — what a scanned manual looks
 *   like to a text extractor.
 *
 * Hand-written PDF 1.4 with the standard Helvetica font (not embedded) and WinAnsi text, so no
 * PDF library is needed to author it. The xref offsets are computed from the bytes written.
 *
 *   pnpm exec tsx packages/core/src/modules/quotes/internal/manuals/fixtures/make-fixtures.ts
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** A PDF string literal in WinAnsi: escapes the delimiters and writes non-ASCII as octal. */
function pdfText(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.charCodeAt(0);
    if (ch === "(" || ch === ")" || ch === "\\") out += `\\${ch}`;
    else if (code < 128) out += ch;
    else out += `\\${code.toString(8).padStart(3, "0")}`;
  }
  return `(${out})`;
}

/** A page's content stream: one line of text per entry, top to bottom. */
function textStream(lines: string[]): string {
  const body = lines.map((line, i) => `BT /F1 11 Tf 56 ${760 - i * 18} Td ${pdfText(line)} Tj ET`).join("\n");
  return body;
}

/** Assembles a PDF from page content streams; each stream is its page's whole content. */
function buildPdf(streams: string[], withFont: boolean): Buffer {
  const objects: string[] = [];
  const pageCount = streams.length;
  // 1 catalog, 2 pages, 3 font, then per page: the page object and its content stream.
  const pageIds = streams.map((_, i) => 4 + i * 2);
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageCount} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  streams.forEach((stream, i) => {
    const pageId = pageIds[i]!;
    const resources = withFont ? "<< /Font << /F1 3 0 R >> >>" : "<< >>";
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources ${resources} /Contents ${pageId + 1} 0 R >>`;
    const bytes = Buffer.from(stream, "latin1");
    objects[pageId + 1] = `<< /Length ${bytes.length} >>\nstream\n${stream}\nendstream`;
  });

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")];
  const offsets: number[] = [];
  let length = chunks[0]!.length;
  for (let id = 1; id < objects.length; id += 1) {
    offsets[id] = length;
    const chunk = Buffer.from(`${id} 0 obj\n${objects[id]}\nendobj\n`, "latin1");
    chunks.push(chunk);
    length += chunk.length;
  }
  const xref = [`xref\n0 ${objects.length}\n`, "0000000000 65535 f \n"];
  for (let id = 1; id < objects.length; id += 1) xref.push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  chunks.push(Buffer.from(`${xref.join("")}trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`, "latin1"));
  return Buffer.concat(chunks);
}

const MANUAL = [
  ["Manual do Proprietário - Veículo de Teste 2021", "Este manual é um documento fictício, escrito para testes.", "Leia todas as instruções antes de dirigir."],
  ["Painel de instrumentos", "Luzes de advertência e indicadores do painel.", "Consulte a rede autorizada em caso de dúvida."],
  [
    "Capacidades e especificações",
    "Óleo do motor 1.0 12V",
    "Viscosidade SAE 5W-40",
    "Capacidade com filtro: 4,0 litros",
    "Capacidade sem filtro: 3,6 litros",
    "Volume seco: 4,5 litros",
    "Reservatório de arrefecimento: 5,0 litros",
  ],
  ["Rodas e pneus", "Calibragem dos pneus: 32 psi dianteiros, 30 psi traseiros.", "Rodízio a cada 10.000 km."],
  ["Garantia", "Condições gerais de garantia do veículo de teste.", "Fim do documento."],
];

writeFileSync(join(HERE, "manual-5-pages.pdf"), buildPdf(MANUAL.map(textStream), true));
writeFileSync(join(HERE, "no-text-layer.pdf"), buildPdf(["0.5 g 100 400 395 200 re f", "0.5 g 100 400 395 200 re f"], false));
console.log("wrote manual-5-pages.pdf and no-text-layer.pdf");
