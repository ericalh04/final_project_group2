/**
 * Measles spread visualization (D3)
 *
 * Shows “John” at the centre of an SVG grid; each wave adds new stick figures
 * in slots closest to existing infections. Others turn fully red after a delay;
 * John keeps a red infection disc on the chest. Each generation’s figures finish fading in over a fixed
 * duration; larger waves use a shorter stagger between individuals. If the grid runs out of empty
 * cells, the SVG grows downward and new rows are filled. Spreading runs for a fixed
 * number of waves (see `maxWaves`) or until the user clicks Stop.
 * Wired from
 * index.html; bootstrapped via `measlesSpreadVis()`
 * from script.js after the DOM exists.
 *
 * Expected markup (inside #vis-measles-spread):
 *   #measles-spread-svg, #measles-spread-title, #measles-spread-sub,
 *   #measles-spread-btn, #measles-spread-count
 */

// -----------------------------------------------------------------------------
// Configuration — layout, timing, and DOM selectors (single source of truth)
// -----------------------------------------------------------------------------

const MEASLES_SPREAD = Object.freeze({
  // SVG coordinate space (matches viewBox)
  width: 660,
  height: 380,
  // Stick-figure scale and grid cell size (px)
  figureScale: 0.4,
  cellWidth: 20,
  cellHeight: 30,
  /** Extra vertical offset so figures sit comfortably in cells */
  slotYOffset: 8,

  timing: Object.freeze({
    /**
     * Total ms for one generation’s stick figures to finish fading in: first start →
     * last at full opacity. Stagger between people is derived as
     * `(generationAppearMs - personFadeMs) / (n - 1)` so larger waves pack in faster.
     */
    generationAppearMs: 3000,
    /** Legacy floor for time between waves (matches generation length here) */
    waveIntervalMs: 3000,
    /** Ms after a person appears before the red infection circle begins growing */
    infectionDelayMs: 1000,
    /** Duration of infection circle radius tween */
    infectionGrowMs: 2000,
    /** Fade-in duration for each new person group */
    personFadeMs: 350,
  }),

  /** Each infected person spawns this many new infections per wave (random range) */
  newInfectionsPerCarrierMin: 12,
  newInfectionsPerCarrierMax: 18,

  /** Generations of new infections after “Watch”; then auto-stop (same outcome UI as Stop). */
  maxWaves: 3,

  selectors: Object.freeze({
    svg: "#measles-spread-svg",
    title: "#measles-spread-title",
    sub: "#measles-spread-sub",
    btn: "#measles-spread-btn",
    count: "#measles-spread-count",
  }),
});

// -----------------------------------------------------------------------------
// Grid geometry — pure helpers for slot ↔ pixel mapping and wave placement
// -----------------------------------------------------------------------------

/**
 * @param {number} width
 * @param {number} height
 * @param {number} cellW
 * @param {number} cellH
 * @param {number} yOffset — vertical nudge applied in slotToXY / xyToSlot
 */
function createMeaslesGrid(width, height, cellW, cellH, yOffset) {
  const cols = Math.floor(width / cellW);
  const rows = Math.floor(height / cellH);
  const slotCount = cols * rows;

  /** Linear index → centre of that grid cell (slots run left→right, top→bottom). */
  function slotToXY(slot) {
    return {
      x: (slot % cols + 0.5) * cellW,
      y: (Math.floor(slot / cols) + 0.5) * cellH + yOffset,
    };
  }

  /** Pixel position → nearest slot index (clamped to valid range). */
  function xyToSlot(cx, cy) {
    const col = Math.round(cx / cellW - 0.5);
    const row = Math.round((cy - yOffset) / cellH - 0.5);
    return Math.max(0, Math.min(slotCount - 1, row * cols + col));
  }

  /**
   * Pick up to `n` unoccupied slots, preferring cells closest to any occupied slot
   * so each wave grows outward from existing infections.
   * @param {Set<number>} occupiedSlots
   * @param {number} n
   * @returns {number[]}
   */
  function pickClusteredFreeSlots(occupiedSlots, n) {
    const candidates = [];

    for (let i = 0; i < slotCount; i++) {
      if (occupiedSlots.has(i)) continue;

      const { x, y } = slotToXY(i);
      let minDist = Infinity;

      occupiedSlots.forEach((occupiedSlot) => {
        const pos = slotToXY(occupiedSlot);
        const dist = Math.hypot(x - pos.x, y - pos.y);
        if (dist < minDist) minDist = dist;
      });

      candidates.push({ slot: i, dist: minDist });
    }

    candidates.sort((a, b) => a.dist - b.dist);
    return candidates.slice(0, n).map((c) => c.slot);
  }

  return { cols, rows, slotCount, slotToXY, xyToSlot, pickClusteredFreeSlots };
}

