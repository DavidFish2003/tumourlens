// TumourLens web tool: outlines spheroids in the browser (segment.js), lets the user check them,
// then plots size against dose (with a 4PL IC50 fit) or time from a pasted plate map.
import { segment } from "./segment.js";
import { fit4PL, fourPL } from "./fit.js";

const $ = (s) => document.querySelector(s);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const items = []; // {name, img (ImageData), result, include}
let chart, usingExamples = false;

// ---------- accuracy table ----------
fetch("data/validation.json").then((r) => r.json()).then((v) => {
  const rows = [["IncuCyte (whole-well)", v.summary.IncuCyte], ["Microscope (brightfield)", v.summary.Microscope], ["All", v.summary.All]];
  $("#acc-body").innerHTML = rows.map(([n, s]) =>
    `<tr><td>${n}</td><td class="num">${s.n}</td><td class="num">${s.dice_median.toFixed(2)}</td><td class="num">${s.good} of ${s.n}</td></tr>`).join("");
  $("#stats").textContent = `Outlines match experts with a median score of ${v.summary.All.dice_median.toFixed(2)} on ${v.summary.All.n} test images · no install, no upload`;
}).catch(() => {});

// ---------- loading images ----------
async function decode(blob) {
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height)); // cap size; analysis runs at 512px anyway
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return { data: c.getContext("2d").getImageData(0, 0, c.width, c.height), scaleToOriginal: 1 / s };
}

async function addFiles(list) {
  $("#results-block").hidden = false; $("#plate-block").hidden = false;
  let i = 0;
  for (const f of list) {
    $("#status").textContent = `Analysing ${++i} of ${list.length}…`;
    await new Promise((r) => setTimeout(r)); // let the page repaint
    try {
      const { data, scaleToOriginal } = await decode(f);
      const item = { name: f.name, img: data, scaleToOriginal, include: true };
      item.result = segment(data.data, data.width, data.height, { thresholdScale: +$("#sens").value });
      items.push(item);
      renderCard(item);
    } catch (e) {
      console.error(e);
    }
  }
  $("#status").textContent = `${items.length} image${items.length === 1 ? "" : "s"} analysed.`;
}

