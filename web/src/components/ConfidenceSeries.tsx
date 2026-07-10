import 'chart.js/auto'
import { Line } from 'react-chartjs-2'
import type { BarkEvent } from '../lib/csv'

export default function ConfidenceSeries({ events }: { events: BarkEvent[] }) {
  const chronological = [...events].sort((a, b) =>
    a.startedAtUtc.localeCompare(b.startedAtUtc),
  )

  const labels = chronological.map((event) =>
    new Date(event.startedAtUtc).toLocaleString(),
  )
  const data = chronological.map((event) => event.peakConfidence)

  return (
    <div className="h-64">
      <Line
        data={{
          labels,
          datasets: [
            {
              label: 'Peak confidence',
              data,
              borderColor: '#aa3bff',
              backgroundColor: 'rgba(170, 59, 255, 0.15)',
              pointRadius: 2,
              tension: 0.25,
            },
          ],
        }}
        options={{
          responsive: true,
          maintainAspectRatio: false,
          scales: { y: { min: 0, max: 1 } },
          plugins: { legend: { display: false } },
        }}
      />
    </div>
  )
}
