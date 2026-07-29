import type { BarkEvent } from './csv'

// Coarse-grained reporting: recordings that occur close together in time are
// rolled up into a single "incident". A new incident starts when the quiet gap
// between the end of one recording and the start of the next exceeds the
// selected interval. A gap of 0 disables grouping — every recording is its own
// (single-member) incident, so callers can render one shape either way.

export const MAX_GROUP_MINUTES = 5

export type BarkGroup = {
  // Start of the first recording in the incident. Named to match BarkEvent so
  // the timeline chart can bucket groups and events with the same code.
  startedAtUtc: string
  // End of the last recording in the incident.
  endedAtUtc: string
  // Wall-clock span of the incident (first start → last end), which includes
  // the quiet gaps between its recordings.
  durationSeconds: number
  // Sum of the individual recording durations (excludes the gaps).
  barkSeconds: number
  peakConfidence: number
  peakLevelDbfs?: number
  // Newest-first, like the top-level event list.
  events: BarkEvent[]
}

function msOf(iso: string): number {
  return new Date(iso).getTime()
}

function makeGroup(ascendingEvents: BarkEvent[]): BarkGroup {
  const first = ascendingEvents[0]
  const last = ascendingEvents[ascendingEvents.length - 1]

  let peakConfidence = 0
  let peakLevelDbfs: number | undefined
  let barkSeconds = 0
  for (const event of ascendingEvents) {
    peakConfidence = Math.max(peakConfidence, event.peakConfidence)
    barkSeconds += event.durationSeconds
    if (event.levelDbfs != null) {
      peakLevelDbfs =
        peakLevelDbfs == null ? event.levelDbfs : Math.max(peakLevelDbfs, event.levelDbfs)
    }
  }

  const spanMs = msOf(last.endedAtUtc) - msOf(first.startedAtUtc)

  return {
    startedAtUtc: first.startedAtUtc,
    endedAtUtc: last.endedAtUtc,
    durationSeconds: Number.isFinite(spanMs) ? spanMs / 1000 : first.durationSeconds,
    barkSeconds,
    peakConfidence,
    peakLevelDbfs,
    events: [...ascendingEvents].reverse(),
  }
}

/**
 * Roll `events` up into incidents. `gapMinutes` of 0 returns one group per
 * event. Input may be in any order; the result is newest-first.
 */
export function groupEvents(events: BarkEvent[], gapMinutes: number): BarkGroup[] {
  if (events.length === 0) return []

  const ascending = [...events].sort((a, b) =>
    a.startedAtUtc.localeCompare(b.startedAtUtc),
  )

  if (gapMinutes <= 0) {
    return ascending.reverse().map((event) => makeGroup([event]))
  }

  const gapMs = gapMinutes * 60_000
  const groups: BarkGroup[] = []
  let current: BarkEvent[] = [ascending[0]]
  // Track the latest end seen so far: recordings are sorted by start, but a
  // long one can still end after the next one starts.
  let currentEndMs = msOf(ascending[0].endedAtUtc)

  for (let i = 1; i < ascending.length; i++) {
    const event = ascending[i]
    const startMs = msOf(event.startedAtUtc)
    if (startMs - currentEndMs > gapMs) {
      groups.push(makeGroup(current))
      current = [event]
      currentEndMs = msOf(event.endedAtUtc)
      continue
    }
    current.push(event)
    currentEndMs = Math.max(currentEndMs, msOf(event.endedAtUtc))
  }
  groups.push(makeGroup(current))

  return groups.reverse()
}

export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const totalMinutes = Math.floor(seconds / 60)
  const remainingSeconds = Math.round(seconds - totalMinutes * 60)
  if (totalMinutes < 60) return `${totalMinutes}m ${remainingSeconds}s`
  const hours = Math.floor(totalMinutes / 60)
  return `${hours}h ${totalMinutes - hours * 60}m`
}
