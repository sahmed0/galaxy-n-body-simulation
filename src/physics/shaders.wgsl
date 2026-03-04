// Copyright (c) 2026 Sajid Ahmed

struct Params {
  gravity: f32,
  dt: f32,
  softening: f32,
  count: f32,
  activeCount: f32,      // Number of heavy particles
  useActivePassive: f32, // 0.0 or 1.0
  theta: f32,
  dmStrength: f32,
  cameraPos: vec2<f32>,
  cameraZoom: f32,
  cameraTilt: f32,
  canvasSize: vec2<f32>,
  dmCoreRadius: f32,
  blackHoleMass: f32,
  blackHoleSoftening: f32,
  pad1: f32,
  pad2: f32,
  pad3: f32,
}

@group(0) @binding(0) var<uniform> params : Params;

struct Particle {
  pos : vec2<f32>,
  vel : vec2<f32>,
}

// We use two buffers for ping-ponging the simulation integration
@group(1) @binding(0) var<storage, read> particlesIn : array<Particle>; 
@group(1) @binding(1) var<storage, read> propsIn : array<vec4<f32>>;     // [mass, r, g, b]
@group(1) @binding(2) var<storage, read_write> particlesOut : array<Particle>; // Write new pos/vel here
@group(1) @binding(3) var<storage, read> particlesRender : array<Particle>; // Read-only for Vertex Shader

@compute @workgroup_size(64)
fn sim_update(@builtin(global_invocation_id) GlobalInvocationID : vec3<u32>) {
  let index = GlobalInvocationID.x;
  
  // 1. Safety Check
  if (index >= u32(params.count)) {
    return;
  }

  // 2. Load My Data
  var pIn = particlesIn[index]; 
  var pos = pIn.pos;
  var vel = pIn.vel;
  var acc = vec2<f32>(0.0, 0.0); // Renamed force to acc (acceleration)

  // 3. Active/Passive Logic
  // CRITICAL: Assumes particles 0 to activeCount are the Heavy ones!
  let limit = select(u32(params.count), u32(params.activeCount), params.useActivePassive > 0.5);

  // 4. Force Loop
  for (var i = 0u; i < limit; i = i + 1u) {
    if (i == index) {
      continue;
    }

    let otherP = particlesIn[i];
    let otherMass = propsIn[i].x;
    
    let d = otherP.pos - pos;
    let distSq = dot(d, d) + params.softening * params.softening;
    
    // Optimization: Use inverseSqrt() (Fast hardware instruction)
    // Formula: F = G * M / dist^2 * (d / dist)
    // Simplify: F = G * M * d / dist^3
    // invDist = 1 / sqrt(distSq)
    // invDistCubed = invDist * invDist * invDist
    
    let invDist = inverseSqrt(distSq);
    let invDistCubed = invDist * invDist * invDist;
    
    let f = params.gravity * otherMass * invDistCubed;
    acc = acc + f * d;
  }

  // 4.5. Central Forces (Dark Matter Halo + Supermassive Black Hole)
  let rawDistSq = dot(pos, pos);

  if (params.dmStrength > 0.0) {
    let aDM_base = (params.dmStrength * params.dmStrength) / (rawDistSq + params.dmCoreRadius * params.dmCoreRadius);
    acc = acc - pos * aDM_base;
  }

  if (params.blackHoleMass > 0.0) {
    let smbhDistSq = rawDistSq + params.blackHoleSoftening * params.blackHoleSoftening;
    let invDistSMBH = inverseSqrt(smbhDistSq);
    let aSMBH_base = (params.gravity * params.blackHoleMass) * (invDistSMBH * invDistSMBH * invDistSMBH);
    acc = acc - pos * aSMBH_base;
  }

  // 5. Integrator (Leapfrog)
  // Maintains orbital stability for large particle bodies without decaying energy limits.
  vel = vel + acc * params.dt;
  pos = pos + vel * params.dt;

  // 6. Store Result
  particlesOut[index] = Particle(pos, vel);
}

// --- Rendering ---