$("#files").addEventListener("change", (e) => addFiles([...e.target.files]));
const drop = $("#drop");
["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => addFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith("image/"))));

$("#example").addEventListener("click", async () => {
  $("#example").disabled = true;
  const names = await (await fetch("examples/index.json")).json();
  const files = await Promise.all(names.map(async (n) => new File([await (await fetch("examples/" + n)).blob()], n, { type: "image/jpeg" })));
  usingExamples = true;
  await addFiles(files);
  // Example plate map: the IncuCyte images' real timepoints from their file names (e.g. 00d18h00m = 18 h).
  const rows = items.filter((it) => /_00d(\d+)h/.test(it.name))
    .map((it) => `${it.name.split("_1_")[0].replace("VID1330_", "")},IncuCyte wells,${+it.name.match(/_(\d+)d(\d+)h/)[1] * 24 + +it.name.match(/_(\d+)d(\d+)h/)[2]}`);
  $("#plate").value = ["file,condition,value", ...rows].join("\n");
  $("#xkind").value = "time"; $("#xunit").value = "h";
  $("#plate-msg").textContent = "Example plate map: each IncuCyte image's real timepoint. These images aren't from a drug experiment, so no doses are shown.";
});

$("#sens").addEventListener("input", () => { $("#sens-v").textContent = (+$("#sens").value).toFixed(2); });
$("#sens").addEventListener("change", async () => {
  $("#status").textContent = "Re-analysing with new sensitivity…";
  await new Promise((r) => setTimeout(r));
  for (const it of items) it.result = segment(it.img.data, it.img.width, it.img.height, { thresholdScale: +$("#sens").value });
  $("#grid").innerHTML = ""; items.forEach(renderCard);
  $("#status").textContent = `${items.length} images re-analysed.`;
  if (!$("#chart-wrap").hidden) plot();
});
$("#umpp").addEventListener("input", () => { $("#grid").innerHTML = ""; items.forEach(renderCard); if (!$("#chart-wrap").hidden) plot(); });

// ---------- measurements ----------
function measure(it) {
  const o = it.result.objects[0];
  if (!o) return null;
  const um = +$("#umpp").value || 0, k = it.scaleToOriginal; // pixels in the original image
  const area = o.areaPx * k * k, dia = o.diameterPx * k;
  return { count: it.result.objects.length, area, diameter: dia, circularity: o.circularity,
           areaUm2: um ? area * um * um : null, diameterUm: um ? dia * um : null };
}
const fmt = (x, d = 0) => (x == null ? "–" : x.toLocaleString(undefined, { maximumFractionDigits: d }));

function renderCard(it) {
  const card = document.createElement("div");
  card.className = "card" + (it.include ? "" : " off");
  const c = document.createElement("canvas");
  const { mask, w, h } = it.result;
  c.width = w; c.height = h;
  const ctx = c.getContext("2d");
  const tmp = document.createElement("canvas"); tmp.width = it.img.width; tmp.height = it.img.height;
  tmp.getContext("2d").putImageData(it.img, 0, 0);
  ctx.drawImage(tmp, 0, 0, w, h);
  // Outline: mask pixels that border background.
  ctx.fillStyle = css("--outline");
  const t = Math.max(1, Math.round(w / 256));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (mask[i] && (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w])) ctx.fillRect(x, y, t, t);
  }
  const m = measure(it);
  const vals = !m ? "No spheroid found" : m.areaUm2 != null
    ? `${fmt(m.diameterUm)} µm wide · ${fmt(m.areaUm2 / 1e6, 3)} mm² · round ${m.circularity.toFixed(2)}`
    : `${fmt(m.diameter)} px wide · ${fmt(m.area)} px² · round ${m.circularity.toFixed(2)}`;
  card.innerHTML = `<div class="meta"><div class="name" title="${esc(it.name)}">${esc(it.name)}</div><div class="vals">${vals}${m && m.count > 1 ? ` · ${m.count} objects` : ""}</div>
    <label><input type="checkbox" ${it.include ? "checked" : ""}> Include</label></div>`;
  card.prepend(c);
  card.querySelector("input").addEventListener("change", (e) => {
    it.include = e.target.checked; card.classList.toggle("off", !it.include);
    if (!$("#chart-wrap").hidden) plot();
  });
  $("#grid").appendChild(card);
}

$("#export").addEventListener("click", () => {
  const plate = parsePlate();
  const rows = [["file", "included", "objects", "area_px", "diameter_px", "circularity", "area_um2", "diameter_um", "condition", "value"]];
  for (const it of items) {
    const m = measure(it) || {};
    const p = plate.find((r) => it.name.includes(r.file)) || {};
    rows.push([it.name, it.include, m.count ?? 0, m.area?.toFixed(0) ?? "", m.diameter?.toFixed(1) ?? "", m.circularity?.toFixed(3) ?? "",
      m.areaUm2?.toFixed(0) ?? "", m.diameterUm?.toFixed(1) ?? "", p.condition ?? "", p.value ?? ""]);
  }
  const csv = rows.map((r) => r.map((v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v)).join(",")).join("\n");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = "tumourlens_measurements.csv"; a.click();
});

// ---------- plate map + chart ----------
function parsePlate() {
  const lines = $("#plate").value.trim().split(/\r?\n/).filter(Boolean);
  if (lines[0] && /file/i.test(lines[0])) lines.shift();
  return lines.map((l) => l.split(/[,\t;]/).map((s) => s.trim())).filter((r) => r.length >= 3 && r[0])
    .map(([file, condition, value]) => ({ file, condition, value: Number(value) }))
    .filter((r) => Number.isFinite(r.value));
}

$("#apply").addEventListener("click", plot);

