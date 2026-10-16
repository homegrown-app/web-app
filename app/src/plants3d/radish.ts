import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { BokehPass } from 'three/examples/jsm/postprocessing/BokehPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

export type ProceduralModelOptions = {
  wireframe?: boolean;
  castShadow?: boolean;
  receiveShadow?: boolean;
  textureSize?: number;
  textureAnisotropy?: number;
  qualityPriority?: 'reference-fidelity' | 'balanced';
};

export type ProceduralModelRuntime = {
  nodes: Record<string, THREE.Object3D>;
  meshes: Record<string, THREE.Mesh>;
  sockets: Record<string, THREE.Object3D>;
  colliders: Record<string, unknown>;
  destructionGroups: Record<string, THREE.Object3D[]>;
};

type SculptMaterialSpec = Record<string, any>;

function buildLatheGeometry(profile: { points: [number, number][]; segments?: number }): THREE.LatheGeometry {
  const points = profile.points.map(([x, y]) => new THREE.Vector2(Math.max(0.0001, x), y));
  return new THREE.LatheGeometry(points, profile.segments ?? 24);
}

type TaperedStation = { position: [number, number, number]; rx: number; rz: number; twist?: number };

// Frames come from PARALLEL TRANSPORT, not from a Frenet frame. A Frenet frame is defined by
// the curve's normal, which flips sign wherever the path has an inflection or straightens out,
// and every flip twists the surface 180 degrees within one segment. Carrying the previous frame
// forward and removing only its along-path component keeps the twist continuous. THREE's own
// extrudePath and TubeGeometry do not expose this, which is why this is hand-built.
function buildTaperedSweepGeometry(
  sweep: { stations: TaperedStation[]; radialSegments?: number; capEnds?: boolean },
): THREE.BufferGeometry {
  const stations = sweep.stations;
  if (stations.length < 2) throw new Error('tapered-sweep needs at least two stations');
  const radial = Math.max(3, sweep.radialSegments ?? 10);
  const centres = stations.map((s) => new THREE.Vector3(...s.position));

  const tangents = centres.map((_, i) => {
    const prev = centres[Math.max(0, i - 1)];
    const next = centres[Math.min(centres.length - 1, i + 1)];
    const t = next.clone().sub(prev);
    // Coincident neighbours would normalise to NaN and poison every downstream vertex.
    return t.lengthSq() < 1e-12 ? new THREE.Vector3(0, 1, 0) : t.normalize();
  });

  // Seed a reference axis that is not parallel to the first tangent, or the first cross
  // product is degenerate and the whole sweep collapses to a line.
  let ref = new THREE.Vector3(0, 0, 1);
  if (Math.abs(tangents[0].dot(ref)) > 0.9) ref = new THREE.Vector3(1, 0, 0);

  const normals: THREE.Vector3[] = [];
  const binormals: THREE.Vector3[] = [];
  let carried = ref.clone().sub(tangents[0].clone().multiplyScalar(ref.dot(tangents[0]))).normalize();
  for (let i = 0; i < tangents.length; i += 1) {
    const t = tangents[i];
    // Project the carried frame back onto the plane perpendicular to this tangent.
    const n = carried.clone().sub(t.clone().multiplyScalar(carried.dot(t)));
    if (n.lengthSq() < 1e-12) {
      const fallback = Math.abs(t.y) > 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
      n.copy(fallback.sub(t.clone().multiplyScalar(fallback.dot(t))));
    }
    n.normalize();
    normals.push(n);
    binormals.push(new THREE.Vector3().crossVectors(t, n).normalize());
    carried = n;
  }

  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const ringStart: number[] = [];
  const isPoint: boolean[] = [];

  for (let i = 0; i < stations.length; i += 1) {
    const st = stations[i];
    const v = i / (stations.length - 1);
    ringStart.push(positions.length / 3);
    // A station whose section has collapsed emits ONE vertex, not a ring of radius zero.
    // A degenerate ring still carries `radial` coincident vertices and `radial` zero-area
    // triangles, so the lock ends in a blunt cap the width of the floating-point noise
    // rather than at a point -- and a hair lock, a horn or a blade tip has to reach a point.
    if (st.rx <= 1e-6 && st.rz <= 1e-6) {
      isPoint.push(true);
      positions.push(centres[i].x, centres[i].y, centres[i].z);
      uvs.push(0.5, v);
      continue;
    }
    isPoint.push(false);
    const twist = ((st.twist ?? 0) * Math.PI) / 180;
    for (let j = 0; j <= radial; j += 1) {
      const theta = (j / radial) * Math.PI * 2 + twist;
      const offset = normals[i].clone().multiplyScalar(Math.cos(theta) * st.rx)
        .add(binormals[i].clone().multiplyScalar(Math.sin(theta) * st.rz));
      const p = centres[i].clone().add(offset);
      positions.push(p.x, p.y, p.z);
      uvs.push(j / radial, v);
    }
  }

  for (let i = 0; i < stations.length - 1; i += 1) {
    const a0 = ringStart[i];
    const b0 = ringStart[i + 1];
    if (isPoint[i] && isPoint[i + 1]) continue;   // two collapsed stations bound nothing
    for (let j = 0; j < radial; j += 1) {
      // Wound so the face normal points radially OUTWARD.
      //
      // Ring vertices advance from `normal` toward `binormal`, and binormal is
      // tangent x normal, so increasing theta runs counter-clockwise seen from the
      // far end of the segment. Taking the ring-to-ring edge first therefore puts
      // the cross product on the inside. Measured as signed volume on the built
      // mesh: every tapered-sweep came out negative -- a torso at -0.0674 and a
      // tail at -0.0044 against a positive ellipsoid head -- so every sweep this
      // generator has ever emitted rendered its back faces, with normals pointing
      // into the solid and every lighting judgement made on the wrong surface.
      if (isPoint[i]) indices.push(a0, b0 + j + 1, b0 + j);
      else if (isPoint[i + 1]) indices.push(a0 + j, a0 + j + 1, b0);
      else indices.push(a0 + j, a0 + j + 1, b0 + j, a0 + j + 1, b0 + j + 1, b0 + j);
    }
  }

  if (sweep.capEnds ?? true) {
    for (const end of [0, stations.length - 1]) {
      if (isPoint[end]) continue;   // a point end is already closed
      const centreIndex = positions.length / 3;
      positions.push(centres[end].x, centres[end].y, centres[end].z);
      uvs.push(0.5, end === 0 ? 0 : 1);
      const base = ringStart[end];
      for (let j = 0; j < radial; j += 1) {
        if (end === 0) indices.push(centreIndex, base + j + 1, base + j);
        else indices.push(centreIndex, base + j, base + j + 1);
      }
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function readLayerNumber(value: unknown, keys: string[], fallback: number): number {
  if (typeof value === 'number') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    for (const key of keys) {
      if (typeof record[key] === 'number') return record[key] as number;
    }
  }
  return fallback;
}

function hexToRgb(hex: string): [number, number, number] {
  const normalized = /^#[0-9a-f]{3}$/i.test(hex)
    ? '#' + hex.slice(1).split('').map((part) => part + part).join('')
    : hex;
  const value = /^#[0-9a-f]{6}$/i.test(normalized) ? Number.parseInt(normalized.slice(1), 16) : 0x8a7a5f;
  return [clampAlbedoChannel((value >> 16) & 255), clampAlbedoChannel((value >> 8) & 255), clampAlbedoChannel(value & 255)];
}

function materialPalette(spec: SculptMaterialSpec): string[] {
  const palette = spec.colorVariation?.palette;
  if (Array.isArray(palette) && palette.length > 0) return palette.filter((value) => typeof value === 'string');
  const secondary = spec.albedo?.secondary;
  const colors = [spec.baseColor ?? spec.color ?? spec.albedo?.dominant, ...(Array.isArray(secondary) ? secondary : [])];
  return colors.filter((value): value is string => typeof value === 'string' && value.startsWith('#'));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampAlbedoChannel(value: number): number {
  return Math.max(30, Math.min(240, Math.round(value)));
}

function clampPbrF0(value: number): number {
  return Math.max(0.02, Math.min(1, value));
}

function clampPbrIor(value: number): number {
  return Math.max(1, Math.min(2.5, value));
}

function clampPbrMetalness(value: number): number {
  return value >= 0.5 ? 1 : 0;
}

function clampedAlbedoColor(spec: SculptMaterialSpec): THREE.Color {
  const source = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  // setStyle with an explicit SRGBColorSpace, NOT the numeric constructor.
  //
  // `new THREE.Color(r, g, b)` treats its arguments as LINEAR working-space components,
  // while an authored `baseColor` hex is sRGB. Feeding one to the other skipped the
  // transfer function and lifted every dark albedo: #2e2a28, authored as a near-black
  // vinyl, rendered at roughly sRGB 0.46 — a mid grey. The error is largest exactly where
  // it matters most, because the transfer curve is steepest near black.
  return new THREE.Color().setStyle(source, THREE.SRGBColorSpace);
}

function smoothCurve(value: number): number {
  return value * value * (3 - 2 * value);
}

function periodicHash(x: number, y: number, seed: number, periodX: number, periodY: number): number {
  const wrappedX = ((x % periodX) + periodX) % periodX;
  const wrappedY = ((y % periodY) + periodY) % periodY;
  let value = Math.imul(wrappedX + seed * 17, 374761393) ^ Math.imul(wrappedY + seed * 31, 668265263);
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function periodicValueNoise(u: number, v: number, seed: number, periodX: number, periodY: number): number {
  const x = u * periodX;
  const y = v * periodY;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = smoothCurve(x - x0);
  const ty = smoothCurve(y - y0);
  const a = periodicHash(x0, y0, seed, periodX, periodY);
  const b = periodicHash(x0 + 1, y0, seed, periodX, periodY);
  const c = periodicHash(x0, y0 + 1, seed, periodX, periodY);
  const d = periodicHash(x0 + 1, y0 + 1, seed, periodX, periodY);
  return THREE.MathUtils.lerp(THREE.MathUtils.lerp(a, b, tx), THREE.MathUtils.lerp(c, d, tx), ty);
}

type SurfaceBand = {
  frequency: number;
  amplitude: number;
  stretchX: number;
  stretchY: number;
  ridge: boolean;
};

function surfaceBands(spec: SculptMaterialSpec): SurfaceBand[] {
  const source = Array.isArray(spec.surfaceFrequencyBands) ? spec.surfaceFrequencyBands : [];
  const parsed = source.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return [];
    const band = item as Record<string, unknown>;
    const frequency = typeof band.frequency === 'number' ? band.frequency : 0;
    const amplitude = typeof band.amplitude === 'number' ? band.amplitude : 0;
    if (frequency <= 0 || amplitude <= 0) return [];
    const stretch = Array.isArray(band.stretch) ? band.stretch : [1, 1];
    const description = `${String(band.pattern ?? '')} ${String(band.role ?? '')}`.toLowerCase();
    return [{
      frequency,
      amplitude,
      stretchX: typeof stretch[0] === 'number' ? Math.max(0.1, stretch[0]) : 1,
      stretchY: typeof stretch[1] === 'number' ? Math.max(0.1, stretch[1]) : 1,
      ridge: /(ridge|groove|grain|fiber|striated|crack)/.test(description),
    }];
  });
  return parsed.length > 0 ? parsed : [
    { frequency: 2, amplitude: 0.42, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 12, amplitude: 0.22, stretchX: 1, stretchY: 1, ridge: false },
    { frequency: 56, amplitude: 0.08, stretchX: 1, stretchY: 1, ridge: false },
  ];
}

function sampleSurface(u: number, v: number, bands: SurfaceBand[], seed: number): number {
  let value = 0;
  let weight = 0;
  for (let index = 0; index < bands.length; index += 1) {
    const band = bands[index];
    const periodX = Math.max(1, Math.round(band.frequency * band.stretchX));
    const periodY = Math.max(1, Math.round(band.frequency * band.stretchY));
    let sample = periodicValueNoise(u, v, seed + index * 1013, periodX, periodY);
    if (band.ridge) sample = 1 - Math.abs(sample * 2 - 1);
    value += sample * band.amplitude;
    weight += band.amplitude;
  }
  return weight > 0 ? clamp01(value / weight) : 0.5;
}

function mixPalette(colors: [number, number, number][], value: number): [number, number, number] {
  if (colors.length === 1) return colors[0];
  const scaled = clamp01(value) * (colors.length - 1);
  const index = Math.min(colors.length - 2, Math.floor(scaled));
  const mix = scaled - index;
  const a = colors[index];
  const b = colors[index + 1];
  return [
    Math.round(THREE.MathUtils.lerp(a[0], b[0], mix)),
    Math.round(THREE.MathUtils.lerp(a[1], b[1], mix)),
    Math.round(THREE.MathUtils.lerp(a[2], b[2], mix)),
  ];
}

type ColorGradientStop = { offset: number; color: string };
type ColorGradientSpec = {
  type: 'linear' | 'radial';
  axis: [number, number];
  stops: ColorGradientStop[];
};

function parseRgba(value: string): [number, number, number] {
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(value);
  if (!match) return [138, 122, 95];
  return [clampAlbedoChannel(Number(match[1])), clampAlbedoChannel(Number(match[2])), clampAlbedoChannel(Number(match[3]))];
}

// Analytical per-pixel gradient sample. The extraction schema's colorGradient carries
// exact rgba(...) stop colors (see extract_part_color_recipe.py), so this samples the
// same trend directly in JS math rather than round-tripping through a Canvas 2D
// createLinearGradient/createRadialGradient object — same visual result, and it composes
// directly with the existing noise/height-correlated colorVariation blend below.
function sampleColorGradient(gradient: ColorGradientSpec, u: number, v: number): [number, number, number] {
  const stops = gradient.stops.length >= 2 ? gradient.stops : [{ offset: 0, color: 'rgba(138,122,95,1)' }, { offset: 1, color: 'rgba(138,122,95,1)' }];
  let t: number;
  if (gradient.type === 'radial') {
    const [cx, cy] = gradient.axis;
    const dx = u - cx;
    const dy = v - cy;
    const maxRadius = Math.max(0.001, Math.hypot(Math.max(cx, 1 - cx), Math.max(cy, 1 - cy)));
    t = clamp01(Math.hypot(dx, dy) / maxRadius);
  } else {
    const [ax, ay] = gradient.axis;
    const projection = (u - 0.5) * ax + (v - 0.5) * ay;
    const maxProjection = 0.5 * (Math.abs(ax) + Math.abs(ay)) || 0.5;
    t = clamp01(projection / maxProjection + 0.5);
  }
  const scaled = t * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.max(0, Math.floor(scaled)));
  const mix = scaled - index;
  const a = parseRgba(stops[index].color);
  const b = parseRgba(stops[index + 1].color);
  return [
    THREE.MathUtils.lerp(a[0], b[0], mix),
    THREE.MathUtils.lerp(a[1], b[1], mix),
    THREE.MathUtils.lerp(a[2], b[2], mix),
  ];
}

function writePixel(data: Uint8ClampedArray, offset: number, red: number, green: number, blue: number): void {
  data[offset] = Math.max(0, Math.min(255, Math.round(red)));
  data[offset + 1] = Math.max(0, Math.min(255, Math.round(green)));
  data[offset + 2] = Math.max(0, Math.min(255, Math.round(blue)));
  data[offset + 3] = 255;
}

function makeCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function createMapTexture(
  canvas: HTMLCanvasElement,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.CanvasTexture {
  const texture = new THREE.CanvasTexture(canvas);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [2, 2];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 2,
    typeof repeat[1] === 'number' ? repeat[1] : 2,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

type ProceduralTextureSet = {
  albedo: THREE.Texture;
  roughness: THREE.Texture;
  height: THREE.Texture;
  normal: THREE.Texture;
  ao: THREE.Texture;
  source: 'reference-pixel-extraction' | 'procedural';
};

function referenceMapUrl(spec: SculptMaterialSpec, channel: string): string | null {
  const reference = spec.referencePbr;
  if (!reference || typeof reference !== 'object') return null;
  if (reference.usable === false) return null;
  const confidence = typeof reference.confidence === 'number'
    ? reference.confidence
    : (typeof reference.estimatedFidelity === 'number' ? reference.estimatedFidelity : 0);
  const threshold = typeof reference.targetThreshold === 'number' ? reference.targetThreshold : 0.7;
  if (confidence < threshold) return null;
  const maps = reference.maps;
  if (!maps || typeof maps !== 'object') return null;
  const map = (maps as Record<string, unknown>)[channel];
  if (!map || typeof map !== 'object') return null;
  const record = map as Record<string, unknown>;
  const url = typeof record.url === 'string' && record.url.trim() ? record.url : record.path;
  return typeof url === 'string' && url.trim() ? url : null;
}

function createLoadedMapTexture(
  url: string,
  colorSpace: THREE.ColorSpace,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): THREE.Texture {
  const texture = new THREE.TextureLoader().load(url);
  const projection = spec.textureProjection && typeof spec.textureProjection === 'object' ? spec.textureProjection : {};
  const repeat = Array.isArray(projection.repeat) ? projection.repeat : [1, 1];
  texture.colorSpace = colorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(
    typeof repeat[0] === 'number' ? repeat[0] : 1,
    typeof repeat[1] === 'number' ? repeat[1] : 1,
  );
  texture.anisotropy = Math.max(1, Math.round(options.textureAnisotropy ?? projection.anisotropy ?? 8));
  texture.needsUpdate = true;
  return texture;
}

function makeReferenceTextureSet(spec: SculptMaterialSpec, options: ProceduralModelOptions): ProceduralTextureSet | null {
  const albedo = referenceMapUrl(spec, 'albedo');
  const roughness = referenceMapUrl(spec, 'roughness');
  const height = referenceMapUrl(spec, 'height');
  const normal = referenceMapUrl(spec, 'normal');
  const ao = referenceMapUrl(spec, 'ao');
  if (!albedo || !roughness || !height || !normal || !ao) return null;
  return {
    albedo: createLoadedMapTexture(albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createLoadedMapTexture(roughness, THREE.NoColorSpace, spec, options),
    height: createLoadedMapTexture(height, THREE.NoColorSpace, spec, options),
    normal: createLoadedMapTexture(normal, THREE.NoColorSpace, spec, options),
    ao: createLoadedMapTexture(ao, THREE.NoColorSpace, spec, options),
    source: 'reference-pixel-extraction',
  };
}

function makeProceduralTextureSet(
  id: string,
  spec: SculptMaterialSpec,
  options: ProceduralModelOptions,
): ProceduralTextureSet | null {
  if (typeof document === 'undefined') return null;
  const qualityFirst = (options.qualityPriority ?? 'reference-fidelity') === 'reference-fidelity';
  const requested = options.textureSize ?? spec.textureResolution;
  const requestedSize = typeof requested === 'number' && Number.isFinite(requested)
    ? requested
    : (qualityFirst ? 1024 : 512);
  const size = Math.max(256, Math.min(2048, 2 ** Math.round(Math.log2(requestedSize))));
  const canvases = {
    albedo: makeCanvas(size),
    roughness: makeCanvas(size),
    height: makeCanvas(size),
    normal: makeCanvas(size),
    ao: makeCanvas(size),
  };
  const contexts = {
    albedo: canvases.albedo.getContext('2d'),
    roughness: canvases.roughness.getContext('2d'),
    height: canvases.height.getContext('2d'),
    normal: canvases.normal.getContext('2d'),
    ao: canvases.ao.getContext('2d'),
  };
  if (!contexts.albedo || !contexts.roughness || !contexts.height || !contexts.normal || !contexts.ao) return null;
  const images = {
    albedo: contexts.albedo.createImageData(size, size),
    roughness: contexts.roughness.createImageData(size, size),
    height: contexts.height.createImageData(size, size),
    normal: contexts.normal.createImageData(size, size),
    ao: contexts.ao.createImageData(size, size),
  };
  const seed = hashString(id);
  const bands = surfaceBands(spec);
  const heightField = new Float32Array(size * size);
  const roughnessField = new Float32Array(size * size);
  const palette = materialPalette(spec);
  const fallback = typeof spec.baseColor === 'string' ? spec.baseColor : '#8A7A5F';
  const colors = (palette.length >= 2 ? palette : [fallback, '#6E614B', '#A08F70']).map(hexToRgb);
  const baseRoughness = clamp01(readLayerNumber(spec.roughness, ['base'], 0.76));
  const roughnessVariation = clamp01(readLayerNumber(spec.roughness, ['variation'], 0.18));
  const colorAmplitude = clamp01(readLayerNumber(spec.colorVariation, ['amplitude', 'variation'], 0.18));
  const heightCorrelation = clamp01(readLayerNumber(spec.colorVariation, ['heightCorrelation'], 0.3));
  const colorGradient: ColorGradientSpec | undefined = spec.colorGradient;
  for (let y = 0; y < size; y += 1) {
    const v = y / size;
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const index = y * size + x;
      const height = sampleSurface(u, v, bands, seed + 101);
      const roughNoise = sampleSurface(u, v, bands, seed + 7001);
      const colorNoise = sampleSurface(u, v, bands, seed + 15013);
      heightField[index] = height;
      roughnessField[index] = clamp01(baseRoughness + (roughNoise - 0.5) * roughnessVariation * 2);
      let color: [number, number, number];
      if (colorGradient) {
        // Evidence-derived spatial gradient (Plan 1.3 Workstream C) takes priority
        // over the noise-based palette blend below — it is a measured trend, not a guess.
        color = sampleColorGradient(colorGradient, u, v);
      } else {
        const paletteValue = clamp01(
          0.5 + (colorNoise - 0.5) * colorAmplitude * 2 + (height - 0.5) * heightCorrelation
        );
        color = mixPalette(colors, paletteValue);
      }
      writePixel(images.albedo.data, index * 4, color[0], color[1], color[2]);
    }
  }
  const normalStrength = Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35));
  const aoStrength = clamp01(readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35));
  for (let y = 0; y < size; y += 1) {
    const up = ((y - 1 + size) % size) * size;
    const down = ((y + 1) % size) * size;
    for (let x = 0; x < size; x += 1) {
      const left = (x - 1 + size) % size;
      const right = (x + 1) % size;
      const index = y * size + x;
      const center = heightField[index];
      const dx = (heightField[y * size + right] - heightField[y * size + left]) * normalStrength * 6;
      const dy = (heightField[down + x] - heightField[up + x]) * normalStrength * 6;
      const inverseLength = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const normalX = -dx * inverseLength;
      const normalY = -dy * inverseLength;
      const normalZ = inverseLength;
      const neighborAverage = (
        heightField[y * size + left] + heightField[y * size + right]
        + heightField[up + x] + heightField[down + x]
      ) * 0.25;
      const cavity = Math.max(0, neighborAverage - center);
      const ao = clamp01(1 - aoStrength * (cavity * 12 + (1 - center) * 0.16));
      const offset = index * 4;
      const heightByte = center * 255;
      const roughnessByte = roughnessField[index] * 255;
      writePixel(images.height.data, offset, heightByte, heightByte, heightByte);
      writePixel(images.roughness.data, offset, roughnessByte, roughnessByte, roughnessByte);
      writePixel(
        images.normal.data, offset,
        (normalX * 0.5 + 0.5) * 255,
        (normalY * 0.5 + 0.5) * 255,
        (normalZ * 0.5 + 0.5) * 255,
      );
      writePixel(images.ao.data, offset, ao * 255, ao * 255, ao * 255);
    }
  }
  contexts.albedo.putImageData(images.albedo, 0, 0);
  contexts.roughness.putImageData(images.roughness, 0, 0);
  contexts.height.putImageData(images.height, 0, 0);
  contexts.normal.putImageData(images.normal, 0, 0);
  contexts.ao.putImageData(images.ao, 0, 0);
  return {
    albedo: createMapTexture(canvases.albedo, THREE.SRGBColorSpace, spec, options),
    roughness: createMapTexture(canvases.roughness, THREE.NoColorSpace, spec, options),
    height: createMapTexture(canvases.height, THREE.NoColorSpace, spec, options),
    normal: createMapTexture(canvases.normal, THREE.NoColorSpace, spec, options),
    ao: createMapTexture(canvases.ao, THREE.NoColorSpace, spec, options),
    source: 'procedural',
  };
}