struct VertexOutput {
  @builtin(position) Position : vec4<f32>,
  @location(0) Color : vec4<f32>,
  @location(1) UV : vec2<f32>,
  @location(2) Mass : f32,
}

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex : u32, @builtin(instance_index) instanceIndex : u32) -> VertexOutput {
  // Read position from the 'particlesRender' buffer using instanceIndex
  let p = particlesRender[instanceIndex]; 
  let props = propsIn[instanceIndex];  // [mass, r, g, b]

  var output : VertexOutput;
  
  // Define Quad Vertices (-1 to 1)
  var quad = array<vec2<f32>, 6>(
      vec2<f32>(-1.0, -1.0),
      vec2<f32>( 1.0, -1.0),
      vec2<f32>(-1.0,  1.0),
      vec2<f32>(-1.0,  1.0),
      vec2<f32>( 1.0, -1.0),
      vec2<f32>( 1.0,  1.0)
  );

  let vertexPos = quad[vertexIndex];
  output.UV = vertexPos; // Pass raw quad coords as UVs (-1 to 1) for circle math

  let mass = props.x;
  output.Mass = mass;

  // Determine physical size based on mass (heavy stars are larger)
  // Our threshold for Active stars is 1.0 due to Salpeter IMF.
  var sizeMultiplier: f32 = 1.0; 
  if (mass > 1000000.0) {
      sizeMultiplier = 25.0; // Black hole accretion disk much larger than heavy star (2.0)
  } else if (mass > 1.0) {
      sizeMultiplier = 2.0; // Make heavy stars larger
  } else {
      sizeMultiplier = 1.5;
  }

  // Base size in world units
  var baseSize = 1.0; 

  // Scale quad by camera zoom and multiplier, clamp to prevent fill-rate issues (min: 0.5px, max: 20px)
  let rawSize = baseSize * sizeMultiplier * params.cameraZoom;
  var finalSize = clamp(rawSize, 0.5, 20.0);
  
  if (mass > 1000000.0) {
      // allow black hole to be larger than standard clamp max
      finalSize = clamp(rawSize, 0.5, 250.0); 
  }
  
  // 1. Scale quad corner by final size, then offset by actual world position
  var zoomed_pos = (p.pos - params.cameraPos) * params.cameraZoom;
  zoomed_pos.y = zoomed_pos.y * params.cameraTilt; // Apply cinematic tilt to the world Y-axis
  
  // Apply quad offset (vertexPos is -1 to 1, we want size in pixels / canvasSize)
  // So vertex offset in screen space is vertexPos * finalSize
  let screen_pos = zoomed_pos + (vertexPos * finalSize) + params.canvasSize * 0.5;
  
  // 3. Convert to NDC
  // HTML canvas 0,0 is top-left. WebGPU -1,-1 is bottom-left.
  let ndc = (screen_pos / params.canvasSize) * 2.0 - 1.0;
  
  // We flip NDC Y to match HTML canvas drawing orientation
  output.Position = vec4<f32>(ndc.x, -ndc.y, 0.0, 1.0);
  
  // Create original color (from state buffer)
  output.Color = vec4<f32>(props.y, props.z, props.w, 1.0);
  return output;
}

@fragment
fn fs_main(in: VertexOutput) -> @location(0) vec4<f32> {
  // 1. Circular/Elliptical Mask calculation (UV goes from -1.0 to 1.0 radius)
  var uv = in.UV;
  
  if (in.Mass > 1000000.0) {
      // Make it slightly elliptical (e.g. an accretion disk viewed at an angle)
      uv.y = uv.y * 1.5; 
  }

  let dist = length(uv);
  
  // Discard pixels outside the circle/ellipse to save fillrate and form a perfect shape
  if (dist > 1.0) {
      discard;
  }
  
  // 2. Soft Radial Gradient Glow
  // Fast quadratic falloff: 1.0 at center, 0.0 at edge
  let falloff = 1.0 - (dist * dist);
  
  // 3. Color Logic Based on Mass
  var finalColor = in.Color.rgb;
  var maxAlpha: f32 = 1.0;

  if (in.Mass > 1000000.0) {
      // Central black hole: large white/yellow sphere
      finalColor = vec3<f32>(1.0, 1.0, 0.8);
      maxAlpha = 1.0;
  } else if (in.Mass > 1.0) {
      // Active stars: make them appear whiter/brighter
      // Blend 30% towards pure white
      finalColor = mix(finalColor, vec3<f32>(1.0, 1.0, 1.0), 0.3);
      maxAlpha = 1.0;
  } else {
      // Passive stars: slightly dimmer or blue-shifted
      // Blend 10% towards blue
      finalColor = mix(finalColor, vec3<f32>(0.5, 0.7, 1.0), 0.1); 
      maxAlpha = 1.0; // dim slightly
  }
  
  let alpha = falloff * maxAlpha;

  // Multiply RGB by alpha for premultiplied additive blending
  return vec4<f32>(finalColor * alpha, alpha);
}
