/**
 * ============================================================
 * extract-ui.ts  —  MASTER QA COMPARISON TOOL
 * Compares Figma JSON design vs live browser rendering
 * ============================================================
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";
import { chromium } from "playwright";

// ============================================================
// ARGS
// ============================================================
type Args = {
  url: string;
  outDir: string;
  headless: boolean;
};

function parseArgs(): Args {
  const args: Args = {
    url: "https://your-url-here.com",
    outDir: ".",
    headless: false,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--url") args.url = argv[++i];
    else if (a === "--outDir") args.outDir = argv[++i];
    else if (a === "--headless") args.headless = true;
  }
  return args;
}

function timestampId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

// ============================================================
// SHARED HELPERS
// ============================================================
function hexToRgba(hex: string | null): { r: number; g: number; b: number; a: number } {
  if (!hex || !hex.startsWith("#") || hex.length < 7) return { r: 0, g: 0, b: 0, a: 1 };
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  return { r, g, b, a: 1 };
}

function normalizeFontFamily(fontFamily: string): string {
  if (!fontFamily) return "";
  return fontFamily.split(",")[0].replace(/['"]/g, "").trim();
}

/**
 * Normalize text for matching:
 * lowercase, collapse whitespace, trim
 */
function normText(s: string | null | undefined): string {
  return (s || "")
    .replace(/\u00A0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function safeReadJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

// ============================================================
// DOM -> RAW EXTRACTION  (runs inside browser via page.evaluate)
// ============================================================
async function extractDom(page: any): Promise<any> {
  return await page.evaluate(() => {
    const round = (n: number) => Math.round(n);
    const px = (v: string) => (v ? parseFloat(v) : 0);

    const toHex = (rgb: string): string => {
      const m = rgb.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/i);
      if (!m) return rgb;
      const r = Number(m[1]).toString(16).padStart(2, "0");
      const g = Number(m[2]).toString(16).padStart(2, "0");
      const b = Number(m[3]).toString(16).padStart(2, "0");
      return `#${r}${g}${b}`.toUpperCase();
    };

    const isVisible = (el: Element): boolean => {
      const style = window.getComputedStyle(el);
      const rect = (el as HTMLElement).getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        style.opacity !== "0" &&
        rect.width > 0 &&
        rect.height > 0
      );
    };

    const pickFillColor = (style: CSSStyleDeclaration): string | null => {
      const bg = style.backgroundColor;
      if (bg && bg !== "rgba(0, 0, 0, 0)" && bg !== "transparent") return toHex(bg);
      const color = style.color;
      if (color) return toHex(color);
      return null;
    };

    /**
     * getTextBounds kept for reference but NOT used in layout comparison.
     * Figma stores absoluteBoundingBox as the full layout frame (with lineHeight).
     * Browser getBoundingClientRect() also returns the full layout box.
     * So we match them directly — no tight glyph measurement needed.
     */

    // Selectors to capture
    const selector = [
      "button", "a[href]", "input", "textarea", "select",
      "h1,h2,h3,h4,h5,h6", "p", "label", "span", "li",
      "[role='button']", "[role='link']", "[role='heading']", "[role='textbox']",
      "[data-testid]", "[id]", "[aria-label]", "svg",
    ].join(",");

    const all = Array.from(document.querySelectorAll(selector));

    const candidates = all
      .filter(isVisible)
      .filter((el) => {
        const element = el as HTMLElement;
        const text = (element.innerText || element.textContent || "").trim();
        const hasText = text.length > 0;
        const tag = element.tagName;
        const isInteractive = ["BUTTON", "A", "INPUT", "TEXTAREA", "SELECT"].includes(tag);
        const hasRole = element.hasAttribute("role");
        const hasId = element.hasAttribute("data-testid") || element.hasAttribute("id");
        const hasAria = element.hasAttribute("aria-label");
        const isSVG = tag === "SVG";
        return hasText || isInteractive || hasRole || hasId || hasAria || isSVG;
      });

    // Leaf filter: drop parents that contain other meaningful candidates
    const leaf = candidates.filter((el) => {
      const element = el as HTMLElement;
      for (const other of candidates) {
        if (other === el) continue;
        if (element.contains(other)) {
          const o = other as HTMLElement;
          const ot = (o.innerText || o.textContent || "").trim();
          const isOtherMeaningful = ot.length > 0 || o.hasAttribute("role") || o.hasAttribute("aria-label");
          if (isOtherMeaningful) return false;
        }
      }
      return true;
    });

    // Dedupe by text + position
    const out: any[] = [];
    const near = (a: number, b: number, tol = 2) => Math.abs(a - b) <= tol;

    for (const el of leaf) {
      const element = el as HTMLElement;
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();

      // Use scroll-corrected absolute position
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;

      const tag = element.tagName;
      const isSVG = tag === "SVG";
      const rawText = (element.innerText || element.textContent || "").trim();

      // Always use getBoundingClientRect for x/y/width/height.
      // This matches Figma's absoluteBoundingBox which is the layout box
      // (includes line-height for text, full element box for others).
      // We do NOT use tight glyph bounds — that was causing width mismatches
      // because Figma stores the full fixed-width text frame, not glyph width.
      const layout = {
        x: round(rect.x + scrollX),
        y: round(rect.y + scrollY),
        width: round(rect.width),
        height: round(rect.height),
      };

      const keyText = rawText.replace(/\s+/g, " ").trim();
      const dupe = out.find((o) => {
        return (
          (o.text || "").trim() === keyText &&
          near(o.layout.x, layout.x) &&
          near(o.layout.y, layout.y) &&
          near(o.layout.width, layout.width) &&
          near(o.layout.height, layout.height)
        );
      });
      if (dupe) continue;

      out.push({
        text: rawText,
        tag,
        id: element.id || null,
        name: element.getAttribute("aria-label") || element.getAttribute("data-testid") || rawText.substring(0, 50),
        layout,
        style: {
          fontSize: px(style.fontSize),
          fontWeight: style.fontWeight,
          fontFamily: style.fontFamily,
          color: toHex(style.color),
          textAlign: (style.textAlign || "left").toUpperCase(),
          letterSpacing: px(style.letterSpacing),
          lineHeight: style.lineHeight,
        },
        fills: pickFillColor(style)
          ? [{ type: "SOLID", color: toHex(style.color) }]
          : [],
        _source: { tag, id: element.id, nameAttr: element.getAttribute("name") },
      });
    }

    return {
      url: window.location.href,
      title: document.title,
      viewport: { width: 360, height: window.innerHeight },
      extractedAt: new Date().toISOString(),
      count: out.length,
      elements: out,
    };
  });
}