function createSculptMaterial(id: string, spec: SculptMaterialSpec, options: ProceduralModelOptions, denseComponent = false): THREE.MeshPhysicalMaterial {
  // A material that declares -- with evidence -- that its subject carries no texture
  // detail gets NO texture set. Synthesising one anyway is not a harmless default: the
  // branch below then forces color to white and roughness to 1 and reads both from the
  // generated maps, so the authored albedo and the reference-derived roughness are both
  // discarded, and the model gains mottling the reference does not have. Measured on the
  // tuxedo cat, whose black fur rendered as speckled grey-and-white from a palette that
  // only ever described two flat regions.
  const textureless = (spec.textureless as { declared?: boolean } | undefined)?.declared === true;
  const textures = textureless
    ? null
    : makeReferenceTextureSet(spec, options) ?? makeProceduralTextureSet(id, spec, options);
  const material = new THREE.MeshPhysicalMaterial({
    color: textures ? 0xffffff : clampedAlbedoColor(spec),
    roughness: textures ? 1 : clamp01(readLayerNumber(spec.roughness, ['base'], 0.76)),
    metalness: clampPbrMetalness(readLayerNumber(spec.metalness, ['base'], 0.0)),
    clearcoat: clamp01(readLayerNumber(spec.clearcoat, ['base', 'amount'], 0)),
    clearcoatRoughness: clamp01(readLayerNumber(spec.clearcoatRoughness, ['base'], 0.25)),
    transmission: clamp01(readLayerNumber(spec.transmission, ['base', 'amount'], 0)),
    ior: clampPbrIor(readLayerNumber(spec.ior, ['base', 'value'], 1.5)),
    thickness: Math.max(0, readLayerNumber(spec.thickness, ['base', 'amount'], 0)),
    attenuationDistance: Math.max(0.001, readLayerNumber(spec.attenuationDistance, ['base', 'value'], Infinity)),
    attenuationColor: new THREE.Color(typeof spec.attenuationColor === 'string' ? spec.attenuationColor : '#ffffff'),
    sheen: clamp01(readLayerNumber(spec.sheen, ['base', 'amount'], 0)),
    sheenColor: new THREE.Color(typeof spec.sheenColor === 'string' ? spec.sheenColor : '#ffffff'),
    sheenRoughness: clamp01(readLayerNumber(spec.sheenRoughness, ['base'], 1.0)),
    iridescence: clamp01(readLayerNumber(spec.iridescence, ['base', 'amount'], 0)),
    iridescenceIOR: clampPbrIor(readLayerNumber(spec.iridescenceIOR, ['base', 'value'], 1.3)),
    anisotropy: clamp01(readLayerNumber(spec.anisotropy, ['base', 'amount'], 0)),
    anisotropyRotation: readLayerNumber(spec.anisotropy, ['rotation'], 0),
    specularIntensity: clampPbrF0(readLayerNumber(spec.specularF0 ?? spec.f0 ?? spec.specularIntensity, ['base', 'value'], 1.0)),
    specularColor: new THREE.Color(typeof spec.specularColor === 'string' ? spec.specularColor : '#ffffff'),
    emissive: new THREE.Color(typeof spec.emissive === 'string' ? spec.emissive : '#000000'),
    emissiveIntensity: Math.max(0, readLayerNumber(spec.emissiveIntensity, ['base'], 1.0)),
    opacity: clamp01(readLayerNumber(spec.opacity, ['base'], 1)),
    transparent: readLayerNumber(spec.transmission, ['base', 'amount'], 0) > 0 || readLayerNumber(spec.opacity, ['base'], 1) < 1,
    alphaTest: Math.max(0, readLayerNumber(spec.alpha, ['cutoff', 'alphaTest'], 0)),
    wireframe: options.wireframe ?? false,
    side: spec.doubleSided === true ? THREE.DoubleSide : THREE.FrontSide,
    flatShading: spec.flatShading === true,
  });
  if (textures) {
    material.map = textures.albedo;
    material.roughnessMap = textures.roughness;
    material.normalMap = textures.normal;
    material.normalScale.setScalar(Math.max(0.05, readLayerNumber(spec.normal, ['strength', 'amplitude'], 0.35)));
    material.aoMap = textures.ao;
    material.aoMap.channel = 0;
    material.aoMapIntensity = readLayerNumber(spec.ambientOcclusion, ['cavityStrength', 'strength'], 0.35);
    const denseMesh = denseComponent || spec.denseMesh === true || spec.geometryDensity === 'dense' || spec.topologyClass === 'dense';
    const bumpScale = Math.max(0, readLayerNumber(spec.bump, ['amplitude', 'strength'], 0));
    const effectiveBumpScale = denseMesh ? Math.max(0.05, bumpScale) : bumpScale;
    if (effectiveBumpScale > 0) {
      material.bumpMap = textures.height;
      material.bumpScale = effectiveBumpScale;
    }
    const displacementScale = Math.max(0, readLayerNumber(spec.displacement, ['amplitude', 'strength'], 0));
    const effectiveDisplacementScale = denseMesh ? Math.max(0.005, displacementScale) : displacementScale;
    if (effectiveDisplacementScale > 0) {
      material.displacementMap = textures.height;
      material.displacementScale = effectiveDisplacementScale;
      material.displacementBias = -effectiveDisplacementScale * 0.5;
    }
  }
  material.envMapIntensity = readLayerNumber(spec, ['envMapIntensity'], 0.8);
  material.userData.sculptMaterial = spec;
  material.userData.proceduralMapsIndependent = true;
  material.userData.pbrConstraints = { albedoRange: [30, 240], binaryMetalness: true, f0Range: [0.02, 1], iorRange: [1, 2.5] };
  material.userData.pbrTextureSource = textures?.source ?? 'flat-fallback';
  material.userData.referencePbr = spec.referencePbr ?? null;
  material.userData.referenceMaterialId = spec.referenceMaterialId ?? spec.materialReference?.profileId ?? null;
  material.userData.materialEvidence = spec.materialEvidence ?? null;
  material.userData.validationViews = spec.materialReference?.validationViews ?? [];
  material.needsUpdate = true;
  return material;
}

type AttachmentEndpoint = {
  start: THREE.Vector3;
  midpoint: THREE.Vector3;
  quaternion: THREE.Quaternion;
  length: number;
  baseRadius: number;
  endRadius: number;
};

function readVector3(value: unknown, fallback: [number, number, number]): THREE.Vector3 {
  if (Array.isArray(value) && value.length === 3 && value.every((item) => typeof item === 'number')) {
    return new THREE.Vector3(value[0], value[1], value[2]);
  }
  return new THREE.Vector3(fallback[0], fallback[1], fallback[2]);
}

function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function makeAttachmentEndpoint(attachment: unknown): AttachmentEndpoint | null {
  if (!attachment || typeof attachment !== 'object') return null;
  const record = attachment as Record<string, unknown>;
  const start = readVector3(record.localStart, [0, 0, 0]);
  const end = readVector3(record.localEnd, [0, 1, 0]);
  const delta = end.clone().sub(start);
  const length = delta.length();
  if (length <= 0.0001) return null;
  const direction = delta.clone().normalize();
  const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);
  const baseRadius = Math.max(0.005, readNumber(record.baseRadius, 0.06));
  const endRadius = Math.max(0.003, readNumber(record.endRadius, baseRadius * 0.55));
  return {
    start,
    midpoint: delta.multiplyScalar(0.5),
    quaternion,
    length,
    baseRadius,
    endRadius,
  };
}

