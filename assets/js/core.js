/* ============================================================================
   core.js — the pure logic of a hash-linked chain.

   Nothing in here touches the DOM, the network, or the clock. Same input,
   same output, every time. That is what makes it testable (see
   tests/core.test.js) and it is also the honest boundary of the project: this
   file is the *rules* of a blockchain; everything else is presentation.

   Works as a plain <script> (exposes window.HL) and as a CommonJS module in
   Node, so the browser and the test runner share one copy with no build step.
   ============================================================================ */

(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.HL = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /* ------------------------------------------------------------- constants */

  // Block 1 has no predecessor, so it points at 64 zeros by convention.
  // Every real chain does something equivalent — the "genesis" block.
  const GENESIS = '0'.repeat(64);

  const HEX = '0123456789abcdef';

  /* ----------------------------------------------------- the commitment */

  /**
   * The exact string a block commits to.
   *
   * This is the single most important function in the project. A block's hash
   * is the hash OF THIS STRING. Because `prev` is part of it, the hash of
   * block N depends on the hash of block N-1, which depends on N-2, and so on
   * back to genesis. That dependency chain is what "blockchain" means.
   *
   * The labels are here on purpose: the site prints this string under every
   * block, and `index=2|data=...` teaches more than `2|...`.
   */
  function commitment(block) {
    return 'index=' + block.index +
           '|data=' + block.data +
           '|prev=' + block.prev +
           '|nonce=' + block.nonce;
  }

  /**
   * A block is mined when its hash starts with `difficulty` zeros.
   * Finding such a hash is the "work" in proof of work — there is no way to
   * compute the right nonce, only to try nonces until one lands.
   */
  function isMined(hash, difficulty) {
    if (!hash) return false;
    return hash.startsWith('0'.repeat(difficulty));
  }

  /**
   * Walk the chain and report the first block whose stored `prev` no longer
   * matches the actual hash of the block before it, or whose own hash no
   * longer meets the difficulty target.
   *
   * Returns the index of the first broken block, or -1 if the chain is whole.
   * This is the function the whole site is a visualisation of.
   */
  function firstBreak(blocks, difficulty) {
    for (let i = 0; i < blocks.length; i++) {
      const expectedPrev = i === 0 ? GENESIS : blocks[i - 1].hash;
      if (blocks[i].prev !== expectedPrev) return i;
      if (!isMined(blocks[i].hash, difficulty)) return i;
    }
    return -1;
  }

  /**
   * How many blocks are downstream of a break — i.e. how much work someone
   * would have to redo to rewrite history from that point.
   */
  function damage(blocks, difficulty) {
    const at = firstBreak(blocks, difficulty);
    return at === -1 ? 0 : blocks.length - at;
  }

  /* ------------------------------------------------------------- hashing */

  /**
   * Deterministic 64-hex-character hash with no crypto dependency.
   *
   * This is NOT SHA-256 and is NOT cryptographically secure. It exists so the
   * page still demonstrates the cascade when `crypto.subtle` is unavailable
   * (some browsers disable it on file:// pages), and so the unit tests can run
   * in Node without pulling anything in. The UI always says which engine is
   * live, because quietly swapping a real hash for a toy one would be exactly
   * the kind of dishonesty this site is about.
   *
   * Four independent FNV-1a passes with different seeds, each expanded to 16
   * hex characters, concatenated to 64.
   */
  function weakHash(text) {
    const seeds = [0x811c9dc5, 0x1b873593, 0x85ebca6b, 0xc2b2ae35];
    let out = '';

    for (let s = 0; s < seeds.length; s++) {
      let h = seeds[s] >>> 0;
      for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      for (let r = 0; r < 2; r++) {
        // Every step must be forced back to unsigned. `^` in JavaScript works
        // on signed 32-bit ints, so without the >>> 0 the value can go
        // negative and toString(16) then emits a leading "-" — which is not
        // hex, and which the unit tests caught.
        h = (h ^ (h >>> 16)) >>> 0;
        h = Math.imul(h, 0x7feb352d) >>> 0;
        h = (h ^ (h >>> 15)) >>> 0;
        out += h.toString(16).padStart(8, '0');
      }
    }
    return out.slice(0, 64);
  }

  /* --------------------------------------------------------- presentation */

  /** First 8 and last 6 characters, so a hash fits in a card. */
  function abbreviate(hash, head, tail) {
    const h = head === undefined ? 8 : head;
    const t = tail === undefined ? 6 : tail;
    if (!hash) return '—';
    if (hash.length <= h + t + 1) return hash;
    return hash.slice(0, h) + '…' + hash.slice(-t);
  }

  /** Third-party and user strings are never trusted as markup. */
  function escapeHtml(text) {
    return String(text === null || text === undefined ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /** 1234567.89 -> "1,234,567.89" style money, honouring the locale. */
  function money(value, currency, locale) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    const digits = Math.abs(value) >= 1 ? 2 : 6;
    return new Intl.NumberFormat(locale || 'en-US', {
      style: 'currency',
      currency: (currency || 'usd').toUpperCase(),
      minimumFractionDigits: digits,
      maximumFractionDigits: digits
    }).format(value);
  }

  /**
   * wei (BigInt) -> a decimal ETH string, using integer maths only.
   *
   * Deliberately NOT Number(wei) / 1e18: one ETH is 10^18 wei, which is far
   * beyond Number.MAX_SAFE_INTEGER, so floating point silently loses the low
   * digits of any real balance. Splitting into whole and fractional parts with
   * BigInt division keeps every digit exact, then we truncate for display.
   */
  function formatEther(wei, places) {
    const v = typeof wei === 'bigint' ? wei : BigInt(wei || 0);
    const neg = v < 0n;
    const abs = neg ? -v : v;

    const unit = 10n ** 18n;
    const whole = abs / unit;
    const frac = abs % unit;

    const digits = places === undefined ? 4 : places;
    const out = digits === 0
      ? whole.toString()
      : whole.toString() + '.' + frac.toString().padStart(18, '0').slice(0, digits);

    return neg ? '-' + out : out;
  }

  /** Compact market caps: $1.2T, $890B. */
  function compact(value, currency, locale) {
    if (!value) return '—';
    return new Intl.NumberFormat(locale || 'en-US', {
      style: 'currency',
      currency: (currency || 'usd').toUpperCase(),
      notation: 'compact',
      maximumFractionDigits: 2
    }).format(value);
  }

  /** Signed percentage with a fixed 2dp, for price change. */
  function percent(value) {
    if (value === null || value === undefined || Number.isNaN(value)) return '—';
    return (value >= 0 ? '+' : '') + value.toFixed(2) + '%';
  }

  /**
   * Turn a price series into polyline points for a sparkline.
   * Separated from rendering so the geometry can be tested directly.
   */
  function trendPoints(series, width, height, keepEvery) {
    if (!series || series.length < 2) return [];

    const step = keepEvery || 1;
    const pts = series.filter(function (_, i) { return i % step === 0; });
    if (pts.length < 2) return [];

    const lo = Math.min.apply(null, pts);
    const hi = Math.max.apply(null, pts);
    const span = hi - lo || 1;
    const inset = 3;

    return pts.map(function (p, i) {
      const x = (i / (pts.length - 1)) * width;
      const y = height - inset - ((p - lo) / span) * (height - inset * 2);
      return x.toFixed(1) + ',' + y.toFixed(1);
    });
  }

  /* ----------------------------------------------------------- chain build */

  /** A fresh, unmined block pointing at whatever came before it. */
  function makeBlock(index, data, prev) {
    return {
      index: index,
      data: data,
      prev: prev === undefined ? GENESIS : prev,
      nonce: 0,
      hash: ''
    };
  }

  return {
    GENESIS: GENESIS,
    HEX: HEX,
    commitment: commitment,
    isMined: isMined,
    firstBreak: firstBreak,
    damage: damage,
    weakHash: weakHash,
    abbreviate: abbreviate,
    escapeHtml: escapeHtml,
    money: money,
    formatEther: formatEther,
    compact: compact,
    percent: percent,
    trendPoints: trendPoints,
    makeBlock: makeBlock
  };
});
