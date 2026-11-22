# TumourLens

Measure spheroids from microscope images and turn a plate map into dose-response curves, right in the browser. Images are never uploaded.

**Live tool:** https://tumourlens.netlify.app

## What it does
1. **Outlines spheroids automatically** in brightfield or phase-contrast images (single images or whole wells), then reports area, equivalent diameter and roundness. Sizes are in pixels, or in µm with a µm-per-pixel value.
2. **Lets you check every outline.** Untick wrong ones, and use one sensitivity slider when outlines run too big or too small.
3. **Plate map → curves.** Paste `file,condition,value`:
   - **Doses:** sizes are normalised to untreated wells and a four-parameter logistic curve gives the IC50. If the data don't support a fit, it says so instead of reporting a number.
   - **Times:** it plots growth.
4. **Exports** all measurements as CSV.

## How the outlining works
`web/segment.js` uses plain JavaScript with no machine learning or dependencies, so the same file runs in the browser and in the validation script. The steps:
1. **Fine-grain texture:** smooth brightness changes are removed first, then texture is measured with a local standard deviation, on a log scale. Spheroids are grainy; backgrounds and well walls are smooth.
2. **Threshold and clean up:** an automatic (Otsu) threshold, then morphological cleanup. Only small holes are filled, so a closed well rim can't fill the whole well.
3. **Keep spheroids, drop rims:** objects that don't fill their convex hull (rims, arcs) are rejected. If a spheroid touches the rim, a stronger opening separates it.

## Accuracy
Scored against expert-drawn outlines from the [SpheroScan](https://doi.org/10.5281/zenodo.7555467) data (Akshay et al., 2023, CC0). The one setting that was tuned (threshold ×1.2) was chosen on every third image; the results below are on the remaining two-thirds, which were never used for tuning.

| Images | Tested | Median Dice | Good outlines (Dice ≥ 0.8) |
|---|---|---|---|
| IncuCyte (whole-well) | 33 | 0.83 | 21 |
| Microscope (brightfield) | 59 | 0.75 | 22 |
| All | 92 | 0.78 | 43 |

**Limits:**
- **Reversed textures:** it fails when the spheroid is smoother than its background (for example, grainy debris around a smooth spheroid). A trained model such as SpheroScan's handles those cases better.
- **Size bias:** outlines tend to run slightly large (median area ratio about 1.4 against expert outlines). Relative comparisons, such as treated against control, are more reliable than absolute sizes.
- **Roundness:** a pixel-based estimate. Accurate for round shapes, and slightly generous for elongated ones.

## Run it
```bash
npm install                                             # jpeg-js, used only by the validation script
uv run python tools/fetch_spheroscan.py                 # ~90 MB of annotated images from Zenodo (range requests)
node tools/validate.mjs --holdout --json                # re-score, writes web/data/validation.json
npx http-server web                                     # open the tool locally
```

## Files
- `web/segment.js`: outlining and measurements (browser and Node).
- `web/fit.js`: four-parameter logistic fit (Nelder-Mead on log dose).
- `web/app.js`, `web/index.html`, `web/styles.css`: the tool.
- `web/examples/`: 12 downscaled SpheroScan images (CC0), picked from images the method outlines well.
- `tools/fetch_spheroscan.py`: downloads only the annotated images from the 1.1 GB Zenodo zip.
- `tools/validate.mjs`: scores outlines against the expert annotations.
