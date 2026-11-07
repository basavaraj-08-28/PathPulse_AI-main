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
  init3DBackgroundParallax();
  initScrollReveal();
  initDemoShowcase();
  // Auto-refresh stats every 30 seconds
  setInterval(loadStats, 30000);
});

// ── 3D Background Parallax Mouse Motion ────────────────────────────
function init3DBackgroundParallax() {
  const bgImg = document.querySelector('.bg-3d-image');
  if (!bgImg) return;

  // Real-time smooth 3D parallax on devices with a mouse or trackpad
  if (window.matchMedia('(pointer: fine)').matches) {
    let mouseX = 0;
    let mouseY = 0;
    let currentX = 0;
    let currentY = 0;
    let isMoving = false;

    window.addEventListener('mousemove', (e) => {
      mouseX = (e.clientX / window.innerWidth) - 0.5;
      mouseY = (e.clientY / window.innerHeight) - 0.5;

      if (!isMoving) {
        isMoving = true;
        requestAnimationFrame(() => {
          currentX += (mouseX - currentX) * 0.1;
          currentY += (mouseY - currentY) * 0.1;

          const rotY = currentX * 6.5;
          const rotX = -currentY * 4.5;
          const transX = currentX * -22;
          const transY = currentY * -16;

          bgImg.style.transform = `scale(1.06) rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg) translate3d(${transX.toFixed(1)}px, ${transY.toFixed(1)}px, 0)`;
          isMoving = false;
        });
      }
    }, { passive: true });
  }
}

