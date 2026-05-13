/**
 * final_project_group2
 * Narrative / scrollytelling-friendly visualizations of the non-linear relationship between
 * immunization coverage and outbreaks.
 *
 * Key technical requirements implemented below:
 * - Promise.all() async loading for paired case + coverage CSVs
 * - Robust merging on primary keys: Country + Year
 * - Type casting + cleaning
 * - Missing longitudinal points handled via interpolation so D3 curves don't break
 * - Responsive SVGs via viewBox
 * - D3 .join() + transitions
 *
 * NOTE: This script expects you to place CSVs into /data. See DATA_FILES below for filenames.
 */

// -----------------------------
// Disclosure widget -- adapted from https://linkedlist.ch/animate_details_element_60/
// -----------------------------
document.querySelectorAll('summary')
  .forEach(element => element.addEventListener('click', (event) => {
    const detailsElement = event.target.parentElement
    const contentElement = event.target.nextElementSibling

    // addresses Chrome bug
    if (contentElement.classList.contains('animation')) {
      contentElement.classList.remove('animation', 'collapsing')
      void element.offsetWidth
      return
    }

    const onAnimationEnd = cb => contentElement.addEventListener('animationend', cb, {once: true})

    // forces Safari to perform the animation
    requestAnimationFrame(() => contentElement.classList.add('animation'))
    onAnimationEnd(() => contentElement.classList.remove('animation'))

    const isDetailsOpen = detailsElement.getAttribute('open') !== null
    if (isDetailsOpen) {
      event.preventDefault()
      contentElement.classList.add('collapsing')
      onAnimationEnd(() => {
        detailsElement.removeAttribute('open')
        contentElement.classList.remove('collapsing')
      })
    }
  }))

const tooltipEl = document.querySelector("#tooltip");
const tippingMount = document.querySelector("#vis-tipping");
const heatmapMount = document.querySelector("#vis-heatmap");

if (!tippingMount || !heatmapMount) {
  throw new Error("Missing visualization mount(s). Expected #vis-tipping, #vis-heatmap.");
}

// -----------------------------
// Theme helpers
// -----------------------------
const THEME = {
  bg: "#111111",
  fg: "#E0E0E0",
  muted: "rgba(114, 105, 105, 0.72)",
  cyan: "#2DE2E6",
  teal: "#00D1B2",
  /** MCV1 line when coverage is below herd immunity threshold */
  coverageBelow: "#00D1B2",
  /** MCV1 line when coverage is at or above herd immunity threshold */
  coverageAbove: "#34d399",
  outbreak: "#FF4136",
  /** Below-threshold vaccination band (distinct from case counts) */
  dangerZoneFill: "rgba(124, 58, 237, 0.22)",
  /** At/above threshold: fill between coverage curve and 95% line */
  safeZoneFill: "rgba(52, 211, 153, 0.2)",
  /** Measles case area — warm orange, not the same hue as danger/vacc shading */
  casesAreaFill: "rgba(234, 88, 12, 0.44)",
  /** Hover marker on cases line */
  casesMark: "#ea580c",
};

// -----------------------------
// Tooltip (glassmorphism div)
// Tracks mouse position and shows context-sensitive metrics
// -----------------------------
const showTooltip = (html, x, y) => {
  if (!tooltipEl) return;
  tooltipEl.innerHTML = html;
  const offset = 10;
  const pad = 8;
  const vw = window.innerWidth || document.documentElement.clientWidth || 0;
  const vh = window.innerHeight || document.documentElement.clientHeight || 0;
  const tw = tooltipEl.offsetWidth || 0;
  const th = tooltipEl.offsetHeight || 0;

  let left = x + offset;
  let top = y + offset;

  if (left + tw + pad > vw) left = Math.max(pad, x - tw - offset);
  if (top + th + pad > vh) top = Math.max(pad, y - th - offset);

  // Final clamp to viewport bounds.
  left = Math.max(pad, Math.min(left, vw - tw - pad));
  top = Math.max(pad, Math.min(top, vh - th - pad));

  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top = `${top}px`;
  tooltipEl.classList.add("is-visible");
  tooltipEl.setAttribute("aria-hidden", "false");
};

const hideTooltip = () => {
  if (!tooltipEl) return;
  tooltipEl.classList.remove("is-visible");
  tooltipEl.setAttribute("aria-hidden", "true");
};

const fmtInt = d3.format(",");
const fmtPct = (v) => (Number.isFinite(v) ? `${d3.format(".0f")(v)}%` : "—");

// -----------------------------
// Data loading
// -----------------------------
// Filenames are explicit so your /data folder stays organized and predictable.
// If your datasets use different names/columns, adjust CONFIG fields below.
const DATA_FILES = {
  // These match the files currently in /data (WHO export format)
  measlesCases: "data/measles_cases.csv",
  measlesCoverage: "data/measles_vacc.csv",
  diphtheriaCases: "data/diphtheria_cases.csv",
  pertussisCases: "data/pertussis_cases.csv",
  dtpCoverage: "data/diphtheria_pertussis_vacc.csv",
  polioCases: "data/polio_cases.csv",
  polioCoverage: "data/polio_vacc.csv",
};

// Robust numeric parsing (handles "", "NA", etc.)
const toNumber = (v) => {
  if (v === null || v === undefined) return NaN;
  const s = String(v).trim();
  if (!s || s.toLowerCase() === "na" || s.toLowerCase() === "n/a") return NaN;
  const n = Number(s.replaceAll(",", ""));
  return Number.isFinite(n) ? n : NaN;
};

const toYear = (v) => {
  const y = Math.trunc(toNumber(v));
  return Number.isFinite(y) ? y : NaN;
};

/**
 * Try to infer the "value" column when you only know keys like Country/Year.
 * We pick the first numeric-looking column not in keys (prefer names that mention cases/coverage).
 */
