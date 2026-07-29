import { useEffect, useMemo, useRef, useState } from 'react'

// A single full-width chart that buckets every item by the local hour it
// started in and draws one thin bar per hour. Items are individual recordings
// when grouping is off, or rolled-up incidents when it is on — the chart only
// needs a start timestamp, so the same code serves both. Each calendar day gets
// a header band across the top with that day's total sitting on a horizontal
// rule. The time axis is laid out at a fixed 10px per hour, so once there is
// more than a screen's worth of days the plot scrolls horizontally and snaps to
// the latest data on load.

// Anything with a start timestamp: a BarkEvent or a BarkGroup.
type TimelineItem = { startedAtUtc: string }

type Unit = { one: string; many: string }

const DEFAULT_UNIT: Unit = { one: 'bark', many: 'barks' }

const HOUR_PX = 10 // requirement: ~10px per hour
const DAY_BAND_H = 44
const PLOT_H = 180
const X_AXIS_H = 28
const Y_AXIS_W = 34
const DAY_MS = 86_400_000
const TOOLTIP_W = 156

const PLOT_TOP = DAY_BAND_H
const PLOT_BOTTOM = PLOT_TOP + PLOT_H
const TOTAL_H = DAY_BAND_H + PLOT_H + X_AXIS_H

type Buckets = {
  firstDay: number // local-midnight ms of the first day with a bark
  numDays: number
  totalHours: number
  counts: Uint16Array // length totalHours; index = dayIndex*24 + hourOfDay
  dayTotals: number[]
  maxCount: number
}

