/**
 * browser-extractor.ts  (or .js — works as either)
 * Extracts comparable UI props from a live browser page using Playwright.
 * Captures padding, relative X/Y from parent, typography, colors, size.
 *
 * Usage:
 *   npx ts-node browser-extractor.ts --url https://your-app.com --output browser.json
 *   node browser-extractor.js --url https://your-app.com --output browser.json
 *
 * Options:
 *   --url        Target URL (required)
 *   --output     Output file (default: browser-normalised.json)
 *   --selector   Root CSS selector (default: body)
 *   --depth      Max tree depth (default: 8)
 *   --mobile     Emulate mobile 360px viewport (default: true)
 *   --wait       Extra ms to wait after load (default: 1500)
 */

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// ─── CLI ──────────────────────────────────────────────────────────────────────
const args        = parseArgs(process.argv.slice(2));
const TARGET_URL  = args.url;
const OUTPUT_FILE = args.output  || 'browser-normalised.json';
const ROOT_SEL    = args.selector || 'body';
const MAX_DEPTH   = parseInt(args.depth || '8');
const IS_MOBILE   = args.mobile !== 'false';
const EXTRA_WAIT  = parseInt(args.wait || '1500');

if (!TARGET_URL) {
  console.error('Usage: node browser-extractor.js --url <url> [--output out.json] [--selector #root] [--depth 8] [--mobile true]');
  process.exit(1);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`\n🎭 Browser UI Extractor`);
  console.log(`   URL     : ${TARGET_URL}`);
  console.log(`   Mobile  : ${IS_MOBILE} (360×800)`);
  console.log(`   Depth   : ${MAX_DEPTH}\n`);

  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome'
  });

  const context = await browser.newContext({
    viewport: IS_MOBILE ? { width: 360, height: 800 } : { width: 1440, height: 900 },
    deviceScaleFactor: IS_MOBILE ? 2 : 1,
    isMobile:   IS_MOBILE,
    hasTouch:   IS_MOBILE,
    userAgent:  IS_MOBILE
      ? 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
      : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
  });

  const page = await context.newPage();

  console.log('⏳ Navigating...');
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(EXTRA_WAIT);

  console.log('🔍 Extracting UI tree...');
  const result = await page.evaluate(extractionScript, { rootSel: ROOT_SEL, maxDepth: MAX_DEPTH });

  await browser.close();

  // Count nodes
  let count = 0;
  const countNodes = (n) => { count++; (n.children || []).forEach(countNodes); };
  result.nodes.forEach(countNodes);

  const outputPath = path.resolve(OUTPUT_FILE);
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));

  console.log(`\n✅ Done!`);
  console.log(`   Nodes extracted : ${count}`);
  console.log(`   Output          : ${outputPath}\n`);
})();

