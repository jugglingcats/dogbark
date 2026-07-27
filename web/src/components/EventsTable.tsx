import { useEffect, useRef, useState } from 'react'
import type { BarkEvent } from '../lib/csv'
import { audioUrlFor, deleteRecording } from '../lib/csv'

function EventRow({
  event,
  onDelete,
}: {
  event: BarkEvent
  onDelete?: (audioPath: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const audioRef = useRef<HTMLAudioElement>(null)

  // Start playback as soon as the player is revealed — the "Play" click is the
  // user gesture that lets the browser autoplay. Catch rejections from rapid
  // toggles (the element unmounts mid-play).
  useEffect(() => {
    if (open) {
      audioRef.current?.play().catch(() => {})
    }
  }, [open])

  async function handleDelete() {
    if (
      !window.confirm('Delete this recording? This removes the WAV and the log row.')
    ) {
      return
    }
    setDeleting(true)
    try {
      await deleteRecording(event.audioPath)
      onDelete?.(event.audioPath)
    } catch (err) {
      alert(err instanceof Error ? err.message : String(err))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <tr className="border-t border-neutral-200 dark:border-neutral-700">
        <td className="px-3 py-2 whitespace-nowrap">
          {new Date(event.startedAtUtc).toLocaleString()}
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          {event.durationSeconds.toFixed(1)}s
        </td>
        <td className="px-3 py-2 text-right tabular-nums">
          {(event.peakConfidence * 100).toFixed(0)}%
        </td>
        <td className="px-3 py-2 text-right tabular-nums text-neutral-400 dark:text-neutral-500">
          {event.levelDbfs != null ? event.levelDbfs.toFixed(1) : '—'}
        </td>
        <td className="px-3 py-2 text-center">
          <span className="inline-flex items-center gap-2">
            <button
              type="button"
              onClick={() => setOpen((value) => !value)}
              className="rounded bg-neutral-200 px-2 py-1 text-xs hover:bg-neutral-300 dark:bg-neutral-700 dark:hover:bg-neutral-600"
            >
              {open ? 'Hide' : 'Play'}
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="rounded bg-red-100 px-2 py-1 text-xs text-red-700 hover:bg-red-200 disabled:cursor-not-allowed disabled:opacity-50 dark:bg-red-900 dark:text-red-200 dark:hover:bg-red-800"
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </button>
          </span>
        </td>
      </tr>
      {open && (
        <tr className="border-t border-neutral-200 dark:border-neutral-700">
          <td colSpan={5} className="px-3 py-2">
            <audio ref={audioRef} controls src={audioUrlFor(event.audioPath)} className="w-full" />
          </td>
        </tr>
      )}
    </>
  )
}

export default function EventsTable({
  events,
  onDelete,
}: {
  events: BarkEvent[]
  onDelete?: (audioPath: string) => void
}) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-neutral-500 dark:text-neutral-400">
          <th className="px-3 py-2 font-medium">When (local)</th>
          <th className="px-3 py-2 text-right font-medium">Duration</th>
          <th className="px-3 py-2 text-right font-medium">Confidence</th>
          <th className="px-3 py-2 text-right font-medium">Level (dBFS)</th>
          <th className="px-3 py-2 text-center font-medium">Audio</th>
        </tr>
      </thead>
      <tbody>
        {events.map((event) => (
          <EventRow key={event.audioPath} event={event} onDelete={onDelete} />
        ))}
      </tbody>
    </table>
  )
}
