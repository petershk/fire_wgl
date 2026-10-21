// main.js - UI Controls, Interactive Object Dragging, and Render Loop

window.addEventListener('DOMContentLoaded', () => {
  const canvas = document.getElementById('fireCanvas');
  let sim;
  try {
    sim = new window.PyroSimulation(canvas);
  } catch (err) {
    alert(err.message);
    console.error(err);
    return;
  }

  // --- Pointer / Touch Interaction for Moving the Object Through the Flames ---
  let dragMode = null; // 'object' | 'wind'
  let dragOffset = { x: 0, y: 0 };

  function getUVFromEvent(e) {
    const rect = canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = 1.0 - (e.clientY - rect.top) / rect.height;
    return {
      x: Math.max(0.02, Math.min(0.98, x)),
      y: Math.max(0.04, Math.min(0.96, y))
    };
  }

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    const uv = getUVFromEvent(e);

    if (e.button === 2 || e.shiftKey || sim.params.objShape === 5) {
      // Right-click or Shift-drag: blow wind / stir flame directly
      dragMode = 'wind';
      sim.pointer.x = uv.x;
      sim.pointer.y = uv.y;
      sim.pointer.vx = 0;
      sim.pointer.vy = 0;
      sim.pointer.active = 1.0;
    } else {
      // Left-click: grab and move the interactive object through the flames!
      dragMode = 'object';
      const dx = (uv.x - sim.obstacle.x) * sim.aspect;
      const dy = uv.y - sim.obstacle.y;
      const dist = Math.hypot(dx, dy);

      if (dist <= sim.params.objRadius * 1.45) {
        // Grabbed directly on the object: preserve grab offset
        dragOffset.x = sim.obstacle.x - uv.x;
        dragOffset.y = sim.obstacle.y - uv.y;
      } else {
        // Clicked elsewhere on canvas: smoothly glide object to cursor
        dragOffset.x = 0;
        dragOffset.y = 0;
        sim.obstacle.targetX = uv.x;
        sim.obstacle.targetY = uv.y;
      }
      sim.obstacle.isDragging = true;
      canvas.classList.add('dragging');
    }
    canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    const uv = getUVFromEvent(e);
    if (dragMode === 'object') {
      sim.obstacle.targetX = Math.max(0.05, Math.min(0.95, uv.x + dragOffset.x));
      sim.obstacle.targetY = Math.max(0.08, Math.min(0.92, uv.y + dragOffset.y));
    } else if (dragMode === 'wind') {
      const vx = (uv.x - sim.pointer.x) * 35.0;
      const vy = (uv.y - sim.pointer.y) * 35.0;
      sim.pointer.vx = vx;
      sim.pointer.vy = vy;
      sim.pointer.x = uv.x;
      sim.pointer.y = uv.y;
      sim.pointer.active = 1.0;
    }
  });

  function endPointer(e) {
    if (dragMode === 'object') {
      sim.obstacle.isDragging = false;
      canvas.classList.remove('dragging');
    } else if (dragMode === 'wind') {
      sim.pointer.active = 0.0;
    }
    dragMode = null;
  }

  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);

  // Mouse wheel resizes the interactive object (or rotates if Alt is held)
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (e.altKey) {
      const degSlider = document.getElementById('objAngle');
      let deg = parseFloat(degSlider.value) + (e.deltaY > 0 ? 8 : -8);
      if (deg > 180) deg -= 360;
      if (deg < -180) deg += 360;
      degSlider.value = deg;
      degSlider.dispatchEvent(new Event('input'));
    } else {
      const radSlider = document.getElementById('objRadius');
      const next = Math.max(0.03, Math.min(0.20, sim.params.objRadius - e.deltaY * 0.00008));
      radSlider.value = next.toFixed(3);
      radSlider.dispatchEvent(new Event('input'));
    }
  }, { passive: false });

  window.addEventListener('resize', () => sim.resize());

  // --- UI Controls Binding ---
  // Background switcher buttons
  const bgBtns = document.querySelectorAll('.bg-btn');
  bgBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      bgBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      sim.params.bgMode = parseInt(btn.dataset.bg, 10);
    });
  });

  // Collider shape switcher buttons
  const shapeBtns = document.querySelectorAll('.shape-btn');
  shapeBtns.forEach((btn) => {
    btn.addEventListener('click', () => {
      shapeBtns.forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      sim.params.objShape = parseInt(btn.dataset.shape, 10);
    });
  });

  function bindSlider(id, paramKey, formatFn, transformFn = (v) => v) {
    const input = document.getElementById(id);
    const output = document.getElementById(id + 'Val');
    if (!input) return;
    input.addEventListener('input', () => {
      const raw = parseFloat(input.value);
      sim.params[paramKey] = transformFn(raw);
      if (output && formatFn) {
        output.textContent = formatFn(raw);
      }
    });
  }

  bindSlider('objRadius', 'objRadius', (v) => `${(v * 100).toFixed(1)}%`);
  bindSlider('objAngle', 'objAngle', (v) => `${Math.round(v)}\u00b0`, (v) => (v * Math.PI) / 180);
  bindSlider('fuelRate', 'fuelRate', (v) => v.toFixed(2));
  bindSlider('vorticity', 'vorticity', (v) => Math.round(v).toString());
  bindSlider('buoyancy', 'buoyancy', (v) => v.toFixed(1));
  bindSlider('cooling', 'cooling', (v) => v.toFixed(2));
  bindSlider('windX', 'windX', (v) => v.toFixed(2));
  bindSlider('refraction', 'refraction', (v) => v.toFixed(2));
  bindSlider('smokeOpacity', 'smokeOpacity', (v) => v.toFixed(2));
  bindSlider('burnerWidth', 'burnerWidth', (v) => `${Math.round(v * 100)}%`);

  document.getElementById('objThermalMode').addEventListener('change', (e) => {
    sim.params.objThermalMode = parseInt(e.target.value, 10);
  });

  document.getElementById('flamePalette').addEventListener('change', (e) => {
    sim.params.flamePalette = parseInt(e.target.value, 10);
  });

  document.getElementById('burnerMode').addEventListener('change', (e) => {
    sim.params.burnerMode = parseInt(e.target.value, 10);
  });

  document.getElementById('showEmbers').addEventListener('change', (e) => {
    sim.params.showEmbers = e.target.checked;
  });

  document.getElementById('showFlowVectors').addEventListener('change', (e) => {
    sim.params.showFlowVectors = e.target.checked;
  });

  document.getElementById('burstBtn').addEventListener('click', () => {
    sim.triggerFireballBurst();
  });

  document.getElementById('resetObjBtn').addEventListener('click', () => {
    sim.obstacle.targetX = 0.5;
    sim.obstacle.targetY = 0.36;
    if (sim.params.objShape === 5) {
      shapeBtns[0].click();
    }
  });

  // Panel collapse toggle
  const togglePanelBtn = document.getElementById('togglePanelBtn');
  const panelBody = document.getElementById('panelBody');
  togglePanelBtn.addEventListener('click', () => {
    const collapsed = panelBody.classList.toggle('collapsed');
    togglePanelBtn.innerHTML = collapsed ? '&#43;' : '&minus;';
  });

  // --- Main Animation & Simulation Loop ---
  let lastTime = performance.now();
  let frameCount = 0;
  let fpsTimer = lastTime;
  const fpsCounter = document.getElementById('fpsCounter');

  function animate(now) {
    const dt = (now - lastTime) * 0.001;
    lastTime = now;

    frameCount++;
    if (now - fpsTimer >= 500) {
      const fps = Math.round((frameCount * 1000) / (now - fpsTimer));
      fpsCounter.textContent = `${fps} FPS`;
      frameCount = 0;
      fpsTimer = now;
    }

    sim.step(dt);
    sim.render();
    requestAnimationFrame(animate);
  }

  requestAnimationFrame(animate);
});
