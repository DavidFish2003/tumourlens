// Four-parameter logistic (4PL) dose-response fit, the standard model for IC50.
// y = bottom + (top - bottom) / (1 + (dose / ic50) ^ hill), fitted on log10(dose) with Nelder-Mead.

export function fourPL(dose, p) {
  const [bottom, top, logIC50, hill] = p;
  return bottom + (top - bottom) / (1 + Math.pow(10, (Math.log10(dose) - logIC50) * hill));
}

function nelderMead(f, x0, steps, iters = 2000) {
  const n = x0.length;
  let pts = [x0, ...steps.map((s, i) => x0.map((v, j) => (j === i ? v + s : v)))].map((x) => ({ x, f: f(x) }));
  for (let k = 0; k < iters; k++) {
    pts.sort((a, b) => a.f - b.f);
    if (Math.abs(pts[n].f - pts[0].f) < 1e-10) break;
    const c = pts.slice(0, n).reduce((acc, p) => acc.map((v, j) => v + p.x[j] / n), new Array(n).fill(0));
    const at = (t) => { const x = c.map((v, j) => v + t * (pts[n].x[j] - v)); return { x, f: f(x) }; };
    const r = at(-1);
    if (r.f < pts[0].f) { const e = at(-2); pts[n] = e.f < r.f ? e : r; }
    else if (r.f < pts[n - 1].f) pts[n] = r;
    else {
      const ct = at(r.f < pts[n].f ? -0.5 : 0.5);
      if (ct.f < Math.min(r.f, pts[n].f)) pts[n] = ct;
      else pts = pts.map((p, i) => (i === 0 ? p : { x: p.x.map((v, j) => pts[0].x[j] + 0.5 * (v - pts[0].x[j])), f: 0 })).map((p, i) => (i === 0 ? p : { x: p.x, f: f(p.x) }));
    }
  }
  pts.sort((a, b) => a.f - b.f);
  return pts[0];
}

/**
 * Fit 4PL to points [{dose, y}] with dose > 0. Returns {params, ic50, r2} or null if it can't fit.
 * Needs at least 4 distinct doses.
 */
export function fit4PL(points) {
  const pts = points.filter((p) => p.dose > 0 && Number.isFinite(p.y));
  if (new Set(pts.map((p) => p.dose)).size < 4) return null;
  const ys = pts.map((p) => p.y), ld = pts.map((p) => Math.log10(p.dose));
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const sse = (p) => {
    if (p[3] <= 0 || p[3] > 10) return 1e12; // hill slope must be positive and sane
    return pts.reduce((s, q) => s + (q.y - fourPL(q.dose, p)) ** 2, 0);
  };
  const mid = (Math.min(...ld) + Math.max(...ld)) / 2;
  const best = nelderMead(sse, [yMin, yMax, mid, 1], [0.1 * (yMax - yMin || 1), 0.1 * (yMax - yMin || 1), 0.5, 0.5]);
  const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
  const sst = ys.reduce((s, y) => s + (y - mean) ** 2, 0);
  const [bottom, top, logIC50, hill] = best.x;
  const inRange = logIC50 >= Math.min(...ld) - 1 && logIC50 <= Math.max(...ld) + 1;
  return { params: best.x, bottom, top, hill, ic50: 10 ** logIC50, ic50InRange: inRange, r2: sst ? 1 - best.f / sst : 0 };
}
