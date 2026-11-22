// Score TumourLens outlines against the SpheroScan experts' outlines.
// Uses the exact same segment.js the web tool runs.
// Run: node tools/validate.mjs [--json]   -> web/data/validation.json
import fs from "node:fs";
import path from "node:path";
import jpeg from "jpeg-js";
import { segment, polygonMask, overlap, DEFAULTS } from "../web/segment.js";

const SETS = [
  { name: "IncuCyte", dir: "data/spheroscan/IncuCyte/test" },
  { name: "Microscope", dir: "data/spheroscan/microscope/val" },
];

const opts = {};
for (const a of process.argv.slice(2)) {
  const [k, v] = a.replace(/^--/, "").split("=");
  if (k in DEFAULTS || k === "every") opts[k] = Number(v);
  if (k === "holdout") opts.holdout = true;
}

const results = [];
for (const set of SETS) {
  let ann = JSON.parse(fs.readFileSync(path.join(set.dir, ".ipynb_checkpoints/via_region_data-checkpoint.json"), "utf8"));
  ann = Array.isArray(ann) ? ann : Object.values(ann);
  for (const [idx, a] of ann.entries()) {
    if (opts.every && idx % opts.every) continue;
    if (opts.holdout && idx % 3 === 0) continue; // every 3rd image was used for tuning; report on the rest
    const file = path.join(set.dir, a.filename);
    if (!fs.existsSync(file) || !a.regions?.length) continue;
    const img = jpeg.decode(fs.readFileSync(file), { useTArray: true, maxMemoryUsageInMB: 2048 });
    const r = segment(img.data, img.width, img.height, opts);
    const truth = new Uint8Array(r.w * r.h);
    for (const reg of a.regions) {
      const s = reg.shape_attributes;
      const pm = polygonMask(s.all_points_x, s.all_points_y, r.w, r.h, r.scale);
      for (let i = 0; i < pm.length; i++) if (pm[i]) truth[i] = 1;
    }
    const o = overlap(r.mask, truth);
    results.push({ set: set.name, file: a.filename, ...o, nTruth: a.regions.length, nFound: r.objects.length });
  }
}

const summarize = (rows) => {
  const d = rows.map((r) => r.dice).sort((x, y) => x - y);
  const mean = (k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
  return { n: rows.length, dice_mean: +mean("dice").toFixed(3), dice_median: +d[Math.floor(d.length / 2)].toFixed(3),
           iou_mean: +mean("iou").toFixed(3), good: rows.filter((r) => r.dice >= 0.8).length,
           area_ratio_median: +rows.map((r) => r.areaRatio).sort((x, y) => x - y)[Math.floor(rows.length / 2)].toFixed(3) };
};
const summary = {};
for (const s of SETS) summary[s.name] = summarize(results.filter((r) => r.set === s.name));
summary.All = summarize(results);
console.log(JSON.stringify(opts), JSON.stringify(summary));

if (process.argv.includes("--json")) {
  fs.mkdirSync("web/data", { recursive: true });
  fs.writeFileSync("web/data/validation.json", JSON.stringify({ settings: { ...DEFAULTS, ...opts }, summary,
    images: results.map((r) => ({ set: r.set, file: r.file, dice: +r.dice.toFixed(3), iou: +r.iou.toFixed(3) })) }));
  console.log("wrote web/data/validation.json");
}
