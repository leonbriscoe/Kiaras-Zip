function getZipIdFromURL() {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get("id");
  const id = Number(raw);
  return Number.isFinite(id) ? id : null;
}

async function loadPuzzleOrThrow(id) {
  const res = await fetch("puzzles.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load puzzles.json (${res.status})`);
  const data = await res.json();
  const zips = Array.isArray(data.zips) ? data.zips : [];
  const puzzle = zips.find(z => Number(z.id) === id);
  if (!puzzle) throw new Error(`Puzzle id=${id} not found`);

  // Expect puzzle.grid to already be a 2D array of numbers (NOT a string)
  if (!Array.isArray(puzzle.grid) || puzzle.grid.length === 0 || !Array.isArray(puzzle.grid[0])) {
    throw new Error(`Puzzle id=${id} has invalid grid (must be a 2D array)`);
  }
  return puzzle;
}

async function getAllPuzzleIds() {
  const res = await fetch("puzzles.json", { cache: "no-store" });
  if (!res.ok) return [];
  const data = await res.json();
  const zips = Array.isArray(data.zips) ? data.zips : [];
  return zips.map(z => Number(z.id)).filter(id => Number.isFinite(id)).sort((a, b) => a - b);
}

function setupNavigation(currentId, allIds) {
  const nextBtn = document.getElementById("nextBtn");
  
  if (!nextBtn || !allIds || allIds.length === 0) return;
  
  const currentIndex = allIds.indexOf(currentId);
  
  // Disable next button if at last puzzle
  if (currentIndex < 0 || currentIndex >= allIds.length - 1) {
    nextBtn.disabled = true;
    nextBtn.style.opacity = "0.4";
    nextBtn.style.cursor = "not-allowed";
  } else {
    nextBtn.disabled = false;
    nextBtn.style.opacity = "1";
    nextBtn.style.cursor = "pointer";
    nextBtn.addEventListener("click", () => {
      const nextId = allIds[currentIndex + 1];
      window.location.href = `zip.html?id=${nextId}`;
    });
  }
  
  // Add keyboard shortcut (Ctrl/Cmd + Right Arrow)
  document.addEventListener("keydown", (e) => {
    // Only trigger if Ctrl (Windows/Linux) or Cmd (Mac) is pressed
    if ((e.ctrlKey || e.metaKey) && e.key === "ArrowRight" && !nextBtn.disabled) {
      e.preventDefault();
      nextBtn.click();
    }
  });
}

(async function main() {
  // --- per-user helpers (localStorage-backed, lightweight) ---
  function getCurrentUser() {
    return localStorage.getItem("zip_currentUser");
  }

  function getUserData(user) {
    if (!user) return { opened: {}, completed: {}, startTimes: {}, times: {} };
    const raw = localStorage.getItem(`zip_user_${user}`);
    try { return raw ? JSON.parse(raw) : { opened: {}, completed: {}, startTimes: {}, times: {} }; } catch { return { opened: {}, completed: {}, startTimes: {}, times: {} }; }
  }

  function saveUserData(user, data) {
    if (!user) return;
    localStorage.setItem(`zip_user_${user}`, JSON.stringify(data));
  }

  function markOpenedForUser(user, id) {
    if (!user) return;
    const d = getUserData(user);
    d.opened = d.opened || {};
    d.opened[id] = true;
    saveUserData(user, d);
  }

  function markCompletedForUser(user, id) {
    if (!user) return;
    const d = getUserData(user);
    d.completed = d.completed || {};
    d.completed[id] = true;
    saveUserData(user, d);
  }

  const id = getZipIdFromURL();
  const titleEl = document.getElementById("zipTitle");
  const msgEl = document.getElementById("msg");

  function setMsg(text, ok = null) {
    msgEl.textContent = text;
    msgEl.classList.toggle("ok", ok === true);
    msgEl.classList.toggle("bad", ok === false);
  }

  if (id === null) {
    document.title = "Zip";
    titleEl.textContent = "Zip";
    setMsg("Missing ?id= in the URL.", false);
    return;
  }

  let ZIP_NUMBER, ZIP_GRID;
  try {
    const puzzle = await loadPuzzleOrThrow(id);
    ZIP_NUMBER = puzzle.id;
    ZIP_GRID = puzzle.grid;
    
    // Setup navigation buttons
    const allIds = await getAllPuzzleIds();
    setupNavigation(ZIP_NUMBER, allIds);
  } catch (err) {
    console.error(err);
    document.title = `Zip #${id}`;
    titleEl.textContent = `Zip #${id}`;
    setMsg(String(err.message || err), false);
    return;
  }

  // ----------------------------
  // Zip logic
  // ----------------------------
  // mark opened for current user and initialize visibility-only timer
  const timerEl = document.getElementById('timer');
  let _elapsedMs = 0;  // actual elapsed time (only while visible)
  let _visibleStartMs = null;  // when tab became visible
  let _timerRaf = null;
  let finishedLock = false;   // once true, no rewinding or undo
  let isPreviouslyCompleted = false; // tracks if puzzle was completed before page load

  function fmtMs(ms) {
    if (ms == null) return '—';
    const s = (ms / 1000).toFixed(3);
    return `${s}s`;
  }

  function updateTimerNow() {
    let total = _elapsedMs;
    if (_visibleStartMs != null) {
      total += Date.now() - _visibleStartMs;
    }
    timerEl.textContent = fmtMs(total);
    _timerRaf = requestAnimationFrame(updateTimerNow);
  }

  function startTimerIfVisible() {
    if (document.visibilityState === 'visible') {
      if (_visibleStartMs == null) _visibleStartMs = Date.now();
      if (_timerRaf) cancelAnimationFrame(_timerRaf);
      updateTimerNow();
    }
  }

  function stopTimerIfHidden() {
    if (_visibleStartMs != null) {
      _elapsedMs += Date.now() - _visibleStartMs;
      _visibleStartMs = null;
    }
    if (_timerRaf) cancelAnimationFrame(_timerRaf);
    _timerRaf = null;
  }

  function persistElapsedForUser(user) {
    if (!user) return;
    const d = getUserData(user);
    d.startTimes = d.startTimes || {};
    d.startTimes[ZIP_NUMBER] = _elapsedMs;
    saveUserData(user, d);
  }

  try {
    const user = getCurrentUser();
    if (user) markOpenedForUser(user, ZIP_NUMBER);

    // load any previous elapsed time for this puzzle
    const d = getUserData(user);
    const entry = d.startTimes && d.startTimes[ZIP_NUMBER];
    if (entry != null) {
      if (typeof entry === 'number') _elapsedMs = entry;
      else if (entry.start) _elapsedMs = entry.paused || 0;
    }

    // If completed already, show time and lock
    if (d.completed && d.completed[ZIP_NUMBER]) {
      const ms = d.times && d.times[ZIP_NUMBER];
      setMsg(`Previously completed — time: ${fmtMs(ms)}`, true);
      timerEl.textContent = fmtMs(ms);
      finishedLock = true;
      isPreviouslyCompleted = true;
      document.getElementById('board').style.pointerEvents = 'none';
      document.getElementById('undoBtn').disabled = true;
      document.getElementById('resetBtn').disabled = true;
      document.getElementById('hintBtn').disabled = true;
      document.getElementById('revealBtn').disabled = true;
    } else {
      // Start timer only if page is visible now
      startTimerIfVisible();
    }
  } catch (e) {
    // anonymous or error: start timer if visible
    startTimerIfVisible();
  }

  // Pause when tab becomes hidden, resume when visible
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      stopTimerIfHidden();
      persistElapsedForUser(getCurrentUser());
    } else {
      startTimerIfVisible();
    }
  });

  // Save progress when leaving the page
  window.addEventListener('beforeunload', () => {
    stopTimerIfHidden();
    persistElapsedForUser(getCurrentUser());
  });

  const grid = ZIP_GRID;
  const n = grid.length;
  const N = n * n;

  document.getElementById("zipTitle").textContent = `Zip #${ZIP_NUMBER}`;
  document.title = `Zip #${ZIP_NUMBER}`;

  const boardEl = document.getElementById("board");
  const pathEl = document.getElementById("path");

  const undoBtn  = document.getElementById("undoBtn");
  const resetBtn = document.getElementById("resetBtn");
  const hintBtn = document.getElementById("hintBtn");
  const revealBtn = document.getElementById("revealBtn");

  // Map number -> location
  const positions = new Map();
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      const v = grid[r][c];
      if (v !== 0) positions.set(v, { r, c });
    }
  }

  const requiredNums = Array.from(positions.keys()).sort((a, b) => a - b);
  const lastRequired = requiredNums[requiredNums.length - 1];

  let path = [];
  let isDragging = false;
  let lastHoverKey = null;    // prevents re-processing the same cell while dragging
  let hintCooldownUntil = 0;  // timestamp for hint cooldown
  let currentHintArrow = null; // reference to current hint arrow element
  let hintCooldownInterval = null; // interval for updating cooldown progress bar

  function orthAdjacent(a, b) {
    const dr = Math.abs(a.r - b.r);
    const dc = Math.abs(a.c - b.c);
    return (dr + dc) === 1;
  }

  function nextRequiredNumber() {
    for (const k of requiredNums) {
      const pos = positions.get(k);
      const visited = path.some(p => p.r === pos.r && p.c === pos.c);
      if (!visited) return k;
    }
    return null;
  }

  function isSolvedNow() {
    if (path.length !== N) return false;

    // must start at 1
    const start = path[0];
    if (grid[start.r][start.c] !== 1) return false;

    // must be orth-adjacent all the way
    for (let i = 0; i < path.length - 1; i++) {
      if (!orthAdjacent(path[i], path[i + 1])) return false;
    }

    // must hit all required numbers in increasing order
    let lastIdx = -1;
    for (const k of requiredNums) {
      const pos = positions.get(k);
      const idx = path.findIndex(p => p.r === pos.r && p.c === pos.c);
      if (idx === -1) return false;
      if (idx <= lastIdx) return false;
      lastIdx = idx;
    }

    // must end at lastRequired
    const end = path[path.length - 1];
    if (grid[end.r][end.c] !== lastRequired) return false;

    return true;
  }

  // Robust hit-test: works even with overlay and borders
  function cellAtPoint(clientX, clientY) {
    const els = document.elementsFromPoint(clientX, clientY);
    for (const el of els) {
      const cell = el.closest?.(".zip-cell");
      if (cell) return { r: Number(cell.dataset.r), c: Number(cell.dataset.c) };
    }
    return null;
  }

  function cellCenterToOverlay(rc) {
    const x = (rc.c + 0.5) / n * 100;
    const y = (rc.r + 0.5) / n * 100;
    return { x, y };
  }

  function redraw() {
    boardEl.querySelectorAll(".zip-cell").forEach(el => el.classList.remove("used", "head"));

    path.forEach((rc, i) => {
      const el = boardEl.querySelector(`[data-r="${rc.r}"][data-c="${rc.c}"]`);
      if (!el) return;
      el.classList.add("used");
      if (i === path.length - 1) el.classList.add("head");
    });

    if (path.length === 0) {
      pathEl.setAttribute("d", "");
      return;
    }

    const pts = path.map(cellCenterToOverlay);
    const d = ["M", pts[0].x, pts[0].y];
    for (let i = 1; i < pts.length; i++) d.push("L", pts[i].x, pts[i].y);
    pathEl.setAttribute("d", d.join(" "));
  }

  function clearHintArrow() {
    if (currentHintArrow) {
      currentHintArrow.remove();
      currentHintArrow = null;
    }
  }

  function updateHintCooldownBar() {
    const cooldownBar = document.getElementById('hintCooldownBar');
    if (!cooldownBar) return;
    
    const now = Date.now();
    if (now >= hintCooldownUntil) {
      cooldownBar.style.width = '100%';
      if (hintCooldownInterval) {
        clearInterval(hintCooldownInterval);
        hintCooldownInterval = null;
      }
      return;
    }
    
    // Calculate progress (0 to 100%)
    const totalDuration = 5000; // 5 seconds
    const elapsed = totalDuration - (hintCooldownUntil - now);
    const progress = Math.min(100, Math.max(0, (elapsed / totalDuration) * 100));
    cooldownBar.style.width = progress + '%';
  }

  function startHintCooldown() {
    hintCooldownUntil = Date.now() + 5000;
    
    // Clear any existing interval
    if (hintCooldownInterval) {
      clearInterval(hintCooldownInterval);
    }
    
    // Update immediately and then every 50ms for smooth animation
    updateHintCooldownBar();
    hintCooldownInterval = setInterval(updateHintCooldownBar, 50);
  }

  function showHintArrow(fromCell, toCell) {
    clearHintArrow();
    
    const el = boardEl.querySelector(`[data-r="${fromCell.r}"][data-c="${fromCell.c}"]`);
    if (!el) return;
    
    // Determine direction
    let arrowClass = 'zip-hint-arrow';
    if (toCell.r < fromCell.r) arrowClass += ' arrow-up';      // up
    else if (toCell.r > fromCell.r) arrowClass += ' arrow-down'; // down
    else if (toCell.c < fromCell.c) arrowClass += ' arrow-left'; // left
    else if (toCell.c > fromCell.c) arrowClass += ' arrow-right'; // right
    
    const arrowEl = document.createElement('div');
    arrowEl.className = arrowClass;
    el.appendChild(arrowEl);
    
    currentHintArrow = arrowEl;
  }

  function tryAddCell(rc, allowRewind = false) {
    const key = `${rc.r},${rc.c}`;
    if (key === lastHoverKey) return;
    lastHoverKey = key;

    // Clear any hint arrow when user makes a move
    clearHintArrow();

    if (path.length === 0) {
      if (grid[rc.r][rc.c] !== 1) {
        setMsg("Start on 1.", false);
        return;
      }
      path.push(rc);
      redraw();
      return;
    }

    // Check if this cell is already in the path (crossing itself)
    const hitIndex = path.findIndex(p => p.r === rc.r && p.c === rc.c);
    if (hitIndex !== -1) {
      if (finishedLock) return; // no changes after solved
      
      // Block crossing during dragging (allowRewind = false)
      // But allow clicking on a visited cell to rewind to that position (allowRewind = true)
      if (!allowRewind) {
        // During drag: completely block crossing
        return;
      }
      
      // During click: rewind to that position (fast alternative to undo button)
      path = path.slice(0, hitIndex + 1);
      redraw();
      return;
    }

    const head = path[path.length - 1];
    if (!orthAdjacent(head, rc)) return;

    const cellVal = grid[rc.r][rc.c];
    const needed = nextRequiredNumber();

    if (cellVal !== 0) {
      // last number can ONLY be selected as the final move
      if (cellVal === lastRequired && path.length !== N - 1) {
        setMsg(`You can only step on ${lastRequired} as the final move.`, false);
        return;
      }

      // must hit required numbers in order
      if (needed !== null && cellVal !== needed) {
        setMsg(`Next number is ${needed}.`, false);
        return;
      }
    }

    path.push(rc);

    // auto-resolve when board is full
    if (path.length === N) {
      if (isSolvedNow()) {
        finishedLock = true; // lock once solved (prevents rewind/undo)
        setMsg("Solved.", true);
        // Persist completion for current user (only when user actually solved it)
        try {
          const user = getCurrentUser();
          if (user) {
            // Calculate total elapsed time
            let elapsed = _elapsedMs;
            if (_visibleStartMs != null) {
              elapsed += Date.now() - _visibleStartMs;
            }
            
            const d = getUserData(user);
            d.times = d.times || {};
            d.times[ZIP_NUMBER] = elapsed;
            if (d.startTimes) delete d.startTimes[ZIP_NUMBER];
            saveUserData(user, d);

            // also POST progress to server (best-effort)
            try {
              const numbersCount = grid.flat().filter(x => x !== 0).length;
              fetch('/api/progress', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username: user, id: ZIP_NUMBER, elapsed: elapsed, n: n, numbersCount })
              }).catch(()=>{});
            } catch(e) {}
            
            markCompletedForUser(user, ZIP_NUMBER);
          }
        } catch (e) { /* ignore */ }

        // stop timer and freeze interactions
        stopTimerIfHidden();
        document.getElementById('board').style.pointerEvents = 'none';
        undoBtn.disabled = true;
        resetBtn.disabled = true;
        hintBtn.disabled = true;
        revealBtn.disabled = true;
      } else {
        setMsg("Not solved yet.", false);
      }
      redraw();
      return;
    }

    redraw();
  }

  function reset() {
    // Don't allow reset on previously completed puzzles
    if (isPreviouslyCompleted) return;
    
    path = [];
    lastHoverKey = null;
    finishedLock = false;
    
    // Clear any hint arrow
    clearHintArrow();
    
    // Timer continues running (not reset)
    
    redraw();
  }

  function undo() {
    if (finishedLock) return;
    if (path.length === 0) return;
    path.pop();
    lastHoverKey = null;
    
    // Clear any hint arrow
    clearHintArrow();
    
    redraw();
  }

  function hint() {
    if (finishedLock) return;
    
    // Check cooldown
    const now = Date.now();
    if (now < hintCooldownUntil) {
      return; // Silently ignore during cooldown, progress bar shows status
    }
    
    // Clear previous hint arrow
    clearHintArrow();
    
    // Solve from current state
    const sol = solveFromCurrentPath();
    
    if (!sol || sol.length <= path.length) {
      return;
    }
    
    // Get current position and next position
    let fromCell;
    if (path.length === 0) {
      // If no path, hint should start from cell 1
      fromCell = findCellWithValue(1);
      if (!fromCell) return;
      const nextCell = sol[0];
      // Show arrow pointing to start cell if path is empty
      showHintArrow(fromCell, fromCell); // This will just show indicator on start cell
    } else {
      fromCell = path[path.length - 1];
      const nextCell = sol[path.length];
      // Show arrow pointing from current head to next cell
      showHintArrow(fromCell, nextCell);
    }
    
    // Start cooldown with progress bar
    startHintCooldown();
  }

  function solveFromCurrentPath() {
    // If path is empty, solve from scratch
    if (path.length === 0) {
      return solveZipDFS();
    }
    
    // Build a solution that continues from current path
    const visited = Array.from({ length: n }, () => Array(n).fill(false));
    const solPath = [];
    
    // Mark current path as visited
    for (const p of path) {
      visited[p.r][p.c] = true;
      solPath.push(p);
    }
    
    const cur = path[path.length - 1];
    
    // Figure out which required numbers we've already hit
    let nextReqIdx = 0;
    for (const reqNum of requiredNums) {
      const pos = positions.get(reqNum);
      const hit = path.some(p => p.r === pos.r && p.c === pos.c);
      if (hit) nextReqIdx++;
      else break;
    }
    
    function dfs(curr, reqIdx) {
      if (solPath.length === N) {
        if (reqIdx !== requiredNums.length) return false;
        return grid[curr.r][curr.c] === lastRequired;
      }

      const needed = (reqIdx < requiredNums.length) ? requiredNums[reqIdx] : null;

      const cand = neighbors4(curr.r, curr.c)
        .filter(nb => !visited[nb.r][nb.c])
        .filter(nb => {
          const v = grid[nb.r][nb.c];
          if (v === 0) return true;
          if (needed === null) return true;
          return v === needed;
        })
        .map(nb => {
          let deg = 0;
          for (const nn of neighbors4(nb.r, nb.c)) if (!visited[nn.r][nn.c]) deg++;
          return { nb, deg };
        })
        .sort((a, b) => a.deg - b.deg)
        .map(x => x.nb);

      for (const nb of cand) {
        const v = grid[nb.r][nb.c];
        let newIdx = reqIdx;
        if (needed !== null && v === needed) newIdx = reqIdx + 1;

        visited[nb.r][nb.c] = true;
        solPath.push(nb);

        if (dfs(nb, newIdx)) return true;

        solPath.pop();
        visited[nb.r][nb.c] = false;
      }
      return false;
    }

    const ok = dfs(cur, nextReqIdx);
    return ok ? solPath : null;
  }

  function check() {
    if (path.length !== N) {
      setMsg(`Not yet. You covered ${path.length}/${N} cells.`, false);
      return;
    }

    if (isSolvedNow()) {
      finishedLock = true; // lock if solved via Check
      setMsg("Solved.", true);
      try {
        const user = getCurrentUser();
        if (user) {
          // Calculate total elapsed time
          let elapsed = _elapsedMs;
          if (_visibleStartMs != null) {
            elapsed += Date.now() - _visibleStartMs;
          }
          
          const d = getUserData(user);
          d.times = d.times || {};
          d.times[ZIP_NUMBER] = elapsed;
          if (d.startTimes) delete d.startTimes[ZIP_NUMBER];
          saveUserData(user, d);
          
          try {
            const numbersCount = grid.flat().filter(x => x !== 0).length;
            fetch('/api/progress', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ username: user, id: ZIP_NUMBER, elapsed: elapsed, n: n, numbersCount })
            }).catch(()=>{});
          } catch(e) {}
          
          markCompletedForUser(user, ZIP_NUMBER);
        }
      } catch (e) {}
      stopTimerIfHidden();
      document.getElementById('board').style.pointerEvents = 'none';
      undoBtn.disabled = true;
      resetBtn.disabled = true;
      hintBtn.disabled = true;
      revealBtn.disabled = true;
      redraw();
      return;
    }

    setMsg("Not solved yet.", false);
  }

  function buildBoard() {
    boardEl.style.setProperty("--n", n);
    boardEl.innerHTML = "";

    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        const cell = document.createElement("div");
        cell.className = "zip-cell";
        cell.dataset.r = r;
        cell.dataset.c = c;

        if (c === n - 1) cell.classList.add("last-col");
        if (r === n - 1) cell.classList.add("last-row");

        const v = grid[r][c];
        if (v !== 0) {
          const badge = document.createElement("div");
          badge.className = "zip-num";
          badge.textContent = v;
          cell.appendChild(badge);
        }

        boardEl.appendChild(cell);
      }
    }

    // line thickness scales with grid size
    pathEl.setAttribute("stroke-width", String(100 / n * 0.42));
  }

  function onPointerDown(e) {
    isDragging = true;
    lastHoverKey = null;
    boardEl.setPointerCapture?.(e.pointerId);
    const rc = cellAtPoint(e.clientX, e.clientY);
    if (rc) tryAddCell(rc, true); // Allow rewind on initial click
  }

  function onPointerMove(e) {
    if (!isDragging) return;
    const rc = cellAtPoint(e.clientX, e.clientY);
    if (rc) tryAddCell(rc, false); // Do NOT allow rewind during dragging
  }

  function onPointerUp() {
    isDragging = false;
    lastHoverKey = null;
  }

  undoBtn.addEventListener("click", undo);
  resetBtn.addEventListener("click", reset);
  hintBtn.addEventListener("click", hint);

  boardEl.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  window.addEventListener("pointercancel", onPointerUp);

  // ----------------------------
  // Keyboard Controls (Arrow Keys)
  // ----------------------------
  window.addEventListener("keydown", (e) => {
    // Skip if user is typing in an input field
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    
    // Skip if puzzle is locked (completed)
    if (finishedLock || isPreviouslyCompleted) return;

    // Only handle arrow keys
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
    
    e.preventDefault(); // Prevent page scrolling

    let targetCell = null;

    if (path.length === 0) {
      // If no path yet, find the cell with value 1
      const start = findCellWithValue(1);
      if (start) {
        targetCell = start;
      }
    } else {
      // Move from the current head position
      const head = path[path.length - 1];
      
      switch(e.key) {
        case 'ArrowUp':
          if (head.r > 0) targetCell = { r: head.r - 1, c: head.c };
          break;
        case 'ArrowDown':
          if (head.r < n - 1) targetCell = { r: head.r + 1, c: head.c };
          break;
        case 'ArrowLeft':
          if (head.c > 0) targetCell = { r: head.r, c: head.c - 1 };
          break;
        case 'ArrowRight':
          if (head.c < n - 1) targetCell = { r: head.r, c: head.c + 1 };
          break;
      }
    }

    if (targetCell) {
      lastHoverKey = null; // Reset to allow processing
      tryAddCell(targetCell, false); // Block rewind with keyboard arrows (prevent accidental resets)
    }
  });

  // ----------------------------
  // Solver (DFS)
  // ----------------------------
  function neighbors4(r, c) {
    const out = [];
    if (r > 0) out.push({ r: r - 1, c });
    if (r < n - 1) out.push({ r: r + 1, c });
    if (c > 0) out.push({ r, c: c - 1 });
    if (c < n - 1) out.push({ r, c: c + 1 });
    return out;
  }

  function findCellWithValue(val) {
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (grid[r][c] === val) return { r, c };
      }
    }
    return null;
  }

  function solveZipDFS() {
    const start = findCellWithValue(1);
    if (!start) return null;
    if (requiredNums.length === 0 || requiredNums[0] !== 1) return null;

    const visited = Array.from({ length: n }, () => Array(n).fill(false));
    const solPath = [];

    visited[start.r][start.c] = true;
    solPath.push(start);

    function dfs(cur, nextReqIdx) {
      if (solPath.length === N) {
        if (nextReqIdx !== requiredNums.length) return false;
        return grid[cur.r][cur.c] === lastRequired;
      }

      const needed = (nextReqIdx < requiredNums.length) ? requiredNums[nextReqIdx] : null;

      const cand = neighbors4(cur.r, cur.c)
        .filter(nb => !visited[nb.r][nb.c])
        .filter(nb => {
          const v = grid[nb.r][nb.c];
          if (v === 0) return true;
          if (needed === null) return true;
          return v === needed;
        })
        .map(nb => {
          let deg = 0;
          for (const nn of neighbors4(nb.r, nb.c)) if (!visited[nn.r][nn.c]) deg++;
          return { nb, deg };
        })
        .sort((a, b) => a.deg - b.deg)
        .map(x => x.nb);

      for (const nb of cand) {
        const v = grid[nb.r][nb.c];
        let newIdx = nextReqIdx;
        if (needed !== null && v === needed) newIdx = nextReqIdx + 1;

        visited[nb.r][nb.c] = true;
        solPath.push(nb);

        if (dfs(nb, newIdx)) return true;

        solPath.pop();
        visited[nb.r][nb.c] = false;
      }
      return false;
    }

    const ok = dfs(start, 1);
    return ok ? solPath : null;
  }

  revealBtn.addEventListener("click", () => {
    setMsg("Revealing solution…");
    const sol = solveZipDFS();
    if (!sol) {
      setMsg("No solution found.", false);
      return;
    }
    path = sol.map(rc => ({ r: rc.r, c: rc.c }));
    lastHoverKey = null;

    // If solver produced a full correct solution, lock it
    if (path.length === N && isSolvedNow()) {
      finishedLock = true;
      setMsg("Solution revealed.", true);
    } else {
      setMsg("Solved path loaded.", true);
    }

    redraw();
  });

  // init
  buildBoard();
  
  // Initialize hint cooldown bar to 100%
  const cooldownBar = document.getElementById('hintCooldownBar');
  if (cooldownBar) cooldownBar.style.width = '100%';
  
  // If previously completed, show the solved path instead of allowing reset
  if (isPreviouslyCompleted) {
    const sol = solveZipDFS();
    if (sol) {
      path = sol.map(rc => ({ r: rc.r, c: rc.c }));
      redraw();
    }
  } else {
    reset();
  }
})();

