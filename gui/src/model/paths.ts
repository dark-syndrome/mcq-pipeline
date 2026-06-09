// Dotted-path get/set + diff over the nested config object. The Model tab edits
// by path (e.g. "pricing.input_per_million_tokens") and computes the changed
// leaves to send to config:write.

export function getPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (o, k) => (o == null ? undefined : (o as Record<string, unknown>)[k]),
      obj,
    )
}

export function setPath<T>(obj: T, path: string, value: unknown): T {
  const keys = path.split('.')
  const next = { ...(obj as Record<string, unknown>) }
  let cur = next
  for (let i = 0; i < keys.length - 1; i++) {
    cur[keys[i]] = { ...((cur[keys[i]] as Record<string, unknown>) ?? {}) }
    cur = cur[keys[i]] as Record<string, unknown>
  }
  cur[keys[keys.length - 1]] = value
  return next as T
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Changed leaves only, as dotted paths → value.
export function deepDiff(
  staged: unknown,
  saved: unknown,
  prefix = '',
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (isPlainObject(staged) && isPlainObject(saved)) {
    const keys = new Set([...Object.keys(staged), ...Object.keys(saved)])
    for (const k of keys) {
      Object.assign(
        out,
        deepDiff(staged[k], saved[k], prefix ? `${prefix}.${k}` : k),
      )
    }
  } else if (JSON.stringify(staged) !== JSON.stringify(saved)) {
    out[prefix] = staged
  }
  return out
}

export function pathModified(
  staged: unknown,
  saved: unknown,
  path: string,
): boolean {
  return (
    JSON.stringify(getPath(staged, path)) !==
    JSON.stringify(getPath(saved, path))
  )
}
