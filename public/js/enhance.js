/* =========================================================================
   Files Fly — Enhancement Layer
   Defensive, additive: scroll-reveal + admin stat count-up.
   Respects prefers-reduced-motion. Zero changes to existing logic.
   ========================================================================= */
(function () {
  'use strict';

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* --- IntersectionObserver scroll-reveal (opt-in via .reveal) --- */
  if (!reduceMotion && 'IntersectionObserver' in window) {
    const reveal = (el) => {
      el.classList.add('reveal');
      const io = new IntersectionObserver((entries, obs) => {
        entries.forEach((e) => {
          if (e.isIntersecting) { e.target.classList.add('is-visible'); obs.unobserve(e.target); }
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -40px 0px' });
      io.observe(el);
    };
    document.querySelectorAll('.glass-card, .stat-card, .file-item, .info-card').forEach(reveal);
  }

  /* --- Count-up for admin stat-value nodes (digits + size strings) --- */
  function parseNum(str) {
    const n = parseFloat(String(str).replace(/[^\d.]/g, ''));
    return isNaN(n) ? null : n;
  }
  function countUp(el, target, suffix, isInt) {
    if (reduceMotion) { return; }
    const dur = 850, start = performance.now();
    const fmt = (v) => isInt ? Math.round(v).toLocaleString() : v.toFixed(1);
    const tick = (now) => {
      const p = Math.min((now - start) / dur, 1);
      const e = 1 - Math.pow(1 - p, 3); // easeOutCubic
      el.textContent = fmt(target * e) + (suffix || '');
      if (p < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // Watch the admin stats grid: when it's populated, animate the values.
  const grid = document.getElementById('stats-grid');
  if (grid && 'IntersectionObserver' in window) {
    const animateStats = () => {
      grid.querySelectorAll('.stat-value').forEach((el) => {
        if (el.dataset.ffAnimated) return;
        const raw = el.textContent.trim();
        const num = parseNum(raw);
        if (num === null || num <= 0) return;
        // Skip size strings like "12.4 MB" (has letters) — keep plain numbers only
        if (/[a-zA-Z]/.test(raw)) return;
        el.dataset.ffAnimated = '1';
        countUp(el, num, '', true);
      });
    };
    const mo = new MutationObserver(() => animateStats());
    mo.observe(grid, { childList: true, subtree: true });
    // Also trigger when scrolled into view
    new IntersectionObserver((entries, obs) => {
      entries.forEach((e) => { if (e.isIntersecting) { animateStats(); obs.disconnect(); } });
    }, { threshold: 0.1 }).observe(grid);
  }
})();
