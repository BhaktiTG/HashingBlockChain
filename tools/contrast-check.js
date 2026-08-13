#!/usr/bin/env node
/* ============================================================================
   tools/contrast-check.js — WCAG 2.1 contrast audit of the design tokens.

   Run with:  npm run contrast

   Parses the colour tokens straight out of assets/css/hashline.css (so the audit
   can never drift from the real stylesheet), then checks every foreground
   token against every surface it is actually painted on, in both themes.

   Exits non-zero if anything fails, which is what makes it useful in CI: a
   future colour tweak that quietly breaks readability fails the build instead
   of shipping.

   Thresholds — WCAG 2.1 AA:
     normal text  4.5:1
     large text   3.0:1   (>=24px, or >=18.66px bold)
     UI borders   3.0:1

   Every token here is used for real text somewhere, so all are held to 4.5:1.
   ============================================================================ */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CSS_PATH = path.join(__dirname, '..', 'assets', 'css', 'hashline.css');

const FOREGROUNDS = ['ink', 'body', 'muted', 'faint', 'data', 'hash', 'linked', 'broken'];
const SURFACES = ['paper', 'paper-deep', 'surface', 'surface-2'];
const AA_NORMAL = 4.5;

/* ------------------------------------------------------------ colour maths */

function channel(value) {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance(hex) {
  const h = hex.replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/* ------------------------------------------------------------- token parsing */

// Pull `--name: #rrggbb;` pairs out of a given CSS block.
function parseTokens(css, selector) {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error('Could not find block: ' + selector);

  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const block = css.slice(open + 1, close);

  const tokens = {};
  const re = /--([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\b/g;
  let match;
  while ((match = re.exec(block)) !== null) {
    tokens[match[1]] = match[2].toLowerCase();
  }
  return tokens;
}

/* -------------------------------------------------------------------- audit */

function audit(themeName, tokens, failures) {
  console.log('\n  ' + themeName);
  console.log('  ' + '-'.repeat(58));

  FOREGROUNDS.forEach(function (fg) {
    if (!tokens[fg]) return;

    let worst = Infinity;
    let worstOn = '';

    SURFACES.forEach(function (bgName) {
      if (!tokens[bgName]) return;
      const ratio = contrast(tokens[fg], tokens[bgName]);
      if (ratio < worst) {
        worst = ratio;
        worstOn = bgName;
      }
    });

    const ok = worst >= AA_NORMAL;
    const mark = ok ? 'PASS' : 'FAIL';
    console.log(
      '  ' + mark.padEnd(6) +
      ('--' + fg).padEnd(12) +
      worst.toFixed(2).padStart(6) + ':1   worst on --' + worstOn
    );

    if (!ok) {
      failures.push(
        themeName + ' --' + fg + ' is ' + worst.toFixed(2) +
        ':1 on --' + worstOn + ' (needs ' + AA_NORMAL + ':1)'
      );
    }
  });
}

/* --------------------------------------------------------------------- main */

function main() {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const failures = [];

  console.log('\n  WCAG 2.1 AA contrast audit — assets/css/hashline.css');

  // Light is the default (:root) on this site; dark is the opt-in override.
  audit('light (:root)', parseTokens(css, ':root'), failures);
  audit("dark  ([data-theme='dark'])", parseTokens(css, "[data-theme='dark']"), failures);

  console.log('');
  if (failures.length) {
    console.error('  ' + failures.length + ' token(s) below AA:\n');
    failures.forEach(function (f) { console.error('    - ' + f); });
    console.error('');
    process.exit(1);
  }

  console.log('  All foreground tokens meet AA (4.5:1) on every surface.\n');
}

main();
