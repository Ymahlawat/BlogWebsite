/**
 * run-pipeline.js
 * End-to-end pipeline: Figma JSON + live URL → diff report JSON + HTML report
 *
 * Usage:
 *   node run-pipeline.js \
 *     --figma    figma-export.json \
 *     --url      https://your-app.com \
 *     --out      ./reports
 *
 * Options:
 *   --figma      Path to Figma JSON export (required)
 *   --url        Live app URL to extract from (required)
 *   --out        Output directory (default: ./reports)
 *   --selector   CSS selector for root (default: body)
 *   --depth      Tree depth (default: 8)
 *   --mobile     Mobile viewport 360px (default: true)
 *   --wait       Extra ms to wait after page load (default: 1500)
 *   --open       Open HTML report in browser after run (default: true)
 */

const { chromium }      = require('playwright');
const fs                = require('fs');
const path              = require('path');
const { extractFigmaTree }  = require('./figma-extractor');
const { compareNodes }      = require('./compare-engine');

// ─── CLI ──────────────────────────────────────────────────────────────────────
const args       = parseArgs(process.argv.slice(2));
const FIGMA_FILE = args.figma;
const TARGET_URL = args.url;
const OUT_DIR    = path.resolve(args.out || './reports');
const ROOT_SEL   = args.selector || 'body';
const MAX_DEPTH  = parseInt(args.depth || '8');
const IS_MOBILE  = args.mobile !== 'false';
const EXTRA_WAIT = parseInt(args.wait || '1500');
const AUTO_OPEN  = args.open !== 'false';

if (!FIGMA_FILE || !TARGET_URL) {
  console.error('Usage: node run-pipeline.js --figma figma.json --url https://app.com');
  process.exit(1);
}

