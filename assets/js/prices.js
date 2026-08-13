/* ============================================================================
   prices.js — live crypto prices from the CoinGecko public API.

   No key, no backend, no account. One request returns everything the board
   needs, including a 7-day series for the trend lines:

     /coins/markets?vs_currency=usd&ids=bitcoin,ethereum,…&sparkline=true

   If that endpoint fails for any reason OTHER than rate limiting, we drop to
   the simpler /simple/price and show prices without trend lines. On a 429 we
   deliberately do not retry: the whole host is throttling this browser, so a
   second request fails the same way and spends another call. We say so
   instead.

   Formatting and sparkline geometry live in core.js so they can be unit
   tested; this file is only fetching and DOM.
   ============================================================================ */

(function () {
  'use strict';

  const HL = window.HL;

  const API = 'https://api.coingecko.com/api/v3';
  const MANUAL_COOLDOWN = 10000;    // free tier is throttled; be a good citizen
  const AUTO_EVERY = 60000;
  const CACHE_TTL = 45000;
  const STORE = 'hashline:prices';

  const DEFAULTS = ['bitcoin', 'ethereum', 'solana', 'cardano'];

  const FIAT = {
    usd: { code: 'USD', locale: 'en-US' },
    inr: { code: 'INR', locale: 'en-IN' },
    gbp: { code: 'GBP', locale: 'en-GB' }
  };

  const grid = document.getElementById('coinGrid');
  const statusEl = document.getElementById('status');
  const alertEl = document.getElementById('alert');
  const refreshBtn = document.getElementById('refreshBtn');
  const addBtn = document.getElementById('addBtn');
  const searchEl = document.getElementById('search');
  const fiatSeg = document.getElementById('fiatSeg');
  const autoEl = document.getElementById('auto');

  const sTracked = document.getElementById('sTracked');
  const sCap = document.getElementById('sCap');
  const sUp = document.getElementById('sUp');
  const sBest = document.getElementById('sBest');

  let ids = DEFAULTS.slice();
  let fiat = 'usd';
  let lastFetch = 0;
  let autoTimer = null;
  let cooldownTimer = null;
  let previous = {};        // id -> last price, so we only flash real movement

  /* ------------------------------------------------------------- storage */

  function loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem(STORE) || '{}');
      if (Array.isArray(p.ids) && p.ids.length) ids = p.ids;
      if (FIAT[p.fiat]) fiat = p.fiat;
      if (p.auto) autoEl.checked = true;
    } catch (err) { /* defaults are fine */ }
  }

  function savePrefs() {
    try {
      localStorage.setItem(STORE, JSON.stringify({ ids: ids, fiat: fiat, auto: autoEl.checked }));
    } catch (err) { /* storage unavailable; page still works */ }
  }

  function cacheKey() { return STORE + ':c:' + fiat + ':' + ids.slice().sort().join(','); }

  function readCache() {
    try {
      const raw = sessionStorage.getItem(cacheKey());
      if (!raw) return null;
      const e = JSON.parse(raw);
      if (!e || Date.now() - e.at > CACHE_TTL) return null;
      return e.coins;
    } catch (err) { return null; }
  }

  function writeCache(coins) {
    try { sessionStorage.setItem(cacheKey(), JSON.stringify({ at: Date.now(), coins: coins })); }
    catch (err) { /* fine */ }
  }

  /* -------------------------------------------------------------- notices */

  function notice(msg, bad) {
    alertEl.innerHTML = '<div class="callout' + (bad ? ' callout--broken' : '') + '">' +
      HL.escapeHtml(msg) + '</div>';
  }
  function clearNotice() { alertEl.innerHTML = ''; }

  /* --------------------------------------------------------------- render */

  function sparkline(series, up) {
    const W = 240, H = 42;
    const pts = HL.trendPoints(series, W, H, 3);
    if (!pts.length) return '';
    const stroke = up ? 'var(--linked)' : 'var(--broken)';
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
      '<polyline fill="none" stroke="' + stroke + '" stroke-width="1.6" ' +
      'stroke-linejoin="round" points="' + pts.join(' ') + '"></polyline></svg>';
  }

  function card(c) {
    const up = (c.change || 0) >= 0;
    const loc = FIAT[fiat].locale;

    const img = c.image
      ? '<img class="coin__img" src="' + HL.escapeHtml(c.image) + '" alt="" loading="lazy" />'
      : '<span class="coin__img"></span>';

    const rank = c.rank ? '<span class="coin__rank">#' + c.rank + '</span>' : '';

    return '<article class="coin">' +
      '<div class="coin__top">' + img +
        '<div><div class="coin__name">' + HL.escapeHtml(c.name) + '</div>' +
        '<div class="coin__tic">' + HL.escapeHtml((c.symbol || '').toUpperCase()) + '</div></div>' +
        rank +
      '</div>' +
      '<div class="coin__price">' + HL.money(c.price, FIAT[fiat].code, loc) + '</div>' +
      '<div class="coin__chg ' + (up ? 'up' : 'down') + '">' +
        '<span aria-hidden="true">' + (up ? '▲' : '▼') + '</span> ' + HL.percent(c.change) +
        ' <span style="color:var(--faint)">24h</span></div>' +
      '<div class="coin__spark">' + sparkline(c.series, up) + '</div>' +
      '<div class="coin__foot"><span>MCAP ' + HL.compact(c.cap, FIAT[fiat].code, loc) + '</span>' +
        '<button class="coin__drop" type="button" data-drop="' + HL.escapeHtml(c.id) + '">REMOVE</button>' +
      '</div></article>';
  }

  function summarise(coins) {
    if (!coins.length) {
      sTracked.textContent = '0'; sCap.textContent = '—';
      sUp.textContent = '—'; sBest.textContent = '—';
      return;
    }
    const cap = coins.reduce(function (t, c) { return t + (c.cap || 0); }, 0);
    const up = coins.filter(function (c) { return (c.change || 0) >= 0; }).length;
    const best = coins.reduce(function (a, b) { return (b.change || 0) > (a.change || 0) ? b : a; });

    sTracked.textContent = String(coins.length);
    sCap.textContent = HL.compact(cap, FIAT[fiat].code, FIAT[fiat].locale);
    sUp.textContent = up + ' / ' + coins.length;
    sBest.textContent = (best.symbol || '').toUpperCase() + ' ' + HL.percent(best.change || 0);
  }

  function render(coins) {
    grid.setAttribute('aria-busy', 'false');

    if (!coins.length) {
      grid.innerHTML = '<div class="callout">No coins on the board. Add one with the search box above.</div>';
      summarise([]);
      return;
    }

    coins.sort(function (a, b) { return (b.cap || 0) - (a.cap || 0); });
    grid.innerHTML = coins.map(card).join('');
    summarise(coins);
    coins.forEach(function (c) { previous[c.id] = c.price; });
  }

  function ghosts(n) {
    let h = '';
    for (let i = 0; i < n; i++) h += '<div class="ghost"></div>';
    grid.innerHTML = h;
  }

  /* -------------------------------------------------------------- fetching */

  function httpError(where, status) {
    const e = new Error(where + ' ' + status);
    e.status = status;
    return e;
  }

  async function fetchMarkets(list) {
    const url = API + '/coins/markets?vs_currency=' + fiat + '&ids=' + list.join(',') +
                '&sparkline=true&price_change_percentage=24h';
    const res = await fetch(url);
    if (!res.ok) throw httpError('markets', res.status);
    const rows = await res.json();

    return rows.map(function (r) {
      return {
        id: r.id, name: r.name, symbol: r.symbol, image: r.image,
        rank: r.market_cap_rank, price: r.current_price,
        change: r.price_change_percentage_24h, cap: r.market_cap,
        series: r.sparkline_in_7d ? r.sparkline_in_7d.price : null
      };
    });
  }

  async function fetchSimple(list) {
    const url = API + '/simple/price?ids=' + list.join(',') + '&vs_currencies=' + fiat +
                '&include_24hr_change=true&include_market_cap=true';
    const res = await fetch(url);
    if (!res.ok) throw httpError('simple', res.status);
    const data = await res.json();

    return list.filter(function (id) { return data[id]; }).map(function (id) {
      return {
        id: id,
        name: id.charAt(0).toUpperCase() + id.slice(1),
        symbol: id.slice(0, 4), image: null, rank: null,
        price: data[id][fiat],
        change: data[id][fiat + '_24h_change'],
        cap: data[id][fiat + '_market_cap'],
        series: null
      };
    });
  }

  async function load(force) {
    const now = Date.now();

    if (!force && now - lastFetch < MANUAL_COOLDOWN) {
      const wait = Math.ceil((MANUAL_COOLDOWN - (now - lastFetch)) / 1000);
      const was = statusEl.textContent;
      statusEl.textContent = 'wait ' + wait + 's';
      clearTimeout(cooldownTimer);
      cooldownTimer = setTimeout(function () { statusEl.textContent = was; }, wait * 1000);
      return;
    }

    if (!ids.length) { render([]); statusEl.textContent = ''; return; }

    // A warm cache means a reload or a page-to-page navigation costs nothing.
    if (!force && !grid.querySelector('.coin')) {
      const hit = readCache();
      if (hit && hit.length) {
        render(hit);
        statusEl.textContent = 'cached · ' + FIAT[fiat].code;
        return;
      }
    }

    lastFetch = now;
    refreshBtn.disabled = true;
    grid.setAttribute('aria-busy', 'true');
    statusEl.textContent = 'fetching…';
    if (!grid.querySelector('.coin')) ghosts(ids.length || 4);

    try {
      let coins;
      try {
        coins = await fetchMarkets(ids);
      } catch (first) {
        if (first.status === 429) throw first;   // fallback would hit the same wall
        coins = await fetchSimple(ids);
        notice('Trend lines are unavailable right now — showing prices from the simpler endpoint.', false);
      }

      render(coins);
      writeCache(coins);
      statusEl.textContent = 'updated ' + new Date().toLocaleTimeString() + ' · ' + FIAT[fiat].code;
      if (grid.querySelector('.coin')) clearNotice();

    } catch (err) {
      grid.setAttribute('aria-busy', 'false');
      if (!grid.querySelector('.coin')) grid.innerHTML = '';
      statusEl.textContent = err.status === 429 ? 'rate limited' : 'failed';
      notice(err.status === 429
        ? 'CoinGecko is rate-limiting this browser (HTTP 429). The free tier allows only a handful of calls a minute — wait about sixty seconds, then refresh.'
        : 'Could not reach CoinGecko. Check your connection and try again. (' + err.message + ')',
        true);
    } finally {
      refreshBtn.disabled = false;
    }
  }

  /* ---------------------------------------------------------- add a coin */

  async function addCoin() {
    const q = searchEl.value.trim();
    if (!q) return;

    addBtn.disabled = true;
    statusEl.textContent = 'searching…';

    try {
      const res = await fetch(API + '/search?query=' + encodeURIComponent(q));
      if (!res.ok) throw httpError('search', res.status);
      const data = await res.json();

      if (!data.coins || !data.coins.length) {
        notice('No coin called "' + q + '" on CoinGecko. Try the full name, like "polygon".', true);
        statusEl.textContent = '';
        return;
      }

      const hit = data.coins[0];
      if (ids.indexOf(hit.id) !== -1) {
        notice(hit.name + ' is already on the board.', false);
        statusEl.textContent = '';
        return;
      }

      ids.push(hit.id);
      savePrefs();
      clearNotice();
      searchEl.value = '';
      await load(true);

    } catch (err) {
      notice('Search failed: ' + err.message, true);
    } finally {
      addBtn.disabled = false;
    }
  }

  /* ------------------------------------------------------------- wiring */

  // Delegated once, so re-rendering the board can never stack up listeners.
  grid.addEventListener('click', function (e) {
    const btn = e.target.closest('[data-drop]');
    if (!btn) return;
    ids = ids.filter(function (id) { return id !== btn.dataset.drop; });
    savePrefs();
    load(true);
  });

  refreshBtn.addEventListener('click', function () { load(false); });
  addBtn.addEventListener('click', addCoin);
  searchEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') addCoin(); });

  fiatSeg.addEventListener('click', function (e) {
    const b = e.target.closest('[data-fiat]');
    if (!b || b.dataset.fiat === fiat) return;
    fiat = b.dataset.fiat;
    fiatSeg.querySelectorAll('[data-fiat]').forEach(function (x) { x.classList.toggle('on', x === b); });
    previous = {};                 // prices are in a new unit; old ones aren't comparable
    savePrefs();
    load(true);                    // a currency change must never hit the cooldown
  });

  function syncAuto() {
    if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
    if (autoEl.checked) autoTimer = setInterval(function () { load(true); }, AUTO_EVERY);
    savePrefs();
  }
  autoEl.addEventListener('change', syncAuto);

  // A background tab should not keep polling a rate-limited free API.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { clearInterval(autoTimer); autoTimer = null; }
    else if (autoEl.checked && !autoTimer) { syncAuto(); load(false); }
  });

  /* ---------------------------------------------------------------- boot */

  loadPrefs();
  fiatSeg.querySelectorAll('[data-fiat]').forEach(function (b) {
    b.classList.toggle('on', b.dataset.fiat === fiat);
  });
  syncAuto();
  load(false);
})();
