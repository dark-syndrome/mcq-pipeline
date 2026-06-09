import { useState, type ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

// Label + "modified" dot wrapper for every control (§3.2 config diff view).
export function Field({
  label,
  hint,
  modified,
  children,
}: {
  label: string
  hint?: string
  modified?: boolean
  children: ReactNode
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5">
        <label className="text-sm text-muted">{label}</label>
        {modified && (
          <span
            title="Modified — not yet saved"
            className="h-1.5 w-1.5 rounded-full bg-warning"
          />
        )}
      </div>
      <div className="mt-1">{children}</div>
      {hint && <p className="mt-1 text-xs text-muted">{hint}</p>}
    </div>
  )
}

const inputCls =
  'w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm outline-none focus:border-primary'

export function NumberField(props: {
  label: string
  value: number
  onChange: (v: number) => void
  min?: number
  max?: number
  step?: number
  modified?: boolean
  hint?: string
}) {
  return (
    <Field label={props.label} hint={props.hint} modified={props.modified}>
      <input
        type="number"
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className={inputCls}
      />
    </Field>
  )
}

export function SliderField(props: {
  label: string
  value: number
  onChange: (v: number) => void
  min: number
  max: number
  step: number
  modified?: boolean
  hint?: string
}) {
  return (
    <Field
      label={`${props.label} — ${props.value}`}
      hint={props.hint}
      modified={props.modified}
    >
      <input
        type="range"
        value={props.value}
        min={props.min}
        max={props.max}
        step={props.step}
        onChange={(e) => props.onChange(Number(e.target.value))}
        className="w-full accent-primary"
      />
    </Field>
  )
}

export function TextField(props: {
  label: string
  value: string
  onChange: (v: string) => void
  placeholder?: string
  modified?: boolean
  hint?: string
}) {
  return (
    <Field label={props.label} hint={props.hint} modified={props.modified}>
      <input
        type="text"
        value={props.value}
        placeholder={props.placeholder}
        onChange={(e) => props.onChange(e.target.value)}
        className={inputCls}
      />
    </Field>
  )
}

export function SelectField(props: {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
  modified?: boolean
  hint?: string
}) {
  return (
    <Field label={props.label} hint={props.hint} modified={props.modified}>
      <select
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        className={inputCls}
      >
        {props.options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </Field>
  )
}

export function SegmentedField(props: {
  label: string
  value: string
  options: string[]
  onChange: (v: string) => void
  modified?: boolean
  hint?: string
}) {
  return (
    <Field label={props.label} hint={props.hint} modified={props.modified}>
      <div className="flex gap-1">
        {props.options.map((o) => (
          <button
            key={o}
            onClick={() => props.onChange(o)}
            className={`flex-1 rounded-lg px-2 py-1.5 text-sm capitalize ${
              props.value === o
                ? 'bg-primary text-white'
                : 'border border-border text-muted hover:text-text'
            }`}
          >
            {o.replace(/_/g, ' ')}
          </button>
        ))}
      </div>
    </Field>
  )
}

export function ToggleField(props: {
  label: string
  value: boolean
  onChange: (v: boolean) => void
  modified?: boolean
  hint?: string
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <div className="flex items-center gap-1.5">
          <label className="text-sm">{props.label}</label>
          {props.modified && (
            <span className="h-1.5 w-1.5 rounded-full bg-warning" />
          )}
        </div>
        {props.hint && <p className="mt-0.5 text-xs text-muted">{props.hint}</p>}
      </div>
      <button
        onClick={() => props.onChange(!props.value)}
        className={`mt-0.5 h-6 w-11 shrink-0 rounded-full p-0.5 transition-colors ${
          props.value ? 'bg-primary' : 'bg-border'
        }`}
      >
        <span
          className={`block h-5 w-5 rounded-full bg-white transition-transform ${
            props.value ? 'translate-x-5' : ''
          }`}
        />
      </button>
    </div>
  )
}

// Collapsible accordion section (§3.1).
export function Accordion({
  title,
  subtitle,
  children,
  defaultOpen = true,
}: {
  title: string
  subtitle?: string
  children: ReactNode
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="rounded-xl border border-border bg-surface">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between px-5 py-4 text-left"
      >
        <div>
          <h3 className="font-semibold">{title}</h3>
          {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
        </div>
        <ChevronDown
          className={`h-5 w-5 text-muted transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>
      {open && <div className="border-t border-border p-5">{children}</div>}
    </div>
  )
}
