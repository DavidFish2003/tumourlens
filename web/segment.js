// TumourLens spheroid outlining. Pure JavaScript, no dependencies: the same file runs in the
// browser (the web tool) and in Node (tools/validate.mjs, which scores it against experts).
//
// Idea: spheroids are textured (grainy); backgrounds and well walls are smooth, even when bright.
// 1. grayscale at a fixed working size   2. local texture (standard deviation)
// 3. automatic threshold (Otsu)          4. clean up: remove thin rims, close gaps, fill holes
// 5. keep the main spheroid(s)           6. measure area, diameter, roundness

export const DEFAULTS = {
  workSize: 512,      // longest side used for analysis (px)
  texRadius: 4,       // texture window radius at working size
  thresholdScale: 1.2, // >1 = stricter (smaller outlines), <1 = looser. 1.2 was chosen on the tuning third of the test images
  openRadius: 3,      // removes thin bright structures such as the well rim
  closeRadius: 8,     // bridges gaps inside the spheroid
  minFraction: 0.15,  // also keep objects at least this fraction of the largest (multi-spheroid wells)
  borderMargin: 0.01, // ignore texture within this fraction of the image edge
  hpRadius: 3,        // removes smooth brightness changes before measuring texture
  maxFraction: 0.35,  // an outline bigger than this share of the image triggers re-thresholding
  maxHoleFraction: 0.05, // only fill enclosed gaps smaller than this share of the image
  minSolidity: 0.6,   // objects must fill at least this share of their convex hull (rejects rims/arcs)
  rescueRadii: [6, 10, 14], // openings tried to separate a spheroid from a rim it touches
  minAreaFraction: 0.004, // ignore specks and labels smaller than this share of the image
};

/** Area of the convex hull of integer points (Andrew's monotone chain + shoelace). */
function hullArea(points) {
  if (points.length < 3) return points.length;
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [], upper = [];
  for (const q of p) { while (lower.length >= 2 && cross(lower.at(-2), lower.at(-1), q) <= 0) lower.pop(); lower.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (upper.length >= 2 && cross(upper.at(-2), upper.at(-1), q) <= 0) upper.pop(); upper.push(q); }
  const hull = lower.slice(0, -1).concat(upper.slice(0, -1));
  let a = 0;
  for (let i = 0; i < hull.length; i++) { const [x1, y1] = hull[i], [x2, y2] = hull[(i + 1) % hull.length]; a += x1 * y2 - x2 * y1; }
  return Math.abs(a) / 2 + hull.length / 2; // + half-perimeter approx so pixel areas compare fairly
}

/** Box blur via integral image. */
function boxBlur(g, w, h, r) {
  const W = w + 1, S = new Float64Array(W * (h + 1)), out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    let a = 0;
    for (let x = 0; x < w; x++) { a += g[y * w + x]; S[(y + 1) * W + x + 1] = S[y * W + x + 1] + a; }
  }
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      out[y * w + x] = (S[y1 * W + x1] - S[y0 * W + x1] - S[y1 * W + x0] + S[y0 * W + x0]) / ((y1 - y0) * (x1 - x0));
    }
  }
  return out;
}

/** Downscale RGBA pixels to a grayscale Float32Array of at most workSize on the long side. */
export function toGray(rgba, width, height, workSize) {
  const s = Math.min(1, workSize / Math.max(width, height));
  const w = Math.max(1, Math.round(width * s)), h = Math.max(1, Math.round(height * s));
  const g = new Float32Array(w * h);
  const sx = width / w, sy = height / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let sum = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = (yy * width + xx) * 4;
        sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]; n++;
      }
      g[y * w + x] = sum / n;
    }
  }
  return { g, w, h, scale: s };
}

/** Local standard deviation with a (2r+1)^2 box, via integral images. */
function localStd(g, w, h, r) {
  const W = w + 1, S = new Float64Array(W * (h + 1)), S2 = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let a = 0, b = 0;
    for (let x = 0; x < w; x++) {
      const v = g[y * w + x]; a += v; b += v * v;
      S[(y + 1) * W + x + 1] = S[y * W + x + 1] + a;
      S2[(y + 1) * W + x + 1] = S2[y * W + x + 1] + b;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const n = (y1 - y0) * (x1 - x0);
      const s = S[y1 * W + x1] - S[y0 * W + x1] - S[y1 * W + x0] + S[y0 * W + x0];
      const s2 = S2[y1 * W + x1] - S2[y0 * W + x1] - S2[y1 * W + x0] + S2[y0 * W + x0];
      out[y * w + x] = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
    }
  }
  return out;
}

