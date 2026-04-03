/**
 * figma-extractor.js
 * Extracts comparable UI properties from a Figma REST API JSON export.
 * Normalises coordinates to be relative to each node's parent.
 *
 * Usage:
 *   node figma-extractor.js --input figma.json --output figma-normalised.json
 *
 * Or import as a module:
 *   const { extractFigmaTree } = require('./figma-extractor');
 */

const fs = require('fs');
const path = require('path');

// ─── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.input) { console.error('--input required'); process.exit(1); }
  const raw = JSON.parse(fs.readFileSync(path.resolve(args.input), 'utf-8'));
  const result = extractFigmaTree(raw);
  const out = args.output || 'figma-normalised.json';
  fs.writeFileSync(path.resolve(out), JSON.stringify(result, null, 2));
  console.log(`✅ Figma extraction complete → ${out}  (${result.nodes.length} nodes)`);
}

// ─── Public API ───────────────────────────────────────────────────────────────
function extractFigmaTree(figmaJson) {
  const nodes = [];

  // Figma REST API wraps in { document: { children: [...] } }
  // Also handle raw node arrays or single node objects
  const roots = getRoots(figmaJson);

  for (const root of roots) {
    walkFigmaNode(root, null, null, nodes);
  }

  return {
    source: 'figma',
    extractedAt: new Date().toISOString(),
    totalNodes: nodes.length,
    nodes
  };
}

module.exports = { extractFigmaTree };

// ─── Tree walker ──────────────────────────────────────────────────────────────
function walkFigmaNode(node, parentNode, parentBox, nodes) {
  if (!node || !node.name) return;

  // Skip purely structural/hidden nodes
  if (node.visible === false) return;
  if (['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'POLYGON', 'ELLIPSE'].includes(node.type) &&
      !node.name) return;

  const box = node.absoluteBoundingBox || null;

  // Relative position = this node's absolute pos minus parent's absolute pos
  const relX = (box && parentBox) ? round(box.x - parentBox.x) : (box ? round(box.x) : null);
  const relY = (box && parentBox) ? round(box.y - parentBox.y) : (box ? round(box.y) : null);

  const props = {
    // ── Identity
    id:             node.id || null,
    name:           node.name,
    type:           node.type || 'FRAME',
    parentName:     parentNode ? parentNode.name : null,

    // ── Size
    width:          box ? round(box.width)  : null,
    height:         box ? round(box.height) : null,

    // ── Position (relative to parent — matches Figma inspector values)
    relX,
    relY,

    // ── Padding (Figma uses paddingLeft/Right/Top/Bottom on AUTO-LAYOUT frames)
    padding: {
      top:    node.paddingTop    ?? 0,
      right:  node.paddingRight  ?? 0,
      bottom: node.paddingBottom ?? 0,
      left:   node.paddingLeft   ?? 0,
    },

    // ── Gap (auto-layout item spacing)
    itemSpacing: node.itemSpacing ?? null,

    // ── Layout direction
    layoutMode: node.layoutMode || null, // HORIZONTAL | VERTICAL | null

    // ── Fill color (first solid fill)
    fillColor: extractFigmaFill(node.fills),

    // ── Stroke
    strokeColor:  extractFigmaFill(node.strokes),
    strokeWeight: node.strokeWeight ?? null,

    // ── Corner radius
    cornerRadius: node.cornerRadius ?? node.rectangleCornerRadii ?? null,

    // ── Opacity
    opacity: node.opacity ?? 1,

    // ── Typography (TEXT nodes)
    fontSize:       null,
    fontWeight:     null,
    fontFamily:     null,
    lineHeight:     null,
    letterSpacing:  null,
    textAlign:      null,
    textContent:    null,
  };

  // Typography — pull from style object on TEXT nodes
  if (node.type === 'TEXT' && node.style) {
    const s = node.style;
    props.fontSize      = s.fontSize      ?? null;
    props.fontWeight    = s.fontWeight    ?? null;
    props.fontFamily    = s.fontFamily    ?? null;
    props.lineHeight    = extractLineHeight(s);
    props.letterSpacing = s.letterSpacing ?? null;
    props.textAlign     = s.textAlignHorizontal ?? null;
    props.textContent   = node.characters ?? null;
  }

  // Effects (shadows, blurs) — just flag presence
  props.hasShadow = !!(node.effects && node.effects.some(e => e.type === 'DROP_SHADOW' && e.visible !== false));
  props.hasBlur   = !!(node.effects && node.effects.some(e => e.type === 'LAYER_BLUR'  && e.visible !== false));

  nodes.push(cleanNulls(props));

  // Recurse into children
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      walkFigmaNode(child, node, box, nodes);
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function getRoots(json) {
  if (json.document && json.document.children) return json.document.children;
  if (json.nodes) return Object.values(json.nodes).map(n => n.document || n);
  if (Array.isArray(json)) return json;
  if (json.children) return json.children;
  return [json];
}

function extractFigmaFill(fills) {
  if (!fills || !fills.length) return null;
  const solid = fills.find(f => f.type === 'SOLID' && f.visible !== false);
  if (!solid || !solid.color) return null;
  const { r, g, b, a } = solid.color;
  return {
    hex: rgbToHex(r, g, b),
    r: round3(r), g: round3(g), b: round3(b),
    a: round3(a ?? 1),
    opacity: round3(solid.opacity ?? 1)
  };
}

function extractLineHeight(style) {
  if (!style.lineHeightPx) return null;
  return {
    value: style.lineHeightPx,
    unit:  style.lineHeightUnit || 'PIXELS'
  };
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

function round(v)  { return Math.round(v * 10) / 10; }
function round3(v) { return Math.round(v * 1000) / 1000; }

function cleanNulls(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== null));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    out[argv[i].replace('--', '')] = argv[i + 1];
  }
  return out;
}
