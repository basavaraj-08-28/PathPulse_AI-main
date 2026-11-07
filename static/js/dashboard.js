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
  initDemoShowcase();
  // Auto-refresh stats every 30 seconds
  setInterval(loadStats, 30000);
});

// ═══════════════════════════════════════════════════════════════════
// ANIMATED FEATURE SHOWCASE
// ═══════════════════════════════════════════════════════════════════
function initDemoShowcase() {
  const slides = document.querySelectorAll('.demo-slide');
  const infos = document.querySelectorAll('.demo-info-card');
  const dots = document.querySelectorAll('.demo-dot');
  const progressFill = document.querySelector('.demo-progress-fill');
  if (!slides.length) return;

  let currentSlide = 0;
  const totalSlides = slides.length;
  const slideDuration = 5000; // 5 seconds per slide
  let timer = null;
  let progressStart = null;
  let rafId = null;

  function goToSlide(index) {
    slides.forEach(s => s.classList.remove('active'));
    infos.forEach(i => i.classList.remove('active'));
    dots.forEach(d => d.classList.remove('active'));

    currentSlide = index;
    slides[currentSlide].classList.add('active');
    infos[currentSlide].classList.add('active');
    dots[currentSlide].classList.add('active');

    // Trigger slide-specific animations
    if (currentSlide === 0) startWaveAnimation();
    if (currentSlide === 3) animateAdminCounters();

    // Restart progress bar
    startProgress();
  }

  function nextSlide() {
    goToSlide((currentSlide + 1) % totalSlides);
  }

  function startProgress() {
    if (rafId) cancelAnimationFrame(rafId);
    if (timer) clearTimeout(timer);
    progressStart = performance.now();

    function tick(now) {
      const elapsed = now - progressStart;
      const pct = Math.min(100, (elapsed / slideDuration) * 100);
      if (progressFill) progressFill.style.width = pct + '%';
      if (pct < 100) {
        rafId = requestAnimationFrame(tick);
      }
    }
    rafId = requestAnimationFrame(tick);
    timer = setTimeout(nextSlide, slideDuration);
  }

  // Click on progress dots
  dots.forEach(dot => {
    dot.addEventListener('click', () => {
      goToSlide(parseInt(dot.dataset.goto));
    });
  });

  // Start
  goToSlide(0);

  // Pause on hover
  const stage = document.querySelector('.demo-stage');
  if (stage) {
    stage.addEventListener('mouseenter', () => {
      if (timer) clearTimeout(timer);
      if (rafId) cancelAnimationFrame(rafId);
    });
    stage.addEventListener('mouseleave', () => {
      startProgress();
    });
  }

  // ── Slide 1: Accelerometer Wave Animation ──
  let waveAnimFrame = null;
  let waveData = [];
  const waveLen = 60;
  for (let i = 0; i < waveLen; i++) waveData.push(40);

  function startWaveAnimation() {
    if (waveAnimFrame) cancelAnimationFrame(waveAnimFrame);
    const svg = document.querySelector('.ds-wave-svg');
    const polyline = document.querySelector('.ds-wave-line');
    const magFill = document.querySelector('.ds-mag-fill');
    const magVal = document.querySelector('.ds-mag-val');
    const valX = document.querySelector('.ds-val-x');
    const valY = document.querySelector('.ds-val-y');
    const valZ = document.querySelector('.ds-val-z');
    const alertFlash = document.querySelector('.ds-alert-flash');
    if (!polyline) return;

    let frame = 0;
    let spikeAt = 90 + Math.floor(Math.random() * 40); // spike between frame 90-130
    let spiked = false;

    function tick() {
      frame++;
      // Normal gentle road vibration
      let dev = Math.abs(Math.sin(frame * 0.12) * 3 + (Math.random() - 0.5) * 2.5);

      // Generate a dramatic spike
      if (frame === spikeAt) {
        dev = 24 + Math.random() * 8; // high severity spike
        spiked = true;
        if (alertFlash) {
          alertFlash.style.display = 'block';
          setTimeout(() => { if (alertFlash) alertFlash.style.display = 'none'; }, 2200);
        }
      } else if (frame === spikeAt + 1) {
        dev = 14 + Math.random() * 5;
      } else if (frame === spikeAt + 2) {
        dev = 6 + Math.random() * 3;
      }

      // If we've gone well past the spike, reset for next cycle
      if (frame > spikeAt + 80) {
        frame = 0;
        spikeAt = 90 + Math.floor(Math.random() * 40);
        spiked = false;
      }

      waveData.push(40 - (dev / 35) * 36);
      if (waveData.length > waveLen) waveData.shift();

      // Build SVG points
      const w = 280;
      const pts = waveData.map((y, i) => `${(i / (waveLen - 1)) * w},${y}`).join(' ');
      polyline.setAttribute('points', pts);

      // Update values
      const magnitude = dev;
      const pct = Math.min(100, (magnitude / 35) * 100);
      if (magFill) {
        magFill.style.width = pct + '%';
        if (magnitude > 25) magFill.style.background = 'linear-gradient(90deg, #f59e0b, #ef4444)';
        else if (magnitude > 15) magFill.style.background = 'linear-gradient(90deg, #059669, #f59e0b)';
        else magFill.style.background = 'linear-gradient(90deg, #059669, #059669)';
      }
      if (magVal) magVal.textContent = magnitude.toFixed(1);
      if (valX) valX.textContent = (Math.sin(frame * 0.08) * 1.2 + (Math.random() - 0.5) * 0.3).toFixed(2);
      if (valY) valY.textContent = (Math.cos(frame * 0.06) * 0.8 + (Math.random() - 0.5) * 0.2).toFixed(2);
      if (valZ) valZ.textContent = (9.81 + (magnitude > 15 ? magnitude * 0.3 : (Math.random() - 0.5) * 0.15)).toFixed(2);

      if (currentSlide === 0) {
        waveAnimFrame = requestAnimationFrame(tick);
      }
    }
    waveAnimFrame = requestAnimationFrame(tick);
  }

  // ── Slide 4: Admin counter animation ──
  function animateAdminCounters() {
    const counters = document.querySelectorAll('.ds-counter');
    counters.forEach(el => {
      const target = parseInt(el.dataset.target) || 0;
      let current = 0;
      const step = Math.max(1, Math.ceil(target / 20));
      const interval = setInterval(() => {
        current += step;
        if (current >= target) { current = target; clearInterval(interval); }
        el.textContent = current;
      }, 50);
    });
  }
}