/** Otsu's threshold over a Float32Array (256 bins between min and max). */
function otsu(v) {
  let lo = Infinity, hi = -Infinity;
  for (const x of v) { if (x < lo) lo = x; if (x > hi) hi = x; }
  const bins = new Float64Array(256), span = hi - lo || 1;
  for (const x of v) bins[Math.min(255, Math.floor(((x - lo) / span) * 256))]++;
  const total = v.length;
  let sumAll = 0; for (let i = 0; i < 256; i++) sumAll += i * bins[i];
  let wB = 0, sumB = 0, best = 0, t = 0;
  for (let i = 0; i < 256; i++) {
    wB += bins[i]; if (!wB) continue;
    const wF = total - wB; if (!wF) break;
    sumB += i * bins[i];
    const mB = sumB / wB, mF = (sumAll - sumB) / wF, between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; t = i; }
  }
  return lo + ((t + 0.5) / 256) * span;
}

/** Binary dilation/erosion with a disk, done as a distance check on a square box (fast enough at 512px). */
function morph(m, w, h, r, dilate) {
  if (r <= 0) return m;
  const out = new Uint8Array(w * h), off = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) off.push([dx, dy]);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let hit = !dilate;
    for (const [dx, dy] of off) {
      const xx = x + dx, yy = y + dy;
      const v = xx >= 0 && yy >= 0 && xx < w && yy < h ? m[yy * w + xx] : 0;
      if (dilate ? v : !v) { hit = dilate; break; }
    }
    out[y * w + x] = hit ? 1 : 0;
  }
  return out;
}
const open = (m, w, h, r) => morph(morph(m, w, h, r, false), w, h, r, true);
const close = (m, w, h, r) => morph(morph(m, w, h, r, true), w, h, r, false);

/**
 * Fill holes smaller than maxHole pixels. Large enclosed regions (such as the inside of a
 * well whose rim forms a closed ring) are left empty.
 */
function fillHoles(m, w, h, maxHole) {
  const out = m.slice(), seen = new Uint8Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (m[s] || seen[s]) continue;
    const region = [s], stack = [s]; seen[s] = 1; let touchesBorder = false;
    while (stack.length) {
      const i = stack.pop(), x = i % w, y = (i - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touchesBorder = true;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
        if (j >= 0 && !m[j] && !seen[j]) { seen[j] = 1; stack.push(j); region.push(j); }
      }
    }
    if (!touchesBorder && region.length <= maxHole) for (const i of region) out[i] = 1;
  }
  return out;
}

/** 4-connected components; returns label image and per-component pixel counts. */
function components(m, w, h) {
  const lab = new Int32Array(w * h), sizes = [0];
  let n = 0;
  for (let s = 0; s < w * h; s++) {
    if (!m[s] || lab[s]) continue;
    n++; let size = 0; const stack = [s]; lab[s] = n;
    while (stack.length) {
      const i = stack.pop(), x = i % w; size++;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i - w, i + w]) {
        if (j >= 0 && j < w * h && m[j] && !lab[j]) { lab[j] = n; stack.push(j); }
      }
    }
    sizes.push(size);
  }
  return { lab, sizes, n };
}

/** Pixels on the object boundary (4-neighbourhood), used for perimeter. */
/**
 * Perimeter estimate: count pixel edges between object and background, times pi/4.
 * Edge counts overestimate a smooth curve's length by 4/pi on average (a disk of radius r has
 * ~8r edges vs a true 2*pi*r), so the correction gives an unbiased length for round shapes.
 */
function perimeter(m, w, h) {
  let edges = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x; if (!m[i]) continue;
    if (x === 0 || !m[i - 1]) edges++;
    if (x === w - 1 || !m[i + 1]) edges++;
    if (y === 0 || !m[i - w]) edges++;
    if (y === h - 1 || !m[i + w]) edges++;
  }
  return edges * Math.PI / 4;
}

/**
 * Outline spheroids in one image.
 * @param rgba  Uint8ClampedArray/Uint8Array RGBA pixels
 * @returns { mask (Uint8Array at working size), w, h, scale, objects: [{areaPx, diameterPx, circularity}], ... }
 */