// -----------------------------------------------------------------------------
// Drawing — stick figure + infection animation (D3 selections)
// -----------------------------------------------------------------------------

const MEASLES_INFECTION_RED = "#E24B4A";

/**
 * Draw a simple stick figure inside a dedicated body group so infection styling
 * targets only the figure (not John’s name label or overlay circle).
 * @param {import("d3").Selection} parentG
 * @returns {{ chestY: number, bodyG: import("d3").Selection }}
 */
function drawMeaslesPersonFigure(parentG, cx, cy, scale, color) {
  const bodyG = parentG.append("g").attr("class", "measles-figure-body");

  const headR = 7 * scale;
  const headY = cy - 20 * scale;
  const bTop = headY + headR;
  const bBot = bTop + 20 * scale;
  const armY = bTop + 7 * scale;
  const armSpan = 10 * scale;
  const legSpan = 6 * scale;
  const legLen = 18 * scale;

  bodyG
    .append("circle")
    .attr("cx", cx)
    .attr("cy", headY)
    .attr("r", headR)
    .attr("fill", color);

  bodyG
    .append("line")
    .attr("x1", cx)
    .attr("y1", bTop)
    .attr("x2", cx)
    .attr("y2", bBot)
    .attr("stroke", color)
    .attr("stroke-width", 3 * scale);

  bodyG
    .append("line")
    .attr("x1", cx - armSpan)
    .attr("y1", armY)
    .attr("x2", cx + armSpan)
    .attr("y2", armY)
    .attr("stroke", color)
    .attr("stroke-width", 2.5 * scale);

  bodyG
    .append("line")
    .attr("x1", cx)
    .attr("y1", bBot)
    .attr("x2", cx - legSpan)
    .attr("y2", bBot + legLen)
    .attr("stroke", color)
    .attr("stroke-width", 2.5 * scale);

  bodyG
    .append("line")
    .attr("x1", cx)
    .attr("y1", bBot)
    .attr("x2", cx + legSpan)
    .attr("y2", bBot + legLen)
    .attr("stroke", color)
    .attr("stroke-width", 2.5 * scale);

  const chestY = bTop + 6 * scale;
  return { chestY, bodyG };
}

/** John only: red infection circle grows on the chest after `delayMs`. */
function animateMeaslesInfectionCircle(parentG, cx, chestY, scale, delayMs, growMs) {
  parentG
    .append("circle")
    .attr("cx", cx)
    .attr("cy", chestY)
    .attr("r", 0)
    .attr("fill", MEASLES_INFECTION_RED)
    .attr("opacity", 0.75)
    .transition()
    .delay(delayMs)
    .duration(growMs)
    .ease(d3.easeCubicOut)
    .attr("r", 7 * scale);
}

/** Everyone except John: tween head fill and limb strokes to infection red. */
function animateMeaslesInfectionBody(bodyG, delayMs, growMs) {
  const ease = d3.easeCubicOut;
  bodyG
    .selectAll("circle")
    .transition()
    .delay(delayMs)
    .duration(growMs)
    .ease(ease)
    .attr("fill", MEASLES_INFECTION_RED);

  bodyG
    .selectAll("line")
    .transition()
    .delay(delayMs)
    .duration(growMs)
    .ease(ease)
    .attr("stroke", MEASLES_INFECTION_RED);
}

// -----------------------------------------------------------------------------
// Main entry — binds DOM, runs simulation state machine (initial | spreading | done)
// -----------------------------------------------------------------------------