// ============================================================
// FIGMA -> DIFF ENGINE
// ============================================================
type RGBA = { r: number; g: number; b: number; a: number };

type DiffNode = {
  name: string;
  type?: string;
  fills?: { type: string; color?: RGBA }[];
  style?: {
    fontSize: number | null;
    fontWeight: string;
    fontFamily: string;
    letterSpacing?: number;
    textAlignHorizontal?: string;
    lineHeightPx?: number;
  };
  absoluteBoundingBox?: { x: number; y: number; width: number; height: number };
  _source?: any;
};

type DiffDoc = { document: { name: string; children: DiffNode[] } };

function rgbaToHex(c?: RGBA): string | null {
  if (!c) return null;
  const r = Math.round(c.r * 255).toString(16).padStart(2, "0");
  const g = Math.round(c.g * 255).toString(16).padStart(2, "0");
  const b = Math.round(c.b * 255).toString(16).padStart(2, "0");
  return ("#" + r + g + b).toUpperCase();
}

function getFillHex(node: DiffNode): string | null {
  const solid = node.fills?.find((f: any) => f.type === "SOLID");
  return rgbaToHex(solid?.color);
}

function safeBox(n: DiffNode): { x: number; y: number; width: number; height: number } {
  const bb = n.absoluteBoundingBox;
  const num = (x: any): number => (Number.isFinite(Number(x)) ? Math.round(Number(x)) : 0);
  return { x: num(bb?.x), y: num(bb?.y), width: num(bb?.width), height: num(bb?.height) };
}

