/* ============================================================================
   ui.js — behaviour shared by all four pages.

   Loaded in <head> and NOT deferred. Two things must happen before the browser
   paints anything:
     1. the `js` class lands on <html>, so the scroll-reveal CSS can hide
        elements — without it the site stays fully readable with JS switched off
     2. the saved theme is applied, so a dark-theme reader doesn't get a white
        flash on every page load

   Everything else waits for DOMContentLoaded.
   ============================================================================ */

(function () {
  'use strict';

  const THEME_KEY = 'hashline:theme';

  document.documentElement.classList.add('js');

  /* ------------------------------------------- theme, applied before paint */

  function savedTheme() {
    try {
      const t = localStorage.getItem(THEME_KEY);
      if (t === 'light' || t === 'dark') return t;
    } catch (err) { /* private mode; fall through */ }

    // Unlike a dashboard, this site is something you *read*, so it follows the
    // reader's own OS preference rather than forcing a house style.
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t);
    window.dispatchEvent(new CustomEvent('hl:theme', { detail: { theme: t } }));
  }

  applyTheme(savedTheme());

  /* ------------------------------------------------------------- on ready */

  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  ready(function () {

    /* ---- theme toggle ---- */
    const themeBtn = document.getElementById('themeBtn');
    if (themeBtn) {
      const label = function () {
        const dark = document.documentElement.getAttribute('data-theme') === 'dark';
        themeBtn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
        themeBtn.setAttribute('aria-pressed', String(dark));
      };
      label();
      themeBtn.addEventListener('click', function () {
        const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        label();
        try { localStorage.setItem(THEME_KEY, next); } catch (err) { /* fine */ }
      });
    }

    /* ---- the sidebar ----
       Above 1080px the rail is simply always visible and this code only wires
       up the animation; below that the same element slides in and the burger
       controls it. */
    const burger = document.getElementById('burger');
    const side = document.getElementById('side');
    const scrim = document.getElementById('scrim');
    const closeBtn = document.getElementById('sideClose');
    const wide = window.matchMedia('(min-width: 1080px)');

    if (burger && side && scrim) {
      const FOCUSABLE = 'a[href], button:not([disabled])';
      let isOpen = false;

      function setOpen(next) {
        if (wide.matches) return;          // nothing to open; it is always there
        isOpen = next;
        side.classList.toggle('is-open', next);
        scrim.classList.toggle('is-open', next);
        scrim.hidden = !next;
        burger.setAttribute('aria-expanded', String(next));
        document.body.style.overflow = next ? 'hidden' : '';
        if (next) {
          const first = side.querySelector(FOCUSABLE);
          if (first) first.focus();
        } else {
          burger.focus();
        }
      }

      burger.addEventListener('click', function () { setOpen(!isOpen); });
      scrim.addEventListener('click', function () { setOpen(false); });
      if (closeBtn) closeBtn.addEventListener('click', function () { setOpen(false); });
      side.addEventListener('click', function (e) { if (e.target.closest('a')) setOpen(false); });

      document.addEventListener('keydown', function (e) {
        if (!isOpen) return;
        if (e.key === 'Escape') { setOpen(false); return; }
        if (e.key === 'Tab') {
          const items = Array.prototype.slice.call(side.querySelectorAll(FOCUSABLE));
          if (!items.length) return;
          const first = items[0], last = items[items.length - 1];
          if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
          else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        }
      });

      // Crossing the breakpoint must never strand a half-open panel.
      const reset = function () {
        if (wide.matches) {
          isOpen = false;
          side.classList.remove('is-open');
          scrim.classList.remove('is-open');
          scrim.hidden = true;
          document.body.style.overflow = '';
          burger.setAttribute('aria-expanded', 'false');
        }
      };
      if (wide.addEventListener) wide.addEventListener('change', reset);
      else if (wide.addListener) wide.addListener(reset);
    }

    /* ---- the pill that glides between nav items ---- */
    const dnav = document.querySelector('.dnav');
    const pill = document.querySelector('.dnav__pill');

    if (dnav && pill) {
      const current = dnav.querySelector('a[aria-current="page"]');

      function moveTo(el) {
        if (!el) { pill.classList.remove('on'); return; }
        pill.style.height = el.offsetHeight + 'px';
        pill.style.transform = 'translateY(' + el.offsetTop + 'px)';
        pill.classList.add('on');
      }

      // Wait a frame so the fan-in animation has laid the items out first.
      requestAnimationFrame(function () { moveTo(current); });

      // The pill chases whatever you point at, then settles back on the page
      // you are actually reading. Cheap to do, and it makes the rail feel alive.
      dnav.querySelectorAll('a').forEach(function (a) {
        a.addEventListener('mouseenter', function () { moveTo(a); });
        a.addEventListener('focus', function () { moveTo(a); });
      });
      dnav.addEventListener('mouseleave', function () { moveTo(current); });
      dnav.addEventListener('focusout', function (e) {
        if (!dnav.contains(e.relatedTarget)) moveTo(current);
      });

      window.addEventListener('resize', function () { moveTo(current); }, { passive: true });
    }

    /* ---- "on this page": built from the document, tracked while scrolling ---- */
    const tocHost = document.getElementById('toc');
    let marks = [];

    if (tocHost) {
      const sections = Array.prototype.slice.call(document.querySelectorAll('main section'));

      sections.forEach(function (sec) {
        const h = sec.querySelector('h2');
        if (!h) return;

        // Give the section an id if the markup didn't, so the link has a target.
        if (!sec.id) {
          sec.id = h.textContent.trim().toLowerCase()
            .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
        }

        const a = document.createElement('a');
        a.href = '#' + sec.id;
        a.textContent = h.textContent.trim();
        tocHost.appendChild(a);
        marks.push({ el: sec, link: a });
      });

      if (!marks.length) {
        const wrap = tocHost.closest('[data-toc-wrap]');
        if (wrap) wrap.hidden = true;
      }
    }

    /* ---- one scroll handler drives the progress line and the section marks ---- */
    const sideEl = document.getElementById('side');

    function onScroll() {
      const doc = document.documentElement;
      const max = doc.scrollHeight - window.innerHeight;
      const pct = max > 0 ? Math.min(100, Math.max(0, (window.scrollY / max) * 100)) : 0;
      if (sideEl) sideEl.style.setProperty('--read', pct.toFixed(2) + '%');

      if (marks.length) {
        // The section whose top has most recently passed the reading line.
        const line = window.scrollY + 150;
        let active = marks[0];
        for (let i = 0; i < marks.length; i++) {
          if (marks[i].el.offsetTop <= line) active = marks[i];
        }
        marks.forEach(function (m) { m.link.classList.toggle('on', m === active); });
      }
    }

    let ticking = false;
    window.addEventListener('scroll', function () {
      // rAF-throttled: the handler reads layout, and running it on every raw
      // scroll event would force a reflow dozens of times a second.
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () { onScroll(); ticking = false; });
    }, { passive: true });
    window.addEventListener('resize', onScroll, { passive: true });
    onScroll();

    /* ---- sticky masthead gains a hairline once the page moves ---- */
    const masthead = document.querySelector('.masthead');
    if (masthead) {
      const stick = function () { masthead.classList.toggle('is-stuck', window.scrollY > 6); };
      stick();
      window.addEventListener('scroll', stick, { passive: true });
    }

    /* ---- scroll reveal ---- */
    const targets = document.querySelectorAll('.rise');
    if (!targets.length) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced || !('IntersectionObserver' in window)) {
      targets.forEach(function (el) { el.classList.add('in'); });
      return;
    }

    const io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in');
        io.unobserve(entry.target);
      });
    }, { rootMargin: '0px 0px -6% 0px', threshold: 0.06 });

    targets.forEach(function (el, i) {
      el.style.transitionDelay = (i % 3) * 70 + 'ms';
      io.observe(el);
    });

    // Safety net: reveal-on-scroll starts elements at opacity 0, so if the
    // observer ever fails the page would be permanently blank. Costs nothing
    // when it isn't needed.
    setTimeout(function () {
      document.querySelectorAll('.rise:not(.in)').forEach(function (el) {
        el.style.transitionDelay = '0ms';
        el.classList.add('in');
      });
    }, 4000);
  });
})();
