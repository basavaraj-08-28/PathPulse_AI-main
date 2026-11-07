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
        animation: {
          animateScale: true,
          animateRotate: true,
          duration: 1300,
          easing: 'easeOutQuart'
        },
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
        animation: {
          duration: 1100,
          easing: 'easeOutQuart'
        },
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
      // Tactile counter pop when target is reached
      el.classList.remove('counter-pop');
      void el.offsetWidth;
      el.classList.add('counter-pop');
    }
    el.textContent = current;
  }, 30);
}

// ── Interactive 3D Parallax Card Tilt ──────────────────────────────
function init3DCardTilt() {
  const cards = document.querySelectorAll('.stat-card, .chart-card, .step-card');
  cards.forEach(card => {
    card.addEventListener('mousemove', (e) => {
      const rect = card.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const rotateX = ((y - centerY) / centerY) * -6;
      const rotateY = ((x - centerX) / centerX) * 6;
      card.style.transform = `perspective(1000px) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg) translateY(-6px)`;
    });
    card.addEventListener('mouseleave', () => {
      card.style.transform = '';
    });
  });
}

// ── Smooth Scroll Reveal ──────────────────────────────────────────
function initScrollReveal() {
  if (!('IntersectionObserver' in window)) return;
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('revealed');
        observer.unobserve(entry.target);
      }
    });
  }, { threshold: 0.1 });

  const targets = document.querySelectorAll('.stat-card, .chart-card, .step-card, .how-it-works h3');
  targets.forEach((el, index) => {
    el.classList.add('reveal-on-scroll');
    el.style.transitionDelay = `${(index % 4) * 0.08}s`;
    observer.observe(el);
  });
}

// Initial Load
document.addEventListener('DOMContentLoaded', () => {
  loadStats();
  init3DCardTilt();
  initScrollReveal();
  // Auto-refresh stats every 30 seconds
  setInterval(loadStats, 30000);
});
