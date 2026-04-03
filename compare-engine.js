/**
 * compare-engine.js
 * Takes normalised Figma JSON + Browser JSON → produces a structured diff report.
 *
 * Usage:
 *   node compare-engine.js --figma figma-normalised.json --browser browser-normalised.json --output report.json
 *
 * Or import:
 *   const { compareNodes } = require('./compare-engine');
 */

const fs   = require('fs');
const path = require('path');

// ─── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.figma || !args.browser) {
    console.error('Usage: node compare-engine.js --figma figma.json --browser browser.json [--output report.json]');
    process.exit(1);
  }
  const figmaJson   = JSON.parse(fs.readFileSync(path.resolve(args.figma),   'utf-8'));
  const browserJson = JSON.parse(fs.readFileSync(path.resolve(args.browser), 'utf-8'));
  const report      = compareNodes(figmaJson, browserJson);
  const outFile     = args.output || 'diff-report.json';
  fs.writeFileSync(path.resolve(outFile), JSON.stringify(report, null, 2));
  console.log(`\n✅ Diff report → ${outFile}`);
  printSummary(report);
}

// ─── Public API ───────────────────────────────────────────────────────────────
function compareNodes(figmaJson, browserJson) {
  const figmaNodes   = indexNodes(figmaJson.nodes   || []);
  const browserNodes = indexNodes(browserJson.nodes || []);

  const allNames = new Set([...Object.keys(figmaNodes), ...Object.keys(browserNodes)]);
  const results  = [];

  for (const name of allNames) {
    const fNode = figmaNodes[name];
    const bNode = browserNodes[name];

    if (fNode && bNode) {
      const diffs = diffProps(fNode, bNode);
      const critical = diffs.filter(d => d.severity === 'critical');
      const warnings = diffs.filter(d => d.severity === 'warning');
      const infos    = diffs.filter(d => d.severity === 'info');
      const changed  = diffs.filter(d => d.status !== 'ok');

      results.push({
        name,
        type:        fNode.type || bNode.type || 'FRAME',
        parentName:  fNode.parentName || null,
        status:      changed.length ? 'diff' : 'match',
        severity:    critical.length ? 'critical' : warnings.length ? 'warning' : changed.length ? 'info' : 'ok',
        diffs,
        summary: {
          total:    diffs.length,
          critical: critical.length,
          warnings: warnings.length,
          infos:    infos.length,
          ok:       diffs.filter(d => d.status === 'ok').length,
        }
      });

    } else if (fNode) {
      results.push({
        name,
        type:       fNode.type || 'FRAME',
        parentName: fNode.parentName || null,
        status:     'missing',
        severity:   'critical',
        diffs:      [],
        summary:    { total:0, critical:0, warnings:0, infos:0, ok:0 }
      });
    } else {
      results.push({
        name,
        type:       bNode.type || 'FRAME',
        parentName: bNode.parentName || null,
        status:     'extra',
        severity:   'info',
        diffs:      [],
        summary:    { total:0, critical:0, warnings:0, infos:0, ok:0 }
      });
    }
  }

  // Sort: critical first, then warning, then match
  const severityOrder = { critical:0, warning:1, info:2, ok:3 };
  results.sort((a, b) => (severityOrder[a.severity] ?? 9) - (severityOrder[b.severity] ?? 9));

  const counts = {
    match:   results.filter(r => r.status === 'match').length,
    diff:    results.filter(r => r.status === 'diff').length,
    missing: results.filter(r => r.status === 'missing').length,
    extra:   results.filter(r => r.status === 'extra').length,
  };
  const total    = results.length;
  const fidelity = Math.round((counts.match / (total || 1)) * 100);

  return {
    meta: {
      generatedAt:   new Date().toISOString(),
      figmaSource:   figmaJson.source    || 'figma',
      browserSource: browserJson.source  || 'browser',
      browserUrl:    browserJson.url     || null,
      viewport:      browserJson.viewport || null,
    },
    summary: {
      total,
      ...counts,
      fidelityScore: fidelity,
      criticalCount: results.filter(r => r.severity === 'critical').length,
      warningCount:  results.filter(r => r.severity === 'warning').length,
    },
    results
  };
}

