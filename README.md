# UI Diff Engine

Figma design ↔ Browser UI property comparison tool.
Extracts padding, relative X/Y, typography, colors, sizing from both sources and generates a severity-graded HTML report.

---

## Files

| File | What it does |
|---|---|
| `figma-extractor.js` | Parses Figma REST API JSON → normalised node list |
| `browser-extractor.js` | Playwright script → extracts same props from live browser |
| `compare-engine.js` | Diffs the two normalised JSONs → structured report |
| `run-pipeline.js` | Runs all 3 steps end-to-end → HTML report |

---

## Install

```bash
npm install
npx playwright install chromium
```

---

## Usage

### Full pipeline (recommended)

```bash
node run-pipeline.js \
  --figma   figma-export.json \
  --url     https://dss-r3.bmbdss.sit.dss.ife.ninja/your-app \
  --out     ./reports \
  --mobile  true \
  --wait    2000
```

### Step by step

```bash
# 1. Extract Figma
node figma-extractor.js --input figma-export.json --output figma-normalised.json

# 2. Extract browser
node browser-extractor.js --url https://your-app.com --output browser-normalised.json --mobile true

# 3. Compare
node compare-engine.js --figma figma-normalised.json --browser browser-normalised.json --output diff-report.json
```

---

## What gets compared

| Property | Source | Tolerance | Severity |
|---|---|---|---|
| width / height | Both | ±2px | 🔴 Critical |
| relX / relY (relative to parent) | Both | ±4px | 🟡 Warning |
| padding.top/right/bottom/left | Both | ±2px | 🟡 Warning |
| fillColor | Both | RGB dist 0.05 | 🔴 Critical |
| fontSize | Both | ±1px | 🔴 Critical |
| fontWeight | Both | exact | 🟡 Warning |
| fontFamily | Both | primary only | 🟡 Warning |
| cornerRadius | Both | ±2px | 🔵 Info |
| letterSpacing | Both | ±0.5 | 🔵 Info |
| lineHeight | Both | ±2px | 🔵 Info |
| opacity | Both | ±0.05 | 🟡 Warning |
| itemSpacing (gap) | Both | ±2px | 🔵 Info |
| strokeColor / strokeWeight | Both | RGB dist 0.05 | 🔵 Info |

### What is intentionally ignored
- Absolute page X/Y (meaningless across coordinate systems)
- Font family fallback chains (`Barclays Effra, Arial` → compares only `Barclays Effra`)
- Opacity = 1 (default, not flagged)
- Elements with zero width AND zero height

---

## Output

```
reports/
  figma-normalised.json    ← normalised Figma nodes
  browser-normalised.json  ← normalised browser nodes
  diff-report.json         ← structured diff data
  diff-report.html         ← interactive HTML report (open this!)
```

---

## Getting Figma JSON

Option 1 — Figma REST API:
```
GET https://api.figma.com/v1/files/{file_key}
Headers: X-Figma-Token: YOUR_TOKEN
```

Option 2 — Figma plugin "Figma to JSON" → export → save as `figma-export.json`

Option 3 — Dev Mode → Inspect panel → copy JSON