// ─── Extraction script (same as browser-extractor.js, inlined for pipeline) ──
const EXTRACTION_SCRIPT = ({ rootSel, maxDepth }) => {
  const SKIP_TAGS  = new Set(['script','style','noscript','meta','link','head','html','br','hr','wbr','svg','path','defs','symbol','use','g']);
  const SKIP_ROLES = new Set(['presentation','none']);

  function inferType(el) {
    const tag  = el.tagName.toLowerCase();
    const role = (el.getAttribute('role') || '').toLowerCase();
    const cls  = Array.from(el.classList).join(' ').toLowerCase();
    if (SKIP_ROLES.has(role)) return null;
    const byRole = { button:'BUTTON',link:'LINK',heading:'HEADING',textbox:'INPUT',checkbox:'CHECKBOX',radio:'RADIO',combobox:'SELECT',dialog:'MODAL',navigation:'NAV',banner:'HEADER',main:'MAIN',list:'LIST',listitem:'LIST_ITEM',tab:'TAB',tabpanel:'TAB_PANEL',alert:'ALERT',tooltip:'TOOLTIP',img:'IMAGE' };
    if (byRole[role]) return byRole[role];
    const byTag = { button:'BUTTON',a:'LINK',input:'INPUT',select:'SELECT',textarea:'TEXTAREA',img:'IMAGE',video:'VIDEO',form:'FORM',nav:'NAV',header:'HEADER',footer:'FOOTER',main:'MAIN',aside:'SIDEBAR',section:'SECTION',article:'ARTICLE',ul:'LIST',ol:'LIST',li:'LIST_ITEM',table:'TABLE',h1:'HEADING',h2:'HEADING',h3:'HEADING',h4:'HEADING',h5:'HEADING',h6:'HEADING',p:'TEXT',span:'TEXT',label:'LABEL',dialog:'MODAL' };
    if (byTag[tag]) return byTag[tag];
    if (/card|tile|panel/i.test(cls))       return 'CARD';
    if (/modal|dialog|overlay/i.test(cls))  return 'MODAL';
    if (/btn|button/i.test(cls))            return 'BUTTON';
    if (/badge|chip|tag|pill/i.test(cls))   return 'BADGE';
    if (/nav|menu/i.test(cls))              return 'NAV';
    if (/input|field/i.test(cls))           return 'INPUT';
    return 'FRAME';
  }

  function inferName(el, type) {
    const aria = el.getAttribute('aria-label') || '';
    if (aria) return aria.trim().slice(0, 80);
    const id = el.id;
    if (id && !/^[a-f0-9-]{30,}$/.test(id)) return `${type}/${id}`;
    const cls = Array.from(el.classList).find(c => c.length > 2 && !/^(d-|mt-|mb-|pt-|pb-|px-|py-|p-|m-|col-|row-|flex|grid|text-|bg-|border-|is-|has-|ng-|v-)/.test(c));
    if (cls) return `${type}/${cls}`;
    const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    if (text && el.children.length === 0) return text;
    return `${type}/${el.tagName.toLowerCase()}`;
  }

  function parseColor(css) {
    if (!css || css === 'transparent' || css === 'rgba(0, 0, 0, 0)') return null;
    const m = css.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    if (!m) return null;
    const r=parseInt(m[1]),g=parseInt(m[2]),b=parseInt(m[3]),a=m[4]!==undefined?parseFloat(m[4]):1;
    if (a === 0) return null;
    return { hex:'#'+[r,g,b].map(v=>v.toString(16).padStart(2,'0')).join(''), r:r/255, g:g/255, b:b/255, a };
  }

  function r1(v) { return Math.round(v * 10) / 10; }

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
    const relX = parentRect ? r1(rect.left - parentRect.left) : r1(rect.left);
    const relY = parentRect ? r1(rect.top  - parentRect.top)  : r1(rect.top);
    const fillColor   = parseColor(cs.backgroundColor);
    const strokeColor = parseColor(cs.borderColor);
    const textColor   = parseColor(cs.color);
    const strokeWeight = parseFloat(cs.borderWidth) || 0;
    const padding = { top:r1(parseFloat(cs.paddingTop)||0), right:r1(parseFloat(cs.paddingRight)||0), bottom:r1(parseFloat(cs.paddingBottom)||0), left:r1(parseFloat(cs.paddingLeft)||0) };
    const margin  = { top:r1(parseFloat(cs.marginTop)||0), right:r1(parseFloat(cs.marginRight)||0), bottom:r1(parseFloat(cs.marginBottom)||0), left:r1(parseFloat(cs.marginLeft)||0) };
    const fontSize      = r1(parseFloat(cs.fontSize)||0);
    const lineHeightPx  = r1(parseFloat(cs.lineHeight)||0);
    const fontFamily    = (cs.fontFamily||'').split(',')[0].replace(/['"]/g,'').trim();
    const fontWeight    = cs.fontWeight || null;
    const letterSpacing = r1(parseFloat(cs.letterSpacing)||0);
    const textAlign     = cs.textAlign || null;
    const textContent   = el.children.length === 0 ? (el.textContent||'').trim().replace(/\s+/g,' ').slice(0,200)||null : null;
    const cornerRadius  = r1(parseFloat(cs.borderRadius)||0);
    const opacity       = parseFloat(cs.opacity);
    const layoutMode    = cs.display==='flex' ? (cs.flexDirection==='row'?'HORIZONTAL':'VERTICAL') : null;
    const itemSpacing   = layoutMode ? r1(parseFloat(cs.gap)||0) : null;
    const hasShadow     = cs.boxShadow !== 'none';
    const hasBlur       = cs.filter.includes('blur') || cs.backdropFilter.includes('blur');
    const node = {
      name, type, tag,
      parentName: parentEl ? inferName(parentEl, inferType(parentEl)||'FRAME') : null,
      width:r1(rect.width), height:r1(rect.height), relX, relY,
      padding, margin, itemSpacing, layoutMode,
      fillColor:fillColor||undefined, strokeColor:strokeColor||undefined,
      strokeWeight:strokeWeight||undefined, cornerRadius:cornerRadius||undefined,
      opacity:opacity!==1?opacity:undefined, hasShadow:hasShadow||undefined, hasBlur:hasBlur||undefined,
      fontSize:fontSize||undefined, fontWeight:fontWeight||undefined, fontFamily:fontFamily||undefined,
      lineHeight:lineHeightPx||undefined, letterSpacing:letterSpacing||undefined,
      textAlign:textAlign||undefined, textColor:textColor||undefined, textContent:textContent||undefined,
    };
    const children = [];
    for (const child of el.children) {
      const c = walkNode(child, el, rect, depth + 1);
      if (c) children.push(c);
    }
    if (children.length) node.children = children;
    return node;
  }

  const root = document.querySelector(rootSel) || document.body;
  const rootNode = walkNode(root, null, null, 0);
  const nodes = [];
  function flatten(n) { const { children, ...p } = n; nodes.push(p); if (children) children.forEach(flatten); }
  if (rootNode) flatten(rootNode);
  return { source:'browser', url:window.location.href, viewport:{width:window.innerWidth,height:window.innerHeight}, extractedAt:new Date().toISOString(), nodes };
};

// ─── HTML Report Generator ────────────────────────────────────────────────────
function generateHtmlReport(report) {
  const s = report.summary;
  const severityIcon = { critical:'🔴', warning:'🟡', info:'🔵', ok:'🟢' };
  const statusBadge = (status, severity) => {
    const colors = { match:'#3B6D11:#EAF3DE', diff_critical:'#A32D2D:#FCEBEB', diff_warning:'#854F0B:#FAEEDA', diff_info:'#185FA5:#E6F1FB', missing:'#854F0B:#FAEEDA', extra:'#185FA5:#E6F1FB' };
    const key = status === 'diff' ? `diff_${severity}` : status;
    const [fg, bg] = (colors[key] || '#444:#eee').split(':');
    const label = status === 'diff' ? `${severityIcon[severity]} ${severity}` : status;
    return `<span style="background:${bg};color:${fg};padding:2px 8px;border-radius:10px;font-size:11px;font-weight:500">${label}</span>`;
  };

  const rows = report.results.map((r, i) => {
    const propRows = r.diffs.filter(d => d.status !== 'ok').map(d => {
      const isColor = d.key.includes('Color');
      const swA = isColor && d.aVal ? `<span style="display:inline-block;width:10px;height:10px;background:${d.aVal};border:1px solid #ccc;border-radius:2px;vertical-align:middle;margin-right:3px"></span>` : '';
      const swB = isColor && d.bVal ? `<span style="display:inline-block;width:10px;height:10px;background:${d.bVal};border:1px solid #ccc;border-radius:2px;vertical-align:middle;margin-right:3px"></span>` : '';
      const sev = { critical:'🔴', warning:'🟡', info:'🔵', ok:'🟢' }[d.severity] || '';
      return `<tr style="border-bottom:1px solid #f0f0f0">
        <td style="padding:4px 8px;font-size:11px;font-family:monospace;color:#555">${d.key}</td>
        <td style="padding:4px 8px;font-size:11px;font-family:monospace;color:#E24B4A;text-decoration:${d.status==='changed'?'line-through':'none'}">${swA}${d.aVal ?? '—'}</td>
        <td style="padding:4px 8px;font-size:11px;font-family:monospace;color:#3B6D11">${swB}${d.bVal ?? '—'}</td>
        <td style="padding:4px 8px;font-size:11px">${sev} ${d.label || (d.delta != null ? `Δ${d.delta}` : d.status)}</td>
      </tr>`;
    }).join('');

    const detail = r.diffs.length ? `
      <tr id="det-${i}" style="display:none">
        <td colspan="5" style="padding:0 12px 12px 40px;background:#fafafa">
          <table style="width:100%;border-collapse:collapse;font-size:12px">
            <tr style="background:#f5f5f5">
              <th style="padding:6px 8px;text-align:left;font-size:11px;color:#888">Property</th>
              <th style="padding:6px 8px;text-align:left;font-size:11px;color:#888">Design (A)</th>
              <th style="padding:6px 8px;text-align:left;font-size:11px;color:#888">Browser (B)</th>
              <th style="padding:6px 8px;text-align:left;font-size:11px;color:#888">Note</th>
            </tr>
            ${propRows}
          </table>
        </td>
      </tr>` : '';

    const changedCount = r.diffs.filter(d => d.status !== 'ok').length;
    const summary = r.status === 'diff'    ? `${changedCount} propert${changedCount===1?'y':'ies'} differ`
                  : r.status === 'missing' ? 'Not found in browser'
                  : r.status === 'extra'   ? 'Not in Figma design'
                  : 'All properties match';

    return `
      <tr onclick="toggleRow(${i})" style="cursor:pointer;border-bottom:1px solid #eee" class="main-row" data-status="${r.status}" data-severity="${r.severity}" data-name="${r.name.toLowerCase()}">
        <td style="padding:10px 12px;font-size:11px;color:#aaa">&#9654;</td>
        <td style="padding:10px 4px">
          <div style="font-size:13px;font-weight:500">${escHtml(r.name)}</div>
          <div style="font-size:11px;color:#888;margin-top:2px">${r.type}${r.parentName ? ` · in ${escHtml(r.parentName)}` : ''}</div>
        </td>
        <td style="padding:10px 8px">${statusBadge(r.status, r.severity)}</td>
        <td style="padding:10px 8px;font-size:12px;color:#888">${summary}</td>
        <td style="padding:10px 8px;font-size:12px;color:#888">
          ${r.summary.critical ? `<span style="color:#E24B4A">🔴 ${r.summary.critical}</span> ` : ''}
          ${r.summary.warnings ? `<span style="color:#BA7517">🟡 ${r.summary.warnings}</span>` : ''}
        </td>
      </tr>
      ${detail}`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>UI Diff Report — ${new Date().toLocaleDateString()}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f8f8f6;color:#1a1a1a}
  .page{max-width:1100px;margin:0 auto;padding:2rem 1.5rem}
  h1{font-size:20px;font-weight:500;margin-bottom:4px}
  .meta{font-size:12px;color:#888;margin-bottom:1.5rem}
  .stats{display:grid;grid-template-columns:repeat(7,1fr);gap:8px;margin-bottom:1.5rem}
  .stat{background:#fff;border:1px solid #eee;border-radius:8px;padding:12px 8px;text-align:center}
  .stat-n{font-size:22px;font-weight:500}
  .stat-l{font-size:11px;color:#888;margin-top:2px}
  .chart-row{display:grid;grid-template-columns:240px 1fr;gap:12px;margin-bottom:1.5rem}
  .chart-box{background:#fff;border:1px solid #eee;border-radius:12px;padding:1rem}
  .chart-label{font-size:11px;font-weight:500;color:#888;text-transform:uppercase;letter-spacing:.05em;margin-bottom:10px}
  .toolbar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center}
  .filter-btn{padding:5px 12px;border:1px solid #ddd;border-radius:20px;font-size:12px;cursor:pointer;background:#fff;color:#666}
  .filter-btn:hover,.filter-btn.active{background:#1a1a1a;color:#fff;border-color:#1a1a1a}
  input[type=text]{padding:6px 12px;border:1px solid #ddd;border-radius:20px;font-size:12px;outline:none;width:220px}
  .report-table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #eee;border-radius:12px;overflow:hidden}
  .report-table thead th{padding:10px 12px;text-align:left;font-size:11px;font-weight:500;color:#888;background:#fafafa;border-bottom:1px solid #eee;text-transform:uppercase;letter-spacing:.04em}
  .main-row:hover{background:#fafafa}
  .legend{display:flex;gap:12px;margin-top:8px;font-size:11px;color:#888}
  .leg{display:flex;align-items:center;gap:4px}
  .leg-dot{width:9px;height:9px;border-radius:2px;display:inline-block}
  @media print{.toolbar,.chart-row{display:none}}
</style>
</head>
<body>
<div class="page">
  <h1>UI Diff Report</h1>
  <div class="meta">
    Generated ${new Date(report.meta.generatedAt).toLocaleString()} &nbsp;·&nbsp;
    ${report.meta.browserUrl ? `<a href="${report.meta.browserUrl}" style="color:#185FA5">${report.meta.browserUrl}</a>` : ''} &nbsp;·&nbsp;
    Viewport ${report.meta.viewport ? `${report.meta.viewport.width}×${report.meta.viewport.height}` : 'unknown'}
  </div>

  <div class="stats">
    <div class="stat"><div class="stat-n">${s.total}</div><div class="stat-l">Total</div></div>
    <div class="stat"><div class="stat-n" style="color:#639922">${s.match}</div><div class="stat-l">Match</div></div>
    <div class="stat"><div class="stat-n" style="color:#E24B4A">${s.diff}</div><div class="stat-l">Different</div></div>
    <div class="stat"><div class="stat-n" style="color:#BA7517">${s.missing}</div><div class="stat-l">Missing</div></div>
    <div class="stat"><div class="stat-n" style="color:#378ADD">${s.extra}</div><div class="stat-l">Extra</div></div>
    <div class="stat"><div class="stat-n" style="color:#E24B4A">${s.criticalCount}</div><div class="stat-l">🔴 Critical</div></div>
    <div class="stat"><div class="stat-n">${s.fidelityScore}%</div><div class="stat-l">Fidelity</div></div>
  </div>

  <div class="chart-row">
    <div class="chart-box">
      <div class="chart-label">Breakdown</div>
      <div style="position:relative;height:160px"><canvas id="pie"></canvas></div>
      <div class="legend">
        <span class="leg"><span class="leg-dot" style="background:#639922"></span>Match</span>
        <span class="leg"><span class="leg-dot" style="background:#E24B4A"></span>Diff</span>
        <span class="leg"><span class="leg-dot" style="background:#BA7517"></span>Missing</span>
        <span class="leg"><span class="leg-dot" style="background:#378ADD"></span>Extra</span>
      </div>
    </div>
    <div class="chart-box">
      <div class="chart-label">Top critical components</div>
      <div style="position:relative;height:160px"><canvas id="bar"></canvas></div>
    </div>
  </div>

  <div class="toolbar">
    <button class="filter-btn active" onclick="setFilter('all',this)">All (${s.total})</button>
    <button class="filter-btn" onclick="setFilter('diff',this)">Different (${s.diff})</button>
    <button class="filter-btn" onclick="setFilter('missing',this)">Missing (${s.missing})</button>
    <button class="filter-btn" onclick="setFilter('extra',this)">Extra (${s.extra})</button>
    <button class="filter-btn" onclick="setFilter('match',this)">Match (${s.match})</button>
    <button class="filter-btn" onclick="setFilter('critical',this)">🔴 Critical (${s.criticalCount})</button>
    <input type="text" id="search" placeholder="Search components..." oninput="doSearch(this.value)" />
    <button class="filter-btn" onclick="window.print()">Print / PDF</button>
  </div>

  <table class="report-table">
    <thead>
      <tr>
        <th style="width:28px"></th>
        <th>Component</th>
        <th style="width:130px">Status</th>
        <th>Summary</th>
        <th style="width:100px">Issues</th>
      </tr>
    </thead>
    <tbody id="tbody">${rows}</tbody>
  </table>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<script>
  const pie = new Chart(document.getElementById('pie'), {
    type:'doughnut',
    data:{labels:['Match','Diff','Missing','Extra'],datasets:[{data:[${s.match},${s.diff},${s.missing},${s.extra}],backgroundColor:['#639922','#E24B4A','#BA7517','#378ADD'],borderWidth:0}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},cutout:'68%'}
  });

  const topCritical = ${JSON.stringify(report.results.filter(r=>r.status==='diff').sort((a,b)=>b.summary.critical-a.summary.critical).slice(0,6).map(r=>({name:r.name.slice(0,20),c:r.summary.critical,w:r.summary.warnings})))};
  new Chart(document.getElementById('bar'), {
    type:'bar',
    data:{labels:topCritical.map(r=>r.name),datasets:[
      {label:'Critical',data:topCritical.map(r=>r.c),backgroundColor:'#E24B4A',borderRadius:4,borderWidth:0},
      {label:'Warning', data:topCritical.map(r=>r.w),backgroundColor:'#BA7517',borderRadius:4,borderWidth:0}
    ]},
    options:{responsive:true,maintainAspectRatio:false,indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{ticks:{stepSize:1,color:'#888',font:{size:10}},grid:{color:'rgba(0,0,0,.06)'}},y:{ticks:{color:'#888',font:{size:10}},grid:{display:false}}}}
  });

  function toggleRow(i) {
    const det = document.getElementById('det-'+i);
    if (!det) return;
    const open = det.style.display === 'table-row';
    det.style.display = open ? 'none' : 'table-row';
    const rows = document.querySelectorAll('.main-row');
    if (rows[i]) {
      const chev = rows[i].querySelector('td:first-child');
      if (chev) chev.innerHTML = open ? '&#9654;' : '&#9660;';
    }
  }

  let currentFilter = 'all';
  function setFilter(f, btn) {
    currentFilter = f;
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    applyFilters();
  }

  function doSearch(v) { applyFilters(v); }

  function applyFilters(search) {
    const q = (search || document.getElementById('search').value || '').toLowerCase();
    document.querySelectorAll('.main-row').forEach(row => {
      const status   = row.dataset.status;
      const severity = row.dataset.severity;
      const name     = row.dataset.name || '';
      let show = true;
      if (currentFilter === 'critical') show = severity === 'critical';
      else if (currentFilter !== 'all') show = status === currentFilter;
      if (q && !name.includes(q)) show = false;
      row.style.display = show ? '' : 'none';
      const detId = row.getAttribute('onclick')?.match(/\d+/)?.[0];
      const det = detId ? document.getElementById('det-'+detId) : null;
      if (det && !show) det.style.display = 'none';
    });
  }
</script>
</body>
</html>`;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) out[argv[i].replace(/^--/,'')] = argv[i+1];
  return out;
}

// ─── Run pipeline ─────────────────────────────────────────────────────────────
(async () => {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  // Step 1: Extract Figma
  console.log('\n📐 Step 1: Extracting Figma JSON...');
  const figmaRaw  = JSON.parse(fs.readFileSync(path.resolve(FIGMA_FILE), 'utf-8'));
  const figmaData = extractFigmaTree(figmaRaw);
  fs.writeFileSync(path.join(OUT_DIR, 'figma-normalised.json'), JSON.stringify(figmaData, null, 2));
  console.log(`   ✅ ${figmaData.totalNodes} Figma nodes extracted`);

  // Step 2: Extract browser
  console.log('\n🎭 Step 2: Extracting browser UI...');
  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const context = await browser.newContext({
    viewport: IS_MOBILE ? { width:360, height:800 } : { width:1440, height:900 },
    deviceScaleFactor: IS_MOBILE ? 2 : 1,
    isMobile: IS_MOBILE, hasTouch: IS_MOBILE,
    userAgent: IS_MOBILE
      ? 'Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36'
      : 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
  });
  const page = await context.newPage();
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(EXTRA_WAIT);
  const browserData = await page.evaluate(EXTRACTION_SCRIPT, { rootSel: ROOT_SEL, maxDepth: MAX_DEPTH });
  await browser.close();
  fs.writeFileSync(path.join(OUT_DIR, 'browser-normalised.json'), JSON.stringify(browserData, null, 2));
  console.log(`   ✅ ${browserData.nodes.length} browser nodes extracted`);

  // Step 3: Compare
  console.log('\n⚙️  Step 3: Running comparison engine...');
  const report = compareNodes(figmaData, browserData);
  fs.writeFileSync(path.join(OUT_DIR, 'diff-report.json'), JSON.stringify(report, null, 2));

  // Step 4: HTML report
  console.log('\n📄 Step 4: Generating HTML report...');
  const html = generateHtmlReport(report);
  const htmlPath = path.join(OUT_DIR, 'diff-report.html');
  fs.writeFileSync(htmlPath, html);

  console.log(`\n✅ Pipeline complete!`);
  console.log(`   📁 Output directory : ${OUT_DIR}`);
  console.log(`   📊 HTML report      : ${htmlPath}`);
  console.log(`   🎯 Fidelity score   : ${report.summary.fidelityScore}%`);
  console.log(`   🔴 Critical issues  : ${report.summary.criticalCount}`);
  console.log(`   🟡 Warnings         : ${report.summary.warningCount}\n`);

  if (AUTO_OPEN) {
    const open = require('child_process').spawn;
    const cmd = process.platform === 'win32' ? 'start' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    open(cmd, [htmlPath], { shell: true });
  }
})();