function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/**
 * Convert Figma JSON -> DiffDoc
 * KEY FIX: For TEXT nodes, use absoluteBoundingBox (line-height box)
 * so height matches browser's getBoundingClientRect
 */
function figmaToDiff(figmaData: any): DiffDoc {
  const nodeIds = Object.keys(figmaData.nodes || {});
  if (nodeIds.length === 0) return { document: { name: "Figma design", children: [] } };

  const nodeId = nodeIds[0];
  const root = figmaData.nodes[nodeId].document;

  function extract(node: any, depth = 0): any[] {
    if (!node || depth > 30) return [];
    const out: any[] = [];

    // TEXT nodes
    if (node.type === "TEXT" && node.characters) {
      const t = String(node.characters).replace(/\s+/g, " ").trim();
      // Use absoluteBoundingBox for TEXT — this is the full layout frame
      // including lineHeight, matching browser's getBoundingClientRect().
      // absoluteRenderBounds is the tight glyph box (~16px for 18px font) — NOT what we want.
      const box = node.absoluteBoundingBox;
      if (t && t !== "undefined" && box) {
        out.push({
          name: t.substring(0, 50).trim(),
          type: "TEXT",
          fills: node.fills || [],
          style: {
            fontSize: node.style?.fontSize ?? null,
            fontWeight: String(node.style?.fontWeight ?? "400"),
            fontFamily: normalizeFontFamily(node.style?.fontFamily || ""),
            letterSpacing: node.style?.letterSpacing ?? 0,
            // ADDED: text alignment from Figma
            textAlignHorizontal: node.style?.textAlignHorizontal ?? "LEFT",
            lineHeightPx: node.style?.lineHeightPx ?? null,
          },
          absoluteBoundingBox: {
            x: Math.round(box.x),
            y: Math.round(box.y),
            width: Math.round(box.width),
            height: Math.round(box.height),
          },
          _source: { id: node.id, type: node.type },
        });
      }
    }

    // ICONS (VECTOR / BOOLEAN_OPERATION small elements)
    if (
      (node.type === "VECTOR" || node.type === "BOOLEAN_OPERATION") &&
      node.absoluteBoundingBox &&
      node.absoluteBoundingBox.width < 80 &&
      node.absoluteBoundingBox.height < 80
    ) {
      out.push({
        name: (node.name || "Icon").trim(),
        type: "SVG",
        fills: node.fills || [],
        style: { fontSize: null, fontWeight: "400", fontFamily: "", letterSpacing: 0 },
        absoluteBoundingBox: {
          x: Math.round(node.absoluteBoundingBox.x),
          y: Math.round(node.absoluteBoundingBox.y),
          width: Math.round(node.absoluteBoundingBox.width),
          height: Math.round(node.absoluteBoundingBox.height),
        },
        _source: { id: node.id, type: node.type },
      });
    }

    // Recurse children
    if (node.children && Array.isArray(node.children)) {
      for (const c of node.children) out.push(...extract(c, depth + 1));
    }
    return out;
  }

  const children = extract(root);
  return { document: { name: "Figma design", children } };
}

