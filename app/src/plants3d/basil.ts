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

// Generated from ObjectSculptSpec target: Basil plant
// Sculpt build pass: optimization-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createBasilPlantModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Basil plant";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["leaf"] = createSculptMaterial(
    "leaf",
    {"id": "leaf", "name": "Basil leaf (satin cuticle)", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#5DBB5A", "color": "#5DBB5A", "albedo": {"dominant": "#5DBB5A", "secondary": ["#5E9E33", "#9FD266"], "samplingNotes": "Sampled from reference regions; see image-analysis.md L6."}, "colorVariation": {"palette": ["#5DBB5A"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.55, "variation": 0.08, "map": "independent-procedural-field", "localResponse": "satin on lit faces, rougher toward margins"}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "young-tint", "region": "apical tuft leaves", "effect": "albedo lighter #9BD25E", "evidenceRefs": ["full-object"]}, {"id": "edge-lighten", "region": "thin leaf margins", "effect": "albedo +8% value where backlit", "evidenceRefs": ["full-object"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "doubleSided": true, "clearcoat": {"base": 0.05, "variation": 0.02}, "flatShading": true, "textureless": {"declared": true, "evidence": ["Style target is the host scene: Kenney Nature Kit models in Garden3D.tsx are flat-shaded solid-colour materials with no texture maps (measured: no map/normalMap on any Kenney material after GLTFLoader).", "User directive 2026-10-08: match the scene style (bigger, simpler, fewer details)."]}},
    options
  );
  materialMap["leaf-young"] = createSculptMaterial(
    "leaf-young",
    {"id": "leaf-young", "name": "Basil young apical leaf", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#8FD16A", "color": "#8FD16A", "albedo": {"dominant": "#8FD16A", "secondary": ["#86C64E"], "samplingNotes": "Sampled from reference regions; see image-analysis.md L6."}, "colorVariation": {"palette": ["#8FD16A"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.5, "variation": 0.08, "map": "independent-procedural-field", "localResponse": "satin on lit faces, rougher toward margins"}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "doubleSided": true, "clearcoat": {"base": 0.05, "variation": 0.02}, "flatShading": true, "textureless": {"declared": true, "evidence": ["Style target is the host scene: Kenney Nature Kit models in Garden3D.tsx are flat-shaded solid-colour materials with no texture maps (measured: no map/normalMap on any Kenney material after GLTFLoader).", "User directive 2026-10-08: match the scene style (bigger, simpler, fewer details)."]}},
    options
  );
  materialMap["stem"] = createSculptMaterial(
    "stem",
    {"id": "stem", "name": "Basil stem/petiole", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#4E9A45", "color": "#4E9A45", "albedo": {"dominant": "#4E9A45", "secondary": ["#6E9E3E"], "samplingNotes": "Sampled from reference regions; see image-analysis.md L6."}, "colorVariation": {"palette": ["#4E9A45"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.6, "variation": 0.08, "map": "independent-procedural-field", "localResponse": "satin on lit faces, rougher toward margins"}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "doubleSided": false, "flatShading": true, "textureless": {"declared": true, "evidence": ["Style target is the host scene: Kenney Nature Kit models in Garden3D.tsx are flat-shaded solid-colour materials with no texture maps (measured: no map/normalMap on any Kenney material after GLTFLoader).", "User directive 2026-10-08: match the scene style (bigger, simpler, fewer details)."]}},
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
  node_soil_disc_0.userData.sculptComponent = {"id": "soil-disc", "name": "Soil disc", "level": "macro", "role": "base", "importance": 0.5, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Flat soil disc the plant is rooted in; seats into any host pot.", "geometryDescriptor": {"topologyIntent": "Flat soil disc the plant is rooted in; seats into any host pot. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 0.92, "height": 0.06, "depth": 0.92, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.03, 0], "rotation": [0, 0, 0], "scale": [0.92, 0.06, 0.92]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soil-disc", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "soil", "materialLayers": ["soil"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "perlite-flecks", "kind": "stain", "description": "pale perlite flecks on dark soil", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.95, "microRoughness": 0.2, "bumpAmplitude": 0.02, "normalPattern": "granular crumbs (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "contact shadow and AO under the crown and around the stem base", "edgeWearPattern": "", "notes": "matte granular top; perlite flecks via albedo map"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 28, 20, 1.0)", "secondaryAlbedo": "rgba(58, 40, 28, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
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
  mesh_soil_disc_0.userData.sculptComponent = {"id": "soil-disc", "name": "Soil disc", "level": "macro", "role": "base", "importance": 0.5, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Flat soil disc the plant is rooted in; seats into any host pot.", "geometryDescriptor": {"topologyIntent": "Flat soil disc the plant is rooted in; seats into any host pot. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 0.92, "height": 0.06, "depth": 0.92, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.03, 0], "rotation": [0, 0, 0], "scale": [0.92, 0.06, 0.92]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soil-disc", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "soil", "materialLayers": ["soil"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "perlite-flecks", "kind": "stain", "description": "pale perlite flecks on dark soil", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.95, "microRoughness": 0.2, "bumpAmplitude": 0.02, "normalPattern": "granular crumbs (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "contact shadow and AO under the crown and around the stem base", "edgeWearPattern": "", "notes": "matte granular top; perlite flecks via albedo map"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 28, 20, 1.0)", "secondaryAlbedo": "rgba(58, 40, 28, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_soil_disc_0.add(mesh_soil_disc_0);
  meshes["soil-disc"] = mesh_soil_disc_0;
  colliders["soil-disc"] = {"type": "cylinder", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["soil-disc"] ??= [];
  destructionGroups["soil-disc"].push(node_soil_disc_0);

  const endpoint_stem_main_1 = makeAttachmentEndpoint(null);
  const node_stem_main_1 = new THREE.Group();
  node_stem_main_1.name = "Main stem__pivot";
  node_stem_main_1.scale.set(1, 1, 1);
  if (endpoint_stem_main_1) {
    node_stem_main_1.position.copy(endpoint_stem_main_1.start);
    node_stem_main_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_stem_main_1.position.set(0.0, 0.03, 0.0);
    node_stem_main_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_stem_main_1.userData.sculptComponent = {"id": "stem-main", "name": "Main stem", "level": "macro", "role": "stem", "importance": 0.9, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Single upright tapered stem, slight S-curve, embedded in soil.", "geometryDescriptor": {"topologyIntent": "Single upright tapered stem, slight S-curve, embedded in soil. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [-0.0015, -0.03, 0.0], "rx": 0.02, "rz": 0.02, "twist": 0}, {"position": [0.011, 0.25, 0.0], "rx": 0.017, "rz": 0.017, "twist": 0}, {"position": [0.0149, 0.5, 0.0], "rx": 0.013, "rz": 0.013, "twist": 0}, {"position": [0.0092, 0.75, 0.0], "rx": 0.01, "rz": 0.01, "twist": 0}, {"position": [0.0, 0.95, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "soil-disc", "attachment": {"parentId": "soil-disc", "parentSocket": "soil-disc:node", "localStart": [0, 0.03, 0], "localEnd": [0.0, 0.98, 0], "contactType": "embed", "embedDepth": 0.05, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0, 0.03, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stem-main", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "decussate-nodes", "kind": "fastener", "description": "opposite leaf pairs, each pair rotated 90 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.05, "bumpAmplitude": 0.0, "normalPattern": "smooth with faint longitudinal ridges", "displacementPattern": "", "occlusionPattern": "slight AO at leaf nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 190, 90, 1.0)", "secondaryAlbedo": "rgba(110, 158, 62, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_stem_main_1.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stem-main", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["soil-disc"] ?? root).add(node_stem_main_1);
  nodes["stem-main"] = node_stem_main_1;
  const mesh_stem_main_1Geometry = endpoint_stem_main_1
    ? new THREE.CylinderGeometry(endpoint_stem_main_1.endRadius, endpoint_stem_main_1.baseRadius, endpoint_stem_main_1.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [-0.0015, -0.03, 0.0], "rx": 0.02, "rz": 0.02, "twist": 0}, {"position": [0.011, 0.25, 0.0], "rx": 0.017, "rz": 0.017, "twist": 0}, {"position": [0.0149, 0.5, 0.0], "rx": 0.013, "rz": 0.013, "twist": 0}, {"position": [0.0092, 0.75, 0.0], "rx": 0.01, "rz": 0.01, "twist": 0}, {"position": [0.0, 0.95, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 5, "capEnds": true});
  if (!endpoint_stem_main_1) {
    mesh_stem_main_1Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_stem_main_1 = new THREE.Mesh(
    mesh_stem_main_1Geometry,
    materialMap["stem"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_stem_main_1.name = "Main stem";
  if (endpoint_stem_main_1) {
    mesh_stem_main_1.position.copy(endpoint_stem_main_1.midpoint);
    mesh_stem_main_1.quaternion.copy(endpoint_stem_main_1.quaternion);
  }
  mesh_stem_main_1.castShadow = options.castShadow ?? true;
  mesh_stem_main_1.receiveShadow = options.receiveShadow ?? true;
  mesh_stem_main_1.userData.sculptComponent = {"id": "stem-main", "name": "Main stem", "level": "macro", "role": "stem", "importance": 0.9, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Single upright tapered stem, slight S-curve, embedded in soil.", "geometryDescriptor": {"topologyIntent": "Single upright tapered stem, slight S-curve, embedded in soil. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [-0.0015, -0.03, 0.0], "rx": 0.02, "rz": 0.02, "twist": 0}, {"position": [0.011, 0.25, 0.0], "rx": 0.017, "rz": 0.017, "twist": 0}, {"position": [0.0149, 0.5, 0.0], "rx": 0.013, "rz": 0.013, "twist": 0}, {"position": [0.0092, 0.75, 0.0], "rx": 0.01, "rz": 0.01, "twist": 0}, {"position": [0.0, 0.95, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "soil-disc", "attachment": {"parentId": "soil-disc", "parentSocket": "soil-disc:node", "localStart": [0, 0.03, 0], "localEnd": [0.0, 0.98, 0], "contactType": "embed", "embedDepth": 0.05, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0, 0.03, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stem-main", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "decussate-nodes", "kind": "fastener", "description": "opposite leaf pairs, each pair rotated 90 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.05, "bumpAmplitude": 0.0, "normalPattern": "smooth with faint longitudinal ridges", "displacementPattern": "", "occlusionPattern": "slight AO at leaf nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 190, 90, 1.0)", "secondaryAlbedo": "rgba(110, 158, 62, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_stem_main_1.add(mesh_stem_main_1);
  meshes["stem-main"] = mesh_stem_main_1;
  colliders["stem-main"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["stem-main"] ??= [];
  destructionGroups["stem-main"].push(node_stem_main_1);

  const endpoint_leaf_00_2 = makeAttachmentEndpoint(null);
  const node_leaf_00_2 = new THREE.Group();
  node_leaf_00_2.name = "Leaf pair 1 A__pivot";
  node_leaf_00_2.scale.set(1, 1, 1);
  if (endpoint_leaf_00_2) {
    node_leaf_00_2.position.copy(endpoint_leaf_00_2.start);
    node_leaf_00_2.rotation.set(0.0, 0.0873, 0.0);
  } else {
    node_leaf_00_2.position.set(0.0039, 0.08, 0.0);
    node_leaf_00_2.rotation.set(0.0, 0.0873, 0.0);
  }
  node_leaf_00_2.userData.sculptComponent = {"id": "leaf-00", "name": "Leaf pair 1 A", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section.", "geometryDescriptor": {"topologyIntent": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.047, 0.0115, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0618, 0.0151, 0.0], "rx": 0.02, "rz": 0.012, "twist": -35}, {"position": [0.0895, 0.0189, 0.0], "rx": 0.0571, "rz": 0.0202, "twist": -35}, {"position": [0.1171, 0.0181, 0.0], "rx": 0.0606, "rz": 0.0214, "twist": -35}, {"position": [0.1447, 0.0128, 0.0], "rx": 0.0507, "rz": 0.018, "twist": -35}, {"position": [0.1724, 0.003, 0.0], "rx": 0.0311, "rz": 0.012, "twist": -35}, {"position": [0.2, -0.0113, 0.0], "rx": 0.0, "rz": 0.0, "twist": -35}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0039, 0.08, 0.0], "localEnd": [0.2031, 0.0687, -0.0174], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0039, 0.08, 0.0], "rotation": [0, 0.0873, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-00", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "midrib-fold", "kind": "linework", "description": "lamina folded along midrib", "evidenceRefs": ["full-object"]}, {"id": "cup-camber", "kind": "bevel", "description": "convex cupped lamina, margins down", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "tip recurves down", "evidenceRefs": ["full-object"]}, {"id": "petiole", "kind": "seam", "description": "petiole stands leaf off the stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "midrib groove + faint pinnate lateral veins (reference-derived normal map, strength 0.35)", "displacementPattern": "", "occlusionPattern": "darker at the petiole junction and inside the cup", "edgeWearPattern": "", "notes": "satin cuticle; no displacement (veins do not change the silhouette at in-app scale)"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_00_2.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-00", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_leaf_00_2);
  nodes["leaf-00"] = node_leaf_00_2;
  const mesh_leaf_00_2Geometry = endpoint_leaf_00_2
    ? new THREE.CylinderGeometry(endpoint_leaf_00_2.endRadius, endpoint_leaf_00_2.baseRadius, endpoint_leaf_00_2.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.047, 0.0115, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0618, 0.0151, 0.0], "rx": 0.02, "rz": 0.012, "twist": -35}, {"position": [0.0895, 0.0189, 0.0], "rx": 0.0571, "rz": 0.0202, "twist": -35}, {"position": [0.1171, 0.0181, 0.0], "rx": 0.0606, "rz": 0.0214, "twist": -35}, {"position": [0.1447, 0.0128, 0.0], "rx": 0.0507, "rz": 0.018, "twist": -35}, {"position": [0.1724, 0.003, 0.0], "rx": 0.0311, "rz": 0.012, "twist": -35}, {"position": [0.2, -0.0113, 0.0], "rx": 0.0, "rz": 0.0, "twist": -35}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaf_00_2) {
    mesh_leaf_00_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaf_00_2 = new THREE.Mesh(
    mesh_leaf_00_2Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaf_00_2.name = "Leaf pair 1 A";
  if (endpoint_leaf_00_2) {
    mesh_leaf_00_2.position.copy(endpoint_leaf_00_2.midpoint);
    mesh_leaf_00_2.quaternion.copy(endpoint_leaf_00_2.quaternion);
  }
  mesh_leaf_00_2.castShadow = options.castShadow ?? true;
  mesh_leaf_00_2.receiveShadow = options.receiveShadow ?? true;
  mesh_leaf_00_2.userData.sculptComponent = {"id": "leaf-00", "name": "Leaf pair 1 A", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section.", "geometryDescriptor": {"topologyIntent": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.047, 0.0115, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0618, 0.0151, 0.0], "rx": 0.02, "rz": 0.012, "twist": -35}, {"position": [0.0895, 0.0189, 0.0], "rx": 0.0571, "rz": 0.0202, "twist": -35}, {"position": [0.1171, 0.0181, 0.0], "rx": 0.0606, "rz": 0.0214, "twist": -35}, {"position": [0.1447, 0.0128, 0.0], "rx": 0.0507, "rz": 0.018, "twist": -35}, {"position": [0.1724, 0.003, 0.0], "rx": 0.0311, "rz": 0.012, "twist": -35}, {"position": [0.2, -0.0113, 0.0], "rx": 0.0, "rz": 0.0, "twist": -35}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0039, 0.08, 0.0], "localEnd": [0.2031, 0.0687, -0.0174], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0039, 0.08, 0.0], "rotation": [0, 0.0873, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-00", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "midrib-fold", "kind": "linework", "description": "lamina folded along midrib", "evidenceRefs": ["full-object"]}, {"id": "cup-camber", "kind": "bevel", "description": "convex cupped lamina, margins down", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "tip recurves down", "evidenceRefs": ["full-object"]}, {"id": "petiole", "kind": "seam", "description": "petiole stands leaf off the stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "midrib groove + faint pinnate lateral veins (reference-derived normal map, strength 0.35)", "displacementPattern": "", "occlusionPattern": "darker at the petiole junction and inside the cup", "edgeWearPattern": "", "notes": "satin cuticle; no displacement (veins do not change the silhouette at in-app scale)"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_00_2.add(mesh_leaf_00_2);
  meshes["leaf-00"] = mesh_leaf_00_2;
  colliders["leaf-00"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaf-00"] ??= [];
  destructionGroups["leaf-00"].push(node_leaf_00_2);

  const endpoint_leaf_01_3 = makeAttachmentEndpoint(null);
  const node_leaf_01_3 = new THREE.Group();
  node_leaf_01_3.name = "Leaf pair 1 B__pivot";
  node_leaf_01_3.scale.set(1, 1, 1);
  if (endpoint_leaf_01_3) {
    node_leaf_01_3.position.copy(endpoint_leaf_01_3.start);
    node_leaf_01_3.rotation.set(0.0, 3.0194, 0.0);
  } else {
    node_leaf_01_3.position.set(0.0039, 0.08, 0.0);
    node_leaf_01_3.rotation.set(0.0, 3.0194, 0.0);
  }
  node_leaf_01_3.userData.sculptComponent = {"id": "leaf-01", "name": "Leaf pair 1 B", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section.", "geometryDescriptor": {"topologyIntent": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0498, 0.0122, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0655, 0.016, 0.0], "rx": 0.0212, "rz": 0.012, "twist": 35}, {"position": [0.0948, 0.02, 0.0], "rx": 0.0605, "rz": 0.0214, "twist": 35}, {"position": [0.1241, 0.0192, 0.0], "rx": 0.0642, "rz": 0.0229, "twist": 35}, {"position": [0.1534, 0.0136, 0.0], "rx": 0.0537, "rz": 0.0191, "twist": 35}, {"position": [0.1826, 0.0032, 0.0], "rx": 0.0329, "rz": 0.012, "twist": 35}, {"position": [0.2119, -0.012, 0.0], "rx": 0.0, "rz": 0.0, "twist": 35}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0039, 0.08, 0.0], "localEnd": [-0.2064, 0.068, -0.0258], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0039, 0.08, 0.0], "rotation": [0, 3.0194, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "midrib-fold", "kind": "linework", "description": "lamina folded along midrib", "evidenceRefs": ["full-object"]}, {"id": "cup-camber", "kind": "bevel", "description": "convex cupped lamina, margins down", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "tip recurves down", "evidenceRefs": ["full-object"]}, {"id": "petiole", "kind": "seam", "description": "petiole stands leaf off the stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "midrib groove + faint pinnate lateral veins (reference-derived normal map, strength 0.35)", "displacementPattern": "", "occlusionPattern": "darker at the petiole junction and inside the cup", "edgeWearPattern": "", "notes": "satin cuticle; no displacement (veins do not change the silhouette at in-app scale)"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_01_3.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_leaf_01_3);
  nodes["leaf-01"] = node_leaf_01_3;
  const mesh_leaf_01_3Geometry = endpoint_leaf_01_3
    ? new THREE.CylinderGeometry(endpoint_leaf_01_3.endRadius, endpoint_leaf_01_3.baseRadius, endpoint_leaf_01_3.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0498, 0.0122, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0655, 0.016, 0.0], "rx": 0.0212, "rz": 0.012, "twist": 35}, {"position": [0.0948, 0.02, 0.0], "rx": 0.0605, "rz": 0.0214, "twist": 35}, {"position": [0.1241, 0.0192, 0.0], "rx": 0.0642, "rz": 0.0229, "twist": 35}, {"position": [0.1534, 0.0136, 0.0], "rx": 0.0537, "rz": 0.0191, "twist": 35}, {"position": [0.1826, 0.0032, 0.0], "rx": 0.0329, "rz": 0.012, "twist": 35}, {"position": [0.2119, -0.012, 0.0], "rx": 0.0, "rz": 0.0, "twist": 35}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaf_01_3) {
    mesh_leaf_01_3Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaf_01_3 = new THREE.Mesh(
    mesh_leaf_01_3Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaf_01_3.name = "Leaf pair 1 B";
  if (endpoint_leaf_01_3) {
    mesh_leaf_01_3.position.copy(endpoint_leaf_01_3.midpoint);
    mesh_leaf_01_3.quaternion.copy(endpoint_leaf_01_3.quaternion);
  }
  mesh_leaf_01_3.castShadow = options.castShadow ?? true;
  mesh_leaf_01_3.receiveShadow = options.receiveShadow ?? true;
  mesh_leaf_01_3.userData.sculptComponent = {"id": "leaf-01", "name": "Leaf pair 1 B", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section.", "geometryDescriptor": {"topologyIntent": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0498, 0.0122, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0655, 0.016, 0.0], "rx": 0.0212, "rz": 0.012, "twist": 35}, {"position": [0.0948, 0.02, 0.0], "rx": 0.0605, "rz": 0.0214, "twist": 35}, {"position": [0.1241, 0.0192, 0.0], "rx": 0.0642, "rz": 0.0229, "twist": 35}, {"position": [0.1534, 0.0136, 0.0], "rx": 0.0537, "rz": 0.0191, "twist": 35}, {"position": [0.1826, 0.0032, 0.0], "rx": 0.0329, "rz": 0.012, "twist": 35}, {"position": [0.2119, -0.012, 0.0], "rx": 0.0, "rz": 0.0, "twist": 35}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0039, 0.08, 0.0], "localEnd": [-0.2064, 0.068, -0.0258], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0039, 0.08, 0.0], "rotation": [0, 3.0194, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "midrib-fold", "kind": "linework", "description": "lamina folded along midrib", "evidenceRefs": ["full-object"]}, {"id": "cup-camber", "kind": "bevel", "description": "convex cupped lamina, margins down", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "tip recurves down", "evidenceRefs": ["full-object"]}, {"id": "petiole", "kind": "seam", "description": "petiole stands leaf off the stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "midrib groove + faint pinnate lateral veins (reference-derived normal map, strength 0.35)", "displacementPattern": "", "occlusionPattern": "darker at the petiole junction and inside the cup", "edgeWearPattern": "", "notes": "satin cuticle; no displacement (veins do not change the silhouette at in-app scale)"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_01_3.add(mesh_leaf_01_3);
  meshes["leaf-01"] = mesh_leaf_01_3;
  colliders["leaf-01"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaf-01"] ??= [];
  destructionGroups["leaf-01"].push(node_leaf_01_3);

  const endpoint_leaf_02_4 = makeAttachmentEndpoint(null);
  const node_leaf_02_4 = new THREE.Group();
  node_leaf_02_4.name = "Leaf pair 2 A__pivot";
  node_leaf_02_4.scale.set(1, 1, 1);
  if (endpoint_leaf_02_4) {
    node_leaf_02_4.position.copy(endpoint_leaf_02_4.start);
    node_leaf_02_4.rotation.set(0.0, 1.4835, 0.0);
  } else {
    node_leaf_02_4.position.set(0.0107, 0.24, 0.0);
    node_leaf_02_4.rotation.set(0.0, 1.4835, 0.0);
  }
  node_leaf_02_4.userData.sculptComponent = {"id": "leaf-02", "name": "Leaf pair 2 A", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section.", "geometryDescriptor": {"topologyIntent": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.065, 0.0265, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0854, 0.0348, 0.0], "rx": 0.0277, "rz": 0.012, "twist": -35}, {"position": [0.1235, 0.0439, 0.0], "rx": 0.0788, "rz": 0.0279, "twist": -35}, {"position": [0.1617, 0.043, 0.0], "rx": 0.0837, "rz": 0.0297, "twist": -35}, {"position": [0.1998, 0.0321, 0.0], "rx": 0.0699, "rz": 0.0248, "twist": -35}, {"position": [0.238, 0.0112, 0.0], "rx": 0.0429, "rz": 0.0151, "twist": -35}, {"position": [0.2762, -0.0197, 0.0], "rx": 0.0, "rz": 0.0, "twist": -35}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0107, 0.24, 0.0], "localEnd": [0.0348, 0.2203, -0.2751], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0107, 0.24, 0.0], "rotation": [0, 1.4835, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "midrib-fold", "kind": "linework", "description": "lamina folded along midrib", "evidenceRefs": ["full-object"]}, {"id": "cup-camber", "kind": "bevel", "description": "convex cupped lamina, margins down", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "tip recurves down", "evidenceRefs": ["full-object"]}, {"id": "petiole", "kind": "seam", "description": "petiole stands leaf off the stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "midrib groove + faint pinnate lateral veins (reference-derived normal map, strength 0.35)", "displacementPattern": "", "occlusionPattern": "darker at the petiole junction and inside the cup", "edgeWearPattern": "", "notes": "satin cuticle; no displacement (veins do not change the silhouette at in-app scale)"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_02_4.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_leaf_02_4);
  nodes["leaf-02"] = node_leaf_02_4;
  const mesh_leaf_02_4Geometry = endpoint_leaf_02_4
    ? new THREE.CylinderGeometry(endpoint_leaf_02_4.endRadius, endpoint_leaf_02_4.baseRadius, endpoint_leaf_02_4.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.065, 0.0265, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0854, 0.0348, 0.0], "rx": 0.0277, "rz": 0.012, "twist": -35}, {"position": [0.1235, 0.0439, 0.0], "rx": 0.0788, "rz": 0.0279, "twist": -35}, {"position": [0.1617, 0.043, 0.0], "rx": 0.0837, "rz": 0.0297, "twist": -35}, {"position": [0.1998, 0.0321, 0.0], "rx": 0.0699, "rz": 0.0248, "twist": -35}, {"position": [0.238, 0.0112, 0.0], "rx": 0.0429, "rz": 0.0151, "twist": -35}, {"position": [0.2762, -0.0197, 0.0], "rx": 0.0, "rz": 0.0, "twist": -35}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaf_02_4) {
    mesh_leaf_02_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaf_02_4 = new THREE.Mesh(
    mesh_leaf_02_4Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaf_02_4.name = "Leaf pair 2 A";
  if (endpoint_leaf_02_4) {
    mesh_leaf_02_4.position.copy(endpoint_leaf_02_4.midpoint);
    mesh_leaf_02_4.quaternion.copy(endpoint_leaf_02_4.quaternion);
  }
  mesh_leaf_02_4.castShadow = options.castShadow ?? true;
  mesh_leaf_02_4.receiveShadow = options.receiveShadow ?? true;
  mesh_leaf_02_4.userData.sculptComponent = {"id": "leaf-02", "name": "Leaf pair 2 A", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section.", "geometryDescriptor": {"topologyIntent": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.065, 0.0265, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0854, 0.0348, 0.0], "rx": 0.0277, "rz": 0.012, "twist": -35}, {"position": [0.1235, 0.0439, 0.0], "rx": 0.0788, "rz": 0.0279, "twist": -35}, {"position": [0.1617, 0.043, 0.0], "rx": 0.0837, "rz": 0.0297, "twist": -35}, {"position": [0.1998, 0.0321, 0.0], "rx": 0.0699, "rz": 0.0248, "twist": -35}, {"position": [0.238, 0.0112, 0.0], "rx": 0.0429, "rz": 0.0151, "twist": -35}, {"position": [0.2762, -0.0197, 0.0], "rx": 0.0, "rz": 0.0, "twist": -35}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0107, 0.24, 0.0], "localEnd": [0.0348, 0.2203, -0.2751], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0107, 0.24, 0.0], "rotation": [0, 1.4835, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "midrib-fold", "kind": "linework", "description": "lamina folded along midrib", "evidenceRefs": ["full-object"]}, {"id": "cup-camber", "kind": "bevel", "description": "convex cupped lamina, margins down", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "tip recurves down", "evidenceRefs": ["full-object"]}, {"id": "petiole", "kind": "seam", "description": "petiole stands leaf off the stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "midrib groove + faint pinnate lateral veins (reference-derived normal map, strength 0.35)", "displacementPattern": "", "occlusionPattern": "darker at the petiole junction and inside the cup", "edgeWearPattern": "", "notes": "satin cuticle; no displacement (veins do not change the silhouette at in-app scale)"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_02_4.add(mesh_leaf_02_4);
  meshes["leaf-02"] = mesh_leaf_02_4;
  colliders["leaf-02"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaf-02"] ??= [];
  destructionGroups["leaf-02"].push(node_leaf_02_4);

  const endpoint_leaf_03_5 = makeAttachmentEndpoint(null);
  const node_leaf_03_5 = new THREE.Group();
  node_leaf_03_5.name = "Leaf pair 2 B__pivot";
  node_leaf_03_5.scale.set(1, 1, 1);
  if (endpoint_leaf_03_5) {
    node_leaf_03_5.position.copy(endpoint_leaf_03_5.start);
    node_leaf_03_5.rotation.set(0.0, 4.8346, 0.0);
  } else {
    node_leaf_03_5.position.set(0.0107, 0.24, 0.0);
    node_leaf_03_5.rotation.set(0.0, 4.8346, 0.0);
  }
  node_leaf_03_5.userData.sculptComponent = {"id": "leaf-03", "name": "Leaf pair 2 B", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section.", "geometryDescriptor": {"topologyIntent": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0738, 0.0301, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.097, 0.0396, 0.0], "rx": 0.0315, "rz": 0.012, "twist": 35}, {"position": [0.1404, 0.0499, 0.0], "rx": 0.0896, "rz": 0.0317, "twist": 35}, {"position": [0.1838, 0.0489, 0.0], "rx": 0.0952, "rz": 0.0337, "twist": 35}, {"position": [0.2271, 0.0365, 0.0], "rx": 0.0796, "rz": 0.0283, "twist": 35}, {"position": [0.2705, 0.0127, 0.0], "rx": 0.0488, "rz": 0.0173, "twist": 35}, {"position": [0.3139, -0.0223, 0.0], "rx": 0.0, "rz": 0.0, "twist": 35}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0107, 0.24, 0.0], "localEnd": [0.049, 0.2177, 0.3116], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0107, 0.24, 0.0], "rotation": [0, 4.8346, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "midrib-fold", "kind": "linework", "description": "lamina folded along midrib", "evidenceRefs": ["full-object"]}, {"id": "cup-camber", "kind": "bevel", "description": "convex cupped lamina, margins down", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "tip recurves down", "evidenceRefs": ["full-object"]}, {"id": "petiole", "kind": "seam", "description": "petiole stands leaf off the stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "midrib groove + faint pinnate lateral veins (reference-derived normal map, strength 0.35)", "displacementPattern": "", "occlusionPattern": "darker at the petiole junction and inside the cup", "edgeWearPattern": "", "notes": "satin cuticle; no displacement (veins do not change the silhouette at in-app scale)"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_03_5.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_leaf_03_5);
  nodes["leaf-03"] = node_leaf_03_5;
  const mesh_leaf_03_5Geometry = endpoint_leaf_03_5
    ? new THREE.CylinderGeometry(endpoint_leaf_03_5.endRadius, endpoint_leaf_03_5.baseRadius, endpoint_leaf_03_5.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0738, 0.0301, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.097, 0.0396, 0.0], "rx": 0.0315, "rz": 0.012, "twist": 35}, {"position": [0.1404, 0.0499, 0.0], "rx": 0.0896, "rz": 0.0317, "twist": 35}, {"position": [0.1838, 0.0489, 0.0], "rx": 0.0952, "rz": 0.0337, "twist": 35}, {"position": [0.2271, 0.0365, 0.0], "rx": 0.0796, "rz": 0.0283, "twist": 35}, {"position": [0.2705, 0.0127, 0.0], "rx": 0.0488, "rz": 0.0173, "twist": 35}, {"position": [0.3139, -0.0223, 0.0], "rx": 0.0, "rz": 0.0, "twist": 35}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaf_03_5) {
    mesh_leaf_03_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaf_03_5 = new THREE.Mesh(
    mesh_leaf_03_5Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaf_03_5.name = "Leaf pair 2 B";
  if (endpoint_leaf_03_5) {
    mesh_leaf_03_5.position.copy(endpoint_leaf_03_5.midpoint);
    mesh_leaf_03_5.quaternion.copy(endpoint_leaf_03_5.quaternion);
  }
  mesh_leaf_03_5.castShadow = options.castShadow ?? true;
  mesh_leaf_03_5.receiveShadow = options.receiveShadow ?? true;
  mesh_leaf_03_5.userData.sculptComponent = {"id": "leaf-03", "name": "Leaf pair 2 B", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section.", "geometryDescriptor": {"topologyIntent": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0738, 0.0301, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.097, 0.0396, 0.0], "rx": 0.0315, "rz": 0.012, "twist": 35}, {"position": [0.1404, 0.0499, 0.0], "rx": 0.0896, "rz": 0.0317, "twist": 35}, {"position": [0.1838, 0.0489, 0.0], "rx": 0.0952, "rz": 0.0337, "twist": 35}, {"position": [0.2271, 0.0365, 0.0], "rx": 0.0796, "rz": 0.0283, "twist": 35}, {"position": [0.2705, 0.0127, 0.0], "rx": 0.0488, "rz": 0.0173, "twist": 35}, {"position": [0.3139, -0.0223, 0.0], "rx": 0.0, "rz": 0.0, "twist": 35}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0107, 0.24, 0.0], "localEnd": [0.049, 0.2177, 0.3116], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0107, 0.24, 0.0], "rotation": [0, 4.8346, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "midrib-fold", "kind": "linework", "description": "lamina folded along midrib", "evidenceRefs": ["full-object"]}, {"id": "cup-camber", "kind": "bevel", "description": "convex cupped lamina, margins down", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "tip recurves down", "evidenceRefs": ["full-object"]}, {"id": "petiole", "kind": "seam", "description": "petiole stands leaf off the stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "midrib groove + faint pinnate lateral veins (reference-derived normal map, strength 0.35)", "displacementPattern": "", "occlusionPattern": "darker at the petiole junction and inside the cup", "edgeWearPattern": "", "notes": "satin cuticle; no displacement (veins do not change the silhouette at in-app scale)"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_03_5.add(mesh_leaf_03_5);
  meshes["leaf-03"] = mesh_leaf_03_5;
  colliders["leaf-03"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaf-03"] ??= [];
  destructionGroups["leaf-03"].push(node_leaf_03_5);

  const endpoint_leaf_04_6 = makeAttachmentEndpoint(null);
  const node_leaf_04_6 = new THREE.Group();
  node_leaf_04_6.name = "Leaf pair 3 A__pivot";
  node_leaf_04_6.scale.set(1, 1, 1);
  if (endpoint_leaf_04_6) {
    node_leaf_04_6.position.copy(endpoint_leaf_04_6.start);
    node_leaf_04_6.rotation.set(0.0, 0.2618, 0.0);
  } else {
    node_leaf_04_6.position.set(0.0145, 0.4, 0.0);
    node_leaf_04_6.rotation.set(0.0, 0.2618, 0.0);
  }
  node_leaf_04_6.userData.sculptComponent = {"id": "leaf-04", "name": "Leaf pair 3 A", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section.", "geometryDescriptor": {"topologyIntent": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.091, 0.0408, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.1195, 0.0536, 0.0], "rx": 0.0387, "rz": 0.0137, "twist": -35}, {"position": [0.173, 0.0674, 0.0], "rx": 0.1104, "rz": 0.0391, "twist": -35}, {"position": [0.2264, 0.0657, 0.0], "rx": 0.1173, "rz": 0.0416, "twist": -35}, {"position": [0.2799, 0.0485, 0.0], "rx": 0.098, "rz": 0.0347, "twist": -35}, {"position": [0.3333, 0.0157, 0.0], "rx": 0.0601, "rz": 0.0212, "twist": -35}, {"position": [0.3868, -0.0326, 0.0], "rx": 0.0, "rz": 0.0, "twist": -35}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0145, 0.4, 0.0], "localEnd": [0.3881, 0.3674, -0.1001], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0145, 0.4, 0.0], "rotation": [0, 0.2618, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "midrib-fold", "kind": "linework", "description": "lamina folded along midrib", "evidenceRefs": ["full-object"]}, {"id": "cup-camber", "kind": "bevel", "description": "convex cupped lamina, margins down", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "tip recurves down", "evidenceRefs": ["full-object"]}, {"id": "petiole", "kind": "seam", "description": "petiole stands leaf off the stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "midrib groove + faint pinnate lateral veins (reference-derived normal map, strength 0.35)", "displacementPattern": "", "occlusionPattern": "darker at the petiole junction and inside the cup", "edgeWearPattern": "", "notes": "satin cuticle; no displacement (veins do not change the silhouette at in-app scale)"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_04_6.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_leaf_04_6);
  nodes["leaf-04"] = node_leaf_04_6;
  const mesh_leaf_04_6Geometry = endpoint_leaf_04_6
    ? new THREE.CylinderGeometry(endpoint_leaf_04_6.endRadius, endpoint_leaf_04_6.baseRadius, endpoint_leaf_04_6.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.091, 0.0408, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.1195, 0.0536, 0.0], "rx": 0.0387, "rz": 0.0137, "twist": -35}, {"position": [0.173, 0.0674, 0.0], "rx": 0.1104, "rz": 0.0391, "twist": -35}, {"position": [0.2264, 0.0657, 0.0], "rx": 0.1173, "rz": 0.0416, "twist": -35}, {"position": [0.2799, 0.0485, 0.0], "rx": 0.098, "rz": 0.0347, "twist": -35}, {"position": [0.3333, 0.0157, 0.0], "rx": 0.0601, "rz": 0.0212, "twist": -35}, {"position": [0.3868, -0.0326, 0.0], "rx": 0.0, "rz": 0.0, "twist": -35}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaf_04_6) {
    mesh_leaf_04_6Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaf_04_6 = new THREE.Mesh(
    mesh_leaf_04_6Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaf_04_6.name = "Leaf pair 3 A";
  if (endpoint_leaf_04_6) {
    mesh_leaf_04_6.position.copy(endpoint_leaf_04_6.midpoint);
    mesh_leaf_04_6.quaternion.copy(endpoint_leaf_04_6.quaternion);
  }
  mesh_leaf_04_6.castShadow = options.castShadow ?? true;
  mesh_leaf_04_6.receiveShadow = options.receiveShadow ?? true;
  mesh_leaf_04_6.userData.sculptComponent = {"id": "leaf-04", "name": "Leaf pair 3 A", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section.", "geometryDescriptor": {"topologyIntent": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.091, 0.0408, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.1195, 0.0536, 0.0], "rx": 0.0387, "rz": 0.0137, "twist": -35}, {"position": [0.173, 0.0674, 0.0], "rx": 0.1104, "rz": 0.0391, "twist": -35}, {"position": [0.2264, 0.0657, 0.0], "rx": 0.1173, "rz": 0.0416, "twist": -35}, {"position": [0.2799, 0.0485, 0.0], "rx": 0.098, "rz": 0.0347, "twist": -35}, {"position": [0.3333, 0.0157, 0.0], "rx": 0.0601, "rz": 0.0212, "twist": -35}, {"position": [0.3868, -0.0326, 0.0], "rx": 0.0, "rz": 0.0, "twist": -35}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0145, 0.4, 0.0], "localEnd": [0.3881, 0.3674, -0.1001], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0145, 0.4, 0.0], "rotation": [0, 0.2618, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "midrib-fold", "kind": "linework", "description": "lamina folded along midrib", "evidenceRefs": ["full-object"]}, {"id": "cup-camber", "kind": "bevel", "description": "convex cupped lamina, margins down", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "tip recurves down", "evidenceRefs": ["full-object"]}, {"id": "petiole", "kind": "seam", "description": "petiole stands leaf off the stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "midrib groove + faint pinnate lateral veins (reference-derived normal map, strength 0.35)", "displacementPattern": "", "occlusionPattern": "darker at the petiole junction and inside the cup", "edgeWearPattern": "", "notes": "satin cuticle; no displacement (veins do not change the silhouette at in-app scale)"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_04_6.add(mesh_leaf_04_6);
  meshes["leaf-04"] = mesh_leaf_04_6;
  colliders["leaf-04"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaf-04"] ??= [];
  destructionGroups["leaf-04"].push(node_leaf_04_6);

  const endpoint_leaf_05_7 = makeAttachmentEndpoint(null);
  const node_leaf_05_7 = new THREE.Group();
  node_leaf_05_7.name = "Leaf pair 3 B__pivot";
  node_leaf_05_7.scale.set(1, 1, 1);
  if (endpoint_leaf_05_7) {
    node_leaf_05_7.position.copy(endpoint_leaf_05_7.start);
    node_leaf_05_7.rotation.set(0.0, 3.194, 0.0);
  } else {
    node_leaf_05_7.position.set(0.0145, 0.4, 0.0);
    node_leaf_05_7.rotation.set(0.0, 3.194, 0.0);
  }
  node_leaf_05_7.userData.sculptComponent = {"id": "leaf-05", "name": "Leaf pair 3 B", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section.", "geometryDescriptor": {"topologyIntent": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0831, 0.0373, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.1092, 0.049, 0.0], "rx": 0.0354, "rz": 0.0126, "twist": 35}, {"position": [0.1581, 0.0616, 0.0], "rx": 0.1008, "rz": 0.0356, "twist": 35}, {"position": [0.2069, 0.0601, 0.0], "rx": 0.1071, "rz": 0.038, "twist": 35}, {"position": [0.2557, 0.0443, 0.0], "rx": 0.0896, "rz": 0.0317, "twist": 35}, {"position": [0.3046, 0.0143, 0.0], "rx": 0.0549, "rz": 0.0194, "twist": 35}, {"position": [0.3534, -0.0298, 0.0], "rx": 0.0, "rz": 0.0, "twist": 35}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0145, 0.4, 0.0], "localEnd": [-0.3384, 0.3702, 0.0185], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0145, 0.4, 0.0], "rotation": [0, 3.194, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "midrib-fold", "kind": "linework", "description": "lamina folded along midrib", "evidenceRefs": ["full-object"]}, {"id": "cup-camber", "kind": "bevel", "description": "convex cupped lamina, margins down", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "tip recurves down", "evidenceRefs": ["full-object"]}, {"id": "petiole", "kind": "seam", "description": "petiole stands leaf off the stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "midrib groove + faint pinnate lateral veins (reference-derived normal map, strength 0.35)", "displacementPattern": "", "occlusionPattern": "darker at the petiole junction and inside the cup", "edgeWearPattern": "", "notes": "satin cuticle; no displacement (veins do not change the silhouette at in-app scale)"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_05_7.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_leaf_05_7);
  nodes["leaf-05"] = node_leaf_05_7;
  const mesh_leaf_05_7Geometry = endpoint_leaf_05_7
    ? new THREE.CylinderGeometry(endpoint_leaf_05_7.endRadius, endpoint_leaf_05_7.baseRadius, endpoint_leaf_05_7.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0831, 0.0373, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.1092, 0.049, 0.0], "rx": 0.0354, "rz": 0.0126, "twist": 35}, {"position": [0.1581, 0.0616, 0.0], "rx": 0.1008, "rz": 0.0356, "twist": 35}, {"position": [0.2069, 0.0601, 0.0], "rx": 0.1071, "rz": 0.038, "twist": 35}, {"position": [0.2557, 0.0443, 0.0], "rx": 0.0896, "rz": 0.0317, "twist": 35}, {"position": [0.3046, 0.0143, 0.0], "rx": 0.0549, "rz": 0.0194, "twist": 35}, {"position": [0.3534, -0.0298, 0.0], "rx": 0.0, "rz": 0.0, "twist": 35}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaf_05_7) {
    mesh_leaf_05_7Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaf_05_7 = new THREE.Mesh(
    mesh_leaf_05_7Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaf_05_7.name = "Leaf pair 3 B";
  if (endpoint_leaf_05_7) {
    mesh_leaf_05_7.position.copy(endpoint_leaf_05_7.midpoint);
    mesh_leaf_05_7.quaternion.copy(endpoint_leaf_05_7.quaternion);
  }
  mesh_leaf_05_7.castShadow = options.castShadow ?? true;
  mesh_leaf_05_7.receiveShadow = options.receiveShadow ?? true;
  mesh_leaf_05_7.userData.sculptComponent = {"id": "leaf-05", "name": "Leaf pair 3 B", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section.", "geometryDescriptor": {"topologyIntent": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0831, 0.0373, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.1092, 0.049, 0.0], "rx": 0.0354, "rz": 0.0126, "twist": 35}, {"position": [0.1581, 0.0616, 0.0], "rx": 0.1008, "rz": 0.0356, "twist": 35}, {"position": [0.2069, 0.0601, 0.0], "rx": 0.1071, "rz": 0.038, "twist": 35}, {"position": [0.2557, 0.0443, 0.0], "rx": 0.0896, "rz": 0.0317, "twist": 35}, {"position": [0.3046, 0.0143, 0.0], "rx": 0.0549, "rz": 0.0194, "twist": 35}, {"position": [0.3534, -0.0298, 0.0], "rx": 0.0, "rz": 0.0, "twist": 35}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0145, 0.4, 0.0], "localEnd": [-0.3384, 0.3702, 0.0185], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0145, 0.4, 0.0], "rotation": [0, 3.194, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-05", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "midrib-fold", "kind": "linework", "description": "lamina folded along midrib", "evidenceRefs": ["full-object"]}, {"id": "cup-camber", "kind": "bevel", "description": "convex cupped lamina, margins down", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "tip recurves down", "evidenceRefs": ["full-object"]}, {"id": "petiole", "kind": "seam", "description": "petiole stands leaf off the stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "midrib groove + faint pinnate lateral veins (reference-derived normal map, strength 0.35)", "displacementPattern": "", "occlusionPattern": "darker at the petiole junction and inside the cup", "edgeWearPattern": "", "notes": "satin cuticle; no displacement (veins do not change the silhouette at in-app scale)"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_05_7.add(mesh_leaf_05_7);
  meshes["leaf-05"] = mesh_leaf_05_7;
  colliders["leaf-05"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaf-05"] ??= [];
  destructionGroups["leaf-05"].push(node_leaf_05_7);

  const endpoint_leaf_06_8 = makeAttachmentEndpoint(null);
  const node_leaf_06_8 = new THREE.Group();
  node_leaf_06_8.name = "Leaf pair 4 A__pivot";
  node_leaf_06_8.scale.set(1, 1, 1);
  if (endpoint_leaf_06_8) {
    node_leaf_06_8.position.copy(endpoint_leaf_06_8.start);
    node_leaf_06_8.rotation.set(0.0, 1.6581, 0.0);
  } else {
    node_leaf_06_8.position.set(0.0144, 0.56, 0.0);
    node_leaf_06_8.rotation.set(0.0, 1.6581, 0.0);
  }
  node_leaf_06_8.userData.sculptComponent = {"id": "leaf-06", "name": "Leaf pair 4 A", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section.", "geometryDescriptor": {"topologyIntent": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.1062, 0.052, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.1396, 0.0684, 0.0], "rx": 0.0452, "rz": 0.016, "twist": -35}, {"position": [0.202, 0.0873, 0.0], "rx": 0.1288, "rz": 0.0457, "twist": -35}, {"position": [0.2645, 0.0875, 0.0], "rx": 0.1369, "rz": 0.0486, "twist": -35}, {"position": [0.3269, 0.0691, 0.0], "rx": 0.1145, "rz": 0.0405, "twist": -35}, {"position": [0.3893, 0.0321, 0.0], "rx": 0.0702, "rz": 0.0248, "twist": -35}, {"position": [0.4517, -0.0235, 0.0], "rx": 0.0, "rz": 0.0, "twist": -35}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0144, 0.56, 0.0], "localEnd": [-0.025, 0.5365, -0.45], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0144, 0.56, 0.0], "rotation": [0, 1.6581, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-06", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "midrib-fold", "kind": "linework", "description": "lamina folded along midrib", "evidenceRefs": ["full-object"]}, {"id": "cup-camber", "kind": "bevel", "description": "convex cupped lamina, margins down", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "tip recurves down", "evidenceRefs": ["full-object"]}, {"id": "petiole", "kind": "seam", "description": "petiole stands leaf off the stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "midrib groove + faint pinnate lateral veins (reference-derived normal map, strength 0.35)", "displacementPattern": "", "occlusionPattern": "darker at the petiole junction and inside the cup", "edgeWearPattern": "", "notes": "satin cuticle; no displacement (veins do not change the silhouette at in-app scale)"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_06_8.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-06", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_leaf_06_8);
  nodes["leaf-06"] = node_leaf_06_8;
  const mesh_leaf_06_8Geometry = endpoint_leaf_06_8
    ? new THREE.CylinderGeometry(endpoint_leaf_06_8.endRadius, endpoint_leaf_06_8.baseRadius, endpoint_leaf_06_8.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.1062, 0.052, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.1396, 0.0684, 0.0], "rx": 0.0452, "rz": 0.016, "twist": -35}, {"position": [0.202, 0.0873, 0.0], "rx": 0.1288, "rz": 0.0457, "twist": -35}, {"position": [0.2645, 0.0875, 0.0], "rx": 0.1369, "rz": 0.0486, "twist": -35}, {"position": [0.3269, 0.0691, 0.0], "rx": 0.1145, "rz": 0.0405, "twist": -35}, {"position": [0.3893, 0.0321, 0.0], "rx": 0.0702, "rz": 0.0248, "twist": -35}, {"position": [0.4517, -0.0235, 0.0], "rx": 0.0, "rz": 0.0, "twist": -35}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaf_06_8) {
    mesh_leaf_06_8Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaf_06_8 = new THREE.Mesh(
    mesh_leaf_06_8Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaf_06_8.name = "Leaf pair 4 A";
  if (endpoint_leaf_06_8) {
    mesh_leaf_06_8.position.copy(endpoint_leaf_06_8.midpoint);
    mesh_leaf_06_8.quaternion.copy(endpoint_leaf_06_8.quaternion);
  }
  mesh_leaf_06_8.castShadow = options.castShadow ?? true;
  mesh_leaf_06_8.receiveShadow = options.receiveShadow ?? true;
  mesh_leaf_06_8.userData.sculptComponent = {"id": "leaf-06", "name": "Leaf pair 4 A", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section.", "geometryDescriptor": {"topologyIntent": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.1062, 0.052, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.1396, 0.0684, 0.0], "rx": 0.0452, "rz": 0.016, "twist": -35}, {"position": [0.202, 0.0873, 0.0], "rx": 0.1288, "rz": 0.0457, "twist": -35}, {"position": [0.2645, 0.0875, 0.0], "rx": 0.1369, "rz": 0.0486, "twist": -35}, {"position": [0.3269, 0.0691, 0.0], "rx": 0.1145, "rz": 0.0405, "twist": -35}, {"position": [0.3893, 0.0321, 0.0], "rx": 0.0702, "rz": 0.0248, "twist": -35}, {"position": [0.4517, -0.0235, 0.0], "rx": 0.0, "rz": 0.0, "twist": -35}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0144, 0.56, 0.0], "localEnd": [-0.025, 0.5365, -0.45], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0144, 0.56, 0.0], "rotation": [0, 1.6581, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-06", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "midrib-fold", "kind": "linework", "description": "lamina folded along midrib", "evidenceRefs": ["full-object"]}, {"id": "cup-camber", "kind": "bevel", "description": "convex cupped lamina, margins down", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "tip recurves down", "evidenceRefs": ["full-object"]}, {"id": "petiole", "kind": "seam", "description": "petiole stands leaf off the stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "midrib groove + faint pinnate lateral veins (reference-derived normal map, strength 0.35)", "displacementPattern": "", "occlusionPattern": "darker at the petiole junction and inside the cup", "edgeWearPattern": "", "notes": "satin cuticle; no displacement (veins do not change the silhouette at in-app scale)"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_06_8.add(mesh_leaf_06_8);
  meshes["leaf-06"] = mesh_leaf_06_8;
  colliders["leaf-06"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaf-06"] ??= [];
  destructionGroups["leaf-06"].push(node_leaf_06_8);

  const endpoint_leaf_07_9 = makeAttachmentEndpoint(null);
  const node_leaf_07_9 = new THREE.Group();
  node_leaf_07_9.name = "Leaf pair 4 B__pivot";
  node_leaf_07_9.scale.set(1, 1, 1);
  if (endpoint_leaf_07_9) {
    node_leaf_07_9.position.copy(endpoint_leaf_07_9.start);
    node_leaf_07_9.rotation.set(0.0, 5.0091, 0.0);
  } else {
    node_leaf_07_9.position.set(0.0144, 0.56, 0.0);
    node_leaf_07_9.rotation.set(0.0, 5.0091, 0.0);
  }
  node_leaf_07_9.userData.sculptComponent = {"id": "leaf-07", "name": "Leaf pair 4 B", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section.", "geometryDescriptor": {"topologyIntent": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0958, 0.0469, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.1259, 0.0617, 0.0], "rx": 0.0408, "rz": 0.0144, "twist": 35}, {"position": [0.1821, 0.0787, 0.0], "rx": 0.1161, "rz": 0.0412, "twist": 35}, {"position": [0.2384, 0.0789, 0.0], "rx": 0.1235, "rz": 0.0437, "twist": 35}, {"position": [0.2946, 0.0623, 0.0], "rx": 0.1032, "rz": 0.0365, "twist": 35}, {"position": [0.3509, 0.029, 0.0], "rx": 0.0633, "rz": 0.0225, "twist": 35}, {"position": [0.4072, -0.0212, 0.0], "rx": 0.0, "rz": 0.0, "twist": 35}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0144, 0.56, 0.0], "localEnd": [0.1335, 0.5388, 0.3894], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0144, 0.56, 0.0], "rotation": [0, 5.0091, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-07", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "midrib-fold", "kind": "linework", "description": "lamina folded along midrib", "evidenceRefs": ["full-object"]}, {"id": "cup-camber", "kind": "bevel", "description": "convex cupped lamina, margins down", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "tip recurves down", "evidenceRefs": ["full-object"]}, {"id": "petiole", "kind": "seam", "description": "petiole stands leaf off the stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "midrib groove + faint pinnate lateral veins (reference-derived normal map, strength 0.35)", "displacementPattern": "", "occlusionPattern": "darker at the petiole junction and inside the cup", "edgeWearPattern": "", "notes": "satin cuticle; no displacement (veins do not change the silhouette at in-app scale)"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_07_9.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-07", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_leaf_07_9);
  nodes["leaf-07"] = node_leaf_07_9;
  const mesh_leaf_07_9Geometry = endpoint_leaf_07_9
    ? new THREE.CylinderGeometry(endpoint_leaf_07_9.endRadius, endpoint_leaf_07_9.baseRadius, endpoint_leaf_07_9.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0958, 0.0469, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.1259, 0.0617, 0.0], "rx": 0.0408, "rz": 0.0144, "twist": 35}, {"position": [0.1821, 0.0787, 0.0], "rx": 0.1161, "rz": 0.0412, "twist": 35}, {"position": [0.2384, 0.0789, 0.0], "rx": 0.1235, "rz": 0.0437, "twist": 35}, {"position": [0.2946, 0.0623, 0.0], "rx": 0.1032, "rz": 0.0365, "twist": 35}, {"position": [0.3509, 0.029, 0.0], "rx": 0.0633, "rz": 0.0225, "twist": 35}, {"position": [0.4072, -0.0212, 0.0], "rx": 0.0, "rz": 0.0, "twist": 35}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaf_07_9) {
    mesh_leaf_07_9Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaf_07_9 = new THREE.Mesh(
    mesh_leaf_07_9Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaf_07_9.name = "Leaf pair 4 B";
  if (endpoint_leaf_07_9) {
    mesh_leaf_07_9.position.copy(endpoint_leaf_07_9.midpoint);
    mesh_leaf_07_9.quaternion.copy(endpoint_leaf_07_9.quaternion);
  }
  mesh_leaf_07_9.castShadow = options.castShadow ?? true;
  mesh_leaf_07_9.receiveShadow = options.receiveShadow ?? true;
  mesh_leaf_07_9.userData.sculptComponent = {"id": "leaf-07", "name": "Leaf pair 4 B", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section.", "geometryDescriptor": {"topologyIntent": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0958, 0.0469, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.1259, 0.0617, 0.0], "rx": 0.0408, "rz": 0.0144, "twist": 35}, {"position": [0.1821, 0.0787, 0.0], "rx": 0.1161, "rz": 0.0412, "twist": 35}, {"position": [0.2384, 0.0789, 0.0], "rx": 0.1235, "rz": 0.0437, "twist": 35}, {"position": [0.2946, 0.0623, 0.0], "rx": 0.1032, "rz": 0.0365, "twist": 35}, {"position": [0.3509, 0.029, 0.0], "rx": 0.0633, "rz": 0.0225, "twist": 35}, {"position": [0.4072, -0.0212, 0.0], "rx": 0.0, "rz": 0.0, "twist": 35}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0144, 0.56, 0.0], "localEnd": [0.1335, 0.5388, 0.3894], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0144, 0.56, 0.0], "rotation": [0, 5.0091, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-07", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "midrib-fold", "kind": "linework", "description": "lamina folded along midrib", "evidenceRefs": ["full-object"]}, {"id": "cup-camber", "kind": "bevel", "description": "convex cupped lamina, margins down", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "tip recurves down", "evidenceRefs": ["full-object"]}, {"id": "petiole", "kind": "seam", "description": "petiole stands leaf off the stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "midrib groove + faint pinnate lateral veins (reference-derived normal map, strength 0.35)", "displacementPattern": "", "occlusionPattern": "darker at the petiole junction and inside the cup", "edgeWearPattern": "", "notes": "satin cuticle; no displacement (veins do not change the silhouette at in-app scale)"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_07_9.add(mesh_leaf_07_9);
  meshes["leaf-07"] = mesh_leaf_07_9;
  colliders["leaf-07"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaf-07"] ??= [];
  destructionGroups["leaf-07"].push(node_leaf_07_9);

  const endpoint_leaf_08_10 = makeAttachmentEndpoint(null);
  const node_leaf_08_10 = new THREE.Group();
  node_leaf_08_10.name = "Leaf pair 5 A__pivot";
  node_leaf_08_10.scale.set(1, 1, 1);
  if (endpoint_leaf_08_10) {
    node_leaf_08_10.position.copy(endpoint_leaf_08_10.start);
    node_leaf_08_10.rotation.set(0.0, 0.1745, 0.0);
  } else {
    node_leaf_08_10.position.set(0.0107, 0.71, 0.0);
    node_leaf_08_10.rotation.set(0.0, 0.1745, 0.0);
  }
  node_leaf_08_10.userData.sculptComponent = {"id": "leaf-08", "name": "Leaf pair 5 A", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section.", "geometryDescriptor": {"topologyIntent": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0863, 0.0458, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.1134, 0.0605, 0.0], "rx": 0.0368, "rz": 0.013, "twist": -35}, {"position": [0.1641, 0.0794, 0.0], "rx": 0.1047, "rz": 0.0371, "twist": -35}, {"position": [0.2147, 0.0844, 0.0], "rx": 0.1112, "rz": 0.0394, "twist": -35}, {"position": [0.2654, 0.0753, 0.0], "rx": 0.0929, "rz": 0.0329, "twist": -35}, {"position": [0.3161, 0.0522, 0.0], "rx": 0.0569, "rz": 0.0202, "twist": -35}, {"position": [0.3668, 0.0151, 0.0], "rx": 0.0, "rz": 0.0, "twist": -35}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0107, 0.71, 0.0], "localEnd": [0.3719, 0.7251, -0.0637], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0107, 0.71, 0.0], "rotation": [0, 0.1745, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-08", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "midrib-fold", "kind": "linework", "description": "lamina folded along midrib", "evidenceRefs": ["full-object"]}, {"id": "cup-camber", "kind": "bevel", "description": "convex cupped lamina, margins down", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "tip recurves down", "evidenceRefs": ["full-object"]}, {"id": "petiole", "kind": "seam", "description": "petiole stands leaf off the stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "midrib groove + faint pinnate lateral veins (reference-derived normal map, strength 0.35)", "displacementPattern": "", "occlusionPattern": "darker at the petiole junction and inside the cup", "edgeWearPattern": "", "notes": "satin cuticle; no displacement (veins do not change the silhouette at in-app scale)"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_08_10.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-08", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_leaf_08_10);
  nodes["leaf-08"] = node_leaf_08_10;
  const mesh_leaf_08_10Geometry = endpoint_leaf_08_10
    ? new THREE.CylinderGeometry(endpoint_leaf_08_10.endRadius, endpoint_leaf_08_10.baseRadius, endpoint_leaf_08_10.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0863, 0.0458, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.1134, 0.0605, 0.0], "rx": 0.0368, "rz": 0.013, "twist": -35}, {"position": [0.1641, 0.0794, 0.0], "rx": 0.1047, "rz": 0.0371, "twist": -35}, {"position": [0.2147, 0.0844, 0.0], "rx": 0.1112, "rz": 0.0394, "twist": -35}, {"position": [0.2654, 0.0753, 0.0], "rx": 0.0929, "rz": 0.0329, "twist": -35}, {"position": [0.3161, 0.0522, 0.0], "rx": 0.0569, "rz": 0.0202, "twist": -35}, {"position": [0.3668, 0.0151, 0.0], "rx": 0.0, "rz": 0.0, "twist": -35}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaf_08_10) {
    mesh_leaf_08_10Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaf_08_10 = new THREE.Mesh(
    mesh_leaf_08_10Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaf_08_10.name = "Leaf pair 5 A";
  if (endpoint_leaf_08_10) {
    mesh_leaf_08_10.position.copy(endpoint_leaf_08_10.midpoint);
    mesh_leaf_08_10.quaternion.copy(endpoint_leaf_08_10.quaternion);
  }
  mesh_leaf_08_10.castShadow = options.castShadow ?? true;
  mesh_leaf_08_10.receiveShadow = options.receiveShadow ?? true;
  mesh_leaf_08_10.userData.sculptComponent = {"id": "leaf-08", "name": "Leaf pair 5 A", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section.", "geometryDescriptor": {"topologyIntent": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0863, 0.0458, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.1134, 0.0605, 0.0], "rx": 0.0368, "rz": 0.013, "twist": -35}, {"position": [0.1641, 0.0794, 0.0], "rx": 0.1047, "rz": 0.0371, "twist": -35}, {"position": [0.2147, 0.0844, 0.0], "rx": 0.1112, "rz": 0.0394, "twist": -35}, {"position": [0.2654, 0.0753, 0.0], "rx": 0.0929, "rz": 0.0329, "twist": -35}, {"position": [0.3161, 0.0522, 0.0], "rx": 0.0569, "rz": 0.0202, "twist": -35}, {"position": [0.3668, 0.0151, 0.0], "rx": 0.0, "rz": 0.0, "twist": -35}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0107, 0.71, 0.0], "localEnd": [0.3719, 0.7251, -0.0637], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0107, 0.71, 0.0], "rotation": [0, 0.1745, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-08", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "midrib-fold", "kind": "linework", "description": "lamina folded along midrib", "evidenceRefs": ["full-object"]}, {"id": "cup-camber", "kind": "bevel", "description": "convex cupped lamina, margins down", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "tip recurves down", "evidenceRefs": ["full-object"]}, {"id": "petiole", "kind": "seam", "description": "petiole stands leaf off the stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "midrib groove + faint pinnate lateral veins (reference-derived normal map, strength 0.35)", "displacementPattern": "", "occlusionPattern": "darker at the petiole junction and inside the cup", "edgeWearPattern": "", "notes": "satin cuticle; no displacement (veins do not change the silhouette at in-app scale)"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_08_10.add(mesh_leaf_08_10);
  meshes["leaf-08"] = mesh_leaf_08_10;
  colliders["leaf-08"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaf-08"] ??= [];
  destructionGroups["leaf-08"].push(node_leaf_08_10);

  const endpoint_leaf_09_11 = makeAttachmentEndpoint(null);
  const node_leaf_09_11 = new THREE.Group();
  node_leaf_09_11.name = "Leaf pair 5 B__pivot";
  node_leaf_09_11.scale.set(1, 1, 1);
  if (endpoint_leaf_09_11) {
    node_leaf_09_11.position.copy(endpoint_leaf_09_11.start);
    node_leaf_09_11.rotation.set(0.0, 3.1067, 0.0);
  } else {
    node_leaf_09_11.position.set(0.0107, 0.71, 0.0);
    node_leaf_09_11.rotation.set(0.0, 3.1067, 0.0);
  }
  node_leaf_09_11.userData.sculptComponent = {"id": "leaf-09", "name": "Leaf pair 5 B", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section.", "geometryDescriptor": {"topologyIntent": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0962, 0.0511, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.1265, 0.0675, 0.0], "rx": 0.0411, "rz": 0.0146, "twist": 35}, {"position": [0.183, 0.0886, 0.0], "rx": 0.1167, "rz": 0.0414, "twist": 35}, {"position": [0.2396, 0.0941, 0.0], "rx": 0.124, "rz": 0.0439, "twist": 35}, {"position": [0.2961, 0.084, 0.0], "rx": 0.1037, "rz": 0.0367, "twist": 35}, {"position": [0.3527, 0.0582, 0.0], "rx": 0.0636, "rz": 0.0225, "twist": 35}, {"position": [0.4092, 0.0169, 0.0], "rx": 0.0, "rz": 0.0, "twist": 35}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0107, 0.71, 0.0], "localEnd": [-0.3983, 0.7269, -0.0143], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0107, 0.71, 0.0], "rotation": [0, 3.1067, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-09", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "midrib-fold", "kind": "linework", "description": "lamina folded along midrib", "evidenceRefs": ["full-object"]}, {"id": "cup-camber", "kind": "bevel", "description": "convex cupped lamina, margins down", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "tip recurves down", "evidenceRefs": ["full-object"]}, {"id": "petiole", "kind": "seam", "description": "petiole stands leaf off the stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "midrib groove + faint pinnate lateral veins (reference-derived normal map, strength 0.35)", "displacementPattern": "", "occlusionPattern": "darker at the petiole junction and inside the cup", "edgeWearPattern": "", "notes": "satin cuticle; no displacement (veins do not change the silhouette at in-app scale)"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_09_11.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-09", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_leaf_09_11);
  nodes["leaf-09"] = node_leaf_09_11;
  const mesh_leaf_09_11Geometry = endpoint_leaf_09_11
    ? new THREE.CylinderGeometry(endpoint_leaf_09_11.endRadius, endpoint_leaf_09_11.baseRadius, endpoint_leaf_09_11.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0962, 0.0511, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.1265, 0.0675, 0.0], "rx": 0.0411, "rz": 0.0146, "twist": 35}, {"position": [0.183, 0.0886, 0.0], "rx": 0.1167, "rz": 0.0414, "twist": 35}, {"position": [0.2396, 0.0941, 0.0], "rx": 0.124, "rz": 0.0439, "twist": 35}, {"position": [0.2961, 0.084, 0.0], "rx": 0.1037, "rz": 0.0367, "twist": 35}, {"position": [0.3527, 0.0582, 0.0], "rx": 0.0636, "rz": 0.0225, "twist": 35}, {"position": [0.4092, 0.0169, 0.0], "rx": 0.0, "rz": 0.0, "twist": 35}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaf_09_11) {
    mesh_leaf_09_11Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaf_09_11 = new THREE.Mesh(
    mesh_leaf_09_11Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaf_09_11.name = "Leaf pair 5 B";
  if (endpoint_leaf_09_11) {
    mesh_leaf_09_11.position.copy(endpoint_leaf_09_11.midpoint);
    mesh_leaf_09_11.quaternion.copy(endpoint_leaf_09_11.quaternion);
  }
  mesh_leaf_09_11.castShadow = options.castShadow ?? true;
  mesh_leaf_09_11.receiveShadow = options.receiveShadow ?? true;
  mesh_leaf_09_11.userData.sculptComponent = {"id": "leaf-09", "name": "Leaf pair 5 B", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section.", "geometryDescriptor": {"topologyIntent": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0962, 0.0511, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.1265, 0.0675, 0.0], "rx": 0.0411, "rz": 0.0146, "twist": 35}, {"position": [0.183, 0.0886, 0.0], "rx": 0.1167, "rz": 0.0414, "twist": 35}, {"position": [0.2396, 0.0941, 0.0], "rx": 0.124, "rz": 0.0439, "twist": 35}, {"position": [0.2961, 0.084, 0.0], "rx": 0.1037, "rz": 0.0367, "twist": 35}, {"position": [0.3527, 0.0582, 0.0], "rx": 0.0636, "rz": 0.0225, "twist": 35}, {"position": [0.4092, 0.0169, 0.0], "rx": 0.0, "rz": 0.0, "twist": 35}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0107, 0.71, 0.0], "localEnd": [-0.3983, 0.7269, -0.0143], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0107, 0.71, 0.0], "rotation": [0, 3.1067, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-09", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "midrib-fold", "kind": "linework", "description": "lamina folded along midrib", "evidenceRefs": ["full-object"]}, {"id": "cup-camber", "kind": "bevel", "description": "convex cupped lamina, margins down", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "tip recurves down", "evidenceRefs": ["full-object"]}, {"id": "petiole", "kind": "seam", "description": "petiole stands leaf off the stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "midrib groove + faint pinnate lateral veins (reference-derived normal map, strength 0.35)", "displacementPattern": "", "occlusionPattern": "darker at the petiole junction and inside the cup", "edgeWearPattern": "", "notes": "satin cuticle; no displacement (veins do not change the silhouette at in-app scale)"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_09_11.add(mesh_leaf_09_11);
  meshes["leaf-09"] = mesh_leaf_09_11;
  colliders["leaf-09"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaf-09"] ??= [];
  destructionGroups["leaf-09"].push(node_leaf_09_11);

  const endpoint_leaf_10_12 = makeAttachmentEndpoint(null);
  const node_leaf_10_12 = new THREE.Group();
  node_leaf_10_12.name = "Leaf pair 6 A__pivot";
  node_leaf_10_12.scale.set(1, 1, 1);
  if (endpoint_leaf_10_12) {
    node_leaf_10_12.position.copy(endpoint_leaf_10_12.start);
    node_leaf_10_12.rotation.set(0.0, 1.5708, 0.0);
  } else {
    node_leaf_10_12.position.set(0.0053, 0.84, 0.0);
    node_leaf_10_12.rotation.set(0.0, 1.5708, 0.0);
  }
  node_leaf_10_12.userData.sculptComponent = {"id": "leaf-10", "name": "Leaf pair 6 A", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section.", "geometryDescriptor": {"topologyIntent": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0614, 0.0376, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0807, 0.05, 0.0], "rx": 0.0261, "rz": 0.012, "twist": -35}, {"position": [0.1168, 0.0678, 0.0], "rx": 0.0745, "rz": 0.0265, "twist": -35}, {"position": [0.1528, 0.0765, 0.0], "rx": 0.0792, "rz": 0.0281, "twist": -35}, {"position": [0.1889, 0.076, 0.0], "rx": 0.0662, "rz": 0.0234, "twist": -35}, {"position": [0.225, 0.0664, 0.0], "rx": 0.0406, "rz": 0.0144, "twist": -35}, {"position": [0.261, 0.0475, 0.0], "rx": 0.0, "rz": 0.0, "twist": -35}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0053, 0.84, 0.0], "localEnd": [0.0053, 0.8875, -0.261], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0053, 0.84, 0.0], "rotation": [0, 1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-10", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "midrib-fold", "kind": "linework", "description": "lamina folded along midrib", "evidenceRefs": ["full-object"]}, {"id": "cup-camber", "kind": "bevel", "description": "convex cupped lamina, margins down", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "tip recurves down", "evidenceRefs": ["full-object"]}, {"id": "petiole", "kind": "seam", "description": "petiole stands leaf off the stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "midrib groove + faint pinnate lateral veins (reference-derived normal map, strength 0.35)", "displacementPattern": "", "occlusionPattern": "darker at the petiole junction and inside the cup", "edgeWearPattern": "", "notes": "satin cuticle; no displacement (veins do not change the silhouette at in-app scale)"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_10_12.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-10", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_leaf_10_12);
  nodes["leaf-10"] = node_leaf_10_12;
  const mesh_leaf_10_12Geometry = endpoint_leaf_10_12
    ? new THREE.CylinderGeometry(endpoint_leaf_10_12.endRadius, endpoint_leaf_10_12.baseRadius, endpoint_leaf_10_12.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0614, 0.0376, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0807, 0.05, 0.0], "rx": 0.0261, "rz": 0.012, "twist": -35}, {"position": [0.1168, 0.0678, 0.0], "rx": 0.0745, "rz": 0.0265, "twist": -35}, {"position": [0.1528, 0.0765, 0.0], "rx": 0.0792, "rz": 0.0281, "twist": -35}, {"position": [0.1889, 0.076, 0.0], "rx": 0.0662, "rz": 0.0234, "twist": -35}, {"position": [0.225, 0.0664, 0.0], "rx": 0.0406, "rz": 0.0144, "twist": -35}, {"position": [0.261, 0.0475, 0.0], "rx": 0.0, "rz": 0.0, "twist": -35}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaf_10_12) {
    mesh_leaf_10_12Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaf_10_12 = new THREE.Mesh(
    mesh_leaf_10_12Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaf_10_12.name = "Leaf pair 6 A";
  if (endpoint_leaf_10_12) {
    mesh_leaf_10_12.position.copy(endpoint_leaf_10_12.midpoint);
    mesh_leaf_10_12.quaternion.copy(endpoint_leaf_10_12.quaternion);
  }
  mesh_leaf_10_12.castShadow = options.castShadow ?? true;
  mesh_leaf_10_12.receiveShadow = options.receiveShadow ?? true;
  mesh_leaf_10_12.userData.sculptComponent = {"id": "leaf-10", "name": "Leaf pair 6 A", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section.", "geometryDescriptor": {"topologyIntent": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0614, 0.0376, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0807, 0.05, 0.0], "rx": 0.0261, "rz": 0.012, "twist": -35}, {"position": [0.1168, 0.0678, 0.0], "rx": 0.0745, "rz": 0.0265, "twist": -35}, {"position": [0.1528, 0.0765, 0.0], "rx": 0.0792, "rz": 0.0281, "twist": -35}, {"position": [0.1889, 0.076, 0.0], "rx": 0.0662, "rz": 0.0234, "twist": -35}, {"position": [0.225, 0.0664, 0.0], "rx": 0.0406, "rz": 0.0144, "twist": -35}, {"position": [0.261, 0.0475, 0.0], "rx": 0.0, "rz": 0.0, "twist": -35}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0053, 0.84, 0.0], "localEnd": [0.0053, 0.8875, -0.261], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0053, 0.84, 0.0], "rotation": [0, 1.5708, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-10", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "midrib-fold", "kind": "linework", "description": "lamina folded along midrib", "evidenceRefs": ["full-object"]}, {"id": "cup-camber", "kind": "bevel", "description": "convex cupped lamina, margins down", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "tip recurves down", "evidenceRefs": ["full-object"]}, {"id": "petiole", "kind": "seam", "description": "petiole stands leaf off the stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "midrib groove + faint pinnate lateral veins (reference-derived normal map, strength 0.35)", "displacementPattern": "", "occlusionPattern": "darker at the petiole junction and inside the cup", "edgeWearPattern": "", "notes": "satin cuticle; no displacement (veins do not change the silhouette at in-app scale)"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_10_12.add(mesh_leaf_10_12);
  meshes["leaf-10"] = mesh_leaf_10_12;
  colliders["leaf-10"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaf-10"] ??= [];
  destructionGroups["leaf-10"].push(node_leaf_10_12);

  const endpoint_leaf_11_13 = makeAttachmentEndpoint(null);
  const node_leaf_11_13 = new THREE.Group();
  node_leaf_11_13.name = "Leaf pair 6 B__pivot";
  node_leaf_11_13.scale.set(1, 1, 1);
  if (endpoint_leaf_11_13) {
    node_leaf_11_13.position.copy(endpoint_leaf_11_13.start);
    node_leaf_11_13.rotation.set(0.0, 4.9218, 0.0);
  } else {
    node_leaf_11_13.position.set(0.0053, 0.84, 0.0);
    node_leaf_11_13.rotation.set(0.0, 4.9218, 0.0);
  }
  node_leaf_11_13.userData.sculptComponent = {"id": "leaf-11", "name": "Leaf pair 6 B", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section.", "geometryDescriptor": {"topologyIntent": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0667, 0.0409, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0877, 0.0543, 0.0], "rx": 0.0285, "rz": 0.012, "twist": 35}, {"position": [0.1269, 0.0737, 0.0], "rx": 0.0809, "rz": 0.0286, "twist": 35}, {"position": [0.1661, 0.0832, 0.0], "rx": 0.0861, "rz": 0.0304, "twist": 35}, {"position": [0.2053, 0.0826, 0.0], "rx": 0.0719, "rz": 0.0256, "twist": 35}, {"position": [0.2445, 0.0721, 0.0], "rx": 0.0441, "rz": 0.0157, "twist": 35}, {"position": [0.2837, 0.0516, 0.0], "rx": 0.0, "rz": 0.0, "twist": 35}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0053, 0.84, 0.0], "localEnd": [0.0643, 0.8916, 0.2775], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0053, 0.84, 0.0], "rotation": [0, 4.9218, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-11", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "midrib-fold", "kind": "linework", "description": "lamina folded along midrib", "evidenceRefs": ["full-object"]}, {"id": "cup-camber", "kind": "bevel", "description": "convex cupped lamina, margins down", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "tip recurves down", "evidenceRefs": ["full-object"]}, {"id": "petiole", "kind": "seam", "description": "petiole stands leaf off the stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "midrib groove + faint pinnate lateral veins (reference-derived normal map, strength 0.35)", "displacementPattern": "", "occlusionPattern": "darker at the petiole junction and inside the cup", "edgeWearPattern": "", "notes": "satin cuticle; no displacement (veins do not change the silhouette at in-app scale)"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_11_13.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-11", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_leaf_11_13);
  nodes["leaf-11"] = node_leaf_11_13;
  const mesh_leaf_11_13Geometry = endpoint_leaf_11_13
    ? new THREE.CylinderGeometry(endpoint_leaf_11_13.endRadius, endpoint_leaf_11_13.baseRadius, endpoint_leaf_11_13.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0667, 0.0409, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0877, 0.0543, 0.0], "rx": 0.0285, "rz": 0.012, "twist": 35}, {"position": [0.1269, 0.0737, 0.0], "rx": 0.0809, "rz": 0.0286, "twist": 35}, {"position": [0.1661, 0.0832, 0.0], "rx": 0.0861, "rz": 0.0304, "twist": 35}, {"position": [0.2053, 0.0826, 0.0], "rx": 0.0719, "rz": 0.0256, "twist": 35}, {"position": [0.2445, 0.0721, 0.0], "rx": 0.0441, "rz": 0.0157, "twist": 35}, {"position": [0.2837, 0.0516, 0.0], "rx": 0.0, "rz": 0.0, "twist": 35}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaf_11_13) {
    mesh_leaf_11_13Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaf_11_13 = new THREE.Mesh(
    mesh_leaf_11_13Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaf_11_13.name = "Leaf pair 6 B";
  if (endpoint_leaf_11_13) {
    mesh_leaf_11_13.position.copy(endpoint_leaf_11_13.midpoint);
    mesh_leaf_11_13.quaternion.copy(endpoint_leaf_11_13.quaternion);
  }
  mesh_leaf_11_13.castShadow = options.castShadow ?? true;
  mesh_leaf_11_13.receiveShadow = options.receiveShadow ?? true;
  mesh_leaf_11_13.userData.sculptComponent = {"id": "leaf-11", "name": "Leaf pair 6 B", "level": "meso", "role": "leaf", "importance": 0.8, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section.", "geometryDescriptor": {"topologyIntent": "Cupped ovate lamina on a thin petiole, swept from the node outward; thin lens section. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0667, 0.0409, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0877, 0.0543, 0.0], "rx": 0.0285, "rz": 0.012, "twist": 35}, {"position": [0.1269, 0.0737, 0.0], "rx": 0.0809, "rz": 0.0286, "twist": 35}, {"position": [0.1661, 0.0832, 0.0], "rx": 0.0861, "rz": 0.0304, "twist": 35}, {"position": [0.2053, 0.0826, 0.0], "rx": 0.0719, "rz": 0.0256, "twist": 35}, {"position": [0.2445, 0.0721, 0.0], "rx": 0.0441, "rz": 0.0157, "twist": 35}, {"position": [0.2837, 0.0516, 0.0], "rx": 0.0, "rz": 0.0, "twist": 35}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0053, 0.84, 0.0], "localEnd": [0.0643, 0.8916, 0.2775], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0053, 0.84, 0.0], "rotation": [0, 4.9218, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaf-11", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "midrib-fold", "kind": "linework", "description": "lamina folded along midrib", "evidenceRefs": ["full-object"]}, {"id": "cup-camber", "kind": "bevel", "description": "convex cupped lamina, margins down", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "tip recurves down", "evidenceRefs": ["full-object"]}, {"id": "petiole", "kind": "seam", "description": "petiole stands leaf off the stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.55, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "midrib groove + faint pinnate lateral veins (reference-derived normal map, strength 0.35)", "displacementPattern": "", "occlusionPattern": "darker at the petiole junction and inside the cup", "edgeWearPattern": "", "notes": "satin cuticle; no displacement (veins do not change the silhouette at in-app scale)"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaf_11_13.add(mesh_leaf_11_13);
  meshes["leaf-11"] = mesh_leaf_11_13;
  colliders["leaf-11"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaf-11"] ??= [];
  destructionGroups["leaf-11"].push(node_leaf_11_13);

  const endpoint_tuft_0_14 = makeAttachmentEndpoint(null);
  const node_tuft_0_14 = new THREE.Group();
  node_tuft_0_14.name = "Apical young leaf 1__pivot";
  node_tuft_0_14.scale.set(1, 1, 1);
  if (endpoint_tuft_0_14) {
    node_tuft_0_14.position.copy(endpoint_tuft_0_14.start);
    node_tuft_0_14.rotation.set(0.0, 0.7854, 0.0);
  } else {
    node_tuft_0_14.position.set(0.001, 0.93, 0.0);
    node_tuft_0_14.rotation.set(0.0, 0.7854, 0.0);
  }
  node_tuft_0_14.userData.sculptComponent = {"id": "tuft-0", "name": "Apical young leaf 1", "level": "micro", "role": "leaf", "importance": 0.5, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Small young leaf of the apical bud cluster, steeply ascending.", "geometryDescriptor": {"topologyIntent": "Small young leaf of the apical bud cluster, steeply ascending. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0191, 0.0218, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0295, 0.0352, 0.0], "rx": 0.014, "rz": 0.012, "twist": 30}, {"position": [0.0496, 0.0575, 0.0], "rx": 0.0402, "rz": 0.0124, "twist": 30}, {"position": [0.0697, 0.0739, 0.0], "rx": 0.0426, "rz": 0.0133, "twist": 30}, {"position": [0.0898, 0.0845, 0.0], "rx": 0.0356, "rz": 0.012, "twist": 30}, {"position": [0.1099, 0.0892, 0.0], "rx": 0.0218, "rz": 0.012, "twist": 30}, {"position": [0.13, 0.0881, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.001, 0.93, 0.0], "localEnd": [0.0929, 1.0181, -0.0919], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.001, 0.93, 0.0], "rotation": [0, 0.7854, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tuft-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf-young", "materialLayers": ["leaf-young"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 210, 94, 1.0)", "secondaryAlbedo": "rgba(134, 198, 78, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_tuft_0_14.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tuft-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_tuft_0_14);
  nodes["tuft-0"] = node_tuft_0_14;
  const mesh_tuft_0_14Geometry = endpoint_tuft_0_14
    ? new THREE.CylinderGeometry(endpoint_tuft_0_14.endRadius, endpoint_tuft_0_14.baseRadius, endpoint_tuft_0_14.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0191, 0.0218, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0295, 0.0352, 0.0], "rx": 0.014, "rz": 0.012, "twist": 30}, {"position": [0.0496, 0.0575, 0.0], "rx": 0.0402, "rz": 0.0124, "twist": 30}, {"position": [0.0697, 0.0739, 0.0], "rx": 0.0426, "rz": 0.0133, "twist": 30}, {"position": [0.0898, 0.0845, 0.0], "rx": 0.0356, "rz": 0.012, "twist": 30}, {"position": [0.1099, 0.0892, 0.0], "rx": 0.0218, "rz": 0.012, "twist": 30}, {"position": [0.13, 0.0881, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_tuft_0_14) {
    mesh_tuft_0_14Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_tuft_0_14 = new THREE.Mesh(
    mesh_tuft_0_14Geometry,
    materialMap["leaf-young"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tuft_0_14.name = "Apical young leaf 1";
  if (endpoint_tuft_0_14) {
    mesh_tuft_0_14.position.copy(endpoint_tuft_0_14.midpoint);
    mesh_tuft_0_14.quaternion.copy(endpoint_tuft_0_14.quaternion);
  }
  mesh_tuft_0_14.castShadow = options.castShadow ?? true;
  mesh_tuft_0_14.receiveShadow = options.receiveShadow ?? true;
  mesh_tuft_0_14.userData.sculptComponent = {"id": "tuft-0", "name": "Apical young leaf 1", "level": "micro", "role": "leaf", "importance": 0.5, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Small young leaf of the apical bud cluster, steeply ascending.", "geometryDescriptor": {"topologyIntent": "Small young leaf of the apical bud cluster, steeply ascending. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0191, 0.0218, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0295, 0.0352, 0.0], "rx": 0.014, "rz": 0.012, "twist": 30}, {"position": [0.0496, 0.0575, 0.0], "rx": 0.0402, "rz": 0.0124, "twist": 30}, {"position": [0.0697, 0.0739, 0.0], "rx": 0.0426, "rz": 0.0133, "twist": 30}, {"position": [0.0898, 0.0845, 0.0], "rx": 0.0356, "rz": 0.012, "twist": 30}, {"position": [0.1099, 0.0892, 0.0], "rx": 0.0218, "rz": 0.012, "twist": 30}, {"position": [0.13, 0.0881, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.001, 0.93, 0.0], "localEnd": [0.0929, 1.0181, -0.0919], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.001, 0.93, 0.0], "rotation": [0, 0.7854, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tuft-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf-young", "materialLayers": ["leaf-young"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 210, 94, 1.0)", "secondaryAlbedo": "rgba(134, 198, 78, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_tuft_0_14.add(mesh_tuft_0_14);
  meshes["tuft-0"] = mesh_tuft_0_14;
  colliders["tuft-0"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["tuft-0"] ??= [];
  destructionGroups["tuft-0"].push(node_tuft_0_14);

  const endpoint_tuft_1_15 = makeAttachmentEndpoint(null);
  const node_tuft_1_15 = new THREE.Group();
  node_tuft_1_15.name = "Apical young leaf 2__pivot";
  node_tuft_1_15.scale.set(1, 1, 1);
  if (endpoint_tuft_1_15) {
    node_tuft_1_15.position.copy(endpoint_tuft_1_15.start);
    node_tuft_1_15.rotation.set(0.0, 2.3562, 0.0);
  } else {
    node_tuft_1_15.position.set(0.001, 0.93, 0.0);
    node_tuft_1_15.rotation.set(0.0, 2.3562, 0.0);
  }
  node_tuft_1_15.userData.sculptComponent = {"id": "tuft-1", "name": "Apical young leaf 2", "level": "micro", "role": "leaf", "importance": 0.5, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Small young leaf of the apical bud cluster, steeply ascending.", "geometryDescriptor": {"topologyIntent": "Small young leaf of the apical bud cluster, steeply ascending. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0191, 0.0218, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0295, 0.0352, 0.0], "rx": 0.014, "rz": 0.012, "twist": 30}, {"position": [0.0496, 0.0575, 0.0], "rx": 0.0402, "rz": 0.0124, "twist": 30}, {"position": [0.0697, 0.0739, 0.0], "rx": 0.0426, "rz": 0.0133, "twist": 30}, {"position": [0.0898, 0.0845, 0.0], "rx": 0.0356, "rz": 0.012, "twist": 30}, {"position": [0.1099, 0.0892, 0.0], "rx": 0.0218, "rz": 0.012, "twist": 30}, {"position": [0.13, 0.0881, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.001, 0.93, 0.0], "localEnd": [-0.0909, 1.0181, -0.0919], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.001, 0.93, 0.0], "rotation": [0, 2.3562, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tuft-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf-young", "materialLayers": ["leaf-young"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 210, 94, 1.0)", "secondaryAlbedo": "rgba(134, 198, 78, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_tuft_1_15.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tuft-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_tuft_1_15);
  nodes["tuft-1"] = node_tuft_1_15;
  const mesh_tuft_1_15Geometry = endpoint_tuft_1_15
    ? new THREE.CylinderGeometry(endpoint_tuft_1_15.endRadius, endpoint_tuft_1_15.baseRadius, endpoint_tuft_1_15.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0191, 0.0218, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0295, 0.0352, 0.0], "rx": 0.014, "rz": 0.012, "twist": 30}, {"position": [0.0496, 0.0575, 0.0], "rx": 0.0402, "rz": 0.0124, "twist": 30}, {"position": [0.0697, 0.0739, 0.0], "rx": 0.0426, "rz": 0.0133, "twist": 30}, {"position": [0.0898, 0.0845, 0.0], "rx": 0.0356, "rz": 0.012, "twist": 30}, {"position": [0.1099, 0.0892, 0.0], "rx": 0.0218, "rz": 0.012, "twist": 30}, {"position": [0.13, 0.0881, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_tuft_1_15) {
    mesh_tuft_1_15Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_tuft_1_15 = new THREE.Mesh(
    mesh_tuft_1_15Geometry,
    materialMap["leaf-young"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tuft_1_15.name = "Apical young leaf 2";
  if (endpoint_tuft_1_15) {
    mesh_tuft_1_15.position.copy(endpoint_tuft_1_15.midpoint);
    mesh_tuft_1_15.quaternion.copy(endpoint_tuft_1_15.quaternion);
  }
  mesh_tuft_1_15.castShadow = options.castShadow ?? true;
  mesh_tuft_1_15.receiveShadow = options.receiveShadow ?? true;
  mesh_tuft_1_15.userData.sculptComponent = {"id": "tuft-1", "name": "Apical young leaf 2", "level": "micro", "role": "leaf", "importance": 0.5, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Small young leaf of the apical bud cluster, steeply ascending.", "geometryDescriptor": {"topologyIntent": "Small young leaf of the apical bud cluster, steeply ascending. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0191, 0.0218, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0295, 0.0352, 0.0], "rx": 0.014, "rz": 0.012, "twist": 30}, {"position": [0.0496, 0.0575, 0.0], "rx": 0.0402, "rz": 0.0124, "twist": 30}, {"position": [0.0697, 0.0739, 0.0], "rx": 0.0426, "rz": 0.0133, "twist": 30}, {"position": [0.0898, 0.0845, 0.0], "rx": 0.0356, "rz": 0.012, "twist": 30}, {"position": [0.1099, 0.0892, 0.0], "rx": 0.0218, "rz": 0.012, "twist": 30}, {"position": [0.13, 0.0881, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.001, 0.93, 0.0], "localEnd": [-0.0909, 1.0181, -0.0919], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.001, 0.93, 0.0], "rotation": [0, 2.3562, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tuft-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf-young", "materialLayers": ["leaf-young"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 210, 94, 1.0)", "secondaryAlbedo": "rgba(134, 198, 78, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_tuft_1_15.add(mesh_tuft_1_15);
  meshes["tuft-1"] = mesh_tuft_1_15;
  colliders["tuft-1"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["tuft-1"] ??= [];
  destructionGroups["tuft-1"].push(node_tuft_1_15);

  const endpoint_tuft_2_16 = makeAttachmentEndpoint(null);
  const node_tuft_2_16 = new THREE.Group();
  node_tuft_2_16.name = "Apical young leaf 3__pivot";
  node_tuft_2_16.scale.set(1, 1, 1);
  if (endpoint_tuft_2_16) {
    node_tuft_2_16.position.copy(endpoint_tuft_2_16.start);
    node_tuft_2_16.rotation.set(0.0, 3.927, 0.0);
  } else {
    node_tuft_2_16.position.set(0.001, 0.93, 0.0);
    node_tuft_2_16.rotation.set(0.0, 3.927, 0.0);
  }
  node_tuft_2_16.userData.sculptComponent = {"id": "tuft-2", "name": "Apical young leaf 3", "level": "micro", "role": "leaf", "importance": 0.5, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Small young leaf of the apical bud cluster, steeply ascending.", "geometryDescriptor": {"topologyIntent": "Small young leaf of the apical bud cluster, steeply ascending. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0191, 0.0218, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0295, 0.0352, 0.0], "rx": 0.014, "rz": 0.012, "twist": 30}, {"position": [0.0496, 0.0575, 0.0], "rx": 0.0402, "rz": 0.0124, "twist": 30}, {"position": [0.0697, 0.0739, 0.0], "rx": 0.0426, "rz": 0.0133, "twist": 30}, {"position": [0.0898, 0.0845, 0.0], "rx": 0.0356, "rz": 0.012, "twist": 30}, {"position": [0.1099, 0.0892, 0.0], "rx": 0.0218, "rz": 0.012, "twist": 30}, {"position": [0.13, 0.0881, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.001, 0.93, 0.0], "localEnd": [-0.0909, 1.0181, 0.0919], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.001, 0.93, 0.0], "rotation": [0, 3.927, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tuft-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf-young", "materialLayers": ["leaf-young"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 210, 94, 1.0)", "secondaryAlbedo": "rgba(134, 198, 78, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_tuft_2_16.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tuft-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_tuft_2_16);
  nodes["tuft-2"] = node_tuft_2_16;
  const mesh_tuft_2_16Geometry = endpoint_tuft_2_16
    ? new THREE.CylinderGeometry(endpoint_tuft_2_16.endRadius, endpoint_tuft_2_16.baseRadius, endpoint_tuft_2_16.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0191, 0.0218, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0295, 0.0352, 0.0], "rx": 0.014, "rz": 0.012, "twist": 30}, {"position": [0.0496, 0.0575, 0.0], "rx": 0.0402, "rz": 0.0124, "twist": 30}, {"position": [0.0697, 0.0739, 0.0], "rx": 0.0426, "rz": 0.0133, "twist": 30}, {"position": [0.0898, 0.0845, 0.0], "rx": 0.0356, "rz": 0.012, "twist": 30}, {"position": [0.1099, 0.0892, 0.0], "rx": 0.0218, "rz": 0.012, "twist": 30}, {"position": [0.13, 0.0881, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_tuft_2_16) {
    mesh_tuft_2_16Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_tuft_2_16 = new THREE.Mesh(
    mesh_tuft_2_16Geometry,
    materialMap["leaf-young"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tuft_2_16.name = "Apical young leaf 3";
  if (endpoint_tuft_2_16) {
    mesh_tuft_2_16.position.copy(endpoint_tuft_2_16.midpoint);
    mesh_tuft_2_16.quaternion.copy(endpoint_tuft_2_16.quaternion);
  }
  mesh_tuft_2_16.castShadow = options.castShadow ?? true;
  mesh_tuft_2_16.receiveShadow = options.receiveShadow ?? true;
  mesh_tuft_2_16.userData.sculptComponent = {"id": "tuft-2", "name": "Apical young leaf 3", "level": "micro", "role": "leaf", "importance": 0.5, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Small young leaf of the apical bud cluster, steeply ascending.", "geometryDescriptor": {"topologyIntent": "Small young leaf of the apical bud cluster, steeply ascending. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0191, 0.0218, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0295, 0.0352, 0.0], "rx": 0.014, "rz": 0.012, "twist": 30}, {"position": [0.0496, 0.0575, 0.0], "rx": 0.0402, "rz": 0.0124, "twist": 30}, {"position": [0.0697, 0.0739, 0.0], "rx": 0.0426, "rz": 0.0133, "twist": 30}, {"position": [0.0898, 0.0845, 0.0], "rx": 0.0356, "rz": 0.012, "twist": 30}, {"position": [0.1099, 0.0892, 0.0], "rx": 0.0218, "rz": 0.012, "twist": 30}, {"position": [0.13, 0.0881, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.001, 0.93, 0.0], "localEnd": [-0.0909, 1.0181, 0.0919], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.001, 0.93, 0.0], "rotation": [0, 3.927, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tuft-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf-young", "materialLayers": ["leaf-young"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 210, 94, 1.0)", "secondaryAlbedo": "rgba(134, 198, 78, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_tuft_2_16.add(mesh_tuft_2_16);
  meshes["tuft-2"] = mesh_tuft_2_16;
  colliders["tuft-2"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["tuft-2"] ??= [];
  destructionGroups["tuft-2"].push(node_tuft_2_16);

  const endpoint_tuft_3_17 = makeAttachmentEndpoint(null);
  const node_tuft_3_17 = new THREE.Group();
  node_tuft_3_17.name = "Apical young leaf 4__pivot";
  node_tuft_3_17.scale.set(1, 1, 1);
  if (endpoint_tuft_3_17) {
    node_tuft_3_17.position.copy(endpoint_tuft_3_17.start);
    node_tuft_3_17.rotation.set(0.0, 5.4978, 0.0);
  } else {
    node_tuft_3_17.position.set(0.001, 0.93, 0.0);
    node_tuft_3_17.rotation.set(0.0, 5.4978, 0.0);
  }
  node_tuft_3_17.userData.sculptComponent = {"id": "tuft-3", "name": "Apical young leaf 4", "level": "micro", "role": "leaf", "importance": 0.5, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Small young leaf of the apical bud cluster, steeply ascending.", "geometryDescriptor": {"topologyIntent": "Small young leaf of the apical bud cluster, steeply ascending. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0191, 0.0218, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0295, 0.0352, 0.0], "rx": 0.014, "rz": 0.012, "twist": 30}, {"position": [0.0496, 0.0575, 0.0], "rx": 0.0402, "rz": 0.0124, "twist": 30}, {"position": [0.0697, 0.0739, 0.0], "rx": 0.0426, "rz": 0.0133, "twist": 30}, {"position": [0.0898, 0.0845, 0.0], "rx": 0.0356, "rz": 0.012, "twist": 30}, {"position": [0.1099, 0.0892, 0.0], "rx": 0.0218, "rz": 0.012, "twist": 30}, {"position": [0.13, 0.0881, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.001, 0.93, 0.0], "localEnd": [0.0929, 1.0181, 0.0919], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.001, 0.93, 0.0], "rotation": [0, 5.4978, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tuft-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf-young", "materialLayers": ["leaf-young"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 210, 94, 1.0)", "secondaryAlbedo": "rgba(134, 198, 78, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_tuft_3_17.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tuft-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_tuft_3_17);
  nodes["tuft-3"] = node_tuft_3_17;
  const mesh_tuft_3_17Geometry = endpoint_tuft_3_17
    ? new THREE.CylinderGeometry(endpoint_tuft_3_17.endRadius, endpoint_tuft_3_17.baseRadius, endpoint_tuft_3_17.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0191, 0.0218, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0295, 0.0352, 0.0], "rx": 0.014, "rz": 0.012, "twist": 30}, {"position": [0.0496, 0.0575, 0.0], "rx": 0.0402, "rz": 0.0124, "twist": 30}, {"position": [0.0697, 0.0739, 0.0], "rx": 0.0426, "rz": 0.0133, "twist": 30}, {"position": [0.0898, 0.0845, 0.0], "rx": 0.0356, "rz": 0.012, "twist": 30}, {"position": [0.1099, 0.0892, 0.0], "rx": 0.0218, "rz": 0.012, "twist": 30}, {"position": [0.13, 0.0881, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_tuft_3_17) {
    mesh_tuft_3_17Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_tuft_3_17 = new THREE.Mesh(
    mesh_tuft_3_17Geometry,
    materialMap["leaf-young"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_tuft_3_17.name = "Apical young leaf 4";
  if (endpoint_tuft_3_17) {
    mesh_tuft_3_17.position.copy(endpoint_tuft_3_17.midpoint);
    mesh_tuft_3_17.quaternion.copy(endpoint_tuft_3_17.quaternion);
  }
  mesh_tuft_3_17.castShadow = options.castShadow ?? true;
  mesh_tuft_3_17.receiveShadow = options.receiveShadow ?? true;
  mesh_tuft_3_17.userData.sculptComponent = {"id": "tuft-3", "name": "Apical young leaf 4", "level": "micro", "role": "leaf", "importance": 0.5, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Small young leaf of the apical bud cluster, steeply ascending.", "geometryDescriptor": {"topologyIntent": "Small young leaf of the apical bud cluster, steeply ascending. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0191, 0.0218, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0295, 0.0352, 0.0], "rx": 0.014, "rz": 0.012, "twist": 30}, {"position": [0.0496, 0.0575, 0.0], "rx": 0.0402, "rz": 0.0124, "twist": 30}, {"position": [0.0697, 0.0739, 0.0], "rx": 0.0426, "rz": 0.0133, "twist": 30}, {"position": [0.0898, 0.0845, 0.0], "rx": 0.0356, "rz": 0.012, "twist": 30}, {"position": [0.1099, 0.0892, 0.0], "rx": 0.0218, "rz": 0.012, "twist": 30}, {"position": [0.13, 0.0881, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.001, 0.93, 0.0], "localEnd": [0.0929, 1.0181, 0.0919], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.001, 0.93, 0.0], "rotation": [0, 5.4978, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "tuft-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf-young", "materialLayers": ["leaf-young"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(155, 210, 94, 1.0)", "secondaryAlbedo": "rgba(134, 198, 78, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_tuft_3_17.add(mesh_tuft_3_17);
  meshes["tuft-3"] = mesh_tuft_3_17;
  colliders["tuft-3"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["tuft-3"] ??= [];
  destructionGroups["tuft-3"].push(node_tuft_3_17);

  const endpoint_branch_lateral_18 = makeAttachmentEndpoint(null);
  const node_branch_lateral_18 = new THREE.Group();
  node_branch_lateral_18.name = "Lateral branch__pivot";
  node_branch_lateral_18.scale.set(1, 1, 1);
  if (endpoint_branch_lateral_18) {
    node_branch_lateral_18.position.copy(endpoint_branch_lateral_18.start);
    node_branch_lateral_18.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_branch_lateral_18.position.set(0.0, 0.0, 0.0);
    node_branch_lateral_18.rotation.set(0.0, 0.0, 0.0);
  }
  node_branch_lateral_18.userData.sculptComponent = {"id": "branch-lateral", "name": "Lateral branch", "level": "macro", "role": "stem", "importance": 0.6, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Axillary shoot from node 3, leaning ~25 deg outward.", "geometryDescriptor": {"topologyIntent": "Axillary shoot from node 3, leaning ~25 deg outward. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0145, 0.4, 0.0], "rx": 0.01, "rz": 0.01, "twist": 0}, {"position": [-0.05550000000000001, 0.54, 0.035], "rx": 0.008, "rz": 0.008, "twist": 0}, {"position": [-0.1255, 0.66, 0.07], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0145, 0.4, 0.0], "localEnd": [-0.1255, 0.66, 0.07], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "branch-lateral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "node2-socket", "kind": "seam", "description": "roots in the leaf axil of node 3", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 190, 90, 1.0)", "secondaryAlbedo": "rgba(110, 158, 62, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_branch_lateral_18.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "branch-lateral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_branch_lateral_18);
  nodes["branch-lateral"] = node_branch_lateral_18;
  const mesh_branch_lateral_18Geometry = endpoint_branch_lateral_18
    ? new THREE.CylinderGeometry(endpoint_branch_lateral_18.endRadius, endpoint_branch_lateral_18.baseRadius, endpoint_branch_lateral_18.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0145, 0.4, 0.0], "rx": 0.01, "rz": 0.01, "twist": 0}, {"position": [-0.05550000000000001, 0.54, 0.035], "rx": 0.008, "rz": 0.008, "twist": 0}, {"position": [-0.1255, 0.66, 0.07], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 5, "capEnds": true});
  if (!endpoint_branch_lateral_18) {
    mesh_branch_lateral_18Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_branch_lateral_18 = new THREE.Mesh(
    mesh_branch_lateral_18Geometry,
    materialMap["stem"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_branch_lateral_18.name = "Lateral branch";
  if (endpoint_branch_lateral_18) {
    mesh_branch_lateral_18.position.copy(endpoint_branch_lateral_18.midpoint);
    mesh_branch_lateral_18.quaternion.copy(endpoint_branch_lateral_18.quaternion);
  }
  mesh_branch_lateral_18.castShadow = options.castShadow ?? true;
  mesh_branch_lateral_18.receiveShadow = options.receiveShadow ?? true;
  mesh_branch_lateral_18.userData.sculptComponent = {"id": "branch-lateral", "name": "Lateral branch", "level": "macro", "role": "stem", "importance": 0.6, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Axillary shoot from node 3, leaning ~25 deg outward.", "geometryDescriptor": {"topologyIntent": "Axillary shoot from node 3, leaning ~25 deg outward. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0145, 0.4, 0.0], "rx": 0.01, "rz": 0.01, "twist": 0}, {"position": [-0.05550000000000001, 0.54, 0.035], "rx": 0.008, "rz": 0.008, "twist": 0}, {"position": [-0.1255, 0.66, 0.07], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0145, 0.4, 0.0], "localEnd": [-0.1255, 0.66, 0.07], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "branch-lateral", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "node2-socket", "kind": "seam", "description": "roots in the leaf axil of node 3", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 190, 90, 1.0)", "secondaryAlbedo": "rgba(110, 158, 62, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_branch_lateral_18.add(mesh_branch_lateral_18);
  meshes["branch-lateral"] = mesh_branch_lateral_18;
  colliders["branch-lateral"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["branch-lateral"] ??= [];
  destructionGroups["branch-lateral"].push(node_branch_lateral_18);

  const endpoint_branch_leaf_0_19 = makeAttachmentEndpoint(null);
  const node_branch_leaf_0_19 = new THREE.Group();
  node_branch_leaf_0_19.name = "Lateral branch leaf 1__pivot";
  node_branch_leaf_0_19.scale.set(1, 1, 1);
  if (endpoint_branch_leaf_0_19) {
    node_branch_leaf_0_19.position.copy(endpoint_branch_leaf_0_19.start);
    node_branch_leaf_0_19.rotation.set(0.0, 2.618, 0.0);
  } else {
    node_branch_leaf_0_19.position.set(-0.1255, 0.66, 0.07);
    node_branch_leaf_0_19.rotation.set(0.0, 2.618, 0.0);
  }
  node_branch_leaf_0_19.userData.sculptComponent = {"id": "branch-leaf-0", "name": "Lateral branch leaf 1", "level": "micro", "role": "leaf", "importance": 0.5, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Leaf pair at the lateral branch tip.", "geometryDescriptor": {"topologyIntent": "Leaf pair at the lateral branch tip. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0612, 0.03, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0804, 0.0391, 0.0], "rx": 0.026, "rz": 0.012, "twist": 35}, {"position": [0.1163, 0.0476, 0.0], "rx": 0.0741, "rz": 0.0263, "twist": 35}, {"position": [0.1522, 0.043, 0.0], "rx": 0.0788, "rz": 0.0279, "twist": 35}, {"position": [0.1881, 0.0254, 0.0], "rx": 0.0659, "rz": 0.0234, "twist": 35}, {"position": [0.2241, -0.0053, 0.0], "rx": 0.0404, "rz": 0.0144, "twist": 35}, {"position": [0.26, -0.0491, 0.0], "rx": 0.0, "rz": 0.0, "twist": 35}], "radialSegments": 4, "capEnds": false}}, "parent": "branch-lateral", "attachment": {"parentId": "branch-lateral", "parentSocket": "branch-lateral:node", "localStart": [-0.1255, 0.66, 0.07], "localEnd": [-0.3507, 0.6109, -0.06], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.1255, 0.66, 0.07], "rotation": [0, 2.618, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "branch-leaf-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_branch_leaf_0_19.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "branch-leaf-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["branch-lateral"] ?? root).add(node_branch_leaf_0_19);
  nodes["branch-leaf-0"] = node_branch_leaf_0_19;
  const mesh_branch_leaf_0_19Geometry = endpoint_branch_leaf_0_19
    ? new THREE.CylinderGeometry(endpoint_branch_leaf_0_19.endRadius, endpoint_branch_leaf_0_19.baseRadius, endpoint_branch_leaf_0_19.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0612, 0.03, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0804, 0.0391, 0.0], "rx": 0.026, "rz": 0.012, "twist": 35}, {"position": [0.1163, 0.0476, 0.0], "rx": 0.0741, "rz": 0.0263, "twist": 35}, {"position": [0.1522, 0.043, 0.0], "rx": 0.0788, "rz": 0.0279, "twist": 35}, {"position": [0.1881, 0.0254, 0.0], "rx": 0.0659, "rz": 0.0234, "twist": 35}, {"position": [0.2241, -0.0053, 0.0], "rx": 0.0404, "rz": 0.0144, "twist": 35}, {"position": [0.26, -0.0491, 0.0], "rx": 0.0, "rz": 0.0, "twist": 35}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_branch_leaf_0_19) {
    mesh_branch_leaf_0_19Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_branch_leaf_0_19 = new THREE.Mesh(
    mesh_branch_leaf_0_19Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_branch_leaf_0_19.name = "Lateral branch leaf 1";
  if (endpoint_branch_leaf_0_19) {
    mesh_branch_leaf_0_19.position.copy(endpoint_branch_leaf_0_19.midpoint);
    mesh_branch_leaf_0_19.quaternion.copy(endpoint_branch_leaf_0_19.quaternion);
  }
  mesh_branch_leaf_0_19.castShadow = options.castShadow ?? true;
  mesh_branch_leaf_0_19.receiveShadow = options.receiveShadow ?? true;
  mesh_branch_leaf_0_19.userData.sculptComponent = {"id": "branch-leaf-0", "name": "Lateral branch leaf 1", "level": "micro", "role": "leaf", "importance": 0.5, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Leaf pair at the lateral branch tip.", "geometryDescriptor": {"topologyIntent": "Leaf pair at the lateral branch tip. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0612, 0.03, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0804, 0.0391, 0.0], "rx": 0.026, "rz": 0.012, "twist": 35}, {"position": [0.1163, 0.0476, 0.0], "rx": 0.0741, "rz": 0.0263, "twist": 35}, {"position": [0.1522, 0.043, 0.0], "rx": 0.0788, "rz": 0.0279, "twist": 35}, {"position": [0.1881, 0.0254, 0.0], "rx": 0.0659, "rz": 0.0234, "twist": 35}, {"position": [0.2241, -0.0053, 0.0], "rx": 0.0404, "rz": 0.0144, "twist": 35}, {"position": [0.26, -0.0491, 0.0], "rx": 0.0, "rz": 0.0, "twist": 35}], "radialSegments": 4, "capEnds": false}}, "parent": "branch-lateral", "attachment": {"parentId": "branch-lateral", "parentSocket": "branch-lateral:node", "localStart": [-0.1255, 0.66, 0.07], "localEnd": [-0.3507, 0.6109, -0.06], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.1255, 0.66, 0.07], "rotation": [0, 2.618, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "branch-leaf-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.0, "microRoughness": 0.0, "bumpAmplitude": 0.0, "normalPattern": "", "displacementPattern": "", "occlusionPattern": "", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(125, 191, 69, 1.0)", "secondaryAlbedo": "rgba(94, 158, 51, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_branch_leaf_0_19.add(mesh_branch_leaf_0_19);
  meshes["branch-leaf-0"] = mesh_branch_leaf_0_19;
  colliders["branch-leaf-0"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["branch-leaf-0"] ??= [];
  destructionGroups["branch-leaf-0"].push(node_branch_leaf_0_19);
  // repetition system "decussate-leaf-pairs" describes 17 parts that are already built individually; not instanced.

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createBasilPlantLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Basil plant look-dev lights";
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
  lights.userData.lightingFromPhoto = [{"id": "key", "type": "area/window", "direction": "front-top-left, ~40 deg elevation", "intensity": "high", "color": "#FFFFFF", "evidence": "soft specular on upper leaf faces, highlight on the top-left of the cupped leaves", "hostMapping": "DirectionalLight (3,7,4) 2.2"}, {"id": "fill", "type": "environment bounce", "direction": "omnidirectional from white seamless sweep", "intensity": "high", "color": "#F4F6F2", "evidence": "very low-contrast shadows; undersides only slightly darker", "hostMapping": "HemisphereLight sky #F2F4F0 / ground #5E8F55 1.6 + Ambient 0.9"}, {"id": "rim", "type": "back/transmission", "direction": "behind, through thin leaves", "intensity": "low", "color": "#E8F5D0", "evidence": "lighter translucent leaf margins", "hostMapping": "no dedicated light; approximated by edge-lighten albedo override"}, {"id": "exposure-shadow", "type": "render settings", "exposure": "neutral 1.0, sRGB output, no tone mapping (matches host renderer)", "contactShadow": "soft contact shadow of leaves on the soil disc via host PCF shadow map; soil AO under the crown", "evidence": "faint leaf shadows on soil near the stem base"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createBasilPlantEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
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
export function frameBasilPlantCamera(
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
export function createBasilPlantPresentationComposer(
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

export function configureBasilPlantRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createBasilPlantInspectControls(
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