// ═══════════════════════════════════════════════════════════════════
// ANIMATED FEATURE SHOWCASE (Scroll-Triggered Auto-Play)
// ═══════════════════════════════════════════════════════════════════
function initDemoShowcase() {
  const showcaseSection = document.getElementById('demo-showcase');
  const slides = document.querySelectorAll('.demo-slide');
  const infos = document.querySelectorAll('.demo-info-card');
  const dots = document.querySelectorAll('.demo-dot');
  const progressFill = document.querySelector('.demo-progress-fill');
  if (!slides.length || !showcaseSection) return;

  let currentSlide = 0;
  const totalSlides = slides.length;
  const slideDuration = 5500; // 5.5 seconds per slide
  let timer = null;
  let progressStart = null;
  let rafId = null;
  let waveAnimFrame = null;
  let isRunning = false;

  function goToSlide(index) {
    slides.forEach(s => s.classList.remove('active'));
    infos.forEach(i => i.classList.remove('active'));
    dots.forEach(d => d.classList.remove('active'));

    currentSlide = index;
    slides[currentSlide].classList.add('active');
    infos[currentSlide].classList.add('active');
    dots[currentSlide].classList.add('active');

    // Trigger slide-specific animations
    if (currentSlide === 0) {
      startWaveAnimation();
    } else if (waveAnimFrame) {
      cancelAnimationFrame(waveAnimFrame);
      waveAnimFrame = null;
    }

    if (currentSlide === 3) {
      animateAdminCounters();
    }

    // Always run progress and cycle
    startProgress();
  }

  function nextSlide() {
    // If element is off-screen, retry in 1s without killing the slider
    if (!isElementInViewport(showcaseSection)) {
      timer = setTimeout(nextSlide, 1000);
      return;
    }
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

  // Click on dots: immediate jump, then auto-play continues
  dots.forEach(dot => {
    dot.addEventListener('click', () => {
      goToSlide(parseInt(dot.dataset.goto));
    });
  });

  // Check if showcase is in or near viewport
  function isElementInViewport(el) {
    const rect = el.getBoundingClientRect();
    const windowHeight = (window.innerHeight || document.documentElement.clientHeight);
    return (rect.top <= windowHeight * 0.9 && rect.bottom >= windowHeight * 0.1);
  }

  // ── Slide 1: Accelerometer Wave Animation ──
  const waveLen = 60;
  let waveData = [];

  function startWaveAnimation() {
    if (waveAnimFrame) cancelAnimationFrame(waveAnimFrame);
    const polyline = document.querySelector('.ds-wave-line');
    const magFill = document.querySelector('.ds-mag-fill');
    const magVal = document.querySelector('.ds-mag-val');
    const valX = document.querySelector('.ds-val-x');
    const valY = document.querySelector('.ds-val-y');
    const valZ = document.querySelector('.ds-val-z');
    const alertFlash = document.getElementById('ds-alert-flash') || document.querySelector('.ds-alert-flash');
    const logMed = document.getElementById('ds-log-med');
    const logHigh = document.getElementById('ds-log-high');
    if (!polyline) return;

    waveData = [];
    for (let i = 0; i < waveLen; i++) waveData.push(40);

    let frame = 0;
    let medSpikeAt = 35;   // Event 1: Medium severity impact at ~0.6s
    let highSpikeAt = 110; // Event 2: High severity crater impact at ~1.9s
    let medTriggered = false;
    let highTriggered = false;

    if (alertFlash) alertFlash.style.display = 'none';
    if (logMed) logMed.classList.remove('visible');
    if (logHigh) logHigh.classList.remove('visible');

    function tick() {
      if (currentSlide !== 0) {
        if (waveAnimFrame) cancelAnimationFrame(waveAnimFrame);
        return;
      }

      frame++;
      let dev = Math.abs(Math.sin(frame * 0.14) * 3.0 + (Math.random() - 0.5) * 2.0);

      // Event 1: MEDIUM Severity Pothole (18 - 22 m/s²)
      if (frame >= medSpikeAt && frame <= medSpikeAt + 4) {
        dev = 19.4 + Math.random() * 2.6;
        if (!medTriggered) {
          medTriggered = true;
          if (alertFlash) {
            alertFlash.className = 'ds-alert-flash alert-med';
            alertFlash.innerHTML = '🟡 POTHOLE DETECTED &mdash; <b>MEDIUM</b> (19.4 m/s&sup2;)';
            alertFlash.style.display = 'block';
          }
          if (logMed) logMed.classList.add('visible');
        }
      } else if (frame > medSpikeAt + 4 && frame <= medSpikeAt + 8) {
        dev = 11 + Math.random() * 3;
      } else if (frame > medSpikeAt + 8 && frame <= medSpikeAt + 12) {
        dev = 6 + Math.random() * 2;
      } else if (frame === medSpikeAt + 38) {
        // Brief settle between the two potholes
        if (alertFlash) alertFlash.style.display = 'none';
      }

      // Event 2: HIGH Severity Crater (27 - 33 m/s²)
      if (frame >= highSpikeAt && frame <= highSpikeAt + 4) {
        dev = 28.6 + Math.random() * 3.8;
        if (!highTriggered) {
          highTriggered = true;
          if (alertFlash) {
            alertFlash.className = 'ds-alert-flash alert-high';
            alertFlash.innerHTML = '🚨 POTHOLE DETECTED &mdash; <b>HIGH</b> (28.6 m/s&sup2;)';
            alertFlash.style.display = 'block';
          }
          if (logHigh) logHigh.classList.add('visible');
        }
      } else if (frame > highSpikeAt + 4 && frame <= highSpikeAt + 8) {
        dev = 16 + Math.random() * 4;
      } else if (frame > highSpikeAt + 8 && frame <= highSpikeAt + 14) {
        dev = 7 + Math.random() * 3;
      }

      waveData.push(40 - (dev / 35) * 36);
      if (waveData.length > waveLen) waveData.shift();

      const w = 280;
      const pts = waveData.map((y, i) => `${(i / (waveLen - 1)) * w},${y.toFixed(1)}`).join(' ');
      polyline.setAttribute('points', pts);

      const magnitude = dev;
      const pct = Math.min(100, (magnitude / 35) * 100);
      if (magFill) {
        magFill.style.width = pct + '%';
        if (magnitude >= 25) magFill.style.background = 'linear-gradient(90deg, #f59e0b, #ef4444)';
        else if (magnitude >= 15) magFill.style.background = 'linear-gradient(90deg, #059669, #f59e0b)';
        else magFill.style.background = 'linear-gradient(90deg, #059669, #059669)';
      }
      if (magVal) magVal.textContent = magnitude.toFixed(1);
      if (valX) valX.textContent = (Math.sin(frame * 0.08) * 1.2 + (Math.random() - 0.5) * 0.3).toFixed(2);
      if (valY) valY.textContent = (Math.cos(frame * 0.06) * 0.8 + (Math.random() - 0.5) * 0.2).toFixed(2);
      if (valZ) valZ.textContent = (9.81 + (magnitude > 15 ? magnitude * 0.35 : (Math.random() - 0.5) * 0.15)).toFixed(2);

      waveAnimFrame = requestAnimationFrame(tick);
    }
    waveAnimFrame = requestAnimationFrame(tick);
  }

  // ── Slide 4: Admin Counter Animation ──
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

  // ── Scroll & Visibility Trigger ──
  function checkAndStart() {
    if (isElementInViewport(showcaseSection)) {
      if (!isRunning) {
        isRunning = true;
        // Start on Slide 1 automatically!
        goToSlide(0);
      }
    }
  }

  // Immediate check on load (in case user refreshed while scrolled down)
  checkAndStart();

  // Window scroll and resize listeners (guaranteed on all mobile browsers)
  window.addEventListener('scroll', checkAndStart, { passive: true });
  window.addEventListener('resize', checkAndStart, { passive: true });

  // IntersectionObserver as secondary trigger
  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          checkAndStart();
        }
      });
    }, { rootMargin: '80px 0px 80px 0px', threshold: 0.05 });
    observer.observe(showcaseSection);
  }
}