// ============================================================
// DOM -> DIFF ENGINE
// ============================================================
function domToDiff(domData: any): DiffDoc {
  const els = Array.isArray(domData.elements) ? domData.elements : [];

  const children = els
    .filter((el: any) => {
      const hasText = el.text && el.text.trim().length > 0 && el.text.trim() !== "undefined";
      const isMeaningful = ["BUTTON", "H1", "H2", "H3", "H4", "H5", "H6", "P", "LABEL", "A", "SPAN", "SVG"].includes(el.tag);
      return hasText || isMeaningful;
    })
    .map((el: any, index: number) => {
      const nameBase = el.text?.substring(0, 50).trim() || el.id || el.name || `${el.tag}-${index}`;
      const name = String(nameBase).replace(/\n/g, " ").replace(/\s+/g, " ").trim();

      return {
        name,
        type: el.tag || "ELEMENT",
        fills: el.style?.color
          ? [{ type: "SOLID", color: hexToRgba(el.style.color) }]
          : [],
        style: {
          fontSize: el.style?.fontSize ?? null,
          fontWeight: String(el.style?.fontWeight ?? "400"),
          fontFamily: normalizeFontFamily(el.style?.fontFamily || ""),
          letterSpacing: el.style?.letterSpacing ?? 0,
          textAlignHorizontal: (el.style?.textAlign || "LEFT").toUpperCase(),
          lineHeightPx: el.style?.lineHeight ? parseFloat(el.style.lineHeight) : null,
        },
        absoluteBoundingBox: {
          x: el.layout?.x ?? 0,
          y: el.layout?.y ?? 0,
          width: el.layout?.width ?? 0,
          height: el.layout?.height ?? 0,
        },
        _source: { tag: el.tag, id: el.id, nameAttr: el._source?.nameAttr },
      };
    });

  return { document: { name: "Browser extraction", children } };
}

// ============================================================
// ANCHOR NORMALIZATION
// Problem: Figma canvas coords are huge (e.g. x:4893, y:4055).
// Browser coords are viewport-relative (e.g. x:16, y:200).
// Solution: Find the FIRST text string that appears in BOTH Figma and DOM.
// Use that element's position as (0,0) in both systems.
// Then offset every other element relative to that anchor.
// This makes x/y values comparable (both relative to same on-screen element).
// IMPORTANT: Only x and y are shifted. width and height are NEVER touched.
// ============================================================
function normalizeByFirstMatchedText(
  figmaDiff: any,
  domDiff: any
): { figmaDiff: any; domDiff: any; anchor: { text: string; fig: { x: number; y: number }; dom: { x: number; y: number } } | null } {
  const figKids: any[] = figmaDiff.document.children || [];
  const domKids: any[] = domDiff.document.children || [];

  const figText: any[] = figKids.filter((e: any) => e.type === "TEXT" && normText(e.name).length > 2);
  const domText: any[] = domKids.filter((e: any) => normText(e.name).length > 2);

  // Build a map of DOM text -> nodes
  const domMap = new Map<string, any[]>();
  for (const d of domText) {
    const key = normText(d.name);
    if (!key) continue;
    if (!domMap.has(key)) domMap.set(key, []);
    domMap.get(key)!.push(d);
  }

  // Find a text string that exists in BOTH Figma and DOM with exact match.
  // That matched pair becomes the anchor — both sides get set to (0,0).
  // No "first" or "top-most" preference — just exact text match wins.
  let anchor: { key: string; f: any; d: any } | null = null;

  for (const f of figText) {
    const key = normText(f.name);
    if (!key || key.length < 2) continue;
    const domMatches = domMap.get(key);
    if (!domMatches || domMatches.length === 0) continue;
    // Found exact match in both — use first DOM match
    anchor = { key, f, d: domMatches[0] };
    break;
  }

  if (!anchor) {
    console.warn("⚠️  No exact text match found between Figma and DOM. Skipping anchor normalization.");
    console.warn("    Figma texts:", figText.slice(0, 5).map((f: any) => normText(f.name)));
    console.warn("    DOM texts:",   domText.slice(0, 5).map((d: any) => normText(d.name)));
    return { figmaDiff, domDiff, anchor: null };
  }

  // Record original anchor positions BEFORE any mutation
  const figAnchorX: number = Math.round(anchor.f.absoluteBoundingBox?.x ?? 0);
  const figAnchorY: number = Math.round(anchor.f.absoluteBoundingBox?.y ?? 0);
  const domAnchorX: number = Math.round(anchor.d.absoluteBoundingBox?.x ?? 0);
  const domAnchorY: number = Math.round(anchor.d.absoluteBoundingBox?.y ?? 0);

  console.log(`\n📍 Anchor text: "${anchor.key}"`);
  console.log(`   Figma canvas origin: (${figAnchorX}, ${figAnchorY})`);
  console.log(`   DOM viewport origin: (${domAnchorX}, ${domAnchorY})`);
  console.log(`   After normalization all coords become relative to this anchor.`);
  console.log(`   Any remaining x/y delta = real padding/margin difference between Figma and browser.`);

  // Shift all nodes so anchor = (0,0) in both coordinate systems.
  // After this: positive x/y = element is to the right/below anchor.
  // Negative x/y = element is to the left/above anchor.
  // width and height are NEVER modified.
  for (const f of figKids) {
    if (!f.absoluteBoundingBox) continue;
    f.absoluteBoundingBox.x = Math.round(f.absoluteBoundingBox.x - figAnchorX);
    f.absoluteBoundingBox.y = Math.round(f.absoluteBoundingBox.y - figAnchorY);
  }
  for (const d of domKids) {
    if (!d.absoluteBoundingBox) continue;
    d.absoluteBoundingBox.x = Math.round(d.absoluteBoundingBox.x - domAnchorX);
    d.absoluteBoundingBox.y = Math.round(d.absoluteBoundingBox.y - domAnchorY);
  }

  return {
    figmaDiff,
    domDiff,
    anchor: {
      text: anchor.key,
      fig: { x: figAnchorX, y: figAnchorY },
      dom: { x: domAnchorX, y: domAnchorY },
    },
  };
}

