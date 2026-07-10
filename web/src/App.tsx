import { useEffect, useState } from 'react'
import BarksPerDayChart from './components/BarksPerDayChart'
import ConfidenceSeries from './components/ConfidenceSeries'
import EventsTable from './components/EventsTable'
import { loadEvents, type BarkEvent } from './lib/csv'

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

export default function App() {
  const [events, setEvents] = useState<BarkEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)

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

  const dayAgo = updatedAt ? updatedAt.getTime() - 24 * 60 * 60 * 1000 : 0
  const last24h = events.filter(
    (event) => new Date(event.startedAtUtc).getTime() >= dayAgo,
  ).length
  const peakConfidence = events.reduce(
    (max, event) => Math.max(max, event.peakConfidence),
    0,
  )

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
        <Stat label="Total barks" value={String(events.length)} />
        <Stat label="Last 24 hours" value={String(last24h)} />
        <Stat label="Peak confidence" value={`${(peakConfidence * 100).toFixed(0)}%`} />
      </div>

      {events.length === 0 && !error ? (
        <p className="py-12 text-center text-neutral-500">No barks recorded yet.</p>
      ) : (
        <>
          <section className="mb-8 grid gap-6 md:grid-cols-2">
            <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-700">
              <h2 className="mb-2 font-medium">Barks per day</h2>
              <BarksPerDayChart events={events} />
            </div>
            <div className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-700">
              <h2 className="mb-2 font-medium">Confidence over time</h2>
              <ConfidenceSeries events={events} />
            </div>
          </section>

          <section className="rounded-lg border border-neutral-200 p-4 dark:border-neutral-700">
            <h2 className="mb-3 font-medium">Events</h2>
            <EventsTable events={events} />
          </section>
        </>
      )}
    </div>
  )
}
