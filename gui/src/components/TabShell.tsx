import type { ReactNode } from 'react'

// Shared frame for each tab. Tabs render placeholder content until their
// dedicated build session (see docs/BUILD_CHECKLIST.md).
export default function TabShell({
  title,
  subtitle,
  session,
  children,
}: {
  title: string
  subtitle: string
  session: string
  children?: ReactNode
}) {
  return (
    <div className="px-10 py-8">
      <h1 className="text-2xl font-bold">{title}</h1>
      <p className="mt-1 text-sm text-muted">{subtitle}</p>
      <div className="mt-8">
        {children ?? (
          <div className="rounded-xl border border-dashed border-border bg-surface/50 p-12 text-center text-muted">
            Built in {session}.
          </div>
        )}
      </div>
    </div>
  )
}