// ─── Extraction script (runs inside browser) ──────────────────────────────────
const extractionScript = ({ rootSel, maxDepth }) => {

  const SKIP_TAGS = new Set(['script','style','noscript','meta','link','head','html','br','hr','wbr','svg','path','defs','symbol','use','g']);
  const SKIP_ROLES = new Set(['presentation','none']);

  // ── Infer component type ───────────────────────────────────────────────────
  function inferType(el) {
    const tag  = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    const cls  = Array.from(el.classList).join(' ').toLowerCase();

    if (SKIP_ROLES.has(role)) return null;

    const byRole = { button:'BUTTON', link:'LINK', heading:'HEADING', textbox:'INPUT',
      checkbox:'CHECKBOX', radio:'RADIO', combobox:'SELECT', dialog:'MODAL',
      navigation:'NAV', banner:'HEADER', main:'MAIN', list:'LIST', listitem:'LIST_ITEM',
      tab:'TAB', tabpanel:'TAB_PANEL', alert:'ALERT', tooltip:'TOOLTIP', img:'IMAGE' };
    if (byRole[role]) return byRole[role];

    const byTag = { button:'BUTTON', a:'LINK', input:'INPUT', select:'SELECT',
      textarea:'TEXTAREA', img:'IMAGE', video:'VIDEO', form:'FORM', nav:'NAV',
      header:'HEADER', footer:'FOOTER', main:'MAIN', aside:'SIDEBAR', section:'SECTION',
      article:'ARTICLE', ul:'LIST', ol:'LIST', li:'LIST_ITEM', table:'TABLE',
      h1:'HEADING', h2:'HEADING', h3:'HEADING', h4:'HEADING', h5:'HEADING', h6:'HEADING',
      p:'TEXT', span:'TEXT', label:'LABEL', dialog:'MODAL' };
    if (byTag[tag]) return byTag[tag];

    if (/card|tile|panel/i.test(cls))        return 'CARD';
    if (/modal|dialog|overlay/i.test(cls))   return 'MODAL';
    if (/btn|button/i.test(cls))             return 'BUTTON';
    if (/badge|chip|tag|pill/i.test(cls))    return 'BADGE';
    if (/nav|menu/i.test(cls))               return 'NAV';
    if (/input|field/i.test(cls))            return 'INPUT';
    return 'FRAME';
  }

  // ── Infer name ─────────────────────────────────────────────────────────────
  function inferName(el, type) {
    const aria = el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || '';
    if (aria) return aria.trim().slice(0, 80);

    const id = el.id;
    if (id && !/^[a-f0-9-]{30,}$/.test(id)) return `${type}/${id}`;

    const cls = Array.from(el.classList).find(c =>
      c.length > 2 &&
      !/^(d-|mt-|mb-|pt-|pb-|px-|py-|p-|m-|col-|row-|flex|grid|text-|bg-|border-|is-|has-|ng-|v-)/.test(c)
    );
    if (cls) return `${type}/${cls}`;

    // For text-like elements grab text content
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (text && el.children.length === 0) return text;

    return `${type}/${el.tagName.toLowerCase()}`;
  }

  // ── Parse rgba/hex color string ────────────────────────────────────────────
  function parseColor(css) {
    if (!css || css === 'transparent' || css === 'rgba(0, 0, 0, 0)') return null;
    const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!m) return null;
    const r = parseInt(m[1]), g = parseInt(m[2]), b = parseInt(m[3]);
    const a = m[4] !== undefined ? parseFloat(m[4]) : 1;
    if (a === 0) return null;
    const hex = '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
    return { hex, r: r/255, g: g/255, b: b/255, a };
  }

  function r1(v)  { return Math.round(v * 10) / 10; }

  // ── Main walker ────────────────────────────────────────────────────────────
  function walkNode(el, parentEl, parentRect, depth) {
    if (depth > maxDepth) return null;

    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return null;

    const type = inferType(el);
    if (!type) return null;

    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return null;

    const cs = window.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return null;

    const name = inferName(el, type);

    // ── Relative position from parent ────────────────────────────────────────
    const relX = parentRect ? r1(rect.left - parentRect.left) : r1(rect.left);
    const relY = parentRect ? r1(rect.top  - parentRect.top)  : r1(rect.top);

    // ── Colors ───────────────────────────────────────────────────────────────
    const fillColor   = parseColor(cs.backgroundColor);
    const strokeColor = parseColor(cs.borderColor);
    const textColor   = parseColor(cs.color);

    // ── Border ───────────────────────────────────────────────────────────────
    const strokeWeight = parseFloat(cs.borderWidth) || 0;

    // ── Padding ──────────────────────────────────────────────────────────────
    const padding = {
      top:    r1(parseFloat(cs.paddingTop)    || 0),
      right:  r1(parseFloat(cs.paddingRight)  || 0),
      bottom: r1(parseFloat(cs.paddingBottom) || 0),
      left:   r1(parseFloat(cs.paddingLeft)   || 0),
    };

    // ── Margin (gap from parent edge, useful for spacing checks) ─────────────
    const margin = {
      top:    r1(parseFloat(cs.marginTop)    || 0),
      right:  r1(parseFloat(cs.marginRight)  || 0),
      bottom: r1(parseFloat(cs.marginBottom) || 0),
      left:   r1(parseFloat(cs.marginLeft)   || 0),
    };

    // ── Typography ───────────────────────────────────────────────────────────
    const fontSize     = r1(parseFloat(cs.fontSize)     || 0);
    const lineHeightPx = r1(parseFloat(cs.lineHeight)   || 0);
    const fontFamily   = (cs.fontFamily || '').split(',')[0].replace(/['"]/g, '').trim();
    const fontWeight   = cs.fontWeight || null;
    const letterSpacing= r1(parseFloat(cs.letterSpacing)|| 0);
    const textAlign    = cs.textAlign  || null;

    // Text content (leaf nodes only)
    const textContent  = el.children.length === 0
      ? (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200) || null
      : null;

    // ── Corner radius ────────────────────────────────────────────────────────
    const cornerRadius = r1(parseFloat(cs.borderRadius) || 0);

    // ── Opacity ──────────────────────────────────────────────────────────────
    const opacity = parseFloat(cs.opacity);

    // ── Layout ───────────────────────────────────────────────────────────────
    const layoutMode = cs.display === 'flex'
      ? (cs.flexDirection === 'row' ? 'HORIZONTAL' : 'VERTICAL')
      : null;
    const itemSpacing = layoutMode ? r1(parseFloat(cs.gap) || 0) : null;

    // ── Shadow / blur ────────────────────────────────────────────────────────
    const hasShadow = cs.boxShadow !== 'none';
    const hasBlur   = cs.filter.includes('blur') || cs.backdropFilter.includes('blur');

    const node = {
      name,
      type,
      tag,
      parentName: parentEl ? inferName(parentEl, inferType(parentEl) || 'FRAME') : null,

      // Size
      width:  r1(rect.width),
      height: r1(rect.height),

      // Position relative to parent
      relX,
      relY,

      // Spacing
      padding,
      margin,
      itemSpacing,
      layoutMode,

      // Visuals
      fillColor:   fillColor   || undefined,
      strokeColor: strokeColor || undefined,
      strokeWeight: strokeWeight || undefined,
      cornerRadius: cornerRadius || undefined,
      opacity:      opacity !== 1 ? opacity : undefined,
      hasShadow:    hasShadow || undefined,
      hasBlur:      hasBlur   || undefined,

      // Typography
      fontSize:      fontSize     || undefined,
      fontWeight:    fontWeight   || undefined,
      fontFamily:    fontFamily   || undefined,
      lineHeight:    lineHeightPx || undefined,
      letterSpacing: letterSpacing || undefined,
      textAlign:     textAlign    || undefined,
      textColor:     textColor    || undefined,
      textContent:   textContent  || undefined,
    };

    // Recurse
    const children = [];
    for (const child of el.children) {
      const childNode = walkNode(child, el, rect, depth + 1);
      if (childNode) children.push(childNode);
    }
    if (children.length) node.children = children;

    return node;
  }

  const root = document.querySelector(rootSel) || document.body;
  const rootRect = root.getBoundingClientRect();
  const rootNode = walkNode(root, null, null, 0);

  // Flatten to nodes array for comparison engine
  const nodes = [];
  function flatten(n) {
    const { children, ...props } = n;
    nodes.push(props);
    if (children) children.forEach(flatten);
  }
  if (rootNode) flatten(rootNode);

  return {
    source: 'browser',
    url: window.location.href,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    extractedAt: new Date().toISOString(),
    nodes
  };
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    out[argv[i].replace(/^--/, '')] = argv[i + 1];
  }
  return out;
}
