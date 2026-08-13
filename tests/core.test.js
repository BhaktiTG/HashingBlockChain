/* ============================================================================
   Unit tests for assets/js/core.js

   Run:  npm test        (or: node --test tests/core.test.js)

   No framework and nothing to install — this is Node's built-in test runner,
   which is why CI needs no `npm install` step at all.

   These target the things that would be *silently* wrong rather than loudly
   broken: whether the commitment string really changes when each field
   changes, whether the break detector finds the FIRST break rather than any
   break, and whether the trend geometry survives a flat series.
   ============================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const HL = require('../assets/js/core.js');

/* ------------------------------------------------------------- commitment */

test('genesis is 64 zeros', () => {
  assert.equal(HL.GENESIS.length, 64);
  assert.match(HL.GENESIS, /^0{64}$/);
});

test('commitment includes every field, labelled', () => {
  const b = { index: 2, data: 'Ada pays Grace 3 ETH', prev: 'abc', nonce: 7 };
  assert.equal(HL.commitment(b), 'index=2|data=Ada pays Grace 3 ETH|prev=abc|nonce=7');
});

test('changing ANY single field changes the commitment', () => {
  const base = { index: 1, data: 'a', prev: 'p', nonce: 0 };
  const original = HL.commitment(base);

  assert.notEqual(HL.commitment({ ...base, index: 2 }), original);
  assert.notEqual(HL.commitment({ ...base, data: 'b' }), original);
  assert.notEqual(HL.commitment({ ...base, prev: 'q' }), original);
  assert.notEqual(HL.commitment({ ...base, nonce: 1 }), original);
});

/* ------------------------------------------------------------------ mining */

test('isMined checks leading zeros, not zeros anywhere', () => {
  assert.equal(HL.isMined('00abcdef', 2), true);
  assert.equal(HL.isMined('00abcdef', 3), false);
  assert.equal(HL.isMined('000abcde', 3), true);
  assert.equal(HL.isMined('ab00cdef', 2), false);
  assert.equal(HL.isMined('', 2), false);
  assert.equal(HL.isMined(null, 2), false);
});

test('difficulty 0 accepts any hash', () => {
  assert.equal(HL.isMined('ffffffff', 0), true);
});

/* -------------------------------------------------------- break detection */

// A helper that builds a chain whose prev pointers are all correct.
function chain(hashes) {
  return hashes.map((h, i) => ({
    index: i + 1,
    data: 'd' + i,
    prev: i === 0 ? HL.GENESIS : hashes[i - 1],
    nonce: 0,
    hash: h
  }));
}

test('firstBreak returns -1 for a whole chain', () => {
  assert.equal(HL.firstBreak(chain(['00a', '00b', '00c']), 2), -1);
});

test('firstBreak finds a mismatched prev pointer', () => {
  const c = chain(['00a', '00b', '00c']);
  c[2].prev = 'WRONG';
  assert.equal(HL.firstBreak(c, 2), 2);
});

test('firstBreak finds an unmined block even when links are fine', () => {
  const c = chain(['00a', 'ZZb', '00c']);   // block 2's hash misses the target
  assert.equal(HL.firstBreak(c, 2), 1);
});

test('firstBreak reports the FIRST break, not the last', () => {
  const c = chain(['00a', '00b', '00c']);
  c[1].prev = 'WRONG';
  c[2].prev = 'ALSO WRONG';
  assert.equal(HL.firstBreak(c, 2), 1, 'should stop at the earliest problem');
});

test('firstBreak catches a bad genesis pointer', () => {
  const c = chain(['00a', '00b']);
  c[0].prev = 'not-genesis';
  assert.equal(HL.firstBreak(c, 2), 0);
});

test('damage counts the block plus everything downstream', () => {
  const c = chain(['00a', '00b', '00c', '00d']);
  c[1].prev = 'WRONG';
  // blocks 2, 3 and 4 are all compromised by an edit at index 1
  assert.equal(HL.damage(c, 2), 3);
  assert.equal(HL.damage(chain(['00a', '00b']), 2), 0);
});

/* ------------------------------------------------------------- weak hash */