const inferValueColumn = (rows, preferredRegex) => {
  if (!rows?.length) return null;
  const keys = Object.keys(rows[0] ?? {});
  const keySet = new Set(["country", "Country", "year", "Year"]);

  const scored = keys
    .filter((k) => !keySet.has(k))
    .map((k) => {
      const nameScore = preferredRegex?.test(k) ? 3 : 0;
      const numericScore =
        rows.slice(0, 25).reduce((acc, r) => acc + (Number.isFinite(toNumber(r[k])) ? 1 : 0), 0) / Math.min(25, rows.length);
      return { key: k, score: nameScore + numericScore };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.key ?? null;
};

/**
 * Merge paired datasets on primary keys: Country + Year.
 * Includes:
 * - Type casting to numbers
 * - Cleaning
 * - Producing a tidy array: { disease, country, year, cases, coverage }
 */
const mergeCaseCoverage = ({
  disease,
  casesRows,
  coverageRows,
  // Default keys for WHO exports
  countryKey = "Location",
  yearKey = "Period",
  casesKey,
  coverageKey,
}) => {
  const inferredCasesKey = casesKey ?? inferValueColumn(casesRows, /case|incidence/i);
  const inferredCoverageKey = coverageKey ?? inferValueColumn(coverageRows, /cov|immun|mcv|dtp|pol/i);

  if (!inferredCasesKey || !inferredCoverageKey) {
    throw new Error(
      `Could not infer value columns for ${disease}. ` +
        `casesKey=${String(inferredCasesKey)} coverageKey=${String(inferredCoverageKey)}. ` +
        `Update CONFIG in js/script.js to specify casesKey/coverageKey explicitly.`
    );
  }

  // Index coverage by (Country|Year)
  const covByKey = new Map();
  for (const r of coverageRows) {
    const country = (r[countryKey] ?? r.Country ?? r.country ?? "").trim();
    const year = toYear(r[yearKey] ?? r.Year ?? r.year);
    const coverage = toNumber(r[inferredCoverageKey]);
    if (!country || !Number.isFinite(year)) continue;
    covByKey.set(`${country}||${year}`, coverage);
  }

  const merged = [];
  for (const r of casesRows) {
    const country = (r[countryKey] ?? r.Country ?? r.country ?? "").trim();
    const year = toYear(r[yearKey] ?? r.Year ?? r.year);
    const cases = toNumber(r[inferredCasesKey]);
    if (!country || !Number.isFinite(year)) continue;
    const coverage = covByKey.get(`${country}||${year}`);
    merged.push({
      disease,
      country,
      year,
      cases: Number.isFinite(cases) ? cases : NaN,
      coverage: Number.isFinite(coverage) ? coverage : NaN,
    });
  }

  return merged;
};

/**
 * Combine two case datasets (same keys: Location+Period) by summing cases.
 * Used to create a single "Diphtheria/Pertussis" incidence series aligned with DTP3 coverage.
 */
const combineCasesSum = ({
  disease,
  rowsA,
  rowsB,
  countryKey = "Location",
  yearKey = "Period",
  valueKey = "FactValueNumeric",
}) => {
  const addTo = (map, r) => {
    const country = (r[countryKey] ?? "").trim();
    const year = toYear(r[yearKey]);
    const v = toNumber(r[valueKey]);
    if (!country || !Number.isFinite(year)) return;
    const key = `${country}||${year}`;
    map.set(key, (map.get(key) ?? 0) + (Number.isFinite(v) ? v : 0));
  };

  const m = new Map();
  for (const r of rowsA) addTo(m, r);
  for (const r of rowsB) addTo(m, r);

  return Array.from(m, ([key, cases]) => {
    const [country, yearStr] = key.split("||");
    return { disease, Location: country, Period: Number(yearStr), FactValueNumeric: cases };
  });
};

/**
 * Interpolate missing years within each (disease, country) series so
 * D3 path generators can render continuous trajectories (no broken segments).
 *
 * Interpolation strategy:
 * - Build full year range between min and max observed years
 * - For each missing year, linearly interpolate coverage and cases if we have bracketing points
 * - If missing at the ends, we keep NaN (so charts can optionally ignore or clamp)
 *
 * IMPORTANT for log scales: later, we clamp cases to >= 1 when rendering.
 */
const interpolateSeries = (rows) => {
  const byGroup = d3.group(rows, (d) => d.disease, (d) => d.country);
  const out = [];

  for (const [disease, byCountry] of byGroup) {
    for (const [country, series0] of byCountry) {
      const series = series0
        .filter((d) => Number.isFinite(d.year))
        .sort((a, b) => d3.ascending(a.year, b.year));

      if (!series.length) continue;
      const yearMin = d3.min(series, (d) => d.year);
      const yearMax = d3.max(series, (d) => d.year);

      // Map year -> data (keep last if duplicates)
      const yearMap = new Map(series.map((d) => [d.year, d]));

      for (let y = yearMin; y <= yearMax; y += 1) {
        const existing = yearMap.get(y);
        if (existing) {
          out.push(existing);
          continue;
        }

        // Find bracketing points
        const left = d3.max(series.filter((d) => d.year < y), (d) => d.year);
        const right = d3.min(series.filter((d) => d.year > y), (d) => d.year);
        if (!Number.isFinite(left) || !Number.isFinite(right)) {
          out.push({ disease, country, year: y, cases: NaN, coverage: NaN, interpolated: true });
          continue;
        }

        const d0 = yearMap.get(left);
        const d1 = yearMap.get(right);
        const t = (y - d0.year) / (d1.year - d0.year);

        const lerp = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? a + (b - a) * t : NaN);

        out.push({
          disease,
          country,
          year: y,
          cases: lerp(d0.cases, d1.cases),
          coverage: lerp(d0.coverage, d1.coverage),
          interpolated: true,
        });
      }
    }
  }

  return out;
};

function enforceViz1LayerCheckboxes() {
  const c = document.querySelector("#viz1-layer-cases");
  const v = document.querySelector("#viz1-layer-vacc");
  if (c && v && !c.checked && !v.checked) v.checked = true;
}

function readViz1LayersFromDom() {
  enforceViz1LayerCheckboxes();
  const c = document.querySelector("#viz1-layer-cases");
  const v = document.querySelector("#viz1-layer-vacc");
  return {
    showCases: c ? c.checked : true,
    showVacc: v ? v.checked : true,
  };
}

/**
 * Split coverage into polylines that stay entirely above or below `threshold`,
 * inserting an interpolated point at crossings so each segment can use one stroke color.
 */
function splitCoverageLineSegments(series, threshold) {
  const pts = series.filter((d) => Number.isFinite(d.year) && Number.isFinite(d.coverage));
  if (!pts.length) return [];

  const atCrossing = (a, b) => {
    const c0 = a.coverage;
    const c1 = b.coverage;
    if (c0 === c1) return null;
    const u = (threshold - c0) / (c1 - c0);
    if (u <= 0 || u >= 1) return null;
    return { year: a.year + u * (b.year - a.year), coverage: threshold };
  };

  const segments = [];
  let seg = [pts[0]];
  let segAbove = pts[0].coverage >= threshold;

  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const prevAb = prev.coverage >= threshold;
    const curAb = cur.coverage >= threshold;

    if (curAb === prevAb) {
      seg.push(cur);
    } else {
      const xpt = atCrossing(prev, cur);
      if (xpt) {
        seg.push(xpt);
        segments.push({ above: prevAb, points: seg });
        seg = [xpt, cur];
        segAbove = curAb;
      } else {
        seg.push(cur);
      }
    }
  }
  if (seg.length) segments.push({ above: segAbove, points: seg });
  return segments;
}

function updateViz1StoryCaption() {
  const el = document.querySelector("#viz1-story-caption");
  if (!el) return;
  enforceViz1LayerCheckboxes();
  const cOn = document.querySelector("#viz1-layer-cases")?.checked;
  const vOn = document.querySelector("#viz1-layer-vacc")?.checked;
  if (cOn && vOn) {
    el.innerHTML =
      "<b>Full view.</b> MCV1 coverage (left axis, 0–100%): the line is <strong>green</strong> when coverage is at or above the herd immunity threshold and <strong>teal</strong> when it is below. Dashed line: 95% target for measles. <strong>Light green</strong> fill sits between the curve and that line when coverage is at or above 95%; <strong>violet</strong> fill does the same when it is under 95%. <strong>Orange</strong> area: reported cases (log scale, right axis). Use the toggles or press <strong>Start</strong> for a guided tour.";
  } else if (vOn && !cOn) {
    el.innerHTML =
      "<b>Vaccination only.</b> The left axis shows MCV1 (first-dose measles) coverage as a line: <strong>green</strong> when it is at or above the ~<strong>95%</strong> target for measles herd immunity, <strong>teal</strong> when it is lower. The dashed horizontal line is that 95% target. <strong>Light green</strong> fill appears between the curve and the line when coverage meets or beats the target; <strong>violet</strong> fill appears when it falls short. Turn on <strong>Measles cases</strong> to add reported counts on the same timeline.";
  } else if (cOn && !vOn) {
    el.innerHTML =
      "<b>Cases layer only.</b> The orange area shows reported cases (log scale, right axis) so both small counts and large outbreaks stay readable. Turn on <strong>Vaccination coverage</strong> to compare immunization trends with case surges.";
  } else {
    el.textContent = "";
  }
}