function localDayStartMs(iso: string): number {
  const d = new Date(iso)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function bucketize(events: TimelineItem[]): Buckets | null {
  if (events.length === 0) return null

  let firstDay = Infinity
  let lastDay = -Infinity
  for (const event of events) {
    const dayStart = localDayStartMs(event.startedAtUtc)
    if (dayStart < firstDay) firstDay = dayStart
    if (dayStart > lastDay) lastDay = dayStart
  }

  // Render whole calendar days so every day band is a uniform 24h wide and the
  // per-day totals are comparable. Treat each day as exactly 24 hour-slots
  // (the x-axis is effectively "hour of day"); DST drift is irrelevant here.
  const numDays = Math.round((lastDay - firstDay) / DAY_MS) + 1
  const totalHours = numDays * 24
  const counts = new Uint16Array(totalHours)
  for (const event of events) {
    const dayIndex = Math.round(
      (localDayStartMs(event.startedAtUtc) - firstDay) / DAY_MS,
    )
    const hourOfDay = new Date(event.startedAtUtc).getHours()
    const idx = dayIndex * 24 + hourOfDay
    if (idx >= 0 && idx < totalHours) counts[idx]++
  }

  const dayTotals = new Array<number>(numDays).fill(0)
  let maxCount = 1
  for (let i = 0; i < totalHours; i++) {
    const count = counts[i]
    if (count > 0) {
      dayTotals[Math.floor(i / 24)] += count
      if (count > maxCount) maxCount = count
    }
  }

  return { firstDay, numDays, totalHours, counts, dayTotals, maxCount }
}

// Round the y-axis ceiling to a clean number and emit evenly spaced ticks.
function niceCeil(value: number): number {
  if (value <= 6) return value
  if (value <= 10) return 10
  const pow = 10 ** Math.floor(Math.log10(value))
  const n = value / pow
  const nice = n <= 2 ? 2 : n <= 5 ? 5 : 10
  return nice * pow
}

function buildTicks(maxCount: number): number[] {
  const ceiling = niceCeil(maxCount)
  if (ceiling <= 6) {
    return Array.from({ length: ceiling + 1 }, (_, i) => i)
  }
  const raw = ceiling / 4
  const pow = 10 ** Math.floor(Math.log10(raw))
  const step =
    (raw / pow <= 1 ? 1 : raw / pow <= 2 ? 2 : raw / pow <= 5 ? 5 : 10) * pow
  const ticks: number[] = []
  for (let v = 0; v <= ceiling + 1e-9; v += step) {
    ticks.push(Math.round(v))
  }
  if (ticks[ticks.length - 1] !== ceiling) ticks.push(ceiling)
  return ticks
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

// An upward-growing bar with rounded top corners and a square baseline.
function topRoundedBarPath(
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): string {
  const radius = Math.max(0, Math.min(r, w / 2, h))
  if (h <= 0) return ''
  const right = x + w
  const bottom = y + h
  return [
    `M${x} ${bottom}`,
    `L${x} ${y + radius}`,
    `Q${x} ${y} ${x + radius} ${y}`,
    `L${right - radius} ${y}`,
    `Q${right} ${y} ${right} ${y + radius}`,
    `L${right} ${bottom}`,
    'Z',
  ].join(' ')
}

type Hover = { hour: number; left: number; top: number }

export default function BarksTimeline({
  events,
  unit = DEFAULT_UNIT,
}: {
  events: TimelineItem[]
  unit?: Unit
}) {
  const data = useMemo(() => bucketize(events), [events])
  const scrollRef = useRef<HTMLDivElement>(null)
  // "Stick to the end": true until the user scrolls away from the latest data,
  // so live refreshes keep the newest hours in view without yanking a reader
  // who has scrolled back through history.
  const stickToEndRef = useRef(true)
  const [hover, setHover] = useState<Hover | null>(null)

  const svgWidth = data ? data.totalHours * HOUR_PX : 0
  const ceiling = data ? niceCeil(data.maxCount) : 1
  const ticks = data ? buildTicks(data.maxCount) : [0, 1]
  const yOf = (value: number) =>
    PLOT_BOTTOM - (value / ceiling) * PLOT_H

  // Snap to the latest data whenever the time range grows, as long as the
  // reader hasn't scrolled away from the end.
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !data) return
    if (stickToEndRef.current) {
      el.scrollLeft = el.scrollWidth - el.clientWidth
    }
  }, [svgWidth, data])

  if (!data) return null

  const labeledHours = [0, 6, 12, 18]

  function enterHour(hour: number) {
    const el = scrollRef.current
    const scrollLeft = el?.scrollLeft ?? 0
    const viewportW = el?.clientWidth ?? svgWidth
    const slotCenter = hour * HOUR_PX + HOUR_PX / 2
    // Keep the tooltip inside the currently visible window (content coords).
    const left = Math.max(
      scrollLeft + 4,
      Math.min(slotCenter - TOOLTIP_W / 2, scrollLeft + viewportW - TOOLTIP_W - 4),
    )
    setHover({ hour, left, top: PLOT_TOP + 8 })
  }

  const hoveredCount = hover ? data.counts[hover.hour] : 0
  const hoveredDayIndex = hover ? Math.floor(hover.hour / 24) : 0
  const hoveredHourOfDay = hover ? hover.hour % 24 : 0
  const hoveredDate = hover
    ? new Date(data.firstDay + hoveredDayIndex * DAY_MS).toLocaleDateString(
        undefined,
        { weekday: 'short', month: 'short', day: 'numeric' },
      )
    : ''

  return (
    <div className="bt-root">
      <div style={{ display: 'flex', alignItems: 'flex-start' }}>
        {/* Fixed y-axis (does not scroll horizontally). */}
        <svg
          width={Y_AXIS_W}
          height={TOTAL_H}
          style={{ flex: '0 0 auto', overflow: 'visible' }}
          aria-hidden="true"
        >
          {ticks.map((tick) => (
            <text
              key={tick}
              x={Y_AXIS_W - 6}
              y={yOf(tick)}
              textAnchor="end"
              dominantBaseline="middle"
              fontSize={11}
              className="bt-axis"
            >
              {tick}
            </text>
          ))}
        </svg>

        <div
          ref={scrollRef}
          onScroll={() => {
            const el = scrollRef.current
            if (!el) return
            stickToEndRef.current =
              el.scrollLeft + el.clientWidth >= el.scrollWidth - 8
          }}
          style={{ overflowX: 'auto', flex: 1, minWidth: 0, position: 'relative' }}
        >
          <svg
            width={svgWidth}
            height={TOTAL_H}
            role="img"
            aria-label={`Number of ${unit.many} per hour`}
            onMouseLeave={() => setHover(null)}
            style={{ display: 'block' }}
          >
            <title>{`${unit.many[0].toUpperCase()}${unit.many.slice(1)} per hour`}</title>
            <desc>
              Bar chart of {unit.many} per hour from {data.numDays} day
              {data.numDays === 1 ? '' : 's'} of recordings.
            </desc>

            {/* Catch hover on empty hours so the tooltip clears when the
                pointer leaves a bar for open plot space. Sits behind marks. */}
            <rect
              x={0}
              y={0}
              width={svgWidth}
              height={TOTAL_H}
              fill="transparent"
              pointerEvents="all"
              onMouseEnter={() => setHover(null)}
            />

            {/* Day dividers (frame each 24h column). */}
            {Array.from({ length: data.numDays + 1 }, (_, d) => d * 24 * HOUR_PX).map(
              (x) => (
                <line
                  key={`divider-${x}`}
                  x1={x}
                  x2={x}
                  y1={4}
                  y2={PLOT_BOTTOM}
                  className="bt-divider"
                />
              ),
            )}

            {/* Horizontal gridlines. */}
            {ticks.map((tick) => (
              <line
                key={`grid-${tick}`}
                x1={0}
                x2={svgWidth}
                y1={yOf(tick)}
                y2={yOf(tick)}
                className={tick === 0 ? 'bt-baseline' : 'bt-grid'}
              />
            ))}

            {/* Day band: each day's total on a horizontal rule, date beneath. */}
            {data.dayTotals.map((total, d) => {
              const x0 = d * 24 * HOUR_PX
              const dayWidth = 24 * HOUR_PX
              const center = x0 + dayWidth / 2
              const label = `${total} ${total === 1 ? unit.one : unit.many}`
              // Leave a gap in the rule where the total sits.
              const gap = label.length * 6.4 + 12
              const date = new Date(data.firstDay + d * DAY_MS).toLocaleDateString(
                undefined,
                { weekday: 'short', month: 'short', day: 'numeric' },
              )
              return (
                <g key={`day-${d}`}>
                  <line
                    x1={x0 + 2}
                    x2={center - gap / 2}
                    y1={10}
                    y2={10}
                    className="bt-day-rule"
                  />
                  <line
                    x1={center + gap / 2}
                    x2={x0 + dayWidth - 2}
                    y1={10}
                    y2={10}
                    className="bt-day-rule"
                  />
                  <text
                    x={center}
                    y={10}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fontSize={11}
                    className="bt-day-total"
                  >
                    {label}
                  </text>
                  <text
                    x={center}
                    y={31}
                    textAnchor="middle"
                    fontSize={11}
                    className="bt-day-date"
                  >
                    {date}
                  </text>
                </g>
              )
            })}

            {/* Bars: one per hour that recorded at least one bark. */}
            {Array.from(data.counts.entries()).map(([hour, count]) => {
              if (count === 0) return null
              const barH = (count / ceiling) * PLOT_H
              const x = hour * HOUR_PX + 1
              const isHovered = hover?.hour === hour
              return (
                <path
                  key={`bar-${hour}`}
                  d={topRoundedBarPath(x, PLOT_BOTTOM - barH, HOUR_PX - 2, barH, 2)}
                  className={isHovered ? 'bt-bar bt-bar-hover' : 'bt-bar'}
                />
              )
            })}

            {/* X-axis: time labels at 00:00 / 06:00 / 12:00 / 18:00 per day. */}
            {data.dayTotals.map((_, d) => (
              <g key={`xaxis-${d}`}>
                {labeledHours.map((h) => {
                  const tickX = (d * 24 + h) * HOUR_PX
                  // Left-align the midnight label so it isn't clipped at the
                  // SVG's left edge; center the rest on their slot.
                  const anchorStart = h === 0
                  return (
                    <g key={`x-${d}-${h}`}>
                      <line
                        x1={tickX + HOUR_PX / 2}
                        x2={tickX + HOUR_PX / 2}
                        y1={PLOT_BOTTOM}
                        y2={PLOT_BOTTOM + 4}
                        className="bt-tick"
                      />
                      <text
                        x={anchorStart ? tickX : tickX + HOUR_PX / 2}
                        y={PLOT_BOTTOM + 16}
                        textAnchor={anchorStart ? 'start' : 'middle'}
                        fontSize={10}
                        className="bt-axis"
                      >
                        {`${pad2(h)}:00`}
                      </text>
                    </g>
                  )
                })}
              </g>
            ))}

            {/* Hover hit areas: the bar's slot, full plot height. */}
            {Array.from(data.counts.entries()).map(([hour, count]) => {
              if (count === 0) return null
              return (
                <rect
                  key={`hit-${hour}`}
                  x={hour * HOUR_PX}
                  y={PLOT_TOP}
                  width={HOUR_PX}
                  height={PLOT_H}
                  fill="transparent"
                  pointerEvents="all"
                  onMouseEnter={() => enterHour(hour)}
                />
              )
            })}
          </svg>

          {hover && (
            <div className="bt-tooltip" style={{ left: hover.left, top: hover.top }}>
              <div className="bt-tooltip-when">
                {hoveredDate} · {pad2(hoveredHourOfDay)}:00
              </div>
              <div className="bt-tooltip-count">
                {hoveredCount} {hoveredCount === 1 ? unit.one : unit.many}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
