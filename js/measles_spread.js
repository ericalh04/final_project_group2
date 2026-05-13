function measlesSpreadVis() {

// ─────────────────────────────────────────────────────────────────────────────
// Visualization: Measles Spread Animation (John radial spread)
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
const measlesSpreadVis = () => {

  // ── Canvas & layout constants ──────────────────────────────────────────────
  const W = 660, H = 380;          // SVG viewBox dimensions (px)
  const SCALE = 0.4;              // uniform scale factor for all stick figures
  const CELL_W = 20, CELL_H = 30; // width × height of each person's grid cell
  const COLS = Math.floor(W / CELL_W);
  const ROWS = Math.floor(H / CELL_H);

  // Timing constants (all in milliseconds)
  const WAVE_INTERVAL    = 3000;  // new wave of infections every 4 seconds
  const INFECTION_DELAY  = 1000;  // red circle starts growing 2s after person appears
  const INFECTION_DUR    = 2000;  // red circle takes 2s to reach full radius
  const MAX_RUNTIME      = 60000; // auto-stop after 30 seconds of spreading

  // ── DOM handles ────────────────────────────────────────────────────────────
  const svgEl      = document.querySelector("#measles-spread-svg");
  const titleEl    = document.querySelector("#measles-spread-title");
  const subEl      = document.querySelector("#measles-spread-sub");
  const btnEl      = document.querySelector("#measles-spread-btn");
  const countEl    = document.querySelector("#measles-spread-count");

  // Bail out gracefully if the HTML mount points are missing
  if (!svgEl || !titleEl || !subEl || !btnEl || !countEl) {
    console.warn("measlesSpreadVis: one or more DOM elements not found; skipping.");
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
   * origin (ox, oy), so each new wave generates clusters spreading out from John.
   */
    const getClusteredFreeSlots = (n) => {
      const candidates = [];
    
      for (let i = 0; i < COLS * ROWS; i++) {
        if (occupiedSlots.has(i)) continue;
    
        const { x, y } = slotToXY(i);
    
        // Find distance to the NEAREST occupied slot
        let minDist = Infinity;
    
        occupiedSlots.forEach(occupiedSlot => {
          const pos = slotToXY(occupiedSlot);
        
          const dist = Math.hypot(
            x - pos.x,
            y - pos.y
          );
      
          if (dist < minDist) {
            minDist = dist;
          }
        });
    
        candidates.push({
          slot: i,
          dist: minDist
        });
      }
  
      // Closest-to-existing-infection first
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
        .attr("id", "john-label")
        .attr("x", x).attr("y", y + 20)
        .attr("text-anchor", "middle")
        .attr("font-size", 9)
        .attr("font-family", "Inter, system-ui, sans-serif")
        .attr("fill", "black")
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
    currentGenerationSize = 1;
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
    if (elapsed >= MAX_RUNTIME) {
      stop();
      return;
    }

    // Total new infections generated THIS wave
    let newInfections = 0;

    // Each currently infected person infects 12–18 more
    for (let i = 0; i < currentGenerationSize; i++) {
      newInfections += Math.floor(Math.random() * 7) + 12;
    }

    // John's pixel position stays fixed at the canvas centre
    const { x: jx, y: jy } = slotToXY(xyToSlot(W / 2, H / 2));

    // Get the nearest free slots
    const slots = getClusteredFreeSlots(newInfections);
    if (slots.length === 0) { stop(); return; }  // grid is full

    // Stagger each person's appearance by 80 ms so the wave ripples visually
    slots.forEach((slot, i) => {
      occupiedSlots.add(slot);
      addPersonToSvg(slot, i * 80, false);
    });

    currentGenerationSize = slots.length;
    totalInfected += slots.length;
    generation++;

    // Calculate how long this specific wave needs to finish appearing.
    // (Total staggered delay) + (1000ms buffer for the animation to settle)
    const waveDuration = (slots.length * 80) + 1000; 
    
    // Ensure we still wait AT LEAST the original 3 seconds (WAVE_INTERVAL)
    const timeToNextWave = Math.max(WAVE_INTERVAL, waveDuration);

    elapsed += timeToNextWave;

    // Update the narrative text and infected counter
    countEl.textContent    = totalInfected;
    titleEl.textContent    = `Generation ${generation}: ${slots.length} more people infected`;
    subEl.textContent      = `Total infected so far: ${totalInfected}`;

    // Chain the next wave dynamically instead of relying on a fixed interval
    if (phase === "spreading") {
      timer = setTimeout(spread, timeToNextWave); 
    }

  };

  /**
   * Halt the animation and transition the UI into the "done" state.
   */
  const stop = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    phase = "done";
    btnEl.textContent   = "Reset";
    titleEl.textContent = `Outcome: — ${totalInfected} people infected`;
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
      // Hide John's name label after the first click
      d3.select("#john-label").transition().duration(300).style("opacity", 0);

      spread();                                     // first wave immediately

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
measlesSpreadVis();

}

window.measlesSpreadVis = measlesSpreadVis;