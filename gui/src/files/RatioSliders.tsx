import type { DifficultyRatio } from '../types'

// §5.3 — four difficulty sliders that always sum to 100%. Adjusting one
// redistributes the remainder proportionally across the other three.
const KEYS: (keyof DifficultyRatio)[] = ['easy', 'medium', 'hard', 'expert']

export const EQUAL_RATIO: DifficultyRatio = {
  easy: 25,
  medium: 25,
  hard: 25,
  expert: 25,
}

function redistribute(
  ratio: DifficultyRatio,
  changed: keyof DifficultyRatio,
  value: number,
): DifficultyRatio {
  const v = Math.max(0, Math.min(100, Math.round(value)))
  const others = KEYS.filter((k) => k !== changed)
  const remaining = 100 - v
  const otherSum = others.reduce((s, k) => s + ratio[k], 0)
  const next = { ...ratio, [changed]: v } as DifficultyRatio
  if (otherSum === 0) {
    // spread evenly if the others were all zero
    others.forEach((k, i) => {
      next[k] = Math.floor(remaining / others.length) + (i === 0 ? remaining % others.length : 0)
    })
  } else {
    let acc = 0
    others.forEach((k, i) => {
      const share =
        i === others.length - 1
          ? remaining - acc // last bucket absorbs rounding
          : Math.round((ratio[k] / otherSum) * remaining)
      next[k] = Math.max(0, share)
      acc += next[k]
    })
  }
  return next
}

export default function RatioSliders({
  ratio,
  onChange,
}: {
  ratio: DifficultyRatio
  onChange: (r: DifficultyRatio) => void
}) {
  const sum = KEYS.reduce((s, k) => s + ratio[k], 0)
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted">
          Difficulty Ratio
        </span>
        <button
          onClick={() => onChange(EQUAL_RATIO)}
          className="text-[11px] text-primary hover:underline"
        >
          Reset to Equal
        </button>
      </div>
      {KEYS.map((k) => (
        <div key={k} className="flex items-center gap-2">
          <span className="w-14 text-[11px] capitalize text-muted">{k}</span>
          <input
            type="range"
            min={0}
            max={100}
            value={ratio[k]}
            onChange={(e) =>
              onChange(redistribute(ratio, k, Number(e.target.value)))
            }
            className="h-1 flex-1 accent-primary"
          />
          <span className="w-8 text-right text-[11px] tabular-nums">
            {ratio[k]}%
          </span>
        </div>
      ))}
      {sum !== 100 && (
        <p className="text-[11px] text-warning">Sums to {sum}% (should be 100%)</p>
      )}
    </div>
  )
}
