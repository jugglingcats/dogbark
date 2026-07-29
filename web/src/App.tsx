import { useEffect, useMemo, useState } from 'react'
import BarksTimeline from './components/BarksTimeline'
import EventsTable from './components/EventsTable'
import { loadEvents, type BarkEvent } from './lib/csv'
import { groupEvents, MAX_GROUP_MINUTES } from './lib/grouping'

const POLL_MS = 20_000

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-700">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="text-xs uppercase tracking-wide text-neutral-500 dark:text-neutral-400">
        {label}
      </div>
    </div>
  )
}

// Rolls nearby recordings into coarse-grained incidents. 0 (the default) keeps
// every recording separate.
function GroupingSlider({
  minutes,
  onChange,
}: {
  minutes: number
  onChange: (minutes: number) => void
}) {
  return (
    <div className="mb-6 rounded-lg border border-neutral-200 px-4 py-3 dark:border-neutral-700">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <label
          htmlFor="group-minutes"
          className="text-sm font-medium whitespace-nowrap"
        >
          Group into incidents
        </label>
        <input
          id="group-minutes"
          type="range"
          min={0}
          max={MAX_GROUP_MINUTES}
          step={1}
          value={minutes}
          onChange={(e) => onChange(Number(e.target.value))}
          className="min-w-[12rem] flex-1 accent-purple-600"
        />
        <span className="text-sm tabular-nums whitespace-nowrap text-neutral-500 dark:text-neutral-400">
          {minutes === 0 ? 'Off' : `${minutes} min`}
        </span>
      </div>
      <div
        aria-hidden="true"
        className="mt-1 flex justify-between text-[10px] tabular-nums text-neutral-400 dark:text-neutral-500"
      >
        {Array.from({ length: MAX_GROUP_MINUTES + 1 }, (_, i) => (
          <span key={i}>{i}</span>
        ))}
      </div>
      <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">
        {minutes === 0
          ? 'Showing every recording individually.'
          : `Recordings less than ${minutes} minute${minutes === 1 ? '' : 's'} apart are counted as one incident.`}
      </p>
    </div>
  )
}

export default function App() {
  const [events, setEvents] = useState<BarkEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [groupMinutes, setGroupMinutes] = useState(0)

  useEffect(() => {
    let cancelled = false

    async function refresh() {
      try {
        const loaded = await loadEvents()
        if (!cancelled) {
          setEvents(loaded)
          setUpdatedAt(new Date())
          setError(null)
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    }

    refresh()
    const id = setInterval(refresh, POLL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [])

  const grouped = groupMinutes > 0
  const groups = useMemo(
    () => groupEvents(events, groupMinutes),
    [events, groupMinutes],
  )
  const unit = grouped
    ? { one: 'incident', many: 'incidents' }
    : { one: 'bark', many: 'barks' }

  const dayAgo = updatedAt ? updatedAt.getTime() - 24 * 60 * 60 * 1000 : 0
  const last24h = groups.filter(
    (group) => new Date(group.startedAtUtc).getTime() >= dayAgo,
  ).length
  const peakConfidence = events.reduce(
    (max, event) => Math.max(max, event.peakConfidence),
    0,
  )

  const handleDelete = (audioPath: string) => {
    setEvents((prev) => prev.filter((event) => event.audioPath !== audioPath))
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">🐶 Dog Bark Monitor</h1>
          <p className="text-sm text-neutral-500 dark:text-neutral-400">
            {updatedAt
              ? `Updated ${updatedAt.toLocaleTimeString()} · refreshes every ${POLL_MS / 1000}s`
              : 'Loading…'}
          </p>
        </div>
      </header>

      {error && (
        <div className="mb-6 rounded-lg border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="mb-6 grid grid-cols-3 gap-3">
        <Stat
          label={grouped ? 'Total incidents' : 'Total barks'}
          value={String(groups.length)}
        />
        <Stat label="Last 24 hours" value={String(last24h)} />
        <Stat label="Peak confidence" value={`${(peakConfidence * 100).toFixed(0)}%`} />
      </div>

      <GroupingSlider minutes={groupMinutes} onChange={setGroupMinutes} />

      {events.length === 0 && !error ? (
        <p className="py-12 text-center text-neutral-500">No barks recorded yet.</p>
      ) : (
        <>
          <section className="mb-8 rounded-lg border border-neutral-200 p-4 dark:border-neutral-700">
            <h2 className="mb-3 font-medium">
              {grouped ? 'Incidents over time' : 'Barks over time'}
            </h2>
            <BarksTimeline events={groups} unit={unit} />
          </section>

          <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-700">
            <h2 className="mb-3 font-medium">{grouped ? 'Incidents' : 'Events'}</h2>
            <EventsTable groups={groups} grouped={grouped} onDelete={handleDelete} />
          </section>
        </>
      )}
    </div>
  )
}
