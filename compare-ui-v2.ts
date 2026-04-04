/**
 * compare-ui-v2.ts
 * Fixed based on ACTUAL Figma JSON structure observed in snapshots.
 *
 * Real structure:
 *   figmaJson.nodes["<nodeId>"].document.children[0]  ← top-level frame
 *     .absoluteBoundingBox { x, y, width, height }    ← canvas origin (e.g. x:2659, y:1541)
 *     .children[]
 *       type:"TEXT"  → .characters, .fills[0].color, .style.{fontFamily,fontWeight,fontSize}
 *       type:"FRAME" → .absoluteBoundingBox, .paddingTop/Right/Bottom/Left, .children[]
 *       type:"INSTANCE" → .componentId, .componentProperties (Radio Button etc.)
 */

import * as fs from 'fs';

// ─── Types matching REAL Figma JSON ──────────────────────────────────────────

interface FigmaColor {
  r: number; g: number; b: number; a: number;
}

interface FigmaFill {
  blendMode: string;
  type: string;
  color: FigmaColor;
}

interface FigmaStyle {
  fontFamily: string;
  fontWeight: number;
  fontSize: number;
  textAlignHorizontal?: string;
  letterSpacing?: number;
  lineHeightPx?: number;
}

interface FigmaBoundingBox {
  x: number; y: number; width: number; height: number;
}

interface FigmaNode {
  id: string;
  name: string;
  type: string;                        // "TEXT" | "FRAME" | "INSTANCE" | "COMPONENT" | etc.

  // TEXT nodes
  characters?: string;
  fills?: FigmaFill[];                 // ← fills is ON THE NODE, not inside style
  style?: FigmaStyle;                  // typography

  // All nodes
  absoluteBoundingBox?: FigmaBoundingBox;
  absoluteRenderBounds?: FigmaBoundingBox;

  // FRAME / layout nodes
  paddingTop?: number;
  paddingRight?: number;
  paddingBottom?: number;
  paddingLeft?: number;
  layoutMode?: string;                 // "VERTICAL" | "HORIZONTAL"
  counterAxisSizingMode?: string;

  // INSTANCE nodes
  componentId?: string;
  componentProperties?: Record<string, { value: string; type: string }>;

  children?: FigmaNode[];

  // Added at runtime
  _relX?: number;                      // x relative to frame origin
  _relY?: number;                      // y relative to frame origin
  _parent?: FigmaNode;
}

interface DOMElement {
  tag: string;
  text: string;
  role?: string;
  boundingBox: { x: number; y: number; width: number; height: number };
  styles: {
    fontSize?: string;
    fontWeight?: string;
    fontFamily?: string;
    color?: string;
    paddingTop?: string;
    paddingRight?: string;
    paddingBottom?: string;
    paddingLeft?: string;
    backgroundColor?: string;
  };
  children?: DOMElement[];
}

interface PropertyDiff {
  property: string;
  figma: string | number;
  dom: string | number;
  status: 'ok' | 'changed';
  delta?: number;
}

interface ComparisonResult {
  figmaText: string;
  figmaType: string;
  figmaName: string;
  status: 'ok' | 'diff' | 'missing_in_dom' | 'extra_in_dom';
  properties: PropertyDiff[];
  diffCount: number;
}

// ─── Tolerances ───────────────────────────────────────────────────────────────

const TOLERANCE = {
  position: 5,   // px
  size: 5,       // px
  fontSize: 1,   // px
  padding: 4,    // px
};

// ─── Patterns to skip (design-only elements) ──────────────────────────────────