test('weakHash is deterministic and 64 lowercase hex characters', () => {
  const a = HL.weakHash('Ada pays Grace 3 ETH');
  assert.equal(a, HL.weakHash('Ada pays Grace 3 ETH'));
  assert.equal(a.length, 64);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('weakHash avalanches on a one-character change', () => {
  const a = HL.weakHash('Ada pays Grace 3 ETH');
  const b = HL.weakHash('Ada pays Grace 4 ETH');
  assert.notEqual(a, b);

  // A decent mixer should differ in far more than a couple of positions.
  let same = 0;
  for (let i = 0; i < 64; i++) if (a[i] === b[i]) same++;
  assert.ok(same < 32, `too similar: ${same}/64 characters identical`);
});

test('weakHash handles empty input', () => {
  assert.match(HL.weakHash(''), /^[0-9a-f]{64}$/);
});

/* ---------------------------------------------------------- presentation */

test('abbreviate shortens long hashes and leaves short ones alone', () => {
  const long = 'a'.repeat(64);
  assert.equal(HL.abbreviate(long), 'aaaaaaaa…aaaaaa');
  assert.equal(HL.abbreviate('short'), 'short');
  assert.equal(HL.abbreviate(''), '—');
});

test('escapeHtml neutralises markup, ampersands first', () => {
  assert.equal(HL.escapeHtml('<img src=x onerror="go()">'),
               '&lt;img src=x onerror=&quot;go()&quot;&gt;');
  assert.equal(HL.escapeHtml("O'Brien & co"), 'O&#39;Brien &amp; co');
  // If & were escaped last, this would double-escape into &amp;amp;lt;
  assert.equal(HL.escapeHtml('&lt;'), '&amp;lt;');
  assert.equal(HL.escapeHtml(null), '');
});

test('percent is signed and fixed to 2dp', () => {
  assert.equal(HL.percent(1.5), '+1.50%');
  assert.equal(HL.percent(-0.333), '-0.33%');
  assert.equal(HL.percent(0), '+0.00%');
  assert.equal(HL.percent(null), '—');
});

test('money uses more decimals for sub-unit prices', () => {
  assert.ok(HL.money(1234.5, 'USD', 'en-US').includes('1,234.50'));
  assert.ok(HL.money(0.000123, 'USD', 'en-US').includes('0.000123'));
  assert.equal(HL.money(null, 'USD', 'en-US'), '—');
});

/* --------------------------------------------------------------- geometry */

test('trendPoints spans the full width and stays inside the box', () => {
  const pts = HL.trendPoints([1, 2, 3, 4, 5], 100, 40);
  assert.equal(pts.length, 5);
  assert.ok(pts[0].startsWith('0.0,'));
  assert.ok(pts[pts.length - 1].startsWith('100.0,'));

  pts.forEach((p) => {
    const y = parseFloat(p.split(',')[1]);
    assert.ok(y >= 0 && y <= 40, `y outside box: ${y}`);
  });
});

test('trendPoints inverts y so a rising series climbs on screen', () => {
  const pts = HL.trendPoints([1, 9], 100, 40);
  const first = parseFloat(pts[0].split(',')[1]);
  const last = parseFloat(pts[1].split(',')[1]);
  assert.ok(last < first, 'SVG y grows downward, so a higher price needs a smaller y');
});

test('trendPoints survives a flat series without dividing by zero', () => {
  HL.trendPoints([5, 5, 5, 5], 100, 40).forEach((p) => {
    assert.ok(Number.isFinite(parseFloat(p.split(',')[1])));
  });
});

test('trendPoints returns nothing for unusable input', () => {
  assert.deepEqual(HL.trendPoints([], 100, 40), []);
  assert.deepEqual(HL.trendPoints([7], 100, 40), []);
  assert.deepEqual(HL.trendPoints(null, 100, 40), []);
});

/* ------------------------------------------------------------ block build */

test('makeBlock defaults the first block to genesis', () => {
  const b = HL.makeBlock(1, 'hello');
  assert.equal(b.prev, HL.GENESIS);
  assert.equal(b.nonce, 0);
  assert.equal(b.hash, '');
  assert.equal(b.data, 'hello');
});

/* ------------------------------------------------------------ wei -> ether */

test('formatEther keeps full precision on values Number would mangle', () => {
  assert.equal(HL.formatEther(1000000000000000000n, 4), '1.0000');
  assert.equal(HL.formatEther(1500000000000000000n, 2), '1.50');
  assert.equal(HL.formatEther(0n, 4), '0.0000');
  // 1 wei: Number(1e-18) would round this away entirely.
  assert.equal(HL.formatEther(1n, 18), '0.000000000000000001');
});

test('formatEther truncates rather than rounding', () => {
  // 1.99999... must never display as "2.00" — an inflated balance is worse
  // than a slightly low one.
  assert.equal(HL.formatEther(1999999999999999999n, 2), '1.99');
  assert.equal(HL.formatEther(1999999999999999999n, 0), '1');
});

test('formatEther handles negative values and huge balances', () => {
  assert.equal(HL.formatEther(-2500000000000000000n, 1), '-2.5');
  assert.equal(HL.formatEther(123456789000000000000000n, 3), '123456.789');
});
