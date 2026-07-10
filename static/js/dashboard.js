/**
 * PathPulse AI — Dashboard Stats Script
 */

let severityChartInstance = null;
let weeklyChartInstance = null;

async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const data = await res.json();
    if (data.stats) {
      animateCounter('stat-total', data.stats.total_reported);
      animateCounter('stat-active', data.stats.active_patholes);
      animateCounter('stat-resolved', data.stats.resolved);
      animateCounter('stat-high', data.stats.high_severity);
      
      // Render visual Chart.js widgets
      renderCharts(data.stats);
    }
  } catch (err) {
    console.error('Failed to load stats:', err);
  }
}

function renderCharts(stats) {
  // 1. Severity Distribution doughnut chart
  const sevCtx = document.getElementById('severity-chart');
  if (sevCtx) {
    const sevData = stats.severity_distribution || { low: 0, medium: 0, high: 0 };
    if (severityChartInstance) {
      severityChartInstance.destroy();
    }
    severityChartInstance = new Chart(sevCtx.getContext('2d'), {
      type: 'doughnut',
      data: {
        labels: ['Low Severity', 'Medium Severity', 'High Severity'],
        datasets: [{
          data: [sevData.low, sevData.medium, sevData.high],
          backgroundColor: ['#2563eb', '#f59e0b', '#ef4444'],
          borderWidth: 2,
          borderColor: '#ffffff'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#4b5563', font: { family: 'Inter', size: 11 } }
          }
        },
        cutout: '65%'
      }
    });
  }

  // 2. Weekly activity timeline bar chart
  const timelineCtx = document.getElementById('weekly-chart');
  if (timelineCtx) {
    const weeklyData = stats.weekly_timeline || { labels: [], data: [] };
    if (weeklyChartInstance) {
      weeklyChartInstance.destroy();
    }
    weeklyChartInstance = new Chart(timelineCtx.getContext('2d'), {
      type: 'bar',
      data: {
        labels: weeklyData.labels,
        datasets: [{
          label: 'Patholes Reported',
          data: weeklyData.data,
          backgroundColor: 'rgba(5, 150, 105, 0.85)',
          hoverBackgroundColor: '#059669',
          borderRadius: 6,
          borderWidth: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: '#4b5563', font: { family: 'Inter' } }
          },
          y: {
            grid: { color: 'rgba(0, 0, 0, 0.05)' },
            ticks: { stepSize: 1, color: '#4b5563', font: { family: 'Inter' } }
          }
        },
        plugins: {
          legend: { display: false }
        }
      }
    });
  }
}

function animateCounter(id, target) {
  const el = document.getElementById(id);
  if (!el) return;
  let current = 0;
  const step = Math.max(1, Math.ceil(target / 30));
  const interval = setInterval(() => {
    current += step;
    if (current >= target) {
      current = target;
      clearInterval(interval);
    }
    el.textContent = current;
  }, 30);
}

// Initial Load
document.addEventListener('DOMContentLoaded', () => {
    loadStats();
    // Auto-refresh stats every 30 seconds
    setInterval(loadStats, 30000);
});
