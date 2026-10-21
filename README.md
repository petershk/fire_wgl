# PyroGL — Interactive WebGL2 Fire & Fluid Combustion Simulation

**PyroGL** is a real-time, physically inspired **Eulerian Navier-Stokes fluid & combustion simulation** built in pure **WebGL2** with zero external dependencies. It simulates buoyant reactive flames, turbulent vorticity, blackbody/chemical radiation, soot formation, heat-haze refraction, and 2-way fluid-solid interaction with draggable obstacles.

---

## Features

### 1. Real-Time Combustion & Fluid Dynamics
- **MacCormack (BFECC) Advection**: Second-order error-corrected advection with local extrema clamping keeps flame fronts, curling tongues, and thin reaction sheets razor-sharp.
- **Coupled Reactive Thermodynamics (`RGBA16F`)**:
  - **Temperature ($T$)**: Driven by exothermic fuel reaction and cooled via Stefan-Boltzmann ($T^4$) radiative heat loss plus convective decay.
  - **Fuel Concentration ($F$)**: Injected at the burner nozzles; ignites where $T > T_{\text{ignition}}$ to release heat and drive thermal gas expansion ($\nabla \cdot \mathbf{u} > 0$) along the flame front.
  - **Soot & Smoke ($S$)**: Formed in fuel-rich reaction zones, partially oxidized in the hottest core, and advected upward as light-absorbing dark carbon smoke.
- **Baroclinic Torque & Vorticity Confinement**: Horizontal density/temperature gradients ($\nabla T \times \mathbf{g}$) naturally generate rotational shear along rising plumes, rolling flame edges into Kelvin-Helmholtz vortices.
- **Planckian Blackbody & Chemical Palettes**:
  - *Blackbody Hydrocarbon* (wood/gas fire with blue $\text{CH}^*$ radical base emission)
  - *Copper Chloride* (emerald/cyan flame)
  - *Lithium / Strontium* (crimson-magenta plasma)
  - *Oxy-Acetylene* (high-temperature cobalt/cyan/white torch)

### 2. Interactive Solid Colliders (Move Objects Through the Flames)
- **Direct Manipulation**: Left-click and drag the collider directly through the fire.
- **Momentum & Wake Coupling**: Moving the collider imparts velocity into the fluid boundary layer and enforces Neumann pressure boundary conditions ($\partial p / \partial n = 0$), splitting flames around the object and shedding turbulent vortex wakes.
- **5 Selectable Collider Shapes**:
  - **Sphere**, **Square Block**, **Wing / Aerofoil Blade**, **Hollow Ring** (flames can pass through the inner cavity and top vent), and **Cross Baffle**.
- **Surface Thermal Heating**: The object's surface dynamically accumulates heat where flames contact it—glowing incandescent red-orange and cooling via radiation when pulled away. Also supports **Cryo / Cold Sink** (quenches flames into thick smoke) and **Superheated Igniter** modes.

### 3. Changeable Backgrounds & Optical Effects
Switch backgrounds on the fly from the top bar to inspect how emission, smoke transmittance, and refraction behave:
1. **Brick Hearth**: Procedural normal-mapped stone masonry dynamically illuminated by the flickering fire centroid.
2. **Optical Grid**: High-contrast calibration grid & checkerboard that highlights real-time **Heat Haze Refraction** ($\nabla T$ optical distortion) and dark smoke occlusion.
3. **Daylight Sky**: Bright sky gradient demonstrating dark carbon soot absorption silhouettes above the bright incandescent flame core.
4. **Dark Void**: Pure dark obsidian studio with floor reflection.
5. **Schlieren Lab**: Optical wind-tunnel refractometry view visualizing refractive index gradients ($\partial T / \partial x, \partial T / \partial y$) and pressure waves.

---

## Controls

| Input | Action |
| :--- | :--- |
| **Left-Click + Drag** | Grab and move the solid object through the flames |
| **Right-Click + Drag** *(or Shift + Drag)* | Blow directional wind gusts into the fire |
| **Mouse Wheel** | Resize the interactive object |
| **Alt + Mouse Wheel** | Rotate the interactive object |

---

## Running Locally

Because PyroGL uses standard scripts with zero build step, you can either open `index.html` directly in any modern WebGL2-capable browser, or serve the folder locally:

```bash
python -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

---

## Project Structure

- `index.html` — Application layout, background switcher bar, and physics control panel.
- `style.css` — Translucent glassmorphism HUD styling.
- `shaders.js` — All WebGL2 GLSL ES 3.00 shaders (Signed Distance Field colliders, MacCormack advection, combustion kinetics, baroclinic curl & vorticity confinement, divergence with thermal expansion, Jacobi pressure solver, embers, and final optical composite).
- `sim.js` — WebGL2 floating-point framebuffer (`EXT_color_buffer_float`) pipeline and particle simulation engine.
- `main.js` — Pointer/touch interaction handlers, UI bindings, and animation loop.