// ============================================================
// TYPES FOR COMPARISON
// ============================================================
type Comparable = {
  fillColor: string | null;
  fontSize: number | null;
  fontWeight: string;
  fontFamily: string;
  letterSpacing: number;
  textAlign: string;
  x: number;
  y: number;
  width: number;
  height: number;
};

function toComparable(n: DiffNode): Comparable {
  const bb = safeBox(n);
  return {
    fillColor: getFillHex(n),
    fontSize: n.style?.fontSize ?? null,
    fontWeight: String(n.style?.fontWeight ?? "400"),
    fontFamily: normalizeFontFamily(n.style?.fontFamily || ""),
    letterSpacing: n.style?.letterSpacing ?? 0,
    // ADDED: textAlign comparison
    textAlign: (n.style?.textAlignHorizontal ?? "LEFT").toUpperCase(),
    x: bb.x,
    y: bb.y,
    width: bb.width,
    height: bb.height,
  };
}

// status: "fail" = real QA issue | "info" = x/y coords (informational) | "ok" = matches
type DiffResult = { prop: keyof Comparable; a: any; b: any; delta?: number; status: "fail" | "info" | "ok" };

/**
 * x/y = INFO only (never fail). Coordinate systems can't be perfectly
 * aligned between Figma canvas and browser viewport — residual offset
 * always exists due to body margins, headers, DPR. Show for context only.
 * width/height = FAIL if delta > 4px.
 * all other props (color, font) = exact match, FAIL if different.
 */
function diffComparable(a: Comparable, b: Comparable): DiffResult[] {
  const results: DiffResult[] = [];
  const SIZE_TOL = 4;

  (Object.keys(a) as (keyof Comparable)[]).forEach((k) => {
    const av = a[k];
    const bv = b[k];

    if (k === "x" || k === "y") {
      const delta = Math.abs(Number(av) - Number(bv));
      results.push({ prop: k, a: av, b: bv, delta, status: delta > 2 ? "info" : "ok" });
      return;
    }

    if (k === "width" || k === "height") {
      const delta = Math.abs(Number(av) - Number(bv));
      results.push({ prop: k, a: av, b: bv, delta, status: delta > SIZE_TOL ? "fail" : "ok" });
      return;
    }

    const same = typeof av === "number" && typeof bv === "number"
      ? av === bv
      : String(av ?? "") === String(bv ?? "");

    const delta = typeof av === "number" && typeof bv === "number" ? Math.abs(av - bv) : undefined;
    results.push({ prop: k, a: av, b: bv, delta, status: same ? "ok" : "fail" });
  });

  return results;
}

