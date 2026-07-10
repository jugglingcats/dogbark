import { useEffect, useRef, useState } from 'react'
import type { BarkEvent } from '../lib/csv'
import { audioUrlFor } from '../lib/csv'

function EventRow({ event }: { event: BarkEvent }) {
  const [open, setOpen] = useState(false)
  const audioRef = useRef<HTMLAudioElement>(null)

  // Start playback as soon as the player is revealed — the "Play" click is the
  // user gesture that lets the browser autoplay. Catch rejections from rapid
  // toggles (the element unmounts mid-play).
  useEffect(() => {
    if (open) {
      audioRef.current?.play().catch(() => {})
    }
  }, [open])

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
        <td className="px-3 py-2 text-center">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="rounded bg-neutral-200 px-2 py-1 text-xs hover:bg-neutral-300 dark:bg-neutral-700 dark:hover:bg-neutral-600"
          >
            {open ? 'Hide' : 'Play'}
          </button>
        </td>
      </tr>
      {open && (
        <tr className="border-t border-neutral-200 dark:border-neutral-700">
          <td colSpan={4} className="px-3 py-2">
            <audio ref={audioRef} controls src={audioUrlFor(event.audioPath)} className="w-full" />
          </td>
        </tr>
      )}
    </>
  )
}

export default function EventsTable({ events }: { events: BarkEvent[] }) {
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-left text-neutral-500 dark:text-neutral-400">
          <th className="px-3 py-2 font-medium">When (local)</th>
          <th className="px-3 py-2 text-right font-medium">Duration</th>
          <th className="px-3 py-2 text-right font-medium">Confidence</th>
          <th className="px-3 py-2 text-center font-medium">Audio</th>
        </tr>
      </thead>
      <tbody>
        {events.map((event) => (
          <EventRow key={event.audioPath} event={event} />
        ))}
      </tbody>
    </table>
  )
}
