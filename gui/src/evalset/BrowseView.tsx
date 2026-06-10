import { useState } from 'react'
import type { EvalAnnotation, EvalQuestion, McqOption } from '../types'

interface Props {
  questions: EvalQuestion[]
  onUpdate: (id: number, annotation: EvalAnnotation) => void
}

export default function BrowseView({ questions, onUpdate }: Props) {
  if (questions.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center text-sm text-muted">
        No questions in this eval set.
      </div>
    )
  }
  return (
    <div className="space-y-4">
      {questions.map((q, i) => (
        <QuestionCard
          key={q.id}
          index={i}
          q={q}
          onUpdate={(ann) => onUpdate(q.id, ann)}
        />
      ))}
    </div>
  )
}

function QuestionCard({
  index,
  q,
  onUpdate,
}: {
  index: number
  q: EvalQuestion
  onUpdate: (a: EvalAnnotation) => void
}) {
  const ann = q.annotation
  const [excerptOpen, setExcerptOpen] = useState(false)

  return (
    <div className="rounded-xl border border-border bg-surface p-4">
      {/* Metadata row */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="min-w-[1.75rem] text-right text-xs text-muted">#{index + 1}</span>
        <span className="rounded bg-primary/20 px-1.5 py-0.5 text-[10px] text-primary">
          {q.bloom_level}
        </span>
        <span className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted">
          {q.difficulty}
        </span>
        {q.source_heading && (
          <span
            className="max-w-[200px] truncate rounded border border-border px-1.5 py-0.5 text-[10px] text-muted"
            title={q.source_heading}
          >
            {q.source_heading}
          </span>
        )}
        {/* Confirm / Flag toggle (right-aligned) */}
        <div className="ml-auto flex gap-1.5">
          <button
            title="Mark as correct"
            onClick={() => onUpdate({ ...ann, confirmed: ann.confirmed === true ? null : true })}
            className={`rounded px-2.5 py-1 text-xs transition-colors ${
              ann.confirmed === true
                ? 'bg-success/20 text-success'
                : 'text-muted hover:bg-success/10 hover:text-success'
            }`}
          >
            ✓ Correct
          </button>
          <button
            title="Flag as wrong"
            onClick={() => onUpdate({ ...ann, confirmed: ann.confirmed === false ? null : false })}
            className={`rounded px-2.5 py-1 text-xs transition-colors ${
              ann.confirmed === false
                ? 'bg-danger/20 text-danger'
                : 'text-muted hover:bg-danger/10 hover:text-danger'
            }`}
          >
            ✗ Wrong
          </button>
        </div>
      </div>

      {/* Question stem */}
      <p className="mb-3 text-sm leading-relaxed">{q.question}</p>

      {/* Options */}
      <ul className="mb-4 space-y-1">
        {(q.options as McqOption[]).map((o, j) => (
          <li
            key={j}
            className={`flex items-start gap-2 rounded px-2 py-1 text-xs ${
              o.is_correct ? 'bg-success/10 font-medium text-success' : 'text-muted'
            }`}
          >
            <span className="shrink-0">{o.label ?? String.fromCharCode(65 + j)}.</span>
            <span>{o.text}</span>
          </li>
        ))}
      </ul>

      {/* Bottom annotation bar */}
      <div className="flex flex-wrap items-center gap-4 border-t border-border pt-3">
        {/* 5-star rating */}
        <div className="flex items-center gap-1">
          <span className="mr-1 text-[10px] text-muted">Quality:</span>
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              title={`Rate ${star} star${star !== 1 ? 's' : ''}`}
              onClick={() => onUpdate({ ...ann, rating: ann.rating === star ? 0 : star })}
              className={`text-base leading-none transition-colors ${
                star <= ann.rating ? 'text-warning' : 'text-muted/40 hover:text-warning/60'
              }`}
            >
              ★
            </button>
          ))}
          {ann.rating > 0 && (
            <span className="ml-1 text-[10px] text-muted">{ann.rating}/5</span>
          )}
        </div>

        {/* Source excerpt toggle */}
        {q.source_excerpt && (
          <button
            className="text-xs text-muted hover:text-text"
            onClick={() => setExcerptOpen((o) => !o)}
          >
            {excerptOpen ? '▲ Hide excerpt' : '▼ Show excerpt'}
          </button>
        )}

        {/* Critic badge: accepted questions passed all criteria */}
        <span className="ml-auto rounded bg-success/10 px-2 py-0.5 text-[10px] text-success">
          ✓ Critic accepted
        </span>
      </div>

      {/* Source excerpt */}
      {excerptOpen && q.source_excerpt && (
        <blockquote className="mt-3 rounded border-l-2 border-primary/40 bg-bg px-3 py-2 text-xs italic text-muted">
          {q.source_excerpt}
        </blockquote>
      )}

      {/* Notes */}
      <textarea
        className="mt-3 w-full resize-none rounded border border-border bg-bg px-3 py-2 text-xs text-text placeholder:text-muted focus:outline-none focus:ring-1 focus:ring-primary"
        rows={2}
        placeholder="Notes about this question…"
        value={ann.notes}
        onChange={(e) => onUpdate({ ...ann, notes: e.target.value })}
      />
    </div>
  )
}