// ============================================================
// NODE MATCHING
// Match figma nodes to DOM nodes by text + proximity
// ============================================================
function matchNodes(
  aNodes: DiffNode[],
  bNodes: DiffNode[]
): { matches: { a: DiffNode; b: DiffNode | undefined }[]; leftoversB: DiffNode[] } {
  // Build map: normalised text -> DOM nodes
  const bByText = new Map<string, DiffNode[]>();
  for (const b of bNodes) {
    const key = normText(b.name);
    if (!key) continue;
    if (!bByText.has(key)) bByText.set(key, []);
    bByText.get(key)!.push(b);
  }

  // Sort figma nodes top-to-bottom, left-to-right
  const orderedA = [...aNodes].sort((n1, n2) => {
    const b1 = safeBox(n1), b2 = safeBox(n2);
    if (b1.y !== b2.y) return b1.y - b2.y;
    return b1.x - b2.x;
  });

  const usedB = new Set<DiffNode>();
  const matches: { a: DiffNode; b: DiffNode | undefined }[] = [];

  for (const a of orderedA) {
    const key = normText(a.name);
    const candidates = (bByText.get(key) || []).filter((x) => !usedB.has(x));

    if (!key || candidates.length === 0) {
      matches.push({ a, b: undefined });
      continue;
    }

    const ab = safeBox(a);
    let best = candidates[0];
    let bestD = Infinity;

    for (const c of candidates) {
      const cb = safeBox(c);
      const d = dist2(ab.x, ab.y, cb.x, cb.y);
      if (d < bestD) { bestD = d; best = c; }
    }

    usedB.add(best);
    matches.push({ a, b: best });
  }

  const leftoversB = bNodes.filter((b) => !usedB.has(b));
  return { matches, leftoversB };
}

// ============================================================
// COMPARE AND REPORT
// ============================================================
function compareAndReport(aDoc: DiffDoc, bDoc: DiffDoc): string {
  const A = aDoc.document.children || [];
  const B = bDoc.document.children || [];

  const aFiltered = A.filter((n) => normText(n.name).length > 0 || normText(n.type) === "svg");
  const bFiltered = B.filter((n) => normText(n.name).length > 0 || normText(n.type) === "svg");

  const { matches, leftoversB } = matchNodes(aFiltered, bFiltered);

  let totalCompared = 0;
  let totalFails = 0;
  let totalMissingInB = 0;
  const totalMissingInA = leftoversB.length;

  const lines: string[] = [];
  const log = (s = "") => lines.push(s);

  for (const pair of matches) {
    const aName = String(pair.a.name ?? "").trim();

    if (!pair.b) {
      totalMissingInB++;
      log(aName);
      log(`tag: ${pair.a.type}`);
      log("missing in B  — not found in browser DOM");
      log("");
      continue;
    }

    totalCompared++;
    const ac = toComparable(pair.a);
    const bc = toComparable(pair.b);
    const results = diffComparable(ac, bc);

    const fails = results.filter((r) => r.status === "fail");
    const infos = results.filter((r) => r.status === "info");
    const oks   = results.filter((r) => r.status === "ok");

    if (fails.length === 0) {
      log(aName);
      log(`tag: ${pair.b.type}`);
      if (infos.length > 0) {
        log(`match ✅  (${infos.length} coord offset${infos.length > 1 ? "s" : ""} — info only)`);
        log(`Property        Design (A)      Browser (B)     Status`);
        for (const r of oks)    log(`${r.prop}\t${r.a}\t${r.b}\tok`);
        for (const r of infos)  log(`${r.prop}\t${r.a}\t${r.b}\tinfo Δ${r.delta?.toFixed(0)}`);
      } else {
        log("match ✅ (no diffs)");
      }
      log("");
      continue;
    }

    totalFails += fails.length;
    log(aName);
    log(`tag: ${pair.b.type}`);
    log("diff ❌");
    log(`${fails.length} propert${fails.length === 1 ? "y" : "ies"} differ`);
    log(`Property\tDesign (A)\tBrowser (B)\tStatus`);

    // Show failures first
    for (const r of fails) {
      const deltaStr = typeof r.delta === "number" ? `  Δ${r.delta.toFixed(1)}` : "";
      log(`${r.prop}\t${String(r.a)}\t${String(r.b)}\tchanged${deltaStr}`);
    }
    // Then ok props
    for (const r of oks) {
      log(`${r.prop}\t${String(r.a)}\t${String(r.b)}\tok`);
    }
    // Then info (x/y coords) at the bottom, clearly labelled
    if (infos.length > 0) {
      log(`--- position info (not a failure) ---`);
      for (const r of infos) {
        log(`${r.prop}\t${String(r.a)}\t${String(r.b)}\tinfo Δ${r.delta?.toFixed(0)}`);
      }
    }
    log("");
  }

  if (totalMissingInA > 0) {
    log("---");
    log(`Extra nodes in Browser (not in Design): ${totalMissingInA}`);
    log("");
    leftoversB.slice(0, 20).forEach((b) => {
      log(`${String(b.name ?? "").trim()}`);
      log("missing in A  — not found in figma JSON");
      log("");
    });
    if (totalMissingInA > 20) log(`(and ${totalMissingInA - 20} more)\n`);
  }

  log("========== SUMMARY ==========");
  log(`Compared: ${totalCompared}`);
  log(`Total failures: ${totalFails}`);
  log(`Missing in Browser (B): ${totalMissingInB}`);
  log(`Missing in Design (A): ${totalMissingInA}`);
  log("==============================");

  return lines.join("\n");
}

