/* ============================================================================
   chain.js — the reusable hash-linked chain component.

   One component, three modes, used on two pages:

     home page      mode: 'demo'   — edit any block's data, watch the cascade.
                                     No mining; hashes recompute instantly so
                                     the *linking* is the only lesson.
     simulator page mode: 'full'   — mining, difficulty, add/remove blocks.
     concepts page  mode: 'static' — a frozen three-block diagram.

   Writing it once and parameterising it is the whole reason the landing page
   and the simulator feel like the same idea at two depths, rather than two
   unrelated widgets that happen to be in the same repo.

   Hashing uses the Web Crypto API (real SHA-256) when the page is served over
   http(s), and falls back to HL.weakHash otherwise. The component reports
   which engine is live; it never pretends a toy hash is SHA-256.
   ============================================================================ */

(function () {
  'use strict';

  const HL = window.HL;

  const CAN_SUBTLE = !!(window.crypto && window.crypto.subtle);

  /** Real SHA-256, hex encoded. */
  async function sha256(text) {
    const bytes = new TextEncoder().encode(text);
    const digest = await window.crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest))
      .map(function (b) { return b.toString(16).padStart(2, '0'); })
      .join('');
  }

  function hash(text) {
    return CAN_SUBTLE ? sha256(text) : Promise.resolve(HL.weakHash(text));
  }

  const ENGINE = CAN_SUBTLE ? 'SHA-256 · Web Crypto' : 'fallback hash · SHA-256 unavailable here';

  /* --------------------------------------------------------------- markup */

  function blockMarkup(b, opts) {
    const editable = opts.mode !== 'static';

    const dataField = editable
      ? '<input class="input" data-role="data" type="text" value="" ' +
        'aria-label="Data in block ' + b.index + '" />'
      : '<div class="field__v field__v--data" data-role="dataText"></div>';

    const nonceField = opts.mode === 'full'
      ? '<div class="field">' +
          '<span class="field__k">Nonce</span>' +
          '<input class="input" data-role="nonce" type="number" min="0" value="0" ' +
          'aria-label="Nonce for block ' + b.index + '" />' +
        '</div>'
      : '';

    const mineBtn = opts.mode === 'full'
      ? '<button class="btn btn--sm" type="button" data-role="mine">Mine block</button>'
      : '';

    return (
      '<div class="blk__top">' +
        '<span class="blk__n">Block <b>#' + b.index + '</b></span>' +
        '<span class="tag tag--broken" data-role="tag">not mined</span>' +
      '</div>' +

      '<div class="field">' +
        '<span class="field__k">Data</span>' +
        dataField +
      '</div>' +

      nonceField +

      '<div class="field">' +
        '<span class="field__k">Previous hash</span>' +
        '<div class="field__v field__v--prev" data-role="prev"></div>' +
      '</div>' +

      '<div class="field">' +
        '<span class="field__k">This block’s hash</span>' +
        '<div class="field__v field__v--hash" data-role="hash"></div>' +
      '</div>' +

      (mineBtn ? '<div style="margin-top:12px;display:flex;gap:10px;align-items:center;flex-wrap:wrap">' +
        mineBtn + '<span class="note" data-role="tries"></span></div>' : '')
    );
  }

  /* ------------------------------------------------------------ component */

  /**
   * @param {HTMLElement} host      container to render into
   * @param {Object} opts
   *   mode        'demo' | 'full' | 'static'
   *   seed        array of data strings for the initial blocks
   *   difficulty  leading zeros required (default 2, ignored in 'demo')
   *   onState     callback({ broken, damage, total }) after every recompute
   */
  function createChain(host, opts) {
    opts = opts || {};
    const mode = opts.mode || 'demo';
    // In demo mode nothing is mined, so the target is zero zeros: a block is
    // "mined" as soon as its prev pointer is correct. That keeps the landing
    // page about linking, not about proof of work.
    let difficulty = mode === 'demo' ? 0 : (opts.difficulty || 2);

    const seed = opts.seed || ['Ada pays Grace 3 ETH', 'Grace pays Linus 1 ETH', 'Linus pays Ada 0.5 ETH'];
    const MIN = 2;
    const MAX = 6;

    let blocks = seed.map(function (d, i) { return HL.makeBlock(i + 1, d, i === 0 ? HL.GENESIS : ''); });
    let views = [];
    let busy = false;

    /* ---------- the two passes that make the cascade real ---------- */

    /**
     * refresh() — recompute each block's OWN hash from the fields it stores.
     *
     * Critically, this does NOT touch `prev`. A block's previous-hash field is
     * *stored data*, copied in at the moment the block was mined. If we
     * recalculated it here, editing an early block would silently re-link the
     * chain behind us and nothing would ever look broken — which is exactly
     * the bug the browser test caught. Leaving `prev` alone is what lets the
     * stored value go stale, and a stale prev IS the broken link.
     */
    async function refresh() {
      for (let i = 0; i < blocks.length; i++) {
        blocks[i].hash = await hash(HL.commitment(blocks[i]));
      }
      paint();
    }

    /**
     * relink() — establish a valid chain from scratch.
     *
     * Used only when the chain's *shape* changes (first render, reset, adding
     * or removing a block), never in response to an edit. Walks forward,
     * copying each block's hash into the next block's prev field, exactly as
     * mining a real block would.
     */
    async function relink() {
      for (let i = 0; i < blocks.length; i++) {
        blocks[i].prev = i === 0 ? HL.GENESIS : blocks[i - 1].hash;
        blocks[i].hash = await hash(HL.commitment(blocks[i]));
      }
      paint();
    }

    /* ---------- build DOM once, then only mutate text ---------- */

    function build() {
      host.innerHTML = '';
      views = [];

      blocks.forEach(function (b, i) {
        if (i > 0) {
          const link = document.createElement('div');
          link.className = 'link';
          link.setAttribute('aria-hidden', 'true');
          link.innerHTML = '<span class="link__dot">' + (CAN_SUBTLE ? '#' : '~') + '</span>';
          host.appendChild(link);
        }

        const el = document.createElement('article');
        el.className = 'blk';
        el.innerHTML = blockMarkup(b, { mode: mode });
        host.appendChild(el);

        const v = {
          el: el,
          link: i > 0 ? host.children[host.children.length - 2] : null,
          tag: el.querySelector('[data-role="tag"]'),
          data: el.querySelector('[data-role="data"]'),
          dataText: el.querySelector('[data-role="dataText"]'),
          nonce: el.querySelector('[data-role="nonce"]'),
          prev: el.querySelector('[data-role="prev"]'),
          hash: el.querySelector('[data-role="hash"]'),
          mine: el.querySelector('[data-role="mine"]'),
          tries: el.querySelector('[data-role="tries"]')
        };
        views.push(v);

        if (v.data) {
          v.data.value = b.data;
          v.data.addEventListener('input', function () {
            b.data = v.data.value;
            if (v.tries) v.tries.textContent = '';
            refresh();
          });
        }
        if (v.dataText) v.dataText.textContent = b.data;

        if (v.nonce) {
          v.nonce.value = b.nonce;
          v.nonce.addEventListener('input', function () {
            b.nonce = parseInt(v.nonce.value, 10) || 0;
            if (v.tries) v.tries.textContent = '';
            refresh();
          });
          // Normalise on blur so an empty box doesn't linger as "".
          v.nonce.addEventListener('blur', function () { v.nonce.value = b.nonce; });
        }

        if (v.mine) v.mine.addEventListener('click', function () { mineOne(i); });
      });
    }

    /* ---------- paint ---------- */

    function paint() {
      const broken = HL.firstBreak(blocks, difficulty);

      blocks.forEach(function (b, i) {
        const v = views[i];
        const ok = broken === -1 || i < broken;

        v.el.classList.toggle('is-linked', ok);
        v.el.classList.toggle('is-broken', !ok);

        v.tag.textContent = ok ? (mode === 'demo' ? 'linked' : 'mined') : (mode === 'demo' ? 'link broken' : 'not mined');
        v.tag.className = 'tag ' + (ok ? 'tag--linked' : 'tag--broken');

        if (v.link) {
          v.link.classList.toggle('is-broken', !ok);
        }

        // textContent, never innerHTML — block data is free-form user input.
        v.prev.textContent = HL.abbreviate(b.prev, 10, 8);
        v.prev.setAttribute('title', b.prev);
        v.hash.textContent = HL.abbreviate(b.hash, 10, 8);
        v.hash.setAttribute('title', b.hash);

        if (v.dataText) v.dataText.textContent = b.data;
        if (v.nonce && document.activeElement !== v.nonce) v.nonce.value = b.nonce;
      });

      if (typeof opts.onState === 'function') {
        opts.onState({
          broken: broken,
          damage: HL.damage(blocks, difficulty),
          total: blocks.length,
          difficulty: difficulty,
          engine: ENGINE
        });
      }
    }

    /* ---------- mining ---------- */

    function setBusy(state) {
      busy = state;
      views.forEach(function (v) { if (v.mine) v.mine.disabled = state; });
      if (typeof opts.onBusy === 'function') opts.onBusy(state);
    }

    // Hash candidates in batches instead of awaiting once per nonce. Each
    // `await` is a microtask round-trip, so one-at-a-time makes difficulty 4
    // painfully slow. We still return the LOWEST satisfying nonce, so the
    // result is identical to a sequential search — just far faster.
    async function mineInner(i) {
      const b = blocks[i];
      const v = views[i];
      const target = '0'.repeat(difficulty);

      v.tag.textContent = 'mining…';
      v.tag.className = 'tag tag--working';

      b.prev = i === 0 ? HL.GENESIS : blocks[i - 1].hash;

      const BATCH = 1024;
      let base = 0;
      let found = -1;
      let out = '';
      const t0 = performance.now();

      while (found === -1) {
        const jobs = [];
        for (let n = base; n < base + BATCH; n++) {
          jobs.push(hash(HL.commitment({ index: b.index, data: b.data, prev: b.prev, nonce: n })));
        }
        const results = await Promise.all(jobs);

        for (let k = 0; k < results.length; k++) {
          if (results[k].startsWith(target)) { found = base + k; out = results[k]; break; }
        }

        if (found === -1) {
          base += BATCH;
          if ((base / BATCH) % 4 === 0 && v.tries) {
            v.tries.textContent = base.toLocaleString() + ' tried';
          }
          await new Promise(function (r) { setTimeout(r, 0); });
        }
      }

      b.nonce = found;
      b.hash = out;

      const secs = (performance.now() - t0) / 1000;
      if (v.tries) {
        v.tries.textContent = found.toLocaleString() + ' tries · ' + secs.toFixed(2) + 's' +
          (secs > 0 ? ' · ~' + Math.round(found / secs).toLocaleString() + '/s' : '');
      }
    }

    async function mineOne(i) {
      if (busy) return;
      setBusy(true);
      await mineInner(i);
      await refresh();
      setBusy(false);
    }

    async function mineAll() {
      if (busy) return;
      setBusy(true);
      for (let i = 0; i < blocks.length; i++) {
        await mineInner(i);
        await refresh();
      }
      setBusy(false);
    }

    /* ---------- public surface ---------- */

    const api = {
      engine: ENGINE,
      usingRealHash: CAN_SUBTLE,

      mineAll: mineAll,

      tamper: async function (index, text) {
        if (busy) return;
        const i = index === undefined ? 0 : index;
        blocks[i].data = text || 'Ada pays Grace 300 ETH';
        if (views[i].data) views[i].data.value = blocks[i].data;
        views.forEach(function (v) { if (v.tries) v.tries.textContent = ''; });
        await refresh();
        if (views[i].data) views[i].data.focus();
      },

      setDifficulty: async function (d) {
        difficulty = d;
        views.forEach(function (v) { if (v.tries) v.tries.textContent = ''; });
        await refresh();
      },

      add: async function () {
        if (busy || blocks.length >= MAX) return;
        const n = blocks.length + 1;
        blocks.push(HL.makeBlock(n, 'Block ' + n + ' payload', ''));
        build();
        await relink();
      },

      remove: async function () {
        if (busy || blocks.length <= MIN) return;
        blocks.pop();
        build();
        await relink();
      },

      reset: async function () {
        if (busy) return;
        blocks = seed.map(function (d, i) { return HL.makeBlock(i + 1, d, i === 0 ? HL.GENESIS : ''); });
        build();
        await relink();
      },

      count: function () { return blocks.length; },
      canAdd: function () { return blocks.length < MAX; },
      canRemove: function () { return blocks.length > MIN; }
    };

    build();
    relink();
    return api;
  }

  window.HLChain = { create: createChain, engine: ENGINE, real: CAN_SUBTLE };
})();