const SKIP_PATTERNS = [
  /^\d{1,2}:\d{2}$/,      // "19:02" status bar time
  /^\[var/i,              // [varProductName]
  /^wifi$/i,
  /^battery$/i,
];

function isDesignOnly(text: string): boolean {
  return SKIP_PATTERNS.some(p => p.test(text?.trim() ?? ''));
}

// ─── Color utilities ──────────────────────────────────────────────────────────

function figmaColorToHex(color: FigmaColor): string {
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
}

function cssColorToHex(css: string): string {
  // "rgb(39, 39, 39)" or "rgba(39, 39, 39, 1)" → "#272727"
  const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
  if (m) {
    const toHex = (n: string) => parseInt(n).toString(16).padStart(2, '0');
    return `#${toHex(m[1])}${toHex(m[2])}${toHex(m[3])}`;
  }
  return css.startsWith('#') ? css.toLowerCase() : css;
}

function colorsMatch(a: string, b: string): boolean {
  return a.toLowerCase().replace('#', '') === b.toLowerCase().replace('#', '');
}

function normalizeFontFamily(f: string): string {
  // "Barclays Effra, Arial, sans-serif" → "Barclays Effra"
  return f.split(',')[0].trim();
}

// ─── Parse real Figma JSON entry point ───────────────────────────────────────

function getRootFrame(figmaJson: any): FigmaNode {
  // Structure: figmaJson.nodes["<id>"].document.children[0]
  const nodeKeys = Object.keys(figmaJson.nodes ?? {});
  if (nodeKeys.length === 0) throw new Error('No nodes in Figma JSON');

  const doc = figmaJson.nodes[nodeKeys[0]].document;
  const root = doc.children?.[0] ?? doc;
  return root as FigmaNode;
}

// ─── Extract all TEXT nodes, annotate with relative coords + parent ───────────

function extractTextNodes(
  node: FigmaNode,
  frameOrigin: FigmaBoundingBox,
  parent?: FigmaNode,
  results: FigmaNode[] = []
): FigmaNode[] {

  if (node.type === 'TEXT' && node.characters && !isDesignOnly(node.characters)) {
    const box = node.absoluteBoundingBox;
    node._relX = box ? Math.round(box.x - frameOrigin.x) : 0;
    node._relY = box ? Math.round(box.y - frameOrigin.y) : 0;
    node._parent = parent;
    results.push(node);
  }

  if (node.children) {
    for (const child of node.children) {
      // For non-TEXT nodes, they become the "parent" context
      extractTextNodes(child, frameOrigin, node.type !== 'TEXT' ? node : parent, results);
    }
  }

  return results;
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function findDOMByText(elements: DOMElement[], text: string): DOMElement | null {
  for (const el of elements) {
    if ((el.text ?? '').trim() === text.trim()) return el;
    if (el.children) {
      const found = findDOMByText(el.children, text);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Find the nearest DOM ancestor that has padding or is a semantic container.
 * Returns the element itself if no meaningful parent found.
 */
function findDOMLayoutParent(
  target: DOMElement,
  allElements: DOMElement[]
): DOMElement {
  const LAYOUT_TAGS = ['button', 'a', 'label', 'li', 'fieldset', 'form', 'section'];

  function hasPadding(el: DOMElement): boolean {
    const s = el.styles;
    return ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft']
      .some(k => parseFloat((s as any)[k] ?? '0') > 0);
  }

  function contains(outer: DOMElement, inner: DOMElement): boolean {
    const o = outer.boundingBox, i = inner.boundingBox;
    if (!o || !i) return false;
    return o.x <= i.x && o.y <= i.y &&
      o.x + o.width >= i.x + i.width &&
      o.y + o.height >= i.y + i.height;
  }

  function search(elements: DOMElement[]): DOMElement | null {
    for (const el of elements) {
      if (el === target) continue;
      if (contains(el, target)) {
        if (LAYOUT_TAGS.includes(el.tag) || hasPadding(el)) return el;
        // Recurse to find closer parent
        if (el.children) {
          const deeper = search(el.children);
          if (deeper) return deeper;
        }
      }
    }
    return null;
  }

  return search(allElements) ?? target;
}

/**
 * Calculate effective padding by comparing bounding boxes.
 * More reliable than reading CSS paddingTop/Left etc.
 */
function calcEffectivePadding(
  parentBox: FigmaBoundingBox,
  childBox: FigmaBoundingBox
) {
  return {
    top:    Math.max(0, Math.round(childBox.y - parentBox.y)),
    left:   Math.max(0, Math.round(childBox.x - parentBox.x)),
    bottom: Math.max(0, Math.round((parentBox.y + parentBox.height) - (childBox.y + childBox.height))),
    right:  Math.max(0, Math.round((parentBox.x + parentBox.width)  - (childBox.x  + childBox.width))),
  };
}

// ─── Core property comparison ─────────────────────────────────────────────────

function compareNode(figmaNode: FigmaNode, domEl: DOMElement, domParent: DOMElement): PropertyDiff[] {
  const diffs: PropertyDiff[] = [];

  const ok = (prop: string, a: any, b: any, delta?: number): PropertyDiff =>
    ({ property: prop, figma: a, dom: b, status: 'ok', delta });
  const changed = (prop: string, a: any, b: any, delta?: number): PropertyDiff =>
    ({ property: prop, figma: a, dom: b, status: 'changed', delta });
  const diff = (prop: string, a: any, b: any, delta: number, tol: number): PropertyDiff =>
    delta <= tol ? ok(prop, a, b, delta) : changed(prop, a, b, delta);

  // 1. Fill color (fills is ON the node, not inside style)
  const figmaFill = figmaNode.fills?.find(f => f.type === 'SOLID');
  if (figmaFill) {
    const figmaHex = figmaColorToHex(figmaFill.color);
    const domHex = cssColorToHex(domEl.styles?.color ?? '');
    diffs.push(colorsMatch(figmaHex, domHex)
      ? ok('fillColor', figmaHex, domHex)
      : changed('fillColor', figmaHex, domHex));
  }

  // 2. Font size
  const figmaFS = figmaNode.style?.fontSize ?? 0;
  const domFS = parseFloat(domEl.styles?.fontSize ?? '0');
  const fsDelta = Math.abs(figmaFS - domFS);
  diffs.push(diff('fontSize', figmaFS, domFS, fsDelta, TOLERANCE.fontSize));

  // 3. Font weight
  const figmaFW = figmaNode.style?.fontWeight ?? 0;
  const domFW = parseInt(domEl.styles?.fontWeight ?? '0');
  diffs.push(Math.abs(figmaFW - domFW) === 0
    ? ok('fontWeight', figmaFW, domFW)
    : changed('fontWeight', figmaFW, domFW, Math.abs(figmaFW - domFW)));

  // 4. Font family (normalize fallbacks)
  const figmaFF = normalizeFontFamily(figmaNode.style?.fontFamily ?? '');
  const domFF = normalizeFontFamily(domEl.styles?.fontFamily ?? '');
  diffs.push(figmaFF === domFF
    ? ok('fontFamily', figmaFF, domFF)
    : changed('fontFamily', figmaFF, domFF));

  // 5 & 6. Padding — from FIGMA PARENT node vs DOM effective padding
  const figmaParent = figmaNode._parent;
  const fp = {
    top:    figmaParent?.paddingTop    ?? 0,
    right:  figmaParent?.paddingRight  ?? 0,
    bottom: figmaParent?.paddingBottom ?? 0,
    left:   figmaParent?.paddingLeft   ?? 0,
  };

  // DOM effective padding from bounding box geometry
  const dp = calcEffectivePadding(domParent.boundingBox, domEl.boundingBox);

  diffs.push(diff('paddingTop',    fp.top,    dp.top,    Math.abs(fp.top    - dp.top),    TOLERANCE.padding));
  diffs.push(diff('paddingRight',  fp.right,  dp.right,  Math.abs(fp.right  - dp.right),  TOLERANCE.padding));
  diffs.push(diff('paddingBottom', fp.bottom, dp.bottom, Math.abs(fp.bottom - dp.bottom), TOLERANCE.padding));
  diffs.push(diff('paddingLeft',   fp.left,   dp.left,   Math.abs(fp.left   - dp.left),   TOLERANCE.padding));

  // 7. X position — relative to frame origin vs DOM viewport X
  const figmaRelX = figmaNode._relX ?? 0;
  const domX = Math.round(domParent.boundingBox.x);
  const xDelta = Math.abs(figmaRelX - domX);
  diffs.push(diff('x', figmaRelX, domX, xDelta, TOLERANCE.position));

  // 8. Y position — relative to frame origin vs DOM viewport Y
  const figmaRelY = figmaNode._relY ?? 0;
  const domY = Math.round(domParent.boundingBox.y);
  const yDelta = Math.abs(figmaRelY - domY);
  diffs.push(diff('y', figmaRelY, domY, yDelta, TOLERANCE.position));

  // 9. Width — use PARENT (frame) width, not text node width
  const figmaWidth = figmaParent?.absoluteBoundingBox?.width
    ?? figmaNode.absoluteBoundingBox?.width ?? 0;
  const domWidth = Math.round(domParent.boundingBox.width);
  const wDelta = Math.abs(Math.round(figmaWidth) - domWidth);
  diffs.push(diff('width', Math.round(figmaWidth), domWidth, wDelta, TOLERANCE.size));

  // 10. Height — parent height
  const figmaHeight = figmaParent?.absoluteBoundingBox?.height
    ?? figmaNode.absoluteBoundingBox?.height ?? 0;
  const domHeight = Math.round(domParent.boundingBox.height);
  const hDelta = Math.abs(Math.round(figmaHeight) - domHeight);
  diffs.push(diff('height', Math.round(figmaHeight), domHeight, hDelta, TOLERANCE.size));

  return diffs;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

function runComparison(figmaPath: string, domPath: string): ComparisonResult[] {
  const figmaJson = JSON.parse(fs.readFileSync(figmaPath, 'utf-8'));
  const domElements: DOMElement[] = JSON.parse(fs.readFileSync(domPath, 'utf-8'));

  // Get the root frame
  const rootFrame = getRootFrame(figmaJson);
  const frameOrigin = rootFrame.absoluteBoundingBox ?? { x: 0, y: 0, width: 360, height: 800 };

  console.log(`\nFrame: "${rootFrame.name}" origin=(${frameOrigin.x}, ${frameOrigin.y}) size=${frameOrigin.width}x${frameOrigin.height}`);

  // Extract TEXT nodes
  const textNodes = extractTextNodes(rootFrame, frameOrigin);
  console.log(`Figma TEXT nodes found: ${textNodes.length}`);
  textNodes.forEach(n => console.log(`  [${n._relX}, ${n._relY}] "${n.characters}"`));

  const results: ComparisonResult[] = [];
  const matchedDOMTexts = new Set<string>();

  for (const figmaNode of textNodes) {
    const text = figmaNode.characters!;
    const domEl = findDOMByText(domElements, text);

    if (!domEl) {
      console.log(`  ❌ Missing in DOM: "${text}"`);
      results.push({
        figmaText: text,
        figmaType: figmaNode.type,
        figmaName: figmaNode.name,
        status: 'missing_in_dom',
        properties: [],
        diffCount: 0,
      });
      continue;
    }

    matchedDOMTexts.add(text.trim());
    const domParent = findDOMLayoutParent(domEl, domElements);
    const props = compareNode(figmaNode, domEl, domParent);
    const diffCount = props.filter(p => p.status === 'changed').length;

    results.push({
      figmaText: text,
      figmaType: figmaNode.type,
      figmaName: figmaNode.name,
      status: diffCount > 0 ? 'diff' : 'ok',
      properties: props,
      diffCount,
    });
  }

  // Extra DOM elements not in Figma
  function scanDOM(elements: DOMElement[]) {
    for (const el of elements) {
      const t = (el.text ?? '').trim();
      if (t && !matchedDOMTexts.has(t) && !isDesignOnly(t)) {
        results.push({
          figmaText: t,
          figmaType: 'EXTRA',
          figmaName: el.tag,
          status: 'extra_in_dom',
          properties: [],
          diffCount: 0,
        });
        matchedDOMTexts.add(t);
      }
      if (el.children) scanDOM(el.children);
    }
  }
  scanDOM(domElements);

  return results;
}

// ─── HTML Report ──────────────────────────────────────────────────────────────

function generateReport(results: ComparisonResult[], figmaPath: string): string {
  const total = results.length;
  const byStatus = (s: string) => results.filter(r => r.status === s).length;
  const ok = byStatus('ok'), diffs = byStatus('diff'),
        missing = byStatus('missing_in_dom'), extra = byStatus('extra_in_dom');
  const rate = total > 0 ? Math.round((ok / total) * 100) : 0;

  const statusBadge = (r: ComparisonResult) => {
    const map: Record<string, [string, string]> = {
      ok:            ['#e8f5e9', '#2e7d32', 'ok'],
      diff:          ['#fff3e0', '#e65100', 'diff'],
      missing_in_dom:['#fce4ec', '#c62828', 'missing in DOM'],
      extra_in_dom:  ['#e3f2fd', '#1565c0', 'extra in DOM'],
    };
    const [bg, color, label] = map[r.status] ?? ['#f5f5f5', '#333', r.status];
    return `<span style="background:${bg};color:${color};padding:2px 10px;border-radius:10px;font-size:11px;font-weight:600">${label}</span>`;
  };

  const rows = results.map(r => {
    const propRows = r.properties.map(p => {
      const isColor = p.property === 'fillColor';
      const swatch = (hex: string) => isColor
        ? `<span style="display:inline-block;width:11px;height:11px;background:${hex};border:1px solid #ccc;border-radius:2px;margin-right:4px;vertical-align:middle"></span>`
        : '';
      if (p.status === 'changed') {
        return `<tr style="background:#fff8f0">
          <td style="color:#e65100;font-weight:600;padding:6px 12px">${p.property}</td>
          <td style="padding:6px 12px"><s style="color:#c62828">${swatch(String(p.figma))}${p.figma}</s></td>
          <td style="padding:6px 12px"><span style="color:#2e7d32">${swatch(String(p.dom))}${p.dom}</span></td>
          <td style="padding:6px 12px;color:#e65100;font-size:12px">changed ${p.delta !== undefined ? `Δ ${p.delta.toFixed(1)}` : ''}</td>
        </tr>`;
      }
      return `<tr>
        <td style="padding:6px 12px;color:#555">${p.property}</td>
        <td style="padding:6px 12px">${swatch(String(p.figma))}${p.figma}</td>
        <td style="padding:6px 12px">${swatch(String(p.dom))}${p.dom}</td>
        <td style="padding:6px 12px;color:#2e7d32;font-size:12px">ok</td>
      </tr>`;
    }).join('');

    const hasProps = r.properties.length > 0;
    const detId = `d_${Math.random().toString(36).slice(2)}`;

    return `
    <div style="background:white;border-radius:8px;margin-bottom:10px;box-shadow:0 1px 3px rgba(0,0,0,.08);overflow:hidden">
      <div onclick="document.getElementById('${detId}').style.display=document.getElementById('${detId}').style.display==='none'?'block':'none'"
           style="display:flex;align-items:center;gap:10px;padding:14px 18px;cursor:pointer;user-select:none">
        <span style="flex:1;font-weight:600;font-size:14px">${escHtml(r.figmaText)}</span>
        <span style="font-size:11px;color:#999;background:#f0f0f0;padding:2px 8px;border-radius:4px">${r.figmaType}</span>
        ${statusBadge(r)}
        ${r.diffCount > 0 ? `<span style="font-size:12px;color:#888">${r.diffCount} differ</span>` : ''}
      </div>
      ${hasProps ? `
      <div id="${detId}" style="display:none;padding:0 18px 16px">
        <table style="width:100%;border-collapse:collapse;font-size:13px">
          <thead><tr style="background:#f8f8f8">
            <th style="padding:7px 12px;text-align:left;color:#666">Property</th>
            <th style="padding:7px 12px;text-align:left;color:#666">Design (Figma)</th>
            <th style="padding:7px 12px;text-align:left;color:#666">Browser (DOM)</th>
            <th style="padding:7px 12px;text-align:left;color:#666">Status</th>
          </tr></thead>
          <tbody>${propRows}</tbody>
        </table>
      </div>` : ''}
    </div>`;
  }).join('');

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<title>UI Diff — ${figmaPath}</title>
<style>*{box-sizing:border-box}body{margin:0;font-family:'Segoe UI',system-ui,sans-serif;background:#f4f5f7}</style>
</head><body>
<div style="background:#00395d;color:white;padding:22px 32px">
  <h1 style="margin:0;font-size:22px">🔍 DOM vs Figma — UI Diff Report</h1>
  <div style="margin-top:6px;opacity:.8;font-size:13px">${figmaPath} · ${new Date().toLocaleString()}</div>
</div>
<div style="display:flex;gap:14px;padding:20px 32px;background:white;border-bottom:1px solid #e8e8e8">
  ${[['✅ Match', ok, '#e8f5e9', '#2e7d32'],
     ['⚠️ Diff',  diffs, '#fff3e0', '#e65100'],
     ['❌ Missing', missing, '#fce4ec', '#c62828'],
     ['➕ Extra', extra, '#e3f2fd', '#1565c0'],
     [`${rate}% match rate`, total, '#f3e5f5', '#6a1b9a']
  ].map(([label, n, bg, color]) =>
    `<div style="text-align:center;padding:12px 18px;background:${bg};border-radius:8px;min-width:80px">
      <div style="font-size:26px;font-weight:700;color:${color}">${n}</div>
      <div style="font-size:11px;color:${color}">${label}</div>
    </div>`).join('')}
</div>
<div style="padding:24px 32px">${rows}</div>
</body></html>`;
}

function escHtml(s: string) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── Entry point ──────────────────────────────────────────────────────────────

const [,, figmaPath = 'figma-output.json', domPath = 'dom-output.json', reportPath = 'diff-report.html'] = process.argv;

const results = runComparison(figmaPath, domPath);
fs.writeFileSync(reportPath, generateReport(results, figmaPath));

const ok = results.filter(r => r.status === 'ok').length;
console.log(`\n✅ Report → ${reportPath}`);
console.log(`📊 ${ok}/${results.length} elements match (${Math.round(ok/results.length*100)}%)`);