// ============================================================
// MAIN
// ============================================================
(async () => {
  const args = parseArgs();
  const ts = timestampId();
  const outDir = args.outDir;

  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  // Launch browser
  const browser = await chromium.launch({
    headless: args.headless,
    channel: "chrome",
  });

  const context = await browser.newContext({
    viewport: { width: 360, height: 750 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (Linux; Android 11; Pixel 5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/90.0.4430.91 Mobile Safari/537.36",
  });

  const page = await context.newPage();
  await page.goto(args.url, { waitUntil: "domcontentloaded", timeout: 60000 });

  // Wait for user to interact / navigate if headless=false
  if (!args.headless) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    await new Promise<void>((resolve) => {
      rl.question("Press ENTER to capture... ", () => {
        rl.close();
        resolve();
      });
    });
  }

  // Screenshot
  const screenshotPath = path.join(outDir, `screenshot-mobile-360-${ts}.png`);
  console.log(`\n📸 Taking screenshot...`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  // Extract DOM
  const domRaw = await extractDom(page);
  const domJsonPath = path.join(outDir, `ui-extraction-mobile-360-${ts}.json`);
  fs.writeFileSync(domJsonPath, JSON.stringify(domRaw, null, 2));

  // Load Figma JSON (hardcoded path — change to your file)
  const figmaPath = path.resolve(__dirname, "funding-figma.json");
  if (!fs.existsSync(figmaPath)) {
    console.error(`❌ Figma file not found: ${figmaPath}`);
    process.exit(1);
  }

  const figmaData = safeReadJson(figmaPath);
  const figmaDiff = figmaToDiff(figmaData);
  const domDiff = domToDiff(domRaw);

  // Normalize coordinate systems
  const normalized = normalizeByFirstMatchedText(figmaDiff, domDiff);

  // Save intermediate diff files
  fs.writeFileSync(path.join(outDir, "diff-engine-a.json"), JSON.stringify(normalized.figmaDiff, null, 2));
  fs.writeFileSync(path.join(outDir, "diff-engine-b.json"), JSON.stringify(normalized.domDiff, null, 2));

  // Run comparison
  const report = compareAndReport(
    normalized.figmaDiff as DiffDoc,
    normalized.domDiff as DiffDoc
  );

  const reportPath = path.join(outDir, `v1-compare-report-${ts}.txt`);
  fs.writeFileSync(reportPath, report, "utf-8");

  console.log("\n" + report);
  console.log(`\n✅ Report saved: ${reportPath}`);

  await browser.close();
})();