module.exports = { compareNodes };

// ─── Property diffing ─────────────────────────────────────────────────────────

/**
 * TOLERANCE CONFIG
 * Adjust these thresholds to tune sensitivity.
 */
const TOLERANCES = {
  // Pixel tolerances
  size:         2,    // width / height allowed delta (px) — subpixel rendering noise
  position:     4,    // relX / relY allowed delta (px)
  padding:      2,    // padding per-side allowed delta (px)
  cornerRadius: 2,    // border radius delta (px)
  lineHeight:   2,    // line height delta (px)
  letterSpacing:0.5,  // letter spacing delta

  // Font
  fontSizeDelta: 1,   // font size allowed delta (px)

  // Color
  colorDist:    0.05, // euclidean RGB distance threshold (0–1)
};

function diffProps(figma, browser) {
  const diffs = [];

  // ── Size (critical if >tolerance) ──────────────────────────────────────────
  diffs.push(...compareNumeric('width',  figma.width,  browser.width,  TOLERANCES.size,     'critical'));
  diffs.push(...compareNumeric('height', figma.height, browser.height, TOLERANCES.size,     'critical'));

  // ── Relative position from parent (warning) ────────────────────────────────
  diffs.push(...compareNumeric('relX', figma.relX, browser.relX, TOLERANCES.position, 'warning'));
  diffs.push(...compareNumeric('relY', figma.relY, browser.relY, TOLERANCES.position, 'warning'));

  // ── Padding (warning) ──────────────────────────────────────────────────────
  if (figma.padding || browser.padding) {
    const fp = figma.padding   || { top:0, right:0, bottom:0, left:0 };
    const bp = browser.padding || { top:0, right:0, bottom:0, left:0 };
    for (const side of ['top', 'right', 'bottom', 'left']) {
      diffs.push(...compareNumeric(`padding.${side}`, fp[side] ?? 0, bp[side] ?? 0, TOLERANCES.padding, 'warning'));
    }
  }

  // ── Corner radius (info) ───────────────────────────────────────────────────
  diffs.push(...compareNumeric('cornerRadius', figma.cornerRadius, browser.cornerRadius, TOLERANCES.cornerRadius, 'info'));

  // ── Fill color (critical — brand color wrong = big deal) ───────────────────
  diffs.push(...compareColor('fillColor', figma.fillColor, browser.fillColor, 'critical'));

  // ── Stroke (info) ──────────────────────────────────────────────────────────
  diffs.push(...compareColor('strokeColor', figma.strokeColor, browser.strokeColor, 'info'));
  diffs.push(...compareNumeric('strokeWeight', figma.strokeWeight, browser.strokeWeight, 1, 'info'));

  // ── Typography ─────────────────────────────────────────────────────────────
  diffs.push(...compareNumeric('fontSize',      figma.fontSize,      browser.fontSize,      TOLERANCES.fontSizeDelta,  'critical'));
  diffs.push(...compareExact  ('fontWeight',    figma.fontWeight,    browser.fontWeight,    'warning'));
  diffs.push(...compareFontFamily('fontFamily', figma.fontFamily,    browser.fontFamily));
  diffs.push(...compareNumeric('lineHeight',    figma.lineHeight?.value, browser.lineHeight, TOLERANCES.lineHeight, 'info'));
  diffs.push(...compareNumeric('letterSpacing', figma.letterSpacing, browser.letterSpacing, TOLERANCES.letterSpacing, 'info'));
  diffs.push(...compareExact  ('textAlign',     figma.textAlign,     browser.textAlign,     'info'));

  // ── Color of text (critical) ───────────────────────────────────────────────
  diffs.push(...compareColor('textColor', figma.fillColor, browser.textColor, 'info'));

  // ── Layout (info) ──────────────────────────────────────────────────────────
  diffs.push(...compareExact('layoutMode',  figma.layoutMode,  browser.layoutMode,  'info'));
  diffs.push(...compareNumeric('itemSpacing', figma.itemSpacing, browser.itemSpacing, 2, 'info'));

  // ── Opacity ────────────────────────────────────────────────────────────────
  diffs.push(...compareNumeric('opacity', figma.opacity ?? 1, browser.opacity ?? 1, 0.05, 'warning'));

  return diffs;
}