/** Guided tour: each step sets layer checkboxes and caption until user presses Done. */
const VIZ1_WALKTHROUGH_STEPS = [
  {
    vacc: true,
    cases: false,
    html: "<b>Step 1 of 3 — Vaccination only.</b> MCV1 on the left axis: <strong>green</strong> line at or above ~95%, <strong>teal</strong> below. <strong>Light green</strong> fill between curve and dashed line when coverage is on target; <strong>violet</strong> when it is under. Press <strong>Next</strong> for the cases layer.",
  },
  {
    vacc: false,
    cases: true,
    html: "<b>Step 2 of 3 — Cases only.</b> Only reported measles cases are shown: one solid orange fill on a <strong>logarithmic</strong> scale (right axis). Press <strong>Next</strong> to turn both layers on and compare.",
  },
  {
    vacc: true,
    cases: true,
    html: "<b>Step 3 of 3 — Both layers.</b> <strong>Light green</strong> / <strong>violet</strong> bands show on- vs under-target vaccination; <strong>orange</strong> shows reported cases. Large surges often follow dips under the threshold (reporting and other factors matter too). Press <strong>Done</strong> to exit the tour.",
  },
];

// -----------------------------
// Visualization 1: Outbreak Timeline (dual-axis + brush + dropdown)
// -----------------------------
const renderOutbreakTimeline = ({ mount, country, rows, threshold = 95, layers }) => {
  let showCases = layers?.showCases !== false;
  let showVacc = layers?.showVacc !== false;
  if (!showCases && !showVacc) showVacc = true;

  const width = 1100;
  const height = 760;
  const margin = { top: 64, right: 86, bottom: 118, left: 72 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const brushH = 64;
  const brushGap = 46; // space for x-axis title between main axis and brush
  const brushTop = innerH + brushGap;

  const svg = d3
    .select(mount)
    .selectAll("svg")
    .data([null])
    .join("svg")
    .attr("viewBox", `0 0 ${width} ${height}`);

  const g = svg
    .selectAll("g.frame")
    .data([null])
    .join("g")
    .attr("class", "frame")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  // Filter + sort series
  const series = rows
    .filter((d) => d.country === country)
    .filter((d) => Number.isFinite(d.year))
    .map((d) => ({
      ...d,
      casesClamped: Number.isFinite(d.cases) ? Math.max(1, d.cases) : NaN, // log-safe
    }))
    .sort((a, b) => d3.ascending(a.year, b.year));

  const years = series.map((d) => d.year);
  const yearExtent = d3.extent(series, (d) => d.year);
  const xFull = d3.scaleLinear().domain(yearExtent).range([0, innerW]);
  const x = xFull.copy();

  // Dual y-axis synchronization:
  // - Coverage is linear (0..100) on LEFT
  // - Cases is logarithmic on RIGHT to capture exponential spikes
  const yCov = d3.scaleLinear().domain([0, 100]).range([innerH, 0]).nice();
  const yCases = d3
    .scaleLog()
    .domain(d3.extent(series, (d) => d.casesClamped).map((v, i) => (i === 0 ? Math.max(1, v ?? 1) : v ?? 1)))
    .range([innerH, 0])
    .clamp(true)
    .nice();

  // Axes
  const xAxis = d3.axisBottom(x).ticks(10).tickFormat(d3.format("d"));
  const yAxisL = d3.axisLeft(yCov).ticks(6).tickFormat((d) => `${d}%`);
  const yAxisR = d3.axisRight(yCases).ticks(6, "~s");

  g.selectAll("g.axis.x.main-x")
    .data([null])
    .join("g")
    .attr("class", "axis x main-x")
    .attr("transform", `translate(0,${innerH})`)
    .call(xAxis);
  // IMPORTANT: axis groups must be selected by a class that actually exists on the element,
  // otherwise we keep appending new axes on each re-render (looks like the axis "won't reset").
  g.selectAll("g.axis-yL").data([null]).join("g").attr("class", "axis y axis-yL axis-yL").call(yAxisL);
  g.selectAll("g.axis-yR")
    .data([null])
    .join("g")
    .attr("class", "axis y axis-yR axis-yR")
    .attr("transform", `translate(${innerW},0)`)
    .call(yAxisR);

  // Y-axis titles along plot sides (rotated, centered on chart height)
  g.selectAll("text.yL-label")
    .data([null])
    .join("text")
    .attr("class", "yL-label")
    .attr("transform", `translate(${-56},${innerH / 2}) rotate(-90)`)
    .attr("text-anchor", "middle")
    .attr("fill", THEME.muted)
    .attr("font-size", 12)
    .text("Coverage (MCV1)");

  g.selectAll("text.yR-label")
    .data([null])
    .join("text")
    .attr("class", "yR-label")
    .attr("transform", `translate(${innerW + 56},${innerH / 2}) rotate(90)`)
    .attr("text-anchor", "middle")
    .attr("fill", THEME.muted)
    .attr("font-size", 12)
    .text("Cases (log)");

  g.selectAll("text.x-axis-label")
    .data([null])
    .join("text")
    .attr("class", "x-axis-label")
    .attr("x", innerW / 2)
    .attr("y", innerH + 34)
    .attr("text-anchor", "middle")
    .attr("fill", THEME.muted)
    .attr("font-size", 12)
    .text("Year");

  // Threshold reference line (herd immunity)
  const threshY = yCov(threshold);
  g.selectAll("line.threshold")
    .data([null])
    .join("line")
    .attr("class", "threshold")
    .attr("x1", 0)
    .attr("x2", innerW)
    .attr("y1", threshY)
    .attr("y2", threshY)
    .attr("stroke", "rgba(15, 23, 42, 0.45)")
    .attr("stroke-dasharray", "6 6")
    .attr("stroke-width", 1.5);

  g.selectAll("text.threshold-label")
    .data([null])
    .join("text")
    .attr("class", "threshold-label")
    .attr("x", innerW - 2)
    .attr("y", threshY - 8)
    .attr("text-anchor", "end")
    .attr("fill", THEME.muted)
    .attr("font-size", 12)
    .text(`Herd immunity threshold (${threshold}%)`);

  // Area (cases) + line (coverage)
  const areaCases = d3
    .area()
    .defined((d) => Number.isFinite(d.year) && Number.isFinite(d.casesClamped))
    .x((d) => x(d.year))
    .y0(innerH)
    .y1((d) => yCases(d.casesClamped))
    .curve(d3.curveCatmullRom.alpha(0.85));

  const lineCoverageSeg = d3
    .line()
    .x((d) => x(d.year))
    .y((d) => yCov(d.coverage))
    .curve(d3.curveCatmullRom.alpha(0.85));

  const coverageSegments = () =>
    splitCoverageLineSegments(series, threshold).filter((s) => s.points.length >= 2);

  // Dynamic "danger zone" highlighting:
  // We create a second area under the *coverage line* only where coverage < threshold.
  // This visually marks the segment(s) in the low-coverage region.
  const areaDanger = d3
    .area()
    .defined((d) => Number.isFinite(d.year) && Number.isFinite(d.coverage) && d.coverage < threshold)
    .x((d) => x(d.year))
    .y0(threshY)
    .y1((d) => yCov(d.coverage))
    .curve(d3.curveCatmullRom.alpha(0.85));

  const areaSafe = d3
    .area()
    .defined((d) => Number.isFinite(d.year) && Number.isFinite(d.coverage) && d.coverage >= threshold)
    .x((d) => x(d.year))
    .y0((d) => yCov(d.coverage))
    .y1(threshY)
    .curve(d3.curveCatmullRom.alpha(0.85));

  const plotG = g.selectAll("g.plot").data([null]).join("g").attr("class", "plot");

  // Cases area (right axis)
  plotG
    .selectAll("path.cases-area")
    .data([series])
    .join(
      (enter) =>
        enter
          .append("path")
          .attr("class", "cases-area")
          .attr("fill", THEME.casesAreaFill)
          .attr("opacity", 0.95)
          .attr("d", areaCases),
      (update) => update.transition().duration(800).attr("fill", THEME.casesAreaFill).attr("d", areaCases)
    );

  // Safe zone: light green fill between coverage curve and herd threshold when coverage >= threshold
  plotG
    .selectAll("path.safe-area")
    .data([series])
    .join(
      (enter) =>
        enter
          .append("path")
          .attr("class", "safe-area")
          .attr("fill", THEME.safeZoneFill)
          .attr("d", areaSafe),
      (update) => update.transition().duration(800).attr("fill", THEME.safeZoneFill).attr("d", areaSafe)
    );

  // Danger zone (coverage dip)
  plotG
    .selectAll("path.danger-area")
    .data([series])
    .join(
      (enter) =>
        enter
          .append("path")
          .attr("class", "danger-area")
          .attr("fill", THEME.dangerZoneFill)
          .attr("d", areaDanger),
      (update) => update.transition().duration(800).attr("fill", THEME.dangerZoneFill).attr("d", areaDanger)
    );

  // Coverage line (left axis): green at/above herd immunity threshold, teal below
  const covSegKey = (s, i) => `${i}-${s.above}-${s.points[0]?.year}-${s.points.at(-1)?.year}`;
  plotG
    .selectAll("path.cov-line-seg")
    .data(coverageSegments(), covSegKey)
    .join(
      (enter) =>
        enter
          .append("path")
          .attr("class", "cov-line-seg")
          .attr("fill", "none")
          .attr("stroke-width", 2.5)
          .attr("stroke-linecap", "round")
          .attr("stroke-linejoin", "round")
          .attr("stroke", (seg) => (seg.above ? THEME.coverageAbove : THEME.coverageBelow))
          .attr("d", (seg) => lineCoverageSeg(seg.points)),
      (update) =>
        update
          .transition()
          .duration(800)
          .attr("stroke", (seg) => (seg.above ? THEME.coverageAbove : THEME.coverageBelow))
          .attr("d", (seg) => lineCoverageSeg(seg.points)),
      (exit) => exit.remove()
    );

  const defs = svg.selectAll("defs").data([null]).join("defs");

  // Clip plotting to the exact x/y bounds so curves don't overshoot past axes.
  defs
    .selectAll("clipPath#viz1-main-clip")
    .data([null])
    .join("clipPath")
    .attr("id", "viz1-main-clip")
    .selectAll("rect")
    .data([null])
    .join("rect")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", innerW)
    .attr("height", innerH);

  defs
    .selectAll("clipPath#viz1-brush-clip")
    .data([null])
    .join("clipPath")
    .attr("id", "viz1-brush-clip")
    .selectAll("rect")
    .data([null])
    .join("rect")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", innerW)
    .attr("height", brushH);

  plotG.attr("clip-path", "url(#viz1-main-clip)");

  // Tooltip interaction: nearest year
  const focusG = plotG.selectAll("g.focus").data([null]).join("g").attr("class", "focus").style("display", "none");

  focusG
    .selectAll("line.focus-x")
    .data([null])
    .join("line")
    .attr("class", "focus-x")
    .attr("y1", 0)
    .attr("y2", innerH)
    .attr("stroke", "rgba(15, 23, 42, 0.45)")
    .attr("stroke-dasharray", "4 4")
    .attr("stroke-width", 1.2);

  focusG
    .selectAll("circle.focus-cov")
    .data([null])
    .join("circle")
    .attr("class", "focus-cov")
    .attr("r", 4.5)
    .attr("fill", THEME.coverageBelow)
    .attr("stroke", "rgba(15, 23, 42, 0.45)")
    .attr("stroke-width", 1.5);

  focusG
    .selectAll("circle.focus-cases")
    .data([null])
    .join("circle")
    .attr("class", "focus-cases")
    .attr("r", 4.5)
    .attr("fill", THEME.casesMark)
    .attr("stroke", "rgba(15, 23, 42, 0.45)")
    .attr("stroke-width", 1.5);

  const overlay = plotG
    .selectAll("rect.overlay")
    .data([null])
    .join("rect")
    .attr("class", "overlay")
    .attr("x", 0)
    .attr("y", 0)
    .attr("width", innerW)
    .attr("height", innerH)
    .attr("fill", "transparent");

  overlay
    .on("mousemove", (event) => {
      const [mx] = d3.pointer(event, g.node());
      const year = Math.round(x.invert(mx));
      const idx = d3.leastIndex(years, (yy) => Math.abs(yy - year));
      const d = series[idx];
      if (!d) return;
      const px = x(d.year);
      const covValid = Number.isFinite(d.coverage);
      const casesValid = Number.isFinite(d.casesClamped);

      focusG.style("display", null);
      focusG.select("line.focus-x").attr("x1", px).attr("x2", px);
      focusG
        .select("circle.focus-cov")
        .attr("display", covValid && showVacc ? null : "none")
        .attr("fill", covValid && d.coverage >= threshold ? THEME.coverageAbove : THEME.coverageBelow)
        .attr("stroke", covValid && d.coverage >= threshold ? "rgba(6, 95, 70, 0.55)" : "rgba(15, 23, 42, 0.45)")
        .attr("cx", px)
        .attr("cy", covValid ? yCov(d.coverage) : 0);
      focusG
        .select("circle.focus-cases")
        .attr("display", casesValid && showCases ? null : "none")
        .attr("cx", px)
        .attr("cy", casesValid ? yCases(d.casesClamped) : 0);

      // Viewport coords: tooltip is position:fixed; body-relative d3.pointer drifts when scrolled.
      const bx = event.clientX;
      const by = event.clientY;
      const below = Number.isFinite(d.coverage) && d.coverage < threshold;
      const tipParts = [
        `<div class="tooltip-v">${escapeHtml(country)}</div>`,
        `<div><span class="tooltip-k">Year</span>: <span class="tooltip-v">${d.year}</span></div>`,
      ];
      if (showVacc) {
        tipParts.push(
          `<div><span class="tooltip-k">Coverage</span>: <span class="tooltip-v">${fmtPct(d.coverage)}</span></div>`,
          `<div><span class="tooltip-k">Threshold</span>: <span class="tooltip-v">${below ? "Below (danger)" : "Above"}</span></div>`
        );
      }
      if (showCases) {
        tipParts.push(`<div><span class="tooltip-k">Cases</span>: <span class="tooltip-v">${fmtInt(Math.round(d.cases ?? 0))}</span></div>`);
      }
      showTooltip(tipParts.join(""), bx, by);
    })
    .on("mouseleave", () => {
      focusG.style("display", "none");
      hideTooltip();
    });

  // Brush (mini-chart area under main chart)
  const xBrush = xFull.copy();
  const yBrush = d3
    .scaleLinear()
    .domain([0, d3.max(series, (d) => (Number.isFinite(d.cases) ? d.cases : 0)) || 1])
    .range([brushH, 0]);

  const areaBrush = d3
    .area()
    .defined((d) => Number.isFinite(d.year) && Number.isFinite(d.cases))
    .x((d) => xBrush(d.year))
    .y0(brushH)
    .y1((d) => yBrush(Math.max(0, d.cases)))
    .curve(d3.curveCatmullRom.alpha(0.85));

  const brushG = g
    .selectAll("g.brush-panel")
    .data([null])
    .join("g")
    .attr("class", "brush-panel")
    .attr("transform", `translate(0,${brushTop})`)
    .attr("clip-path", "url(#viz1-brush-clip)");

  brushG
    .selectAll("path.brush-area")
    .data([series])
    .join("path")
    .attr("class", "brush-area")
    .attr("fill", "rgba(2, 6, 23, 0.08)")
    .attr("d", areaBrush)
    .attr("pointer-events", "none");

  brushG
    .selectAll("g.axis.brush-x")
    .data([null])
    .join("g")
    .attr("class", "axis x brush-x")
    .attr("transform", `translate(0,${brushH})`)
    .call(d3.axisBottom(xBrush).ticks(10).tickFormat(d3.format("d")));

  const updateZoomDomain = (domain) => {
    x.domain(domain);
    g.select("g.axis.x.main-x").call(xAxis);

    // Cancel in-flight transitions before applying brush-driven redraws.
    plotG.select("path.cases-area").interrupt().attr("d", areaCases(series));
    plotG.selectAll("path.cov-line-seg").each(function () {
      d3.select(this).interrupt();
    });
    plotG.selectAll("path.cov-line-seg").data(coverageSegments(), covSegKey).attr("d", (seg) => lineCoverageSeg(seg.points));
    plotG.select("path.danger-area").interrupt().attr("d", areaDanger(series));
    plotG.select("path.safe-area").interrupt().attr("d", areaSafe(series));
  };

  const brushed = (event) => {
    const selection = event?.selection;

    // If the brush is cleared, reset to the full domain.
    if (!selection) {
      updateZoomDomain(xFull.domain());
      return;
    }

    const [x0, x1] = selection;
    if (!Number.isFinite(x0) || !Number.isFinite(x1) || x0 === x1) return;

    const domain = [xBrush.invert(x0), xBrush.invert(x1)];
    updateZoomDomain(domain);
  };

  const brush = d3
    .brushX()
    .extent([
      [0, 0],
      [innerW, brushH],
    ])
    .on("brush end", brushed);

  const brushSel = brushG.selectAll("g.brush").data([null]).join("g").attr("class", "brush").call(brush);

  brushSel.selectAll(".overlay").attr("cursor", "crosshair");
  brushSel.selectAll(".selection").attr("fill", "rgba(14, 165, 233, 0.16)").attr("stroke", "rgba(14, 165, 233, 0.75)");
  brushSel.selectAll(".handle").attr("fill", "rgba(14, 165, 233, 0.9)");

  // Initialize / reset brush to full width so the main axis starts un-zoomed.
  brushSel.call(brush.move, xBrush.range());

  // Title
  svg
    .selectAll("text.chart-title")
    .data([null])
    .join("text")
    .attr("class", "chart-title")
    .attr("x", margin.left)
    .attr("y", 30)
    .attr("fill", THEME.fg)
    .attr("font-family", '"Playfair Display", Georgia, serif')
    .attr("font-size", 20)
    .text(`Outbreak Timeline — ${country}`);

  // Layer visibility (vaccination vs cases): axes, marks, and brush context.
  const pe = (on) => (on ? null : "none");
  g.select("g.axis-yL").style("opacity", showVacc ? 1 : 0).style("pointer-events", pe(showVacc));
  g.select("text.yL-label").style("opacity", showVacc ? 1 : 0);
  g.select("line.threshold").style("opacity", showVacc ? 1 : 0);
  g.select("text.threshold-label").style("opacity", showVacc ? 1 : 0);
  plotG.selectAll("path.cov-line-seg").style("opacity", showVacc ? 1 : 0);
  plotG.select("path.danger-area").style("opacity", showVacc ? 1 : 0);
  plotG.select("path.safe-area").style("opacity", showVacc ? 1 : 0);
  plotG.select("path.cases-area").style("opacity", showCases ? 1 : 0);
  g.select("g.axis-yR").style("opacity", showCases ? 1 : 0).style("pointer-events", pe(showCases));
  g.select("text.yR-label").style("opacity", showCases ? 1 : 0);
  brushG.select("path.brush-area").style("opacity", showCases ? 1 : 0.22);
};

// -----------------------------
// Visualization 2: Global Threat Map (choropleth + bubbles + play/slider + zoom)
// -----------------------------
const renderThreatMap = async ({ mount, rows, year, diseaseLabel = "Measles" }) => {
  const width = 1100;
  const height = 760;
  const margin = { top: 18, right: 18, bottom: 18, left: 18 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const svg = d3
    .select(mount)
    .selectAll("svg")
    .data([null])
    .join("svg")
    .attr("viewBox", `0 0 ${width} ${height}`);

  const gRoot = svg
    .selectAll("g.root")
    .data([null])
    .join("g")
    .attr("class", "root")
    .attr("transform", `translate(${margin.left},${margin.top})`);

  // GeoJSON setup:
  // - Use Natural Earth projection for a clean global view
  // - Fit to the drawing area
  const projection = d3.geoNaturalEarth1();
  const path = d3.geoPath(projection);

  // Load TopoJSON world (public CDN). If this fails (offline), we show a friendly message.
  const worldUrl = "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json";
  let world;
  try {
    world = await d3.json(worldUrl);
  } catch (e) {
    d3.select(mount)
      .selectAll("div.error")
      .data([null])
      .join("div")
      .attr("class", "p-3")
      .style("color", "rgba(15,23,42,0.75)")
      .html(
        "Couldn’t load the world map file. If you’re offline, download <code>countries-110m.json</code> and point the code to a local copy."
      );
    return;
  }

  // TopoJSON dependency sanity check
  if (typeof topojson === "undefined" || !topojson?.feature) {
    throw new Error(
      "TopoJSON not available. Ensure `topojson-client.min.js` is loaded before `js/script.js`."
    );
  }
  if (!world?.objects?.countries) {
    throw new Error("World TopoJSON missing `objects.countries` (unexpected format).");
  }

  const countries = topojson.feature(world, world.objects.countries).features;
  projection.fitSize([innerW, innerH], { type: "FeatureCollection", features: countries });

  // Build quick lookup for coverage/cases by country name for selected year
  const yearRows = rows
    .filter((d) => d.disease === diseaseLabel)
    .filter((d) => d.year === year)
    .filter((d) => d.country);

  const byCountry = new Map(yearRows.map((d) => [normalizeName(d.country), d]));

  // Choropleth scale (coverage)
  const covColor = d3
    .scaleLinear()
    .domain([70, 80, 95, 100])
    .range(["#CBD5E1", "#94A3B8", "#34D399", THEME.cyan])
    .clamp(true);

  // Bubble scale (cases)
  const casesMax = d3.max(yearRows, (d) => (Number.isFinite(d.cases) ? d.cases : 0)) || 1;
  const bubbleR = d3.scaleSqrt().domain([0, casesMax]).range([0, 28]).clamp(true);

  const mapG = gRoot.selectAll("g.map").data([null]).join("g").attr("class", "map");
  const bubbleG = gRoot.selectAll("g.bubbles").data([null]).join("g").attr("class", "bubbles");

  const clearMapHover = () => {
    mapG
      .selectAll("path.country")
      .attr("stroke", "rgba(15, 23, 42, 0.12)")
      .attr("stroke-width", 0.6)
      .attr("opacity", 1);
    bubbleG
      .selectAll("circle.bubble")
      .attr("stroke", "rgba(255, 65, 54, 0.55)")
      .attr("stroke-width", 1)
      .attr("fill", "rgba(255, 65, 54, 0.35)")
      .attr("opacity", 1);
  };

  const highlightCountryByName = (countryName) => {
    const key = normalizeName(countryName);
    mapG
      .selectAll("path.country")
      .attr("opacity", (f) => (normalizeName(f.properties?.name ?? "") === key ? 1 : 0.42))
      .attr("stroke", (f) => (normalizeName(f.properties?.name ?? "") === key ? "rgba(15, 23, 42, 0.75)" : "rgba(15, 23, 42, 0.12)"))
      .attr("stroke-width", (f) => (normalizeName(f.properties?.name ?? "") === key ? 1.6 : 0.6));
    bubbleG
      .selectAll("circle.bubble")
      .attr("opacity", (d) => (normalizeName(d.country ?? "") === key ? 1 : 0.25))
      .attr("fill", (d) => (normalizeName(d.country ?? "") === key ? "rgba(255, 65, 54, 0.6)" : "rgba(255, 65, 54, 0.28)"))
      .attr("stroke-width", (d) => (normalizeName(d.country ?? "") === key ? 1.8 : 1));
  };

  // Base map
  mapG
    .selectAll("path.country")
    .data(countries, (d) => d.id)
    .join("path")
    .attr("class", "country")
    .attr("d", path)
    .attr("fill", (f) => {
      const name = normalizeName(f.properties?.name ?? "");
      const d = byCountry.get(name);
      const cov = d?.coverage;
      return Number.isFinite(cov) ? covColor(cov) : "#E2E8F0";
    })
    .attr("stroke", "rgba(15, 23, 42, 0.12)")
    .attr("stroke-width", 0.6)
    .on("mousemove", (event, f) => {
      const name = normalizeName(f.properties?.name ?? "");
      const d = byCountry.get(name);
      if (!d) return;
      highlightCountryByName(d.country);
      showTooltip(
        [
          `<div class="tooltip-v">${escapeHtml(d.country)}</div>`,
          `<div><span class="tooltip-k">Year</span>: <span class="tooltip-v">${d.year}</span></div>`,
          `<div><span class="tooltip-k">Coverage</span>: <span class="tooltip-v">${fmtPct(d.coverage)}</span></div>`,
          `<div><span class="tooltip-k">Cases</span>: <span class="tooltip-v">${fmtInt(Math.round(d.cases ?? 0))}</span></div>`,
        ].join(""),
        event.clientX,
        event.clientY
      );
    })
    .on("mouseleave", () => {
      clearMapHover();
      hideTooltip();
    });

  // Bubbles at country centroids (approx) for countries we can match by name
  const bubbleData = countries
    .map((f) => {
      const name = normalizeName(f.properties?.name ?? "");
      const d = byCountry.get(name);
      if (!d || !Number.isFinite(d.cases)) return null;
      const [cx, cy] = path.centroid(f);
      return { feature: f, name: f.properties?.name ?? "", cx, cy, ...d };
    })
    .filter(Boolean);

  bubbleG
    .selectAll("circle.bubble")
    .data(bubbleData, (d) => d.feature.id)
    .join(
      (enter) =>
        enter
          .append("circle")
          .attr("class", "bubble")
          .attr("cx", (d) => d.cx)
          .attr("cy", (d) => d.cy)
          .attr("r", 0)
          .attr("fill", "rgba(255, 65, 54, 0.35)")
          .attr("stroke", "rgba(255, 65, 54, 0.55)")
          .attr("stroke-width", 1)
          .call((sel) => sel.transition().duration(800).attr("r", (d) => bubbleR(d.cases))),
      (update) =>
        update.call((sel) =>
          sel
            .transition()
            .duration(800)
            .attr("cx", (d) => d.cx)
            .attr("cy", (d) => d.cy)
            .attr("r", (d) => bubbleR(d.cases))
        ),
      (exit) => exit.call((sel) => sel.transition().duration(300).attr("r", 0).remove())
    )
    .on("mousemove", (event, d) => {
      highlightCountryByName(d.country);
      showTooltip(
        [
          `<div class="tooltip-v">${escapeHtml(d.country)}</div>`,
          `<div><span class="tooltip-k">Year</span>: <span class="tooltip-v">${d.year}</span></div>`,
          `<div><span class="tooltip-k">Coverage</span>: <span class="tooltip-v">${fmtPct(d.coverage)}</span></div>`,
          `<div><span class="tooltip-k">Cases</span>: <span class="tooltip-v">${fmtInt(Math.round(d.cases ?? 0))}</span></div>`,
        ].join(""),
        event.clientX,
        event.clientY
      );
    })
    .on("mouseleave", () => {
      clearMapHover();
      hideTooltip();
    });

  svg
    .selectAll("text.chart-title")
    .data([null])
    .join("text")
    .attr("class", "chart-title")
    .attr("x", margin.left + 10)
    .attr("y", 30)
    .attr("fill", THEME.fg)
    .attr("font-family", '"Playfair Display", Georgia, serif')
    .attr("font-size", 20)
    .text(`Global Outbreak Map — ${diseaseLabel} (${year})`);
};

// -----------------------------
// Utility helpers
// -----------------------------
const slug = (s) =>
  String(s)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/(^-|-$)/g, "");

// Normalize country names for map joins (WHO "Location" vs map feature names).
// This is intentionally conservative; add aliases as you encounter mismatches.
const normalizeName = (s) => {
  const base = String(s)
    .trim()
    .toLowerCase()
    .replaceAll("&", "and")
    .replaceAll(/[^a-z0-9\s-]/g, "")
    .replaceAll(/\s+/g, " ");

  const aliases = new Map([
    ["united states of america", "united states"],
    ["russian federation", "russia"],
    ["iran islamic republic of", "iran"],
    ["venezuela bolivarian republic of", "venezuela"],
    ["bolivia plurinational state of", "bolivia"],
    ["tanzania united republic of", "tanzania"],
    ["viet nam", "vietnam"],
    ["lao peoples democratic republic", "laos"],
    ["syrian arab republic", "syria"],
    ["cote divoire", "cote d ivoire"],
    ["democratic republic of the congo", "congo"],
    ["congo the democratic republic of the", "congo"],
    ["republic of korea", "south korea"],
    ["korea republic of", "south korea"],
    ["korea democratic peoples republic of", "north korea"],
  ]);

  return aliases.get(base) ?? base;
};

const escapeHtml = (s) =>
  String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

// Call measles visualization
measlesSpreadVis();

// -----------------------------
// Main: load -> merge -> interpolate -> render
// -----------------------------
async function main() {
  // Promise.all() for paired CSV loads (cases vs coverage for each disease)
  const [measlesCases, measlesCoverage, diphtheriaCases, pertussisCases, dtpCoverage, polioCases, polioCoverage] =
    await Promise.all([
      d3.csv(DATA_FILES.measlesCases),
      d3.csv(DATA_FILES.measlesCoverage),
      d3.csv(DATA_FILES.diphtheriaCases),
      d3.csv(DATA_FILES.pertussisCases),
      d3.csv(DATA_FILES.dtpCoverage),
      d3.csv(DATA_FILES.polioCases),
      d3.csv(DATA_FILES.polioCoverage),
    ]);

  const assertArray = (name, v) => {
    if (!Array.isArray(v)) throw new Error(`${name} did not load as an array`);
  };
  assertArray("measlesCases", measlesCases);
  assertArray("measlesCoverage", measlesCoverage);
  assertArray("diphtheriaCases", diphtheriaCases);
  assertArray("pertussisCases", pertussisCases);
  assertArray("dtpCoverage", dtpCoverage);
  assertArray("polioCases", polioCases);
  assertArray("polioCoverage", polioCoverage);

  // Combine diphtheria + pertussis incidence (sum of reported cases per country-year)
  const dtpCasesCombined = combineCasesSum({
    disease: "Diphtheria/Pertussis",
    rowsA: diphtheriaCases,
    rowsB: pertussisCases,
  });

  // Merge on (Country, Year) and cast numerics
  const mergedRaw = [
    ...mergeCaseCoverage({
      disease: "Measles",
      casesRows: measlesCases,
      coverageRows: measlesCoverage,
      countryKey: "Location",
      yearKey: "Period",
      casesKey: "FactValueNumeric",
      coverageKey: "FactValueNumeric",
    }),
    ...mergeCaseCoverage({
      disease: "Diphtheria/Pertussis",
      casesRows: dtpCasesCombined,
      coverageRows: dtpCoverage,
      countryKey: "Location",
      yearKey: "Period",
      casesKey: "FactValueNumeric",
      coverageKey: "FactValueNumeric",
    }),
    ...mergeCaseCoverage({
      disease: "Polio",
      casesRows: polioCases,
      coverageRows: polioCoverage,
      countryKey: "Location",
      yearKey: "Period",
      casesKey: "FactValueNumeric",
      coverageKey: "FactValueNumeric",
    }),
  ];

  // Interpolate missing years inside each country series so curves are continuous
  const merged = interpolateSeries(mergedRaw);

  // -----------------------------
  // Viz 1: Outbreak Timeline controls + initial render (Measles)
  // -----------------------------
  const measles = merged.filter((d) => d.disease === "Measles");
  const yearMax = d3.max(measles, (d) => d.year);
  const yearMin = Number.isFinite(yearMax) ? yearMax - 24 : d3.min(measles, (d) => d.year);
  const measlesRecent = measles.filter((d) => d.year >= yearMin && d.year <= yearMax);

  let viz1TourStep = -1;
  let viz1ControlsBound = false;

  const renderViz1 = () => {
    // Include every available country in alphabetical order.
    const allCountries = Array.from(new Set(measlesRecent.map((d) => d.country).filter(Boolean))).sort((a, b) =>
      d3.ascending(a, b)
    );

    const countrySelect = document.querySelector("#countrySelect");
    const initialCountry = allCountries.includes("United States") ? "United States" : allCountries[0] ?? "United States";
    if (countrySelect) {
      const previous = countrySelect.value;
      d3.select(countrySelect)
        .selectAll("option")
        .data(allCountries, (d) => d)
        .join("option")
        .attr("value", (d) => d)
        .text((d) => d);
      const nextCountry = previous && allCountries.includes(previous) ? previous : initialCountry;
      countrySelect.value = nextCountry;

      const syncViz1WalkthroughButton = () => {
        const btn = document.querySelector("#viz1-walkthrough");
        if (!btn) return;
        if (viz1TourStep < 0) {
          btn.textContent = "Start";
          btn.setAttribute("aria-label", "Start guided tour of chart layers");
        } else if (viz1TourStep < VIZ1_WALKTHROUGH_STEPS.length - 1) {
          btn.textContent = "Next";
          btn.setAttribute("aria-label", "Next step of guided tour");
        } else {
          btn.textContent = "Done";
          btn.setAttribute("aria-label", "Finish guided tour");
        }
      };

      const redrawViz1 = () => {
        if (viz1TourStep < 0) updateViz1StoryCaption();
        renderOutbreakTimeline({
          mount: tippingMount,
          country: countrySelect.value,
          rows: measlesRecent,
          threshold: 95,
          layers: readViz1LayersFromDom(),
        });
      };

      const endViz1TourAndRedraw = () => {
        viz1TourStep = -1;
        syncViz1WalkthroughButton();
        redrawViz1();
      };

      if (!viz1ControlsBound) {
        viz1ControlsBound = true;
        countrySelect.addEventListener("change", endViz1TourAndRedraw);
        document.querySelector("#viz1-layer-cases")?.addEventListener("change", endViz1TourAndRedraw);
        document.querySelector("#viz1-layer-vacc")?.addEventListener("change", endViz1TourAndRedraw);
        document.querySelector("#viz1-walkthrough")?.addEventListener("click", () => {
          const btn = document.querySelector("#viz1-walkthrough");
          const cap = document.querySelector("#viz1-story-caption");
          const c = document.querySelector("#viz1-layer-cases");
          const v = document.querySelector("#viz1-layer-vacc");
          if (!btn || !cap || !c || !v) return;

          const last = VIZ1_WALKTHROUGH_STEPS.length - 1;

          if (viz1TourStep === last) {
            viz1TourStep = -1;
            v.checked = true;
            c.checked = true;
            enforceViz1LayerCheckboxes();
            updateViz1StoryCaption();
            syncViz1WalkthroughButton();
            redrawViz1();
            return;
          }

          if (viz1TourStep < 0) viz1TourStep = 0;
          else viz1TourStep += 1;

          const step = VIZ1_WALKTHROUGH_STEPS[viz1TourStep];
          v.checked = step.vacc;
          c.checked = step.cases;
          enforceViz1LayerCheckboxes();
          cap.innerHTML = step.html;
          syncViz1WalkthroughButton();
          renderOutbreakTimeline({
            mount: tippingMount,
            country: countrySelect.value,
            rows: measlesRecent,
            threshold: 95,
            layers: readViz1LayersFromDom(),
          });
        });
        syncViz1WalkthroughButton();
      }

      redrawViz1();
    } else {
      updateViz1StoryCaption();
      renderOutbreakTimeline({
        mount: tippingMount,
        country: initialCountry,
        rows: measlesRecent,
        threshold: 95,
        layers: readViz1LayersFromDom(),
      });
    }
  };

  try {
    renderViz1();
  } catch (e) {
    console.error("Viz1 failed", e);
    d3.select(tippingMount)
      .selectAll("div.error")
      .data([null])
      .join("div")
      .attr("class", "p-3")
      .style("color", "rgba(15,23,42,0.82)")
      .html(
        [
          `<div style="font-weight:600">Viz 1 failed</div>`,
          `<div style="margin-top:6px;"><code>${escapeHtml(e?.message ?? String(e))}</code></div>`,
          `<details style="margin-top:8px;"><summary style="cursor:pointer; opacity:0.8;">Stack trace</summary><pre style="white-space:pre-wrap; margin-top:8px;">${escapeHtml(e?.stack ?? "(no stack)")}</pre></details>`,
        ].join("")
      );
  }

  // -----------------------------
  // Viz 2: Threat Map (disease dropdown + play/slider)
  // -----------------------------
  const mapDiseaseSelect = document.querySelector("#mapDisease");
  const mapYearSlider = document.querySelector("#mapYear");
  const mapYearLabel = document.querySelector("#mapYearLabel");
  const mapPlayBtn = document.querySelector("#mapPlay");

  const mapDiseaseOptions = ["Measles", "Diphtheria/Pertussis", "Polio"];
  let mapDisease = "Measles";
  let mapYears = [];
  let mapYear = null;
  let playing = false;
  let playTimer = null;

  const getValidMapYears = (disease) =>
    Array.from(
      d3.rollup(
        merged.filter((d) => d.disease === disease && Number.isFinite(d.year)),
        (rows) => rows.some((r) => Number.isFinite(r.coverage) && Number.isFinite(r.cases)),
        (d) => d.year
      ),
      ([year, hasBoth]) => (hasBoth ? year : null)
    )
      .filter(Number.isFinite)
      .sort(d3.ascending);

  const stopMapPlayback = () => {
    playing = false;
    if (playTimer) window.clearInterval(playTimer);
    playTimer = null;
    if (mapPlayBtn) mapPlayBtn.textContent = "Play";
  };

  const updateMapUi = () => {
    if (mapYearLabel) mapYearLabel.textContent = Number.isFinite(mapYear) ? String(mapYear) : "No valid years";
    if (mapYearSlider) {
      if (!mapYears.length) {
        mapYearSlider.disabled = true;
        return;
      }
      mapYearSlider.disabled = false;
      mapYearSlider.min = String(mapYears[0]);
      mapYearSlider.max = String(mapYears.at(-1));
      mapYearSlider.step = "1";
      mapYearSlider.value = String(mapYear);
    }
  };

  const renderMap = async () => {
    if (!Number.isFinite(mapYear)) return;
    await renderThreatMap({ mount: heatmapMount, rows: merged, year: mapYear, diseaseLabel: mapDisease });
  };

  const resetYearsForDisease = (disease) => {
    mapYears = getValidMapYears(disease);
    mapYear = mapYears[0] ?? null; // Start at first year with BOTH coverage and cases data.
    updateMapUi();
  };

  if (mapDiseaseSelect) {
    d3.select(mapDiseaseSelect)
      .selectAll("option")
      .data(mapDiseaseOptions, (d) => d)
      .join("option")
      .attr("value", (d) => d)
      .text((d) => d);
    mapDiseaseSelect.value = mapDisease;
    mapDiseaseSelect.addEventListener("change", async () => {
      mapDisease = mapDiseaseSelect.value;
      stopMapPlayback();
      resetYearsForDisease(mapDisease);
      await renderMap();
    });
  }

  resetYearsForDisease(mapDisease);

  if (mapYearSlider) {
    mapYearSlider.addEventListener("input", async () => {
      mapYear = Number(mapYearSlider.value);
      updateMapUi();
      await renderMap();
    });
  }

  if (mapPlayBtn) {
    mapPlayBtn.addEventListener("click", async () => {
      playing = !playing;
      mapPlayBtn.textContent = playing ? "Pause" : "Play";
      if (!playing) {
        stopMapPlayback();
        return;
      }
      if (!mapYears.length) {
        stopMapPlayback();
        return;
      }
      playTimer = window.setInterval(async () => {
        const idx = mapYears.indexOf(mapYear);
        mapYear = mapYears[(idx + 1) % mapYears.length];
        updateMapUi();
        await renderMap();
      }, 900);
    });
  }

  updateMapUi();
  try {
    await renderMap();
  } catch (e) {
    console.error("Viz2 failed", e);
    d3.select(heatmapMount)
      .selectAll("div.error")
      .data([null])
      .join("div")
      .attr("class", "p-3")
      .style("color", "rgba(15,23,42,0.82)")
      .html(
        `<div style="font-weight:600">Viz 2 failed</div><div><code>${escapeHtml(e?.message ?? String(e))}</code></div>`
      );
  }

}

// Friendly failure mode if CSVs can’t be loaded (missing files or page not served over HTTP).
main().catch((err) => {
  console.error(err);
  const mounts = [tippingMount, heatmapMount];
  for (const m of mounts) {
    d3.select(m)
      .selectAll("div.error")
      .data([null])
      .join("div")
      .attr("class", "p-3")
      .style("color", "rgba(15,23,42,0.82)")
      .style("font-family", "Inter, system-ui, sans-serif")
      .html(
        [
          "<div style='font-weight:600; margin-bottom: 6px;'>Data load failed</div>",
          "<div style='opacity:0.85; font-size: 0.95rem;'>",
          "<div style='margin-bottom: 10px;'>If you opened <code>index.html</code> by double-clicking, the browser will block CSV fetches. Run a local server (Live Server, or <code>python3 -m http.server</code>) and open the page via <code>http://</code>.</div>",
          `<div style='margin-bottom: 10px;'><span style='opacity:0.75;'>Error:</span> <code>${escapeHtml(err?.message ?? String(err))}</code></div>`,
          `<details style='margin-bottom: 10px;'><summary style='cursor:pointer; opacity:0.8;'>Stack trace</summary><pre style='white-space:pre-wrap; margin-top:8px;'>${escapeHtml(err?.stack ?? "(no stack)")}</pre></details>`,
          "Expected filenames:",
          "<ul style='margin: 8px 0 0 18px;'>",
          Object.values(DATA_FILES)
            .map((f) => `<li><code>${escapeHtml(f)}</code></li>`)
            .join(""),
          "</ul>",
          "<div style='margin-top: 10px; opacity:0.8;'>If your CSV columns differ from WHO defaults (<code>Location</code>/<code>Period</code>/<code>FactValueNumeric</code>), update the merge config in <code>js/script.js</code>.</div>",
          "</div>",
        ].join("")
      );
  }
});