function measlesSpreadVis() {
  const cfg = MEASLES_SPREAD;
  const t = cfg.timing;
  const sel = cfg.selectors;

  const svgEl = document.querySelector(sel.svg);
  const titleEl = document.querySelector(sel.title);
  const subEl = document.querySelector(sel.sub);
  const btnEl = document.querySelector(sel.btn);
  const countEl = document.querySelector(sel.count);

  if (!svgEl || !titleEl || !subEl || !btnEl || !countEl) {
    console.warn("measlesSpreadVis: required DOM nodes missing; skipping init.");
    return;
  }

  /** Current SVG height (px); grows downward when the grid is full. */
  let vizHeight = cfg.height;
  /** Grid helpers always match `vizHeight` and `cfg.width`. */
  let grid = createMeaslesGrid(
    cfg.width,
    vizHeight,
    cfg.cellWidth,
    cfg.cellHeight,
    cfg.slotYOffset
  );

  const svg = d3.select(svgEl).attr("viewBox", `0 0 ${cfg.width} ${vizHeight}`);

  function applyViewBox() {
    svg.attr("viewBox", `0 0 ${cfg.width} ${vizHeight}`);
  }

  /**
   * Add rows at the bottom until at least `neededFree` empty slots exist.
   * Slot indices for existing people stay valid; new slots are appended row-wise.
   */
  function expandDownUntilFreeSlots(neededFree) {
    while (grid.slotCount - occupiedSlots.size < neededFree) {
      const freeNow = grid.slotCount - occupiedSlots.size;
      const deficit = neededFree - freeNow;
      const rowsToAdd = Math.max(1, Math.ceil(deficit / grid.cols));
      vizHeight += rowsToAdd * cfg.cellHeight;
      grid = createMeaslesGrid(
        cfg.width,
        vizHeight,
        cfg.cellWidth,
        cfg.cellHeight,
        cfg.slotYOffset
      );
      applyViewBox();
    }
  }

  // --- Mutable simulation state ---
  let phase = "initial"; // "initial" | "spreading" | "done"
  /** @type {ReturnType<typeof setTimeout> | null} */
  let waveTimer = null;
  let totalInfected = 1;
  let waveIndex = 0;
  /** Grid slots that already have a person */
  const occupiedSlots = new Set();
  /** How many “carriers” drive the next wave’s branching factor */
  let currentGenerationSize = 1;

  /** John stays at the centre of the original (non-expanded) viewport. */
  const johnCenterSlot = () => grid.xyToSlot(cfg.width / 2, cfg.height / 2);

  /**
   * Add one person at `slot`: fade-in after `appearDelayMs`, infection animation after.
   * @param {boolean} isJohn — primary styling + optional label
   */
  function addPersonToSvg(slot, appearDelayMs, isJohn) {
    const { x, y } = grid.slotToXY(slot);
    const color = isJohn ? "black" : THEME.muted;

    const g = svg.append("g").attr("opacity", 0);
    g.transition()
      .delay(appearDelayMs)
      .duration(t.personFadeMs)
      .attr("opacity", 1);

    const { chestY, bodyG } = drawMeaslesPersonFigure(g, x, y, cfg.figureScale, color);
    const infectionStart = appearDelayMs + t.infectionDelayMs;

    if (isJohn) {
      animateMeaslesInfectionCircle(
        g,
        x,
        chestY,
        cfg.figureScale,
        infectionStart,
        t.infectionGrowMs
      );
    } else {
      animateMeaslesInfectionBody(bodyG, infectionStart, t.infectionGrowMs);
    }

    if (isJohn) {
      g.append("text")
        .attr("id", "john-label")
        .attr("x", x)
        .attr("y", y + 20)
        .attr("text-anchor", "middle")
        .attr("font-size", 9)
        .attr("font-family", "Inter, system-ui, sans-serif")
        .attr("fill", "black")
        .text("John");
    }
  }

  function clearWaveTimer() {
    if (waveTimer != null) {
      clearTimeout(waveTimer);
      waveTimer = null;
    }
  }

  /** Reset SVG and state; draw only John at canvas centre. */
  function resetToInitial() {
    clearWaveTimer();
    svg.selectAll("*").remove();
    occupiedSlots.clear();
    totalInfected = 1;
    waveIndex = 0;
    currentGenerationSize = 1;
    countEl.textContent = "1";

    vizHeight = cfg.height;
    grid = createMeaslesGrid(
      cfg.width,
      vizHeight,
      cfg.cellWidth,
      cfg.cellHeight,
      cfg.slotYOffset
    );
    applyViewBox();

    const slot = johnCenterSlot();
    occupiedSlots.add(slot);
    addPersonToSvg(slot, 0, true);
  }

  function flashCountInElement(containerEl, beforeText, count) {
    const n = String(Math.max(0, Math.floor(Number(count))));
    containerEl.replaceChildren();
    containerEl.append(beforeText);
    const span = document.createElement("span");
    span.className = "measles-outcome-count";
    span.textContent = n;
    containerEl.appendChild(span);
    requestAnimationFrame(() => {
      span.classList.add("measles-outcome-count--flash");
      span.addEventListener(
        "animationend",
        () => span.classList.remove("measles-outcome-count--flash"),
        { once: true }
      );
    });
  }

  /**
   * Set the done-state title with a span around the count and run a short flash
   * animation so the number draws attention when it appears or changes.
   */
  function showOutcomeTitleFlashing(total) {
    flashCountInElement(titleEl, "Outcome: ", total);
    titleEl.append(" people infected");
  }

  /** End animation and show summary copy. */
  function stopSpreading() {
    clearWaveTimer();
    phase = "done";
    btnEl.textContent = "Reset";
    showOutcomeTitleFlashing(totalInfected);
    subEl.textContent =
      "Measles spreads to 12–18 people per infected person — 6× more contagious than COVID-19.";
  }

  /** One wave: branch from current carriers, fill clustered free slots, schedule next. */
  function runWave() {
    const randSpan =
      cfg.newInfectionsPerCarrierMax - cfg.newInfectionsPerCarrierMin + 1;
    let newInfectionTarget = 0;
    for (let i = 0; i < currentGenerationSize; i++) {
      newInfectionTarget += Math.floor(Math.random() * randSpan) + cfg.newInfectionsPerCarrierMin;
    }

    expandDownUntilFreeSlots(newInfectionTarget);
    const slots = grid.pickClusteredFreeSlots(occupiedSlots, newInfectionTarget);

    const n = slots.length;
    const genMs = t.generationAppearMs;
    /** Spread fade starts across `genMs` so the last person reaches opacity 1 at `genMs`. */
    const staggerMs =
      n <= 1 ? 0 : Math.max(0, (genMs - t.personFadeMs) / (n - 1));

    slots.forEach((slot, i) => {
      occupiedSlots.add(slot);
      addPersonToSvg(slot, i * staggerMs, false);
    });

    currentGenerationSize = slots.length;
    totalInfected += slots.length;
    waveIndex++;

    const waveAppearDurationMs =
      n <= 1 ? genMs : (n - 1) * staggerMs + t.personFadeMs;
    const timeToNextWave = Math.max(t.waveIntervalMs, waveAppearDurationMs);

    countEl.textContent = String(totalInfected);
    titleEl.textContent = `Generation ${waveIndex}: ${slots.length} more people infected`;
    flashCountInElement(subEl, "Total infected so far: ", totalInfected);

    if (waveIndex >= cfg.maxWaves) {
      stopSpreading();
    } else if (phase === "spreading") {
      waveTimer = setTimeout(runWave, timeToNextWave);
    }
  }

  btnEl.addEventListener("click", () => {
    if (phase === "initial") {
      phase = "spreading";
      btnEl.textContent = "Stop";
      titleEl.textContent =
        "Measles spreads to 12–18 people per infected person…";
      subEl.textContent = "Each wave represents one generation of new infections.";
      d3.select("#john-label").transition().duration(300).style("opacity", 0);
      runWave();
    } else if (phase === "spreading") {
      stopSpreading();
    } else {
      phase = "initial";
      btnEl.textContent = "Watch what happens next →";
      titleEl.textContent = "John gets infected with measles";
      subEl.textContent =
        "See how quickly measles — one of the most contagious diseases - spreads.";
      resetToInitial();
    }
  });

  resetToInitial();
}

window.measlesSpreadVis = measlesSpreadVis;
