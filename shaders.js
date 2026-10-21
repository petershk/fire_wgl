// shaders.js - WebGL2 GLSL Shaders for Navier-Stokes Combustion, Obstacle SDFs, and Optical Composite

window.PyroShaders = {
  // Common fullscreen vertex shader
  baseVertex: `#version 300 es
  precision highp float;
  layout(location = 0) in vec2 aPosition;
  out vec2 vUv;
  void main() {
    vUv = aPosition * 0.5 + 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }`,

  // Shared SDF library for the interactive obstacle & burner geometry
  sdfChunk: `
  uniform vec2 uObjPos;
  uniform vec2 uObjVel;
  uniform float uObjRadius;
  uniform float uObjAngle;
  uniform int uObjShape; // 0: Sphere, 1: Box, 2: Airfoil/Blade, 3: Hollow Ring, 4: Cross Baffle, 5: Hidden
  uniform float uAspect;

  vec2 rotate2D(vec2 p, float angle) {
    float c = cos(angle);
    float s = sin(angle);
    return vec2(c * p.x - s * p.y, s * p.x + c * p.y);
  }

  float sdBox(vec2 p, vec2 b) {
    vec2 d = abs(p) - b;
    return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  }

  float sdRoundedBox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + r;
    return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
  }

  // Evaluate signed distance to the interactive collider in aspect-corrected space
  float obstacleSDF(vec2 uv) {
    if (uObjShape == 5) return 10.0;
    vec2 p = uv - uObjPos;
    p.x *= uAspect;
    p = rotate2D(p, uObjAngle);
    float r = uObjRadius;

    if (uObjShape == 0) {
      // Sphere / Cylinder
      return length(p) - r;
    } else if (uObjShape == 1) {
      // Rounded Square Block
      return sdRoundedBox(p, vec2(r * 0.88), r * 0.16);
    } else if (uObjShape == 2) {
      // Aerofoil / Curved Deflector Blade
      vec2 q = p;
      q.y -= 0.18 * r * (1.0 - clamp((q.x / (r * 1.45)) * (q.x / (r * 1.45)), 0.0, 1.5));
      float taper = clamp(0.5 - q.x / (r * 2.8), 0.15, 1.0);
      return sdRoundedBox(q, vec2(r * 1.45, r * 0.26 * taper), r * 0.09);
    } else if (uObjShape == 3) {
      // Hollow Ring (flames can pass through the center or split around!)
      float dOuter = length(p) - r * 1.15;
      float dInner = length(p) - r * 0.65;
      // Leave a small gap at top & bottom or full ring? Full ring with top vent gap so fire can thread through!
      float ring = max(dOuter, -dInner);
      float slot = sdBox(p - vec2(0.0, r * 0.9), vec2(r * 0.28, r * 0.45));
      return max(ring, -slot);
    } else if (uObjShape == 4) {
      // Cross Baffle / Stirrer
      float d1 = sdRoundedBox(p, vec2(r * 1.25, r * 0.26), r * 0.07);
      float d2 = sdRoundedBox(p, vec2(r * 0.26, r * 1.25), r * 0.07);
      return min(d1, d2);
    }
    return 10.0;
  }

  vec2 obstacleNormal(vec2 uv) {
    float e = 0.0025;
    float dx = obstacleSDF(uv + vec2(e, 0.0)) - obstacleSDF(uv - vec2(e, 0.0));
    float dy = obstacleSDF(uv + vec2(0.0, e)) - obstacleSDF(uv - vec2(0.0, e));
    vec2 n = vec2(dx, dy);
    float len = length(n);
    return len > 1e-5 ? n / len : vec2(0.0, 1.0);
  }
  `,

  // 1. Obstacle & Surface Heat Map Update Shader
  // Outputs RGBA16F: R = sdf, G = obsVel.x, B = obsVel.y, A = surface thermal glow
  obstacleUpdateFrag: `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 fragColor;

  uniform sampler2D uPrevObstacle;
  uniform sampler2D uThermo;
  uniform float uDt;
  uniform int uObjThermalMode;
  #include_sdf

  void main() {
    float d = obstacleSDF(vUv);

    // Sample previous obstacle heat at back-projected position (follows moving object)
    vec2 prevUv = vUv - uObjVel * uDt;
    float prevHeat = texture(uPrevObstacle, prevUv).a;

    // Sample surrounding flame temperature just outside the obstacle boundary
    vec2 n = obstacleNormal(vUv);
    vec2 probeUv = vUv + n * max(0.0, -d + 0.012);
    float flameT = texture(uThermo, probeUv).r;

    // Object heats up where flame touches its surface and slowly cools via radiation
    float surfaceProximity = smoothstep(0.045, -0.04, d);
    float targetHeat = prevHeat * exp(-0.55 * uDt) + flameT * 0.95 * uDt * surfaceProximity;

    if (uObjThermalMode == 1) {
      // Cryo mode: frosts over
      targetHeat = 0.0;
    } else if (uObjThermalMode == 2) {
      // Superheated igniter
      targetHeat = max(targetHeat, 1.4 * surfaceProximity);
    }

    targetHeat = clamp(targetHeat, 0.0, 1.8);
    fragColor = vec4(d, uObjVel.x, uObjVel.y, targetHeat);
  }`,

  // 2. Semi-Lagrangian Advection (used as building block & fallback)
  advectFrag: `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 fragColor;

  uniform sampler2D uVelocity;
  uniform sampler2D uSource;
  uniform sampler2D uObstacle;
  uniform vec2 uTexelSize;
  uniform float uDt;
  uniform float uDissipation;

  void main() {
    vec4 obs = texture(uObstacle, vUv);
    if (obs.r < 0.0) {
      fragColor = vec4(0.0);
      return;
    }
    vec2 vel = texture(uVelocity, vUv).xy;
    vec2 coord = vUv - uDt * vel;
    fragColor = uDissipation * texture(uSource, coord);
  }`,

  // 3. MacCormack Sharp Advection for Thermo & Velocity fields (preserves crisp flame sheets!)
  maccormackFrag: `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 fragColor;

  uniform sampler2D uVelocity;
  uniform sampler2D uSource;      // phi^n
  uniform sampler2D uPhiHat1;     // forward advected phi_hat^(n+1)
  uniform sampler2D uObstacle;
  uniform vec2 uTexelSize;
  uniform float uDt;
  uniform float uDissipation;

  void main() {
    vec4 obs = texture(uObstacle, vUv);
    if (obs.r < -0.004) {
      fragColor = vec4(0.0);
      return;
    }

    vec2 vel = texture(uVelocity, vUv).xy;
    vec2 backCoord = vUv - uDt * vel;

    // If near boundary or solid obstacle, revert to stable semi-Lagrangian
    float obsBack = texture(uObstacle, backCoord).r;
    if (obsBack < 0.008 || any(lessThan(backCoord, vec2(0.01))) || any(greaterThan(backCoord, vec2(0.99)))) {
      fragColor = uDissipation * texture(uPhiHat1, vUv);
      return;
    }

    // Reverse step from phi_hat^(n+1)
    vec4 phiHat1 = texture(uPhiHat1, vUv);
    vec4 phiHat0 = texture(uPhiHat1, vUv + uDt * vel);
    vec4 phiN = texture(uSource, vUv);

    // MacCormack correction
    vec4 result = phiHat1 + 0.5 * (phiN - phiHat0);

    // Clamp to neighborhood extrema around backCoord in uSource to prevent oscillation
    vec2 tc = backCoord / uTexelSize - 0.5;
    vec2 f = floor(tc);
    vec2 uv00 = (f + vec2(0.5, 0.5)) * uTexelSize;
    vec2 uv10 = (f + vec2(1.5, 0.5)) * uTexelSize;
    vec2 uv01 = (f + vec2(0.5, 1.5)) * uTexelSize;
    vec2 uv11 = (f + vec2(1.5, 1.5)) * uTexelSize;

    vec4 s00 = texture(uSource, uv00);
    vec4 s10 = texture(uSource, uv10);
    vec4 s01 = texture(uSource, uv01);
    vec4 s11 = texture(uSource, uv11);

    vec4 minVal = min(min(s00, s10), min(s01, s11));
    vec4 maxVal = max(max(s00, s10), max(s01, s11));

    fragColor = uDissipation * clamp(result, minVal, maxVal);
  }`,

  // 4. Burner Fuel Injection, Combustion Reaction, Baroclinic Torque, Buoyancy & Collider Coupling
  combustionAndForcesFrag: `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 outColor; // Will run in two passes: mode 0 updates Thermo, mode 1 updates Velocity

  uniform int uPassMode; // 0: update Thermo, 1: update Velocity
  uniform sampler2D uVelocity;
  uniform sampler2D uThermo;
  uniform sampler2D uObstacle;
  uniform vec2 uTexelSize;
  uniform float uTime;
  uniform float uDt;

  // Physics uniforms
  uniform float uFuelRate;
  uniform float uBuoyancy;
  uniform float uCooling;
  uniform float uWindX;
  uniform float uBurnerWidth;
  uniform int uBurnerMode;
  uniform int uObjThermalMode;
  uniform float uBurstIntensity;

  // Pointer wind/stir impulse
  uniform vec2 uPointerPos;
  uniform vec2 uPointerVel;
  uniform float uPointerActive;

  #include_sdf

  // Simplex/Value 2D + time noise for organic turbulent fuel injection
  float hash21(vec2 p) {
    p = fract(p * vec2(234.34, 435.345));
    p += dot(p, p + 34.23);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
  }

  float fbm(vec2 p) {
    float v = 0.0;
    float amp = 0.5;
    mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < 4; i++) {
      v += amp * noise(p);
      p = rot * p * 2.03;
      amp *= 0.5;
    }
    return v;
  }

  void main() {
    vec4 thermo = texture(uThermo, vUv);
    vec2 vel = texture(uVelocity, vUv).xy;
    vec4 obs = texture(uObstacle, vUv);
    float d = obs.r;

    float T = thermo.r; // Temperature
    float F = thermo.g; // Unburnt Fuel concentration
    float S = thermo.b; // Soot / Smoke density
    float W = thermo.a; // Fine flame wrinkle modulation

    // Burner geometry at the bottom of the domain
    float burnerY = 0.075;
    float dx = (vUv.x - 0.5);
    float dy = (vUv.y - burnerY);

    float n1 = fbm(vec2(vUv.x * 16.0, uTime * 3.8));
    float n2 = fbm(vec2(vUv.x * 32.0 + 11.3, uTime * 6.4 - vUv.y * 8.0));

    float emitterMask = 0.0;
    vec2 jetVel = vec2(0.0);

    if (uBurnerMode == 0) {
      // Campfire Logs / Multi-Jet: clustered hot coals & uneven wood gas jets
      float width = uBurnerWidth;
      float horiz = smoothstep(width, width * 0.35, abs(dx));
      float vert = exp(- (dy * dy) / 0.00055);
      // 3 overlapping log peaks
      float logs = 0.55 + 0.45 * cos(dx / width * 9.42) + 0.3 * sin(dx / width * 17.0 + 1.2);
      emitterMask = horiz * vert * clamp(logs, 0.25, 1.35) * (0.65 + 0.7 * n1);
      jetVel = vec2((n2 - 0.5) * 0.55 - dx * 0.6, (0.55 + 0.65 * n1) * uFuelRate);
    } else if (uBurnerMode == 1) {
      // Wide Ribbon Burner: uniform linear gas slots
      float width = uBurnerWidth * 1.45;
      float horiz = smoothstep(width, width - 0.02, abs(dx));
      float slots = 0.65 + 0.35 * sin(vUv.x * 160.0);
      float vert = exp(- (dy * dy) / 0.00038);
      emitterMask = horiz * vert * slots * (0.75 + 0.45 * n1);
      jetVel = vec2((n2 - 0.5) * 0.35, 0.72 * uFuelRate);
    } else if (uBurnerMode == 2) {
      // Focused Blowtorch Jet: high-velocity narrow core
      float width = uBurnerWidth * 0.32;
      float horiz = exp(-(dx * dx) / (width * width * 0.35));
      float vert = exp(-(dy * dy) / 0.00045);
      emitterMask = horiz * vert * 1.45;
      jetVel = vec2((n2 - 0.5) * 0.25, 1.85 * uFuelRate);
    } else if (uBurnerMode == 3) {
      // Twin Counter-Vortex Burners
      float sep = uBurnerWidth * 0.65;
      float dL = vUv.x - (0.5 - sep);
      float dR = vUv.x - (0.5 + sep);
      float w = uBurnerWidth * 0.35;
      float mL = exp(-(dL * dL) / (w * w * 0.5)) * exp(-(dy * dy) / 0.00045);
      float mR = exp(-(dR * dR) / (w * w * 0.5)) * exp(-(dy * dy) / 0.00045);
      emitterMask = (mL + mR) * (0.75 + 0.5 * n1);
      jetVel = vec2((mL * 0.55 - mR * 0.55) + (n2 - 0.5) * 0.35, (mL + mR) * 0.95 * uFuelRate);
    }

    // Fireball burst button impulse
    if (uBurstIntensity > 0.001) {
      vec2 bp = vec2(vUv.x - 0.5, vUv.y - 0.14);
      bp.x *= uAspect;
      float bMask = exp(-dot(bp, bp) / 0.0065) * uBurstIntensity;
      emitterMask += bMask * 2.2;
      jetVel += vec2((n1 - 0.5) * 1.5, 2.4 * bMask);
    }

    if (uPassMode == 0) {
      // --- PASS 0: THERMODYNAMICS & COMBUSTION ---
      // Inject fresh fuel & base ignition temperature at burner
      F = max(F, emitterMask * uFuelRate * 1.25);
      T = max(T, emitterMask * (0.95 + 0.35 * n2));
      W = mix(W, n2, clamp(emitterMask * 0.8, 0.0, 1.0));

      // Combustion kinetics: Fuel + O2 -> Heat + Soot
      // Reaction rate peaks at the flame sheet where both fuel and heat coexist
      float ignition = smoothstep(0.18, 0.55, T);
      float burnRate = 3.6 * F * ignition;
      float dF = min(F, burnRate * uDt);

      F -= dF;
      // Exothermic heat release from burning fuel
      T += dF * 1.55;

      // Radiative (T^4 Stefan-Boltzmann) + convective cooling
      float radCool = uCooling * (0.38 * T * T * T * T + 0.52 * T);
      T = max(0.0, T - radCool * uDt);

      // Soot formation in rich reaction zone, oxidation in ultra-hot core, slow dissipation in cool plume
      float sootGen = dF * 0.92 * smoothstep(0.25, 0.9, F + 0.25);
      float sootBurn = S * 0.45 * smoothstep(1.25, 1.85, T) * uDt;
      S = clamp(S + sootGen - sootBurn - 0.32 * S * uDt, 0.0, 2.0);

      // Evolve fine turbulent wrinkle detail
      W = clamp(W + (n2 - 0.48) * 1.8 * uDt * smoothstep(0.05, 0.5, T), 0.0, 1.5);

      // Interaction with the solid collider!
      if (d < 0.015) {
        if (uObjThermalMode == 1) {
          // Cryo / Cold Sink quenches temperature and fuel near boundary, creating dense steam/smoke
          float quench = smoothstep(0.018, -0.002, d);
          S += T * 0.35 * quench;
          T *= (1.0 - 0.92 * quench);
          F *= (1.0 - 0.85 * quench);
        } else if (uObjThermalMode == 2) {
          // Superheated Igniter: object itself sheds fuel & extreme heat into boundary layer!
          float shell = smoothstep(0.016, 0.0, abs(d - 0.004));
          T = max(T, shell * 1.45);
          F = max(F, shell * 0.85 * (0.6 + 0.6 * n1));
        } else {
          // Neutral collider: blocks interior flame, hot boundary layer hugs the surface
          if (d < -0.003) {
            T = 0.0;
            F = 0.0;
            S = 0.0;
          }
        }
      }

      outColor = vec4(clamp(T, 0.0, 2.4), clamp(F, 0.0, 2.2), S, W);
    } else {
      // --- PASS 1: FLUID MOMENTUM (BUOYANCY, BAROCLINIC TORQUE, WIND, COLLIDER WAKE) ---
      // Sample temperature horizontal gradient for baroclinic torque (rolling flame edges!)
      float tL = texture(uThermo, vUv - vec2(uTexelSize.x, 0.0)).r;
      float tR = texture(uThermo, vUv + vec2(uTexelSize.x, 0.0)).r;
      float dTdx = (tR - tL) * 0.5;

      // Upward thermal buoyancy minus heavy smoke drag
      float lift = uBuoyancy * (T * 1.25 + F * 0.45 - S * 0.12);
      vel.y += lift * uDt;

      // Baroclinic horizontal pinch + natural flickering instability
      vel.x += (-dTdx * 2.8 + (n2 - 0.5) * 1.35 * T + uWindX * (0.35 + 0.65 * smoothstep(0.05, 0.6, vUv.y))) * uDt;

      // Burner jet momentum
      vel = mix(vel, jetVel, clamp(emitterMask * 0.55, 0.0, 0.85));

      // Right-click / secondary pointer wind gust
      if (uPointerActive > 0.5) {
        vec2 dp = vUv - uPointerPos;
        dp.x *= uAspect;
        float wMask = exp(-dot(dp, dp) / 0.0045);
        vel += uPointerVel * wMask * 0.85;
      }

      // Collider boundary coupling: moving object imparts momentum to boundary layer & displaces fluid
      if (d < 0.018) {
        vec2 n = obstacleNormal(vUv);
        vec2 objV = obs.gb;
        if (d <= 0.0) {
          // Inside solid object: match object velocity + push fluid outward along normal
          vel = objV + n * (max(0.0, dot(objV, n)) * 0.65 + 0.25);
        } else {
          // Boundary layer shear & deflection around the object
          float band = smoothstep(0.018, 0.0, d);
          // Deflect oncoming flow tangentially around the obstacle surface
          float vn = dot(vel - objV, n);
          if (vn < 0.0) {
            vel -= n * vn * band * 0.95;
          }
          // Drag wake from moving object
          vel = mix(vel, objV, band * 0.45);
        }
      }

      outColor = vec4(vel, 0.0, 1.0);
    }
  }`,

  // 5. Curl (Vorticity) Calculation
  curlFrag: `#version 300 es
  precision highp float;
  in vec2 vUv;
  out float fragColor;

  uniform sampler2D uVelocity;
  uniform sampler2D uThermo;
  uniform vec2 uTexelSize;

  void main() {
    float L = texture(uVelocity, vUv - vec2(uTexelSize.x, 0.0)).y;
    float R = texture(uVelocity, vUv + vec2(uTexelSize.x, 0.0)).y;
    float B = texture(uVelocity, vUv - vec2(0.0, uTexelSize.y)).x;
    float T = texture(uVelocity, vUv + vec2(0.0, uTexelSize.y)).x;

    // Also include baroclinic vorticity contribution along steep temperature gradients
    float tL = texture(uThermo, vUv - vec2(uTexelSize.x, 0.0)).r;
    float tR = texture(uThermo, vUv + vec2(uTexelSize.x, 0.0)).r;

    float vorticity = 0.5 * ((R - L) - (T - B)) + (tR - tL) * 1.2;
    fragColor = vorticity;
  }`,

  // 6. Vorticity Confinement Force Application
  vorticityFrag: `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 fragColor;

  uniform sampler2D uVelocity;
  uniform sampler2D uCurl;
  uniform sampler2D uObstacle;
  uniform vec2 uTexelSize;
  uniform float uCurlStrength;
  uniform float uDt;

  void main() {
    vec4 obs = texture(uObstacle, vUv);
    if (obs.r < 0.0) {
      fragColor = vec4(obs.gb, 0.0, 1.0);
      return;
    }

    float L = texture(uCurl, vUv - vec2(uTexelSize.x, 0.0)).r;
    float R = texture(uCurl, vUv + vec2(uTexelSize.x, 0.0)).r;
    float B = texture(uCurl, vUv - vec2(0.0, uTexelSize.y)).r;
    float T = texture(uCurl, vUv + vec2(0.0, uTexelSize.y)).r;
    float C = texture(uCurl, vUv).r;

    vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    force /= length(force) + 1e-4;
    force *= uCurlStrength * C;
    force.y *= -1.0;

    vec2 vel = texture(uVelocity, vUv).xy;
    vel += force * uDt;
    fragColor = vec4(vel, 0.0, 1.0);
  }`,

  // 7. Divergence with Combustion Thermal Expansion & Solid Obstacle Boundaries
  divergenceFrag: `#version 300 es
  precision highp float;
  in vec2 vUv;
  out float fragColor;

  uniform sampler2D uVelocity;
  uniform sampler2D uThermo;
  uniform sampler2D uObstacle;
  uniform vec2 uTexelSize;

  void main() {
    vec2 C = texture(uVelocity, vUv).xy;
    vec4 obsC = texture(uObstacle, vUv);
    if (obsC.r < 0.0) {
      fragColor = 0.0;
      return;
    }

    vec2 uvL = vUv - vec2(uTexelSize.x, 0.0);
    vec2 uvR = vUv + vec2(uTexelSize.x, 0.0);
    vec2 uvB = vUv - vec2(0.0, uTexelSize.y);
    vec2 uvT = vUv + vec2(0.0, uTexelSize.y);

    vec2 L = texture(uVelocity, uvL).xy;
    vec2 R = texture(uVelocity, uvR).xy;
    vec2 B = texture(uVelocity, uvB).xy;
    vec2 T = texture(uVelocity, uvT).xy;

    vec4 obsL = texture(uObstacle, uvL);
    vec4 obsR = texture(uObstacle, uvR);
    vec4 obsB = texture(uObstacle, uvB);
    vec4 obsT = texture(uObstacle, uvT);

    // Enforce moving solid boundary velocities in divergence computation
    if (obsL.r < 0.0) L = obsL.gb;
    if (obsR.r < 0.0) R = obsR.gb;
    if (obsB.r < 0.0) B = obsB.gb;
    if (obsT.r < 0.0) T = obsT.gb;

    // Open outflow at top, no-slip/bounce at sides/bottom
    if (uvL.x < 0.0) L.x = -C.x;
    if (uvR.x > 1.0) R.x = -C.x;
    if (uvB.y < 0.0) B.y = -C.y;

    float div = 0.5 * ((R.x - L.x) + (T.y - B.y));

    // Exothermic gas expansion at the active flame reaction front!
    vec4 th = texture(uThermo, vUv);
    float reactionZone = th.g * smoothstep(0.25, 0.75, th.r);
    div -= reactionZone * 0.018;

    fragColor = div;
  }`,

  // 8. Pressure Poisson Jacobi Iteration with Solid Obstacle Neumann Boundary Conditions
  pressureFrag: `#version 300 es
  precision highp float;
  in vec2 vUv;
  out float fragColor;

  uniform sampler2D uPressure;
  uniform sampler2D uDivergence;
  uniform sampler2D uObstacle;
  uniform vec2 uTexelSize;

  void main() {
    float pC = texture(uPressure, vUv).r;
    if (texture(uObstacle, vUv).r < 0.0) {
      fragColor = pC;
      return;
    }

    vec2 uvL = vUv - vec2(uTexelSize.x, 0.0);
    vec2 uvR = vUv + vec2(uTexelSize.x, 0.0);
    vec2 uvB = vUv - vec2(0.0, uTexelSize.y);
    vec2 uvT = vUv + vec2(0.0, uTexelSize.y);

    float L = texture(uPressure, uvL).r;
    float R = texture(uPressure, uvR).r;
    float B = texture(uPressure, uvB).r;
    float T = texture(uPressure, uvT).r;

    // Pure Neumann boundary condition (dp/dn = 0) at solid obstacle interfaces
    if (texture(uObstacle, uvL).r < 0.0) L = pC;
    if (texture(uObstacle, uvR).r < 0.0) R = pC;
    if (texture(uObstacle, uvB).r < 0.0) B = pC;
    if (texture(uObstacle, uvT).r < 0.0) T = pC;

    float div = texture(uDivergence, vUv).r;
    fragColor = (L + R + B + T - div) * 0.25;
  }`,

  // 9. Pressure Gradient Subtraction (Projection to Incompressible / Low-Mach Flow)
  gradientSubtractFrag: `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 fragColor;

  uniform sampler2D uPressure;
  uniform sampler2D uVelocity;
  uniform sampler2D uObstacle;
  uniform vec2 uTexelSize;

  void main() {
    vec4 obsC = texture(uObstacle, vUv);
    if (obsC.r < 0.0) {
      fragColor = vec4(obsC.gb, 0.0, 1.0);
      return;
    }

    vec2 uvL = vUv - vec2(uTexelSize.x, 0.0);
    vec2 uvR = vUv + vec2(uTexelSize.x, 0.0);
    vec2 uvB = vUv - vec2(0.0, uTexelSize.y);
    vec2 uvT = vUv + vec2(0.0, uTexelSize.y);

    float pC = texture(uPressure, vUv).r;
    float L = texture(uPressure, uvL).r;
    float R = texture(uPressure, uvR).r;
    float B = texture(uPressure, uvB).r;
    float T = texture(uPressure, uvT).r;

    vec4 obsL = texture(uObstacle, uvL);
    vec4 obsR = texture(uObstacle, uvR);
    vec4 obsB = texture(uObstacle, uvB);
    vec4 obsT = texture(uObstacle, uvT);

    vec2 obstV = vec2(0.0);
    vec2 vMask = vec2(1.0);

    if (obsL.r < 0.0) { L = pC; obstV.x = obsL.g; vMask.x = 0.0; }
    if (obsR.r < 0.0) { R = pC; obstV.x = obsR.g; vMask.x = 0.0; }
    if (obsB.r < 0.0) { B = pC; obstV.y = obsB.b; vMask.y = 0.0; }
    if (obsT.r < 0.0) { T = pC; obstV.y = obsT.b; vMask.y = 0.0; }

    vec2 vel = texture(uVelocity, vUv).xy;
    vel -= 0.5 * vec2(R - L, T - B);
    vel = vMask * vel + (1.0 - vMask) * obstV;

    fragColor = vec4(vel, 0.0, 1.0);
  }`,

  // 10. Final Optical Composite Shader:
  // - 5 Selectable Backgrounds with dynamic fire illumination
  // - Real-time Heat Haze Refraction (Schlieren index-of-refraction gradient)
  // - Sub-grid procedural flame tongue detail + Planckian Blackbody / Chemical Emission
  // - Volumetric-style Smoke Self-Shadowing & Background Occlusion
  // - 3D Shaded Interactive Collider with Incandescent Thermal Glow
  // - Optional Velocity Vector Glyph Overlay
  compositeFrag: `#version 300 es
  precision highp float;
  in vec2 vUv;
  out vec4 fragColor;

  uniform sampler2D uThermo;
  uniform sampler2D uVelocity;
  uniform sampler2D uPressure;
  uniform sampler2D uObstacle;

  uniform vec2 uTexelSize;
  uniform float uTime;

  uniform int uBgMode;          // 0: Brick Hearth, 1: Optical Grid, 2: Daylight Sky, 3: Dark Void, 4: Schlieren Lab
  uniform int uFlamePalette;    // 0: Hydrocarbon Blackbody, 1: Copper Emerald, 2: Crimson Plasma, 3: Oxy-Acetylene
  uniform float uRefraction;
  uniform float uSmokeOpacity;
  uniform float uBurnerWidth;
  uniform int uBurnerMode;
  uniform int uObjThermalMode;
  uniform int uShowFlowVectors;
  uniform vec3 uFireLightPos;   // xy = centroid, z = intensity

  #include_sdf

  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash21(i), hash21(i + vec2(1.0, 0.0)), f.x),
      mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), f.x),
      f.y
    );
  }

  float fbm3(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    mat2 m = mat2(0.8, 0.6, -0.6, 0.8);
    for (int i = 0; i < 3; i++) {
      v += a * noise(p);
      p = m * p * 2.07;
      a *= 0.5;
    }
    return v;
  }

  // Physically-inspired Blackbody & Chemical Flame Color Mapping
  vec3 mapFlameEmission(float temp, float fuel, float wrinkle, int palette) {
    // Modulate temperature with fine advected wrinkle detail so flame tongues have crisp glowing ribs
    float t = max(0.0, temp * (0.82 + 0.36 * wrinkle));

    if (palette == 0) {
      // Classic Hydrocarbon Blackbody (Planckian locus: deep red -> orange -> golden yellow -> dazzling white)
      // Plus subtle blue CH* radical chemiluminescence at the base where unburnt fuel meets oxygen!
      vec3 cRed    = vec3(0.75, 0.04, 0.005);
      vec3 cOrange = vec3(1.00, 0.32, 0.02);
      vec3 cYellow = vec3(1.00, 0.78, 0.18);
      vec3 cWhite  = vec3(1.00, 0.98, 0.92);

      vec3 col = vec3(0.0);
      col = mix(col, cRed,    smoothstep(0.08, 0.42, t));
      col = mix(col, cOrange, smoothstep(0.35, 0.82, t));
      col = mix(col, cYellow, smoothstep(0.75, 1.32, t));
      col = mix(col, cWhite,  smoothstep(1.25, 1.95, t));

      float intensity = pow(clamp(t * 0.95, 0.0, 2.2), 1.65) * 2.4;
      vec3 emission = col * intensity;

      // Blue radical glow at the base of the fuel-rich reaction zone
      float blueBase = fuel * smoothstep(0.15, 0.65, t) * (1.0 - smoothstep(0.9, 1.5, t));
      emission += vec3(0.08, 0.28, 0.95) * blueBase * 0.75;
      return emission;
    } else if (palette == 1) {
      // Copper Chloride (Emerald / Cyan-Green Alchemy Flame)
      vec3 cTeal   = vec3(0.02, 0.25, 0.45);
      vec3 cGreen  = vec3(0.06, 0.92, 0.38);
      vec3 cLime   = vec3(0.58, 1.00, 0.45);
      vec3 cWhite  = vec3(0.92, 1.00, 0.96);

      vec3 col = mix(vec3(0.0), cTeal, smoothstep(0.08, 0.40, t));
      col = mix(col, cGreen, smoothstep(0.35, 0.85, t));
      col = mix(col, cLime,  smoothstep(0.80, 1.35, t));
      col = mix(col, cWhite, smoothstep(1.30, 1.95, t));
      return col * pow(clamp(t, 0.0, 2.2), 1.6) * 2.3;
    } else if (palette == 2) {
      // Lithium / Strontium (Deep Magenta-Crimson Plasma)
      vec3 cViolet  = vec3(0.38, 0.02, 0.28);
      vec3 cCrimson = vec3(0.98, 0.06, 0.26);
      vec3 cPeach   = vec3(1.00, 0.48, 0.55);
      vec3 cWhite   = vec3(1.00, 0.94, 0.97);

      vec3 col = mix(vec3(0.0), cViolet, smoothstep(0.08, 0.40, t));
      col = mix(col, cCrimson, smoothstep(0.35, 0.85, t));
      col = mix(col, cPeach,   smoothstep(0.80, 1.35, t));
      col = mix(col, cWhite,   smoothstep(1.30, 1.95, t));
      return col * pow(clamp(t, 0.0, 2.2), 1.6) * 2.3;
    } else {
      // Oxy-Acetylene High-Temp Torch (Electric Cobalt -> Cyan -> Ultraviolet White)
      vec3 cCobalt = vec3(0.04, 0.12, 0.78);
      vec3 cCyan   = vec3(0.15, 0.62, 1.00);
      vec3 cIce    = vec3(0.68, 0.90, 1.00);
      vec3 cWhite  = vec3(0.98, 0.99, 1.00);

      vec3 col = mix(vec3(0.0), cCobalt, smoothstep(0.08, 0.40, t));
      col = mix(col, cCyan,   smoothstep(0.35, 0.85, t));
      col = mix(col, cIce,    smoothstep(0.80, 1.35, t));
      col = mix(col, cWhite,  smoothstep(1.30, 1.95, t));
      return col * pow(clamp(t, 0.0, 2.2), 1.6) * 2.3;
    }
  }

  // Render the selectable background at refracted UV coordinates
  vec3 sampleBackground(vec2 uv, vec2 rawUv) {
    vec2 p = vec2(uv.x * uAspect, uv.y);

    // Light color matching the current flame palette
    vec3 lightTint = vec3(1.0, 0.52, 0.18);
    if (uFlamePalette == 1) lightTint = vec3(0.20, 0.95, 0.52);
    if (uFlamePalette == 2) lightTint = vec3(1.00, 0.22, 0.45);
    if (uFlamePalette == 3) lightTint = vec3(0.35, 0.72, 1.00);

    vec2 lightPos = vec2(uFireLightPos.x * uAspect, uFireLightPos.y);
    float lightPower = uFireLightPos.z;

    if (uBgMode == 0) {
      // --- 0: BRICK HEARTH WITH NORMAL-MAPPED DYNAMIC FIRELIGHT ---
      vec2 brickScale = vec2(7.5, 16.0);
      vec2 bp = p * brickScale;
      float row = floor(bp.y);
      bp.x += mod(row, 2.0) * 0.5;
      vec2 cell = floor(bp);
      vec2 f = fract(bp);

      // Mortar grooves & brick surface relief
      vec2 dEdge = min(f, 1.0 - f);
      float mortar = smoothstep(0.03, 0.085, min(dEdge.x, dEdge.y * 0.65));

      float brickId = hash21(cell);
      float surfaceNoise = fbm3(bp * 2.4 + brickId * 13.7);

      // Approximate brick surface normal for 3D point lighting from the dancing fire
      float nx = (smoothstep(0.0, 0.12, f.x) - smoothstep(0.88, 1.0, f.x)) * 0.6 + (surfaceNoise - 0.5) * 0.35;
      float ny = (smoothstep(0.0, 0.16, f.y) - smoothstep(0.84, 1.0, f.y)) * 0.6 + (surfaceNoise - 0.5) * 0.35;
      vec3 N = normalize(vec3(-nx * mortar, -ny * mortar, 1.0));

      vec3 fragPos = vec3(p, 0.0);
      vec3 lPos = vec3(lightPos, 0.24);
      vec3 L = lPos - fragPos;
      float dist = length(L);
      L /= max(dist, 1e-4);

      float atten = lightPower / (0.18 + 1.85 * dist * dist);
      float ndotl = max(0.0, dot(N, L));

      vec3 brickAlbedo = mix(vec3(0.18, 0.09, 0.07), vec3(0.28, 0.14, 0.10), brickId) * (0.75 + 0.5 * surfaceNoise);
      vec3 mortarAlbedo = vec3(0.09, 0.085, 0.08);
      vec3 albedo = mix(mortarAlbedo, brickAlbedo, mortar);

      // Ambient cool moonlight + warm flickering firelight
      vec3 col = albedo * (vec3(0.11, 0.13, 0.18) + lightTint * ndotl * atten * 2.6);

      // Stone hearth floor slab at the bottom
      float floorMask = smoothstep(0.068, 0.062, uv.y);
      vec3 floorCol = vec3(0.07, 0.07, 0.08) + lightTint * atten * 0.45;
      return mix(col, floorCol, floorMask);

    } else if (uBgMode == 1) {
      // --- 1: HIGH-CONTRAST OPTICAL CALIBRATION GRID ---
      // Designed so heat refraction ripples and dark smoke absorption are 100% unmistakable!
      vec2 gp = p * 12.0;
      vec2 gridCell = floor(gp);
      float checker = mod(gridCell.x + gridCell.y, 2.0);

      vec3 c1 = vec3(0.16, 0.19, 0.24);
      vec3 c2 = vec3(0.25, 0.29, 0.36);
      vec3 base = mix(c1, c2, checker);

      // Crisp cyan/white millimeter grid lines
      vec2 gf = abs(fract(gp) - 0.5);
      float line = 1.0 - smoothstep(0.465, 0.495, max(gf.x, gf.y));
      base = mix(base, vec3(0.55, 0.78, 0.95), line * 0.55);

      // Major axis lines
      vec2 mf = abs(fract(p * 3.0) - 0.5);
      float majorLine = 1.0 - smoothstep(0.485, 0.498, max(mf.x, mf.y));
      base = mix(base, vec3(0.88, 0.94, 1.0), majorLine * 0.7);

      return base;

    } else if (uBgMode == 2) {
      // --- 2: DAYLIGHT / GOLDEN HOUR SKY ---
      // Bright background so you can see black carbon soot and smoke silhouette in contrast to the bright core!
      vec3 zenith = vec3(0.24, 0.46, 0.78);
      vec3 horizon = vec3(0.94, 0.68, 0.46);
      vec3 sky = mix(horizon, zenith, pow(clamp(uv.y, 0.0, 1.0), 0.65));

      // Soft procedural clouds distorted by heat haze
      float clouds = fbm3(vec2(p.x * 2.2 + 0.4, p.y * 3.8));
      sky = mix(sky, vec3(0.98, 0.92, 0.86), smoothstep(0.45, 0.78, clouds) * 0.45 * smoothstep(0.1, 0.5, uv.y));

      // Distant mountain ridge silhouette near bottom
      float ridge = 0.11 + 0.035 * sin(p.x * 4.2) + 0.02 * cos(p.x * 9.7);
      float mMask = smoothstep(ridge + 0.004, ridge - 0.004, uv.y);
      vec3 ground = vec3(0.11, 0.12, 0.16) + lightTint * 0.12 * exp(-length(p - lightPos) * 2.5);
      return mix(sky, ground, mMask);

    } else if (uBgMode == 3) {
      // --- 3: DARK STUDIO VOID WITH REFLECTIVE FLOOR ---
      float dist = length(p - lightPos);
      vec3 bg = vec3(0.015, 0.018, 0.025) + lightTint * (0.035 * lightPower / (0.25 + dist * dist * 2.5));
      if (uv.y < 0.068) {
        float refl = exp(-abs(p.x - lightPos.x) * 3.5) * lightPower;
        bg = vec3(0.03, 0.032, 0.04) + lightTint * refl * 0.35;
      }
      return bg;

    } else {
      // --- 4: SCHLIEREN OPTICAL REFRACTOMETRY LAB VIEW ---
      // Visualizes refractive index gradients (dn/dx, dn/dy) like a high-speed aerodynamics wind tunnel!
      float tL = texture(uThermo, rawUv - vec2(uTexelSize.x, 0.0)).r;
      float tR = texture(uThermo, rawUv + vec2(uTexelSize.x, 0.0)).r;
      float tB = texture(uThermo, rawUv - vec2(0.0, uTexelSize.y)).r;
      float tT = texture(uThermo, rawUv + vec2(0.0, uTexelSize.y)).r;

      float pL = texture(uPressure, rawUv - vec2(uTexelSize.x, 0.0)).r;
      float pR = texture(uPressure, rawUv + vec2(uTexelSize.x, 0.0)).r;

      vec2 gradT = vec2(tR - tL, tT - tB) * 14.0;
      float knifeEdge = gradT.x * 0.8 + gradT.y * 0.5 + (pR - pL) * 4.0;
      float schlieren = clamp(0.48 + knifeEdge, 0.04, 0.98);

      // Subtle silver/blue lab optics tint
      return vec3(schlieren * 0.88, schlieren * 0.93, schlieren);
    }
  }

  // Render the physical burner grate / nozzle at the bottom
  void renderBurnerNozzle(vec2 uv, inout vec3 color) {
    float burnerY = 0.068;
    float dx = abs(uv.x - 0.5);
    float dy = uv.y - burnerY;
    if (dy < 0.012 && dy > -0.035 && dx < uBurnerWidth * 1.15) {
      float grate = smoothstep(0.012, 0.005, dy) * smoothstep(uBurnerWidth * 1.15, uBurnerWidth * 0.98, dx);
      float slots = 0.5 + 0.5 * sin(uv.x * 180.0);
      vec3 metal = vec3(0.12, 0.13, 0.15) * (0.6 + 0.4 * slots);
      // Glowing ember bed on top of burner
      float coalGlow = smoothstep(0.01, -0.006, abs(dy - 0.004)) * smoothstep(uBurnerWidth, uBurnerWidth * 0.4, dx);
      metal += vec3(1.2, 0.32, 0.04) * coalGlow * (0.6 + 0.4 * slots);
      color = mix(color, metal, grate);
    }
  }

  // Render 2D vector field arrows when enabled
  float drawVelocityGlyph(vec2 uv) {
    vec2 grid = vec2(28.0 * uAspect, 28.0);
    vec2 cellCenter = (floor(uv * grid) + 0.5) / grid;
    if (obstacleSDF(cellCenter) < 0.0) return 0.0;

    vec2 vel = texture(uVelocity, cellCenter).xy;
    float speed = length(vel);
    if (speed < 0.02) return 0.0;

    vec2 dir = vel / speed;
    vec2 local = (uv - cellCenter) * grid; // in [-0.5, 0.5]
    float len = clamp(speed * 0.42, 0.08, 0.44);

    // Project onto arrow segment
    float proj = clamp(dot(local, dir), -len * 0.5, len * 0.5);
    float distSeg = length(local - dir * proj);
    float line = smoothstep(0.065, 0.025, distSeg);

    // Tip dot
    float tip = smoothstep(0.11, 0.04, length(local - dir * (len * 0.5)));
    return max(line * 0.65, tip);
  }

  void main() {
    // 1. Sample temperature gradient for realistic Heat Haze Refraction
    float tL = texture(uThermo, vUv - vec2(uTexelSize.x * 1.5, 0.0)).r;
    float tR = texture(uThermo, vUv + vec2(uTexelSize.x * 1.5, 0.0)).r;
    float tB = texture(uThermo, vUv - vec2(0.0, uTexelSize.y * 1.5)).r;
    float tT = texture(uThermo, vUv + vec2(0.0, uTexelSize.y * 1.5)).r;

    vec4 thermo = texture(uThermo, vUv);
    float T = thermo.r;
    float F = thermo.g;
    float S = thermo.b;
    float W = thermo.a;

    // Sub-grid animated micro-turbulence advected along the flow direction
    vec2 vel = texture(uVelocity, vUv).xy;
    vec2 flowUv = vec2(vUv.x * uAspect, vUv.y) * 9.5 - vel * 0.18 - vec2(0.0, uTime * 2.6);
    float microNoise = fbm3(flowUv + vec2(W * 1.8));

    // Refractive index gradient distortion of background
    vec2 gradT = vec2(tR - tL, tT - tB);
    vec2 refractOffset = gradT * 0.018 * uRefraction + (microNoise - 0.5) * 0.008 * clamp(T, 0.0, 1.2) * uRefraction;
    vec2 bgUv = clamp(vUv + refractOffset, 0.002, 0.998);

    // 2. Render background at refracted coordinates
    vec3 color = sampleBackground(bgUv, vUv);

    // Render burner hardware
    renderBurnerNozzle(vUv, color);

    // 3. Volumetric-style Smoke & Soot Absorption + Self-Illumination from nearby flame
    // Shape smoke with fine noise so it looks wispy and billowing
    float smokeDensity = clamp(S * (0.72 + 0.55 * microNoise) * uSmokeOpacity, 0.0, 1.0);
    float smokeTransmittance = exp(-smokeDensity * 2.2);

    // Smoke receives warm internal scatter from adjacent fire temperature
    float avgNeighborT = 0.25 * (tL + tR + tB + tT);
    vec3 smokeTint = vec3(0.04, 0.042, 0.048);
    if (uBgMode == 2) {
      // Against bright daylight sky, carbon soot looks rich dark charcoal gray
      smokeTint = vec3(0.08, 0.085, 0.095);
    }
    vec3 internalScatter = mapFlameEmission(avgNeighborT * 0.65, 0.0, W, uFlamePalette) * 0.22;
    vec3 smokeColor = smokeTint + internalScatter;

    // Attenuate background by smoke transmittance and blend scattered smoke
    color = color * smokeTransmittance + smokeColor * (1.0 - smokeTransmittance);

    // 4. Radiative Flame Emission (Crisp tongues via sub-grid cellular erosion at outer boundary)
    float erodedT = max(0.0, T - (1.0 - microNoise) * 0.22 * smoothstep(1.1, 0.1, T));
    vec3 flameEmission = mapFlameEmission(erodedT, F, mix(W, microNoise, 0.45), uFlamePalette);

    // In Schlieren lab mode, blend flame gently so refractive shockwaves stay visible
    float flameWeight = (uBgMode == 4) ? 0.55 : 1.0;
    color += flameEmission * flameWeight;

    // 5. Render the Interactive 3D-Shaded Collider Object
    vec4 obs = texture(uObstacle, vUv);
    float d = obstacleSDF(vUv);
    if (d < 0.004) {
      float mask = smoothstep(0.003, -0.002, d);
      vec2 n2d = obstacleNormal(vUv);
      // Reconstruct 3D bevel normal for metallic/ceramic shading
      float bevel = clamp(-d / max(uObjRadius * 0.65, 0.01), 0.0, 1.0);
      vec3 N3 = normalize(vec3(n2d * (1.0 - bevel * 0.65), sqrt(max(0.05, 1.0 - dot(n2d * (1.0 - bevel * 0.65), n2d * (1.0 - bevel * 0.65))))));

      // Light from fire centroid + top studio rim light
      vec2 pAspect = vec2(vUv.x * uAspect, vUv.y);
      vec2 lAspect = vec2(uFireLightPos.x * uAspect, uFireLightPos.y);
      vec3 Lfire = normalize(vec3(lAspect - pAspect, 0.18));
      vec3 Ltop  = normalize(vec3(-0.3, 0.8, 0.6));
      vec3 V     = vec3(0.0, 0.0, 1.0);

      float diffFire = max(0.0, dot(N3, Lfire)) * uFireLightPos.z;
      float diffTop  = max(0.0, dot(N3, Ltop));
      float specFire = pow(max(0.0, dot(reflect(-Lfire, N3), V)), 24.0) * uFireLightPos.z;
      float specTop  = pow(max(0.0, dot(reflect(-Ltop, N3), V)), 32.0);

      // Material base color based on thermal mode
      vec3 matBase = vec3(0.18, 0.20, 0.24); // Brushed dark titanium
      if (uObjThermalMode == 1) matBase = vec3(0.22, 0.45, 0.68); // Cryo cobalt
      if (uObjThermalMode == 2) matBase = vec3(0.32, 0.14, 0.08); // Igniter refractory core

      // Subtle machined grip rings on collider
      vec2 localP = rotate2D(vec2((vUv.x - uObjPos.x) * uAspect, vUv.y - uObjPos.y), uObjAngle);
      float grip = 0.9 + 0.1 * cos(length(localP) / max(uObjRadius, 0.01) * 25.0);
      matBase *= grip;

      vec3 objColor = matBase * (0.28 + 0.65 * diffTop)
                    + matBase * vec3(1.0, 0.55, 0.2) * diffFire * 1.4
                    + vec3(0.45, 0.5, 0.55) * specTop * 0.45
                    + vec3(1.0, 0.65, 0.3) * specFire * 0.65;

      // Thermal incandescence where the flames have heated the collider!
      float surfHeat = obs.a;
      if (uObjThermalMode == 1) {
        // Frost rim glow
        float rim = smoothstep(-0.025, 0.0, d);
        objColor += vec3(0.25, 0.75, 1.0) * rim * 0.55;
      } else {
        vec3 heatGlow = vec3(1.2, 0.18, 0.02) * smoothstep(0.15, 0.85, surfHeat)
                      + vec3(1.4, 0.65, 0.12) * smoothstep(0.65, 1.45, surfHeat);
        objColor += heatGlow * 1.35;
      }

      // Crisp rim highlight so collider is always easy to see and grab
      float edgeRim = smoothstep(-0.005, -0.0005, d);
      objColor += vec3(0.35, 0.4, 0.48) * edgeRim * 0.45;

      color = mix(color, objColor, mask);
    }

    // 6. Optional Velocity Vector Glyph Overlay
    if (uShowFlowVectors == 1) {
      float glyph = drawVelocityGlyph(vUv);
      color = mix(color, vec3(0.2, 0.95, 1.0), glyph * 0.75);
    }

    // 7. ACES Filmic Tone Mapping & Gamma Correction
    vec3 x = color;
    vec3 aces = clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
    fragColor = vec4(pow(aces, vec3(1.0 / 2.2)), 1.0);
  }`,

  // 11. Glowing Sparks & Embers Particle Shaders (Advected in fluid velocity field!)
  emberVertex: `#version 300 es
  precision highp float;
  layout(location = 0) in vec2 aPos;
  layout(location = 1) in vec2 aVel;
  layout(location = 2) in vec2 aLifeSize; // x = life [0..1], y = size

  uniform float uAspect;
  out float vLife;
  out float vSpeed;

  void main() {
    vLife = aLifeSize.x;
    vSpeed = length(aVel);
    vec2 ndc = aPos * 2.0 - 1.0;
    gl_Position = vec4(ndc, 0.0, 1.0);
    gl_PointSize = aLifeSize.y * (0.6 + 0.8 * vLife);
  }`,

  emberFrag: `#version 300 es
  precision highp float;
  in float vLife;
  in float vSpeed;
  out vec4 fragColor;

  uniform int uFlamePalette;

  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;

    float core = exp(-r2 * 3.5);
    vec3 cHot = vec3(1.0, 0.85, 0.45);
    vec3 cCool = vec3(1.0, 0.25, 0.02);

    if (uFlamePalette == 1) {
      cHot = vec3(0.65, 1.0, 0.75);
      cCool = vec3(0.05, 0.85, 0.35);
    } else if (uFlamePalette == 2) {
      cHot = vec3(1.0, 0.65, 0.8);
      cCool = vec3(0.95, 0.08, 0.3);
    } else if (uFlamePalette == 3) {
      cHot = vec3(0.8, 0.95, 1.0);
      cCool = vec3(0.15, 0.55, 1.0);
    }

    vec3 col = mix(cCool, cHot, smoothstep(0.2, 0.85, vLife));
    float alpha = core * smoothstep(0.0, 0.2, vLife) * smoothstep(1.0, 0.85, vLife);
    fragColor = vec4(col * 1.6 * alpha, alpha);
  }`
};
