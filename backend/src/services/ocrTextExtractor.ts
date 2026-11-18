import { createCanvas, Canvas, SKRSContext2D } from '@napi-rs/canvas';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { createWorker } from 'tesseract.js';

export interface WordConfidence {
  text: string;
  confidence: number;
}

export interface TextExtractionResult {
  text: string;
  method: 'PDF_TEXT' | 'TESSERACT_OCR';
  ocrConfidence: number;
  wordConfidences: WordConfidence[];
}

class NodeCanvasFactory {
  create(width: number, height: number): { canvas: Canvas; context: SKRSContext2D } {
    const canvas = createCanvas(Math.max(1, Math.floor(width)), Math.max(1, Math.floor(height)));
    const context = canvas.getContext('2d');
    return { canvas, context };
  }

  reset(
    canvasAndContext: { canvas: Canvas; context: SKRSContext2D },
    width: number,
    height: number
  ): void {
    canvasAndContext.canvas.width = Math.max(1, Math.floor(width));
    canvasAndContext.canvas.height = Math.max(1, Math.floor(height));
  }

  destroy(canvasAndContext: { canvas: Canvas; context: SKRSContext2D }): void {
    canvasAndContext.canvas.width = 0;
    canvasAndContext.canvas.height = 0;
  }
}

async function runTesseractOnBuffers(buffers: Buffer[]): Promise<TextExtractionResult> {
  const worker = await createWorker('eng');
  try {
    const texts: string[] = [];
    const confidences: number[] = [];
    const wordConfidences: WordConfidence[] = [];

    for (const buf of buffers) {
      const result = await worker.recognize(buf, {}, { text: true, blocks: true });
      const pageText = (result.data.text || '').trim();
      if (pageText) {
        texts.push(pageText);
      }
      const pageConf = Number(result.data.confidence || 0) / 100;
      confidences.push(Math.max(0, Math.min(1, pageConf)));

      const blocks = result.data.blocks || [];
      for (const block of blocks) {
        for (const para of block.paragraphs || []) {
          for (const line of para.lines || []) {
            for (const w of line.words || []) {
              if (w.text && w.text.trim()) {
                wordConfidences.push({
                  text: w.text.trim(),
                  confidence: Math.max(0, Math.min(1, Number(w.confidence || 0) / 100)),
                });
              }
            }
          }
        }
      }
    }

    const avgConf =
      confidences.length > 0
        ? confidences.reduce((sum, c) => sum + c, 0) / confidences.length
        : 0;

    return {
      text: texts.join('\n\n'),
      method: 'TESSERACT_OCR',
      ocrConfidence: Number(avgConf.toFixed(2)),
      wordConfidences,
    };
  } finally {
    await worker.terminate();
  }
}

async function extractPdfTextAndMaybeRender(buffer: Buffer): Promise<TextExtractionResult> {
  const uint8 = new Uint8Array(buffer);
  const loadingTask = pdfjsLib.getDocument({
    data: uint8,
    useSystemFonts: true,
    disableFontFace: true,
    verbosity: 0,
  });

  const pdfDoc = await loadingTask.promise;
  const pageTexts: string[] = [];

  for (let p = 1; p <= pdfDoc.numPages; p++) {
    const page = await pdfDoc.getPage(p);
    const textContent = await page.getTextContent();
    const lines: string[] = [];
    let currentY: number | null = null;
    let currentLine: string[] = [];

    for (const item of textContent.items) {
      if (!('str' in item)) continue;
      const y = Array.isArray(item.transform) ? Math.round(item.transform[5]) : 0;
      if (currentY !== null && Math.abs(y - currentY) > 4) {
        if (currentLine.length > 0) {
          lines.push(currentLine.join(' ').replace(/\s+/g, ' ').trim());
        }
        currentLine = [];
      }
      currentY = y;
      if (item.str.trim()) {
        currentLine.push(item.str.trim());
      }
    }
    if (currentLine.length > 0) {
      lines.push(currentLine.join(' ').replace(/\s+/g, ' ').trim());
    }

    const combined = lines.join('\n').trim();
    if (combined) {
      pageTexts.push(combined);
    }
  }

  const embeddedText = pageTexts.join('\n\n').trim();
  const meaningfulChars = embeddedText.replace(/\s+/g, '').length;

  // Use direct text extraction when embedded text is present
  if (meaningfulChars >= 40) {
    return {
      text: embeddedText,
      method: 'PDF_TEXT',
      ocrConfidence: 0.98,
      wordConfidences: [],
    };
  }

  // Scanned PDF fallback: render pages to PNG and run Tesseract OCR
  const canvasFactory = new NodeCanvasFactory();
  const pageBuffers: Buffer[] = [];
  const maxPages = Math.min(pdfDoc.numPages, 5);

  for (let p = 1; p <= maxPages; p++) {
    const page = await pdfDoc.getPage(p);
    const viewport = page.getViewport({ scale: 2.0 });
    const { canvas, context } = canvasFactory.create(viewport.width, viewport.height);

    await page.render({
      canvasContext: context as unknown as CanvasRenderingContext2D,
      viewport,
      canvas: canvas as unknown as HTMLCanvasElement,
    }).promise;

    pageBuffers.push(canvas.toBuffer('image/png'));
    canvasFactory.destroy({ canvas, context });
  }

  return runTesseractOnBuffers(pageBuffers);
}

export async function extractTextFromDocument(
  buffer: Buffer,
  mimeType: string
): Promise<TextExtractionResult> {
  if (mimeType === 'application/pdf') {
    return extractPdfTextAndMaybeRender(buffer);
  }

  if (mimeType === 'image/png' || mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
    return runTesseractOnBuffers([buffer]);
  }

  throw new Error(`Unsupported document MIME type: ${mimeType}`);
}
