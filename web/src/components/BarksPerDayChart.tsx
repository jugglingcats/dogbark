import 'chart.js/auto'
import { Bar } from 'react-chartjs-2'
import type { BarkEvent } from '../lib/csv'

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export default function BarksPerDayChart({ events }: { events: BarkEvent[] }) {
  const counts = new Map<string, number>()
  for (const event of events) {
    const key = localDayKey(new Date(event.startedAtUtc))
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  const labels = [...counts.keys()].sort()
  const data = labels.map((label) => counts.get(label) ?? 0)

  return (
    <div className="h-64">
      <Bar
        data={{ labels, datasets: [{ label: 'Barks', data, backgroundColor: '#aa3bff' }] }}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
          plugins: { legend: { display: false } },
        }}
      />
    </div>
  )
}