// ─── Comparison primitives ────────────────────────────────────────────────────
function compareNumeric(key, aVal, bVal, tolerance, severity) {
  if (aVal == null && bVal == null) return [];
  if (aVal == null || bVal == null) {
    return [{ key, aVal, bVal, status: 'missing', severity: 'info', delta: null }];
  }
  const delta = Math.abs(aVal - bVal);
  const status = delta > tolerance ? 'changed' : 'ok';
  return [{
    key, aVal, bVal, status,
    severity: status === 'ok' ? 'ok' : severity,
    delta: Math.round(delta * 10) / 10,
    tolerance
  }];
}

function compareExact(key, aVal, bVal, severity) {
  if (aVal == null && bVal == null) return [];
  if (aVal == null || bVal == null) {
    return [{ key, aVal, bVal, status: 'missing', severity: 'info', delta: null }];
  }
  const status = String(aVal).toLowerCase() === String(bVal).toLowerCase() ? 'ok' : 'changed';
  return [{ key, aVal, bVal, status, severity: status === 'ok' ? 'ok' : severity, delta: null }];
}

function compareFontFamily(key, aVal, bVal) {
  if (aVal == null && bVal == null) return [];
  if (aVal == null || bVal == null) {
    return [{ key, aVal, bVal, status: 'missing', severity: 'info', delta: null }];
  }
  // Compare only the PRIMARY font (first in stack) — ignore browser fallback chain
  const primaryA = aVal.split(',')[0].replace(/['"]/g, '').trim().toLowerCase();
  const primaryB = bVal.split(',')[0].replace(/['"]/g, '').trim().toLowerCase();
  const status   = primaryA === primaryB ? 'ok' : 'changed';
  return [{ key, aVal: primaryA, bVal: primaryB, status, severity: status === 'ok' ? 'ok' : 'warning', delta: null }];
}

function compareColor(key, aColor, bColor, severity) {
  if (!aColor && !bColor) return [];
  if (!aColor || !bColor) {
    return [{ key, aVal: aColor?.hex || null, bVal: bColor?.hex || null, status: 'missing', severity: 'info', delta: null }];
  }
  const dist = Math.sqrt(
    Math.pow(aColor.r - bColor.r, 2) +
    Math.pow(aColor.g - bColor.g, 2) +
    Math.pow(aColor.b - bColor.b, 2)
  );
  const status = dist > TOLERANCES.colorDist ? 'changed' : 'ok';
  return [{
    key,
    aVal:  aColor.hex,
    bVal:  bColor.hex,
    status,
    severity: status === 'ok' ? 'ok' : severity,
    delta: Math.round(dist * 1000) / 1000,
    tolerance: TOLERANCES.colorDist,
    label: status === 'changed' ? `color distance ${Math.round(dist * 100)}%` : null
  }];
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function indexNodes(nodes) {
  const map = {};
  for (const n of nodes) {
    if (n.name) map[n.name] = n;
  }
  return map;
}

function printSummary(report) {
  const s = report.summary;
  console.log(`\n📊 Report Summary`);
  console.log(`   Total components : ${s.total}`);
  console.log(`   Matching         : ${s.match}`);
  console.log(`   Different        : ${s.diff}`);
  console.log(`   Missing in B     : ${s.missing}`);
  console.log(`   Extra in B       : ${s.extra}`);
  console.log(`   🔴 Critical diffs: ${s.criticalCount}`);
  console.log(`   🟡 Warnings      : ${s.warningCount}`);
  console.log(`   🎯 Fidelity score: ${s.fidelityScore}%\n`);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/, '')] = argv[i + 1];
  return out;
}