export function segment(rgba, width, height, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const { g, w, h, scale } = toGray(rgba, width, height, o.workSize);
  // Fine-grain texture: remove smooth brightness changes first (high-pass), so well walls and
  // illumination gradients don't look like spheroids; a single edge becomes a thin line that opening removes.
  const blur = boxBlur(g, w, h, o.hpRadius);
  const hp = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) hp[i] = g[i] - blur[i];
  const tex = localStd(hp, w, h, o.texRadius);
  // Log scale so one very strong structure (like a well rim) can't set the threshold for everything.
  for (let i = 0; i < w * h; i++) tex[i] = Math.log1p(tex[i]);
  const margin = Math.round(o.borderMargin * Math.max(w, h));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x < margin || y < margin || x >= w - margin || y >= h - margin) tex[y * w + x] = 0;
  }
  const build = (t) => {
    let m = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) m[i] = tex[i] > t ? 1 : 0;
    m = open(m, w, h, o.openRadius);
    m = close(m, w, h, o.closeRadius);
    return fillHoles(m, w, h, o.maxHoleFraction * w * h);
  };
  let t = otsu(tex) * o.thresholdScale;
  let m = build(t);
  // If the outline swallows most of the image (e.g. the whole well interior), the first threshold
  // separated "outside the well" from "inside". Re-threshold using only the texture inside it.
  for (let pass = 0; pass < 2; pass++) {
    let area = 0; for (let i = 0; i < w * h; i++) area += m[i];
    if (area < o.maxFraction * w * h) break;
    const inside = []; for (let i = 0; i < w * h; i++) if (m[i]) inside.push(tex[i]);
    t = otsu(Float32Array.from(inside)) * o.thresholdScale;
    m = build(t);
  }

  const minArea = o.minAreaFraction * w * h;
  // Split a mask into objects; each is {pix: Uint8Array mask, area, solidity}.
  // Solidity = area / convex hull area: rings and arcs (well rims, wall edges) score low.
  const objectsOf = (mm) => {
    const { lab, sizes, n } = components(mm, w, h);
    const pts = Array.from({ length: n + 1 }, () => []);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const k = lab[y * w + x];
      if (k && (x === 0 || x === w - 1 || lab[y * w + x - 1] !== k || lab[y * w + x + 1] !== k)) pts[k].push([x, y]);
    }
    const out = [];
    for (let k = 1; k <= n; k++) {
      if (sizes[k] < minArea) continue;
      const pix = new Uint8Array(w * h);
      for (let i = 0; i < w * h; i++) if (lab[i] === k) pix[i] = 1;
      out.push({ pix, area: sizes[k], solidity: Math.min(1, sizes[k] / Math.max(1, hullArea(pts[k]))) });
    }
    return out;
  };
  let found = [];
  for (const ob of objectsOf(m)) {
    if (ob.solidity >= o.minSolidity) { found.push(ob); continue; }
    // Irregular object, e.g. a spheroid touching the well rim: strip thin parts with a
    // stronger opening and re-test the pieces that remain.
    for (const r of o.rescueRadii) {
      const pieces = objectsOf(open(ob.pix, w, h, r)).filter((p) => p.solidity >= o.minSolidity);
      if (pieces.length) { found.push(...pieces); break; }
    }
  }
  const largest = Math.max(0, ...found.map((f) => f.area));
  found = found.filter((f) => f.area >= o.minFraction * largest);
  const mask = new Uint8Array(w * h);
  const objects = [];
  for (const f of found) {
    const one = f.pix;
    for (let i = 0; i < w * h; i++) if (one[i]) mask[i] = 1;
    const area = f.area, per = perimeter(one, w, h);
    const P = per;
    objects.push({ areaPx: area / scale ** 2, diameterPx: 2 * Math.sqrt(area / Math.PI) / scale,
                   circularity: Math.min(1, (4 * Math.PI * area) / (P * P)) });
  }
  objects.sort((a, b) => b.areaPx - a.areaPx);
  return { mask, w, h, scale, threshold: t, objects };
}

/** Rasterize a polygon (image coordinates) into a mask at working size. Used for validation. */
export function polygonMask(xs, ys, w, h, scale) {
  const m = new Uint8Array(w * h);
  const X = xs.map((v) => v * scale), Y = ys.map((v) => v * scale), n = X.length;
  for (let y = 0; y < h; y++) {
    const yc = y + 0.5, cuts = [];
    for (let i = 0, j = n - 1; i < n; j = i++) {
      if ((Y[i] > yc) !== (Y[j] > yc)) cuts.push(X[i] + ((yc - Y[i]) / (Y[j] - Y[i])) * (X[j] - X[i]));
    }
    cuts.sort((a, b) => a - b);
    for (let k = 0; k + 1 < cuts.length; k += 2) {
      for (let x = Math.max(0, Math.ceil(cuts[k] - 0.5)); x <= Math.min(w - 1, Math.floor(cuts[k + 1] - 0.5)); x++) m[y * w + x] = 1;
    }
  }
  return m;
}

/** Dice and IoU between two masks. */
export function overlap(a, b) {
  let inter = 0, sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) { sa += a[i]; sb += b[i]; if (a[i] && b[i]) inter++; }
  return { dice: (2 * inter) / (sa + sb || 1), iou: inter / (sa + sb - inter || 1), areaRatio: sa / (sb || 1) };
}
