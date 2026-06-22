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

export interface PaperHeader {
  institution?: string
  title: string
  subject?: string
  date?: string
  duration?: string
  maxMarks?: number
  instructions?: string
}

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
  // Question paper header (replaces coverPage when present)
  paperHeader?: PaperHeader
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

  // Paper header takes priority over the generic cover page.
  let cover = ''
  if (o.paperHeader) {
    const h = o.paperHeader
    const metaParts: string[] = []
    if (h.subject) metaParts.push(`Subject: ${esc(h.subject)}`)
    if (h.date) metaParts.push(`Date: ${esc(h.date)}`)
    if (h.duration) metaParts.push(`Duration: ${esc(h.duration)}`)
    if (h.maxMarks != null) metaParts.push(`Max Marks: ${h.maxMarks}`)
    cover =
      `<div class="paper-header">` +
      (h.institution ? `<p class="ph-institution">${esc(h.institution)}</p>` : '') +
      `<h1 class="ph-title">${esc(h.title)}</h1>` +
      (metaParts.length ? `<p class="ph-meta">${metaParts.join(' &nbsp;|&nbsp; ')}</p>` : '') +
      `<hr class="ph-rule">` +
      (h.instructions
        ? `<p class="ph-instructions"><b>Instructions:</b> ${esc(h.instructions)}</p>`
        : '') +
      `</div>`
  } else if (o.coverPage) {
    cover = `<section class="cover"><h1>${esc(title)}</h1>
         <p>${rows.length} questions</p></section>`
  }
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
    .paper-header{text-align:center;margin-bottom:20px;padding-bottom:12px}
    .ph-institution{font-size:13px;font-weight:600;margin:0 0 4px}
    .ph-title{font-size:22px;font-weight:700;margin:0 0 6px}
    .ph-meta{font-size:12px;margin:0 0 8px;color:#333}
    .ph-rule{border:none;border-top:2px solid #111;margin:6px 0 8px}
    .ph-instructions{font-size:12px;text-align:left;margin:0}
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

  if (o.paperHeader) {
    const h = o.paperHeader
    if (h.institution) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: h.institution, bold: true, size: 26 })],
          alignment: AlignmentType.CENTER,
          spacing: { after: 60 },
        }),
      )
    }
    children.push(
      new Paragraph({
        text: h.title,
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.CENTER,
      }),
    )
    const metaParts: string[] = []
    if (h.subject) metaParts.push(`Subject: ${h.subject}`)
    if (h.date) metaParts.push(`Date: ${h.date}`)
    if (h.duration) metaParts.push(`Duration: ${h.duration}`)
    if (h.maxMarks != null) metaParts.push(`Max Marks: ${h.maxMarks}`)
    if (metaParts.length) {
      children.push(
        new Paragraph({
          children: [new TextRun({ text: metaParts.join('    '), size: 22 })],
          alignment: AlignmentType.CENTER,
          spacing: { before: 60, after: 80 },
        }),
      )
    }
    // Horizontal rule via an underline-styled empty paragraph
    children.push(
      new Paragraph({
        children: [
          new TextRun({
            text: '─'.repeat(80),
            color: '111111',
            size: 16,
          }),
        ],
        alignment: AlignmentType.CENTER,
        spacing: { after: 80 },
      }),
    )
    if (h.instructions) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({ text: 'Instructions: ', bold: true }),
            new TextRun({ text: h.instructions }),
          ],
          spacing: { before: 40, after: 240 },
        }),
      )
    } else {
      children.push(new Paragraph({ text: '', spacing: { after: 120 } }))
    }
  } else if (o.coverPage) {
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
      (a.label ?? '').localeCompare(b.label ?? '', 'en'),
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

// --- Paper XLSX (question-paper export format) ---
// Fixed column layout used when exporting a generated question paper.
// Columns: S.No | question content | Option A-D | Explanation | Key |
// Portal upload format: S.No | question content | A-D | Explanation | Key | sub_topic | Difficulty | IS_PUBLIC/IS_PRIVATE
export function buildPaperXlsx(rows: ExportRow[]): Buffer {
  const headers = [
    'S. No',
    'question content',
    'Option A',
    'Option B',
    'Option C',
    'Option D',
    'Explanation',
    'Key',
    'SUB TOPIC',
    'Difficulty',
    'IS_PUBLIC/IS_PRIVATE',
  ]

  const aoa: (string | number | null)[][] = [headers]
  rows.forEach((r, i) => {
    const sorted = [...r.options].sort((a, b) =>
      (a.label ?? '').localeCompare(b.label ?? '', 'en'),
    )
    const correctOpt = sorted.find((op) => op.is_correct)
    if (!correctOpt) {
      console.warn(`[export] Row ${i + 1} has no correct option — skipping`)
      return
    }
    const key = correctOpt.label
    const tagList = Array.isArray(r['tags']) ? (r['tags'] as string[]) : []
    const visibility = tagList.includes('IS_PUBLIC') ? 'IS_PUBLIC' : 'IS_PRIVATE'
    aoa.push([
      i + 1,
      r.question,
      sorted[0]?.text ?? '',
      sorted[1]?.text ?? '',
      sorted[2]?.text ?? '',
      sorted[3]?.text ?? '',
      r.explanation ?? '',
      key,
      String(r['sub_topic'] ?? ''),
      r.difficulty
        ? r.difficulty.charAt(0).toUpperCase() + r.difficulty.slice(1)
        : '',
      visibility,
    ])
  })

  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!freeze'] = { xSplit: 0, ySplit: 1 }
  ws['!cols'] = [
    { wch: 6 },  // S. No
    { wch: 70 }, // question content
    { wch: 36 }, // Option A
    { wch: 36 }, // Option B
    { wch: 36 }, // Option C
    { wch: 36 }, // Option D
    { wch: 60 }, // Explanation
    { wch: 8 },  // Key
    { wch: 30 }, // SUB TOPIC
    { wch: 12 }, // Difficulty
    { wch: 20 }, // IS_PUBLIC/IS_PRIVATE
  ]
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Questions')
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer
}

// Write a string or buffer to disk (target chosen via save dialog in ipc.ts).
export function writeFileSync(target: string, data: string | Buffer): void {
  fs.writeFileSync(target, data)
}
