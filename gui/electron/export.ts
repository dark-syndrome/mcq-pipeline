import fs from 'node:fs'
import { BrowserWindow } from 'electron'
import {
  AlignmentType,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from 'docx'
import * as XLSX from 'xlsx'

// Export the selected MCQ set to JSON / DOCX / PDF / XLSX (GUI §5.6). File
// generation lives here; the save-dialog interaction stays in ipc.ts. Rows are
// the parsed McqRow objects sent from the renderer (see src/types.ts).

export interface ExportOptions {
  format: 'json' | 'docx' | 'pdf' | 'xlsx'
  // JSON
  includeExplanation?: boolean
  includeRationale?: boolean
  // DOCX / PDF
  answerKey?: boolean
  explanations?: boolean
  metadata?: boolean
  coverPage?: boolean
  topic?: string
}

interface Opt {
  label: string
  text: string
  is_correct: boolean
  distractor_rationale: string | null
}
export interface ExportRow {
  question: string
  options: Opt[]
  explanation: string | null
  source_excerpt: string | null
  source_heading: string
  bloom_level: string
  difficulty: string
  question_type: string
  question_number: number | null
  generation_number: number
  [k: string]: unknown
}

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// --- JSON ---
export function buildJson(rows: ExportRow[], o: ExportOptions): string {
  const out = rows.map((r) => {
    const opts = r.options.map((op) => ({
      label: op.label,
      text: op.text,
      is_correct: op.is_correct,
      ...(o.includeRationale !== false
        ? { distractor_rationale: op.distractor_rationale }
        : {}),
    }))
    const obj: Record<string, unknown> = {
      question: r.question,
      options: opts,
      source_excerpt: r.source_excerpt,
      source_heading: r.source_heading,
      bloom_level: r.bloom_level,
      difficulty: r.difficulty,
      question_type: r.question_type,
      question_number: r.question_number,
      generation_number: r.generation_number,
    }
    if (o.includeExplanation !== false) obj.explanation = r.explanation
    return obj
  })
  return JSON.stringify(out, null, 2)
}

// --- shared styled HTML (used by the PDF path) ---
export function buildHtml(rows: ExportRow[], o: ExportOptions): string {
  const title = o.topic || 'MCQ Export'
  const cover = o.coverPage
    ? `<section class="cover"><h1>${esc(title)}</h1>
         <p>${rows.length} questions</p></section>`
    : ''
  const questions = rows
    .map((r, i) => {
      const opts = r.options
        .map(
          (op) =>
            `<li class="${op.is_correct ? 'correct' : ''}">
               <b>${esc(op.label)}.</b> ${esc(op.text)}
               ${op.is_correct ? ' <span class="tick">✓</span>' : ''}
             </li>`,
        )
        .join('')
      const meta = o.metadata
        ? `<p class="meta">${esc(r.difficulty)} · ${esc(r.bloom_level)} · ${esc(r.question_type)}${
            r.source_heading ? ` · ${esc(r.source_heading)}` : ''
          }</p>`
        : ''
      const expl =
        o.explanations && r.explanation
          ? `<p class="expl"><i>Explanation:</i> ${esc(r.explanation)}</p>`
          : ''
      return `<div class="q"><p class="stem"><b>${i + 1}.</b> ${esc(
        r.question,
      )}</p><ul>${opts}</ul>${meta}${expl}</div>`
    })
    .join('')
  const answerKey = o.answerKey
    ? `<section class="key"><h2>Answer Key</h2><ol>${rows
        .map((r) => {
          const correct = r.options
            .filter((op) => op.is_correct)
            .map((op) => op.label)
            .join(', ')
          return `<li>${esc(correct || '—')}</li>`
        })
        .join('')}</ol></section>`
    : ''
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    body{font-family:Segoe UI,Arial,sans-serif;color:#111;margin:32px;font-size:13px;line-height:1.45}
    .cover{text-align:center;margin:120px 0;page-break-after:always}
    .cover h1{font-size:28px}
    .q{margin:0 0 18px;page-break-inside:avoid}
    .stem{margin:0 0 6px}
    ul{margin:4px 0;padding-left:22px;list-style:none}
    li{margin:2px 0}
    li.correct{color:#0a7d3c;font-weight:600}
    .tick{color:#0a7d3c}
    .meta{color:#666;font-size:11px;margin:4px 0 0}
    .expl{color:#333;font-size:12px;margin:4px 0 0}
    .key{margin-top:32px;page-break-before:always}
    .key ol{padding-left:22px}
  </style></head><body>${cover}${questions}${answerKey}</body></html>`
}

// --- PDF via Electron's bundled Chromium (no Puppeteer) ---
export async function buildPdf(
  rows: ExportRow[],
  o: ExportOptions,
): Promise<Buffer> {
  const html = buildHtml(rows, o)
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, javascript: false },
  })
  try {
    await win.loadURL(
      'data:text/html;charset=utf-8,' + encodeURIComponent(html),
    )
    const data = await win.webContents.printToPDF({
      printBackground: true,
      margins: { marginType: 'default' },
    })
    return data
  } finally {
    win.destroy()
  }
}

// --- DOCX via the docx package (pure JS) ---
export async function buildDocx(
  rows: ExportRow[],
  o: ExportOptions,
): Promise<Buffer> {
  const children: Paragraph[] = []

  if (o.coverPage) {
    children.push(
      new Paragraph({
        text: o.topic || 'MCQ Export',
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
      }),
      new Paragraph({
        text: `${rows.length} questions`,
        alignment: AlignmentType.CENTER,
      }),
      new Paragraph({ text: '', pageBreakBefore: false }),
    )
  }

  rows.forEach((r, i) => {
    children.push(
      new Paragraph({
        children: [new TextRun({ text: `${i + 1}. ${r.question}`, bold: true })],
        spacing: { before: 200, after: 60 },
      }),
    )
    for (const op of r.options) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `${op.label}. ${op.text}${op.is_correct ? '  ✓' : ''}`,
              bold: op.is_correct,
              color: op.is_correct ? '0A7D3C' : undefined,
            }),
          ],
          indent: { left: 360 },
        }),
      )
    }
    if (o.metadata) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `${r.difficulty} · ${r.bloom_level} · ${r.question_type}${
                r.source_heading ? ` · ${r.source_heading}` : ''
              }`,
              italics: true,
              color: '666666',
              size: 18,
            }),
          ],
          indent: { left: 360 },
        }),
      )
    }
    if (o.explanations && r.explanation) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: 'Explanation: ', italics: true }),
            new TextRun({ text: r.explanation }),
          ],
          indent: { left: 360 },
          spacing: { before: 40 },
        }),
      )
    }
  })

  if (o.answerKey) {
    children.push(
      new Paragraph({
        text: 'Answer Key',
        heading: HeadingLevel.HEADING_1,
        pageBreakBefore: true,
      }),
    )
    rows.forEach((r, i) => {
      const correct = r.options
        .filter((op) => op.is_correct)
        .map((op) => op.label)
        .join(', ')
      children.push(
        new Paragraph({ text: `${i + 1}. ${correct || '—'}`, indent: { left: 360 } }),
      )
    })
  }

  const doc = new Document({ sections: [{ children }] })
  return Packer.toBuffer(doc) as Promise<Buffer>
}

// --- XLSX via SheetJS (pure JS, works in the main process without native build) ---
export function buildXlsx(rows: ExportRow[], o: ExportOptions): Buffer {
  const headers: string[] = ['#', 'Question', 'A', 'B', 'C', 'D', 'Answer']
  if (o.metadata !== false) {
    headers.push('Bloom', 'Difficulty', 'Type', 'Source Heading', 'Q#')
  }
  if (o.includeExplanation !== false) {
    headers.push('Explanation')
  }
  if (o.includeRationale) {
    headers.push('Rationale A', 'Rationale B', 'Rationale C', 'Rationale D')
  }

  const aoa: (string | number | null)[][] = [headers]
  rows.forEach((r, i) => {
    const sorted = [...r.options].sort((a, b) =>
      (a.label ?? '').localeCompare(b.label ?? ''),
    )
    const answer = sorted.find((op) => op.is_correct)?.label ?? ''
    const row: (string | number | null)[] = [
      i + 1,
      r.question,
      sorted[0]?.text ?? '',
      sorted[1]?.text ?? '',
      sorted[2]?.text ?? '',
      sorted[3]?.text ?? '',
      answer,
    ]
    if (o.metadata !== false) {
      row.push(
        r.bloom_level,
        r.difficulty,
        r.question_type,
        r.source_heading,
        r.question_number,
      )
    }
    if (o.includeExplanation !== false) {
      row.push(r.explanation ?? '')
    }
    if (o.includeRationale) {
      row.push(
        sorted[0]?.distractor_rationale ?? '',
        sorted[1]?.distractor_rationale ?? '',
        sorted[2]?.distractor_rationale ?? '',
        sorted[3]?.distractor_rationale ?? '',
      )
    }
    aoa.push(row)
  })

  const ws = XLSX.utils.aoa_to_sheet(aoa)
  // Freeze header row and set reasonable column widths
  ws['!freeze'] = { xSplit: 0, ySplit: 1 }
  ws['!cols'] = [
    { wch: 4 },  // #
    { wch: 60 }, // Question
    { wch: 36 }, // A
    { wch: 36 }, // B
    { wch: 36 }, // C
    { wch: 36 }, // D
    { wch: 8 },  // Answer
    { wch: 12 }, // Bloom
    { wch: 12 }, // Difficulty
    { wch: 16 }, // Type
    { wch: 28 }, // Source Heading
    { wch: 5 },  // Q#
    { wch: 60 }, // Explanation
    { wch: 40 }, // Rationale A
    { wch: 40 }, // Rationale B
    { wch: 40 }, // Rationale C
    { wch: 40 }, // Rationale D
  ]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'MCQs')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

// Write a string or buffer to disk (target chosen via save dialog in ipc.ts).
export function writeFileSync(target: string, data: string | Buffer): void {
  fs.writeFileSync(target, data)
}
