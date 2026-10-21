// sim.js - WebGL2 Navier-Stokes Combustion & Interactive Collider Engine

class PyroSimulation {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      depth: false,
      stencil: false,
      antialias: false,
      preserveDrawingBuffer: false
    });
    if (!gl) {
      throw new Error('WebGL2 is required for this simulation.');
    }
    this.gl = gl;

    // Enable floating-point render targets and linear filtering
    this.extFloat = gl.getExtension('EXT_color_buffer_float');
    this.extFloatLinear = gl.getExtension('OES_texture_float_linear');
    if (!this.extFloat) {
      throw new Error('EXT_color_buffer_float not supported on this GPU/browser.');
    }

    // Simulation parameters (controlled by UI)
    this.params = {
      bgMode: 0,           // 0: Brick Hearth, 1: Optical Grid, 2: Daylight Sky, 3: Dark Void, 4: Schlieren Lab
      flamePalette: 0,     // 0: Hydrocarbon, 1: Copper, 2: Crimson, 3: Oxy-Acetylene
      objShape: 0,         // 0: Sphere, 1: Box, 2: Wing/Blade, 3: Hollow Ring, 4: Cross Baffle, 5: Hidden
      objRadius: 0.085,
      objAngle: -20 * Math.PI / 180,
      objThermalMode: 0,   // 0: Neutral (Glows), 1: Cryo Sink, 2: Superheated Igniter
      fuelRate: 1.15,
      vorticity: 36.0,
      buoyancy: 2.4,
      cooling: 1.35,
      windX: 0.0,
      refraction: 1.0,
      smokeOpacity: 1.1,
      burnerWidth: 0.22,
      burnerMode: 0,
      showEmbers: true,
      showFlowVectors: false,
      pressureIterations: 28
    };

    // Interactive object state (normalized UV space [0..1, 0..1])
    this.obstacle = {
      x: 0.5,
      y: 0.42,
      vx: 0.0,
      vy: 0.0,
      targetX: 0.5,
      targetY: 0.42,
      isDragging: false
    };

    // Secondary pointer (right-drag or shift-drag wind gust)
    this.pointer = {
      x: 0.5,
      y: 0.5,
      vx: 0.0,
      vy: 0.0,
      active: 0.0
    };

    this.time = 0.0;
    this.burstIntensity = 0.0;
    this.fireLight = { x: 0.5, y: 0.28, power: 1.0 };

    this.initGeometry();
    this.initPrograms();
    this.resize();
    this.initEmbers();
  }

  initGeometry() {
    const gl = this.gl;
    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(this.quadVao);

    const quadVerts = new Float32Array([
      -1, -1,
       1, -1,
      -1,  1,
      -1,  1,
       1, -1,
       1,  1
    ]);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  compileShader(type, source) {
    const gl = this.gl;
    const processed = source.replace('#include_sdf', window.PyroShaders.sdfChunk);
    const shader = gl.createShader(type);
    gl.shaderSource(shader, processed);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader);
      console.error('Shader compile error:', log, '\nSource:\n', processed);
      throw new Error('Shader compilation failed: ' + log);
    }
    return shader;
  }

  createProgram(vsSource, fsSource) {
    const gl = this.gl;
    const vs = this.compileShader(gl.VERTEX_SHADER, vsSource);
    const fs = this.compileShader(gl.FRAGMENT_SHADER, fsSource);
    const prog = gl.createProgram();
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(prog);
      throw new Error('Program link error: ' + log);
    }

    const uniforms = {};
    const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(prog, i);
      uniforms[info.name] = gl.getUniformLocation(prog, info.name);
    }
    return { program: prog, uniforms };
  }

  initPrograms() {
    const S = window.PyroShaders;
    this.progObstacle    = this.createProgram(S.baseVertex, S.obstacleUpdateFrag);
    this.progAdvect      = this.createProgram(S.baseVertex, S.advectFrag);
    this.progMacCormack  = this.createProgram(S.baseVertex, S.maccormackFrag);
    this.progCombustion  = this.createProgram(S.baseVertex, S.combustionAndForcesFrag);
    this.progCurl        = this.createProgram(S.baseVertex, S.curlFrag);
    this.progVorticity   = this.createProgram(S.baseVertex, S.vorticityFrag);
    this.progDivergence  = this.createProgram(S.baseVertex, S.divergenceFrag);
    this.progPressure    = this.createProgram(S.baseVertex, S.pressureFrag);
    this.progGradSub     = this.createProgram(S.baseVertex, S.gradientSubtractFrag);
    this.progComposite   = this.createProgram(S.baseVertex, S.compositeFrag);
    this.progEmber       = this.createProgram(S.emberVertex, S.emberFrag);
  }

  createFBO(w, h, internalFormat, format, type, filter) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    return {
      tex,
      fbo,
      width: w,
      height: h,
      attach(unit) {
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        return unit;
      }
    };
  }

  createDoubleFBO(w, h, internalFormat, format, type, filter) {
    let fbo1 = this.createFBO(w, h, internalFormat, format, type, filter);
    let fbo2 = this.createFBO(w, h, internalFormat, format, type, filter);
    return {
      width: w,
      height: h,
      get read() { return fbo1; },
      set read(v) { fbo1 = v; },
      get write() { return fbo2; },
      set write(v) { fbo2 = v; },
      swap() {
        const tmp = fbo1;
        fbo1 = fbo2;
        fbo2 = tmp;
      }
    };
  }

  initSimBuffers() {
    const gl = this.gl;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.aspect = this.canvas.width / Math.max(1, this.canvas.height);

    // Choose high-detail simulation grid resolution proportional to aspect ratio
    const baseRes = 352;
    if (this.aspect >= 1.0) {
      this.simHeight = baseRes;
      this.simWidth = Math.round(baseRes * this.aspect);
    } else {
      this.simWidth = baseRes;
      this.simHeight = Math.round(baseRes / this.aspect);
    }
    // Clamp max dimension for smooth 60fps
    this.simWidth = Math.min(576, Math.max(256, this.simWidth));
    this.simHeight = Math.min(576, Math.max(256, this.simHeight));

    const w = this.simWidth;
    const h = this.simHeight;
    this.texelSize = [1.0 / w, 1.0 / h];

    const linear = this.extFloatLinear ? gl.LINEAR : gl.NEAREST;

    this.velocity   = this.createDoubleFBO(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, linear);
    this.thermo     = this.createDoubleFBO(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, linear);
    this.obstacleFBO = this.createDoubleFBO(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, linear);
    this.pressure   = this.createDoubleFBO(w, h, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.NEAREST);
    this.divergence = this.createFBO(w, h, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.NEAREST);
    this.curl       = this.createFBO(w, h, gl.R16F, gl.RED, gl.HALF_FLOAT, gl.NEAREST);
    this.phiHat     = this.createFBO(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT, linear);

    const simLabel = document.getElementById('simResLabel');
    if (simLabel) {
      simLabel.textContent = `Sim: ${w}\u00d7${h}`;
    }
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.floor(window.innerWidth * dpr);
    const height = Math.floor(window.innerHeight * dpr);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
      this.initSimBuffers();
    }
  }

  initEmbers() {
    const gl = this.gl;
    this.emberCount = 260;
    this.emberData = new Float32Array(this.emberCount * 6); // x, y, vx, vy, life, size
    for (let i = 0; i < this.emberCount; i++) {
      this.respawnEmber(i, true);
    }

    this.emberVao = gl.createVertexArray();
    gl.bindVertexArray(this.emberVao);
    this.emberVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.emberVbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.emberData.byteLength, gl.DYNAMIC_DRAW);

    const stride = 6 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 16);
    gl.bindVertexArray(null);
  }

  respawnEmber(i, randomLife = false) {
    const idx = i * 6;
    const spread = this.params.burnerWidth * (this.params.burnerMode === 2 ? 0.3 : 0.9);
    this.emberData[idx + 0] = 0.5 + (Math.random() - 0.5) * 2.0 * spread;
    this.emberData[idx + 1] = 0.075 + Math.random() * 0.06;
    this.emberData[idx + 2] = (Math.random() - 0.5) * 0.25;
    this.emberData[idx + 3] = 0.35 + Math.random() * 0.65;
    this.emberData[idx + 4] = randomLife ? Math.random() : 0.85 + Math.random() * 0.15;
    this.emberData[idx + 5] = 2.5 + Math.random() * 4.5;
  }

  // CPU-side SDF helper so embers also bounce off the interactive object!
  evalObstacleSDF(x, y) {
    if (this.params.objShape === 5) return 10.0;
    let px = (x - this.obstacle.x) * this.aspect;
    let py = (y - this.obstacle.y);
    const c = Math.cos(this.params.objAngle);
    const s = Math.sin(this.params.objAngle);
    const rx = c * px - s * py;
    const ry = s * px + c * py;
    const r = this.params.objRadius;

    if (this.params.objShape === 0) {
      return Math.hypot(rx, ry) - r;
    } else if (this.params.objShape === 1) {
      const dx = Math.abs(rx) - r * 0.88;
      const dy = Math.abs(ry) - r * 0.88;
      return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0);
    } else {
      return Math.hypot(rx, ry) - r * 0.95;
    }
  }

  updateEmbers(dt) {
    const swirlTime = this.time * 3.0;
    for (let i = 0; i < this.emberCount; i++) {
      const idx = i * 6;
      let x = this.emberData[idx + 0];
      let y = this.emberData[idx + 1];
      let vx = this.emberData[idx + 2];
      let vy = this.emberData[idx + 3];
      let life = this.emberData[idx + 4];

      life -= dt * (0.32 + 0.15 * (i % 3));
      if (life <= 0.0 || y > 0.98 || x < 0.02 || x > 0.98) {
        this.respawnEmber(i, false);
        continue;
      }

      // Buoyant upward acceleration + turbulent curl flutter + wind
      const flutter = Math.sin(y * 18.0 + swirlTime + i) * 0.55;
      vx += (flutter + this.params.windX * 0.6 - (x - 0.5) * 0.35) * dt;
      vy += (this.params.buoyancy * 0.32) * dt;

      // Deflect embers around the interactive collider!
      const d = this.evalObstacleSDF(x, y);
      if (d < 0.022) {
        const eps = 0.004;
        const nx = this.evalObstacleSDF(x + eps, y) - this.evalObstacleSDF(x - eps, y);
        const ny = this.evalObstacleSDF(x, y + eps) - this.evalObstacleSDF(x, y - eps);
        const len = Math.hypot(nx, ny) || 1.0;
        const unx = nx / len;
        const uny = ny / len;

        x += unx * Math.max(0.0, 0.015 - d);
        y += uny * Math.max(0.0, 0.015 - d);
        vx = vx * 0.6 + this.obstacle.vx * 0.8 + unx * 0.35;
        vy = vy * 0.6 + this.obstacle.vy * 0.8 + uny * 0.35;
      }

      x += vx * dt;
      y += vy * dt;

      this.emberData[idx + 0] = x;
      this.emberData[idx + 1] = y;
      this.emberData[idx + 2] = vx * 0.985;
      this.emberData[idx + 3] = vy * 0.985;
      this.emberData[idx + 4] = life;
    }
  }

  setObstacleUniforms(u) {
    const gl = this.gl;
    if (u.uObjPos) gl.uniform2f(u.uObjPos, this.obstacle.x, this.obstacle.y);
    if (u.uObjVel) gl.uniform2f(u.uObjVel, this.obstacle.vx, this.obstacle.vy);
    if (u.uObjRadius) gl.uniform1f(u.uObjRadius, this.params.objRadius);
    if (u.uObjAngle) gl.uniform1f(u.uObjAngle, this.params.objAngle);
    if (u.uObjShape) gl.uniform1i(u.uObjShape, this.params.objShape);
    if (u.uAspect) gl.uniform1f(u.uAspect, this.aspect);
  }

  blit(targetFBO) {
    const gl = this.gl;
    if (targetFBO == null) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, targetFBO.fbo);
      gl.viewport(0, 0, targetFBO.width, targetFBO.height);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  triggerFireballBurst() {
    this.burstIntensity = 1.0;
  }

  step(dt) {
    const gl = this.gl;
    const clampedDt = Math.min(dt, 0.022);
    this.time += clampedDt;
    this.burstIntensity *= Math.exp(-4.5 * clampedDt);

    // Smoothly spring-interpolate obstacle toward pointer target so dragging imparts crisp, realistic velocity
    const prevX = this.obstacle.x;
    const prevY = this.obstacle.y;
    const lerpFactor = 1.0 - Math.exp(-28.0 * clampedDt);
    this.obstacle.x += (this.obstacle.targetX - this.obstacle.x) * lerpFactor;
    this.obstacle.y += (this.obstacle.targetY - this.obstacle.y) * lerpFactor;

    const instVx = (this.obstacle.x - prevX) / Math.max(clampedDt, 1e-4);
    const instVy = (this.obstacle.y - prevY) / Math.max(clampedDt, 1e-4);
    // Clamp max obstacle velocity so wild mouse flicks create dramatic wakes without numerical blowup
    const maxV = 2.8;
    const speed = Math.hypot(instVx, instVy);
    const scale = speed > maxV ? maxV / speed : 1.0;
    this.obstacle.vx = instVx * scale;
    this.obstacle.vy = instVy * scale;

    gl.bindVertexArray(this.quadVao);
    gl.disable(gl.BLEND);

    // 1. Update Obstacle SDF, Velocity, and Surface Thermal Glow Field
    {
      const p = this.progObstacle;
      gl.useProgram(p.program);
      this.setObstacleUniforms(p.uniforms);
      gl.uniform1i(p.uniforms.uPrevObstacle, this.obstacleFBO.read.attach(0));
      gl.uniform1i(p.uniforms.uThermo, this.thermo.read.attach(1));
      gl.uniform1f(p.uniforms.uDt, clampedDt);
      gl.uniform1i(p.uniforms.uObjThermalMode, this.params.objThermalMode);
      this.blit(this.obstacleFBO.write);
      this.obstacleFBO.swap();
    }

    // 2. MacCormack Sharp Advection of Velocity Field
    {
      const pAdv = this.progAdvect;
      gl.useProgram(pAdv.program);
      gl.uniform2f(pAdv.uniforms.uTexelSize, this.texelSize[0], this.texelSize[1]);
      gl.uniform1i(pAdv.uniforms.uVelocity, this.velocity.read.attach(0));
      gl.uniform1i(pAdv.uniforms.uSource, this.velocity.read.attach(1));
      gl.uniform1i(pAdv.uniforms.uObstacle, this.obstacleFBO.read.attach(2));
      gl.uniform1f(pAdv.uniforms.uDt, clampedDt);
      gl.uniform1f(pAdv.uniforms.uDissipation, 1.0);
      this.blit(this.phiHat);

      const pMac = this.progMacCormack;
      gl.useProgram(pMac.program);
      gl.uniform2f(pMac.uniforms.uTexelSize, this.texelSize[0], this.texelSize[1]);
      gl.uniform1i(pMac.uniforms.uVelocity, this.velocity.read.attach(0));
      gl.uniform1i(pMac.uniforms.uSource, this.velocity.read.attach(1));
      gl.uniform1i(pMac.uniforms.uPhiHat1, this.phiHat.attach(2));
      gl.uniform1i(pMac.uniforms.uObstacle, this.obstacleFBO.read.attach(3));
      gl.uniform1f(pMac.uniforms.uDt, clampedDt);
      gl.uniform1f(pMac.uniforms.uDissipation, 0.992);
      this.blit(this.velocity.write);
      this.velocity.swap();
    }

    // 3. MacCormack Sharp Advection of Thermo (Temperature, Fuel, Soot, Wrinkle) Field
    {
      const pAdv = this.progAdvect;
      gl.useProgram(pAdv.program);
      gl.uniform2f(pAdv.uniforms.uTexelSize, this.texelSize[0], this.texelSize[1]);
      gl.uniform1i(pAdv.uniforms.uVelocity, this.velocity.read.attach(0));
      gl.uniform1i(pAdv.uniforms.uSource, this.thermo.read.attach(1));
      gl.uniform1i(pAdv.uniforms.uObstacle, this.obstacleFBO.read.attach(2));
      gl.uniform1f(pAdv.uniforms.uDt, clampedDt);
      gl.uniform1f(pAdv.uniforms.uDissipation, 1.0);
      this.blit(this.phiHat);

      const pMac = this.progMacCormack;
      gl.useProgram(pMac.program);
      gl.uniform2f(pMac.uniforms.uTexelSize, this.texelSize[0], this.texelSize[1]);
      gl.uniform1i(pMac.uniforms.uVelocity, this.velocity.read.attach(0));
      gl.uniform1i(pMac.uniforms.uSource, this.thermo.read.attach(1));
      gl.uniform1i(pMac.uniforms.uPhiHat1, this.phiHat.attach(2));
      gl.uniform1i(pMac.uniforms.uObstacle, this.obstacleFBO.read.attach(3));
      gl.uniform1f(pMac.uniforms.uDt, clampedDt);
      gl.uniform1f(pMac.uniforms.uDissipation, 0.995);
      this.blit(this.thermo.write);
      this.thermo.swap();
    }

    // 4. Combustion Kinetics, Buoyancy, Baroclinic Torque, and Moving Obstacle Coupling
    {
      const p = this.progCombustion;
      gl.useProgram(p.program);
      this.setObstacleUniforms(p.uniforms);
      gl.uniform2f(p.uniforms.uTexelSize, this.texelSize[0], this.texelSize[1]);
      gl.uniform1f(p.uniforms.uTime, this.time);
      gl.uniform1f(p.uniforms.uDt, clampedDt);
      gl.uniform1f(p.uniforms.uFuelRate, this.params.fuelRate);
      gl.uniform1f(p.uniforms.uBuoyancy, this.params.buoyancy);
      gl.uniform1f(p.uniforms.uCooling, this.params.cooling);
      gl.uniform1f(p.uniforms.uWindX, this.params.windX);
      gl.uniform1f(p.uniforms.uBurnerWidth, this.params.burnerWidth);
      gl.uniform1i(p.uniforms.uBurnerMode, this.params.burnerMode);
      gl.uniform1i(p.uniforms.uObjThermalMode, this.params.objThermalMode);
      gl.uniform1f(p.uniforms.uBurstIntensity, this.burstIntensity);
      gl.uniform2f(p.uniforms.uPointerPos, this.pointer.x, this.pointer.y);
      gl.uniform2f(p.uniforms.uPointerVel, this.pointer.vx, this.pointer.vy);
      gl.uniform1f(p.uniforms.uPointerActive, this.pointer.active);

      // Pass 0: Update Thermo
      gl.uniform1i(p.uniforms.uPassMode, 0);
      gl.uniform1i(p.uniforms.uVelocity, this.velocity.read.attach(0));
      gl.uniform1i(p.uniforms.uThermo, this.thermo.read.attach(1));
      gl.uniform1i(p.uniforms.uObstacle, this.obstacleFBO.read.attach(2));
      this.blit(this.thermo.write);
      this.thermo.swap();

      // Pass 1: Update Velocity with updated Thermo
      gl.uniform1i(p.uniforms.uPassMode, 1);
      gl.uniform1i(p.uniforms.uVelocity, this.velocity.read.attach(0));
      gl.uniform1i(p.uniforms.uThermo, this.thermo.read.attach(1));
      gl.uniform1i(p.uniforms.uObstacle, this.obstacleFBO.read.attach(2));
      this.blit(this.velocity.write);
      this.velocity.swap();
    }

    // Decay pointer impulse
    this.pointer.vx *= 0.85;
    this.pointer.vy *= 0.85;

    // 5. Vorticity Confinement (Turbulent Flame Curls)
    {
      const pCurl = this.progCurl;
      gl.useProgram(pCurl.program);
      gl.uniform2f(pCurl.uniforms.uTexelSize, this.texelSize[0], this.texelSize[1]);
      gl.uniform1i(pCurl.uniforms.uVelocity, this.velocity.read.attach(0));
      gl.uniform1i(pCurl.uniforms.uThermo, this.thermo.read.attach(1));
      this.blit(this.curl);

      const pVort = this.progVorticity;
      gl.useProgram(pVort.program);
      gl.uniform2f(pVort.uniforms.uTexelSize, this.texelSize[0], this.texelSize[1]);
      gl.uniform1i(pVort.uniforms.uVelocity, this.velocity.read.attach(0));
      gl.uniform1i(pVort.uniforms.uCurl, this.curl.attach(1));
      gl.uniform1i(pVort.uniforms.uObstacle, this.obstacleFBO.read.attach(2));
      gl.uniform1f(pVort.uniforms.uCurlStrength, this.params.vorticity);
      gl.uniform1f(pVort.uniforms.uDt, clampedDt);
      this.blit(this.velocity.write);
      this.velocity.swap();
    }

    // 6. Divergence Calculation (with Exothermic Flame Front Expansion & Moving Obstacle Boundary)
    {
      const pDiv = this.progDivergence;
      gl.useProgram(pDiv.program);
      gl.uniform2f(pDiv.uniforms.uTexelSize, this.texelSize[0], this.texelSize[1]);
      gl.uniform1i(pDiv.uniforms.uVelocity, this.velocity.read.attach(0));
      gl.uniform1i(pDiv.uniforms.uThermo, this.thermo.read.attach(1));
      gl.uniform1i(pDiv.uniforms.uObstacle, this.obstacleFBO.read.attach(2));
      this.blit(this.divergence);
    }

    // 7. Jacobi Pressure Poisson Solver
    {
      const pPres = this.progPressure;
      gl.useProgram(pPres.program);
      gl.uniform2f(pPres.uniforms.uTexelSize, this.texelSize[0], this.texelSize[1]);
      gl.uniform1i(pPres.uniforms.uDivergence, this.divergence.attach(0));
      gl.uniform1i(pPres.uniforms.uObstacle, this.obstacleFBO.read.attach(1));

      for (let i = 0; i < this.params.pressureIterations; i++) {
        gl.uniform1i(pPres.uniforms.uPressure, this.pressure.read.attach(2));
        this.blit(this.pressure.write);
        this.pressure.swap();
      }
    }

    // 8. Subtract Pressure Gradient to Enforce Incompressibility & Solid Obstacle Flow Deflection
    {
      const pGrad = this.progGradSub;
      gl.useProgram(pGrad.program);
      gl.uniform2f(pGrad.uniforms.uTexelSize, this.texelSize[0], this.texelSize[1]);
      gl.uniform1i(pGrad.uniforms.uPressure, this.pressure.read.attach(0));
      gl.uniform1i(pGrad.uniforms.uVelocity, this.velocity.read.attach(1));
      gl.uniform1i(pGrad.uniforms.uObstacle, this.obstacleFBO.read.attach(2));
      this.blit(this.velocity.write);
      this.velocity.swap();
    }

    // Update dynamic firelight position & flicker for background normal-mapped illumination
    const flicker = 0.92 + 0.14 * Math.sin(this.time * 17.0) + 0.08 * Math.cos(this.time * 29.3);
    this.fireLight.x = 0.5 + this.params.windX * 0.06;
    this.fireLight.y = 0.25 + 0.03 * Math.sin(this.time * 8.5);
    this.fireLight.power = Math.min(2.0, this.params.fuelRate * 0.95 * flicker + this.burstIntensity * 1.2);

    // Update embers
    if (this.params.showEmbers) {
      this.updateEmbers(clampedDt);
    }
  }

  render() {
    const gl = this.gl;
    gl.bindVertexArray(this.quadVao);
    gl.disable(gl.BLEND);

    const p = this.progComposite;
    gl.useProgram(p.program);
    this.setObstacleUniforms(p.uniforms);
    gl.uniform2f(p.uniforms.uTexelSize, this.texelSize[0], this.texelSize[1]);
    gl.uniform1f(p.uniforms.uTime, this.time);
    gl.uniform1i(p.uniforms.uThermo, this.thermo.read.attach(0));
    gl.uniform1i(p.uniforms.uVelocity, this.velocity.read.attach(1));
    gl.uniform1i(p.uniforms.uPressure, this.pressure.read.attach(2));
    gl.uniform1i(p.uniforms.uObstacle, this.obstacleFBO.read.attach(3));

    gl.uniform1i(p.uniforms.uBgMode, this.params.bgMode);
    gl.uniform1i(p.uniforms.uFlamePalette, this.params.flamePalette);
    gl.uniform1f(p.uniforms.uRefraction, this.params.refraction);
    gl.uniform1f(p.uniforms.uSmokeOpacity, this.params.smokeOpacity);
    gl.uniform1f(p.uniforms.uBurnerWidth, this.params.burnerWidth);
    gl.uniform1i(p.uniforms.uBurnerMode, this.params.burnerMode);
    gl.uniform1i(p.uniforms.uObjThermalMode, this.params.objThermalMode);
    gl.uniform1i(p.uniforms.uShowFlowVectors, this.params.showFlowVectors ? 1 : 0);
    gl.uniform3f(p.uniforms.uFireLightPos, this.fireLight.x, this.fireLight.y, this.fireLight.power);

    this.blit(null);

    // Render glowing embers & sparks with additive blending
    if (this.params.showEmbers) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.useProgram(this.progEmber.program);
      gl.uniform1f(this.progEmber.uniforms.uAspect, this.aspect);
      gl.uniform1i(this.progEmber.uniforms.uFlamePalette, this.params.flamePalette);

      gl.bindVertexArray(this.emberVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.emberVbo);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.emberData);
      gl.drawArrays(gl.POINTS, 0, this.emberCount);
      gl.disable(gl.BLEND);
    }
  }
}

window.PyroSimulation = PyroSimulation;