// Generated from ObjectSculptSpec target: Radish plant
// Sculpt build pass: optimization-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createRadishPlantModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Radish plant";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["root"] = createSculptMaterial(
    "root",
    {"id": "root", "name": "Radish root skin (glossy)", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#D7263D", "color": "#D7263D", "albedo": {"dominant": "#D7263D", "secondary": ["#7A0E18", "#E0505A"], "samplingNotes": "Sampled from reference regions; see image-analysis.md L6."}, "colorVariation": {"palette": ["#D7263D"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.25, "variation": 0.08, "map": "independent-procedural-field", "localResponse": "satin on lit faces, rougher toward margins"}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "root-highlight", "region": "upper-left of the globe", "effect": "roughness 0.15 hotspot", "evidenceRefs": ["full-object"]}, {"id": "pale-tip", "region": "bottom toward the taproot", "effect": "albedo #E8C8C8", "evidenceRefs": ["full-object"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "doubleSided": false, "flatShading": true, "clearcoat": {"base": 0.35, "variation": 0.0}, "textureless": {"declared": true, "evidence": ["Style target is the host scene: Kenney Nature Kit models in Garden3D.tsx are flat-shaded solid-colour materials with no texture maps (measured: no map/normalMap on any Kenney material after GLTFLoader).", "User directive 2026-10-08: match the scene style (bigger, simpler, fewer details)."]}},
    options
  );
  materialMap["leaf"] = createSculptMaterial(
    "leaf",
    {"id": "leaf", "name": "Radish leaf (matte, rugose)", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#3FA34D", "color": "#3FA34D", "albedo": {"dominant": "#3FA34D", "secondary": ["#2F5A25", "#6FA554"], "samplingNotes": "Sampled from reference regions; see image-analysis.md L6."}, "colorVariation": {"palette": ["#3FA34D"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.65, "variation": 0.08, "map": "independent-procedural-field", "localResponse": "satin on lit faces, rougher toward margins"}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "rugose", "region": "blade surface", "effect": "normal strength 0.45, vein relief", "evidenceRefs": ["full-object"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "doubleSided": true, "flatShading": true, "textureless": {"declared": true, "evidence": ["Style target is the host scene: Kenney Nature Kit models in Garden3D.tsx are flat-shaded solid-colour materials with no texture maps (measured: no map/normalMap on any Kenney material after GLTFLoader).", "User directive 2026-10-08: match the scene style (bigger, simpler, fewer details)."]}},
    options
  );
  materialMap["soil"] = createSculptMaterial(
    "soil",
    {"id": "soil", "name": "Potting soil (matte, granular)", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#3B2A20", "color": "#3B2A20", "albedo": {"dominant": "#3B2A20", "secondary": ["#3A281C", "#C9A57A"], "samplingNotes": "Sampled from reference regions; see image-analysis.md L6."}, "colorVariation": {"palette": ["#3B2A20"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.95, "variation": 0.08, "map": "independent-procedural-field", "localResponse": "satin on lit faces, rougher toward margins"}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "perlite-flecks", "region": "soil top surface", "effect": "pale beige flecks ~15% coverage", "evidenceRefs": ["full-object"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "doubleSided": false, "flatShading": true, "textureless": {"declared": true, "evidence": ["Style target is the host scene: Kenney Nature Kit models in Garden3D.tsx are flat-shaded solid-colour materials with no texture maps (measured: no map/normalMap on any Kenney material after GLTFLoader).", "User directive 2026-10-08: match the scene style (bigger, simpler, fewer details)."]}},
    options
  );

  const nodes: Record<string, THREE.Object3D> = { root };
  const meshes: Record<string, THREE.Mesh> = {};
  const sockets: Record<string, THREE.Object3D> = {};
  const colliders: Record<string, unknown> = {};
  const destructionGroups: Record<string, THREE.Object3D[]> = {};

  const attachment_soil_disc_0 = null;
  const endpoint_soil_disc_0 = makeAttachmentEndpoint(attachment_soil_disc_0);
  const node_soil_disc_0 = new THREE.Group();
  node_soil_disc_0.name = "Soil disc__pivot";
  node_soil_disc_0.scale.set(1, 1, 1);
  if (endpoint_soil_disc_0) {
    node_soil_disc_0.position.copy(endpoint_soil_disc_0.start);
    node_soil_disc_0.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_soil_disc_0.position.set(0.0, -0.03, 0.0);
    node_soil_disc_0.rotation.set(0.0, 0.0, 0.0);
  }
  node_soil_disc_0.userData.sculptComponent = {"id": "soil-disc", "name": "Soil disc", "level": "macro", "role": "base", "importance": 0.5, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Flat soil disc the root sits in; seats into any host pot.", "geometryDescriptor": {"topologyIntent": "Flat soil disc the root sits in; seats into any host pot. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 0.92, "height": 0.06, "depth": 0.92, "units": "relative", "confidence": 0.6}, "transform": {"position": [0, -0.03, 0], "rotation": [0, 0, 0], "scale": [0.92, 0.06, 0.92]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soil-disc", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "soil", "materialLayers": ["soil"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "perlite-flecks", "kind": "stain", "description": "pale flecks", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.95, "microRoughness": 0.2, "bumpAmplitude": 0.02, "normalPattern": "granular crumbs", "displacementPattern": "", "occlusionPattern": "contact AO around the root", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 28, 20, 1.0)", "secondaryAlbedo": "rgba(58, 40, 28, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_soil_disc_0.userData.actionProfile = {"animationRole": "root", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soil-disc", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root"] ?? root).add(node_soil_disc_0);
  nodes["soil-disc"] = node_soil_disc_0;
  const mesh_soil_disc_0Geometry = endpoint_soil_disc_0
    ? new THREE.CylinderGeometry(endpoint_soil_disc_0.endRadius, endpoint_soil_disc_0.baseRadius, endpoint_soil_disc_0.length, 8, 4)
    : new THREE.CylinderGeometry(0.5, 0.5, 1, 10, 4);
  if (!endpoint_soil_disc_0) {
    mesh_soil_disc_0Geometry.scale(0.92, 0.06, 0.92);
  }
  const mesh_soil_disc_0 = new THREE.Mesh(
    mesh_soil_disc_0Geometry,
    materialMap["soil"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_soil_disc_0.name = "Soil disc";
  if (endpoint_soil_disc_0) {
    mesh_soil_disc_0.position.copy(endpoint_soil_disc_0.midpoint);
    mesh_soil_disc_0.quaternion.copy(endpoint_soil_disc_0.quaternion);
  }
  mesh_soil_disc_0.castShadow = options.castShadow ?? true;
  mesh_soil_disc_0.receiveShadow = options.receiveShadow ?? true;
  mesh_soil_disc_0.userData.sculptComponent = {"id": "soil-disc", "name": "Soil disc", "level": "macro", "role": "base", "importance": 0.5, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Flat soil disc the root sits in; seats into any host pot.", "geometryDescriptor": {"topologyIntent": "Flat soil disc the root sits in; seats into any host pot. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 0.92, "height": 0.06, "depth": 0.92, "units": "relative", "confidence": 0.6}, "transform": {"position": [0, -0.03, 0], "rotation": [0, 0, 0], "scale": [0.92, 0.06, 0.92]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soil-disc", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "soil", "materialLayers": ["soil"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "perlite-flecks", "kind": "stain", "description": "pale flecks", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.95, "microRoughness": 0.2, "bumpAmplitude": 0.02, "normalPattern": "granular crumbs", "displacementPattern": "", "occlusionPattern": "contact AO around the root", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 28, 20, 1.0)", "secondaryAlbedo": "rgba(58, 40, 28, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_soil_disc_0.add(mesh_soil_disc_0);
  meshes["soil-disc"] = mesh_soil_disc_0;
  colliders["soil-disc"] = {"type": "cylinder", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["soil-disc"] ??= [];
  destructionGroups["soil-disc"].push(node_soil_disc_0);

  const endpoint_root_globe_1 = makeAttachmentEndpoint(null);
  const node_root_globe_1 = new THREE.Group();
  node_root_globe_1.name = "Root globe__pivot";
  node_root_globe_1.scale.set(1, 1, 1);
  if (endpoint_root_globe_1) {
    node_root_globe_1.position.copy(endpoint_root_globe_1.start);
    node_root_globe_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_root_globe_1.position.set(0.0, 0.03, 0.0);
    node_root_globe_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_root_globe_1.userData.sculptComponent = {"id": "root-globe", "name": "Root globe", "level": "macro", "role": "root", "importance": 0.95, "confidence": 0.75, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "Slightly oblate crimson globe, ~45% below the soil line.", "geometryDescriptor": {"topologyIntent": "Slightly oblate crimson globe, ~45% below the soil line. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.0, -0.13], [0.04, -0.11], [0.09, -0.07], [0.125, -0.01], [0.13, 0.03], [0.12, 0.08], [0.08, 0.112], [0.03, 0.127], [0.0, 0.13]], "segments": 8}}, "parent": "soil-disc", "attachment": {"parentId": "soil-disc", "parentSocket": "soil-disc:node", "localStart": [0, -0.1, 0], "localEnd": [0, 0.16, 0], "contactType": "embed", "embedDepth": 0.11, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.26, "height": 0.26, "depth": 0.26, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0.03, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root-globe", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "root", "materialLayers": ["root"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "globe", "kind": "bevel", "description": "oblate globe widest above the middle", "evidenceRefs": ["full-object"]}, {"id": "crown", "kind": "fastener", "description": "petioles emerge from the crown", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.05, "bumpAmplitude": 0.004, "normalPattern": "smooth waxy skin, faint lenticel bands", "displacementPattern": "", "occlusionPattern": "AO at the crown where petioles emerge and at the soil line", "edgeWearPattern": "", "notes": "glossy crimson skin"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(196, 24, 42, 1.0)", "secondaryAlbedo": "rgba(122, 14, 24, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_root_globe_1.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root-globe", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["soil-disc"] ?? root).add(node_root_globe_1);
  nodes["root-globe"] = node_root_globe_1;
  const mesh_root_globe_1Geometry = endpoint_root_globe_1
    ? new THREE.CylinderGeometry(endpoint_root_globe_1.endRadius, endpoint_root_globe_1.baseRadius, endpoint_root_globe_1.length, 8, 4)
    : buildLatheGeometry({"points": [[0.0, -0.13], [0.04, -0.11], [0.09, -0.07], [0.125, -0.01], [0.13, 0.03], [0.12, 0.08], [0.08, 0.112], [0.03, 0.127], [0.0, 0.13]], "segments": 8});
  if (!endpoint_root_globe_1) {
    mesh_root_globe_1Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_root_globe_1 = new THREE.Mesh(
    mesh_root_globe_1Geometry,
    materialMap["root"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_root_globe_1.name = "Root globe";
  if (endpoint_root_globe_1) {
    mesh_root_globe_1.position.copy(endpoint_root_globe_1.midpoint);
    mesh_root_globe_1.quaternion.copy(endpoint_root_globe_1.quaternion);
  }
  mesh_root_globe_1.castShadow = options.castShadow ?? true;
  mesh_root_globe_1.receiveShadow = options.receiveShadow ?? true;
  mesh_root_globe_1.userData.sculptComponent = {"id": "root-globe", "name": "Root globe", "level": "macro", "role": "root", "importance": 0.95, "confidence": 0.75, "primitive": "lathe", "topologyClass": "continuous-sculpt", "topologyRationale": "Slightly oblate crimson globe, ~45% below the soil line.", "geometryDescriptor": {"topologyIntent": "Slightly oblate crimson globe, ~45% below the soil line. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "latheProfile": {"points": [[0.0, -0.13], [0.04, -0.11], [0.09, -0.07], [0.125, -0.01], [0.13, 0.03], [0.12, 0.08], [0.08, 0.112], [0.03, 0.127], [0.0, 0.13]], "segments": 8}}, "parent": "soil-disc", "attachment": {"parentId": "soil-disc", "parentSocket": "soil-disc:node", "localStart": [0, -0.1, 0], "localEnd": [0, 0.16, 0], "contactType": "embed", "embedDepth": 0.11, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.26, "height": 0.26, "depth": 0.26, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, 0.03, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "root-globe", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "root", "materialLayers": ["root"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "globe", "kind": "bevel", "description": "oblate globe widest above the middle", "evidenceRefs": ["full-object"]}, {"id": "crown", "kind": "fastener", "description": "petioles emerge from the crown", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.35, "microRoughness": 0.05, "bumpAmplitude": 0.004, "normalPattern": "smooth waxy skin, faint lenticel bands", "displacementPattern": "", "occlusionPattern": "AO at the crown where petioles emerge and at the soil line", "edgeWearPattern": "", "notes": "glossy crimson skin"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(196, 24, 42, 1.0)", "secondaryAlbedo": "rgba(122, 14, 24, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_root_globe_1.add(mesh_root_globe_1);
  meshes["root-globe"] = mesh_root_globe_1;
  colliders["root-globe"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["root-globe"] ??= [];
  destructionGroups["root-globe"].push(node_root_globe_1);

  const endpoint_leaf_0_2 = makeAttachmentEndpoint(null);
  const node_leaf_0_2 = new THREE.Group();
  node_leaf_0_2.name = "Leaf 1__pivot";
  node_leaf_0_2.scale.set(1, 1, 1);
  if (endpoint_leaf_0_2) {
    node_leaf_0_2.position.copy(endpoint_leaf_0_2.start);
    node_leaf_0_2.rotation.set(0.0, -0.1222, 0.0);
  } else {
    node_leaf_0_2.position.set(0.0149, 0.125, 0.0018);
    node_leaf_0_2.rotation.set(0.0, -0.1222, 0.0);
  }
  node_leaf_0_2.userData.sculptComponent = {"id": "leaf-0", "name": "Leaf 1", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Long channelled petiole rising steeply from the crown into a lyrate blade that opens and droops.", "geometryDescriptor": {"topologyIntent": "Long channelled petiole rising steeply from the crown into a lyrate blade that opens and droops. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0126, "rz": 0.0198, "twist": 0}, {"position": [0.2646, 0.594, 0.0], "rx": 0.0088, "rz": 0.0088, "twist": 0}, {"position": [0.3, 0.6125, 0.0], "rx": 0.0055, "rz": 0.003, "twist": -20}, {"position": [0.36, 0.6349, 0.0], "rx": 0.0516, "rz": 0.0155, "twist": -20}, {"position": [0.42, 0.6376, 0.0], "rx": 0.1015, "rz": 0.0306, "twist": -20}, {"position": [0.48, 0.6207, 0.0], "rx": 0.1349, "rz": 0.0405, "twist": -20}, {"position": [0.54, 0.5842, 0.0], "rx": 0.1159, "rz": 0.0347, "twist": -20}, {"position": [0.6, 0.528, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false}}, "parent": "root-globe", "attachment": {"parentId": "root-globe", "parentSocket": "root-globe:node", "localStart": [0.0149, 0.125, 0.0018], "localEnd": [0.6104, 0.653, 0.0749], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0149, 0.125, 0.0018], "rotation": [0, -0.1222, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "petiole", "kind": "linework", "description": "long pale channelled petiole", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "blade opens and droops", "evidenceRefs": ["full-object"]}, {"id": "lateral-lobe", "kind": "contour", "description": "lyrate blade with lateral lobes", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.65, "microRoughness": 0.1, "bumpAmplitude": 0.012, "normalPattern": "rugose blade with pinnate veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker where the blade meets the petiole", "edgeWearPattern": "", "notes": "matte rugose leaf"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(79, 138, 58, 1.0)", "secondaryAlbedo": "rgba(47, 90, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_0_2.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root-globe"] ?? root).add(node_leaf_0_2);
  nodes["leaf-0"] = node_leaf_0_2;
  const mesh_leaf_0_2Geometry = endpoint_leaf_0_2
    ? new THREE.CylinderGeometry(endpoint_leaf_0_2.endRadius, endpoint_leaf_0_2.baseRadius, endpoint_leaf_0_2.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0126, "rz": 0.0198, "twist": 0}, {"position": [0.2646, 0.594, 0.0], "rx": 0.0088, "rz": 0.0088, "twist": 0}, {"position": [0.3, 0.6125, 0.0], "rx": 0.0055, "rz": 0.003, "twist": -20}, {"position": [0.36, 0.6349, 0.0], "rx": 0.0516, "rz": 0.0155, "twist": -20}, {"position": [0.42, 0.6376, 0.0], "rx": 0.1015, "rz": 0.0306, "twist": -20}, {"position": [0.48, 0.6207, 0.0], "rx": 0.1349, "rz": 0.0405, "twist": -20}, {"position": [0.54, 0.5842, 0.0], "rx": 0.1159, "rz": 0.0347, "twist": -20}, {"position": [0.6, 0.528, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaf_0_2) {
    mesh_leaf_0_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaf_0_2 = new THREE.Mesh(
    mesh_leaf_0_2Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaf_0_2.name = "Leaf 1";
  if (endpoint_leaf_0_2) {
    mesh_leaf_0_2.position.copy(endpoint_leaf_0_2.midpoint);
    mesh_leaf_0_2.quaternion.copy(endpoint_leaf_0_2.quaternion);
  }
  mesh_leaf_0_2.castShadow = options.castShadow ?? true;
  mesh_leaf_0_2.receiveShadow = options.receiveShadow ?? true;
  mesh_leaf_0_2.userData.sculptComponent = {"id": "leaf-0", "name": "Leaf 1", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Long channelled petiole rising steeply from the crown into a lyrate blade that opens and droops.", "geometryDescriptor": {"topologyIntent": "Long channelled petiole rising steeply from the crown into a lyrate blade that opens and droops. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0126, "rz": 0.0198, "twist": 0}, {"position": [0.2646, 0.594, 0.0], "rx": 0.0088, "rz": 0.0088, "twist": 0}, {"position": [0.3, 0.6125, 0.0], "rx": 0.0055, "rz": 0.003, "twist": -20}, {"position": [0.36, 0.6349, 0.0], "rx": 0.0516, "rz": 0.0155, "twist": -20}, {"position": [0.42, 0.6376, 0.0], "rx": 0.1015, "rz": 0.0306, "twist": -20}, {"position": [0.48, 0.6207, 0.0], "rx": 0.1349, "rz": 0.0405, "twist": -20}, {"position": [0.54, 0.5842, 0.0], "rx": 0.1159, "rz": 0.0347, "twist": -20}, {"position": [0.6, 0.528, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false}}, "parent": "root-globe", "attachment": {"parentId": "root-globe", "parentSocket": "root-globe:node", "localStart": [0.0149, 0.125, 0.0018], "localEnd": [0.6104, 0.653, 0.0749], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0149, 0.125, 0.0018], "rotation": [0, -0.1222, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "petiole", "kind": "linework", "description": "long pale channelled petiole", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "blade opens and droops", "evidenceRefs": ["full-object"]}, {"id": "lateral-lobe", "kind": "contour", "description": "lyrate blade with lateral lobes", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.65, "microRoughness": 0.1, "bumpAmplitude": 0.012, "normalPattern": "rugose blade with pinnate veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker where the blade meets the petiole", "edgeWearPattern": "", "notes": "matte rugose leaf"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(79, 138, 58, 1.0)", "secondaryAlbedo": "rgba(47, 90, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_0_2.add(mesh_leaf_0_2);
  meshes["leaf-0"] = mesh_leaf_0_2;
  colliders["leaf-0"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaf-0"] ??= [];
  destructionGroups["leaf-0"].push(node_leaf_0_2);

  const endpoint_lobe_00_3 = makeAttachmentEndpoint(null);
  const node_lobe_00_3 = new THREE.Group();
  node_lobe_00_3.name = "Leaf 1 lateral lobe L__pivot";
  node_lobe_00_3.scale.set(1, 1, 1);
  if (endpoint_lobe_00_3) {
    node_lobe_00_3.position.copy(endpoint_lobe_00_3.start);
    node_lobe_00_3.rotation.set(0.0, -1.309, 0.0);
  } else {
    node_lobe_00_3.position.set(0.1944, 0.4277, 0.0);
    node_lobe_00_3.rotation.set(0.0, -1.309, 0.0);
  }
  node_lobe_00_3.userData.sculptComponent = {"id": "lobe-00", "name": "Leaf 1 lateral lobe L", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Small lateral lobe of the lyrate leaf on the upper petiole.", "geometryDescriptor": {"topologyIntent": "Small lateral lobe of the lyrate leaf on the upper petiole. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.004, "rz": 0.004, "twist": 0}, {"position": [0.0176, 0.0086, 0.0], "rx": 0.0032, "rz": 0.0032, "twist": 0}, {"position": [0.0273, 0.0134, 0.0], "rx": 0.0144, "rz": 0.012, "twist": -20}, {"position": [0.0458, 0.0185, 0.0], "rx": 0.0409, "rz": 0.0122, "twist": -20}, {"position": [0.0644, 0.0175, 0.0], "rx": 0.0436, "rz": 0.0131, "twist": -20}, {"position": [0.0829, 0.0104, 0.0], "rx": 0.0365, "rz": 0.012, "twist": -20}, {"position": [0.1015, -0.0027, 0.0], "rx": 0.0223, "rz": 0.012, "twist": -20}, {"position": [0.12, -0.022, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false}}, "parent": "leaf-0", "attachment": {"parentId": "leaf-0", "parentSocket": "leaf-0:node", "localStart": [0.1944, 0.4277, 0.0], "localEnd": [0.2255, 0.4057, 0.1159], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.1944, 0.4277, 0.0], "rotation": [0, -1.309, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lobe-00", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(79, 138, 58, 1.0)", "secondaryAlbedo": "rgba(47, 90, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_lobe_00_3.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lobe-00", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["leaf-0"] ?? root).add(node_lobe_00_3);
  nodes["lobe-00"] = node_lobe_00_3;
  const mesh_lobe_00_3Geometry = endpoint_lobe_00_3
    ? new THREE.CylinderGeometry(endpoint_lobe_00_3.endRadius, endpoint_lobe_00_3.baseRadius, endpoint_lobe_00_3.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.004, "rz": 0.004, "twist": 0}, {"position": [0.0176, 0.0086, 0.0], "rx": 0.0032, "rz": 0.0032, "twist": 0}, {"position": [0.0273, 0.0134, 0.0], "rx": 0.0144, "rz": 0.012, "twist": -20}, {"position": [0.0458, 0.0185, 0.0], "rx": 0.0409, "rz": 0.0122, "twist": -20}, {"position": [0.0644, 0.0175, 0.0], "rx": 0.0436, "rz": 0.0131, "twist": -20}, {"position": [0.0829, 0.0104, 0.0], "rx": 0.0365, "rz": 0.012, "twist": -20}, {"position": [0.1015, -0.0027, 0.0], "rx": 0.0223, "rz": 0.012, "twist": -20}, {"position": [0.12, -0.022, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_lobe_00_3) {
    mesh_lobe_00_3Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_lobe_00_3 = new THREE.Mesh(
    mesh_lobe_00_3Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lobe_00_3.name = "Leaf 1 lateral lobe L";
  if (endpoint_lobe_00_3) {
    mesh_lobe_00_3.position.copy(endpoint_lobe_00_3.midpoint);
    mesh_lobe_00_3.quaternion.copy(endpoint_lobe_00_3.quaternion);
  }
  mesh_lobe_00_3.castShadow = options.castShadow ?? true;
  mesh_lobe_00_3.receiveShadow = options.receiveShadow ?? true;
  mesh_lobe_00_3.userData.sculptComponent = {"id": "lobe-00", "name": "Leaf 1 lateral lobe L", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Small lateral lobe of the lyrate leaf on the upper petiole.", "geometryDescriptor": {"topologyIntent": "Small lateral lobe of the lyrate leaf on the upper petiole. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.004, "rz": 0.004, "twist": 0}, {"position": [0.0176, 0.0086, 0.0], "rx": 0.0032, "rz": 0.0032, "twist": 0}, {"position": [0.0273, 0.0134, 0.0], "rx": 0.0144, "rz": 0.012, "twist": -20}, {"position": [0.0458, 0.0185, 0.0], "rx": 0.0409, "rz": 0.0122, "twist": -20}, {"position": [0.0644, 0.0175, 0.0], "rx": 0.0436, "rz": 0.0131, "twist": -20}, {"position": [0.0829, 0.0104, 0.0], "rx": 0.0365, "rz": 0.012, "twist": -20}, {"position": [0.1015, -0.0027, 0.0], "rx": 0.0223, "rz": 0.012, "twist": -20}, {"position": [0.12, -0.022, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false}}, "parent": "leaf-0", "attachment": {"parentId": "leaf-0", "parentSocket": "leaf-0:node", "localStart": [0.1944, 0.4277, 0.0], "localEnd": [0.2255, 0.4057, 0.1159], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.1944, 0.4277, 0.0], "rotation": [0, -1.309, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lobe-00", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(79, 138, 58, 1.0)", "secondaryAlbedo": "rgba(47, 90, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_lobe_00_3.add(mesh_lobe_00_3);
  meshes["lobe-00"] = mesh_lobe_00_3;
  colliders["lobe-00"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["lobe-00"] ??= [];
  destructionGroups["lobe-00"].push(node_lobe_00_3);

  const endpoint_leaf_1_4 = makeAttachmentEndpoint(null);
  const node_leaf_1_4 = new THREE.Group();
  node_leaf_1_4.name = "Leaf 2__pivot";
  node_leaf_1_4.scale.set(1, 1, 1);
  if (endpoint_leaf_1_4) {
    node_leaf_1_4.position.copy(endpoint_leaf_1_4.start);
    node_leaf_1_4.rotation.set(0.0, 1.2392, 0.0);
  } else {
    node_leaf_1_4.position.set(0.0049, 0.125, -0.0142);
    node_leaf_1_4.rotation.set(0.0, 1.2392, 0.0);
  }
  node_leaf_1_4.userData.sculptComponent = {"id": "leaf-1", "name": "Leaf 2", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Long channelled petiole rising steeply from the crown into a lyrate blade that opens and droops.", "geometryDescriptor": {"topologyIntent": "Long channelled petiole rising steeply from the crown into a lyrate blade that opens and droops. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0126, "rz": 0.0198, "twist": 0}, {"position": [0.2952, 0.6627, 0.0], "rx": 0.0088, "rz": 0.0088, "twist": 0}, {"position": [0.3347, 0.6834, 0.0], "rx": 0.0061, "rz": 0.003, "twist": 20}, {"position": [0.4016, 0.7084, 0.0], "rx": 0.0577, "rz": 0.0173, "twist": 20}, {"position": [0.4686, 0.7114, 0.0], "rx": 0.1133, "rz": 0.034, "twist": 20}, {"position": [0.5355, 0.6925, 0.0], "rx": 0.1505, "rz": 0.0452, "twist": 20}, {"position": [0.6025, 0.6518, 0.0], "rx": 0.1293, "rz": 0.0389, "twist": 20}, {"position": [0.6694, 0.5891, 0.0], "rx": 0.0, "rz": 0.0, "twist": 20}], "radialSegments": 4, "capEnds": false}}, "parent": "root-globe", "attachment": {"parentId": "root-globe", "parentSocket": "root-globe:node", "localStart": [0.0049, 0.125, -0.0142], "localEnd": [0.2228, 0.7141, -0.6471], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0049, 0.125, -0.0142], "rotation": [0, 1.2392, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "petiole", "kind": "linework", "description": "long pale channelled petiole", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "blade opens and droops", "evidenceRefs": ["full-object"]}, {"id": "lateral-lobe", "kind": "contour", "description": "lyrate blade with lateral lobes", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.65, "microRoughness": 0.1, "bumpAmplitude": 0.012, "normalPattern": "rugose blade with pinnate veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker where the blade meets the petiole", "edgeWearPattern": "", "notes": "matte rugose leaf"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(79, 138, 58, 1.0)", "secondaryAlbedo": "rgba(47, 90, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_1_4.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root-globe"] ?? root).add(node_leaf_1_4);
  nodes["leaf-1"] = node_leaf_1_4;
  const mesh_leaf_1_4Geometry = endpoint_leaf_1_4
    ? new THREE.CylinderGeometry(endpoint_leaf_1_4.endRadius, endpoint_leaf_1_4.baseRadius, endpoint_leaf_1_4.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0126, "rz": 0.0198, "twist": 0}, {"position": [0.2952, 0.6627, 0.0], "rx": 0.0088, "rz": 0.0088, "twist": 0}, {"position": [0.3347, 0.6834, 0.0], "rx": 0.0061, "rz": 0.003, "twist": 20}, {"position": [0.4016, 0.7084, 0.0], "rx": 0.0577, "rz": 0.0173, "twist": 20}, {"position": [0.4686, 0.7114, 0.0], "rx": 0.1133, "rz": 0.034, "twist": 20}, {"position": [0.5355, 0.6925, 0.0], "rx": 0.1505, "rz": 0.0452, "twist": 20}, {"position": [0.6025, 0.6518, 0.0], "rx": 0.1293, "rz": 0.0389, "twist": 20}, {"position": [0.6694, 0.5891, 0.0], "rx": 0.0, "rz": 0.0, "twist": 20}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaf_1_4) {
    mesh_leaf_1_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaf_1_4 = new THREE.Mesh(
    mesh_leaf_1_4Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaf_1_4.name = "Leaf 2";
  if (endpoint_leaf_1_4) {
    mesh_leaf_1_4.position.copy(endpoint_leaf_1_4.midpoint);
    mesh_leaf_1_4.quaternion.copy(endpoint_leaf_1_4.quaternion);
  }
  mesh_leaf_1_4.castShadow = options.castShadow ?? true;
  mesh_leaf_1_4.receiveShadow = options.receiveShadow ?? true;
  mesh_leaf_1_4.userData.sculptComponent = {"id": "leaf-1", "name": "Leaf 2", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Long channelled petiole rising steeply from the crown into a lyrate blade that opens and droops.", "geometryDescriptor": {"topologyIntent": "Long channelled petiole rising steeply from the crown into a lyrate blade that opens and droops. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0126, "rz": 0.0198, "twist": 0}, {"position": [0.2952, 0.6627, 0.0], "rx": 0.0088, "rz": 0.0088, "twist": 0}, {"position": [0.3347, 0.6834, 0.0], "rx": 0.0061, "rz": 0.003, "twist": 20}, {"position": [0.4016, 0.7084, 0.0], "rx": 0.0577, "rz": 0.0173, "twist": 20}, {"position": [0.4686, 0.7114, 0.0], "rx": 0.1133, "rz": 0.034, "twist": 20}, {"position": [0.5355, 0.6925, 0.0], "rx": 0.1505, "rz": 0.0452, "twist": 20}, {"position": [0.6025, 0.6518, 0.0], "rx": 0.1293, "rz": 0.0389, "twist": 20}, {"position": [0.6694, 0.5891, 0.0], "rx": 0.0, "rz": 0.0, "twist": 20}], "radialSegments": 4, "capEnds": false}}, "parent": "root-globe", "attachment": {"parentId": "root-globe", "parentSocket": "root-globe:node", "localStart": [0.0049, 0.125, -0.0142], "localEnd": [0.2228, 0.7141, -0.6471], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0049, 0.125, -0.0142], "rotation": [0, 1.2392, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "petiole", "kind": "linework", "description": "long pale channelled petiole", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "blade opens and droops", "evidenceRefs": ["full-object"]}, {"id": "lateral-lobe", "kind": "contour", "description": "lyrate blade with lateral lobes", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.65, "microRoughness": 0.1, "bumpAmplitude": 0.012, "normalPattern": "rugose blade with pinnate veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker where the blade meets the petiole", "edgeWearPattern": "", "notes": "matte rugose leaf"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(79, 138, 58, 1.0)", "secondaryAlbedo": "rgba(47, 90, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_1_4.add(mesh_leaf_1_4);
  meshes["leaf-1"] = mesh_leaf_1_4;
  colliders["leaf-1"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaf-1"] ??= [];
  destructionGroups["leaf-1"].push(node_leaf_1_4);

  const endpoint_lobe_02_5 = makeAttachmentEndpoint(null);
  const node_lobe_02_5 = new THREE.Group();
  node_lobe_02_5.name = "Leaf 2 lateral lobe L__pivot";
  node_lobe_02_5.scale.set(1, 1, 1);
  if (endpoint_lobe_02_5) {
    node_lobe_02_5.position.copy(endpoint_lobe_02_5.start);
    node_lobe_02_5.rotation.set(0.0, -1.309, 0.0);
  } else {
    node_lobe_02_5.position.set(0.2169, 0.4772, 0.0);
    node_lobe_02_5.rotation.set(0.0, -1.309, 0.0);
  }
  node_lobe_02_5.userData.sculptComponent = {"id": "lobe-02", "name": "Leaf 2 lateral lobe L", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Small lateral lobe of the lyrate leaf on the upper petiole.", "geometryDescriptor": {"topologyIntent": "Small lateral lobe of the lyrate leaf on the upper petiole. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.004, "rz": 0.004, "twist": 0}, {"position": [0.0176, 0.0086, 0.0], "rx": 0.0032, "rz": 0.0032, "twist": 0}, {"position": [0.0273, 0.0134, 0.0], "rx": 0.0144, "rz": 0.012, "twist": -20}, {"position": [0.0458, 0.0185, 0.0], "rx": 0.0409, "rz": 0.0122, "twist": -20}, {"position": [0.0644, 0.0175, 0.0], "rx": 0.0436, "rz": 0.0131, "twist": -20}, {"position": [0.0829, 0.0104, 0.0], "rx": 0.0365, "rz": 0.012, "twist": -20}, {"position": [0.1015, -0.0027, 0.0], "rx": 0.0223, "rz": 0.012, "twist": -20}, {"position": [0.12, -0.022, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false}}, "parent": "leaf-1", "attachment": {"parentId": "leaf-1", "parentSocket": "leaf-1:node", "localStart": [0.2169, 0.4772, 0.0], "localEnd": [0.248, 0.4552, 0.1159], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.2169, 0.4772, 0.0], "rotation": [0, -1.309, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lobe-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(79, 138, 58, 1.0)", "secondaryAlbedo": "rgba(47, 90, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_lobe_02_5.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lobe-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["leaf-1"] ?? root).add(node_lobe_02_5);
  nodes["lobe-02"] = node_lobe_02_5;
  const mesh_lobe_02_5Geometry = endpoint_lobe_02_5
    ? new THREE.CylinderGeometry(endpoint_lobe_02_5.endRadius, endpoint_lobe_02_5.baseRadius, endpoint_lobe_02_5.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.004, "rz": 0.004, "twist": 0}, {"position": [0.0176, 0.0086, 0.0], "rx": 0.0032, "rz": 0.0032, "twist": 0}, {"position": [0.0273, 0.0134, 0.0], "rx": 0.0144, "rz": 0.012, "twist": -20}, {"position": [0.0458, 0.0185, 0.0], "rx": 0.0409, "rz": 0.0122, "twist": -20}, {"position": [0.0644, 0.0175, 0.0], "rx": 0.0436, "rz": 0.0131, "twist": -20}, {"position": [0.0829, 0.0104, 0.0], "rx": 0.0365, "rz": 0.012, "twist": -20}, {"position": [0.1015, -0.0027, 0.0], "rx": 0.0223, "rz": 0.012, "twist": -20}, {"position": [0.12, -0.022, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_lobe_02_5) {
    mesh_lobe_02_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_lobe_02_5 = new THREE.Mesh(
    mesh_lobe_02_5Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lobe_02_5.name = "Leaf 2 lateral lobe L";
  if (endpoint_lobe_02_5) {
    mesh_lobe_02_5.position.copy(endpoint_lobe_02_5.midpoint);
    mesh_lobe_02_5.quaternion.copy(endpoint_lobe_02_5.quaternion);
  }
  mesh_lobe_02_5.castShadow = options.castShadow ?? true;
  mesh_lobe_02_5.receiveShadow = options.receiveShadow ?? true;
  mesh_lobe_02_5.userData.sculptComponent = {"id": "lobe-02", "name": "Leaf 2 lateral lobe L", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Small lateral lobe of the lyrate leaf on the upper petiole.", "geometryDescriptor": {"topologyIntent": "Small lateral lobe of the lyrate leaf on the upper petiole. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.004, "rz": 0.004, "twist": 0}, {"position": [0.0176, 0.0086, 0.0], "rx": 0.0032, "rz": 0.0032, "twist": 0}, {"position": [0.0273, 0.0134, 0.0], "rx": 0.0144, "rz": 0.012, "twist": -20}, {"position": [0.0458, 0.0185, 0.0], "rx": 0.0409, "rz": 0.0122, "twist": -20}, {"position": [0.0644, 0.0175, 0.0], "rx": 0.0436, "rz": 0.0131, "twist": -20}, {"position": [0.0829, 0.0104, 0.0], "rx": 0.0365, "rz": 0.012, "twist": -20}, {"position": [0.1015, -0.0027, 0.0], "rx": 0.0223, "rz": 0.012, "twist": -20}, {"position": [0.12, -0.022, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false}}, "parent": "leaf-1", "attachment": {"parentId": "leaf-1", "parentSocket": "leaf-1:node", "localStart": [0.2169, 0.4772, 0.0], "localEnd": [0.248, 0.4552, 0.1159], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.2169, 0.4772, 0.0], "rotation": [0, -1.309, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lobe-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(79, 138, 58, 1.0)", "secondaryAlbedo": "rgba(47, 90, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_lobe_02_5.add(mesh_lobe_02_5);
  meshes["lobe-02"] = mesh_lobe_02_5;
  colliders["lobe-02"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["lobe-02"] ??= [];
  destructionGroups["lobe-02"].push(node_lobe_02_5);

  const endpoint_leaf_2_6 = makeAttachmentEndpoint(null);
  const node_leaf_2_6 = new THREE.Group();
  node_leaf_2_6.name = "Leaf 3__pivot";
  node_leaf_2_6.scale.set(1, 1, 1);
  if (endpoint_leaf_2_6) {
    node_leaf_2_6.position.copy(endpoint_leaf_2_6.start);
    node_leaf_2_6.rotation.set(0.0, 1.9722, 0.0);
  } else {
    node_leaf_2_6.position.set(-0.0059, 0.125, -0.0138);
    node_leaf_2_6.rotation.set(0.0, 1.9722, 0.0);
  }
  node_leaf_2_6.userData.sculptComponent = {"id": "leaf-2", "name": "Leaf 3", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Long channelled petiole rising steeply from the crown into a lyrate blade that opens and droops.", "geometryDescriptor": {"topologyIntent": "Long channelled petiole rising steeply from the crown into a lyrate blade that opens and droops. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0126, "rz": 0.0198, "twist": 0}, {"position": [0.2567, 0.5763, 0.0], "rx": 0.0088, "rz": 0.0088, "twist": 0}, {"position": [0.2911, 0.5943, 0.0], "rx": 0.0053, "rz": 0.003, "twist": -20}, {"position": [0.3493, 0.616, 0.0], "rx": 0.0501, "rz": 0.0151, "twist": -20}, {"position": [0.4075, 0.6186, 0.0], "rx": 0.0986, "rz": 0.0295, "twist": -20}, {"position": [0.4657, 0.6022, 0.0], "rx": 0.1309, "rz": 0.0394, "twist": -20}, {"position": [0.5239, 0.5668, 0.0], "rx": 0.1125, "rz": 0.0338, "twist": -20}, {"position": [0.5821, 0.5123, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false}}, "parent": "root-globe", "attachment": {"parentId": "root-globe", "parentSocket": "root-globe:node", "localStart": [-0.0059, 0.125, -0.0138], "localEnd": [-0.2333, 0.6373, -0.5496], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.0059, 0.125, -0.0138], "rotation": [0, 1.9722, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "petiole", "kind": "linework", "description": "long pale channelled petiole", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "blade opens and droops", "evidenceRefs": ["full-object"]}, {"id": "lateral-lobe", "kind": "contour", "description": "lyrate blade with lateral lobes", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.65, "microRoughness": 0.1, "bumpAmplitude": 0.012, "normalPattern": "rugose blade with pinnate veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker where the blade meets the petiole", "edgeWearPattern": "", "notes": "matte rugose leaf"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(79, 138, 58, 1.0)", "secondaryAlbedo": "rgba(47, 90, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_2_6.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root-globe"] ?? root).add(node_leaf_2_6);
  nodes["leaf-2"] = node_leaf_2_6;
  const mesh_leaf_2_6Geometry = endpoint_leaf_2_6
    ? new THREE.CylinderGeometry(endpoint_leaf_2_6.endRadius, endpoint_leaf_2_6.baseRadius, endpoint_leaf_2_6.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0126, "rz": 0.0198, "twist": 0}, {"position": [0.2567, 0.5763, 0.0], "rx": 0.0088, "rz": 0.0088, "twist": 0}, {"position": [0.2911, 0.5943, 0.0], "rx": 0.0053, "rz": 0.003, "twist": -20}, {"position": [0.3493, 0.616, 0.0], "rx": 0.0501, "rz": 0.0151, "twist": -20}, {"position": [0.4075, 0.6186, 0.0], "rx": 0.0986, "rz": 0.0295, "twist": -20}, {"position": [0.4657, 0.6022, 0.0], "rx": 0.1309, "rz": 0.0394, "twist": -20}, {"position": [0.5239, 0.5668, 0.0], "rx": 0.1125, "rz": 0.0338, "twist": -20}, {"position": [0.5821, 0.5123, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaf_2_6) {
    mesh_leaf_2_6Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaf_2_6 = new THREE.Mesh(
    mesh_leaf_2_6Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaf_2_6.name = "Leaf 3";
  if (endpoint_leaf_2_6) {
    mesh_leaf_2_6.position.copy(endpoint_leaf_2_6.midpoint);
    mesh_leaf_2_6.quaternion.copy(endpoint_leaf_2_6.quaternion);
  }
  mesh_leaf_2_6.castShadow = options.castShadow ?? true;
  mesh_leaf_2_6.receiveShadow = options.receiveShadow ?? true;
  mesh_leaf_2_6.userData.sculptComponent = {"id": "leaf-2", "name": "Leaf 3", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Long channelled petiole rising steeply from the crown into a lyrate blade that opens and droops.", "geometryDescriptor": {"topologyIntent": "Long channelled petiole rising steeply from the crown into a lyrate blade that opens and droops. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0126, "rz": 0.0198, "twist": 0}, {"position": [0.2567, 0.5763, 0.0], "rx": 0.0088, "rz": 0.0088, "twist": 0}, {"position": [0.2911, 0.5943, 0.0], "rx": 0.0053, "rz": 0.003, "twist": -20}, {"position": [0.3493, 0.616, 0.0], "rx": 0.0501, "rz": 0.0151, "twist": -20}, {"position": [0.4075, 0.6186, 0.0], "rx": 0.0986, "rz": 0.0295, "twist": -20}, {"position": [0.4657, 0.6022, 0.0], "rx": 0.1309, "rz": 0.0394, "twist": -20}, {"position": [0.5239, 0.5668, 0.0], "rx": 0.1125, "rz": 0.0338, "twist": -20}, {"position": [0.5821, 0.5123, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false}}, "parent": "root-globe", "attachment": {"parentId": "root-globe", "parentSocket": "root-globe:node", "localStart": [-0.0059, 0.125, -0.0138], "localEnd": [-0.2333, 0.6373, -0.5496], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.0059, 0.125, -0.0138], "rotation": [0, 1.9722, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "petiole", "kind": "linework", "description": "long pale channelled petiole", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "blade opens and droops", "evidenceRefs": ["full-object"]}, {"id": "lateral-lobe", "kind": "contour", "description": "lyrate blade with lateral lobes", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.65, "microRoughness": 0.1, "bumpAmplitude": 0.012, "normalPattern": "rugose blade with pinnate veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker where the blade meets the petiole", "edgeWearPattern": "", "notes": "matte rugose leaf"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(79, 138, 58, 1.0)", "secondaryAlbedo": "rgba(47, 90, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_2_6.add(mesh_leaf_2_6);
  meshes["leaf-2"] = mesh_leaf_2_6;
  colliders["leaf-2"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaf-2"] ??= [];
  destructionGroups["leaf-2"].push(node_leaf_2_6);

  const endpoint_lobe_04_7 = makeAttachmentEndpoint(null);
  const node_lobe_04_7 = new THREE.Group();
  node_lobe_04_7.name = "Leaf 3 lateral lobe L__pivot";
  node_lobe_04_7.scale.set(1, 1, 1);
  if (endpoint_lobe_04_7) {
    node_lobe_04_7.position.copy(endpoint_lobe_04_7.start);
    node_lobe_04_7.rotation.set(0.0, -1.309, 0.0);
  } else {
    node_lobe_04_7.position.set(0.1886, 0.4149, 0.0);
    node_lobe_04_7.rotation.set(0.0, -1.309, 0.0);
  }
  node_lobe_04_7.userData.sculptComponent = {"id": "lobe-04", "name": "Leaf 3 lateral lobe L", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Small lateral lobe of the lyrate leaf on the upper petiole.", "geometryDescriptor": {"topologyIntent": "Small lateral lobe of the lyrate leaf on the upper petiole. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.004, "rz": 0.004, "twist": 0}, {"position": [0.0176, 0.0086, 0.0], "rx": 0.0032, "rz": 0.0032, "twist": 0}, {"position": [0.0273, 0.0134, 0.0], "rx": 0.0144, "rz": 0.012, "twist": -20}, {"position": [0.0458, 0.0185, 0.0], "rx": 0.0409, "rz": 0.0122, "twist": -20}, {"position": [0.0644, 0.0175, 0.0], "rx": 0.0436, "rz": 0.0131, "twist": -20}, {"position": [0.0829, 0.0104, 0.0], "rx": 0.0365, "rz": 0.012, "twist": -20}, {"position": [0.1015, -0.0027, 0.0], "rx": 0.0223, "rz": 0.012, "twist": -20}, {"position": [0.12, -0.022, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false}}, "parent": "leaf-2", "attachment": {"parentId": "leaf-2", "parentSocket": "leaf-2:node", "localStart": [0.1886, 0.4149, 0.0], "localEnd": [0.2197, 0.3929, 0.1159], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.1886, 0.4149, 0.0], "rotation": [0, -1.309, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lobe-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(79, 138, 58, 1.0)", "secondaryAlbedo": "rgba(47, 90, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_lobe_04_7.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lobe-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["leaf-2"] ?? root).add(node_lobe_04_7);
  nodes["lobe-04"] = node_lobe_04_7;
  const mesh_lobe_04_7Geometry = endpoint_lobe_04_7
    ? new THREE.CylinderGeometry(endpoint_lobe_04_7.endRadius, endpoint_lobe_04_7.baseRadius, endpoint_lobe_04_7.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.004, "rz": 0.004, "twist": 0}, {"position": [0.0176, 0.0086, 0.0], "rx": 0.0032, "rz": 0.0032, "twist": 0}, {"position": [0.0273, 0.0134, 0.0], "rx": 0.0144, "rz": 0.012, "twist": -20}, {"position": [0.0458, 0.0185, 0.0], "rx": 0.0409, "rz": 0.0122, "twist": -20}, {"position": [0.0644, 0.0175, 0.0], "rx": 0.0436, "rz": 0.0131, "twist": -20}, {"position": [0.0829, 0.0104, 0.0], "rx": 0.0365, "rz": 0.012, "twist": -20}, {"position": [0.1015, -0.0027, 0.0], "rx": 0.0223, "rz": 0.012, "twist": -20}, {"position": [0.12, -0.022, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_lobe_04_7) {
    mesh_lobe_04_7Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_lobe_04_7 = new THREE.Mesh(
    mesh_lobe_04_7Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lobe_04_7.name = "Leaf 3 lateral lobe L";
  if (endpoint_lobe_04_7) {
    mesh_lobe_04_7.position.copy(endpoint_lobe_04_7.midpoint);
    mesh_lobe_04_7.quaternion.copy(endpoint_lobe_04_7.quaternion);
  }
  mesh_lobe_04_7.castShadow = options.castShadow ?? true;
  mesh_lobe_04_7.receiveShadow = options.receiveShadow ?? true;
  mesh_lobe_04_7.userData.sculptComponent = {"id": "lobe-04", "name": "Leaf 3 lateral lobe L", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Small lateral lobe of the lyrate leaf on the upper petiole.", "geometryDescriptor": {"topologyIntent": "Small lateral lobe of the lyrate leaf on the upper petiole. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.004, "rz": 0.004, "twist": 0}, {"position": [0.0176, 0.0086, 0.0], "rx": 0.0032, "rz": 0.0032, "twist": 0}, {"position": [0.0273, 0.0134, 0.0], "rx": 0.0144, "rz": 0.012, "twist": -20}, {"position": [0.0458, 0.0185, 0.0], "rx": 0.0409, "rz": 0.0122, "twist": -20}, {"position": [0.0644, 0.0175, 0.0], "rx": 0.0436, "rz": 0.0131, "twist": -20}, {"position": [0.0829, 0.0104, 0.0], "rx": 0.0365, "rz": 0.012, "twist": -20}, {"position": [0.1015, -0.0027, 0.0], "rx": 0.0223, "rz": 0.012, "twist": -20}, {"position": [0.12, -0.022, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false}}, "parent": "leaf-2", "attachment": {"parentId": "leaf-2", "parentSocket": "leaf-2:node", "localStart": [0.1886, 0.4149, 0.0], "localEnd": [0.2197, 0.3929, 0.1159], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.1886, 0.4149, 0.0], "rotation": [0, -1.309, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lobe-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(79, 138, 58, 1.0)", "secondaryAlbedo": "rgba(47, 90, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_lobe_04_7.add(mesh_lobe_04_7);
  meshes["lobe-04"] = mesh_lobe_04_7;
  colliders["lobe-04"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["lobe-04"] ??= [];
  destructionGroups["lobe-04"].push(node_lobe_04_7);

  const endpoint_leaf_3_8 = makeAttachmentEndpoint(null);
  const node_leaf_3_8 = new THREE.Group();
  node_leaf_3_8.name = "Leaf 4__pivot";
  node_leaf_3_8.scale.set(1, 1, 1);
  if (endpoint_leaf_3_8) {
    node_leaf_3_8.position.copy(endpoint_leaf_3_8.start);
    node_leaf_3_8.rotation.set(0.0, 3.3336, 0.0);
  } else {
    node_leaf_3_8.position.set(-0.0147, 0.125, 0.0029);
    node_leaf_3_8.rotation.set(0.0, 3.3336, 0.0);
  }
  node_leaf_3_8.userData.sculptComponent = {"id": "leaf-3", "name": "Leaf 4", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Long channelled petiole rising steeply from the crown into a lyrate blade that opens and droops.", "geometryDescriptor": {"topologyIntent": "Long channelled petiole rising steeply from the crown into a lyrate blade that opens and droops. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0126, "rz": 0.0198, "twist": 0}, {"position": [0.236, 0.5298, 0.0], "rx": 0.0088, "rz": 0.0088, "twist": 0}, {"position": [0.2676, 0.5464, 0.0], "rx": 0.0049, "rz": 0.003, "twist": 20}, {"position": [0.3211, 0.5663, 0.0], "rx": 0.0461, "rz": 0.0139, "twist": 20}, {"position": [0.3746, 0.5688, 0.0], "rx": 0.0906, "rz": 0.0272, "twist": 20}, {"position": [0.4282, 0.5537, 0.0], "rx": 0.1203, "rz": 0.0362, "twist": 20}, {"position": [0.4817, 0.5211, 0.0], "rx": 0.1034, "rz": 0.0311, "twist": 20}, {"position": [0.5352, 0.471, 0.0], "rx": 0.0, "rz": 0.0, "twist": 20}], "radialSegments": 4, "capEnds": false}}, "parent": "root-globe", "attachment": {"parentId": "root-globe", "parentSocket": "root-globe:node", "localStart": [-0.0147, 0.125, 0.0029], "localEnd": [-0.5401, 0.596, 0.105], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.0147, 0.125, 0.0029], "rotation": [0, 3.3336, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "petiole", "kind": "linework", "description": "long pale channelled petiole", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "blade opens and droops", "evidenceRefs": ["full-object"]}, {"id": "lateral-lobe", "kind": "contour", "description": "lyrate blade with lateral lobes", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.65, "microRoughness": 0.1, "bumpAmplitude": 0.012, "normalPattern": "rugose blade with pinnate veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker where the blade meets the petiole", "edgeWearPattern": "", "notes": "matte rugose leaf"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(79, 138, 58, 1.0)", "secondaryAlbedo": "rgba(47, 90, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_3_8.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root-globe"] ?? root).add(node_leaf_3_8);
  nodes["leaf-3"] = node_leaf_3_8;
  const mesh_leaf_3_8Geometry = endpoint_leaf_3_8
    ? new THREE.CylinderGeometry(endpoint_leaf_3_8.endRadius, endpoint_leaf_3_8.baseRadius, endpoint_leaf_3_8.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0126, "rz": 0.0198, "twist": 0}, {"position": [0.236, 0.5298, 0.0], "rx": 0.0088, "rz": 0.0088, "twist": 0}, {"position": [0.2676, 0.5464, 0.0], "rx": 0.0049, "rz": 0.003, "twist": 20}, {"position": [0.3211, 0.5663, 0.0], "rx": 0.0461, "rz": 0.0139, "twist": 20}, {"position": [0.3746, 0.5688, 0.0], "rx": 0.0906, "rz": 0.0272, "twist": 20}, {"position": [0.4282, 0.5537, 0.0], "rx": 0.1203, "rz": 0.0362, "twist": 20}, {"position": [0.4817, 0.5211, 0.0], "rx": 0.1034, "rz": 0.0311, "twist": 20}, {"position": [0.5352, 0.471, 0.0], "rx": 0.0, "rz": 0.0, "twist": 20}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaf_3_8) {
    mesh_leaf_3_8Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaf_3_8 = new THREE.Mesh(
    mesh_leaf_3_8Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaf_3_8.name = "Leaf 4";
  if (endpoint_leaf_3_8) {
    mesh_leaf_3_8.position.copy(endpoint_leaf_3_8.midpoint);
    mesh_leaf_3_8.quaternion.copy(endpoint_leaf_3_8.quaternion);
  }
  mesh_leaf_3_8.castShadow = options.castShadow ?? true;
  mesh_leaf_3_8.receiveShadow = options.receiveShadow ?? true;
  mesh_leaf_3_8.userData.sculptComponent = {"id": "leaf-3", "name": "Leaf 4", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Long channelled petiole rising steeply from the crown into a lyrate blade that opens and droops.", "geometryDescriptor": {"topologyIntent": "Long channelled petiole rising steeply from the crown into a lyrate blade that opens and droops. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0126, "rz": 0.0198, "twist": 0}, {"position": [0.236, 0.5298, 0.0], "rx": 0.0088, "rz": 0.0088, "twist": 0}, {"position": [0.2676, 0.5464, 0.0], "rx": 0.0049, "rz": 0.003, "twist": 20}, {"position": [0.3211, 0.5663, 0.0], "rx": 0.0461, "rz": 0.0139, "twist": 20}, {"position": [0.3746, 0.5688, 0.0], "rx": 0.0906, "rz": 0.0272, "twist": 20}, {"position": [0.4282, 0.5537, 0.0], "rx": 0.1203, "rz": 0.0362, "twist": 20}, {"position": [0.4817, 0.5211, 0.0], "rx": 0.1034, "rz": 0.0311, "twist": 20}, {"position": [0.5352, 0.471, 0.0], "rx": 0.0, "rz": 0.0, "twist": 20}], "radialSegments": 4, "capEnds": false}}, "parent": "root-globe", "attachment": {"parentId": "root-globe", "parentSocket": "root-globe:node", "localStart": [-0.0147, 0.125, 0.0029], "localEnd": [-0.5401, 0.596, 0.105], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.0147, 0.125, 0.0029], "rotation": [0, 3.3336, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "petiole", "kind": "linework", "description": "long pale channelled petiole", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "blade opens and droops", "evidenceRefs": ["full-object"]}, {"id": "lateral-lobe", "kind": "contour", "description": "lyrate blade with lateral lobes", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.65, "microRoughness": 0.1, "bumpAmplitude": 0.012, "normalPattern": "rugose blade with pinnate veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker where the blade meets the petiole", "edgeWearPattern": "", "notes": "matte rugose leaf"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(79, 138, 58, 1.0)", "secondaryAlbedo": "rgba(47, 90, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_3_8.add(mesh_leaf_3_8);
  meshes["leaf-3"] = mesh_leaf_3_8;
  colliders["leaf-3"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaf-3"] ??= [];
  destructionGroups["leaf-3"].push(node_leaf_3_8);

  const endpoint_lobe_06_9 = makeAttachmentEndpoint(null);
  const node_lobe_06_9 = new THREE.Group();
  node_lobe_06_9.name = "Leaf 4 lateral lobe L__pivot";
  node_lobe_06_9.scale.set(1, 1, 1);
  if (endpoint_lobe_06_9) {
    node_lobe_06_9.position.copy(endpoint_lobe_06_9.start);
    node_lobe_06_9.rotation.set(0.0, -1.309, 0.0);
  } else {
    node_lobe_06_9.position.set(0.1734, 0.3815, 0.0);
    node_lobe_06_9.rotation.set(0.0, -1.309, 0.0);
  }
  node_lobe_06_9.userData.sculptComponent = {"id": "lobe-06", "name": "Leaf 4 lateral lobe L", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Small lateral lobe of the lyrate leaf on the upper petiole.", "geometryDescriptor": {"topologyIntent": "Small lateral lobe of the lyrate leaf on the upper petiole. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.004, "rz": 0.004, "twist": 0}, {"position": [0.0176, 0.0086, 0.0], "rx": 0.0032, "rz": 0.0032, "twist": 0}, {"position": [0.0273, 0.0134, 0.0], "rx": 0.0144, "rz": 0.012, "twist": -20}, {"position": [0.0458, 0.0185, 0.0], "rx": 0.0409, "rz": 0.0122, "twist": -20}, {"position": [0.0644, 0.0175, 0.0], "rx": 0.0436, "rz": 0.0131, "twist": -20}, {"position": [0.0829, 0.0104, 0.0], "rx": 0.0365, "rz": 0.012, "twist": -20}, {"position": [0.1015, -0.0027, 0.0], "rx": 0.0223, "rz": 0.012, "twist": -20}, {"position": [0.12, -0.022, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false}}, "parent": "leaf-3", "attachment": {"parentId": "leaf-3", "parentSocket": "leaf-3:node", "localStart": [0.1734, 0.3815, 0.0], "localEnd": [0.2045, 0.3595, 0.1159], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.1734, 0.3815, 0.0], "rotation": [0, -1.309, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lobe-06", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(79, 138, 58, 1.0)", "secondaryAlbedo": "rgba(47, 90, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_lobe_06_9.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lobe-06", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["leaf-3"] ?? root).add(node_lobe_06_9);
  nodes["lobe-06"] = node_lobe_06_9;
  const mesh_lobe_06_9Geometry = endpoint_lobe_06_9
    ? new THREE.CylinderGeometry(endpoint_lobe_06_9.endRadius, endpoint_lobe_06_9.baseRadius, endpoint_lobe_06_9.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.004, "rz": 0.004, "twist": 0}, {"position": [0.0176, 0.0086, 0.0], "rx": 0.0032, "rz": 0.0032, "twist": 0}, {"position": [0.0273, 0.0134, 0.0], "rx": 0.0144, "rz": 0.012, "twist": -20}, {"position": [0.0458, 0.0185, 0.0], "rx": 0.0409, "rz": 0.0122, "twist": -20}, {"position": [0.0644, 0.0175, 0.0], "rx": 0.0436, "rz": 0.0131, "twist": -20}, {"position": [0.0829, 0.0104, 0.0], "rx": 0.0365, "rz": 0.012, "twist": -20}, {"position": [0.1015, -0.0027, 0.0], "rx": 0.0223, "rz": 0.012, "twist": -20}, {"position": [0.12, -0.022, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_lobe_06_9) {
    mesh_lobe_06_9Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_lobe_06_9 = new THREE.Mesh(
    mesh_lobe_06_9Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lobe_06_9.name = "Leaf 4 lateral lobe L";
  if (endpoint_lobe_06_9) {
    mesh_lobe_06_9.position.copy(endpoint_lobe_06_9.midpoint);
    mesh_lobe_06_9.quaternion.copy(endpoint_lobe_06_9.quaternion);
  }
  mesh_lobe_06_9.castShadow = options.castShadow ?? true;
  mesh_lobe_06_9.receiveShadow = options.receiveShadow ?? true;
  mesh_lobe_06_9.userData.sculptComponent = {"id": "lobe-06", "name": "Leaf 4 lateral lobe L", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Small lateral lobe of the lyrate leaf on the upper petiole.", "geometryDescriptor": {"topologyIntent": "Small lateral lobe of the lyrate leaf on the upper petiole. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.004, "rz": 0.004, "twist": 0}, {"position": [0.0176, 0.0086, 0.0], "rx": 0.0032, "rz": 0.0032, "twist": 0}, {"position": [0.0273, 0.0134, 0.0], "rx": 0.0144, "rz": 0.012, "twist": -20}, {"position": [0.0458, 0.0185, 0.0], "rx": 0.0409, "rz": 0.0122, "twist": -20}, {"position": [0.0644, 0.0175, 0.0], "rx": 0.0436, "rz": 0.0131, "twist": -20}, {"position": [0.0829, 0.0104, 0.0], "rx": 0.0365, "rz": 0.012, "twist": -20}, {"position": [0.1015, -0.0027, 0.0], "rx": 0.0223, "rz": 0.012, "twist": -20}, {"position": [0.12, -0.022, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false}}, "parent": "leaf-3", "attachment": {"parentId": "leaf-3", "parentSocket": "leaf-3:node", "localStart": [0.1734, 0.3815, 0.0], "localEnd": [0.2045, 0.3595, 0.1159], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.1734, 0.3815, 0.0], "rotation": [0, -1.309, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lobe-06", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(79, 138, 58, 1.0)", "secondaryAlbedo": "rgba(47, 90, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_lobe_06_9.add(mesh_lobe_06_9);
  meshes["lobe-06"] = mesh_lobe_06_9;
  colliders["lobe-06"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["lobe-06"] ??= [];
  destructionGroups["lobe-06"].push(node_lobe_06_9);

  const endpoint_leaf_4_10 = makeAttachmentEndpoint(null);
  const node_leaf_4_10 = new THREE.Group();
  node_leaf_4_10.name = "Leaf 5__pivot";
  node_leaf_4_10.scale.set(1, 1, 1);
  if (endpoint_leaf_4_10) {
    node_leaf_4_10.position.copy(endpoint_leaf_4_10.start);
    node_leaf_4_10.rotation.set(0.0, 4.0666, 0.0);
  } else {
    node_leaf_4_10.position.set(-0.009, 0.125, 0.012);
    node_leaf_4_10.rotation.set(0.0, 4.0666, 0.0);
  }
  node_leaf_4_10.userData.sculptComponent = {"id": "leaf-4", "name": "Leaf 5", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Long channelled petiole rising steeply from the crown into a lyrate blade that opens and droops.", "geometryDescriptor": {"topologyIntent": "Long channelled petiole rising steeply from the crown into a lyrate blade that opens and droops. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0126, "rz": 0.0198, "twist": 0}, {"position": [0.2799, 0.6282, 0.0], "rx": 0.0088, "rz": 0.0088, "twist": 0}, {"position": [0.3173, 0.6479, 0.0], "rx": 0.0058, "rz": 0.003, "twist": -20}, {"position": [0.3808, 0.6715, 0.0], "rx": 0.0546, "rz": 0.0164, "twist": -20}, {"position": [0.4442, 0.6744, 0.0], "rx": 0.1074, "rz": 0.0322, "twist": -20}, {"position": [0.5077, 0.6565, 0.0], "rx": 0.1427, "rz": 0.0428, "twist": -20}, {"position": [0.5711, 0.6179, 0.0], "rx": 0.1226, "rz": 0.0369, "twist": -20}, {"position": [0.6346, 0.5584, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false}}, "parent": "root-globe", "attachment": {"parentId": "root-globe", "parentSocket": "root-globe:node", "localStart": [-0.009, 0.125, 0.012], "localEnd": [-0.3909, 0.6834, 0.5188], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.009, 0.125, 0.012], "rotation": [0, 4.0666, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "petiole", "kind": "linework", "description": "long pale channelled petiole", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "blade opens and droops", "evidenceRefs": ["full-object"]}, {"id": "lateral-lobe", "kind": "contour", "description": "lyrate blade with lateral lobes", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.65, "microRoughness": 0.1, "bumpAmplitude": 0.012, "normalPattern": "rugose blade with pinnate veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker where the blade meets the petiole", "edgeWearPattern": "", "notes": "matte rugose leaf"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(79, 138, 58, 1.0)", "secondaryAlbedo": "rgba(47, 90, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_4_10.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root-globe"] ?? root).add(node_leaf_4_10);
  nodes["leaf-4"] = node_leaf_4_10;
  const mesh_leaf_4_10Geometry = endpoint_leaf_4_10
    ? new THREE.CylinderGeometry(endpoint_leaf_4_10.endRadius, endpoint_leaf_4_10.baseRadius, endpoint_leaf_4_10.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0126, "rz": 0.0198, "twist": 0}, {"position": [0.2799, 0.6282, 0.0], "rx": 0.0088, "rz": 0.0088, "twist": 0}, {"position": [0.3173, 0.6479, 0.0], "rx": 0.0058, "rz": 0.003, "twist": -20}, {"position": [0.3808, 0.6715, 0.0], "rx": 0.0546, "rz": 0.0164, "twist": -20}, {"position": [0.4442, 0.6744, 0.0], "rx": 0.1074, "rz": 0.0322, "twist": -20}, {"position": [0.5077, 0.6565, 0.0], "rx": 0.1427, "rz": 0.0428, "twist": -20}, {"position": [0.5711, 0.6179, 0.0], "rx": 0.1226, "rz": 0.0369, "twist": -20}, {"position": [0.6346, 0.5584, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaf_4_10) {
    mesh_leaf_4_10Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaf_4_10 = new THREE.Mesh(
    mesh_leaf_4_10Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaf_4_10.name = "Leaf 5";
  if (endpoint_leaf_4_10) {
    mesh_leaf_4_10.position.copy(endpoint_leaf_4_10.midpoint);
    mesh_leaf_4_10.quaternion.copy(endpoint_leaf_4_10.quaternion);
  }
  mesh_leaf_4_10.castShadow = options.castShadow ?? true;
  mesh_leaf_4_10.receiveShadow = options.receiveShadow ?? true;
  mesh_leaf_4_10.userData.sculptComponent = {"id": "leaf-4", "name": "Leaf 5", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Long channelled petiole rising steeply from the crown into a lyrate blade that opens and droops.", "geometryDescriptor": {"topologyIntent": "Long channelled petiole rising steeply from the crown into a lyrate blade that opens and droops. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0126, "rz": 0.0198, "twist": 0}, {"position": [0.2799, 0.6282, 0.0], "rx": 0.0088, "rz": 0.0088, "twist": 0}, {"position": [0.3173, 0.6479, 0.0], "rx": 0.0058, "rz": 0.003, "twist": -20}, {"position": [0.3808, 0.6715, 0.0], "rx": 0.0546, "rz": 0.0164, "twist": -20}, {"position": [0.4442, 0.6744, 0.0], "rx": 0.1074, "rz": 0.0322, "twist": -20}, {"position": [0.5077, 0.6565, 0.0], "rx": 0.1427, "rz": 0.0428, "twist": -20}, {"position": [0.5711, 0.6179, 0.0], "rx": 0.1226, "rz": 0.0369, "twist": -20}, {"position": [0.6346, 0.5584, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false}}, "parent": "root-globe", "attachment": {"parentId": "root-globe", "parentSocket": "root-globe:node", "localStart": [-0.009, 0.125, 0.012], "localEnd": [-0.3909, 0.6834, 0.5188], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.009, 0.125, 0.012], "rotation": [0, 4.0666, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "petiole", "kind": "linework", "description": "long pale channelled petiole", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "blade opens and droops", "evidenceRefs": ["full-object"]}, {"id": "lateral-lobe", "kind": "contour", "description": "lyrate blade with lateral lobes", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.65, "microRoughness": 0.1, "bumpAmplitude": 0.012, "normalPattern": "rugose blade with pinnate veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker where the blade meets the petiole", "edgeWearPattern": "", "notes": "matte rugose leaf"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(79, 138, 58, 1.0)", "secondaryAlbedo": "rgba(47, 90, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_4_10.add(mesh_leaf_4_10);
  meshes["leaf-4"] = mesh_leaf_4_10;
  colliders["leaf-4"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaf-4"] ??= [];
  destructionGroups["leaf-4"].push(node_leaf_4_10);

  const endpoint_lobe_08_11 = makeAttachmentEndpoint(null);
  const node_lobe_08_11 = new THREE.Group();
  node_lobe_08_11.name = "Leaf 5 lateral lobe L__pivot";
  node_lobe_08_11.scale.set(1, 1, 1);
  if (endpoint_lobe_08_11) {
    node_lobe_08_11.position.copy(endpoint_lobe_08_11.start);
    node_lobe_08_11.rotation.set(0.0, -1.309, 0.0);
  } else {
    node_lobe_08_11.position.set(0.2056, 0.4523, 0.0);
    node_lobe_08_11.rotation.set(0.0, -1.309, 0.0);
  }
  node_lobe_08_11.userData.sculptComponent = {"id": "lobe-08", "name": "Leaf 5 lateral lobe L", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Small lateral lobe of the lyrate leaf on the upper petiole.", "geometryDescriptor": {"topologyIntent": "Small lateral lobe of the lyrate leaf on the upper petiole. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.004, "rz": 0.004, "twist": 0}, {"position": [0.0176, 0.0086, 0.0], "rx": 0.0032, "rz": 0.0032, "twist": 0}, {"position": [0.0273, 0.0134, 0.0], "rx": 0.0144, "rz": 0.012, "twist": -20}, {"position": [0.0458, 0.0185, 0.0], "rx": 0.0409, "rz": 0.0122, "twist": -20}, {"position": [0.0644, 0.0175, 0.0], "rx": 0.0436, "rz": 0.0131, "twist": -20}, {"position": [0.0829, 0.0104, 0.0], "rx": 0.0365, "rz": 0.012, "twist": -20}, {"position": [0.1015, -0.0027, 0.0], "rx": 0.0223, "rz": 0.012, "twist": -20}, {"position": [0.12, -0.022, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false}}, "parent": "leaf-4", "attachment": {"parentId": "leaf-4", "parentSocket": "leaf-4:node", "localStart": [0.2056, 0.4523, 0.0], "localEnd": [0.2367, 0.4303, 0.1159], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.2056, 0.4523, 0.0], "rotation": [0, -1.309, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lobe-08", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(79, 138, 58, 1.0)", "secondaryAlbedo": "rgba(47, 90, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_lobe_08_11.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lobe-08", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["leaf-4"] ?? root).add(node_lobe_08_11);
  nodes["lobe-08"] = node_lobe_08_11;
  const mesh_lobe_08_11Geometry = endpoint_lobe_08_11
    ? new THREE.CylinderGeometry(endpoint_lobe_08_11.endRadius, endpoint_lobe_08_11.baseRadius, endpoint_lobe_08_11.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.004, "rz": 0.004, "twist": 0}, {"position": [0.0176, 0.0086, 0.0], "rx": 0.0032, "rz": 0.0032, "twist": 0}, {"position": [0.0273, 0.0134, 0.0], "rx": 0.0144, "rz": 0.012, "twist": -20}, {"position": [0.0458, 0.0185, 0.0], "rx": 0.0409, "rz": 0.0122, "twist": -20}, {"position": [0.0644, 0.0175, 0.0], "rx": 0.0436, "rz": 0.0131, "twist": -20}, {"position": [0.0829, 0.0104, 0.0], "rx": 0.0365, "rz": 0.012, "twist": -20}, {"position": [0.1015, -0.0027, 0.0], "rx": 0.0223, "rz": 0.012, "twist": -20}, {"position": [0.12, -0.022, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_lobe_08_11) {
    mesh_lobe_08_11Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_lobe_08_11 = new THREE.Mesh(
    mesh_lobe_08_11Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lobe_08_11.name = "Leaf 5 lateral lobe L";
  if (endpoint_lobe_08_11) {
    mesh_lobe_08_11.position.copy(endpoint_lobe_08_11.midpoint);
    mesh_lobe_08_11.quaternion.copy(endpoint_lobe_08_11.quaternion);
  }
  mesh_lobe_08_11.castShadow = options.castShadow ?? true;
  mesh_lobe_08_11.receiveShadow = options.receiveShadow ?? true;
  mesh_lobe_08_11.userData.sculptComponent = {"id": "lobe-08", "name": "Leaf 5 lateral lobe L", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Small lateral lobe of the lyrate leaf on the upper petiole.", "geometryDescriptor": {"topologyIntent": "Small lateral lobe of the lyrate leaf on the upper petiole. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.004, "rz": 0.004, "twist": 0}, {"position": [0.0176, 0.0086, 0.0], "rx": 0.0032, "rz": 0.0032, "twist": 0}, {"position": [0.0273, 0.0134, 0.0], "rx": 0.0144, "rz": 0.012, "twist": -20}, {"position": [0.0458, 0.0185, 0.0], "rx": 0.0409, "rz": 0.0122, "twist": -20}, {"position": [0.0644, 0.0175, 0.0], "rx": 0.0436, "rz": 0.0131, "twist": -20}, {"position": [0.0829, 0.0104, 0.0], "rx": 0.0365, "rz": 0.012, "twist": -20}, {"position": [0.1015, -0.0027, 0.0], "rx": 0.0223, "rz": 0.012, "twist": -20}, {"position": [0.12, -0.022, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false}}, "parent": "leaf-4", "attachment": {"parentId": "leaf-4", "parentSocket": "leaf-4:node", "localStart": [0.2056, 0.4523, 0.0], "localEnd": [0.2367, 0.4303, 0.1159], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.2056, 0.4523, 0.0], "rotation": [0, -1.309, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lobe-08", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(79, 138, 58, 1.0)", "secondaryAlbedo": "rgba(47, 90, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_lobe_08_11.add(mesh_lobe_08_11);
  meshes["lobe-08"] = mesh_lobe_08_11;
  colliders["lobe-08"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["lobe-08"] ??= [];
  destructionGroups["lobe-08"].push(node_lobe_08_11);

  const endpoint_leaf_5_12 = makeAttachmentEndpoint(null);
  const node_leaf_5_12 = new THREE.Group();
  node_leaf_5_12.name = "Leaf 6__pivot";
  node_leaf_5_12.scale.set(1, 1, 1);
  if (endpoint_leaf_5_12) {
    node_leaf_5_12.position.copy(endpoint_leaf_5_12.start);
    node_leaf_5_12.rotation.set(0.0, 5.428, 0.0);
  } else {
    node_leaf_5_12.position.set(0.0098, 0.125, 0.0113);
    node_leaf_5_12.rotation.set(0.0, 5.428, 0.0);
  }
  node_leaf_5_12.userData.sculptComponent = {"id": "leaf-5", "name": "Leaf 6", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Long channelled petiole rising steeply from the crown into a lyrate blade that opens and droops.", "geometryDescriptor": {"topologyIntent": "Long channelled petiole rising steeply from the crown into a lyrate blade that opens and droops. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0126, "rz": 0.0198, "twist": 0}, {"position": [0.2892, 0.6493, 0.0], "rx": 0.0088, "rz": 0.0088, "twist": 0}, {"position": [0.3279, 0.6696, 0.0], "rx": 0.006, "rz": 0.003, "twist": 20}, {"position": [0.3935, 0.6941, 0.0], "rx": 0.0565, "rz": 0.0169, "twist": 20}, {"position": [0.4591, 0.697, 0.0], "rx": 0.111, "rz": 0.0333, "twist": 20}, {"position": [0.5247, 0.6786, 0.0], "rx": 0.1475, "rz": 0.0443, "twist": 20}, {"position": [0.5903, 0.6386, 0.0], "rx": 0.1267, "rz": 0.0382, "twist": 20}, {"position": [0.6559, 0.5772, 0.0], "rx": 0.0, "rz": 0.0, "twist": 20}], "radialSegments": 4, "capEnds": false}}, "parent": "root-globe", "attachment": {"parentId": "root-globe", "parentSocket": "root-globe:node", "localStart": [0.0098, 0.125, 0.0113], "localEnd": [0.4401, 0.7022, 0.5063], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0098, 0.125, 0.0113], "rotation": [0, 5.428, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "petiole", "kind": "linework", "description": "long pale channelled petiole", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "blade opens and droops", "evidenceRefs": ["full-object"]}, {"id": "lateral-lobe", "kind": "contour", "description": "lyrate blade with lateral lobes", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.65, "microRoughness": 0.1, "bumpAmplitude": 0.012, "normalPattern": "rugose blade with pinnate veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker where the blade meets the petiole", "edgeWearPattern": "", "notes": "matte rugose leaf"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(79, 138, 58, 1.0)", "secondaryAlbedo": "rgba(47, 90, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_5_12.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["root-globe"] ?? root).add(node_leaf_5_12);
  nodes["leaf-5"] = node_leaf_5_12;
  const mesh_leaf_5_12Geometry = endpoint_leaf_5_12
    ? new THREE.CylinderGeometry(endpoint_leaf_5_12.endRadius, endpoint_leaf_5_12.baseRadius, endpoint_leaf_5_12.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0126, "rz": 0.0198, "twist": 0}, {"position": [0.2892, 0.6493, 0.0], "rx": 0.0088, "rz": 0.0088, "twist": 0}, {"position": [0.3279, 0.6696, 0.0], "rx": 0.006, "rz": 0.003, "twist": 20}, {"position": [0.3935, 0.6941, 0.0], "rx": 0.0565, "rz": 0.0169, "twist": 20}, {"position": [0.4591, 0.697, 0.0], "rx": 0.111, "rz": 0.0333, "twist": 20}, {"position": [0.5247, 0.6786, 0.0], "rx": 0.1475, "rz": 0.0443, "twist": 20}, {"position": [0.5903, 0.6386, 0.0], "rx": 0.1267, "rz": 0.0382, "twist": 20}, {"position": [0.6559, 0.5772, 0.0], "rx": 0.0, "rz": 0.0, "twist": 20}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaf_5_12) {
    mesh_leaf_5_12Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaf_5_12 = new THREE.Mesh(
    mesh_leaf_5_12Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaf_5_12.name = "Leaf 6";
  if (endpoint_leaf_5_12) {
    mesh_leaf_5_12.position.copy(endpoint_leaf_5_12.midpoint);
    mesh_leaf_5_12.quaternion.copy(endpoint_leaf_5_12.quaternion);
  }
  mesh_leaf_5_12.castShadow = options.castShadow ?? true;
  mesh_leaf_5_12.receiveShadow = options.receiveShadow ?? true;
  mesh_leaf_5_12.userData.sculptComponent = {"id": "leaf-5", "name": "Leaf 6", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Long channelled petiole rising steeply from the crown into a lyrate blade that opens and droops.", "geometryDescriptor": {"topologyIntent": "Long channelled petiole rising steeply from the crown into a lyrate blade that opens and droops. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.0126, "rz": 0.0198, "twist": 0}, {"position": [0.2892, 0.6493, 0.0], "rx": 0.0088, "rz": 0.0088, "twist": 0}, {"position": [0.3279, 0.6696, 0.0], "rx": 0.006, "rz": 0.003, "twist": 20}, {"position": [0.3935, 0.6941, 0.0], "rx": 0.0565, "rz": 0.0169, "twist": 20}, {"position": [0.4591, 0.697, 0.0], "rx": 0.111, "rz": 0.0333, "twist": 20}, {"position": [0.5247, 0.6786, 0.0], "rx": 0.1475, "rz": 0.0443, "twist": 20}, {"position": [0.5903, 0.6386, 0.0], "rx": 0.1267, "rz": 0.0382, "twist": 20}, {"position": [0.6559, 0.5772, 0.0], "rx": 0.0, "rz": 0.0, "twist": 20}], "radialSegments": 4, "capEnds": false}}, "parent": "root-globe", "attachment": {"parentId": "root-globe", "parentSocket": "root-globe:node", "localStart": [0.0098, 0.125, 0.0113], "localEnd": [0.4401, 0.7022, 0.5063], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0098, 0.125, 0.0113], "rotation": [0, 5.428, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "petiole", "kind": "linework", "description": "long pale channelled petiole", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "blade opens and droops", "evidenceRefs": ["full-object"]}, {"id": "lateral-lobe", "kind": "contour", "description": "lyrate blade with lateral lobes", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.65, "microRoughness": 0.1, "bumpAmplitude": 0.012, "normalPattern": "rugose blade with pinnate veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker where the blade meets the petiole", "edgeWearPattern": "", "notes": "matte rugose leaf"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(79, 138, 58, 1.0)", "secondaryAlbedo": "rgba(47, 90, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_5_12.add(mesh_leaf_5_12);
  meshes["leaf-5"] = mesh_leaf_5_12;
  colliders["leaf-5"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaf-5"] ??= [];
  destructionGroups["leaf-5"].push(node_leaf_5_12);

  const endpoint_lobe_10_13 = makeAttachmentEndpoint(null);
  const node_lobe_10_13 = new THREE.Group();
  node_lobe_10_13.name = "Leaf 6 lateral lobe L__pivot";
  node_lobe_10_13.scale.set(1, 1, 1);
  if (endpoint_lobe_10_13) {
    node_lobe_10_13.position.copy(endpoint_lobe_10_13.start);
    node_lobe_10_13.rotation.set(0.0, -1.309, 0.0);
  } else {
    node_lobe_10_13.position.set(0.2125, 0.4675, 0.0);
    node_lobe_10_13.rotation.set(0.0, -1.309, 0.0);
  }
  node_lobe_10_13.userData.sculptComponent = {"id": "lobe-10", "name": "Leaf 6 lateral lobe L", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Small lateral lobe of the lyrate leaf on the upper petiole.", "geometryDescriptor": {"topologyIntent": "Small lateral lobe of the lyrate leaf on the upper petiole. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.004, "rz": 0.004, "twist": 0}, {"position": [0.0176, 0.0086, 0.0], "rx": 0.0032, "rz": 0.0032, "twist": 0}, {"position": [0.0273, 0.0134, 0.0], "rx": 0.0144, "rz": 0.012, "twist": -20}, {"position": [0.0458, 0.0185, 0.0], "rx": 0.0409, "rz": 0.0122, "twist": -20}, {"position": [0.0644, 0.0175, 0.0], "rx": 0.0436, "rz": 0.0131, "twist": -20}, {"position": [0.0829, 0.0104, 0.0], "rx": 0.0365, "rz": 0.012, "twist": -20}, {"position": [0.1015, -0.0027, 0.0], "rx": 0.0223, "rz": 0.012, "twist": -20}, {"position": [0.12, -0.022, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false}}, "parent": "leaf-5", "attachment": {"parentId": "leaf-5", "parentSocket": "leaf-5:node", "localStart": [0.2125, 0.4675, 0.0], "localEnd": [0.2436, 0.4455, 0.1159], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.2125, 0.4675, 0.0], "rotation": [0, -1.309, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lobe-10", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(79, 138, 58, 1.0)", "secondaryAlbedo": "rgba(47, 90, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_lobe_10_13.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lobe-10", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["leaf-5"] ?? root).add(node_lobe_10_13);
  nodes["lobe-10"] = node_lobe_10_13;
  const mesh_lobe_10_13Geometry = endpoint_lobe_10_13
    ? new THREE.CylinderGeometry(endpoint_lobe_10_13.endRadius, endpoint_lobe_10_13.baseRadius, endpoint_lobe_10_13.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.004, "rz": 0.004, "twist": 0}, {"position": [0.0176, 0.0086, 0.0], "rx": 0.0032, "rz": 0.0032, "twist": 0}, {"position": [0.0273, 0.0134, 0.0], "rx": 0.0144, "rz": 0.012, "twist": -20}, {"position": [0.0458, 0.0185, 0.0], "rx": 0.0409, "rz": 0.0122, "twist": -20}, {"position": [0.0644, 0.0175, 0.0], "rx": 0.0436, "rz": 0.0131, "twist": -20}, {"position": [0.0829, 0.0104, 0.0], "rx": 0.0365, "rz": 0.012, "twist": -20}, {"position": [0.1015, -0.0027, 0.0], "rx": 0.0223, "rz": 0.012, "twist": -20}, {"position": [0.12, -0.022, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_lobe_10_13) {
    mesh_lobe_10_13Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_lobe_10_13 = new THREE.Mesh(
    mesh_lobe_10_13Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_lobe_10_13.name = "Leaf 6 lateral lobe L";
  if (endpoint_lobe_10_13) {
    mesh_lobe_10_13.position.copy(endpoint_lobe_10_13.midpoint);
    mesh_lobe_10_13.quaternion.copy(endpoint_lobe_10_13.quaternion);
  }
  mesh_lobe_10_13.castShadow = options.castShadow ?? true;
  mesh_lobe_10_13.receiveShadow = options.receiveShadow ?? true;
  mesh_lobe_10_13.userData.sculptComponent = {"id": "lobe-10", "name": "Leaf 6 lateral lobe L", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Small lateral lobe of the lyrate leaf on the upper petiole.", "geometryDescriptor": {"topologyIntent": "Small lateral lobe of the lyrate leaf on the upper petiole. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.004, "rz": 0.004, "twist": 0}, {"position": [0.0176, 0.0086, 0.0], "rx": 0.0032, "rz": 0.0032, "twist": 0}, {"position": [0.0273, 0.0134, 0.0], "rx": 0.0144, "rz": 0.012, "twist": -20}, {"position": [0.0458, 0.0185, 0.0], "rx": 0.0409, "rz": 0.0122, "twist": -20}, {"position": [0.0644, 0.0175, 0.0], "rx": 0.0436, "rz": 0.0131, "twist": -20}, {"position": [0.0829, 0.0104, 0.0], "rx": 0.0365, "rz": 0.012, "twist": -20}, {"position": [0.1015, -0.0027, 0.0], "rx": 0.0223, "rz": 0.012, "twist": -20}, {"position": [0.12, -0.022, 0.0], "rx": 0.0, "rz": 0.0, "twist": -20}], "radialSegments": 4, "capEnds": false}}, "parent": "leaf-5", "attachment": {"parentId": "leaf-5", "parentSocket": "leaf-5:node", "localStart": [0.2125, 0.4675, 0.0], "localEnd": [0.2436, 0.4455, 0.1159], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.2125, 0.4675, 0.0], "rotation": [0, -1.309, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "lobe-10", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(79, 138, 58, 1.0)", "secondaryAlbedo": "rgba(47, 90, 37, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_lobe_10_13.add(mesh_lobe_10_13);
  meshes["lobe-10"] = mesh_lobe_10_13;
  colliders["lobe-10"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["lobe-10"] ??= [];
  destructionGroups["lobe-10"].push(node_lobe_10_13);
  // repetition system "leaf-rosette" describes 6 parts that are already built individually; not instanced.

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createRadishPlantLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Radish plant look-dev lights";
  const hemi = new THREE.HemisphereLight(
    mode === 'reference' ? 0xfff0d6 : 0xf2f4ff,
    0x363b42,
    mode === 'grazing' ? 0.28 : mode === 'reference' ? 0.72 : 0.85,
  );
  lights.add(hemi);
  const key = new THREE.DirectionalLight(
    mode === 'reference' ? 0xffcf8a : 0xfff4e8,
    mode === 'grazing' ? 4.2 : mode === 'reference' ? 2.6 : 2.15,
  );
  if (mode === 'grazing') key.position.set(7.5, 1.1, 4.0);
  else if (mode === 'reference') key.position.set(-4.5, 7.5, 5.0);
  else key.position.set(-4.0, 6.0, 5.5);
  key.castShadow = true;
  key.shadow.mapSize.set(4096, 4096);
  key.shadow.bias = -0.00025;
  key.shadow.normalBias = 0.018;
  key.shadow.radius = 7;
  key.shadow.blurSamples = 24;
  key.shadow.camera.near = 0.5;
  key.shadow.camera.far = 30;
  key.shadow.camera.left = -2.6;
  key.shadow.camera.right = 2.6;
  key.shadow.camera.top = 2.6;
  key.shadow.camera.bottom = -2.6;
  key.shadow.camera.updateProjectionMatrix();
  lights.add(key);
  const fill = new THREE.DirectionalLight(0xa8c4ff, mode === 'grazing' ? 0.12 : 0.42);
  fill.position.set(4.0, 3.0, 3.5);
  lights.add(fill);
  const rim = new THREE.DirectionalLight(0xfff1c4, mode === 'grazing' ? 0.28 : 0.85);
  rim.position.set(0.5, 4.5, -6.0);
  lights.add(rim);
  lights.userData.reviewMode = mode;
  lights.userData.lightingFromPhoto = [{"id": "key", "type": "softbox", "direction": "front-top-left", "intensity": "high", "color": "#FFFFFF", "evidence": "sharp highlight upper-left of the root globe", "hostMapping": "DirectionalLight (3,7,4) 2.2"}, {"id": "fill", "type": "low fill", "direction": "front", "intensity": "low", "color": "#FFFFFF", "evidence": "black seamless background, deep shadows on leaf undersides", "hostMapping": "HemisphereLight 1.6 + Ambient 0.9 (app is brighter than the studio photo)"}, {"id": "rim", "type": "none/edge", "direction": "behind", "intensity": "low", "color": "#FFFFFF", "evidence": "faint edge light on petioles", "hostMapping": "none"}, {"id": "exposure-shadow", "type": "render settings", "exposure": "neutral 1.0, sRGB, no tone mapping (host renderer)", "contactShadow": "root and leaves cast soft contact shadow on the soil disc; AO at the soil line", "evidence": "app context"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createRadishPlantEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  const texture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  pmrem.dispose();
  return texture;
}

// Plan 1.3 §3.2 — auto-framing by bounding box. The Divine Eye can only compare a
// render to the reference if the object is FRAMED consistently (an object framed
// differently scores as wrong even when its shape is right). This positions the camera
// deterministically from the object's bounding box so it fills the frame at a stable
// margin, and sets near/far to the object scale. Call after adding the model to the
// scene, and again on resize (after updating camera.aspect).
export function frameRadishPlantCamera(
  camera: THREE.PerspectiveCamera,
  object: THREE.Object3D,
  options: { margin?: number; azimuthDeg?: number; elevationDeg?: number } = {},
): void {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const margin = options.margin ?? 1.15;
  const maxDim = Math.max(size.x, size.y, size.z) * margin;
  const fov = (camera.fov * Math.PI) / 180;
  // distance so the largest object dimension fits vertically in the frame
  const distance = (maxDim / 2) / Math.tan(fov / 2);
  const az = ((options.azimuthDeg ?? 0) * Math.PI) / 180;
  const el = ((options.elevationDeg ?? 0) * Math.PI) / 180;
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(el),
    Math.sin(el),
    Math.cos(az) * Math.cos(el),
  );
  camera.position.copy(center).addScaledVector(dir, distance);
  camera.near = Math.max(0.01, distance - maxDim);
  camera.far = distance + maxDim * 2;
  camera.lookAt(center);
  camera.updateProjectionMatrix();
}

// Plan 1.3 §3.2c — PRESENTATION composer (DOF + bloom). CRITICAL (R-POSTFX): this is
// for the showcase/hero render ONLY. The Divine Eye's EVALUATION render MUST use a
// plain renderer with NO composer — bloom blows highlights and DOF blurs edges, which
// would corrupt the deterministic IoU/DCD/edge/blowout signals. Enable dof/bloom ONLY
// when the reference photo actually exhibits them (detect_reference_effects.py authorizes).
export function createRadishPlantPresentationComposer(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  options: { dof?: boolean; bloom?: boolean; bloomStrength?: number; dofFocus?: number; dofAperture?: number } = {},
): EffectComposer {
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  if (options.dof) {
    composer.addPass(new BokehPass(scene, camera, {
      focus: options.dofFocus ?? 10.0,
      aperture: options.dofAperture ?? 0.0002,
      maxblur: 0.01,
    }));
  }
  if (options.bloom) {
    const size = new THREE.Vector2();
    renderer.getSize(size);
    composer.addPass(new UnrealBloomPass(size, options.bloomStrength ?? 0.4, 0.4, 0.85));
  }
  return composer;
}

export function configureRadishPlantRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createRadishPlantInspectControls(
  camera: THREE.Camera,
  domElement: HTMLElement,
): OrbitControls {
  // View-dependent finishes only read correctly once the user orbits — their color
  // comes from the environment reflection, not albedo, so free rotation matters here.
  const controls = new OrbitControls(camera, domElement);
  controls.enableDamping = true;
  controls.minDistance = 1.0;
  controls.maxDistance = 8.0;
  controls.autoRotate = false;
  return controls;
}
