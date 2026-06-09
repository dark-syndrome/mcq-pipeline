import { useStore } from '../store'

// Persistent 32px status bar (§2.2), docked at the bottom of every screen.
export default function StatusBar() {
  const s = useStore((st) => st.status)
  const sep = <span className="text-border">|</span>

  return (
    <footer className="flex h-8 shrink-0 items-center gap-3 border-t border-border bg-surface px-3 text-xs text-muted">
      <span className="flex items-center gap-1.5">
        <span
          className={`h-2 w-2 rounded-full ${s.connected ? 'bg-success' : 'bg-danger'}`}
        />
        {s.provider}
      </span>
      {sep}
      <span>
        Analyzer → {s.modelRoute.analyzer} · Generator → {s.modelRoute.generator} ·
        Critic → {s.modelRoute.critic}
      </span>
      {sep}
      <span>
        SQLite: {s.dbPath}
        {s.dbRows != null ? ` (${s.dbRows} rows)` : ''}
      </span>
      {sep}
      <span>Supabase: {s.supabaseEnabled ? 'enabled' : 'disabled'}</span>
      <span className="ml-auto font-medium text-text">
        Session cost: ${s.sessionCost.toFixed(3)}
      </span>
    </footer>
  )
}
