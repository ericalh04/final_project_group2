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
  muted: "rgba(224,224,224,0.72)",
  cyan: "#2DE2E6",
  teal: "#00D1B2",
  outbreak: "#FF4136",
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

// -----------------------------
// Visualization 1: Outbreak Timeline (dual-axis + brush + dropdown)
// -----------------------------
const renderOutbreakTimeline = ({ mount, country, rows, threshold = 95 }) => {
  const width = 1100;
  const height = 760;
  const margin = { top: 64, right: 86, bottom: 118, left: 72 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;

  const brushH = 64;
  const brushGap = 36;
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

  // Axis labels
  g.selectAll("text.yL-label")
    .data([null])
    .join("text")
    .attr("class", "yL-label")
    .attr("x", 0)
    .attr("y", -18)
    .attr("fill", THEME.muted)
    .attr("font-size", 12)
    .text("Coverage (MCV1)");

  g.selectAll("text.yR-label")
    .data([null])
    .join("text")
    .attr("class", "yR-label")
    .attr("x", innerW)
    .attr("y", -18)
    .attr("text-anchor", "end")
    .attr("fill", THEME.muted)
    .attr("font-size", 12)
    .text("Cases (log)");

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

  const lineCoverage = d3
    .line()
    .defined((d) => Number.isFinite(d.year) && Number.isFinite(d.coverage))
    .x((d) => x(d.year))
    .y((d) => yCov(d.coverage))
    .curve(d3.curveCatmullRom.alpha(0.85));

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
          .attr("fill", "url(#casesGrad)")
          .attr("opacity", 0.95)
          .attr("d", areaCases),
      (update) => update.transition().duration(800).attr("d", areaCases)
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
          .attr("fill", "rgba(255, 65, 54, 0.18)")
          .attr("d", areaDanger),
      (update) => update.transition().duration(800).attr("d", areaDanger)
    );

  // Coverage line (left axis)
  plotG
    .selectAll("path.cov-line")
    .data([series])
    .join(
      (enter) =>
        enter
          .append("path")
          .attr("class", "cov-line")
          .attr("fill", "none")
          .attr("stroke", THEME.teal)
          .attr("stroke-width", 2.5)
          .attr("d", lineCoverage),
      (update) => update.transition().duration(800).attr("d", lineCoverage)
    );

  // Gradients for the cases area fill (stark orange/red near top)
  // This is purely visual and does not affect scales.
  const defs = svg.selectAll("defs").data([null]).join("defs");
  const grad = defs.selectAll("linearGradient#casesGrad").data([null]).join("linearGradient").attr("id", "casesGrad");
  grad.attr("x1", "0%").attr("x2", "0%").attr("y1", "100%").attr("y2", "0%");
  grad
    .selectAll("stop")
    .data([
      { o: "0%", c: "rgba(255, 65, 54, 0.10)" },
      { o: "55%", c: "rgba(255, 133, 27, 0.35)" },
      { o: "100%", c: "rgba(255, 65, 54, 0.72)" },
    ])
    .join("stop")
    .attr("offset", (d) => d.o)
    .attr("stop-color", (d) => d.c);

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
    .attr("fill", THEME.teal)
    .attr("stroke", "#ffffff")
    .attr("stroke-width", 1.5);

  focusG
    .selectAll("circle.focus-cases")
    .data([null])
    .join("circle")
    .attr("class", "focus-cases")
    .attr("r", 4.5)
    .attr("fill", THEME.outbreak)
    .attr("stroke", "#ffffff")
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
        .attr("display", covValid ? null : "none")
        .attr("cx", px)
        .attr("cy", covValid ? yCov(d.coverage) : 0);
      focusG
        .select("circle.focus-cases")
        .attr("display", casesValid ? null : "none")
        .attr("cx", px)
        .attr("cy", casesValid ? yCases(d.casesClamped) : 0);

      const [bx, by] = d3.pointer(event, document.body);
      const below = Number.isFinite(d.coverage) && d.coverage < threshold;
      showTooltip(
        [
          `<div class="tooltip-v">${escapeHtml(country)}</div>`,
          `<div><span class="tooltip-k">Year</span>: <span class="tooltip-v">${d.year}</span></div>`,
          `<div><span class="tooltip-k">Coverage</span>: <span class="tooltip-v">${fmtPct(d.coverage)}</span></div>`,
          `<div><span class="tooltip-k">Cases</span>: <span class="tooltip-v">${fmtInt(Math.round(d.cases ?? 0))}</span></div>`,
          `<div><span class="tooltip-k">Threshold</span>: <span class="tooltip-v">${below ? "Below (danger)" : "Above"}</span></div>`,
        ].join(""),
        bx,
        by
      );
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
    plotG.select("path.cov-line").interrupt().attr("d", lineCoverage(series));
    plotG.select("path.danger-area").interrupt().attr("d", areaDanger(series));
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

// ─────────────────────────────────────────────────────────────────────────────
// Visualization 3: Measles Spread Animation (John radial spread)
//
// Illustrates measles infectivity by showing one person (John) at the centre
// of the canvas and animating waves of 12–18 newly-infected people radiating
// outward every 4 seconds.  Red infection circles grow on each person 2 seconds
// after they appear, taking 2 seconds to reach full size.
//
// DOM elements expected in index.html (all inside #vis-measles-spread):
//   #measles-spread-svg    — the <svg> tag D3 draws into
//   #measles-spread-title  — <h4> updated with wave narrative
//   #measles-spread-sub    — <p>  updated with running commentary
//   #measles-spread-btn    — <button> that starts / stops / resets
//   #measles-spread-count  — inline <strong> showing total infected
// ─────────────────────────────────────────────────────────────────────────────
const renderMeaslesSpread = () => {

  // ── Canvas & layout constants ──────────────────────────────────────────────
  const W = 660, H = 380;          // SVG viewBox dimensions (px)
  const SCALE = 0.4;              // uniform scale factor for all stick figures
  const CELL_W = 20, CELL_H = 30; // width × height of each person's grid cell
  const COLS = Math.floor(W / CELL_W);
  const ROWS = Math.floor(H / CELL_H);

  // Timing constants (all in milliseconds)
  const WAVE_INTERVAL    = 4000;  // new wave of infections every 4 seconds
  const INFECTION_DELAY  = 2000;  // red circle starts growing 2s after person appears
  const INFECTION_DUR    = 2000;  // red circle takes 2s to reach full radius
  const MAX_RUNTIME      = 30000; // auto-stop after 30 seconds of spreading

  // ── DOM handles ────────────────────────────────────────────────────────────
  const svgEl      = document.querySelector("#measles-spread-svg");
  const titleEl    = document.querySelector("#measles-spread-title");
  const subEl      = document.querySelector("#measles-spread-sub");
  const btnEl      = document.querySelector("#measles-spread-btn");
  const countEl    = document.querySelector("#measles-spread-count");

  // Bail out gracefully if the HTML mount points are missing
  if (!svgEl || !titleEl || !subEl || !btnEl || !countEl) {
    console.warn("renderMeaslesSpread: one or more DOM elements not found; skipping.");
    return;
  }

  // Bind D3 to the existing <svg> element and set a fixed viewBox so the
  // coordinate space is always 660 × 380, regardless of screen width.
  const svg = d3.select(svgEl).attr("viewBox", `0 0 ${W} ${H}`);

  // ── State variables ────────────────────────────────────────────────────────
  let phase         = "initial";  // "initial" | "spreading" | "done"
  let timer         = null;       // handle returned by setInterval
  let elapsed       = 0;          // ms elapsed since spreading began
  let totalInfected = 1;          // running count (John starts infected)
  let generation    = 0;          // wave counter (increments each interval)
  let occupiedSlots = new Set();  // set of grid slot indices already filled

  // ── Grid helpers ───────────────────────────────────────────────────────────

  /**
   * Convert a linear slot index → pixel centre {x, y}.
   * Slots are numbered left-to-right, top-to-bottom.
   */
  const slotToXY = (slot) => ({
    x: (slot % COLS + 0.5) * CELL_W,
    y: (Math.floor(slot / COLS) + 0.5) * CELL_H + 8,
  });

  /**
   * Return the slot index whose centre is closest to pixel (cx, cy).
   * Used to pin John to the exact centre of the canvas.
   */
  const xyToSlot = (cx, cy) => {
    const col = Math.round(cx / CELL_W - 0.5);
    const row = Math.round((cy - 8) / CELL_H - 0.5);
    return Math.max(0, Math.min(COLS * ROWS - 1, row * COLS + col));
  };

  /**
   * Return up to `n` free (unoccupied) slot indices sorted by distance from
   * origin (ox, oy), so each new wave radiates outward from John's position.
   */
  const getRadialFreeSlots = (n, ox, oy) => {
    const candidates = [];
    for (let i = 0; i < COLS * ROWS; i++) {
      if (occupiedSlots.has(i)) continue;
      const { x, y } = slotToXY(i);
      candidates.push({ slot: i, dist: Math.hypot(x - ox, y - oy) });
    }
    // Nearest-first → wave expands outward like a ripple
    candidates.sort((a, b) => a.dist - b.dist);
    return candidates.slice(0, n).map(c => c.slot);
  };

  // ── Drawing helpers ────────────────────────────────────────────────────────

  /**
   * Append a stick figure centred at (cx, cy) to `parentG`.
   * Returns the y-coordinate of the chest, where the infection circle is placed.
   *
   * @param {d3.Selection} parentG - The <g> element to draw into.
   * @param {number}       cx      - Horizontal centre of the figure.
   * @param {number}       cy      - Vertical anchor (waist level) of the figure.
   * @param {number}       s       - Uniform scale multiplier.
   * @param {string}       color   - CSS colour string for all body parts.
   * @returns {number} chestY - Y coordinate of the chest centre.
   */
  const drawPerson = (parentG, cx, cy, s, color) => {
    const headR   = 7  * s;
    const headY   = cy - 20 * s;          // centre of the head circle
    const bTop    = headY + headR;         // top of torso line
    const bBot    = bTop  + 20 * s;        // bottom of torso line
    const armY    = bTop  + 7  * s;        // y-level of the arm bar
    const armSpan = 10 * s;               // half-width of arms
    const legSpan = 6  * s;               // horizontal spread of legs at foot
    const legLen  = 18 * s;               // vertical length of each leg

    parentG.append("circle")              // head
      .attr("cx", cx).attr("cy", headY).attr("r", headR)
      .attr("fill", color);

    parentG.append("line")               // torso
      .attr("x1", cx).attr("y1", bTop).attr("x2", cx).attr("y2", bBot)
      .attr("stroke", color).attr("stroke-width", 3 * s);

    parentG.append("line")               // arms
      .attr("x1", cx - armSpan).attr("y1", armY)
      .attr("x2", cx + armSpan).attr("y2", armY)
      .attr("stroke", color).attr("stroke-width", 2.5 * s);

    parentG.append("line")               // left leg
      .attr("x1", cx).attr("y1", bBot)
      .attr("x2", cx - legSpan).attr("y2", bBot + legLen)
      .attr("stroke", color).attr("stroke-width", 2.5 * s);

    parentG.append("line")               // right leg
      .attr("x1", cx).attr("y1", bBot)
      .attr("x2", cx + legSpan).attr("y2", bBot + legLen)
      .attr("stroke", color).attr("stroke-width", 2.5 * s);

    // Return chest Y so the caller can position the infection circle
    return bTop + 6 * s;
  };

  /**
   * Append a red infection circle to `parentG` that:
   *   - starts at radius 0
   *   - begins growing after `delay` milliseconds
   *   - reaches its final radius over INFECTION_DUR milliseconds
   *
   * @param {d3.Selection} parentG - Container <g> to append the circle to.
   * @param {number}       cx      - Horizontal centre of the circle.
   * @param {number}       chestY  - Vertical centre (the person's chest).
   * @param {number}       s       - Scale multiplier (matches the figure's scale).
   * @param {number}       delay   - Milliseconds to wait before the grow transition starts.
   */
  const animateInfection = (parentG, cx, chestY, s, delay) => {
    parentG.append("circle")
      .attr("cx", cx).attr("cy", chestY)
      .attr("r", 0)                        // start invisible
      .attr("fill", "#E24B4A")
      .attr("opacity", 0.75)
      .transition()
        .delay(delay)
        .duration(INFECTION_DUR)
        .ease(d3.easeCubicOut)
        .attr("r", 7 * s);                 // grow to final radius
  };

  /**
   * Create one complete person (figure + infection circle) at the given grid slot.
   * The figure fades in after `appearDelay` ms; the infection circle starts growing
   * an additional INFECTION_DELAY ms after that.
   *
   * @param {number}  slot         - Grid slot index.
   * @param {number}  appearDelay  - Ms to wait before the figure fades in.
   * @param {boolean} isJohn       - If true, uses primary colour and adds a name label.
   */
  const addPersonToSvg = (slot, appearDelay, isJohn) => {
    const { x, y } = slotToXY(slot);

    // John uses the page's primary text colour; everyone else uses muted secondary
    const color = isJohn ? "black" : THEME.muted;

    // Wrap all elements for this person in a single <g> so they fade in together
    const g = svg.append("g").attr("opacity", 0);
    g.transition()
      .delay(appearDelay)
      .duration(350)
      .attr("opacity", 1);

    // Draw the stick figure and get back the chest Y for the infection circle
    const chestY = drawPerson(g, x, y, SCALE, color);

    // Schedule the infection circle: starts INFECTION_DELAY ms after the person appears
    animateInfection(g, x, chestY, SCALE, appearDelay + INFECTION_DELAY);

    // Name label centred below John's feet
    if (isJohn) {
      g.append("text")
        .attr("x", x).attr("y", y + 40)
        .attr("text-anchor", "middle")
        .attr("font-size", 11)
        .attr("font-family", "Inter, system-ui, sans-serif")
        .attr("fill", THEME.muted)
        .text("John");
    }
  };

  // ── Simulation lifecycle ───────────────────────────────────────────────────

  /**
   * Reset everything: clear the SVG, reset all state variables, and draw
   * only John at the centre of the canvas.
   */
  const init = () => {
    svg.selectAll("*").remove();   // wipe all existing SVG children
    occupiedSlots.clear();
    totalInfected = 1;
    generation    = 0;
    elapsed       = 0;
    countEl.textContent = "1";

    // Pin John to the grid slot nearest the canvas centre
    const johnSlot = xyToSlot(W / 2, H / 2);
    occupiedSlots.add(johnSlot);
    addPersonToSvg(johnSlot, 0, true);
  };

  /**
   * Emit one wave of 12–18 new infections radiating outward from John.
   * Called immediately on "Watch" click, then again every WAVE_INTERVAL ms.
   * Auto-stops when MAX_RUNTIME is exceeded or no free slots remain.
   */
  const spread = () => {
    // Stop automatically after MAX_RUNTIME ms
    if (elapsed >= MAX_RUNTIME) { stop(); return; }

    // Random number of new infections in the measles range (12–18)
    const n = Math.floor(Math.random() * 7) + 12;

    // John's pixel position stays fixed at the canvas centre
    const { x: jx, y: jy } = slotToXY(xyToSlot(W / 2, H / 2));

    // Get the nearest free slots, radiating outward from John
    const slots = getRadialFreeSlots(n, jx, jy);
    if (slots.length === 0) { stop(); return; }  // grid is full

    // Stagger each person's appearance by 80 ms so the wave ripples visually
    slots.forEach((slot, i) => {
      occupiedSlots.add(slot);
      addPersonToSvg(slot, i * 80, false);
    });

    totalInfected += slots.length;
    generation++;
    elapsed += WAVE_INTERVAL;

    // Update the narrative text and infected counter
    countEl.textContent    = totalInfected;
    titleEl.textContent    = `Generation ${generation}: ${slots.length} more people infected`;
    subEl.textContent      = `Total infected so far: ${totalInfected}`;
  };

  /**
   * Halt the animation and transition the UI into the "done" state.
   */
  const stop = () => {
    if (timer) { clearInterval(timer); timer = null; }
    phase = "done";
    btnEl.textContent   = "Reset";
    titleEl.textContent = `Outbreak stopped — ${totalInfected} people infected`;
    subEl.textContent   = "Measles spreads to 12–18 people per infected person — 6× more contagious than COVID-19.";
  };

  // ── Button handler ─────────────────────────────────────────────────────────
  btnEl.addEventListener("click", () => {
    if (phase === "initial") {
      // ── Start spreading ──────────────────────────────────────────────────
      phase = "spreading";
      btnEl.textContent  = "Stop";
      titleEl.textContent = "Measles spreads to 12–18 people per infected person…";
      subEl.textContent  = "Each wave represents one generation of new infections.";
      spread();                                     // first wave immediately
      timer = setInterval(spread, WAVE_INTERVAL);   // then every 4 seconds

    } else if (phase === "spreading") {
      // ── Stop mid-animation ───────────────────────────────────────────────
      stop();

    } else if (phase === "done") {
      // ── Full reset back to just John ─────────────────────────────────────
      phase = "initial";
      btnEl.textContent   = "Watch what happens next →";
      titleEl.textContent = "John gets infected with measles";
      subEl.textContent   = "See how quickly measles spreads — one of the most contagious diseases on Earth.";
      init();
    }
  });

  // ── Boot: draw the initial state ───────────────────────────────────────────
  init();
};

// Initialise the measles spread animation as soon as the script runs
// (D3 and the DOM are both ready at this point since the script tag is at
// the bottom of <body>, after all HTML elements have been parsed).
renderMeaslesSpread();

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

  const renderViz1 = () => {
    // Include every available country in alphabetical order.
    const allCountries = Array.from(new Set(measlesRecent.map((d) => d.country).filter(Boolean))).sort((a, b) =>
      d3.ascending(a, b)
    );

    const countrySelect = document.querySelector("#countrySelect");
    const initialCountry = allCountries.includes("United States") ? "United States" : allCountries[0] ?? "United States";
    if (countrySelect) {
      d3.select(countrySelect)
        .selectAll("option")
        .data(allCountries, (d) => d)
        .join("option")
        .attr("value", (d) => d)
        .text((d) => d);
      countrySelect.value = initialCountry;
      countrySelect.addEventListener("change", () => {
        renderOutbreakTimeline({ mount: tippingMount, country: countrySelect.value, rows: measlesRecent, threshold: 95 });
      });
    }
    renderOutbreakTimeline({ mount: tippingMount, country: initialCountry, rows: measlesRecent, threshold: 95 });
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
