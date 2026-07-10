export type BarkEvent = {
  startedAtUtc: string
  endedAtUtc: string
  durationSeconds: number
  peakConfidence: number
  audioPath: string
}

// Dev serves the committed example data; prod serves the detector's live log.
export const CSV_URL = import.meta.env.DEV ? '/example.csv' : '/events.csv'

// The Python writer emits datetime.isoformat() with 6-digit microseconds and
// "+00:00" (e.g. 2026-07-09T13:00:00.123456+00:00). ECMAScript's date-time
// format only allows up to 3 fractional digits, so truncate before passing the
// string to Date(), otherwise several engines return Invalid Date.
function normalizeTimestamp(iso: string): string {
  return iso.replace(/\.(\d{3})\d+/, '.$1')
}

export function parseEvents(text: string): BarkEvent[] {
  const events: BarkEvent[] = []

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('started_at_utc')) continue

    const fields = trimmed.split(',')
    if (fields.length !== 5) continue

    const durationSeconds = Number(fields[2])
    const peakConfidence = Number(fields[3])
    if (Number.isNaN(durationSeconds) || Number.isNaN(peakConfidence)) continue

    events.push({
      startedAtUtc: normalizeTimestamp(fields[0]),
      endedAtUtc: normalizeTimestamp(fields[1]),
      durationSeconds,
      peakConfidence,
      audioPath: fields[4],
    })
  }

  // Newest first.
  events.sort((a, b) => b.startedAtUtc.localeCompare(a.startedAtUtc))
  return events
}

// audio_path is relative ("recordings/DATE/FILE.wav", backslashes on Windows).
// Map it to the URL the server serves recordings under.
export function audioUrlFor(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const stripped = normalized.replace(/^\/?recordings\//, '')
  return '/recordings/' + stripped
}

export async function loadEvents(): Promise<BarkEvent[]> {
  const response = await fetch(CSV_URL, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`Failed to load events (HTTP ${response.status})`)
  }
  return parseEvents(await response.text())
}