function plot() {
  const plate = parsePlate();
  const kind = $("#xkind").value, unit = $("#xunit").value || "";
  const um = +$("#umpp").value;
  const groups = new Map(); let matched = 0;
  for (const r of plate) {
    // Match by exact name first, otherwise by a whole token (so "A1" doesn't also match "A10").
    const it = items.find((x) => x.name === r.file) ||
      items.find((x) => new RegExp(`(^|[^A-Za-z0-9])${r.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`).test(x.name));
    if (!it || !it.include) continue;
    const m = measure(it); if (!m) continue;
    matched++;
    if (!groups.has(r.condition)) groups.set(r.condition, []);
    groups.get(r.condition).push({ x: r.value, area: um ? m.areaUm2 / 1e6 : m.area, file: it.name });
  }
  if (!matched) { $("#plate-msg").textContent = "No plate-map rows matched an included image."; return; }
  const yLabel = kind === "dose" ? "Spheroid size (% of untreated)" : um ? "Spheroid area (mm²)" : "Spheroid area (px²)";
  const colors = [css("--s1"), css("--s2"), css("--s3"), css("--s4")];
  const datasets = [], fits = [];
  [...groups.entries()].slice(0, 4).forEach(([name, pts], gi) => {
    let data = pts;
    if (kind === "dose") {
      // Normalise to the untreated wells (dose 0) of this condition.
      const ctrl = pts.filter((p) => p.x === 0).map((p) => p.area);
      const base = ctrl.length ? ctrl.reduce((a, b) => a + b, 0) / ctrl.length : Math.max(...pts.map((p) => p.area));
      data = pts.filter((p) => p.x > 0).map((p) => ({ ...p, y: (100 * p.area) / base }));
      const f = fit4PL(data.map((p) => ({ dose: p.x, y: p.y })));
      if (f) {
        const xs = data.map((p) => p.x), lo = Math.log10(Math.min(...xs)), hi = Math.log10(Math.max(...xs));
        const curve = Array.from({ length: 60 }, (_, i) => { const d = 10 ** (lo + ((hi - lo) * i) / 59); return { x: d, y: fourPL(d, f.params) }; });
        datasets.push({ type: "line", data: curve, borderColor: colors[gi], borderWidth: 2, pointRadius: 0, label: name + " fit" });
        fits.push({ name, f, color: colors[gi] });
      }
    } else data = pts.map((p) => ({ ...p, y: p.area }));
    datasets.push({ type: "scatter", data: data.map((p) => ({ x: p.x, y: p.y, file: p.file })), backgroundColor: colors[gi],
                    borderColor: css("--surface"), borderWidth: 2, pointRadius: 5, pointHoverRadius: 7, label: name });
  });
  $("#chart-wrap").hidden = false;
  $("#legend").innerHTML = [...groups.keys()].slice(0, 4).map((n, i) => `<span><i style="background:${colors[i]}"></i>${esc(n)}</span>`).join("")
    + (groups.size > 4 ? `<span class="muted">Showing the first 4 conditions</span>` : "");
  $("#fits").innerHTML = kind !== "dose" ? "" : fits.length
    ? fits.map(({ name, f }) => `<div class="fit"><b>${f.ic50InRange ? fmt(f.ic50, 3) + " " + esc(unit) : "outside tested range"}</b>IC50, ${esc(name)} · R² ${f.r2.toFixed(2)}</div>`).join("")
    : `<div class="fit">Need at least 4 different non-zero doses per condition to fit an IC50.</div>`;
  $("#plate-msg").textContent = `${matched} image${matched === 1 ? "" : "s"} matched.`;

  Chart.defaults.font.family = "Inter, system-ui, sans-serif";
  Chart.defaults.color = css("--text-2");
  if (chart) chart.destroy();
  chart = new Chart($("#chart"), {
    data: { datasets },
    options: {
      maintainAspectRatio: false, animation: { duration: 200 },
      plugins: { legend: { display: false },
        tooltip: { backgroundColor: css("--surface"), titleColor: css("--text"), bodyColor: css("--text-2"), borderColor: css("--line"), borderWidth: 1, padding: 10, displayColors: false,
          filter: (it) => it.dataset.type === "scatter",
          callbacks: { title: (it) => it[0].raw.file, label: (it) => `${fmt(it.raw.x, 3)} ${unit} → ${fmt(it.raw.y, kind === "dose" ? 0 : 3)}${kind === "dose" ? "%" : ""}` } } },
      scales: {
        x: { type: kind === "dose" ? "logarithmic" : "linear", grid: { color: css("--grid") }, border: { display: false },
             title: { display: true, text: `${kind === "dose" ? "Dose" : "Time"}${unit ? " (" + unit + ")" : ""}`, color: css("--text-3") } },
        y: { beginAtZero: true, grid: { color: css("--grid") }, border: { display: false }, title: { display: true, text: yLabel, color: css("--text-3") } },
      },
    },
  });
}
