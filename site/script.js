/* memento-mcp · marketing site interactions */

(function () {
  'use strict';

  const root = document.documentElement;
  const toggle = document.getElementById('theme-toggle');
  const STORAGE_KEY = 'memento-theme';

  function getTheme() {
    return root.getAttribute('data-theme') || 'dark';
  }

  function setTheme(theme) {
    root.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch (e) {}
    if (toggle) {
      toggle.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false');
      toggle.setAttribute(
        'aria-label',
        theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme'
      );
    }
  }

  // initial sync (bootstrap script already set data-theme)
  setTheme(getTheme());

  if (toggle) {
    toggle.addEventListener('click', function () {
      setTheme(getTheme() === 'dark' ? 'light' : 'dark');
    });
  }

  // follow system preference until user picks
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    if (mq.addEventListener) {
      mq.addEventListener('change', function (e) {
        let saved = null;
        try {
          saved = localStorage.getItem(STORAGE_KEY);
        } catch (err) {}
        if (!saved) setTheme(e.matches ? 'dark' : 'light');
      });
    }
  }

  // sticky nav border on scroll
  const nav = document.querySelector('.nav');
  if (nav) {
    const onScroll = function () {
      if (window.scrollY > 8) nav.classList.add('scrolled');
      else nav.classList.remove('scrolled');
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  // copy buttons
  document.querySelectorAll('[data-copy]').forEach(function (btn) {
    btn.addEventListener('click', async function () {
      const text = btn.getAttribute('data-copy') || '';
      const label = btn.querySelector('.t-copy-label');
      const original = label ? label.textContent : null;
      try {
        await navigator.clipboard.writeText(text);
      } catch (e) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand('copy');
        } catch (err) {}
        document.body.removeChild(ta);
      }
      btn.classList.add('copied');
      if (label) label.textContent = 'copied';
      setTimeout(function () {
        btn.classList.remove('copied');
        if (label && original) label.textContent = original;
      }, 1400);
    });
  });

  // feature card spotlight follows cursor
  document.querySelectorAll('.feature').forEach(function (el) {
    el.addEventListener('mousemove', function (e) {
      const rect = el.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * 100;
      const y = ((e.clientY - rect.top) / rect.height) * 100;
      el.style.setProperty('--mx', x + '%');
      el.style.setProperty('--my', y + '%');
    });
  });

  // reveal on intersect
  if ('IntersectionObserver' in window) {
    const targets = document.querySelectorAll(
      '.card, .feature, .flow-node, .steps li, .checks li, .terminal, .snippet, .quote blockquote'
    );
    targets.forEach(function (t) { t.classList.add('reveal'); });
    const io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: '0px 0px -40px 0px' }
    );
    targets.forEach(function (t) { io.observe(t); });
  }

  // year stamp
  const y = document.getElementById('year');
  if (y) y.textContent = new Date().getFullYear();
})();
