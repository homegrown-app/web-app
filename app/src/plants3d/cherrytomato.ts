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

// Generated from ObjectSculptSpec target: Cherry tomato plant
// Sculpt build pass: optimization-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createCherryTomatoPlantModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Cherry tomato plant";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["leaf"] = createSculptMaterial(
    "leaf",
    {"id": "leaf", "name": "Tomato leaflet (matte, rugose)", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#2F8A4C", "color": "#2F8A4C", "albedo": {"dominant": "#2F8A4C", "secondary": ["#24502A", "#5E9E45"], "samplingNotes": "Sampled from reference regions; see image-analysis.md L6."}, "colorVariation": {"palette": ["#2F8A4C"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.6, "variation": 0.08, "map": "independent-procedural-field", "localResponse": "satin on lit faces, rougher toward margins"}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "rugose", "region": "leaflet surface", "effect": "normal 0.45", "evidenceRefs": ["full-object"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "doubleSided": true, "flatShading": true, "textureless": {"declared": true, "evidence": ["Style target is the host scene: Kenney Nature Kit models in Garden3D.tsx are flat-shaded solid-colour materials with no texture maps (measured: no map/normalMap on any Kenney material after GLTFLoader).", "User directive 2026-10-08: match the scene style (bigger, simpler, fewer details)."]}},
    options
  );
  materialMap["stem"] = createSculptMaterial(
    "stem",
    {"id": "stem", "name": "Tomato stem (matte, hairy)", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#4E9A45", "color": "#4E9A45", "albedo": {"dominant": "#4E9A45", "secondary": ["#557E30"], "samplingNotes": "Sampled from reference regions; see image-analysis.md L6."}, "colorVariation": {"palette": ["#4E9A45"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.7, "variation": 0.08, "map": "independent-procedural-field", "localResponse": "satin on lit faces, rougher toward margins"}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "hairy", "region": "stems", "effect": "roughness 0.8", "evidenceRefs": ["full-object"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "doubleSided": false, "flatShading": true, "textureless": {"declared": true, "evidence": ["Style target is the host scene: Kenney Nature Kit models in Garden3D.tsx are flat-shaded solid-colour materials with no texture maps (measured: no map/normalMap on any Kenney material after GLTFLoader).", "User directive 2026-10-08: match the scene style (bigger, simpler, fewer details)."]}},
    options
  );
  materialMap["fruit-ripe"] = createSculptMaterial(
    "fruit-ripe",
    {"id": "fruit-ripe", "name": "Ripe cherry (glossy orange)", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#F07A1A", "color": "#F07A1A", "albedo": {"dominant": "#F07A1A", "secondary": ["#C85A0E", "#FFB060"], "samplingNotes": "Sampled from reference regions; see image-analysis.md L6."}, "colorVariation": {"palette": ["#F07A1A"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.2, "variation": 0.08, "map": "independent-procedural-field", "localResponse": "satin on lit faces, rougher toward margins"}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "fruit-highlight", "region": "upper skin", "effect": "roughness 0.1 hotspot", "evidenceRefs": ["full-object"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "doubleSided": false, "flatShading": true, "clearcoat": {"base": 0.45, "variation": 0.0}, "textureless": {"declared": true, "evidence": ["Style target is the host scene: Kenney Nature Kit models in Garden3D.tsx are flat-shaded solid-colour materials with no texture maps (measured: no map/normalMap on any Kenney material after GLTFLoader).", "User directive 2026-10-08: match the scene style (bigger, simpler, fewer details)."]}},
    options
  );
  materialMap["fruit-green"] = createSculptMaterial(
    "fruit-green",
    {"id": "fruit-green", "name": "Unripe cherry (glossy green)", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#8DBE4A", "color": "#8DBE4A", "albedo": {"dominant": "#8DBE4A", "secondary": ["#6FA034", "#B2D878"], "samplingNotes": "Sampled from reference regions; see image-analysis.md L6."}, "colorVariation": {"palette": ["#8DBE4A"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.22, "variation": 0.08, "map": "independent-procedural-field", "localResponse": "satin on lit faces, rougher toward margins"}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "unripe-shoulder", "region": "fruit shoulders", "effect": "lighter #B2D878 top, darker sides", "evidenceRefs": ["full-object"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "doubleSided": false, "flatShading": true, "clearcoat": {"base": 0.4, "variation": 0.0}, "textureless": {"declared": true, "evidence": ["Style target is the host scene: Kenney Nature Kit models in Garden3D.tsx are flat-shaded solid-colour materials with no texture maps (measured: no map/normalMap on any Kenney material after GLTFLoader).", "User directive 2026-10-08: match the scene style (bigger, simpler, fewer details)."]}},
    options
  );
  materialMap["soil"] = createSculptMaterial(
    "soil",
    {"id": "soil", "name": "Moist potting soil", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#3B2A20", "color": "#3B2A20", "albedo": {"dominant": "#3B2A20", "secondary": ["#2E2018", "#B89A70"], "samplingNotes": "Sampled from reference regions; see image-analysis.md L6."}, "colorVariation": {"palette": ["#3B2A20"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.9, "variation": 0.08, "map": "independent-procedural-field", "localResponse": "satin on lit faces, rougher toward margins"}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "perlite-flecks", "region": "soil top surface", "effect": "pale flecks ~12%", "evidenceRefs": ["full-object"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "doubleSided": false, "flatShading": true, "textureless": {"declared": true, "evidence": ["Style target is the host scene: Kenney Nature Kit models in Garden3D.tsx are flat-shaded solid-colour materials with no texture maps (measured: no map/normalMap on any Kenney material after GLTFLoader).", "User directive 2026-10-08: match the scene style (bigger, simpler, fewer details)."]}},
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
  node_soil_disc_0.userData.sculptComponent = {"id": "soil-disc", "name": "Soil disc", "level": "macro", "role": "base", "importance": 0.5, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Flat soil disc; seats into any host pot.", "geometryDescriptor": {"topologyIntent": "Flat soil disc; seats into any host pot. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 0.92, "height": 0.06, "depth": 0.92, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.03, 0], "rotation": [0, 0, 0], "scale": [0.92, 0.06, 0.92]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soil-disc", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "soil", "materialLayers": ["soil"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "perlite-flecks", "kind": "stain", "description": "pale flecks", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.9, "microRoughness": 0.2, "bumpAmplitude": 0.02, "normalPattern": "moist granular soil", "displacementPattern": "", "occlusionPattern": "contact AO under the bush", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 21, 16, 1.0)", "secondaryAlbedo": "rgba(46, 32, 24, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
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
  mesh_soil_disc_0.userData.sculptComponent = {"id": "soil-disc", "name": "Soil disc", "level": "macro", "role": "base", "importance": 0.5, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Flat soil disc; seats into any host pot.", "geometryDescriptor": {"topologyIntent": "Flat soil disc; seats into any host pot. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 0.92, "height": 0.06, "depth": 0.92, "units": "relative", "confidence": 0.8}, "transform": {"position": [0, -0.03, 0], "rotation": [0, 0, 0], "scale": [0.92, 0.06, 0.92]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soil-disc", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "soil", "materialLayers": ["soil"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "perlite-flecks", "kind": "stain", "description": "pale flecks", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.9, "microRoughness": 0.2, "bumpAmplitude": 0.02, "normalPattern": "moist granular soil", "displacementPattern": "", "occlusionPattern": "contact AO under the bush", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(30, 21, 16, 1.0)", "secondaryAlbedo": "rgba(46, 32, 24, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
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
  node_stem_main_1.userData.sculptComponent = {"id": "stem-main", "name": "Main stem", "level": "macro", "role": "stem", "importance": 0.9, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Upright tapered main stem embedded in soil.", "geometryDescriptor": {"topologyIntent": "Upright tapered main stem embedded in soil. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, -0.03, 0.0], "rx": 0.03, "rz": 0.03, "twist": 0}, {"position": [0.02, 0.3, 0.01], "rx": 0.025, "rz": 0.025, "twist": 0}, {"position": [-0.01, 0.6, 0.0], "rx": 0.02, "rz": 0.02, "twist": 0}, {"position": [0.015, 0.85, -0.01], "rx": 0.014, "rz": 0.014, "twist": 0}, {"position": [0.0, 1.05, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "soil-disc", "attachment": {"parentId": "soil-disc", "parentSocket": "soil-disc:node", "localStart": [0, 0.03, 0], "localEnd": [0, 1.08, 0], "contactType": "embed", "embedDepth": 0.05, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0, 0.03, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stem-main", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "branch-socket", "kind": "seam", "description": "lateral branches at the lower stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_stem_main_1.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stem-main", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["soil-disc"] ?? root).add(node_stem_main_1);
  nodes["stem-main"] = node_stem_main_1;
  const mesh_stem_main_1Geometry = endpoint_stem_main_1
    ? new THREE.CylinderGeometry(endpoint_stem_main_1.endRadius, endpoint_stem_main_1.baseRadius, endpoint_stem_main_1.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, -0.03, 0.0], "rx": 0.03, "rz": 0.03, "twist": 0}, {"position": [0.02, 0.3, 0.01], "rx": 0.025, "rz": 0.025, "twist": 0}, {"position": [-0.01, 0.6, 0.0], "rx": 0.02, "rz": 0.02, "twist": 0}, {"position": [0.015, 0.85, -0.01], "rx": 0.014, "rz": 0.014, "twist": 0}, {"position": [0.0, 1.05, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 5, "capEnds": true});
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
  mesh_stem_main_1.userData.sculptComponent = {"id": "stem-main", "name": "Main stem", "level": "macro", "role": "stem", "importance": 0.9, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Upright tapered main stem embedded in soil.", "geometryDescriptor": {"topologyIntent": "Upright tapered main stem embedded in soil. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, -0.03, 0.0], "rx": 0.03, "rz": 0.03, "twist": 0}, {"position": [0.02, 0.3, 0.01], "rx": 0.025, "rz": 0.025, "twist": 0}, {"position": [-0.01, 0.6, 0.0], "rx": 0.02, "rz": 0.02, "twist": 0}, {"position": [0.015, 0.85, -0.01], "rx": 0.014, "rz": 0.014, "twist": 0}, {"position": [0.0, 1.05, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "soil-disc", "attachment": {"parentId": "soil-disc", "parentSocket": "soil-disc:node", "localStart": [0, 0.03, 0], "localEnd": [0, 1.08, 0], "contactType": "embed", "embedDepth": 0.05, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0, 0.03, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "stem-main", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "branch-socket", "kind": "seam", "description": "lateral branches at the lower stem", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_stem_main_1.add(mesh_stem_main_1);
  meshes["stem-main"] = mesh_stem_main_1;
  colliders["stem-main"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["stem-main"] ??= [];
  destructionGroups["stem-main"].push(node_stem_main_1);

  const endpoint_branch_0_2 = makeAttachmentEndpoint(null);
  const node_branch_0_2 = new THREE.Group();
  node_branch_0_2.name = "Lateral branch 1__pivot";
  node_branch_0_2.scale.set(1, 1, 1);
  if (endpoint_branch_0_2) {
    node_branch_0_2.position.copy(endpoint_branch_0_2.start);
    node_branch_0_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_branch_0_2.position.set(0.0, 0.0, 0.0);
    node_branch_0_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_branch_0_2.userData.sculptComponent = {"id": "branch-0", "name": "Lateral branch 1", "level": "macro", "role": "stem", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Lateral branch leaning outward from the lower stem.", "geometryDescriptor": {"topologyIntent": "Lateral branch leaning outward from the lower stem. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.22, 0.0], "rx": 0.018, "rz": 0.018, "twist": 0}, {"position": [-0.1973, 0.445, 0.0718], "rx": 0.013, "rz": 0.013, "twist": 0}, {"position": [-0.3524, 0.545, 0.1283], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.22, 0.0], "localEnd": [-0.3524, 0.545, 0.1283], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "branch-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_branch_0_2.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "branch-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_branch_0_2);
  nodes["branch-0"] = node_branch_0_2;
  const mesh_branch_0_2Geometry = endpoint_branch_0_2
    ? new THREE.CylinderGeometry(endpoint_branch_0_2.endRadius, endpoint_branch_0_2.baseRadius, endpoint_branch_0_2.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.22, 0.0], "rx": 0.018, "rz": 0.018, "twist": 0}, {"position": [-0.1973, 0.445, 0.0718], "rx": 0.013, "rz": 0.013, "twist": 0}, {"position": [-0.3524, 0.545, 0.1283], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 5, "capEnds": true});
  if (!endpoint_branch_0_2) {
    mesh_branch_0_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_branch_0_2 = new THREE.Mesh(
    mesh_branch_0_2Geometry,
    materialMap["stem"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_branch_0_2.name = "Lateral branch 1";
  if (endpoint_branch_0_2) {
    mesh_branch_0_2.position.copy(endpoint_branch_0_2.midpoint);
    mesh_branch_0_2.quaternion.copy(endpoint_branch_0_2.quaternion);
  }
  mesh_branch_0_2.castShadow = options.castShadow ?? true;
  mesh_branch_0_2.receiveShadow = options.receiveShadow ?? true;
  mesh_branch_0_2.userData.sculptComponent = {"id": "branch-0", "name": "Lateral branch 1", "level": "macro", "role": "stem", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Lateral branch leaning outward from the lower stem.", "geometryDescriptor": {"topologyIntent": "Lateral branch leaning outward from the lower stem. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.22, 0.0], "rx": 0.018, "rz": 0.018, "twist": 0}, {"position": [-0.1973, 0.445, 0.0718], "rx": 0.013, "rz": 0.013, "twist": 0}, {"position": [-0.3524, 0.545, 0.1283], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.22, 0.0], "localEnd": [-0.3524, 0.545, 0.1283], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "branch-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_branch_0_2.add(mesh_branch_0_2);
  meshes["branch-0"] = mesh_branch_0_2;
  colliders["branch-0"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["branch-0"] ??= [];
  destructionGroups["branch-0"].push(node_branch_0_2);

  const endpoint_branch_1_3 = makeAttachmentEndpoint(null);
  const node_branch_1_3 = new THREE.Group();
  node_branch_1_3.name = "Lateral branch 2__pivot";
  node_branch_1_3.scale.set(1, 1, 1);
  if (endpoint_branch_1_3) {
    node_branch_1_3.position.copy(endpoint_branch_1_3.start);
    node_branch_1_3.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_branch_1_3.position.set(0.0, 0.0, 0.0);
    node_branch_1_3.rotation.set(0.0, 0.0, 0.0);
  }
  node_branch_1_3.userData.sculptComponent = {"id": "branch-1", "name": "Lateral branch 2", "level": "macro", "role": "stem", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Lateral branch leaning outward from the lower stem.", "geometryDescriptor": {"topologyIntent": "Lateral branch leaning outward from the lower stem. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.34, 0.0], "rx": 0.018, "rz": 0.018, "twist": 0}, {"position": [0.1776, 0.5425, -0.0646], "rx": 0.013, "rz": 0.013, "twist": 0}, {"position": [0.3171, 0.6325, -0.1154], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.34, 0.0], "localEnd": [0.3171, 0.6325, -0.1154], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "branch-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_branch_1_3.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "branch-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_branch_1_3);
  nodes["branch-1"] = node_branch_1_3;
  const mesh_branch_1_3Geometry = endpoint_branch_1_3
    ? new THREE.CylinderGeometry(endpoint_branch_1_3.endRadius, endpoint_branch_1_3.baseRadius, endpoint_branch_1_3.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.34, 0.0], "rx": 0.018, "rz": 0.018, "twist": 0}, {"position": [0.1776, 0.5425, -0.0646], "rx": 0.013, "rz": 0.013, "twist": 0}, {"position": [0.3171, 0.6325, -0.1154], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 5, "capEnds": true});
  if (!endpoint_branch_1_3) {
    mesh_branch_1_3Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_branch_1_3 = new THREE.Mesh(
    mesh_branch_1_3Geometry,
    materialMap["stem"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_branch_1_3.name = "Lateral branch 2";
  if (endpoint_branch_1_3) {
    mesh_branch_1_3.position.copy(endpoint_branch_1_3.midpoint);
    mesh_branch_1_3.quaternion.copy(endpoint_branch_1_3.quaternion);
  }
  mesh_branch_1_3.castShadow = options.castShadow ?? true;
  mesh_branch_1_3.receiveShadow = options.receiveShadow ?? true;
  mesh_branch_1_3.userData.sculptComponent = {"id": "branch-1", "name": "Lateral branch 2", "level": "macro", "role": "stem", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Lateral branch leaning outward from the lower stem.", "geometryDescriptor": {"topologyIntent": "Lateral branch leaning outward from the lower stem. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.34, 0.0], "rx": 0.018, "rz": 0.018, "twist": 0}, {"position": [0.1776, 0.5425, -0.0646], "rx": 0.013, "rz": 0.013, "twist": 0}, {"position": [0.3171, 0.6325, -0.1154], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.34, 0.0], "localEnd": [0.3171, 0.6325, -0.1154], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "branch-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_branch_1_3.add(mesh_branch_1_3);
  meshes["branch-1"] = mesh_branch_1_3;
  colliders["branch-1"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["branch-1"] ??= [];
  destructionGroups["branch-1"].push(node_branch_1_3);

  const endpoint_rachis_0_4 = makeAttachmentEndpoint(null);
  const node_rachis_0_4 = new THREE.Group();
  node_rachis_0_4.name = "Compound leaf 1 rachis__pivot";
  node_rachis_0_4.scale.set(1, 1, 1);
  if (endpoint_rachis_0_4) {
    node_rachis_0_4.position.copy(endpoint_rachis_0_4.start);
    node_rachis_0_4.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_rachis_0_4.position.set(0.0, 0.4, 0.0);
    node_rachis_0_4.rotation.set(0.0, 0.0, 0.0);
  }
  node_rachis_0_4.userData.sculptComponent = {"id": "rachis-0", "name": "Compound leaf 1 rachis", "level": "meso", "role": "leaf", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Arching rachis of a pinnate compound leaf.", "geometryDescriptor": {"topologyIntent": "Arching rachis of a pinnate compound leaf. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.096, 0.071, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.192, 0.1114, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.288, 0.121, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.384, 0.0998, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.48, 0.048, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.4, 0.0], "localEnd": [0.48, 0.448, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.4, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pinnate", "kind": "contour", "description": "terminal leaflet + 2 opposite pairs", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_rachis_0_4.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_rachis_0_4);
  nodes["rachis-0"] = node_rachis_0_4;
  const mesh_rachis_0_4Geometry = endpoint_rachis_0_4
    ? new THREE.CylinderGeometry(endpoint_rachis_0_4.endRadius, endpoint_rachis_0_4.baseRadius, endpoint_rachis_0_4.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.096, 0.071, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.192, 0.1114, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.288, 0.121, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.384, 0.0998, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.48, 0.048, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true});
  if (!endpoint_rachis_0_4) {
    mesh_rachis_0_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rachis_0_4 = new THREE.Mesh(
    mesh_rachis_0_4Geometry,
    materialMap["stem"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rachis_0_4.name = "Compound leaf 1 rachis";
  if (endpoint_rachis_0_4) {
    mesh_rachis_0_4.position.copy(endpoint_rachis_0_4.midpoint);
    mesh_rachis_0_4.quaternion.copy(endpoint_rachis_0_4.quaternion);
  }
  mesh_rachis_0_4.castShadow = options.castShadow ?? true;
  mesh_rachis_0_4.receiveShadow = options.receiveShadow ?? true;
  mesh_rachis_0_4.userData.sculptComponent = {"id": "rachis-0", "name": "Compound leaf 1 rachis", "level": "meso", "role": "leaf", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Arching rachis of a pinnate compound leaf.", "geometryDescriptor": {"topologyIntent": "Arching rachis of a pinnate compound leaf. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.096, 0.071, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.192, 0.1114, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.288, 0.121, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.384, 0.0998, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.48, 0.048, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.4, 0.0], "localEnd": [0.48, 0.448, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.4, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pinnate", "kind": "contour", "description": "terminal leaflet + 2 opposite pairs", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_rachis_0_4.add(mesh_rachis_0_4);
  meshes["rachis-0"] = mesh_rachis_0_4;
  colliders["rachis-0"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["rachis-0"] ??= [];
  destructionGroups["rachis-0"].push(node_rachis_0_4);

  const endpoint_leaflet_02_5 = makeAttachmentEndpoint(null);
  const node_leaflet_02_5 = new THREE.Group();
  node_leaflet_02_5.name = "Leaf 1 leaflet 3__pivot";
  node_leaflet_02_5.scale.set(1, 1, 1);
  if (endpoint_leaflet_02_5) {
    node_leaflet_02_5.position.copy(endpoint_leaflet_02_5.start);
    node_leaflet_02_5.rotation.set(0.0, -1.2217, 0.0);
  } else {
    node_leaflet_02_5.position.set(0.384, 0.0998, 0.0);
    node_leaflet_02_5.rotation.set(0.0, -1.2217, 0.0);
  }
  node_leaflet_02_5.userData.sculptComponent = {"id": "leaflet-02", "name": "Leaf 1 leaflet 3", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.035, 0.01, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0731, 0.0183, 0.0], "rx": 0.0549, "rz": 0.0153, "twist": -30}, {"position": [0.1479, 0.006, 0.0], "rx": 0.106, "rz": 0.0293, "twist": -30}, {"position": [0.2228, -0.0448, 0.0], "rx": 0.0775, "rz": 0.0214, "twist": -30}, {"position": [0.2976, -0.134, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-0", "attachment": {"parentId": "rachis-0", "parentSocket": "rachis-0:node", "localStart": [0.384, 0.0998, 0.0], "localEnd": [0.4858, -0.0342, 0.2797], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.384, 0.0998, 0.0], "rotation": [0, -1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_02_5.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-0"] ?? root).add(node_leaflet_02_5);
  nodes["leaflet-02"] = node_leaflet_02_5;
  const mesh_leaflet_02_5Geometry = endpoint_leaflet_02_5
    ? new THREE.CylinderGeometry(endpoint_leaflet_02_5.endRadius, endpoint_leaflet_02_5.baseRadius, endpoint_leaflet_02_5.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.035, 0.01, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0731, 0.0183, 0.0], "rx": 0.0549, "rz": 0.0153, "twist": -30}, {"position": [0.1479, 0.006, 0.0], "rx": 0.106, "rz": 0.0293, "twist": -30}, {"position": [0.2228, -0.0448, 0.0], "rx": 0.0775, "rz": 0.0214, "twist": -30}, {"position": [0.2976, -0.134, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_02_5) {
    mesh_leaflet_02_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_02_5 = new THREE.Mesh(
    mesh_leaflet_02_5Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_02_5.name = "Leaf 1 leaflet 3";
  if (endpoint_leaflet_02_5) {
    mesh_leaflet_02_5.position.copy(endpoint_leaflet_02_5.midpoint);
    mesh_leaflet_02_5.quaternion.copy(endpoint_leaflet_02_5.quaternion);
  }
  mesh_leaflet_02_5.castShadow = options.castShadow ?? true;
  mesh_leaflet_02_5.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_02_5.userData.sculptComponent = {"id": "leaflet-02", "name": "Leaf 1 leaflet 3", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.035, 0.01, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0731, 0.0183, 0.0], "rx": 0.0549, "rz": 0.0153, "twist": -30}, {"position": [0.1479, 0.006, 0.0], "rx": 0.106, "rz": 0.0293, "twist": -30}, {"position": [0.2228, -0.0448, 0.0], "rx": 0.0775, "rz": 0.0214, "twist": -30}, {"position": [0.2976, -0.134, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-0", "attachment": {"parentId": "rachis-0", "parentSocket": "rachis-0:node", "localStart": [0.384, 0.0998, 0.0], "localEnd": [0.4858, -0.0342, 0.2797], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.384, 0.0998, 0.0], "rotation": [0, -1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_02_5.add(mesh_leaflet_02_5);
  meshes["leaflet-02"] = mesh_leaflet_02_5;
  colliders["leaflet-02"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-02"] ??= [];
  destructionGroups["leaflet-02"].push(node_leaflet_02_5);

  const endpoint_leaflet_03_6 = makeAttachmentEndpoint(null);
  const node_leaflet_03_6 = new THREE.Group();
  node_leaflet_03_6.name = "Leaf 1 leaflet 4__pivot";
  node_leaflet_03_6.scale.set(1, 1, 1);
  if (endpoint_leaflet_03_6) {
    node_leaflet_03_6.position.copy(endpoint_leaflet_03_6.start);
    node_leaflet_03_6.rotation.set(0.0, 1.2217, 0.0);
  } else {
    node_leaflet_03_6.position.set(0.384, 0.0998, 0.0);
    node_leaflet_03_6.rotation.set(0.0, 1.2217, 0.0);
  }
  node_leaflet_03_6.userData.sculptComponent = {"id": "leaflet-03", "name": "Leaf 1 leaflet 4", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.035, 0.01, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0731, 0.0183, 0.0], "rx": 0.0549, "rz": 0.0153, "twist": 30}, {"position": [0.1479, 0.006, 0.0], "rx": 0.106, "rz": 0.0293, "twist": 30}, {"position": [0.2228, -0.0448, 0.0], "rx": 0.0775, "rz": 0.0214, "twist": 30}, {"position": [0.2976, -0.134, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-0", "attachment": {"parentId": "rachis-0", "parentSocket": "rachis-0:node", "localStart": [0.384, 0.0998, 0.0], "localEnd": [0.4858, -0.0342, -0.2797], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.384, 0.0998, 0.0], "rotation": [0, 1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_03_6.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-0"] ?? root).add(node_leaflet_03_6);
  nodes["leaflet-03"] = node_leaflet_03_6;
  const mesh_leaflet_03_6Geometry = endpoint_leaflet_03_6
    ? new THREE.CylinderGeometry(endpoint_leaflet_03_6.endRadius, endpoint_leaflet_03_6.baseRadius, endpoint_leaflet_03_6.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.035, 0.01, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0731, 0.0183, 0.0], "rx": 0.0549, "rz": 0.0153, "twist": 30}, {"position": [0.1479, 0.006, 0.0], "rx": 0.106, "rz": 0.0293, "twist": 30}, {"position": [0.2228, -0.0448, 0.0], "rx": 0.0775, "rz": 0.0214, "twist": 30}, {"position": [0.2976, -0.134, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_03_6) {
    mesh_leaflet_03_6Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_03_6 = new THREE.Mesh(
    mesh_leaflet_03_6Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_03_6.name = "Leaf 1 leaflet 4";
  if (endpoint_leaflet_03_6) {
    mesh_leaflet_03_6.position.copy(endpoint_leaflet_03_6.midpoint);
    mesh_leaflet_03_6.quaternion.copy(endpoint_leaflet_03_6.quaternion);
  }
  mesh_leaflet_03_6.castShadow = options.castShadow ?? true;
  mesh_leaflet_03_6.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_03_6.userData.sculptComponent = {"id": "leaflet-03", "name": "Leaf 1 leaflet 4", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.035, 0.01, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0731, 0.0183, 0.0], "rx": 0.0549, "rz": 0.0153, "twist": 30}, {"position": [0.1479, 0.006, 0.0], "rx": 0.106, "rz": 0.0293, "twist": 30}, {"position": [0.2228, -0.0448, 0.0], "rx": 0.0775, "rz": 0.0214, "twist": 30}, {"position": [0.2976, -0.134, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-0", "attachment": {"parentId": "rachis-0", "parentSocket": "rachis-0:node", "localStart": [0.384, 0.0998, 0.0], "localEnd": [0.4858, -0.0342, -0.2797], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.384, 0.0998, 0.0], "rotation": [0, 1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_03_6.add(mesh_leaflet_03_6);
  meshes["leaflet-03"] = mesh_leaflet_03_6;
  colliders["leaflet-03"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-03"] ??= [];
  destructionGroups["leaflet-03"].push(node_leaflet_03_6);

  const endpoint_leaflet_04_7 = makeAttachmentEndpoint(null);
  const node_leaflet_04_7 = new THREE.Group();
  node_leaflet_04_7.name = "Leaf 1 leaflet 5__pivot";
  node_leaflet_04_7.scale.set(1, 1, 1);
  if (endpoint_leaflet_04_7) {
    node_leaflet_04_7.position.copy(endpoint_leaflet_04_7.start);
    node_leaflet_04_7.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leaflet_04_7.position.set(0.48, 0.048, 0.0);
    node_leaflet_04_7.rotation.set(0.0, 0.0, 0.0);
  }
  node_leaflet_04_7.userData.sculptComponent = {"id": "leaflet-04", "name": "Leaf 1 leaflet 5", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0406, 0.0116, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0849, 0.0212, 0.0], "rx": 0.0639, "rz": 0.0176, "twist": 0}, {"position": [0.1718, 0.007, 0.0], "rx": 0.1231, "rz": 0.0342, "twist": 0}, {"position": [0.2587, -0.052, 0.0], "rx": 0.0899, "rz": 0.025, "twist": 0}, {"position": [0.3456, -0.1557, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-0", "attachment": {"parentId": "rachis-0", "parentSocket": "rachis-0:node", "localStart": [0.48, 0.048, 0.0], "localEnd": [0.8256, -0.1077, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.48, 0.048, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_04_7.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-0"] ?? root).add(node_leaflet_04_7);
  nodes["leaflet-04"] = node_leaflet_04_7;
  const mesh_leaflet_04_7Geometry = endpoint_leaflet_04_7
    ? new THREE.CylinderGeometry(endpoint_leaflet_04_7.endRadius, endpoint_leaflet_04_7.baseRadius, endpoint_leaflet_04_7.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0406, 0.0116, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0849, 0.0212, 0.0], "rx": 0.0639, "rz": 0.0176, "twist": 0}, {"position": [0.1718, 0.007, 0.0], "rx": 0.1231, "rz": 0.0342, "twist": 0}, {"position": [0.2587, -0.052, 0.0], "rx": 0.0899, "rz": 0.025, "twist": 0}, {"position": [0.3456, -0.1557, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_04_7) {
    mesh_leaflet_04_7Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_04_7 = new THREE.Mesh(
    mesh_leaflet_04_7Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_04_7.name = "Leaf 1 leaflet 5";
  if (endpoint_leaflet_04_7) {
    mesh_leaflet_04_7.position.copy(endpoint_leaflet_04_7.midpoint);
    mesh_leaflet_04_7.quaternion.copy(endpoint_leaflet_04_7.quaternion);
  }
  mesh_leaflet_04_7.castShadow = options.castShadow ?? true;
  mesh_leaflet_04_7.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_04_7.userData.sculptComponent = {"id": "leaflet-04", "name": "Leaf 1 leaflet 5", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0406, 0.0116, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0849, 0.0212, 0.0], "rx": 0.0639, "rz": 0.0176, "twist": 0}, {"position": [0.1718, 0.007, 0.0], "rx": 0.1231, "rz": 0.0342, "twist": 0}, {"position": [0.2587, -0.052, 0.0], "rx": 0.0899, "rz": 0.025, "twist": 0}, {"position": [0.3456, -0.1557, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-0", "attachment": {"parentId": "rachis-0", "parentSocket": "rachis-0:node", "localStart": [0.48, 0.048, 0.0], "localEnd": [0.8256, -0.1077, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.48, 0.048, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-04", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_04_7.add(mesh_leaflet_04_7);
  meshes["leaflet-04"] = mesh_leaflet_04_7;
  colliders["leaflet-04"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-04"] ??= [];
  destructionGroups["leaflet-04"].push(node_leaflet_04_7);

  const endpoint_rachis_1_8 = makeAttachmentEndpoint(null);
  const node_rachis_1_8 = new THREE.Group();
  node_rachis_1_8.name = "Compound leaf 2 rachis__pivot";
  node_rachis_1_8.scale.set(1, 1, 1);
  if (endpoint_rachis_1_8) {
    node_rachis_1_8.position.copy(endpoint_rachis_1_8.start);
    node_rachis_1_8.rotation.set(0.0, 2.3998, 0.0);
  } else {
    node_rachis_1_8.position.set(0.0, 0.48, 0.0);
    node_rachis_1_8.rotation.set(0.0, 2.3998, 0.0);
  }
  node_rachis_1_8.userData.sculptComponent = {"id": "rachis-1", "name": "Compound leaf 2 rachis", "level": "meso", "role": "leaf", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Arching rachis of a pinnate compound leaf.", "geometryDescriptor": {"topologyIntent": "Arching rachis of a pinnate compound leaf. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.091, 0.0673, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.182, 0.1056, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.273, 0.1147, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.364, 0.0946, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.455, 0.0455, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.48, 0.0], "localEnd": [-0.3355, 0.5255, -0.3074], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.48, 0.0], "rotation": [0, 2.3998, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pinnate", "kind": "contour", "description": "terminal leaflet + 2 opposite pairs", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_rachis_1_8.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_rachis_1_8);
  nodes["rachis-1"] = node_rachis_1_8;
  const mesh_rachis_1_8Geometry = endpoint_rachis_1_8
    ? new THREE.CylinderGeometry(endpoint_rachis_1_8.endRadius, endpoint_rachis_1_8.baseRadius, endpoint_rachis_1_8.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.091, 0.0673, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.182, 0.1056, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.273, 0.1147, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.364, 0.0946, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.455, 0.0455, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true});
  if (!endpoint_rachis_1_8) {
    mesh_rachis_1_8Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rachis_1_8 = new THREE.Mesh(
    mesh_rachis_1_8Geometry,
    materialMap["stem"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rachis_1_8.name = "Compound leaf 2 rachis";
  if (endpoint_rachis_1_8) {
    mesh_rachis_1_8.position.copy(endpoint_rachis_1_8.midpoint);
    mesh_rachis_1_8.quaternion.copy(endpoint_rachis_1_8.quaternion);
  }
  mesh_rachis_1_8.castShadow = options.castShadow ?? true;
  mesh_rachis_1_8.receiveShadow = options.receiveShadow ?? true;
  mesh_rachis_1_8.userData.sculptComponent = {"id": "rachis-1", "name": "Compound leaf 2 rachis", "level": "meso", "role": "leaf", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Arching rachis of a pinnate compound leaf.", "geometryDescriptor": {"topologyIntent": "Arching rachis of a pinnate compound leaf. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.091, 0.0673, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.182, 0.1056, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.273, 0.1147, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.364, 0.0946, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.455, 0.0455, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.48, 0.0], "localEnd": [-0.3355, 0.5255, -0.3074], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.48, 0.0], "rotation": [0, 2.3998, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pinnate", "kind": "contour", "description": "terminal leaflet + 2 opposite pairs", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_rachis_1_8.add(mesh_rachis_1_8);
  meshes["rachis-1"] = mesh_rachis_1_8;
  colliders["rachis-1"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["rachis-1"] ??= [];
  destructionGroups["rachis-1"].push(node_rachis_1_8);

  const endpoint_leaflet_07_9 = makeAttachmentEndpoint(null);
  const node_leaflet_07_9 = new THREE.Group();
  node_leaflet_07_9.name = "Leaf 2 leaflet 3__pivot";
  node_leaflet_07_9.scale.set(1, 1, 1);
  if (endpoint_leaflet_07_9) {
    node_leaflet_07_9.position.copy(endpoint_leaflet_07_9.start);
    node_leaflet_07_9.rotation.set(0.0, -1.2217, 0.0);
  } else {
    node_leaflet_07_9.position.set(0.364, 0.0946, 0.0);
    node_leaflet_07_9.rotation.set(0.0, -1.2217, 0.0);
  }
  node_leaflet_07_9.userData.sculptComponent = {"id": "leaflet-07", "name": "Leaf 2 leaflet 3", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0332, 0.0095, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0693, 0.0173, 0.0], "rx": 0.0521, "rz": 0.0144, "twist": -30}, {"position": [0.1402, 0.0057, 0.0], "rx": 0.1006, "rz": 0.0279, "twist": -30}, {"position": [0.2112, -0.0425, 0.0], "rx": 0.0734, "rz": 0.0203, "twist": -30}, {"position": [0.2821, -0.1271, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-1", "attachment": {"parentId": "rachis-1", "parentSocket": "rachis-1:node", "localStart": [0.364, 0.0946, 0.0], "localEnd": [0.4605, -0.0325, 0.2651], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.364, 0.0946, 0.0], "rotation": [0, -1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-07", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_07_9.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-07", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-1"] ?? root).add(node_leaflet_07_9);
  nodes["leaflet-07"] = node_leaflet_07_9;
  const mesh_leaflet_07_9Geometry = endpoint_leaflet_07_9
    ? new THREE.CylinderGeometry(endpoint_leaflet_07_9.endRadius, endpoint_leaflet_07_9.baseRadius, endpoint_leaflet_07_9.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0332, 0.0095, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0693, 0.0173, 0.0], "rx": 0.0521, "rz": 0.0144, "twist": -30}, {"position": [0.1402, 0.0057, 0.0], "rx": 0.1006, "rz": 0.0279, "twist": -30}, {"position": [0.2112, -0.0425, 0.0], "rx": 0.0734, "rz": 0.0203, "twist": -30}, {"position": [0.2821, -0.1271, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_07_9) {
    mesh_leaflet_07_9Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_07_9 = new THREE.Mesh(
    mesh_leaflet_07_9Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_07_9.name = "Leaf 2 leaflet 3";
  if (endpoint_leaflet_07_9) {
    mesh_leaflet_07_9.position.copy(endpoint_leaflet_07_9.midpoint);
    mesh_leaflet_07_9.quaternion.copy(endpoint_leaflet_07_9.quaternion);
  }
  mesh_leaflet_07_9.castShadow = options.castShadow ?? true;
  mesh_leaflet_07_9.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_07_9.userData.sculptComponent = {"id": "leaflet-07", "name": "Leaf 2 leaflet 3", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0332, 0.0095, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0693, 0.0173, 0.0], "rx": 0.0521, "rz": 0.0144, "twist": -30}, {"position": [0.1402, 0.0057, 0.0], "rx": 0.1006, "rz": 0.0279, "twist": -30}, {"position": [0.2112, -0.0425, 0.0], "rx": 0.0734, "rz": 0.0203, "twist": -30}, {"position": [0.2821, -0.1271, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-1", "attachment": {"parentId": "rachis-1", "parentSocket": "rachis-1:node", "localStart": [0.364, 0.0946, 0.0], "localEnd": [0.4605, -0.0325, 0.2651], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.364, 0.0946, 0.0], "rotation": [0, -1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-07", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_07_9.add(mesh_leaflet_07_9);
  meshes["leaflet-07"] = mesh_leaflet_07_9;
  colliders["leaflet-07"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-07"] ??= [];
  destructionGroups["leaflet-07"].push(node_leaflet_07_9);

  const endpoint_leaflet_08_10 = makeAttachmentEndpoint(null);
  const node_leaflet_08_10 = new THREE.Group();
  node_leaflet_08_10.name = "Leaf 2 leaflet 4__pivot";
  node_leaflet_08_10.scale.set(1, 1, 1);
  if (endpoint_leaflet_08_10) {
    node_leaflet_08_10.position.copy(endpoint_leaflet_08_10.start);
    node_leaflet_08_10.rotation.set(0.0, 1.2217, 0.0);
  } else {
    node_leaflet_08_10.position.set(0.364, 0.0946, 0.0);
    node_leaflet_08_10.rotation.set(0.0, 1.2217, 0.0);
  }
  node_leaflet_08_10.userData.sculptComponent = {"id": "leaflet-08", "name": "Leaf 2 leaflet 4", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0332, 0.0095, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0693, 0.0173, 0.0], "rx": 0.0521, "rz": 0.0144, "twist": 30}, {"position": [0.1402, 0.0057, 0.0], "rx": 0.1006, "rz": 0.0279, "twist": 30}, {"position": [0.2112, -0.0425, 0.0], "rx": 0.0734, "rz": 0.0203, "twist": 30}, {"position": [0.2821, -0.1271, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-1", "attachment": {"parentId": "rachis-1", "parentSocket": "rachis-1:node", "localStart": [0.364, 0.0946, 0.0], "localEnd": [0.4605, -0.0325, -0.2651], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.364, 0.0946, 0.0], "rotation": [0, 1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-08", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_08_10.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-08", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-1"] ?? root).add(node_leaflet_08_10);
  nodes["leaflet-08"] = node_leaflet_08_10;
  const mesh_leaflet_08_10Geometry = endpoint_leaflet_08_10
    ? new THREE.CylinderGeometry(endpoint_leaflet_08_10.endRadius, endpoint_leaflet_08_10.baseRadius, endpoint_leaflet_08_10.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0332, 0.0095, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0693, 0.0173, 0.0], "rx": 0.0521, "rz": 0.0144, "twist": 30}, {"position": [0.1402, 0.0057, 0.0], "rx": 0.1006, "rz": 0.0279, "twist": 30}, {"position": [0.2112, -0.0425, 0.0], "rx": 0.0734, "rz": 0.0203, "twist": 30}, {"position": [0.2821, -0.1271, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_08_10) {
    mesh_leaflet_08_10Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_08_10 = new THREE.Mesh(
    mesh_leaflet_08_10Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_08_10.name = "Leaf 2 leaflet 4";
  if (endpoint_leaflet_08_10) {
    mesh_leaflet_08_10.position.copy(endpoint_leaflet_08_10.midpoint);
    mesh_leaflet_08_10.quaternion.copy(endpoint_leaflet_08_10.quaternion);
  }
  mesh_leaflet_08_10.castShadow = options.castShadow ?? true;
  mesh_leaflet_08_10.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_08_10.userData.sculptComponent = {"id": "leaflet-08", "name": "Leaf 2 leaflet 4", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0332, 0.0095, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0693, 0.0173, 0.0], "rx": 0.0521, "rz": 0.0144, "twist": 30}, {"position": [0.1402, 0.0057, 0.0], "rx": 0.1006, "rz": 0.0279, "twist": 30}, {"position": [0.2112, -0.0425, 0.0], "rx": 0.0734, "rz": 0.0203, "twist": 30}, {"position": [0.2821, -0.1271, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-1", "attachment": {"parentId": "rachis-1", "parentSocket": "rachis-1:node", "localStart": [0.364, 0.0946, 0.0], "localEnd": [0.4605, -0.0325, -0.2651], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.364, 0.0946, 0.0], "rotation": [0, 1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-08", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_08_10.add(mesh_leaflet_08_10);
  meshes["leaflet-08"] = mesh_leaflet_08_10;
  colliders["leaflet-08"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-08"] ??= [];
  destructionGroups["leaflet-08"].push(node_leaflet_08_10);

  const endpoint_leaflet_09_11 = makeAttachmentEndpoint(null);
  const node_leaflet_09_11 = new THREE.Group();
  node_leaflet_09_11.name = "Leaf 2 leaflet 5__pivot";
  node_leaflet_09_11.scale.set(1, 1, 1);
  if (endpoint_leaflet_09_11) {
    node_leaflet_09_11.position.copy(endpoint_leaflet_09_11.start);
    node_leaflet_09_11.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leaflet_09_11.position.set(0.455, 0.0455, 0.0);
    node_leaflet_09_11.rotation.set(0.0, 0.0, 0.0);
  }
  node_leaflet_09_11.userData.sculptComponent = {"id": "leaflet-09", "name": "Leaf 2 leaflet 5", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0385, 0.011, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0805, 0.0201, 0.0], "rx": 0.0605, "rz": 0.0167, "twist": 0}, {"position": [0.1629, 0.0066, 0.0], "rx": 0.1168, "rz": 0.0324, "twist": 0}, {"position": [0.2452, -0.0493, 0.0], "rx": 0.0852, "rz": 0.0236, "twist": 0}, {"position": [0.3276, -0.1476, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-1", "attachment": {"parentId": "rachis-1", "parentSocket": "rachis-1:node", "localStart": [0.455, 0.0455, 0.0], "localEnd": [0.7826, -0.1021, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.455, 0.0455, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-09", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_09_11.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-09", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-1"] ?? root).add(node_leaflet_09_11);
  nodes["leaflet-09"] = node_leaflet_09_11;
  const mesh_leaflet_09_11Geometry = endpoint_leaflet_09_11
    ? new THREE.CylinderGeometry(endpoint_leaflet_09_11.endRadius, endpoint_leaflet_09_11.baseRadius, endpoint_leaflet_09_11.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0385, 0.011, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0805, 0.0201, 0.0], "rx": 0.0605, "rz": 0.0167, "twist": 0}, {"position": [0.1629, 0.0066, 0.0], "rx": 0.1168, "rz": 0.0324, "twist": 0}, {"position": [0.2452, -0.0493, 0.0], "rx": 0.0852, "rz": 0.0236, "twist": 0}, {"position": [0.3276, -0.1476, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_09_11) {
    mesh_leaflet_09_11Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_09_11 = new THREE.Mesh(
    mesh_leaflet_09_11Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_09_11.name = "Leaf 2 leaflet 5";
  if (endpoint_leaflet_09_11) {
    mesh_leaflet_09_11.position.copy(endpoint_leaflet_09_11.midpoint);
    mesh_leaflet_09_11.quaternion.copy(endpoint_leaflet_09_11.quaternion);
  }
  mesh_leaflet_09_11.castShadow = options.castShadow ?? true;
  mesh_leaflet_09_11.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_09_11.userData.sculptComponent = {"id": "leaflet-09", "name": "Leaf 2 leaflet 5", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0385, 0.011, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0805, 0.0201, 0.0], "rx": 0.0605, "rz": 0.0167, "twist": 0}, {"position": [0.1629, 0.0066, 0.0], "rx": 0.1168, "rz": 0.0324, "twist": 0}, {"position": [0.2452, -0.0493, 0.0], "rx": 0.0852, "rz": 0.0236, "twist": 0}, {"position": [0.3276, -0.1476, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-1", "attachment": {"parentId": "rachis-1", "parentSocket": "rachis-1:node", "localStart": [0.455, 0.0455, 0.0], "localEnd": [0.7826, -0.1021, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.455, 0.0455, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-09", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_09_11.add(mesh_leaflet_09_11);
  meshes["leaflet-09"] = mesh_leaflet_09_11;
  colliders["leaflet-09"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-09"] ??= [];
  destructionGroups["leaflet-09"].push(node_leaflet_09_11);

  const endpoint_rachis_2_12 = makeAttachmentEndpoint(null);
  const node_rachis_2_12 = new THREE.Group();
  node_rachis_2_12.name = "Compound leaf 3 rachis__pivot";
  node_rachis_2_12.scale.set(1, 1, 1);
  if (endpoint_rachis_2_12) {
    node_rachis_2_12.position.copy(endpoint_rachis_2_12.start);
    node_rachis_2_12.rotation.set(0.0, 4.7997, 0.0);
  } else {
    node_rachis_2_12.position.set(0.0, 0.56, 0.0);
    node_rachis_2_12.rotation.set(0.0, 4.7997, 0.0);
  }
  node_rachis_2_12.userData.sculptComponent = {"id": "rachis-2", "name": "Compound leaf 3 rachis", "level": "meso", "role": "leaf", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Arching rachis of a pinnate compound leaf.", "geometryDescriptor": {"topologyIntent": "Arching rachis of a pinnate compound leaf. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.086, 0.0636, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.172, 0.0998, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.258, 0.1084, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.344, 0.0894, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.43, 0.043, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.56, 0.0], "localEnd": [0.0375, 0.603, 0.4284], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.56, 0.0], "rotation": [0, 4.7997, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pinnate", "kind": "contour", "description": "terminal leaflet + 2 opposite pairs", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_rachis_2_12.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_rachis_2_12);
  nodes["rachis-2"] = node_rachis_2_12;
  const mesh_rachis_2_12Geometry = endpoint_rachis_2_12
    ? new THREE.CylinderGeometry(endpoint_rachis_2_12.endRadius, endpoint_rachis_2_12.baseRadius, endpoint_rachis_2_12.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.086, 0.0636, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.172, 0.0998, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.258, 0.1084, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.344, 0.0894, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.43, 0.043, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true});
  if (!endpoint_rachis_2_12) {
    mesh_rachis_2_12Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rachis_2_12 = new THREE.Mesh(
    mesh_rachis_2_12Geometry,
    materialMap["stem"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rachis_2_12.name = "Compound leaf 3 rachis";
  if (endpoint_rachis_2_12) {
    mesh_rachis_2_12.position.copy(endpoint_rachis_2_12.midpoint);
    mesh_rachis_2_12.quaternion.copy(endpoint_rachis_2_12.quaternion);
  }
  mesh_rachis_2_12.castShadow = options.castShadow ?? true;
  mesh_rachis_2_12.receiveShadow = options.receiveShadow ?? true;
  mesh_rachis_2_12.userData.sculptComponent = {"id": "rachis-2", "name": "Compound leaf 3 rachis", "level": "meso", "role": "leaf", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Arching rachis of a pinnate compound leaf.", "geometryDescriptor": {"topologyIntent": "Arching rachis of a pinnate compound leaf. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.086, 0.0636, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.172, 0.0998, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.258, 0.1084, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.344, 0.0894, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.43, 0.043, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.56, 0.0], "localEnd": [0.0375, 0.603, 0.4284], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.56, 0.0], "rotation": [0, 4.7997, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pinnate", "kind": "contour", "description": "terminal leaflet + 2 opposite pairs", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_rachis_2_12.add(mesh_rachis_2_12);
  meshes["rachis-2"] = mesh_rachis_2_12;
  colliders["rachis-2"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["rachis-2"] ??= [];
  destructionGroups["rachis-2"].push(node_rachis_2_12);

  const endpoint_leaflet_12_13 = makeAttachmentEndpoint(null);
  const node_leaflet_12_13 = new THREE.Group();
  node_leaflet_12_13.name = "Leaf 3 leaflet 3__pivot";
  node_leaflet_12_13.scale.set(1, 1, 1);
  if (endpoint_leaflet_12_13) {
    node_leaflet_12_13.position.copy(endpoint_leaflet_12_13.start);
    node_leaflet_12_13.rotation.set(0.0, -1.2217, 0.0);
  } else {
    node_leaflet_12_13.position.set(0.344, 0.0894, 0.0);
    node_leaflet_12_13.rotation.set(0.0, -1.2217, 0.0);
  }
  node_leaflet_12_13.userData.sculptComponent = {"id": "leaflet-12", "name": "Leaf 3 leaflet 3", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0314, 0.009, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0655, 0.0164, 0.0], "rx": 0.0493, "rz": 0.0137, "twist": -30}, {"position": [0.1325, 0.0054, 0.0], "rx": 0.095, "rz": 0.0263, "twist": -30}, {"position": [0.1996, -0.0401, 0.0], "rx": 0.0694, "rz": 0.0193, "twist": -30}, {"position": [0.2666, -0.1201, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-2", "attachment": {"parentId": "rachis-2", "parentSocket": "rachis-2:node", "localStart": [0.344, 0.0894, 0.0], "localEnd": [0.4352, -0.0307, 0.2505], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.344, 0.0894, 0.0], "rotation": [0, -1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-12", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_12_13.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-12", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-2"] ?? root).add(node_leaflet_12_13);
  nodes["leaflet-12"] = node_leaflet_12_13;
  const mesh_leaflet_12_13Geometry = endpoint_leaflet_12_13
    ? new THREE.CylinderGeometry(endpoint_leaflet_12_13.endRadius, endpoint_leaflet_12_13.baseRadius, endpoint_leaflet_12_13.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0314, 0.009, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0655, 0.0164, 0.0], "rx": 0.0493, "rz": 0.0137, "twist": -30}, {"position": [0.1325, 0.0054, 0.0], "rx": 0.095, "rz": 0.0263, "twist": -30}, {"position": [0.1996, -0.0401, 0.0], "rx": 0.0694, "rz": 0.0193, "twist": -30}, {"position": [0.2666, -0.1201, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_12_13) {
    mesh_leaflet_12_13Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_12_13 = new THREE.Mesh(
    mesh_leaflet_12_13Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_12_13.name = "Leaf 3 leaflet 3";
  if (endpoint_leaflet_12_13) {
    mesh_leaflet_12_13.position.copy(endpoint_leaflet_12_13.midpoint);
    mesh_leaflet_12_13.quaternion.copy(endpoint_leaflet_12_13.quaternion);
  }
  mesh_leaflet_12_13.castShadow = options.castShadow ?? true;
  mesh_leaflet_12_13.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_12_13.userData.sculptComponent = {"id": "leaflet-12", "name": "Leaf 3 leaflet 3", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0314, 0.009, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0655, 0.0164, 0.0], "rx": 0.0493, "rz": 0.0137, "twist": -30}, {"position": [0.1325, 0.0054, 0.0], "rx": 0.095, "rz": 0.0263, "twist": -30}, {"position": [0.1996, -0.0401, 0.0], "rx": 0.0694, "rz": 0.0193, "twist": -30}, {"position": [0.2666, -0.1201, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-2", "attachment": {"parentId": "rachis-2", "parentSocket": "rachis-2:node", "localStart": [0.344, 0.0894, 0.0], "localEnd": [0.4352, -0.0307, 0.2505], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.344, 0.0894, 0.0], "rotation": [0, -1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-12", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_12_13.add(mesh_leaflet_12_13);
  meshes["leaflet-12"] = mesh_leaflet_12_13;
  colliders["leaflet-12"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-12"] ??= [];
  destructionGroups["leaflet-12"].push(node_leaflet_12_13);

  const endpoint_leaflet_13_14 = makeAttachmentEndpoint(null);
  const node_leaflet_13_14 = new THREE.Group();
  node_leaflet_13_14.name = "Leaf 3 leaflet 4__pivot";
  node_leaflet_13_14.scale.set(1, 1, 1);
  if (endpoint_leaflet_13_14) {
    node_leaflet_13_14.position.copy(endpoint_leaflet_13_14.start);
    node_leaflet_13_14.rotation.set(0.0, 1.2217, 0.0);
  } else {
    node_leaflet_13_14.position.set(0.344, 0.0894, 0.0);
    node_leaflet_13_14.rotation.set(0.0, 1.2217, 0.0);
  }
  node_leaflet_13_14.userData.sculptComponent = {"id": "leaflet-13", "name": "Leaf 3 leaflet 4", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0314, 0.009, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0655, 0.0164, 0.0], "rx": 0.0493, "rz": 0.0137, "twist": 30}, {"position": [0.1325, 0.0054, 0.0], "rx": 0.095, "rz": 0.0263, "twist": 30}, {"position": [0.1996, -0.0401, 0.0], "rx": 0.0694, "rz": 0.0193, "twist": 30}, {"position": [0.2666, -0.1201, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-2", "attachment": {"parentId": "rachis-2", "parentSocket": "rachis-2:node", "localStart": [0.344, 0.0894, 0.0], "localEnd": [0.4352, -0.0307, -0.2505], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.344, 0.0894, 0.0], "rotation": [0, 1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-13", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_13_14.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-13", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-2"] ?? root).add(node_leaflet_13_14);
  nodes["leaflet-13"] = node_leaflet_13_14;
  const mesh_leaflet_13_14Geometry = endpoint_leaflet_13_14
    ? new THREE.CylinderGeometry(endpoint_leaflet_13_14.endRadius, endpoint_leaflet_13_14.baseRadius, endpoint_leaflet_13_14.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0314, 0.009, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0655, 0.0164, 0.0], "rx": 0.0493, "rz": 0.0137, "twist": 30}, {"position": [0.1325, 0.0054, 0.0], "rx": 0.095, "rz": 0.0263, "twist": 30}, {"position": [0.1996, -0.0401, 0.0], "rx": 0.0694, "rz": 0.0193, "twist": 30}, {"position": [0.2666, -0.1201, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_13_14) {
    mesh_leaflet_13_14Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_13_14 = new THREE.Mesh(
    mesh_leaflet_13_14Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_13_14.name = "Leaf 3 leaflet 4";
  if (endpoint_leaflet_13_14) {
    mesh_leaflet_13_14.position.copy(endpoint_leaflet_13_14.midpoint);
    mesh_leaflet_13_14.quaternion.copy(endpoint_leaflet_13_14.quaternion);
  }
  mesh_leaflet_13_14.castShadow = options.castShadow ?? true;
  mesh_leaflet_13_14.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_13_14.userData.sculptComponent = {"id": "leaflet-13", "name": "Leaf 3 leaflet 4", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0314, 0.009, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0655, 0.0164, 0.0], "rx": 0.0493, "rz": 0.0137, "twist": 30}, {"position": [0.1325, 0.0054, 0.0], "rx": 0.095, "rz": 0.0263, "twist": 30}, {"position": [0.1996, -0.0401, 0.0], "rx": 0.0694, "rz": 0.0193, "twist": 30}, {"position": [0.2666, -0.1201, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-2", "attachment": {"parentId": "rachis-2", "parentSocket": "rachis-2:node", "localStart": [0.344, 0.0894, 0.0], "localEnd": [0.4352, -0.0307, -0.2505], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.344, 0.0894, 0.0], "rotation": [0, 1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-13", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_13_14.add(mesh_leaflet_13_14);
  meshes["leaflet-13"] = mesh_leaflet_13_14;
  colliders["leaflet-13"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-13"] ??= [];
  destructionGroups["leaflet-13"].push(node_leaflet_13_14);

  const endpoint_leaflet_14_15 = makeAttachmentEndpoint(null);
  const node_leaflet_14_15 = new THREE.Group();
  node_leaflet_14_15.name = "Leaf 3 leaflet 5__pivot";
  node_leaflet_14_15.scale.set(1, 1, 1);
  if (endpoint_leaflet_14_15) {
    node_leaflet_14_15.position.copy(endpoint_leaflet_14_15.start);
    node_leaflet_14_15.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leaflet_14_15.position.set(0.43, 0.043, 0.0);
    node_leaflet_14_15.rotation.set(0.0, 0.0, 0.0);
  }
  node_leaflet_14_15.userData.sculptComponent = {"id": "leaflet-14", "name": "Leaf 3 leaflet 5", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0364, 0.0104, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0761, 0.019, 0.0], "rx": 0.0572, "rz": 0.0158, "twist": 0}, {"position": [0.1539, 0.0062, 0.0], "rx": 0.1103, "rz": 0.0306, "twist": 0}, {"position": [0.2318, -0.0466, 0.0], "rx": 0.0806, "rz": 0.0223, "twist": 0}, {"position": [0.3096, -0.1394, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-2", "attachment": {"parentId": "rachis-2", "parentSocket": "rachis-2:node", "localStart": [0.43, 0.043, 0.0], "localEnd": [0.7396, -0.0964, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.43, 0.043, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-14", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_14_15.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-14", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-2"] ?? root).add(node_leaflet_14_15);
  nodes["leaflet-14"] = node_leaflet_14_15;
  const mesh_leaflet_14_15Geometry = endpoint_leaflet_14_15
    ? new THREE.CylinderGeometry(endpoint_leaflet_14_15.endRadius, endpoint_leaflet_14_15.baseRadius, endpoint_leaflet_14_15.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0364, 0.0104, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0761, 0.019, 0.0], "rx": 0.0572, "rz": 0.0158, "twist": 0}, {"position": [0.1539, 0.0062, 0.0], "rx": 0.1103, "rz": 0.0306, "twist": 0}, {"position": [0.2318, -0.0466, 0.0], "rx": 0.0806, "rz": 0.0223, "twist": 0}, {"position": [0.3096, -0.1394, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_14_15) {
    mesh_leaflet_14_15Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_14_15 = new THREE.Mesh(
    mesh_leaflet_14_15Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_14_15.name = "Leaf 3 leaflet 5";
  if (endpoint_leaflet_14_15) {
    mesh_leaflet_14_15.position.copy(endpoint_leaflet_14_15.midpoint);
    mesh_leaflet_14_15.quaternion.copy(endpoint_leaflet_14_15.quaternion);
  }
  mesh_leaflet_14_15.castShadow = options.castShadow ?? true;
  mesh_leaflet_14_15.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_14_15.userData.sculptComponent = {"id": "leaflet-14", "name": "Leaf 3 leaflet 5", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0364, 0.0104, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0761, 0.019, 0.0], "rx": 0.0572, "rz": 0.0158, "twist": 0}, {"position": [0.1539, 0.0062, 0.0], "rx": 0.1103, "rz": 0.0306, "twist": 0}, {"position": [0.2318, -0.0466, 0.0], "rx": 0.0806, "rz": 0.0223, "twist": 0}, {"position": [0.3096, -0.1394, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-2", "attachment": {"parentId": "rachis-2", "parentSocket": "rachis-2:node", "localStart": [0.43, 0.043, 0.0], "localEnd": [0.7396, -0.0964, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.43, 0.043, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-14", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_14_15.add(mesh_leaflet_14_15);
  meshes["leaflet-14"] = mesh_leaflet_14_15;
  colliders["leaflet-14"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-14"] ??= [];
  destructionGroups["leaflet-14"].push(node_leaflet_14_15);

  const endpoint_rachis_3_16 = makeAttachmentEndpoint(null);
  const node_rachis_3_16 = new THREE.Group();
  node_rachis_3_16.name = "Compound leaf 4 rachis__pivot";
  node_rachis_3_16.scale.set(1, 1, 1);
  if (endpoint_rachis_3_16) {
    node_rachis_3_16.position.copy(endpoint_rachis_3_16.start);
    node_rachis_3_16.rotation.set(0.0, 0.9163, 0.0);
  } else {
    node_rachis_3_16.position.set(0.0, 0.64, 0.0);
    node_rachis_3_16.rotation.set(0.0, 0.9163, 0.0);
  }
  node_rachis_3_16.userData.sculptComponent = {"id": "rachis-3", "name": "Compound leaf 4 rachis", "level": "meso", "role": "leaf", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Arching rachis of a pinnate compound leaf.", "geometryDescriptor": {"topologyIntent": "Arching rachis of a pinnate compound leaf. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.081, 0.0599, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.162, 0.094, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.243, 0.1021, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.324, 0.0842, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.405, 0.0405, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.64, 0.0], "localEnd": [0.2465, 0.6805, -0.3213], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.64, 0.0], "rotation": [0, 0.9163, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pinnate", "kind": "contour", "description": "terminal leaflet + 2 opposite pairs", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_rachis_3_16.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_rachis_3_16);
  nodes["rachis-3"] = node_rachis_3_16;
  const mesh_rachis_3_16Geometry = endpoint_rachis_3_16
    ? new THREE.CylinderGeometry(endpoint_rachis_3_16.endRadius, endpoint_rachis_3_16.baseRadius, endpoint_rachis_3_16.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.081, 0.0599, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.162, 0.094, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.243, 0.1021, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.324, 0.0842, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.405, 0.0405, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true});
  if (!endpoint_rachis_3_16) {
    mesh_rachis_3_16Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rachis_3_16 = new THREE.Mesh(
    mesh_rachis_3_16Geometry,
    materialMap["stem"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rachis_3_16.name = "Compound leaf 4 rachis";
  if (endpoint_rachis_3_16) {
    mesh_rachis_3_16.position.copy(endpoint_rachis_3_16.midpoint);
    mesh_rachis_3_16.quaternion.copy(endpoint_rachis_3_16.quaternion);
  }
  mesh_rachis_3_16.castShadow = options.castShadow ?? true;
  mesh_rachis_3_16.receiveShadow = options.receiveShadow ?? true;
  mesh_rachis_3_16.userData.sculptComponent = {"id": "rachis-3", "name": "Compound leaf 4 rachis", "level": "meso", "role": "leaf", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Arching rachis of a pinnate compound leaf.", "geometryDescriptor": {"topologyIntent": "Arching rachis of a pinnate compound leaf. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.081, 0.0599, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.162, 0.094, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.243, 0.1021, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.324, 0.0842, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.405, 0.0405, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.64, 0.0], "localEnd": [0.2465, 0.6805, -0.3213], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.64, 0.0], "rotation": [0, 0.9163, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pinnate", "kind": "contour", "description": "terminal leaflet + 2 opposite pairs", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_rachis_3_16.add(mesh_rachis_3_16);
  meshes["rachis-3"] = mesh_rachis_3_16;
  colliders["rachis-3"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["rachis-3"] ??= [];
  destructionGroups["rachis-3"].push(node_rachis_3_16);

  const endpoint_leaflet_17_17 = makeAttachmentEndpoint(null);
  const node_leaflet_17_17 = new THREE.Group();
  node_leaflet_17_17.name = "Leaf 4 leaflet 3__pivot";
  node_leaflet_17_17.scale.set(1, 1, 1);
  if (endpoint_leaflet_17_17) {
    node_leaflet_17_17.position.copy(endpoint_leaflet_17_17.start);
    node_leaflet_17_17.rotation.set(0.0, -1.2217, 0.0);
  } else {
    node_leaflet_17_17.position.set(0.324, 0.0842, 0.0);
    node_leaflet_17_17.rotation.set(0.0, -1.2217, 0.0);
  }
  node_leaflet_17_17.userData.sculptComponent = {"id": "leaflet-17", "name": "Leaf 4 leaflet 3", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0295, 0.0084, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0617, 0.0154, 0.0], "rx": 0.0463, "rz": 0.0128, "twist": -30}, {"position": [0.1248, 0.0051, 0.0], "rx": 0.0895, "rz": 0.0248, "twist": -30}, {"position": [0.188, -0.0378, 0.0], "rx": 0.0653, "rz": 0.0182, "twist": -30}, {"position": [0.2511, -0.1131, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-3", "attachment": {"parentId": "rachis-3", "parentSocket": "rachis-3:node", "localStart": [0.324, 0.0842, 0.0], "localEnd": [0.4099, -0.0289, 0.236], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.324, 0.0842, 0.0], "rotation": [0, -1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-17", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_17_17.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-17", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-3"] ?? root).add(node_leaflet_17_17);
  nodes["leaflet-17"] = node_leaflet_17_17;
  const mesh_leaflet_17_17Geometry = endpoint_leaflet_17_17
    ? new THREE.CylinderGeometry(endpoint_leaflet_17_17.endRadius, endpoint_leaflet_17_17.baseRadius, endpoint_leaflet_17_17.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0295, 0.0084, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0617, 0.0154, 0.0], "rx": 0.0463, "rz": 0.0128, "twist": -30}, {"position": [0.1248, 0.0051, 0.0], "rx": 0.0895, "rz": 0.0248, "twist": -30}, {"position": [0.188, -0.0378, 0.0], "rx": 0.0653, "rz": 0.0182, "twist": -30}, {"position": [0.2511, -0.1131, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_17_17) {
    mesh_leaflet_17_17Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_17_17 = new THREE.Mesh(
    mesh_leaflet_17_17Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_17_17.name = "Leaf 4 leaflet 3";
  if (endpoint_leaflet_17_17) {
    mesh_leaflet_17_17.position.copy(endpoint_leaflet_17_17.midpoint);
    mesh_leaflet_17_17.quaternion.copy(endpoint_leaflet_17_17.quaternion);
  }
  mesh_leaflet_17_17.castShadow = options.castShadow ?? true;
  mesh_leaflet_17_17.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_17_17.userData.sculptComponent = {"id": "leaflet-17", "name": "Leaf 4 leaflet 3", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0295, 0.0084, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0617, 0.0154, 0.0], "rx": 0.0463, "rz": 0.0128, "twist": -30}, {"position": [0.1248, 0.0051, 0.0], "rx": 0.0895, "rz": 0.0248, "twist": -30}, {"position": [0.188, -0.0378, 0.0], "rx": 0.0653, "rz": 0.0182, "twist": -30}, {"position": [0.2511, -0.1131, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-3", "attachment": {"parentId": "rachis-3", "parentSocket": "rachis-3:node", "localStart": [0.324, 0.0842, 0.0], "localEnd": [0.4099, -0.0289, 0.236], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.324, 0.0842, 0.0], "rotation": [0, -1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-17", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_17_17.add(mesh_leaflet_17_17);
  meshes["leaflet-17"] = mesh_leaflet_17_17;
  colliders["leaflet-17"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-17"] ??= [];
  destructionGroups["leaflet-17"].push(node_leaflet_17_17);

  const endpoint_leaflet_18_18 = makeAttachmentEndpoint(null);
  const node_leaflet_18_18 = new THREE.Group();
  node_leaflet_18_18.name = "Leaf 4 leaflet 4__pivot";
  node_leaflet_18_18.scale.set(1, 1, 1);
  if (endpoint_leaflet_18_18) {
    node_leaflet_18_18.position.copy(endpoint_leaflet_18_18.start);
    node_leaflet_18_18.rotation.set(0.0, 1.2217, 0.0);
  } else {
    node_leaflet_18_18.position.set(0.324, 0.0842, 0.0);
    node_leaflet_18_18.rotation.set(0.0, 1.2217, 0.0);
  }
  node_leaflet_18_18.userData.sculptComponent = {"id": "leaflet-18", "name": "Leaf 4 leaflet 4", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0295, 0.0084, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0617, 0.0154, 0.0], "rx": 0.0463, "rz": 0.0128, "twist": 30}, {"position": [0.1248, 0.0051, 0.0], "rx": 0.0895, "rz": 0.0248, "twist": 30}, {"position": [0.188, -0.0378, 0.0], "rx": 0.0653, "rz": 0.0182, "twist": 30}, {"position": [0.2511, -0.1131, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-3", "attachment": {"parentId": "rachis-3", "parentSocket": "rachis-3:node", "localStart": [0.324, 0.0842, 0.0], "localEnd": [0.4099, -0.0289, -0.236], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.324, 0.0842, 0.0], "rotation": [0, 1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-18", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_18_18.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-18", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-3"] ?? root).add(node_leaflet_18_18);
  nodes["leaflet-18"] = node_leaflet_18_18;
  const mesh_leaflet_18_18Geometry = endpoint_leaflet_18_18
    ? new THREE.CylinderGeometry(endpoint_leaflet_18_18.endRadius, endpoint_leaflet_18_18.baseRadius, endpoint_leaflet_18_18.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0295, 0.0084, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0617, 0.0154, 0.0], "rx": 0.0463, "rz": 0.0128, "twist": 30}, {"position": [0.1248, 0.0051, 0.0], "rx": 0.0895, "rz": 0.0248, "twist": 30}, {"position": [0.188, -0.0378, 0.0], "rx": 0.0653, "rz": 0.0182, "twist": 30}, {"position": [0.2511, -0.1131, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_18_18) {
    mesh_leaflet_18_18Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_18_18 = new THREE.Mesh(
    mesh_leaflet_18_18Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_18_18.name = "Leaf 4 leaflet 4";
  if (endpoint_leaflet_18_18) {
    mesh_leaflet_18_18.position.copy(endpoint_leaflet_18_18.midpoint);
    mesh_leaflet_18_18.quaternion.copy(endpoint_leaflet_18_18.quaternion);
  }
  mesh_leaflet_18_18.castShadow = options.castShadow ?? true;
  mesh_leaflet_18_18.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_18_18.userData.sculptComponent = {"id": "leaflet-18", "name": "Leaf 4 leaflet 4", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0295, 0.0084, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0617, 0.0154, 0.0], "rx": 0.0463, "rz": 0.0128, "twist": 30}, {"position": [0.1248, 0.0051, 0.0], "rx": 0.0895, "rz": 0.0248, "twist": 30}, {"position": [0.188, -0.0378, 0.0], "rx": 0.0653, "rz": 0.0182, "twist": 30}, {"position": [0.2511, -0.1131, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-3", "attachment": {"parentId": "rachis-3", "parentSocket": "rachis-3:node", "localStart": [0.324, 0.0842, 0.0], "localEnd": [0.4099, -0.0289, -0.236], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.324, 0.0842, 0.0], "rotation": [0, 1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-18", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_18_18.add(mesh_leaflet_18_18);
  meshes["leaflet-18"] = mesh_leaflet_18_18;
  colliders["leaflet-18"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-18"] ??= [];
  destructionGroups["leaflet-18"].push(node_leaflet_18_18);

  const endpoint_leaflet_19_19 = makeAttachmentEndpoint(null);
  const node_leaflet_19_19 = new THREE.Group();
  node_leaflet_19_19.name = "Leaf 4 leaflet 5__pivot";
  node_leaflet_19_19.scale.set(1, 1, 1);
  if (endpoint_leaflet_19_19) {
    node_leaflet_19_19.position.copy(endpoint_leaflet_19_19.start);
    node_leaflet_19_19.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leaflet_19_19.position.set(0.405, 0.0405, 0.0);
    node_leaflet_19_19.rotation.set(0.0, 0.0, 0.0);
  }
  node_leaflet_19_19.userData.sculptComponent = {"id": "leaflet-19", "name": "Leaf 4 leaflet 5", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0343, 0.0098, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0717, 0.0179, 0.0], "rx": 0.0539, "rz": 0.0149, "twist": 0}, {"position": [0.145, 0.0059, 0.0], "rx": 0.104, "rz": 0.0288, "twist": 0}, {"position": [0.2183, -0.0439, 0.0], "rx": 0.0759, "rz": 0.0211, "twist": 0}, {"position": [0.2916, -0.1313, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-3", "attachment": {"parentId": "rachis-3", "parentSocket": "rachis-3:node", "localStart": [0.405, 0.0405, 0.0], "localEnd": [0.6966, -0.0908, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.405, 0.0405, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-19", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_19_19.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-19", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-3"] ?? root).add(node_leaflet_19_19);
  nodes["leaflet-19"] = node_leaflet_19_19;
  const mesh_leaflet_19_19Geometry = endpoint_leaflet_19_19
    ? new THREE.CylinderGeometry(endpoint_leaflet_19_19.endRadius, endpoint_leaflet_19_19.baseRadius, endpoint_leaflet_19_19.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0343, 0.0098, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0717, 0.0179, 0.0], "rx": 0.0539, "rz": 0.0149, "twist": 0}, {"position": [0.145, 0.0059, 0.0], "rx": 0.104, "rz": 0.0288, "twist": 0}, {"position": [0.2183, -0.0439, 0.0], "rx": 0.0759, "rz": 0.0211, "twist": 0}, {"position": [0.2916, -0.1313, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_19_19) {
    mesh_leaflet_19_19Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_19_19 = new THREE.Mesh(
    mesh_leaflet_19_19Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_19_19.name = "Leaf 4 leaflet 5";
  if (endpoint_leaflet_19_19) {
    mesh_leaflet_19_19.position.copy(endpoint_leaflet_19_19.midpoint);
    mesh_leaflet_19_19.quaternion.copy(endpoint_leaflet_19_19.quaternion);
  }
  mesh_leaflet_19_19.castShadow = options.castShadow ?? true;
  mesh_leaflet_19_19.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_19_19.userData.sculptComponent = {"id": "leaflet-19", "name": "Leaf 4 leaflet 5", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0343, 0.0098, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0717, 0.0179, 0.0], "rx": 0.0539, "rz": 0.0149, "twist": 0}, {"position": [0.145, 0.0059, 0.0], "rx": 0.104, "rz": 0.0288, "twist": 0}, {"position": [0.2183, -0.0439, 0.0], "rx": 0.0759, "rz": 0.0211, "twist": 0}, {"position": [0.2916, -0.1313, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-3", "attachment": {"parentId": "rachis-3", "parentSocket": "rachis-3:node", "localStart": [0.405, 0.0405, 0.0], "localEnd": [0.6966, -0.0908, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.405, 0.0405, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-19", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_19_19.add(mesh_leaflet_19_19);
  meshes["leaflet-19"] = mesh_leaflet_19_19;
  colliders["leaflet-19"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-19"] ??= [];
  destructionGroups["leaflet-19"].push(node_leaflet_19_19);

  const endpoint_rachis_4_20 = makeAttachmentEndpoint(null);
  const node_rachis_4_20 = new THREE.Group();
  node_rachis_4_20.name = "Compound leaf 5 rachis__pivot";
  node_rachis_4_20.scale.set(1, 1, 1);
  if (endpoint_rachis_4_20) {
    node_rachis_4_20.position.copy(endpoint_rachis_4_20.start);
    node_rachis_4_20.rotation.set(0.0, 3.3161, 0.0);
  } else {
    node_rachis_4_20.position.set(0.0, 0.72, 0.0);
    node_rachis_4_20.rotation.set(0.0, 3.3161, 0.0);
  }
  node_rachis_4_20.userData.sculptComponent = {"id": "rachis-4", "name": "Compound leaf 5 rachis", "level": "meso", "role": "leaf", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Arching rachis of a pinnate compound leaf.", "geometryDescriptor": {"topologyIntent": "Arching rachis of a pinnate compound leaf. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.076, 0.0562, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.152, 0.0882, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.228, 0.0958, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.304, 0.079, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.38, 0.038, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.72, 0.0], "localEnd": [-0.3742, 0.758, 0.066], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.72, 0.0], "rotation": [0, 3.3161, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pinnate", "kind": "contour", "description": "terminal leaflet + 2 opposite pairs", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_rachis_4_20.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_rachis_4_20);
  nodes["rachis-4"] = node_rachis_4_20;
  const mesh_rachis_4_20Geometry = endpoint_rachis_4_20
    ? new THREE.CylinderGeometry(endpoint_rachis_4_20.endRadius, endpoint_rachis_4_20.baseRadius, endpoint_rachis_4_20.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.076, 0.0562, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.152, 0.0882, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.228, 0.0958, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.304, 0.079, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.38, 0.038, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true});
  if (!endpoint_rachis_4_20) {
    mesh_rachis_4_20Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rachis_4_20 = new THREE.Mesh(
    mesh_rachis_4_20Geometry,
    materialMap["stem"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rachis_4_20.name = "Compound leaf 5 rachis";
  if (endpoint_rachis_4_20) {
    mesh_rachis_4_20.position.copy(endpoint_rachis_4_20.midpoint);
    mesh_rachis_4_20.quaternion.copy(endpoint_rachis_4_20.quaternion);
  }
  mesh_rachis_4_20.castShadow = options.castShadow ?? true;
  mesh_rachis_4_20.receiveShadow = options.receiveShadow ?? true;
  mesh_rachis_4_20.userData.sculptComponent = {"id": "rachis-4", "name": "Compound leaf 5 rachis", "level": "meso", "role": "leaf", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Arching rachis of a pinnate compound leaf.", "geometryDescriptor": {"topologyIntent": "Arching rachis of a pinnate compound leaf. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.076, 0.0562, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.152, 0.0882, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.228, 0.0958, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.304, 0.079, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.38, 0.038, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.72, 0.0], "localEnd": [-0.3742, 0.758, 0.066], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.72, 0.0], "rotation": [0, 3.3161, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pinnate", "kind": "contour", "description": "terminal leaflet + 2 opposite pairs", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_rachis_4_20.add(mesh_rachis_4_20);
  meshes["rachis-4"] = mesh_rachis_4_20;
  colliders["rachis-4"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["rachis-4"] ??= [];
  destructionGroups["rachis-4"].push(node_rachis_4_20);

  const endpoint_leaflet_22_21 = makeAttachmentEndpoint(null);
  const node_leaflet_22_21 = new THREE.Group();
  node_leaflet_22_21.name = "Leaf 5 leaflet 3__pivot";
  node_leaflet_22_21.scale.set(1, 1, 1);
  if (endpoint_leaflet_22_21) {
    node_leaflet_22_21.position.copy(endpoint_leaflet_22_21.start);
    node_leaflet_22_21.rotation.set(0.0, -1.2217, 0.0);
  } else {
    node_leaflet_22_21.position.set(0.304, 0.079, 0.0);
    node_leaflet_22_21.rotation.set(0.0, -1.2217, 0.0);
  }
  node_leaflet_22_21.userData.sculptComponent = {"id": "leaflet-22", "name": "Leaf 5 leaflet 3", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0277, 0.0079, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0579, 0.0145, 0.0], "rx": 0.0435, "rz": 0.0121, "twist": -30}, {"position": [0.1171, 0.0047, 0.0], "rx": 0.084, "rz": 0.0232, "twist": -30}, {"position": [0.1764, -0.0355, 0.0], "rx": 0.0613, "rz": 0.0169, "twist": -30}, {"position": [0.2356, -0.1061, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-4", "attachment": {"parentId": "rachis-4", "parentSocket": "rachis-4:node", "localStart": [0.304, 0.079, 0.0], "localEnd": [0.3846, -0.0271, 0.2214], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.304, 0.079, 0.0], "rotation": [0, -1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-22", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_22_21.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-22", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-4"] ?? root).add(node_leaflet_22_21);
  nodes["leaflet-22"] = node_leaflet_22_21;
  const mesh_leaflet_22_21Geometry = endpoint_leaflet_22_21
    ? new THREE.CylinderGeometry(endpoint_leaflet_22_21.endRadius, endpoint_leaflet_22_21.baseRadius, endpoint_leaflet_22_21.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0277, 0.0079, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0579, 0.0145, 0.0], "rx": 0.0435, "rz": 0.0121, "twist": -30}, {"position": [0.1171, 0.0047, 0.0], "rx": 0.084, "rz": 0.0232, "twist": -30}, {"position": [0.1764, -0.0355, 0.0], "rx": 0.0613, "rz": 0.0169, "twist": -30}, {"position": [0.2356, -0.1061, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_22_21) {
    mesh_leaflet_22_21Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_22_21 = new THREE.Mesh(
    mesh_leaflet_22_21Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_22_21.name = "Leaf 5 leaflet 3";
  if (endpoint_leaflet_22_21) {
    mesh_leaflet_22_21.position.copy(endpoint_leaflet_22_21.midpoint);
    mesh_leaflet_22_21.quaternion.copy(endpoint_leaflet_22_21.quaternion);
  }
  mesh_leaflet_22_21.castShadow = options.castShadow ?? true;
  mesh_leaflet_22_21.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_22_21.userData.sculptComponent = {"id": "leaflet-22", "name": "Leaf 5 leaflet 3", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0277, 0.0079, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0579, 0.0145, 0.0], "rx": 0.0435, "rz": 0.0121, "twist": -30}, {"position": [0.1171, 0.0047, 0.0], "rx": 0.084, "rz": 0.0232, "twist": -30}, {"position": [0.1764, -0.0355, 0.0], "rx": 0.0613, "rz": 0.0169, "twist": -30}, {"position": [0.2356, -0.1061, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-4", "attachment": {"parentId": "rachis-4", "parentSocket": "rachis-4:node", "localStart": [0.304, 0.079, 0.0], "localEnd": [0.3846, -0.0271, 0.2214], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.304, 0.079, 0.0], "rotation": [0, -1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-22", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_22_21.add(mesh_leaflet_22_21);
  meshes["leaflet-22"] = mesh_leaflet_22_21;
  colliders["leaflet-22"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-22"] ??= [];
  destructionGroups["leaflet-22"].push(node_leaflet_22_21);

  const endpoint_leaflet_23_22 = makeAttachmentEndpoint(null);
  const node_leaflet_23_22 = new THREE.Group();
  node_leaflet_23_22.name = "Leaf 5 leaflet 4__pivot";
  node_leaflet_23_22.scale.set(1, 1, 1);
  if (endpoint_leaflet_23_22) {
    node_leaflet_23_22.position.copy(endpoint_leaflet_23_22.start);
    node_leaflet_23_22.rotation.set(0.0, 1.2217, 0.0);
  } else {
    node_leaflet_23_22.position.set(0.304, 0.079, 0.0);
    node_leaflet_23_22.rotation.set(0.0, 1.2217, 0.0);
  }
  node_leaflet_23_22.userData.sculptComponent = {"id": "leaflet-23", "name": "Leaf 5 leaflet 4", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0277, 0.0079, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0579, 0.0145, 0.0], "rx": 0.0435, "rz": 0.0121, "twist": 30}, {"position": [0.1171, 0.0047, 0.0], "rx": 0.084, "rz": 0.0232, "twist": 30}, {"position": [0.1764, -0.0355, 0.0], "rx": 0.0613, "rz": 0.0169, "twist": 30}, {"position": [0.2356, -0.1061, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-4", "attachment": {"parentId": "rachis-4", "parentSocket": "rachis-4:node", "localStart": [0.304, 0.079, 0.0], "localEnd": [0.3846, -0.0271, -0.2214], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.304, 0.079, 0.0], "rotation": [0, 1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-23", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_23_22.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-23", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-4"] ?? root).add(node_leaflet_23_22);
  nodes["leaflet-23"] = node_leaflet_23_22;
  const mesh_leaflet_23_22Geometry = endpoint_leaflet_23_22
    ? new THREE.CylinderGeometry(endpoint_leaflet_23_22.endRadius, endpoint_leaflet_23_22.baseRadius, endpoint_leaflet_23_22.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0277, 0.0079, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0579, 0.0145, 0.0], "rx": 0.0435, "rz": 0.0121, "twist": 30}, {"position": [0.1171, 0.0047, 0.0], "rx": 0.084, "rz": 0.0232, "twist": 30}, {"position": [0.1764, -0.0355, 0.0], "rx": 0.0613, "rz": 0.0169, "twist": 30}, {"position": [0.2356, -0.1061, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_23_22) {
    mesh_leaflet_23_22Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_23_22 = new THREE.Mesh(
    mesh_leaflet_23_22Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_23_22.name = "Leaf 5 leaflet 4";
  if (endpoint_leaflet_23_22) {
    mesh_leaflet_23_22.position.copy(endpoint_leaflet_23_22.midpoint);
    mesh_leaflet_23_22.quaternion.copy(endpoint_leaflet_23_22.quaternion);
  }
  mesh_leaflet_23_22.castShadow = options.castShadow ?? true;
  mesh_leaflet_23_22.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_23_22.userData.sculptComponent = {"id": "leaflet-23", "name": "Leaf 5 leaflet 4", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0277, 0.0079, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0579, 0.0145, 0.0], "rx": 0.0435, "rz": 0.0121, "twist": 30}, {"position": [0.1171, 0.0047, 0.0], "rx": 0.084, "rz": 0.0232, "twist": 30}, {"position": [0.1764, -0.0355, 0.0], "rx": 0.0613, "rz": 0.0169, "twist": 30}, {"position": [0.2356, -0.1061, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-4", "attachment": {"parentId": "rachis-4", "parentSocket": "rachis-4:node", "localStart": [0.304, 0.079, 0.0], "localEnd": [0.3846, -0.0271, -0.2214], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.304, 0.079, 0.0], "rotation": [0, 1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-23", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_23_22.add(mesh_leaflet_23_22);
  meshes["leaflet-23"] = mesh_leaflet_23_22;
  colliders["leaflet-23"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-23"] ??= [];
  destructionGroups["leaflet-23"].push(node_leaflet_23_22);

  const endpoint_leaflet_24_23 = makeAttachmentEndpoint(null);
  const node_leaflet_24_23 = new THREE.Group();
  node_leaflet_24_23.name = "Leaf 5 leaflet 5__pivot";
  node_leaflet_24_23.scale.set(1, 1, 1);
  if (endpoint_leaflet_24_23) {
    node_leaflet_24_23.position.copy(endpoint_leaflet_24_23.start);
    node_leaflet_24_23.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leaflet_24_23.position.set(0.38, 0.038, 0.0);
    node_leaflet_24_23.rotation.set(0.0, 0.0, 0.0);
  }
  node_leaflet_24_23.userData.sculptComponent = {"id": "leaflet-24", "name": "Leaf 5 leaflet 5", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0322, 0.0092, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0672, 0.0168, 0.0], "rx": 0.0505, "rz": 0.014, "twist": 0}, {"position": [0.136, 0.0055, 0.0], "rx": 0.0975, "rz": 0.027, "twist": 0}, {"position": [0.2048, -0.0412, 0.0], "rx": 0.0711, "rz": 0.0198, "twist": 0}, {"position": [0.2736, -0.1232, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-4", "attachment": {"parentId": "rachis-4", "parentSocket": "rachis-4:node", "localStart": [0.38, 0.038, 0.0], "localEnd": [0.6536, -0.0852, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.38, 0.038, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-24", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_24_23.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-24", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-4"] ?? root).add(node_leaflet_24_23);
  nodes["leaflet-24"] = node_leaflet_24_23;
  const mesh_leaflet_24_23Geometry = endpoint_leaflet_24_23
    ? new THREE.CylinderGeometry(endpoint_leaflet_24_23.endRadius, endpoint_leaflet_24_23.baseRadius, endpoint_leaflet_24_23.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0322, 0.0092, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0672, 0.0168, 0.0], "rx": 0.0505, "rz": 0.014, "twist": 0}, {"position": [0.136, 0.0055, 0.0], "rx": 0.0975, "rz": 0.027, "twist": 0}, {"position": [0.2048, -0.0412, 0.0], "rx": 0.0711, "rz": 0.0198, "twist": 0}, {"position": [0.2736, -0.1232, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_24_23) {
    mesh_leaflet_24_23Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_24_23 = new THREE.Mesh(
    mesh_leaflet_24_23Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_24_23.name = "Leaf 5 leaflet 5";
  if (endpoint_leaflet_24_23) {
    mesh_leaflet_24_23.position.copy(endpoint_leaflet_24_23.midpoint);
    mesh_leaflet_24_23.quaternion.copy(endpoint_leaflet_24_23.quaternion);
  }
  mesh_leaflet_24_23.castShadow = options.castShadow ?? true;
  mesh_leaflet_24_23.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_24_23.userData.sculptComponent = {"id": "leaflet-24", "name": "Leaf 5 leaflet 5", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0322, 0.0092, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0672, 0.0168, 0.0], "rx": 0.0505, "rz": 0.014, "twist": 0}, {"position": [0.136, 0.0055, 0.0], "rx": 0.0975, "rz": 0.027, "twist": 0}, {"position": [0.2048, -0.0412, 0.0], "rx": 0.0711, "rz": 0.0198, "twist": 0}, {"position": [0.2736, -0.1232, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-4", "attachment": {"parentId": "rachis-4", "parentSocket": "rachis-4:node", "localStart": [0.38, 0.038, 0.0], "localEnd": [0.6536, -0.0852, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.38, 0.038, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-24", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_24_23.add(mesh_leaflet_24_23);
  meshes["leaflet-24"] = mesh_leaflet_24_23;
  colliders["leaflet-24"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-24"] ??= [];
  destructionGroups["leaflet-24"].push(node_leaflet_24_23);

  const endpoint_rachis_5_24 = makeAttachmentEndpoint(null);
  const node_rachis_5_24 = new THREE.Group();
  node_rachis_5_24.name = "Compound leaf 6 rachis__pivot";
  node_rachis_5_24.scale.set(1, 1, 1);
  if (endpoint_rachis_5_24) {
    node_rachis_5_24.position.copy(endpoint_rachis_5_24.start);
    node_rachis_5_24.rotation.set(0.0, 5.716, 0.0);
  } else {
    node_rachis_5_24.position.set(0.0, 0.8, 0.0);
    node_rachis_5_24.rotation.set(0.0, 5.716, 0.0);
  }
  node_rachis_5_24.userData.sculptComponent = {"id": "rachis-5", "name": "Compound leaf 6 rachis", "level": "meso", "role": "leaf", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Arching rachis of a pinnate compound leaf.", "geometryDescriptor": {"topologyIntent": "Arching rachis of a pinnate compound leaf. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.071, 0.0525, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.142, 0.0824, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.213, 0.0895, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.284, 0.0738, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.355, 0.0355, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.8, 0.0], "localEnd": [0.2994, 0.8355, 0.1907], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.8, 0.0], "rotation": [0, 5.716, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pinnate", "kind": "contour", "description": "terminal leaflet + 2 opposite pairs", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_rachis_5_24.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_rachis_5_24);
  nodes["rachis-5"] = node_rachis_5_24;
  const mesh_rachis_5_24Geometry = endpoint_rachis_5_24
    ? new THREE.CylinderGeometry(endpoint_rachis_5_24.endRadius, endpoint_rachis_5_24.baseRadius, endpoint_rachis_5_24.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.071, 0.0525, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.142, 0.0824, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.213, 0.0895, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.284, 0.0738, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.355, 0.0355, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true});
  if (!endpoint_rachis_5_24) {
    mesh_rachis_5_24Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rachis_5_24 = new THREE.Mesh(
    mesh_rachis_5_24Geometry,
    materialMap["stem"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rachis_5_24.name = "Compound leaf 6 rachis";
  if (endpoint_rachis_5_24) {
    mesh_rachis_5_24.position.copy(endpoint_rachis_5_24.midpoint);
    mesh_rachis_5_24.quaternion.copy(endpoint_rachis_5_24.quaternion);
  }
  mesh_rachis_5_24.castShadow = options.castShadow ?? true;
  mesh_rachis_5_24.receiveShadow = options.receiveShadow ?? true;
  mesh_rachis_5_24.userData.sculptComponent = {"id": "rachis-5", "name": "Compound leaf 6 rachis", "level": "meso", "role": "leaf", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Arching rachis of a pinnate compound leaf.", "geometryDescriptor": {"topologyIntent": "Arching rachis of a pinnate compound leaf. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.071, 0.0525, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.142, 0.0824, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.213, 0.0895, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.284, 0.0738, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.355, 0.0355, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.8, 0.0], "localEnd": [0.2994, 0.8355, 0.1907], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.8, 0.0], "rotation": [0, 5.716, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pinnate", "kind": "contour", "description": "terminal leaflet + 2 opposite pairs", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_rachis_5_24.add(mesh_rachis_5_24);
  meshes["rachis-5"] = mesh_rachis_5_24;
  colliders["rachis-5"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["rachis-5"] ??= [];
  destructionGroups["rachis-5"].push(node_rachis_5_24);

  const endpoint_leaflet_27_25 = makeAttachmentEndpoint(null);
  const node_leaflet_27_25 = new THREE.Group();
  node_leaflet_27_25.name = "Leaf 6 leaflet 3__pivot";
  node_leaflet_27_25.scale.set(1, 1, 1);
  if (endpoint_leaflet_27_25) {
    node_leaflet_27_25.position.copy(endpoint_leaflet_27_25.start);
    node_leaflet_27_25.rotation.set(0.0, -1.2217, 0.0);
  } else {
    node_leaflet_27_25.position.set(0.284, 0.0738, 0.0);
    node_leaflet_27_25.rotation.set(0.0, -1.2217, 0.0);
  }
  node_leaflet_27_25.userData.sculptComponent = {"id": "leaflet-27", "name": "Leaf 6 leaflet 3", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0259, 0.0074, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0541, 0.0135, 0.0], "rx": 0.0406, "rz": 0.012, "twist": -30}, {"position": [0.1094, 0.0044, 0.0], "rx": 0.0784, "rz": 0.0218, "twist": -30}, {"position": [0.1648, -0.0331, 0.0], "rx": 0.0572, "rz": 0.0158, "twist": -30}, {"position": [0.2201, -0.0991, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-5", "attachment": {"parentId": "rachis-5", "parentSocket": "rachis-5:node", "localStart": [0.284, 0.0738, 0.0], "localEnd": [0.3593, -0.0253, 0.2068], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.284, 0.0738, 0.0], "rotation": [0, -1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-27", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_27_25.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-27", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-5"] ?? root).add(node_leaflet_27_25);
  nodes["leaflet-27"] = node_leaflet_27_25;
  const mesh_leaflet_27_25Geometry = endpoint_leaflet_27_25
    ? new THREE.CylinderGeometry(endpoint_leaflet_27_25.endRadius, endpoint_leaflet_27_25.baseRadius, endpoint_leaflet_27_25.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0259, 0.0074, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0541, 0.0135, 0.0], "rx": 0.0406, "rz": 0.012, "twist": -30}, {"position": [0.1094, 0.0044, 0.0], "rx": 0.0784, "rz": 0.0218, "twist": -30}, {"position": [0.1648, -0.0331, 0.0], "rx": 0.0572, "rz": 0.0158, "twist": -30}, {"position": [0.2201, -0.0991, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_27_25) {
    mesh_leaflet_27_25Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_27_25 = new THREE.Mesh(
    mesh_leaflet_27_25Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_27_25.name = "Leaf 6 leaflet 3";
  if (endpoint_leaflet_27_25) {
    mesh_leaflet_27_25.position.copy(endpoint_leaflet_27_25.midpoint);
    mesh_leaflet_27_25.quaternion.copy(endpoint_leaflet_27_25.quaternion);
  }
  mesh_leaflet_27_25.castShadow = options.castShadow ?? true;
  mesh_leaflet_27_25.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_27_25.userData.sculptComponent = {"id": "leaflet-27", "name": "Leaf 6 leaflet 3", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0259, 0.0074, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0541, 0.0135, 0.0], "rx": 0.0406, "rz": 0.012, "twist": -30}, {"position": [0.1094, 0.0044, 0.0], "rx": 0.0784, "rz": 0.0218, "twist": -30}, {"position": [0.1648, -0.0331, 0.0], "rx": 0.0572, "rz": 0.0158, "twist": -30}, {"position": [0.2201, -0.0991, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-5", "attachment": {"parentId": "rachis-5", "parentSocket": "rachis-5:node", "localStart": [0.284, 0.0738, 0.0], "localEnd": [0.3593, -0.0253, 0.2068], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.284, 0.0738, 0.0], "rotation": [0, -1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-27", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_27_25.add(mesh_leaflet_27_25);
  meshes["leaflet-27"] = mesh_leaflet_27_25;
  colliders["leaflet-27"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-27"] ??= [];
  destructionGroups["leaflet-27"].push(node_leaflet_27_25);

  const endpoint_leaflet_28_26 = makeAttachmentEndpoint(null);
  const node_leaflet_28_26 = new THREE.Group();
  node_leaflet_28_26.name = "Leaf 6 leaflet 4__pivot";
  node_leaflet_28_26.scale.set(1, 1, 1);
  if (endpoint_leaflet_28_26) {
    node_leaflet_28_26.position.copy(endpoint_leaflet_28_26.start);
    node_leaflet_28_26.rotation.set(0.0, 1.2217, 0.0);
  } else {
    node_leaflet_28_26.position.set(0.284, 0.0738, 0.0);
    node_leaflet_28_26.rotation.set(0.0, 1.2217, 0.0);
  }
  node_leaflet_28_26.userData.sculptComponent = {"id": "leaflet-28", "name": "Leaf 6 leaflet 4", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0259, 0.0074, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0541, 0.0135, 0.0], "rx": 0.0406, "rz": 0.012, "twist": 30}, {"position": [0.1094, 0.0044, 0.0], "rx": 0.0784, "rz": 0.0218, "twist": 30}, {"position": [0.1648, -0.0331, 0.0], "rx": 0.0572, "rz": 0.0158, "twist": 30}, {"position": [0.2201, -0.0991, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-5", "attachment": {"parentId": "rachis-5", "parentSocket": "rachis-5:node", "localStart": [0.284, 0.0738, 0.0], "localEnd": [0.3593, -0.0253, -0.2068], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.284, 0.0738, 0.0], "rotation": [0, 1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-28", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_28_26.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-28", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-5"] ?? root).add(node_leaflet_28_26);
  nodes["leaflet-28"] = node_leaflet_28_26;
  const mesh_leaflet_28_26Geometry = endpoint_leaflet_28_26
    ? new THREE.CylinderGeometry(endpoint_leaflet_28_26.endRadius, endpoint_leaflet_28_26.baseRadius, endpoint_leaflet_28_26.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0259, 0.0074, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0541, 0.0135, 0.0], "rx": 0.0406, "rz": 0.012, "twist": 30}, {"position": [0.1094, 0.0044, 0.0], "rx": 0.0784, "rz": 0.0218, "twist": 30}, {"position": [0.1648, -0.0331, 0.0], "rx": 0.0572, "rz": 0.0158, "twist": 30}, {"position": [0.2201, -0.0991, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_28_26) {
    mesh_leaflet_28_26Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_28_26 = new THREE.Mesh(
    mesh_leaflet_28_26Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_28_26.name = "Leaf 6 leaflet 4";
  if (endpoint_leaflet_28_26) {
    mesh_leaflet_28_26.position.copy(endpoint_leaflet_28_26.midpoint);
    mesh_leaflet_28_26.quaternion.copy(endpoint_leaflet_28_26.quaternion);
  }
  mesh_leaflet_28_26.castShadow = options.castShadow ?? true;
  mesh_leaflet_28_26.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_28_26.userData.sculptComponent = {"id": "leaflet-28", "name": "Leaf 6 leaflet 4", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0259, 0.0074, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0541, 0.0135, 0.0], "rx": 0.0406, "rz": 0.012, "twist": 30}, {"position": [0.1094, 0.0044, 0.0], "rx": 0.0784, "rz": 0.0218, "twist": 30}, {"position": [0.1648, -0.0331, 0.0], "rx": 0.0572, "rz": 0.0158, "twist": 30}, {"position": [0.2201, -0.0991, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-5", "attachment": {"parentId": "rachis-5", "parentSocket": "rachis-5:node", "localStart": [0.284, 0.0738, 0.0], "localEnd": [0.3593, -0.0253, -0.2068], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.284, 0.0738, 0.0], "rotation": [0, 1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-28", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_28_26.add(mesh_leaflet_28_26);
  meshes["leaflet-28"] = mesh_leaflet_28_26;
  colliders["leaflet-28"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-28"] ??= [];
  destructionGroups["leaflet-28"].push(node_leaflet_28_26);

  const endpoint_leaflet_29_27 = makeAttachmentEndpoint(null);
  const node_leaflet_29_27 = new THREE.Group();
  node_leaflet_29_27.name = "Leaf 6 leaflet 5__pivot";
  node_leaflet_29_27.scale.set(1, 1, 1);
  if (endpoint_leaflet_29_27) {
    node_leaflet_29_27.position.copy(endpoint_leaflet_29_27.start);
    node_leaflet_29_27.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leaflet_29_27.position.set(0.355, 0.0355, 0.0);
    node_leaflet_29_27.rotation.set(0.0, 0.0, 0.0);
  }
  node_leaflet_29_27.userData.sculptComponent = {"id": "leaflet-29", "name": "Leaf 6 leaflet 5", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0301, 0.0086, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0628, 0.0157, 0.0], "rx": 0.0473, "rz": 0.0131, "twist": 0}, {"position": [0.1271, 0.0051, 0.0], "rx": 0.0911, "rz": 0.0252, "twist": 0}, {"position": [0.1913, -0.0385, 0.0], "rx": 0.0666, "rz": 0.0184, "twist": 0}, {"position": [0.2556, -0.1151, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-5", "attachment": {"parentId": "rachis-5", "parentSocket": "rachis-5:node", "localStart": [0.355, 0.0355, 0.0], "localEnd": [0.6106, -0.0796, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.355, 0.0355, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-29", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_29_27.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-29", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-5"] ?? root).add(node_leaflet_29_27);
  nodes["leaflet-29"] = node_leaflet_29_27;
  const mesh_leaflet_29_27Geometry = endpoint_leaflet_29_27
    ? new THREE.CylinderGeometry(endpoint_leaflet_29_27.endRadius, endpoint_leaflet_29_27.baseRadius, endpoint_leaflet_29_27.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0301, 0.0086, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0628, 0.0157, 0.0], "rx": 0.0473, "rz": 0.0131, "twist": 0}, {"position": [0.1271, 0.0051, 0.0], "rx": 0.0911, "rz": 0.0252, "twist": 0}, {"position": [0.1913, -0.0385, 0.0], "rx": 0.0666, "rz": 0.0184, "twist": 0}, {"position": [0.2556, -0.1151, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_29_27) {
    mesh_leaflet_29_27Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_29_27 = new THREE.Mesh(
    mesh_leaflet_29_27Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_29_27.name = "Leaf 6 leaflet 5";
  if (endpoint_leaflet_29_27) {
    mesh_leaflet_29_27.position.copy(endpoint_leaflet_29_27.midpoint);
    mesh_leaflet_29_27.quaternion.copy(endpoint_leaflet_29_27.quaternion);
  }
  mesh_leaflet_29_27.castShadow = options.castShadow ?? true;
  mesh_leaflet_29_27.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_29_27.userData.sculptComponent = {"id": "leaflet-29", "name": "Leaf 6 leaflet 5", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0301, 0.0086, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0628, 0.0157, 0.0], "rx": 0.0473, "rz": 0.0131, "twist": 0}, {"position": [0.1271, 0.0051, 0.0], "rx": 0.0911, "rz": 0.0252, "twist": 0}, {"position": [0.1913, -0.0385, 0.0], "rx": 0.0666, "rz": 0.0184, "twist": 0}, {"position": [0.2556, -0.1151, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-5", "attachment": {"parentId": "rachis-5", "parentSocket": "rachis-5:node", "localStart": [0.355, 0.0355, 0.0], "localEnd": [0.6106, -0.0796, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.355, 0.0355, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-29", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_29_27.add(mesh_leaflet_29_27);
  meshes["leaflet-29"] = mesh_leaflet_29_27;
  colliders["leaflet-29"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-29"] ??= [];
  destructionGroups["leaflet-29"].push(node_leaflet_29_27);

  const endpoint_rachis_6_28 = makeAttachmentEndpoint(null);
  const node_rachis_6_28 = new THREE.Group();
  node_rachis_6_28.name = "Compound leaf 7 rachis__pivot";
  node_rachis_6_28.scale.set(1, 1, 1);
  if (endpoint_rachis_6_28) {
    node_rachis_6_28.position.copy(endpoint_rachis_6_28.start);
    node_rachis_6_28.rotation.set(0.0, 1.8326, 0.0);
  } else {
    node_rachis_6_28.position.set(0.0, 0.88, 0.0);
    node_rachis_6_28.rotation.set(0.0, 1.8326, 0.0);
  }
  node_rachis_6_28.userData.sculptComponent = {"id": "rachis-6", "name": "Compound leaf 7 rachis", "level": "meso", "role": "leaf", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Arching rachis of a pinnate compound leaf.", "geometryDescriptor": {"topologyIntent": "Arching rachis of a pinnate compound leaf. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.066, 0.0488, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.132, 0.0766, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.198, 0.0832, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.264, 0.0686, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.33, 0.033, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.88, 0.0], "localEnd": [-0.0854, 0.913, -0.3188], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.88, 0.0], "rotation": [0, 1.8326, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pinnate", "kind": "contour", "description": "terminal leaflet + 2 opposite pairs", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_rachis_6_28.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_rachis_6_28);
  nodes["rachis-6"] = node_rachis_6_28;
  const mesh_rachis_6_28Geometry = endpoint_rachis_6_28
    ? new THREE.CylinderGeometry(endpoint_rachis_6_28.endRadius, endpoint_rachis_6_28.baseRadius, endpoint_rachis_6_28.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.066, 0.0488, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.132, 0.0766, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.198, 0.0832, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.264, 0.0686, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.33, 0.033, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true});
  if (!endpoint_rachis_6_28) {
    mesh_rachis_6_28Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rachis_6_28 = new THREE.Mesh(
    mesh_rachis_6_28Geometry,
    materialMap["stem"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rachis_6_28.name = "Compound leaf 7 rachis";
  if (endpoint_rachis_6_28) {
    mesh_rachis_6_28.position.copy(endpoint_rachis_6_28.midpoint);
    mesh_rachis_6_28.quaternion.copy(endpoint_rachis_6_28.quaternion);
  }
  mesh_rachis_6_28.castShadow = options.castShadow ?? true;
  mesh_rachis_6_28.receiveShadow = options.receiveShadow ?? true;
  mesh_rachis_6_28.userData.sculptComponent = {"id": "rachis-6", "name": "Compound leaf 7 rachis", "level": "meso", "role": "leaf", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Arching rachis of a pinnate compound leaf.", "geometryDescriptor": {"topologyIntent": "Arching rachis of a pinnate compound leaf. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.066, 0.0488, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.132, 0.0766, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.198, 0.0832, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.264, 0.0686, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.33, 0.033, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.88, 0.0], "localEnd": [-0.0854, 0.913, -0.3188], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.88, 0.0], "rotation": [0, 1.8326, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-6", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pinnate", "kind": "contour", "description": "terminal leaflet + 2 opposite pairs", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_rachis_6_28.add(mesh_rachis_6_28);
  meshes["rachis-6"] = mesh_rachis_6_28;
  colliders["rachis-6"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["rachis-6"] ??= [];
  destructionGroups["rachis-6"].push(node_rachis_6_28);

  const endpoint_leaflet_32_29 = makeAttachmentEndpoint(null);
  const node_leaflet_32_29 = new THREE.Group();
  node_leaflet_32_29.name = "Leaf 7 leaflet 3__pivot";
  node_leaflet_32_29.scale.set(1, 1, 1);
  if (endpoint_leaflet_32_29) {
    node_leaflet_32_29.position.copy(endpoint_leaflet_32_29.start);
    node_leaflet_32_29.rotation.set(0.0, -1.2217, 0.0);
  } else {
    node_leaflet_32_29.position.set(0.264, 0.0686, 0.0);
    node_leaflet_32_29.rotation.set(0.0, -1.2217, 0.0);
  }
  node_leaflet_32_29.userData.sculptComponent = {"id": "leaflet-32", "name": "Leaf 7 leaflet 3", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0241, 0.0069, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0503, 0.0126, 0.0], "rx": 0.0378, "rz": 0.012, "twist": -30}, {"position": [0.1017, 0.0041, 0.0], "rx": 0.0729, "rz": 0.0202, "twist": -30}, {"position": [0.1532, -0.0308, 0.0], "rx": 0.0532, "rz": 0.0148, "twist": -30}, {"position": [0.2046, -0.0922, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-6", "attachment": {"parentId": "rachis-6", "parentSocket": "rachis-6:node", "localStart": [0.264, 0.0686, 0.0], "localEnd": [0.334, -0.0236, 0.1923], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.264, 0.0686, 0.0], "rotation": [0, -1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-32", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_32_29.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-32", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-6"] ?? root).add(node_leaflet_32_29);
  nodes["leaflet-32"] = node_leaflet_32_29;
  const mesh_leaflet_32_29Geometry = endpoint_leaflet_32_29
    ? new THREE.CylinderGeometry(endpoint_leaflet_32_29.endRadius, endpoint_leaflet_32_29.baseRadius, endpoint_leaflet_32_29.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0241, 0.0069, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0503, 0.0126, 0.0], "rx": 0.0378, "rz": 0.012, "twist": -30}, {"position": [0.1017, 0.0041, 0.0], "rx": 0.0729, "rz": 0.0202, "twist": -30}, {"position": [0.1532, -0.0308, 0.0], "rx": 0.0532, "rz": 0.0148, "twist": -30}, {"position": [0.2046, -0.0922, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_32_29) {
    mesh_leaflet_32_29Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_32_29 = new THREE.Mesh(
    mesh_leaflet_32_29Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_32_29.name = "Leaf 7 leaflet 3";
  if (endpoint_leaflet_32_29) {
    mesh_leaflet_32_29.position.copy(endpoint_leaflet_32_29.midpoint);
    mesh_leaflet_32_29.quaternion.copy(endpoint_leaflet_32_29.quaternion);
  }
  mesh_leaflet_32_29.castShadow = options.castShadow ?? true;
  mesh_leaflet_32_29.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_32_29.userData.sculptComponent = {"id": "leaflet-32", "name": "Leaf 7 leaflet 3", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0241, 0.0069, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0503, 0.0126, 0.0], "rx": 0.0378, "rz": 0.012, "twist": -30}, {"position": [0.1017, 0.0041, 0.0], "rx": 0.0729, "rz": 0.0202, "twist": -30}, {"position": [0.1532, -0.0308, 0.0], "rx": 0.0532, "rz": 0.0148, "twist": -30}, {"position": [0.2046, -0.0922, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-6", "attachment": {"parentId": "rachis-6", "parentSocket": "rachis-6:node", "localStart": [0.264, 0.0686, 0.0], "localEnd": [0.334, -0.0236, 0.1923], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.264, 0.0686, 0.0], "rotation": [0, -1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-32", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_32_29.add(mesh_leaflet_32_29);
  meshes["leaflet-32"] = mesh_leaflet_32_29;
  colliders["leaflet-32"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-32"] ??= [];
  destructionGroups["leaflet-32"].push(node_leaflet_32_29);

  const endpoint_leaflet_33_30 = makeAttachmentEndpoint(null);
  const node_leaflet_33_30 = new THREE.Group();
  node_leaflet_33_30.name = "Leaf 7 leaflet 4__pivot";
  node_leaflet_33_30.scale.set(1, 1, 1);
  if (endpoint_leaflet_33_30) {
    node_leaflet_33_30.position.copy(endpoint_leaflet_33_30.start);
    node_leaflet_33_30.rotation.set(0.0, 1.2217, 0.0);
  } else {
    node_leaflet_33_30.position.set(0.264, 0.0686, 0.0);
    node_leaflet_33_30.rotation.set(0.0, 1.2217, 0.0);
  }
  node_leaflet_33_30.userData.sculptComponent = {"id": "leaflet-33", "name": "Leaf 7 leaflet 4", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0241, 0.0069, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0503, 0.0126, 0.0], "rx": 0.0378, "rz": 0.012, "twist": 30}, {"position": [0.1017, 0.0041, 0.0], "rx": 0.0729, "rz": 0.0202, "twist": 30}, {"position": [0.1532, -0.0308, 0.0], "rx": 0.0532, "rz": 0.0148, "twist": 30}, {"position": [0.2046, -0.0922, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-6", "attachment": {"parentId": "rachis-6", "parentSocket": "rachis-6:node", "localStart": [0.264, 0.0686, 0.0], "localEnd": [0.334, -0.0236, -0.1923], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.264, 0.0686, 0.0], "rotation": [0, 1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-33", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_33_30.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-33", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-6"] ?? root).add(node_leaflet_33_30);
  nodes["leaflet-33"] = node_leaflet_33_30;
  const mesh_leaflet_33_30Geometry = endpoint_leaflet_33_30
    ? new THREE.CylinderGeometry(endpoint_leaflet_33_30.endRadius, endpoint_leaflet_33_30.baseRadius, endpoint_leaflet_33_30.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0241, 0.0069, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0503, 0.0126, 0.0], "rx": 0.0378, "rz": 0.012, "twist": 30}, {"position": [0.1017, 0.0041, 0.0], "rx": 0.0729, "rz": 0.0202, "twist": 30}, {"position": [0.1532, -0.0308, 0.0], "rx": 0.0532, "rz": 0.0148, "twist": 30}, {"position": [0.2046, -0.0922, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_33_30) {
    mesh_leaflet_33_30Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_33_30 = new THREE.Mesh(
    mesh_leaflet_33_30Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_33_30.name = "Leaf 7 leaflet 4";
  if (endpoint_leaflet_33_30) {
    mesh_leaflet_33_30.position.copy(endpoint_leaflet_33_30.midpoint);
    mesh_leaflet_33_30.quaternion.copy(endpoint_leaflet_33_30.quaternion);
  }
  mesh_leaflet_33_30.castShadow = options.castShadow ?? true;
  mesh_leaflet_33_30.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_33_30.userData.sculptComponent = {"id": "leaflet-33", "name": "Leaf 7 leaflet 4", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0241, 0.0069, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0503, 0.0126, 0.0], "rx": 0.0378, "rz": 0.012, "twist": 30}, {"position": [0.1017, 0.0041, 0.0], "rx": 0.0729, "rz": 0.0202, "twist": 30}, {"position": [0.1532, -0.0308, 0.0], "rx": 0.0532, "rz": 0.0148, "twist": 30}, {"position": [0.2046, -0.0922, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-6", "attachment": {"parentId": "rachis-6", "parentSocket": "rachis-6:node", "localStart": [0.264, 0.0686, 0.0], "localEnd": [0.334, -0.0236, -0.1923], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.264, 0.0686, 0.0], "rotation": [0, 1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-33", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_33_30.add(mesh_leaflet_33_30);
  meshes["leaflet-33"] = mesh_leaflet_33_30;
  colliders["leaflet-33"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-33"] ??= [];
  destructionGroups["leaflet-33"].push(node_leaflet_33_30);

  const endpoint_leaflet_34_31 = makeAttachmentEndpoint(null);
  const node_leaflet_34_31 = new THREE.Group();
  node_leaflet_34_31.name = "Leaf 7 leaflet 5__pivot";
  node_leaflet_34_31.scale.set(1, 1, 1);
  if (endpoint_leaflet_34_31) {
    node_leaflet_34_31.position.copy(endpoint_leaflet_34_31.start);
    node_leaflet_34_31.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leaflet_34_31.position.set(0.33, 0.033, 0.0);
    node_leaflet_34_31.rotation.set(0.0, 0.0, 0.0);
  }
  node_leaflet_34_31.userData.sculptComponent = {"id": "leaflet-34", "name": "Leaf 7 leaflet 5", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0279, 0.008, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0584, 0.0146, 0.0], "rx": 0.0439, "rz": 0.0122, "twist": 0}, {"position": [0.1181, 0.0048, 0.0], "rx": 0.0846, "rz": 0.0234, "twist": 0}, {"position": [0.1779, -0.0358, 0.0], "rx": 0.0618, "rz": 0.0171, "twist": 0}, {"position": [0.2376, -0.107, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-6", "attachment": {"parentId": "rachis-6", "parentSocket": "rachis-6:node", "localStart": [0.33, 0.033, 0.0], "localEnd": [0.5676, -0.074, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.33, 0.033, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-34", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_34_31.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-34", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-6"] ?? root).add(node_leaflet_34_31);
  nodes["leaflet-34"] = node_leaflet_34_31;
  const mesh_leaflet_34_31Geometry = endpoint_leaflet_34_31
    ? new THREE.CylinderGeometry(endpoint_leaflet_34_31.endRadius, endpoint_leaflet_34_31.baseRadius, endpoint_leaflet_34_31.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0279, 0.008, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0584, 0.0146, 0.0], "rx": 0.0439, "rz": 0.0122, "twist": 0}, {"position": [0.1181, 0.0048, 0.0], "rx": 0.0846, "rz": 0.0234, "twist": 0}, {"position": [0.1779, -0.0358, 0.0], "rx": 0.0618, "rz": 0.0171, "twist": 0}, {"position": [0.2376, -0.107, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_34_31) {
    mesh_leaflet_34_31Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_34_31 = new THREE.Mesh(
    mesh_leaflet_34_31Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_34_31.name = "Leaf 7 leaflet 5";
  if (endpoint_leaflet_34_31) {
    mesh_leaflet_34_31.position.copy(endpoint_leaflet_34_31.midpoint);
    mesh_leaflet_34_31.quaternion.copy(endpoint_leaflet_34_31.quaternion);
  }
  mesh_leaflet_34_31.castShadow = options.castShadow ?? true;
  mesh_leaflet_34_31.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_34_31.userData.sculptComponent = {"id": "leaflet-34", "name": "Leaf 7 leaflet 5", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0279, 0.008, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0584, 0.0146, 0.0], "rx": 0.0439, "rz": 0.0122, "twist": 0}, {"position": [0.1181, 0.0048, 0.0], "rx": 0.0846, "rz": 0.0234, "twist": 0}, {"position": [0.1779, -0.0358, 0.0], "rx": 0.0618, "rz": 0.0171, "twist": 0}, {"position": [0.2376, -0.107, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-6", "attachment": {"parentId": "rachis-6", "parentSocket": "rachis-6:node", "localStart": [0.33, 0.033, 0.0], "localEnd": [0.5676, -0.074, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.33, 0.033, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-34", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_34_31.add(mesh_leaflet_34_31);
  meshes["leaflet-34"] = mesh_leaflet_34_31;
  colliders["leaflet-34"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-34"] ??= [];
  destructionGroups["leaflet-34"].push(node_leaflet_34_31);

  const endpoint_rachis_7_32 = makeAttachmentEndpoint(null);
  const node_rachis_7_32 = new THREE.Group();
  node_rachis_7_32.name = "Compound leaf 8 rachis__pivot";
  node_rachis_7_32.scale.set(1, 1, 1);
  if (endpoint_rachis_7_32) {
    node_rachis_7_32.position.copy(endpoint_rachis_7_32.start);
    node_rachis_7_32.rotation.set(0.0, 4.2324, 0.0);
  } else {
    node_rachis_7_32.position.set(0.0, 0.96, 0.0);
    node_rachis_7_32.rotation.set(0.0, 4.2324, 0.0);
  }
  node_rachis_7_32.userData.sculptComponent = {"id": "rachis-7", "name": "Compound leaf 8 rachis", "level": "meso", "role": "leaf", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Arching rachis of a pinnate compound leaf.", "geometryDescriptor": {"topologyIntent": "Arching rachis of a pinnate compound leaf. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.061, 0.0451, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.122, 0.0708, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.183, 0.0769, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.244, 0.0634, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.305, 0.0305, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.96, 0.0], "localEnd": [-0.1408, 0.9905, 0.2705], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.96, 0.0], "rotation": [0, 4.2324, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-7", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pinnate", "kind": "contour", "description": "terminal leaflet + 2 opposite pairs", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_rachis_7_32.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-7", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_rachis_7_32);
  nodes["rachis-7"] = node_rachis_7_32;
  const mesh_rachis_7_32Geometry = endpoint_rachis_7_32
    ? new THREE.CylinderGeometry(endpoint_rachis_7_32.endRadius, endpoint_rachis_7_32.baseRadius, endpoint_rachis_7_32.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.061, 0.0451, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.122, 0.0708, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.183, 0.0769, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.244, 0.0634, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.305, 0.0305, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true});
  if (!endpoint_rachis_7_32) {
    mesh_rachis_7_32Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rachis_7_32 = new THREE.Mesh(
    mesh_rachis_7_32Geometry,
    materialMap["stem"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rachis_7_32.name = "Compound leaf 8 rachis";
  if (endpoint_rachis_7_32) {
    mesh_rachis_7_32.position.copy(endpoint_rachis_7_32.midpoint);
    mesh_rachis_7_32.quaternion.copy(endpoint_rachis_7_32.quaternion);
  }
  mesh_rachis_7_32.castShadow = options.castShadow ?? true;
  mesh_rachis_7_32.receiveShadow = options.receiveShadow ?? true;
  mesh_rachis_7_32.userData.sculptComponent = {"id": "rachis-7", "name": "Compound leaf 8 rachis", "level": "meso", "role": "leaf", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Arching rachis of a pinnate compound leaf.", "geometryDescriptor": {"topologyIntent": "Arching rachis of a pinnate compound leaf. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.061, 0.0451, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.122, 0.0708, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.183, 0.0769, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.244, 0.0634, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.305, 0.0305, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.96, 0.0], "localEnd": [-0.1408, 0.9905, 0.2705], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.96, 0.0], "rotation": [0, 4.2324, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-7", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pinnate", "kind": "contour", "description": "terminal leaflet + 2 opposite pairs", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_rachis_7_32.add(mesh_rachis_7_32);
  meshes["rachis-7"] = mesh_rachis_7_32;
  colliders["rachis-7"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["rachis-7"] ??= [];
  destructionGroups["rachis-7"].push(node_rachis_7_32);

  const endpoint_leaflet_37_33 = makeAttachmentEndpoint(null);
  const node_leaflet_37_33 = new THREE.Group();
  node_leaflet_37_33.name = "Leaf 8 leaflet 3__pivot";
  node_leaflet_37_33.scale.set(1, 1, 1);
  if (endpoint_leaflet_37_33) {
    node_leaflet_37_33.position.copy(endpoint_leaflet_37_33.start);
    node_leaflet_37_33.rotation.set(0.0, -1.2217, 0.0);
  } else {
    node_leaflet_37_33.position.set(0.244, 0.0634, 0.0);
    node_leaflet_37_33.rotation.set(0.0, -1.2217, 0.0);
  }
  node_leaflet_37_33.userData.sculptComponent = {"id": "leaflet-37", "name": "Leaf 8 leaflet 3", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0222, 0.0064, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0465, 0.0116, 0.0], "rx": 0.035, "rz": 0.012, "twist": -30}, {"position": [0.094, 0.0038, 0.0], "rx": 0.0674, "rz": 0.0187, "twist": -30}, {"position": [0.1416, -0.0285, 0.0], "rx": 0.0491, "rz": 0.0137, "twist": -30}, {"position": [0.1891, -0.0852, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-7", "attachment": {"parentId": "rachis-7", "parentSocket": "rachis-7:node", "localStart": [0.244, 0.0634, 0.0], "localEnd": [0.3087, -0.0218, 0.1777], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.244, 0.0634, 0.0], "rotation": [0, -1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-37", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_37_33.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-37", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-7"] ?? root).add(node_leaflet_37_33);
  nodes["leaflet-37"] = node_leaflet_37_33;
  const mesh_leaflet_37_33Geometry = endpoint_leaflet_37_33
    ? new THREE.CylinderGeometry(endpoint_leaflet_37_33.endRadius, endpoint_leaflet_37_33.baseRadius, endpoint_leaflet_37_33.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0222, 0.0064, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0465, 0.0116, 0.0], "rx": 0.035, "rz": 0.012, "twist": -30}, {"position": [0.094, 0.0038, 0.0], "rx": 0.0674, "rz": 0.0187, "twist": -30}, {"position": [0.1416, -0.0285, 0.0], "rx": 0.0491, "rz": 0.0137, "twist": -30}, {"position": [0.1891, -0.0852, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_37_33) {
    mesh_leaflet_37_33Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_37_33 = new THREE.Mesh(
    mesh_leaflet_37_33Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_37_33.name = "Leaf 8 leaflet 3";
  if (endpoint_leaflet_37_33) {
    mesh_leaflet_37_33.position.copy(endpoint_leaflet_37_33.midpoint);
    mesh_leaflet_37_33.quaternion.copy(endpoint_leaflet_37_33.quaternion);
  }
  mesh_leaflet_37_33.castShadow = options.castShadow ?? true;
  mesh_leaflet_37_33.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_37_33.userData.sculptComponent = {"id": "leaflet-37", "name": "Leaf 8 leaflet 3", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0222, 0.0064, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0465, 0.0116, 0.0], "rx": 0.035, "rz": 0.012, "twist": -30}, {"position": [0.094, 0.0038, 0.0], "rx": 0.0674, "rz": 0.0187, "twist": -30}, {"position": [0.1416, -0.0285, 0.0], "rx": 0.0491, "rz": 0.0137, "twist": -30}, {"position": [0.1891, -0.0852, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-7", "attachment": {"parentId": "rachis-7", "parentSocket": "rachis-7:node", "localStart": [0.244, 0.0634, 0.0], "localEnd": [0.3087, -0.0218, 0.1777], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.244, 0.0634, 0.0], "rotation": [0, -1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-37", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_37_33.add(mesh_leaflet_37_33);
  meshes["leaflet-37"] = mesh_leaflet_37_33;
  colliders["leaflet-37"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-37"] ??= [];
  destructionGroups["leaflet-37"].push(node_leaflet_37_33);

  const endpoint_leaflet_38_34 = makeAttachmentEndpoint(null);
  const node_leaflet_38_34 = new THREE.Group();
  node_leaflet_38_34.name = "Leaf 8 leaflet 4__pivot";
  node_leaflet_38_34.scale.set(1, 1, 1);
  if (endpoint_leaflet_38_34) {
    node_leaflet_38_34.position.copy(endpoint_leaflet_38_34.start);
    node_leaflet_38_34.rotation.set(0.0, 1.2217, 0.0);
  } else {
    node_leaflet_38_34.position.set(0.244, 0.0634, 0.0);
    node_leaflet_38_34.rotation.set(0.0, 1.2217, 0.0);
  }
  node_leaflet_38_34.userData.sculptComponent = {"id": "leaflet-38", "name": "Leaf 8 leaflet 4", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0222, 0.0064, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0465, 0.0116, 0.0], "rx": 0.035, "rz": 0.012, "twist": 30}, {"position": [0.094, 0.0038, 0.0], "rx": 0.0674, "rz": 0.0187, "twist": 30}, {"position": [0.1416, -0.0285, 0.0], "rx": 0.0491, "rz": 0.0137, "twist": 30}, {"position": [0.1891, -0.0852, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-7", "attachment": {"parentId": "rachis-7", "parentSocket": "rachis-7:node", "localStart": [0.244, 0.0634, 0.0], "localEnd": [0.3087, -0.0218, -0.1777], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.244, 0.0634, 0.0], "rotation": [0, 1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-38", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_38_34.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-38", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-7"] ?? root).add(node_leaflet_38_34);
  nodes["leaflet-38"] = node_leaflet_38_34;
  const mesh_leaflet_38_34Geometry = endpoint_leaflet_38_34
    ? new THREE.CylinderGeometry(endpoint_leaflet_38_34.endRadius, endpoint_leaflet_38_34.baseRadius, endpoint_leaflet_38_34.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0222, 0.0064, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0465, 0.0116, 0.0], "rx": 0.035, "rz": 0.012, "twist": 30}, {"position": [0.094, 0.0038, 0.0], "rx": 0.0674, "rz": 0.0187, "twist": 30}, {"position": [0.1416, -0.0285, 0.0], "rx": 0.0491, "rz": 0.0137, "twist": 30}, {"position": [0.1891, -0.0852, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_38_34) {
    mesh_leaflet_38_34Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_38_34 = new THREE.Mesh(
    mesh_leaflet_38_34Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_38_34.name = "Leaf 8 leaflet 4";
  if (endpoint_leaflet_38_34) {
    mesh_leaflet_38_34.position.copy(endpoint_leaflet_38_34.midpoint);
    mesh_leaflet_38_34.quaternion.copy(endpoint_leaflet_38_34.quaternion);
  }
  mesh_leaflet_38_34.castShadow = options.castShadow ?? true;
  mesh_leaflet_38_34.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_38_34.userData.sculptComponent = {"id": "leaflet-38", "name": "Leaf 8 leaflet 4", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0222, 0.0064, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0465, 0.0116, 0.0], "rx": 0.035, "rz": 0.012, "twist": 30}, {"position": [0.094, 0.0038, 0.0], "rx": 0.0674, "rz": 0.0187, "twist": 30}, {"position": [0.1416, -0.0285, 0.0], "rx": 0.0491, "rz": 0.0137, "twist": 30}, {"position": [0.1891, -0.0852, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-7", "attachment": {"parentId": "rachis-7", "parentSocket": "rachis-7:node", "localStart": [0.244, 0.0634, 0.0], "localEnd": [0.3087, -0.0218, -0.1777], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.244, 0.0634, 0.0], "rotation": [0, 1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-38", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_38_34.add(mesh_leaflet_38_34);
  meshes["leaflet-38"] = mesh_leaflet_38_34;
  colliders["leaflet-38"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-38"] ??= [];
  destructionGroups["leaflet-38"].push(node_leaflet_38_34);

  const endpoint_leaflet_39_35 = makeAttachmentEndpoint(null);
  const node_leaflet_39_35 = new THREE.Group();
  node_leaflet_39_35.name = "Leaf 8 leaflet 5__pivot";
  node_leaflet_39_35.scale.set(1, 1, 1);
  if (endpoint_leaflet_39_35) {
    node_leaflet_39_35.position.copy(endpoint_leaflet_39_35.start);
    node_leaflet_39_35.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leaflet_39_35.position.set(0.305, 0.0305, 0.0);
    node_leaflet_39_35.rotation.set(0.0, 0.0, 0.0);
  }
  node_leaflet_39_35.userData.sculptComponent = {"id": "leaflet-39", "name": "Leaf 8 leaflet 5", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0258, 0.0074, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.054, 0.0135, 0.0], "rx": 0.0405, "rz": 0.012, "twist": 0}, {"position": [0.1092, 0.0044, 0.0], "rx": 0.0783, "rz": 0.0218, "twist": 0}, {"position": [0.1644, -0.033, 0.0], "rx": 0.0571, "rz": 0.0158, "twist": 0}, {"position": [0.2196, -0.0989, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-7", "attachment": {"parentId": "rachis-7", "parentSocket": "rachis-7:node", "localStart": [0.305, 0.0305, 0.0], "localEnd": [0.5246, -0.0684, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.305, 0.0305, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-39", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_39_35.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-39", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-7"] ?? root).add(node_leaflet_39_35);
  nodes["leaflet-39"] = node_leaflet_39_35;
  const mesh_leaflet_39_35Geometry = endpoint_leaflet_39_35
    ? new THREE.CylinderGeometry(endpoint_leaflet_39_35.endRadius, endpoint_leaflet_39_35.baseRadius, endpoint_leaflet_39_35.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0258, 0.0074, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.054, 0.0135, 0.0], "rx": 0.0405, "rz": 0.012, "twist": 0}, {"position": [0.1092, 0.0044, 0.0], "rx": 0.0783, "rz": 0.0218, "twist": 0}, {"position": [0.1644, -0.033, 0.0], "rx": 0.0571, "rz": 0.0158, "twist": 0}, {"position": [0.2196, -0.0989, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_39_35) {
    mesh_leaflet_39_35Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_39_35 = new THREE.Mesh(
    mesh_leaflet_39_35Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_39_35.name = "Leaf 8 leaflet 5";
  if (endpoint_leaflet_39_35) {
    mesh_leaflet_39_35.position.copy(endpoint_leaflet_39_35.midpoint);
    mesh_leaflet_39_35.quaternion.copy(endpoint_leaflet_39_35.quaternion);
  }
  mesh_leaflet_39_35.castShadow = options.castShadow ?? true;
  mesh_leaflet_39_35.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_39_35.userData.sculptComponent = {"id": "leaflet-39", "name": "Leaf 8 leaflet 5", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0258, 0.0074, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.054, 0.0135, 0.0], "rx": 0.0405, "rz": 0.012, "twist": 0}, {"position": [0.1092, 0.0044, 0.0], "rx": 0.0783, "rz": 0.0218, "twist": 0}, {"position": [0.1644, -0.033, 0.0], "rx": 0.0571, "rz": 0.0158, "twist": 0}, {"position": [0.2196, -0.0989, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-7", "attachment": {"parentId": "rachis-7", "parentSocket": "rachis-7:node", "localStart": [0.305, 0.0305, 0.0], "localEnd": [0.5246, -0.0684, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.305, 0.0305, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-39", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_39_35.add(mesh_leaflet_39_35);
  meshes["leaflet-39"] = mesh_leaflet_39_35;
  colliders["leaflet-39"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-39"] ??= [];
  destructionGroups["leaflet-39"].push(node_leaflet_39_35);

  const endpoint_rachis_8_36 = makeAttachmentEndpoint(null);
  const node_rachis_8_36 = new THREE.Group();
  node_rachis_8_36.name = "Compound leaf 9 rachis__pivot";
  node_rachis_8_36.scale.set(1, 1, 1);
  if (endpoint_rachis_8_36) {
    node_rachis_8_36.position.copy(endpoint_rachis_8_36.start);
    node_rachis_8_36.rotation.set(0.0, 3.4907, 0.0);
  } else {
    node_rachis_8_36.position.set(-0.3524, 0.545, 0.1283);
    node_rachis_8_36.rotation.set(0.0, 3.4907, 0.0);
  }
  node_rachis_8_36.userData.sculptComponent = {"id": "rachis-8", "name": "Compound leaf 9 rachis", "level": "meso", "role": "leaf", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Arching rachis of a pinnate compound leaf.", "geometryDescriptor": {"topologyIntent": "Arching rachis of a pinnate compound leaf. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.08, 0.0592, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.16, 0.0928, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.24, 0.1008, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.32, 0.0832, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.4, 0.04, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "branch-0", "attachment": {"parentId": "branch-0", "parentSocket": "branch-0:node", "localStart": [-0.3524, 0.545, 0.1283], "localEnd": [-0.7283, 0.585, 0.2651], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.3524, 0.545, 0.1283], "rotation": [0, 3.4907, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-8", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pinnate", "kind": "contour", "description": "terminal leaflet + 2 opposite pairs", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_rachis_8_36.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-8", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["branch-0"] ?? root).add(node_rachis_8_36);
  nodes["rachis-8"] = node_rachis_8_36;
  const mesh_rachis_8_36Geometry = endpoint_rachis_8_36
    ? new THREE.CylinderGeometry(endpoint_rachis_8_36.endRadius, endpoint_rachis_8_36.baseRadius, endpoint_rachis_8_36.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.08, 0.0592, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.16, 0.0928, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.24, 0.1008, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.32, 0.0832, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.4, 0.04, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true});
  if (!endpoint_rachis_8_36) {
    mesh_rachis_8_36Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rachis_8_36 = new THREE.Mesh(
    mesh_rachis_8_36Geometry,
    materialMap["stem"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rachis_8_36.name = "Compound leaf 9 rachis";
  if (endpoint_rachis_8_36) {
    mesh_rachis_8_36.position.copy(endpoint_rachis_8_36.midpoint);
    mesh_rachis_8_36.quaternion.copy(endpoint_rachis_8_36.quaternion);
  }
  mesh_rachis_8_36.castShadow = options.castShadow ?? true;
  mesh_rachis_8_36.receiveShadow = options.receiveShadow ?? true;
  mesh_rachis_8_36.userData.sculptComponent = {"id": "rachis-8", "name": "Compound leaf 9 rachis", "level": "meso", "role": "leaf", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Arching rachis of a pinnate compound leaf.", "geometryDescriptor": {"topologyIntent": "Arching rachis of a pinnate compound leaf. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.08, 0.0592, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.16, 0.0928, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.24, 0.1008, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.32, 0.0832, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.4, 0.04, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "branch-0", "attachment": {"parentId": "branch-0", "parentSocket": "branch-0:node", "localStart": [-0.3524, 0.545, 0.1283], "localEnd": [-0.7283, 0.585, 0.2651], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.3524, 0.545, 0.1283], "rotation": [0, 3.4907, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-8", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pinnate", "kind": "contour", "description": "terminal leaflet + 2 opposite pairs", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_rachis_8_36.add(mesh_rachis_8_36);
  meshes["rachis-8"] = mesh_rachis_8_36;
  colliders["rachis-8"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["rachis-8"] ??= [];
  destructionGroups["rachis-8"].push(node_rachis_8_36);

  const endpoint_leaflet_42_37 = makeAttachmentEndpoint(null);
  const node_leaflet_42_37 = new THREE.Group();
  node_leaflet_42_37.name = "Leaf 9 leaflet 3__pivot";
  node_leaflet_42_37.scale.set(1, 1, 1);
  if (endpoint_leaflet_42_37) {
    node_leaflet_42_37.position.copy(endpoint_leaflet_42_37.start);
    node_leaflet_42_37.rotation.set(0.0, -1.2217, 0.0);
  } else {
    node_leaflet_42_37.position.set(0.32, 0.0832, 0.0);
    node_leaflet_42_37.rotation.set(0.0, -1.2217, 0.0);
  }
  node_leaflet_42_37.userData.sculptComponent = {"id": "leaflet-42", "name": "Leaf 9 leaflet 3", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0292, 0.0083, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0609, 0.0152, 0.0], "rx": 0.0458, "rz": 0.0128, "twist": -30}, {"position": [0.1233, 0.005, 0.0], "rx": 0.0884, "rz": 0.0245, "twist": -30}, {"position": [0.1856, -0.0373, 0.0], "rx": 0.0645, "rz": 0.0178, "twist": -30}, {"position": [0.248, -0.1117, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-8", "attachment": {"parentId": "rachis-8", "parentSocket": "rachis-8:node", "localStart": [0.32, 0.0832, 0.0], "localEnd": [0.4048, -0.0285, 0.233], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.32, 0.0832, 0.0], "rotation": [0, -1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-42", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_42_37.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-42", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-8"] ?? root).add(node_leaflet_42_37);
  nodes["leaflet-42"] = node_leaflet_42_37;
  const mesh_leaflet_42_37Geometry = endpoint_leaflet_42_37
    ? new THREE.CylinderGeometry(endpoint_leaflet_42_37.endRadius, endpoint_leaflet_42_37.baseRadius, endpoint_leaflet_42_37.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0292, 0.0083, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0609, 0.0152, 0.0], "rx": 0.0458, "rz": 0.0128, "twist": -30}, {"position": [0.1233, 0.005, 0.0], "rx": 0.0884, "rz": 0.0245, "twist": -30}, {"position": [0.1856, -0.0373, 0.0], "rx": 0.0645, "rz": 0.0178, "twist": -30}, {"position": [0.248, -0.1117, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_42_37) {
    mesh_leaflet_42_37Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_42_37 = new THREE.Mesh(
    mesh_leaflet_42_37Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_42_37.name = "Leaf 9 leaflet 3";
  if (endpoint_leaflet_42_37) {
    mesh_leaflet_42_37.position.copy(endpoint_leaflet_42_37.midpoint);
    mesh_leaflet_42_37.quaternion.copy(endpoint_leaflet_42_37.quaternion);
  }
  mesh_leaflet_42_37.castShadow = options.castShadow ?? true;
  mesh_leaflet_42_37.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_42_37.userData.sculptComponent = {"id": "leaflet-42", "name": "Leaf 9 leaflet 3", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0292, 0.0083, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0609, 0.0152, 0.0], "rx": 0.0458, "rz": 0.0128, "twist": -30}, {"position": [0.1233, 0.005, 0.0], "rx": 0.0884, "rz": 0.0245, "twist": -30}, {"position": [0.1856, -0.0373, 0.0], "rx": 0.0645, "rz": 0.0178, "twist": -30}, {"position": [0.248, -0.1117, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-8", "attachment": {"parentId": "rachis-8", "parentSocket": "rachis-8:node", "localStart": [0.32, 0.0832, 0.0], "localEnd": [0.4048, -0.0285, 0.233], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.32, 0.0832, 0.0], "rotation": [0, -1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-42", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_42_37.add(mesh_leaflet_42_37);
  meshes["leaflet-42"] = mesh_leaflet_42_37;
  colliders["leaflet-42"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-42"] ??= [];
  destructionGroups["leaflet-42"].push(node_leaflet_42_37);

  const endpoint_leaflet_43_38 = makeAttachmentEndpoint(null);
  const node_leaflet_43_38 = new THREE.Group();
  node_leaflet_43_38.name = "Leaf 9 leaflet 4__pivot";
  node_leaflet_43_38.scale.set(1, 1, 1);
  if (endpoint_leaflet_43_38) {
    node_leaflet_43_38.position.copy(endpoint_leaflet_43_38.start);
    node_leaflet_43_38.rotation.set(0.0, 1.2217, 0.0);
  } else {
    node_leaflet_43_38.position.set(0.32, 0.0832, 0.0);
    node_leaflet_43_38.rotation.set(0.0, 1.2217, 0.0);
  }
  node_leaflet_43_38.userData.sculptComponent = {"id": "leaflet-43", "name": "Leaf 9 leaflet 4", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0292, 0.0083, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0609, 0.0152, 0.0], "rx": 0.0458, "rz": 0.0128, "twist": 30}, {"position": [0.1233, 0.005, 0.0], "rx": 0.0884, "rz": 0.0245, "twist": 30}, {"position": [0.1856, -0.0373, 0.0], "rx": 0.0645, "rz": 0.0178, "twist": 30}, {"position": [0.248, -0.1117, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-8", "attachment": {"parentId": "rachis-8", "parentSocket": "rachis-8:node", "localStart": [0.32, 0.0832, 0.0], "localEnd": [0.4048, -0.0285, -0.233], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.32, 0.0832, 0.0], "rotation": [0, 1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-43", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_43_38.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-43", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-8"] ?? root).add(node_leaflet_43_38);
  nodes["leaflet-43"] = node_leaflet_43_38;
  const mesh_leaflet_43_38Geometry = endpoint_leaflet_43_38
    ? new THREE.CylinderGeometry(endpoint_leaflet_43_38.endRadius, endpoint_leaflet_43_38.baseRadius, endpoint_leaflet_43_38.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0292, 0.0083, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0609, 0.0152, 0.0], "rx": 0.0458, "rz": 0.0128, "twist": 30}, {"position": [0.1233, 0.005, 0.0], "rx": 0.0884, "rz": 0.0245, "twist": 30}, {"position": [0.1856, -0.0373, 0.0], "rx": 0.0645, "rz": 0.0178, "twist": 30}, {"position": [0.248, -0.1117, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_43_38) {
    mesh_leaflet_43_38Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_43_38 = new THREE.Mesh(
    mesh_leaflet_43_38Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_43_38.name = "Leaf 9 leaflet 4";
  if (endpoint_leaflet_43_38) {
    mesh_leaflet_43_38.position.copy(endpoint_leaflet_43_38.midpoint);
    mesh_leaflet_43_38.quaternion.copy(endpoint_leaflet_43_38.quaternion);
  }
  mesh_leaflet_43_38.castShadow = options.castShadow ?? true;
  mesh_leaflet_43_38.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_43_38.userData.sculptComponent = {"id": "leaflet-43", "name": "Leaf 9 leaflet 4", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0292, 0.0083, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0609, 0.0152, 0.0], "rx": 0.0458, "rz": 0.0128, "twist": 30}, {"position": [0.1233, 0.005, 0.0], "rx": 0.0884, "rz": 0.0245, "twist": 30}, {"position": [0.1856, -0.0373, 0.0], "rx": 0.0645, "rz": 0.0178, "twist": 30}, {"position": [0.248, -0.1117, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-8", "attachment": {"parentId": "rachis-8", "parentSocket": "rachis-8:node", "localStart": [0.32, 0.0832, 0.0], "localEnd": [0.4048, -0.0285, -0.233], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.32, 0.0832, 0.0], "rotation": [0, 1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-43", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_43_38.add(mesh_leaflet_43_38);
  meshes["leaflet-43"] = mesh_leaflet_43_38;
  colliders["leaflet-43"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-43"] ??= [];
  destructionGroups["leaflet-43"].push(node_leaflet_43_38);

  const endpoint_leaflet_44_39 = makeAttachmentEndpoint(null);
  const node_leaflet_44_39 = new THREE.Group();
  node_leaflet_44_39.name = "Leaf 9 leaflet 5__pivot";
  node_leaflet_44_39.scale.set(1, 1, 1);
  if (endpoint_leaflet_44_39) {
    node_leaflet_44_39.position.copy(endpoint_leaflet_44_39.start);
    node_leaflet_44_39.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leaflet_44_39.position.set(0.4, 0.04, 0.0);
    node_leaflet_44_39.rotation.set(0.0, 0.0, 0.0);
  }
  node_leaflet_44_39.userData.sculptComponent = {"id": "leaflet-44", "name": "Leaf 9 leaflet 5", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0339, 0.0097, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0708, 0.0177, 0.0], "rx": 0.0532, "rz": 0.0148, "twist": 0}, {"position": [0.1432, 0.0058, 0.0], "rx": 0.1026, "rz": 0.0284, "twist": 0}, {"position": [0.2156, -0.0433, 0.0], "rx": 0.0749, "rz": 0.0207, "twist": 0}, {"position": [0.288, -0.1297, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-8", "attachment": {"parentId": "rachis-8", "parentSocket": "rachis-8:node", "localStart": [0.4, 0.04, 0.0], "localEnd": [0.688, -0.0897, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.4, 0.04, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-44", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_44_39.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-44", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-8"] ?? root).add(node_leaflet_44_39);
  nodes["leaflet-44"] = node_leaflet_44_39;
  const mesh_leaflet_44_39Geometry = endpoint_leaflet_44_39
    ? new THREE.CylinderGeometry(endpoint_leaflet_44_39.endRadius, endpoint_leaflet_44_39.baseRadius, endpoint_leaflet_44_39.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0339, 0.0097, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0708, 0.0177, 0.0], "rx": 0.0532, "rz": 0.0148, "twist": 0}, {"position": [0.1432, 0.0058, 0.0], "rx": 0.1026, "rz": 0.0284, "twist": 0}, {"position": [0.2156, -0.0433, 0.0], "rx": 0.0749, "rz": 0.0207, "twist": 0}, {"position": [0.288, -0.1297, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_44_39) {
    mesh_leaflet_44_39Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_44_39 = new THREE.Mesh(
    mesh_leaflet_44_39Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_44_39.name = "Leaf 9 leaflet 5";
  if (endpoint_leaflet_44_39) {
    mesh_leaflet_44_39.position.copy(endpoint_leaflet_44_39.midpoint);
    mesh_leaflet_44_39.quaternion.copy(endpoint_leaflet_44_39.quaternion);
  }
  mesh_leaflet_44_39.castShadow = options.castShadow ?? true;
  mesh_leaflet_44_39.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_44_39.userData.sculptComponent = {"id": "leaflet-44", "name": "Leaf 9 leaflet 5", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0339, 0.0097, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0708, 0.0177, 0.0], "rx": 0.0532, "rz": 0.0148, "twist": 0}, {"position": [0.1432, 0.0058, 0.0], "rx": 0.1026, "rz": 0.0284, "twist": 0}, {"position": [0.2156, -0.0433, 0.0], "rx": 0.0749, "rz": 0.0207, "twist": 0}, {"position": [0.288, -0.1297, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-8", "attachment": {"parentId": "rachis-8", "parentSocket": "rachis-8:node", "localStart": [0.4, 0.04, 0.0], "localEnd": [0.688, -0.0897, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.4, 0.04, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-44", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_44_39.add(mesh_leaflet_44_39);
  meshes["leaflet-44"] = mesh_leaflet_44_39;
  colliders["leaflet-44"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-44"] ??= [];
  destructionGroups["leaflet-44"].push(node_leaflet_44_39);

  const endpoint_rachis_9_40 = makeAttachmentEndpoint(null);
  const node_rachis_9_40 = new THREE.Group();
  node_rachis_9_40.name = "Compound leaf 10 rachis__pivot";
  node_rachis_9_40.scale.set(1, 1, 1);
  if (endpoint_rachis_9_40) {
    node_rachis_9_40.position.copy(endpoint_rachis_9_40.start);
    node_rachis_9_40.rotation.set(0.0, 4.3633, 0.0);
  } else {
    node_rachis_9_40.position.set(-0.3524, 0.545, 0.1283);
    node_rachis_9_40.rotation.set(0.0, 4.3633, 0.0);
  }
  node_rachis_9_40.userData.sculptComponent = {"id": "rachis-9", "name": "Compound leaf 10 rachis", "level": "meso", "role": "leaf", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Arching rachis of a pinnate compound leaf.", "geometryDescriptor": {"topologyIntent": "Arching rachis of a pinnate compound leaf. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.068, 0.0503, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.136, 0.0789, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.204, 0.0857, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.272, 0.0707, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.34, 0.034, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "branch-0", "attachment": {"parentId": "branch-0", "parentSocket": "branch-0:node", "localStart": [-0.3524, 0.545, 0.1283], "localEnd": [-0.4687, 0.579, 0.4478], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.3524, 0.545, 0.1283], "rotation": [0, 4.3633, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-9", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pinnate", "kind": "contour", "description": "terminal leaflet + 2 opposite pairs", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_rachis_9_40.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-9", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["branch-0"] ?? root).add(node_rachis_9_40);
  nodes["rachis-9"] = node_rachis_9_40;
  const mesh_rachis_9_40Geometry = endpoint_rachis_9_40
    ? new THREE.CylinderGeometry(endpoint_rachis_9_40.endRadius, endpoint_rachis_9_40.baseRadius, endpoint_rachis_9_40.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.068, 0.0503, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.136, 0.0789, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.204, 0.0857, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.272, 0.0707, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.34, 0.034, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true});
  if (!endpoint_rachis_9_40) {
    mesh_rachis_9_40Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rachis_9_40 = new THREE.Mesh(
    mesh_rachis_9_40Geometry,
    materialMap["stem"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rachis_9_40.name = "Compound leaf 10 rachis";
  if (endpoint_rachis_9_40) {
    mesh_rachis_9_40.position.copy(endpoint_rachis_9_40.midpoint);
    mesh_rachis_9_40.quaternion.copy(endpoint_rachis_9_40.quaternion);
  }
  mesh_rachis_9_40.castShadow = options.castShadow ?? true;
  mesh_rachis_9_40.receiveShadow = options.receiveShadow ?? true;
  mesh_rachis_9_40.userData.sculptComponent = {"id": "rachis-9", "name": "Compound leaf 10 rachis", "level": "meso", "role": "leaf", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Arching rachis of a pinnate compound leaf.", "geometryDescriptor": {"topologyIntent": "Arching rachis of a pinnate compound leaf. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.068, 0.0503, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.136, 0.0789, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.204, 0.0857, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.272, 0.0707, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.34, 0.034, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "branch-0", "attachment": {"parentId": "branch-0", "parentSocket": "branch-0:node", "localStart": [-0.3524, 0.545, 0.1283], "localEnd": [-0.4687, 0.579, 0.4478], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.3524, 0.545, 0.1283], "rotation": [0, 4.3633, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-9", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pinnate", "kind": "contour", "description": "terminal leaflet + 2 opposite pairs", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_rachis_9_40.add(mesh_rachis_9_40);
  meshes["rachis-9"] = mesh_rachis_9_40;
  colliders["rachis-9"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["rachis-9"] ??= [];
  destructionGroups["rachis-9"].push(node_rachis_9_40);

  const endpoint_leaflet_47_41 = makeAttachmentEndpoint(null);
  const node_leaflet_47_41 = new THREE.Group();
  node_leaflet_47_41.name = "Leaf 10 leaflet 3__pivot";
  node_leaflet_47_41.scale.set(1, 1, 1);
  if (endpoint_leaflet_47_41) {
    node_leaflet_47_41.position.copy(endpoint_leaflet_47_41.start);
    node_leaflet_47_41.rotation.set(0.0, -1.2217, 0.0);
  } else {
    node_leaflet_47_41.position.set(0.272, 0.0707, 0.0);
    node_leaflet_47_41.rotation.set(0.0, -1.2217, 0.0);
  }
  node_leaflet_47_41.userData.sculptComponent = {"id": "leaflet-47", "name": "Leaf 10 leaflet 3", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0248, 0.0071, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0518, 0.013, 0.0], "rx": 0.0389, "rz": 0.012, "twist": -30}, {"position": [0.1048, 0.0042, 0.0], "rx": 0.0751, "rz": 0.0209, "twist": -30}, {"position": [0.1578, -0.0317, 0.0], "rx": 0.0548, "rz": 0.0151, "twist": -30}, {"position": [0.2108, -0.0949, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-9", "attachment": {"parentId": "rachis-9", "parentSocket": "rachis-9:node", "localStart": [0.272, 0.0707, 0.0], "localEnd": [0.3441, -0.0242, 0.1981], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.272, 0.0707, 0.0], "rotation": [0, -1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-47", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_47_41.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-47", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-9"] ?? root).add(node_leaflet_47_41);
  nodes["leaflet-47"] = node_leaflet_47_41;
  const mesh_leaflet_47_41Geometry = endpoint_leaflet_47_41
    ? new THREE.CylinderGeometry(endpoint_leaflet_47_41.endRadius, endpoint_leaflet_47_41.baseRadius, endpoint_leaflet_47_41.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0248, 0.0071, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0518, 0.013, 0.0], "rx": 0.0389, "rz": 0.012, "twist": -30}, {"position": [0.1048, 0.0042, 0.0], "rx": 0.0751, "rz": 0.0209, "twist": -30}, {"position": [0.1578, -0.0317, 0.0], "rx": 0.0548, "rz": 0.0151, "twist": -30}, {"position": [0.2108, -0.0949, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_47_41) {
    mesh_leaflet_47_41Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_47_41 = new THREE.Mesh(
    mesh_leaflet_47_41Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_47_41.name = "Leaf 10 leaflet 3";
  if (endpoint_leaflet_47_41) {
    mesh_leaflet_47_41.position.copy(endpoint_leaflet_47_41.midpoint);
    mesh_leaflet_47_41.quaternion.copy(endpoint_leaflet_47_41.quaternion);
  }
  mesh_leaflet_47_41.castShadow = options.castShadow ?? true;
  mesh_leaflet_47_41.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_47_41.userData.sculptComponent = {"id": "leaflet-47", "name": "Leaf 10 leaflet 3", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0248, 0.0071, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0518, 0.013, 0.0], "rx": 0.0389, "rz": 0.012, "twist": -30}, {"position": [0.1048, 0.0042, 0.0], "rx": 0.0751, "rz": 0.0209, "twist": -30}, {"position": [0.1578, -0.0317, 0.0], "rx": 0.0548, "rz": 0.0151, "twist": -30}, {"position": [0.2108, -0.0949, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-9", "attachment": {"parentId": "rachis-9", "parentSocket": "rachis-9:node", "localStart": [0.272, 0.0707, 0.0], "localEnd": [0.3441, -0.0242, 0.1981], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.272, 0.0707, 0.0], "rotation": [0, -1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-47", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_47_41.add(mesh_leaflet_47_41);
  meshes["leaflet-47"] = mesh_leaflet_47_41;
  colliders["leaflet-47"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-47"] ??= [];
  destructionGroups["leaflet-47"].push(node_leaflet_47_41);

  const endpoint_leaflet_48_42 = makeAttachmentEndpoint(null);
  const node_leaflet_48_42 = new THREE.Group();
  node_leaflet_48_42.name = "Leaf 10 leaflet 4__pivot";
  node_leaflet_48_42.scale.set(1, 1, 1);
  if (endpoint_leaflet_48_42) {
    node_leaflet_48_42.position.copy(endpoint_leaflet_48_42.start);
    node_leaflet_48_42.rotation.set(0.0, 1.2217, 0.0);
  } else {
    node_leaflet_48_42.position.set(0.272, 0.0707, 0.0);
    node_leaflet_48_42.rotation.set(0.0, 1.2217, 0.0);
  }
  node_leaflet_48_42.userData.sculptComponent = {"id": "leaflet-48", "name": "Leaf 10 leaflet 4", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0248, 0.0071, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0518, 0.013, 0.0], "rx": 0.0389, "rz": 0.012, "twist": 30}, {"position": [0.1048, 0.0042, 0.0], "rx": 0.0751, "rz": 0.0209, "twist": 30}, {"position": [0.1578, -0.0317, 0.0], "rx": 0.0548, "rz": 0.0151, "twist": 30}, {"position": [0.2108, -0.0949, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-9", "attachment": {"parentId": "rachis-9", "parentSocket": "rachis-9:node", "localStart": [0.272, 0.0707, 0.0], "localEnd": [0.3441, -0.0242, -0.1981], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.272, 0.0707, 0.0], "rotation": [0, 1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-48", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_48_42.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-48", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-9"] ?? root).add(node_leaflet_48_42);
  nodes["leaflet-48"] = node_leaflet_48_42;
  const mesh_leaflet_48_42Geometry = endpoint_leaflet_48_42
    ? new THREE.CylinderGeometry(endpoint_leaflet_48_42.endRadius, endpoint_leaflet_48_42.baseRadius, endpoint_leaflet_48_42.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0248, 0.0071, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0518, 0.013, 0.0], "rx": 0.0389, "rz": 0.012, "twist": 30}, {"position": [0.1048, 0.0042, 0.0], "rx": 0.0751, "rz": 0.0209, "twist": 30}, {"position": [0.1578, -0.0317, 0.0], "rx": 0.0548, "rz": 0.0151, "twist": 30}, {"position": [0.2108, -0.0949, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_48_42) {
    mesh_leaflet_48_42Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_48_42 = new THREE.Mesh(
    mesh_leaflet_48_42Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_48_42.name = "Leaf 10 leaflet 4";
  if (endpoint_leaflet_48_42) {
    mesh_leaflet_48_42.position.copy(endpoint_leaflet_48_42.midpoint);
    mesh_leaflet_48_42.quaternion.copy(endpoint_leaflet_48_42.quaternion);
  }
  mesh_leaflet_48_42.castShadow = options.castShadow ?? true;
  mesh_leaflet_48_42.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_48_42.userData.sculptComponent = {"id": "leaflet-48", "name": "Leaf 10 leaflet 4", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0248, 0.0071, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0518, 0.013, 0.0], "rx": 0.0389, "rz": 0.012, "twist": 30}, {"position": [0.1048, 0.0042, 0.0], "rx": 0.0751, "rz": 0.0209, "twist": 30}, {"position": [0.1578, -0.0317, 0.0], "rx": 0.0548, "rz": 0.0151, "twist": 30}, {"position": [0.2108, -0.0949, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-9", "attachment": {"parentId": "rachis-9", "parentSocket": "rachis-9:node", "localStart": [0.272, 0.0707, 0.0], "localEnd": [0.3441, -0.0242, -0.1981], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.272, 0.0707, 0.0], "rotation": [0, 1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-48", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_48_42.add(mesh_leaflet_48_42);
  meshes["leaflet-48"] = mesh_leaflet_48_42;
  colliders["leaflet-48"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-48"] ??= [];
  destructionGroups["leaflet-48"].push(node_leaflet_48_42);

  const endpoint_leaflet_49_43 = makeAttachmentEndpoint(null);
  const node_leaflet_49_43 = new THREE.Group();
  node_leaflet_49_43.name = "Leaf 10 leaflet 5__pivot";
  node_leaflet_49_43.scale.set(1, 1, 1);
  if (endpoint_leaflet_49_43) {
    node_leaflet_49_43.position.copy(endpoint_leaflet_49_43.start);
    node_leaflet_49_43.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leaflet_49_43.position.set(0.34, 0.034, 0.0);
    node_leaflet_49_43.rotation.set(0.0, 0.0, 0.0);
  }
  node_leaflet_49_43.userData.sculptComponent = {"id": "leaflet-49", "name": "Leaf 10 leaflet 5", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0288, 0.0082, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0602, 0.015, 0.0], "rx": 0.0452, "rz": 0.0126, "twist": 0}, {"position": [0.1217, 0.0049, 0.0], "rx": 0.0872, "rz": 0.0241, "twist": 0}, {"position": [0.1833, -0.0368, 0.0], "rx": 0.0637, "rz": 0.0176, "twist": 0}, {"position": [0.2448, -0.1103, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-9", "attachment": {"parentId": "rachis-9", "parentSocket": "rachis-9:node", "localStart": [0.34, 0.034, 0.0], "localEnd": [0.5848, -0.0763, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.34, 0.034, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-49", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_49_43.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-49", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-9"] ?? root).add(node_leaflet_49_43);
  nodes["leaflet-49"] = node_leaflet_49_43;
  const mesh_leaflet_49_43Geometry = endpoint_leaflet_49_43
    ? new THREE.CylinderGeometry(endpoint_leaflet_49_43.endRadius, endpoint_leaflet_49_43.baseRadius, endpoint_leaflet_49_43.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0288, 0.0082, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0602, 0.015, 0.0], "rx": 0.0452, "rz": 0.0126, "twist": 0}, {"position": [0.1217, 0.0049, 0.0], "rx": 0.0872, "rz": 0.0241, "twist": 0}, {"position": [0.1833, -0.0368, 0.0], "rx": 0.0637, "rz": 0.0176, "twist": 0}, {"position": [0.2448, -0.1103, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_49_43) {
    mesh_leaflet_49_43Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_49_43 = new THREE.Mesh(
    mesh_leaflet_49_43Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_49_43.name = "Leaf 10 leaflet 5";
  if (endpoint_leaflet_49_43) {
    mesh_leaflet_49_43.position.copy(endpoint_leaflet_49_43.midpoint);
    mesh_leaflet_49_43.quaternion.copy(endpoint_leaflet_49_43.quaternion);
  }
  mesh_leaflet_49_43.castShadow = options.castShadow ?? true;
  mesh_leaflet_49_43.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_49_43.userData.sculptComponent = {"id": "leaflet-49", "name": "Leaf 10 leaflet 5", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0288, 0.0082, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0602, 0.015, 0.0], "rx": 0.0452, "rz": 0.0126, "twist": 0}, {"position": [0.1217, 0.0049, 0.0], "rx": 0.0872, "rz": 0.0241, "twist": 0}, {"position": [0.1833, -0.0368, 0.0], "rx": 0.0637, "rz": 0.0176, "twist": 0}, {"position": [0.2448, -0.1103, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-9", "attachment": {"parentId": "rachis-9", "parentSocket": "rachis-9:node", "localStart": [0.34, 0.034, 0.0], "localEnd": [0.5848, -0.0763, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.34, 0.034, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-49", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_49_43.add(mesh_leaflet_49_43);
  meshes["leaflet-49"] = mesh_leaflet_49_43;
  colliders["leaflet-49"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-49"] ??= [];
  destructionGroups["leaflet-49"].push(node_leaflet_49_43);

  const endpoint_rachis_10_44 = makeAttachmentEndpoint(null);
  const node_rachis_10_44 = new THREE.Group();
  node_rachis_10_44.name = "Compound leaf 11 rachis__pivot";
  node_rachis_10_44.scale.set(1, 1, 1);
  if (endpoint_rachis_10_44) {
    node_rachis_10_44.position.copy(endpoint_rachis_10_44.start);
    node_rachis_10_44.rotation.set(0.0, 0.3491, 0.0);
  } else {
    node_rachis_10_44.position.set(0.3171, 0.6325, -0.1154);
    node_rachis_10_44.rotation.set(0.0, 0.3491, 0.0);
  }
  node_rachis_10_44.userData.sculptComponent = {"id": "rachis-10", "name": "Compound leaf 11 rachis", "level": "meso", "role": "leaf", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Arching rachis of a pinnate compound leaf.", "geometryDescriptor": {"topologyIntent": "Arching rachis of a pinnate compound leaf. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.076, 0.0562, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.152, 0.0882, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.228, 0.0958, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.304, 0.079, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.38, 0.038, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "branch-1", "attachment": {"parentId": "branch-1", "parentSocket": "branch-1:node", "localStart": [0.3171, 0.6325, -0.1154], "localEnd": [0.6742, 0.6705, -0.2454], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.3171, 0.6325, -0.1154], "rotation": [0, 0.3491, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-10", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pinnate", "kind": "contour", "description": "terminal leaflet + 2 opposite pairs", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_rachis_10_44.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-10", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["branch-1"] ?? root).add(node_rachis_10_44);
  nodes["rachis-10"] = node_rachis_10_44;
  const mesh_rachis_10_44Geometry = endpoint_rachis_10_44
    ? new THREE.CylinderGeometry(endpoint_rachis_10_44.endRadius, endpoint_rachis_10_44.baseRadius, endpoint_rachis_10_44.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.076, 0.0562, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.152, 0.0882, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.228, 0.0958, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.304, 0.079, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.38, 0.038, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true});
  if (!endpoint_rachis_10_44) {
    mesh_rachis_10_44Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rachis_10_44 = new THREE.Mesh(
    mesh_rachis_10_44Geometry,
    materialMap["stem"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rachis_10_44.name = "Compound leaf 11 rachis";
  if (endpoint_rachis_10_44) {
    mesh_rachis_10_44.position.copy(endpoint_rachis_10_44.midpoint);
    mesh_rachis_10_44.quaternion.copy(endpoint_rachis_10_44.quaternion);
  }
  mesh_rachis_10_44.castShadow = options.castShadow ?? true;
  mesh_rachis_10_44.receiveShadow = options.receiveShadow ?? true;
  mesh_rachis_10_44.userData.sculptComponent = {"id": "rachis-10", "name": "Compound leaf 11 rachis", "level": "meso", "role": "leaf", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Arching rachis of a pinnate compound leaf.", "geometryDescriptor": {"topologyIntent": "Arching rachis of a pinnate compound leaf. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.076, 0.0562, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.152, 0.0882, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.228, 0.0958, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.304, 0.079, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.38, 0.038, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "branch-1", "attachment": {"parentId": "branch-1", "parentSocket": "branch-1:node", "localStart": [0.3171, 0.6325, -0.1154], "localEnd": [0.6742, 0.6705, -0.2454], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.3171, 0.6325, -0.1154], "rotation": [0, 0.3491, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-10", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pinnate", "kind": "contour", "description": "terminal leaflet + 2 opposite pairs", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_rachis_10_44.add(mesh_rachis_10_44);
  meshes["rachis-10"] = mesh_rachis_10_44;
  colliders["rachis-10"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["rachis-10"] ??= [];
  destructionGroups["rachis-10"].push(node_rachis_10_44);

  const endpoint_leaflet_52_45 = makeAttachmentEndpoint(null);
  const node_leaflet_52_45 = new THREE.Group();
  node_leaflet_52_45.name = "Leaf 11 leaflet 3__pivot";
  node_leaflet_52_45.scale.set(1, 1, 1);
  if (endpoint_leaflet_52_45) {
    node_leaflet_52_45.position.copy(endpoint_leaflet_52_45.start);
    node_leaflet_52_45.rotation.set(0.0, -1.2217, 0.0);
  } else {
    node_leaflet_52_45.position.set(0.304, 0.079, 0.0);
    node_leaflet_52_45.rotation.set(0.0, -1.2217, 0.0);
  }
  node_leaflet_52_45.userData.sculptComponent = {"id": "leaflet-52", "name": "Leaf 11 leaflet 3", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0277, 0.0079, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0579, 0.0145, 0.0], "rx": 0.0435, "rz": 0.0121, "twist": -30}, {"position": [0.1171, 0.0047, 0.0], "rx": 0.084, "rz": 0.0232, "twist": -30}, {"position": [0.1764, -0.0355, 0.0], "rx": 0.0613, "rz": 0.0169, "twist": -30}, {"position": [0.2356, -0.1061, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-10", "attachment": {"parentId": "rachis-10", "parentSocket": "rachis-10:node", "localStart": [0.304, 0.079, 0.0], "localEnd": [0.3846, -0.0271, 0.2214], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.304, 0.079, 0.0], "rotation": [0, -1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-52", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_52_45.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-52", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-10"] ?? root).add(node_leaflet_52_45);
  nodes["leaflet-52"] = node_leaflet_52_45;
  const mesh_leaflet_52_45Geometry = endpoint_leaflet_52_45
    ? new THREE.CylinderGeometry(endpoint_leaflet_52_45.endRadius, endpoint_leaflet_52_45.baseRadius, endpoint_leaflet_52_45.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0277, 0.0079, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0579, 0.0145, 0.0], "rx": 0.0435, "rz": 0.0121, "twist": -30}, {"position": [0.1171, 0.0047, 0.0], "rx": 0.084, "rz": 0.0232, "twist": -30}, {"position": [0.1764, -0.0355, 0.0], "rx": 0.0613, "rz": 0.0169, "twist": -30}, {"position": [0.2356, -0.1061, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_52_45) {
    mesh_leaflet_52_45Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_52_45 = new THREE.Mesh(
    mesh_leaflet_52_45Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_52_45.name = "Leaf 11 leaflet 3";
  if (endpoint_leaflet_52_45) {
    mesh_leaflet_52_45.position.copy(endpoint_leaflet_52_45.midpoint);
    mesh_leaflet_52_45.quaternion.copy(endpoint_leaflet_52_45.quaternion);
  }
  mesh_leaflet_52_45.castShadow = options.castShadow ?? true;
  mesh_leaflet_52_45.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_52_45.userData.sculptComponent = {"id": "leaflet-52", "name": "Leaf 11 leaflet 3", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0277, 0.0079, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0579, 0.0145, 0.0], "rx": 0.0435, "rz": 0.0121, "twist": -30}, {"position": [0.1171, 0.0047, 0.0], "rx": 0.084, "rz": 0.0232, "twist": -30}, {"position": [0.1764, -0.0355, 0.0], "rx": 0.0613, "rz": 0.0169, "twist": -30}, {"position": [0.2356, -0.1061, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-10", "attachment": {"parentId": "rachis-10", "parentSocket": "rachis-10:node", "localStart": [0.304, 0.079, 0.0], "localEnd": [0.3846, -0.0271, 0.2214], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.304, 0.079, 0.0], "rotation": [0, -1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-52", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_52_45.add(mesh_leaflet_52_45);
  meshes["leaflet-52"] = mesh_leaflet_52_45;
  colliders["leaflet-52"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-52"] ??= [];
  destructionGroups["leaflet-52"].push(node_leaflet_52_45);

  const endpoint_leaflet_53_46 = makeAttachmentEndpoint(null);
  const node_leaflet_53_46 = new THREE.Group();
  node_leaflet_53_46.name = "Leaf 11 leaflet 4__pivot";
  node_leaflet_53_46.scale.set(1, 1, 1);
  if (endpoint_leaflet_53_46) {
    node_leaflet_53_46.position.copy(endpoint_leaflet_53_46.start);
    node_leaflet_53_46.rotation.set(0.0, 1.2217, 0.0);
  } else {
    node_leaflet_53_46.position.set(0.304, 0.079, 0.0);
    node_leaflet_53_46.rotation.set(0.0, 1.2217, 0.0);
  }
  node_leaflet_53_46.userData.sculptComponent = {"id": "leaflet-53", "name": "Leaf 11 leaflet 4", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0277, 0.0079, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0579, 0.0145, 0.0], "rx": 0.0435, "rz": 0.0121, "twist": 30}, {"position": [0.1171, 0.0047, 0.0], "rx": 0.084, "rz": 0.0232, "twist": 30}, {"position": [0.1764, -0.0355, 0.0], "rx": 0.0613, "rz": 0.0169, "twist": 30}, {"position": [0.2356, -0.1061, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-10", "attachment": {"parentId": "rachis-10", "parentSocket": "rachis-10:node", "localStart": [0.304, 0.079, 0.0], "localEnd": [0.3846, -0.0271, -0.2214], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.304, 0.079, 0.0], "rotation": [0, 1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-53", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_53_46.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-53", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-10"] ?? root).add(node_leaflet_53_46);
  nodes["leaflet-53"] = node_leaflet_53_46;
  const mesh_leaflet_53_46Geometry = endpoint_leaflet_53_46
    ? new THREE.CylinderGeometry(endpoint_leaflet_53_46.endRadius, endpoint_leaflet_53_46.baseRadius, endpoint_leaflet_53_46.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0277, 0.0079, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0579, 0.0145, 0.0], "rx": 0.0435, "rz": 0.0121, "twist": 30}, {"position": [0.1171, 0.0047, 0.0], "rx": 0.084, "rz": 0.0232, "twist": 30}, {"position": [0.1764, -0.0355, 0.0], "rx": 0.0613, "rz": 0.0169, "twist": 30}, {"position": [0.2356, -0.1061, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_53_46) {
    mesh_leaflet_53_46Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_53_46 = new THREE.Mesh(
    mesh_leaflet_53_46Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_53_46.name = "Leaf 11 leaflet 4";
  if (endpoint_leaflet_53_46) {
    mesh_leaflet_53_46.position.copy(endpoint_leaflet_53_46.midpoint);
    mesh_leaflet_53_46.quaternion.copy(endpoint_leaflet_53_46.quaternion);
  }
  mesh_leaflet_53_46.castShadow = options.castShadow ?? true;
  mesh_leaflet_53_46.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_53_46.userData.sculptComponent = {"id": "leaflet-53", "name": "Leaf 11 leaflet 4", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0277, 0.0079, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0579, 0.0145, 0.0], "rx": 0.0435, "rz": 0.0121, "twist": 30}, {"position": [0.1171, 0.0047, 0.0], "rx": 0.084, "rz": 0.0232, "twist": 30}, {"position": [0.1764, -0.0355, 0.0], "rx": 0.0613, "rz": 0.0169, "twist": 30}, {"position": [0.2356, -0.1061, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-10", "attachment": {"parentId": "rachis-10", "parentSocket": "rachis-10:node", "localStart": [0.304, 0.079, 0.0], "localEnd": [0.3846, -0.0271, -0.2214], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.304, 0.079, 0.0], "rotation": [0, 1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-53", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_53_46.add(mesh_leaflet_53_46);
  meshes["leaflet-53"] = mesh_leaflet_53_46;
  colliders["leaflet-53"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-53"] ??= [];
  destructionGroups["leaflet-53"].push(node_leaflet_53_46);

  const endpoint_leaflet_54_47 = makeAttachmentEndpoint(null);
  const node_leaflet_54_47 = new THREE.Group();
  node_leaflet_54_47.name = "Leaf 11 leaflet 5__pivot";
  node_leaflet_54_47.scale.set(1, 1, 1);
  if (endpoint_leaflet_54_47) {
    node_leaflet_54_47.position.copy(endpoint_leaflet_54_47.start);
    node_leaflet_54_47.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leaflet_54_47.position.set(0.38, 0.038, 0.0);
    node_leaflet_54_47.rotation.set(0.0, 0.0, 0.0);
  }
  node_leaflet_54_47.userData.sculptComponent = {"id": "leaflet-54", "name": "Leaf 11 leaflet 5", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0322, 0.0092, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0672, 0.0168, 0.0], "rx": 0.0505, "rz": 0.014, "twist": 0}, {"position": [0.136, 0.0055, 0.0], "rx": 0.0975, "rz": 0.027, "twist": 0}, {"position": [0.2048, -0.0412, 0.0], "rx": 0.0711, "rz": 0.0198, "twist": 0}, {"position": [0.2736, -0.1232, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-10", "attachment": {"parentId": "rachis-10", "parentSocket": "rachis-10:node", "localStart": [0.38, 0.038, 0.0], "localEnd": [0.6536, -0.0852, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.38, 0.038, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-54", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_54_47.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-54", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-10"] ?? root).add(node_leaflet_54_47);
  nodes["leaflet-54"] = node_leaflet_54_47;
  const mesh_leaflet_54_47Geometry = endpoint_leaflet_54_47
    ? new THREE.CylinderGeometry(endpoint_leaflet_54_47.endRadius, endpoint_leaflet_54_47.baseRadius, endpoint_leaflet_54_47.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0322, 0.0092, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0672, 0.0168, 0.0], "rx": 0.0505, "rz": 0.014, "twist": 0}, {"position": [0.136, 0.0055, 0.0], "rx": 0.0975, "rz": 0.027, "twist": 0}, {"position": [0.2048, -0.0412, 0.0], "rx": 0.0711, "rz": 0.0198, "twist": 0}, {"position": [0.2736, -0.1232, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_54_47) {
    mesh_leaflet_54_47Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_54_47 = new THREE.Mesh(
    mesh_leaflet_54_47Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_54_47.name = "Leaf 11 leaflet 5";
  if (endpoint_leaflet_54_47) {
    mesh_leaflet_54_47.position.copy(endpoint_leaflet_54_47.midpoint);
    mesh_leaflet_54_47.quaternion.copy(endpoint_leaflet_54_47.quaternion);
  }
  mesh_leaflet_54_47.castShadow = options.castShadow ?? true;
  mesh_leaflet_54_47.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_54_47.userData.sculptComponent = {"id": "leaflet-54", "name": "Leaf 11 leaflet 5", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0322, 0.0092, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0672, 0.0168, 0.0], "rx": 0.0505, "rz": 0.014, "twist": 0}, {"position": [0.136, 0.0055, 0.0], "rx": 0.0975, "rz": 0.027, "twist": 0}, {"position": [0.2048, -0.0412, 0.0], "rx": 0.0711, "rz": 0.0198, "twist": 0}, {"position": [0.2736, -0.1232, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-10", "attachment": {"parentId": "rachis-10", "parentSocket": "rachis-10:node", "localStart": [0.38, 0.038, 0.0], "localEnd": [0.6536, -0.0852, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.38, 0.038, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-54", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_54_47.add(mesh_leaflet_54_47);
  meshes["leaflet-54"] = mesh_leaflet_54_47;
  colliders["leaflet-54"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-54"] ??= [];
  destructionGroups["leaflet-54"].push(node_leaflet_54_47);

  const endpoint_rachis_11_48 = makeAttachmentEndpoint(null);
  const node_rachis_11_48 = new THREE.Group();
  node_rachis_11_48.name = "Compound leaf 12 rachis__pivot";
  node_rachis_11_48.scale.set(1, 1, 1);
  if (endpoint_rachis_11_48) {
    node_rachis_11_48.position.copy(endpoint_rachis_11_48.start);
    node_rachis_11_48.rotation.set(0.0, 5.7596, 0.0);
  } else {
    node_rachis_11_48.position.set(0.3171, 0.6325, -0.1154);
    node_rachis_11_48.rotation.set(0.0, 5.7596, 0.0);
  }
  node_rachis_11_48.userData.sculptComponent = {"id": "rachis-11", "name": "Compound leaf 12 rachis", "level": "meso", "role": "leaf", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Arching rachis of a pinnate compound leaf.", "geometryDescriptor": {"topologyIntent": "Arching rachis of a pinnate compound leaf. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.064, 0.0474, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.128, 0.0742, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.192, 0.0806, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.256, 0.0666, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.32, 0.032, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "branch-1", "attachment": {"parentId": "branch-1", "parentSocket": "branch-1:node", "localStart": [0.3171, 0.6325, -0.1154], "localEnd": [0.5942, 0.6645, 0.0446], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.3171, 0.6325, -0.1154], "rotation": [0, 5.7596, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-11", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pinnate", "kind": "contour", "description": "terminal leaflet + 2 opposite pairs", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_rachis_11_48.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-11", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["branch-1"] ?? root).add(node_rachis_11_48);
  nodes["rachis-11"] = node_rachis_11_48;
  const mesh_rachis_11_48Geometry = endpoint_rachis_11_48
    ? new THREE.CylinderGeometry(endpoint_rachis_11_48.endRadius, endpoint_rachis_11_48.baseRadius, endpoint_rachis_11_48.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.064, 0.0474, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.128, 0.0742, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.192, 0.0806, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.256, 0.0666, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.32, 0.032, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true});
  if (!endpoint_rachis_11_48) {
    mesh_rachis_11_48Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_rachis_11_48 = new THREE.Mesh(
    mesh_rachis_11_48Geometry,
    materialMap["stem"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_rachis_11_48.name = "Compound leaf 12 rachis";
  if (endpoint_rachis_11_48) {
    mesh_rachis_11_48.position.copy(endpoint_rachis_11_48.midpoint);
    mesh_rachis_11_48.quaternion.copy(endpoint_rachis_11_48.quaternion);
  }
  mesh_rachis_11_48.castShadow = options.castShadow ?? true;
  mesh_rachis_11_48.receiveShadow = options.receiveShadow ?? true;
  mesh_rachis_11_48.userData.sculptComponent = {"id": "rachis-11", "name": "Compound leaf 12 rachis", "level": "meso", "role": "leaf", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Arching rachis of a pinnate compound leaf.", "geometryDescriptor": {"topologyIntent": "Arching rachis of a pinnate compound leaf. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.007, "rz": 0.007, "twist": 0}, {"position": [0.064, 0.0474, 0.0], "rx": 0.005833333333333334, "rz": 0.005833333333333334, "twist": 0}, {"position": [0.128, 0.0742, 0.0], "rx": 0.004666666666666667, "rz": 0.004666666666666667, "twist": 0}, {"position": [0.192, 0.0806, 0.0], "rx": 0.0035, "rz": 0.0035, "twist": 0}, {"position": [0.256, 0.0666, 0.0], "rx": 0.0023333333333333335, "rz": 0.0023333333333333335, "twist": 0}, {"position": [0.32, 0.032, 0.0], "rx": 0.0011666666666666663, "rz": 0.0011666666666666663, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "branch-1", "attachment": {"parentId": "branch-1", "parentSocket": "branch-1:node", "localStart": [0.3171, 0.6325, -0.1154], "localEnd": [0.5942, 0.6645, 0.0446], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.3171, 0.6325, -0.1154], "rotation": [0, 5.7596, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "rachis-11", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "pinnate", "kind": "contour", "description": "terminal leaflet + 2 opposite pairs", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_rachis_11_48.add(mesh_rachis_11_48);
  meshes["rachis-11"] = mesh_rachis_11_48;
  colliders["rachis-11"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["rachis-11"] ??= [];
  destructionGroups["rachis-11"].push(node_rachis_11_48);

  const endpoint_leaflet_57_49 = makeAttachmentEndpoint(null);
  const node_leaflet_57_49 = new THREE.Group();
  node_leaflet_57_49.name = "Leaf 12 leaflet 3__pivot";
  node_leaflet_57_49.scale.set(1, 1, 1);
  if (endpoint_leaflet_57_49) {
    node_leaflet_57_49.position.copy(endpoint_leaflet_57_49.start);
    node_leaflet_57_49.rotation.set(0.0, -1.2217, 0.0);
  } else {
    node_leaflet_57_49.position.set(0.256, 0.0666, 0.0);
    node_leaflet_57_49.rotation.set(0.0, -1.2217, 0.0);
  }
  node_leaflet_57_49.userData.sculptComponent = {"id": "leaflet-57", "name": "Leaf 12 leaflet 3", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0233, 0.0067, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0487, 0.0122, 0.0], "rx": 0.0366, "rz": 0.012, "twist": -30}, {"position": [0.0986, 0.004, 0.0], "rx": 0.0707, "rz": 0.0196, "twist": -30}, {"position": [0.1485, -0.0299, 0.0], "rx": 0.0516, "rz": 0.0144, "twist": -30}, {"position": [0.1984, -0.0894, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-11", "attachment": {"parentId": "rachis-11", "parentSocket": "rachis-11:node", "localStart": [0.256, 0.0666, 0.0], "localEnd": [0.3239, -0.0228, 0.1864], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.256, 0.0666, 0.0], "rotation": [0, -1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-57", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_57_49.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-57", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-11"] ?? root).add(node_leaflet_57_49);
  nodes["leaflet-57"] = node_leaflet_57_49;
  const mesh_leaflet_57_49Geometry = endpoint_leaflet_57_49
    ? new THREE.CylinderGeometry(endpoint_leaflet_57_49.endRadius, endpoint_leaflet_57_49.baseRadius, endpoint_leaflet_57_49.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0233, 0.0067, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0487, 0.0122, 0.0], "rx": 0.0366, "rz": 0.012, "twist": -30}, {"position": [0.0986, 0.004, 0.0], "rx": 0.0707, "rz": 0.0196, "twist": -30}, {"position": [0.1485, -0.0299, 0.0], "rx": 0.0516, "rz": 0.0144, "twist": -30}, {"position": [0.1984, -0.0894, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_57_49) {
    mesh_leaflet_57_49Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_57_49 = new THREE.Mesh(
    mesh_leaflet_57_49Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_57_49.name = "Leaf 12 leaflet 3";
  if (endpoint_leaflet_57_49) {
    mesh_leaflet_57_49.position.copy(endpoint_leaflet_57_49.midpoint);
    mesh_leaflet_57_49.quaternion.copy(endpoint_leaflet_57_49.quaternion);
  }
  mesh_leaflet_57_49.castShadow = options.castShadow ?? true;
  mesh_leaflet_57_49.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_57_49.userData.sculptComponent = {"id": "leaflet-57", "name": "Leaf 12 leaflet 3", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0233, 0.0067, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0487, 0.0122, 0.0], "rx": 0.0366, "rz": 0.012, "twist": -30}, {"position": [0.0986, 0.004, 0.0], "rx": 0.0707, "rz": 0.0196, "twist": -30}, {"position": [0.1485, -0.0299, 0.0], "rx": 0.0516, "rz": 0.0144, "twist": -30}, {"position": [0.1984, -0.0894, 0.0], "rx": 0.0, "rz": 0.0, "twist": -30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-11", "attachment": {"parentId": "rachis-11", "parentSocket": "rachis-11:node", "localStart": [0.256, 0.0666, 0.0], "localEnd": [0.3239, -0.0228, 0.1864], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.256, 0.0666, 0.0], "rotation": [0, -1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-57", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_57_49.add(mesh_leaflet_57_49);
  meshes["leaflet-57"] = mesh_leaflet_57_49;
  colliders["leaflet-57"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-57"] ??= [];
  destructionGroups["leaflet-57"].push(node_leaflet_57_49);

  const endpoint_leaflet_58_50 = makeAttachmentEndpoint(null);
  const node_leaflet_58_50 = new THREE.Group();
  node_leaflet_58_50.name = "Leaf 12 leaflet 4__pivot";
  node_leaflet_58_50.scale.set(1, 1, 1);
  if (endpoint_leaflet_58_50) {
    node_leaflet_58_50.position.copy(endpoint_leaflet_58_50.start);
    node_leaflet_58_50.rotation.set(0.0, 1.2217, 0.0);
  } else {
    node_leaflet_58_50.position.set(0.256, 0.0666, 0.0);
    node_leaflet_58_50.rotation.set(0.0, 1.2217, 0.0);
  }
  node_leaflet_58_50.userData.sculptComponent = {"id": "leaflet-58", "name": "Leaf 12 leaflet 4", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0233, 0.0067, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0487, 0.0122, 0.0], "rx": 0.0366, "rz": 0.012, "twist": 30}, {"position": [0.0986, 0.004, 0.0], "rx": 0.0707, "rz": 0.0196, "twist": 30}, {"position": [0.1485, -0.0299, 0.0], "rx": 0.0516, "rz": 0.0144, "twist": 30}, {"position": [0.1984, -0.0894, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-11", "attachment": {"parentId": "rachis-11", "parentSocket": "rachis-11:node", "localStart": [0.256, 0.0666, 0.0], "localEnd": [0.3239, -0.0228, -0.1864], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.256, 0.0666, 0.0], "rotation": [0, 1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-58", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_58_50.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-58", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-11"] ?? root).add(node_leaflet_58_50);
  nodes["leaflet-58"] = node_leaflet_58_50;
  const mesh_leaflet_58_50Geometry = endpoint_leaflet_58_50
    ? new THREE.CylinderGeometry(endpoint_leaflet_58_50.endRadius, endpoint_leaflet_58_50.baseRadius, endpoint_leaflet_58_50.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0233, 0.0067, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0487, 0.0122, 0.0], "rx": 0.0366, "rz": 0.012, "twist": 30}, {"position": [0.0986, 0.004, 0.0], "rx": 0.0707, "rz": 0.0196, "twist": 30}, {"position": [0.1485, -0.0299, 0.0], "rx": 0.0516, "rz": 0.0144, "twist": 30}, {"position": [0.1984, -0.0894, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_58_50) {
    mesh_leaflet_58_50Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_58_50 = new THREE.Mesh(
    mesh_leaflet_58_50Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_58_50.name = "Leaf 12 leaflet 4";
  if (endpoint_leaflet_58_50) {
    mesh_leaflet_58_50.position.copy(endpoint_leaflet_58_50.midpoint);
    mesh_leaflet_58_50.quaternion.copy(endpoint_leaflet_58_50.quaternion);
  }
  mesh_leaflet_58_50.castShadow = options.castShadow ?? true;
  mesh_leaflet_58_50.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_58_50.userData.sculptComponent = {"id": "leaflet-58", "name": "Leaf 12 leaflet 4", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0233, 0.0067, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0487, 0.0122, 0.0], "rx": 0.0366, "rz": 0.012, "twist": 30}, {"position": [0.0986, 0.004, 0.0], "rx": 0.0707, "rz": 0.0196, "twist": 30}, {"position": [0.1485, -0.0299, 0.0], "rx": 0.0516, "rz": 0.0144, "twist": 30}, {"position": [0.1984, -0.0894, 0.0], "rx": 0.0, "rz": 0.0, "twist": 30}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-11", "attachment": {"parentId": "rachis-11", "parentSocket": "rachis-11:node", "localStart": [0.256, 0.0666, 0.0], "localEnd": [0.3239, -0.0228, -0.1864], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.256, 0.0666, 0.0], "rotation": [0, 1.2217, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-58", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_58_50.add(mesh_leaflet_58_50);
  meshes["leaflet-58"] = mesh_leaflet_58_50;
  colliders["leaflet-58"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-58"] ??= [];
  destructionGroups["leaflet-58"].push(node_leaflet_58_50);

  const endpoint_leaflet_59_51 = makeAttachmentEndpoint(null);
  const node_leaflet_59_51 = new THREE.Group();
  node_leaflet_59_51.name = "Leaf 12 leaflet 5__pivot";
  node_leaflet_59_51.scale.set(1, 1, 1);
  if (endpoint_leaflet_59_51) {
    node_leaflet_59_51.position.copy(endpoint_leaflet_59_51.start);
    node_leaflet_59_51.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_leaflet_59_51.position.set(0.32, 0.032, 0.0);
    node_leaflet_59_51.rotation.set(0.0, 0.0, 0.0);
  }
  node_leaflet_59_51.userData.sculptComponent = {"id": "leaflet-59", "name": "Leaf 12 leaflet 5", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0271, 0.0077, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0566, 0.0142, 0.0], "rx": 0.0425, "rz": 0.012, "twist": 0}, {"position": [0.1145, 0.0046, 0.0], "rx": 0.0821, "rz": 0.0227, "twist": 0}, {"position": [0.1725, -0.0347, 0.0], "rx": 0.0599, "rz": 0.0166, "twist": 0}, {"position": [0.2304, -0.1038, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-11", "attachment": {"parentId": "rachis-11", "parentSocket": "rachis-11:node", "localStart": [0.32, 0.032, 0.0], "localEnd": [0.5504, -0.0718, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.32, 0.032, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-59", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_59_51.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-59", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["rachis-11"] ?? root).add(node_leaflet_59_51);
  nodes["leaflet-59"] = node_leaflet_59_51;
  const mesh_leaflet_59_51Geometry = endpoint_leaflet_59_51
    ? new THREE.CylinderGeometry(endpoint_leaflet_59_51.endRadius, endpoint_leaflet_59_51.baseRadius, endpoint_leaflet_59_51.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0271, 0.0077, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0566, 0.0142, 0.0], "rx": 0.0425, "rz": 0.012, "twist": 0}, {"position": [0.1145, 0.0046, 0.0], "rx": 0.0821, "rz": 0.0227, "twist": 0}, {"position": [0.1725, -0.0347, 0.0], "rx": 0.0599, "rz": 0.0166, "twist": 0}, {"position": [0.2304, -0.1038, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_leaflet_59_51) {
    mesh_leaflet_59_51Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_leaflet_59_51 = new THREE.Mesh(
    mesh_leaflet_59_51Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_leaflet_59_51.name = "Leaf 12 leaflet 5";
  if (endpoint_leaflet_59_51) {
    mesh_leaflet_59_51.position.copy(endpoint_leaflet_59_51.midpoint);
    mesh_leaflet_59_51.quaternion.copy(endpoint_leaflet_59_51.quaternion);
  }
  mesh_leaflet_59_51.castShadow = options.castShadow ?? true;
  mesh_leaflet_59_51.receiveShadow = options.receiveShadow ?? true;
  mesh_leaflet_59_51.userData.sculptComponent = {"id": "leaflet-59", "name": "Leaf 12 leaflet 5", "level": "micro", "role": "leaf", "importance": 0.4, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Serrate ovate leaflet on the rachis.", "geometryDescriptor": {"topologyIntent": "Serrate ovate leaflet on the rachis. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.006, "rz": 0.006, "twist": 0}, {"position": [0.0271, 0.0077, 0.0], "rx": 0.0048000000000000004, "rz": 0.0048000000000000004, "twist": 0}, {"position": [0.0566, 0.0142, 0.0], "rx": 0.0425, "rz": 0.012, "twist": 0}, {"position": [0.1145, 0.0046, 0.0], "rx": 0.0821, "rz": 0.0227, "twist": 0}, {"position": [0.1725, -0.0347, 0.0], "rx": 0.0599, "rz": 0.0166, "twist": 0}, {"position": [0.2304, -0.1038, 0.0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 4, "capEnds": false}}, "parent": "rachis-11", "attachment": {"parentId": "rachis-11", "parentSocket": "rachis-11:node", "localStart": [0.32, 0.032, 0.0], "localEnd": [0.5504, -0.0718, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.32, 0.032, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "leaflet-59", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "serrate", "kind": "contour", "description": "serrate margin (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.6, "microRoughness": 0.1, "bumpAmplitude": 0.01, "normalPattern": "rugose leaflet with sunken veins (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "AO where leaflets overlap and at the rachis", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(62, 122, 46, 1.0)", "secondaryAlbedo": "rgba(36, 80, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_leaflet_59_51.add(mesh_leaflet_59_51);
  meshes["leaflet-59"] = mesh_leaflet_59_51;
  colliders["leaflet-59"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["leaflet-59"] ??= [];
  destructionGroups["leaflet-59"].push(node_leaflet_59_51);

  const endpoint_peduncle_0_52 = makeAttachmentEndpoint(null);
  const node_peduncle_0_52 = new THREE.Group();
  node_peduncle_0_52.name = "Truss 1 peduncle__pivot";
  node_peduncle_0_52.scale.set(1, 1, 1);
  if (endpoint_peduncle_0_52) {
    node_peduncle_0_52.position.copy(endpoint_peduncle_0_52.start);
    node_peduncle_0_52.rotation.set(0.0, 5.9341, 0.0);
  } else {
    node_peduncle_0_52.position.set(0.0, 0.42, 0.0);
    node_peduncle_0_52.rotation.set(0.0, 5.9341, 0.0);
  }
  node_peduncle_0_52.userData.sculptComponent = {"id": "peduncle-0", "name": "Truss 1 peduncle", "level": "meso", "role": "stem", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Peduncle carrying a hanging truss.", "geometryDescriptor": {"topologyIntent": "Peduncle carrying a hanging truss. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0, 0, 0], "rx": 0.008, "rz": 0.008, "twist": 0}, {"position": [0.15, 0.0, 0], "rx": 0.008, "rz": 0.008, "twist": 0}, {"position": [0.27, -0.06, 0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.42, 0.0], "localEnd": [0.2537, 0.36, 0.0923], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.42, 0.0], "rotation": [0, 5.9341, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "peduncle-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "truss", "kind": "fastener", "description": "4 fruits per truss", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_peduncle_0_52.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "peduncle-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_peduncle_0_52);
  nodes["peduncle-0"] = node_peduncle_0_52;
  const mesh_peduncle_0_52Geometry = endpoint_peduncle_0_52
    ? new THREE.CylinderGeometry(endpoint_peduncle_0_52.endRadius, endpoint_peduncle_0_52.baseRadius, endpoint_peduncle_0_52.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0, 0, 0], "rx": 0.008, "rz": 0.008, "twist": 0}, {"position": [0.15, 0.0, 0], "rx": 0.008, "rz": 0.008, "twist": 0}, {"position": [0.27, -0.06, 0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 5, "capEnds": true});
  if (!endpoint_peduncle_0_52) {
    mesh_peduncle_0_52Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_peduncle_0_52 = new THREE.Mesh(
    mesh_peduncle_0_52Geometry,
    materialMap["stem"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_peduncle_0_52.name = "Truss 1 peduncle";
  if (endpoint_peduncle_0_52) {
    mesh_peduncle_0_52.position.copy(endpoint_peduncle_0_52.midpoint);
    mesh_peduncle_0_52.quaternion.copy(endpoint_peduncle_0_52.quaternion);
  }
  mesh_peduncle_0_52.castShadow = options.castShadow ?? true;
  mesh_peduncle_0_52.receiveShadow = options.receiveShadow ?? true;
  mesh_peduncle_0_52.userData.sculptComponent = {"id": "peduncle-0", "name": "Truss 1 peduncle", "level": "meso", "role": "stem", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Peduncle carrying a hanging truss.", "geometryDescriptor": {"topologyIntent": "Peduncle carrying a hanging truss. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0, 0, 0], "rx": 0.008, "rz": 0.008, "twist": 0}, {"position": [0.15, 0.0, 0], "rx": 0.008, "rz": 0.008, "twist": 0}, {"position": [0.27, -0.06, 0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.42, 0.0], "localEnd": [0.2537, 0.36, 0.0923], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.42, 0.0], "rotation": [0, 5.9341, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "peduncle-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "truss", "kind": "fastener", "description": "4 fruits per truss", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_peduncle_0_52.add(mesh_peduncle_0_52);
  meshes["peduncle-0"] = mesh_peduncle_0_52;
  colliders["peduncle-0"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["peduncle-0"] ??= [];
  destructionGroups["peduncle-0"].push(node_peduncle_0_52);

  const endpoint_fruit_00_53 = makeAttachmentEndpoint(null);
  const node_fruit_00_53 = new THREE.Group();
  node_fruit_00_53.name = "Truss 1 fruit 1__pivot";
  node_fruit_00_53.scale.set(1, 1, 1);
  if (endpoint_fruit_00_53) {
    node_fruit_00_53.position.copy(endpoint_fruit_00_53.start);
    node_fruit_00_53.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_fruit_00_53.position.set(0.22, -0.1, 0.05);
    node_fruit_00_53.rotation.set(0.0, 0.0, 0.0);
  }
  node_fruit_00_53.userData.sculptComponent = {"id": "fruit-00", "name": "Truss 1 fruit 1", "level": "micro", "role": "fruit", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Glossy round cherry.", "geometryDescriptor": {"topologyIntent": "Glossy round cherry. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "peduncle-0", "attachment": {"parentId": "peduncle-0", "parentSocket": "peduncle-0:node", "localStart": [0.22, -0.042, 0.05], "localEnd": [0.22, -0.158, 0.05], "contactType": "butt", "embedDepth": 0.004, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.116, "height": 0.1102, "depth": 0.116, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.22, -0.1, 0.05], "rotation": [0, 0, 0], "scale": [0.116, 0.1102, 0.116]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-00", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "fruit-ripe", "materialLayers": ["fruit-ripe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ripeness", "kind": "stain", "description": "ripe orange", "evidenceRefs": ["full-object"]}, {"id": "calyx", "kind": "bevel", "description": "calyx star (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.2, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "smooth glossy skin", "displacementPattern": "", "occlusionPattern": "AO between touching fruits and under the calyx", "edgeWearPattern": "", "notes": "clearcoat highlight"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 122, 26, 1.0)", "secondaryAlbedo": "rgba(200, 90, 14, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_fruit_00_53.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-00", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["peduncle-0"] ?? root).add(node_fruit_00_53);
  nodes["fruit-00"] = node_fruit_00_53;
  const mesh_fruit_00_53Geometry = endpoint_fruit_00_53
    ? new THREE.CylinderGeometry(endpoint_fruit_00_53.endRadius, endpoint_fruit_00_53.baseRadius, endpoint_fruit_00_53.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_fruit_00_53) {
    mesh_fruit_00_53Geometry.scale(0.116, 0.1102, 0.116);
  }
  const mesh_fruit_00_53 = new THREE.Mesh(
    mesh_fruit_00_53Geometry,
    materialMap["fruit-ripe"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fruit_00_53.name = "Truss 1 fruit 1";
  if (endpoint_fruit_00_53) {
    mesh_fruit_00_53.position.copy(endpoint_fruit_00_53.midpoint);
    mesh_fruit_00_53.quaternion.copy(endpoint_fruit_00_53.quaternion);
  }
  mesh_fruit_00_53.castShadow = options.castShadow ?? true;
  mesh_fruit_00_53.receiveShadow = options.receiveShadow ?? true;
  mesh_fruit_00_53.userData.sculptComponent = {"id": "fruit-00", "name": "Truss 1 fruit 1", "level": "micro", "role": "fruit", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Glossy round cherry.", "geometryDescriptor": {"topologyIntent": "Glossy round cherry. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "peduncle-0", "attachment": {"parentId": "peduncle-0", "parentSocket": "peduncle-0:node", "localStart": [0.22, -0.042, 0.05], "localEnd": [0.22, -0.158, 0.05], "contactType": "butt", "embedDepth": 0.004, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.116, "height": 0.1102, "depth": 0.116, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.22, -0.1, 0.05], "rotation": [0, 0, 0], "scale": [0.116, 0.1102, 0.116]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-00", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "fruit-ripe", "materialLayers": ["fruit-ripe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ripeness", "kind": "stain", "description": "ripe orange", "evidenceRefs": ["full-object"]}, {"id": "calyx", "kind": "bevel", "description": "calyx star (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.2, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "smooth glossy skin", "displacementPattern": "", "occlusionPattern": "AO between touching fruits and under the calyx", "edgeWearPattern": "", "notes": "clearcoat highlight"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 122, 26, 1.0)", "secondaryAlbedo": "rgba(200, 90, 14, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_fruit_00_53.add(mesh_fruit_00_53);
  meshes["fruit-00"] = mesh_fruit_00_53;
  colliders["fruit-00"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["fruit-00"] ??= [];
  destructionGroups["fruit-00"].push(node_fruit_00_53);

  const endpoint_fruit_01_54 = makeAttachmentEndpoint(null);
  const node_fruit_01_54 = new THREE.Group();
  node_fruit_01_54.name = "Truss 1 fruit 2__pivot";
  node_fruit_01_54.scale.set(1, 1, 1);
  if (endpoint_fruit_01_54) {
    node_fruit_01_54.position.copy(endpoint_fruit_01_54.start);
    node_fruit_01_54.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_fruit_01_54.position.set(0.28, -0.15, -0.05);
    node_fruit_01_54.rotation.set(0.0, 0.0, 0.0);
  }
  node_fruit_01_54.userData.sculptComponent = {"id": "fruit-01", "name": "Truss 1 fruit 2", "level": "micro", "role": "fruit", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Glossy round cherry.", "geometryDescriptor": {"topologyIntent": "Glossy round cherry. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "peduncle-0", "attachment": {"parentId": "peduncle-0", "parentSocket": "peduncle-0:node", "localStart": [0.28, -0.092, -0.05], "localEnd": [0.28, -0.208, -0.05], "contactType": "butt", "embedDepth": 0.004, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.116, "height": 0.1102, "depth": 0.116, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.28, -0.15, -0.05], "rotation": [0, 0, 0], "scale": [0.116, 0.1102, 0.116]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "fruit-ripe", "materialLayers": ["fruit-ripe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ripeness", "kind": "stain", "description": "ripe orange", "evidenceRefs": ["full-object"]}, {"id": "calyx", "kind": "bevel", "description": "calyx star (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.2, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "smooth glossy skin", "displacementPattern": "", "occlusionPattern": "AO between touching fruits and under the calyx", "edgeWearPattern": "", "notes": "clearcoat highlight"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 122, 26, 1.0)", "secondaryAlbedo": "rgba(200, 90, 14, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_fruit_01_54.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["peduncle-0"] ?? root).add(node_fruit_01_54);
  nodes["fruit-01"] = node_fruit_01_54;
  const mesh_fruit_01_54Geometry = endpoint_fruit_01_54
    ? new THREE.CylinderGeometry(endpoint_fruit_01_54.endRadius, endpoint_fruit_01_54.baseRadius, endpoint_fruit_01_54.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_fruit_01_54) {
    mesh_fruit_01_54Geometry.scale(0.116, 0.1102, 0.116);
  }
  const mesh_fruit_01_54 = new THREE.Mesh(
    mesh_fruit_01_54Geometry,
    materialMap["fruit-ripe"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fruit_01_54.name = "Truss 1 fruit 2";
  if (endpoint_fruit_01_54) {
    mesh_fruit_01_54.position.copy(endpoint_fruit_01_54.midpoint);
    mesh_fruit_01_54.quaternion.copy(endpoint_fruit_01_54.quaternion);
  }
  mesh_fruit_01_54.castShadow = options.castShadow ?? true;
  mesh_fruit_01_54.receiveShadow = options.receiveShadow ?? true;
  mesh_fruit_01_54.userData.sculptComponent = {"id": "fruit-01", "name": "Truss 1 fruit 2", "level": "micro", "role": "fruit", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Glossy round cherry.", "geometryDescriptor": {"topologyIntent": "Glossy round cherry. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "peduncle-0", "attachment": {"parentId": "peduncle-0", "parentSocket": "peduncle-0:node", "localStart": [0.28, -0.092, -0.05], "localEnd": [0.28, -0.208, -0.05], "contactType": "butt", "embedDepth": 0.004, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.116, "height": 0.1102, "depth": 0.116, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.28, -0.15, -0.05], "rotation": [0, 0, 0], "scale": [0.116, 0.1102, 0.116]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-01", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "fruit-ripe", "materialLayers": ["fruit-ripe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ripeness", "kind": "stain", "description": "ripe orange", "evidenceRefs": ["full-object"]}, {"id": "calyx", "kind": "bevel", "description": "calyx star (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.2, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "smooth glossy skin", "displacementPattern": "", "occlusionPattern": "AO between touching fruits and under the calyx", "edgeWearPattern": "", "notes": "clearcoat highlight"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 122, 26, 1.0)", "secondaryAlbedo": "rgba(200, 90, 14, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_fruit_01_54.add(mesh_fruit_01_54);
  meshes["fruit-01"] = mesh_fruit_01_54;
  colliders["fruit-01"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["fruit-01"] ??= [];
  destructionGroups["fruit-01"].push(node_fruit_01_54);

  const endpoint_fruit_02_55 = makeAttachmentEndpoint(null);
  const node_fruit_02_55 = new THREE.Group();
  node_fruit_02_55.name = "Truss 1 fruit 3__pivot";
  node_fruit_02_55.scale.set(1, 1, 1);
  if (endpoint_fruit_02_55) {
    node_fruit_02_55.position.copy(endpoint_fruit_02_55.start);
    node_fruit_02_55.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_fruit_02_55.position.set(0.33, -0.09, 0.055);
    node_fruit_02_55.rotation.set(0.0, 0.0, 0.0);
  }
  node_fruit_02_55.userData.sculptComponent = {"id": "fruit-02", "name": "Truss 1 fruit 3", "level": "micro", "role": "fruit", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Glossy round cherry.", "geometryDescriptor": {"topologyIntent": "Glossy round cherry. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "peduncle-0", "attachment": {"parentId": "peduncle-0", "parentSocket": "peduncle-0:node", "localStart": [0.33, -0.031999999999999994, 0.055], "localEnd": [0.33, -0.148, 0.055], "contactType": "butt", "embedDepth": 0.004, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.116, "height": 0.1102, "depth": 0.116, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.33, -0.09, 0.055], "rotation": [0, 0, 0], "scale": [0.116, 0.1102, 0.116]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "fruit-ripe", "materialLayers": ["fruit-ripe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ripeness", "kind": "stain", "description": "ripe orange", "evidenceRefs": ["full-object"]}, {"id": "calyx", "kind": "bevel", "description": "calyx star (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.2, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "smooth glossy skin", "displacementPattern": "", "occlusionPattern": "AO between touching fruits and under the calyx", "edgeWearPattern": "", "notes": "clearcoat highlight"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 122, 26, 1.0)", "secondaryAlbedo": "rgba(200, 90, 14, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_fruit_02_55.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["peduncle-0"] ?? root).add(node_fruit_02_55);
  nodes["fruit-02"] = node_fruit_02_55;
  const mesh_fruit_02_55Geometry = endpoint_fruit_02_55
    ? new THREE.CylinderGeometry(endpoint_fruit_02_55.endRadius, endpoint_fruit_02_55.baseRadius, endpoint_fruit_02_55.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_fruit_02_55) {
    mesh_fruit_02_55Geometry.scale(0.116, 0.1102, 0.116);
  }
  const mesh_fruit_02_55 = new THREE.Mesh(
    mesh_fruit_02_55Geometry,
    materialMap["fruit-ripe"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fruit_02_55.name = "Truss 1 fruit 3";
  if (endpoint_fruit_02_55) {
    mesh_fruit_02_55.position.copy(endpoint_fruit_02_55.midpoint);
    mesh_fruit_02_55.quaternion.copy(endpoint_fruit_02_55.quaternion);
  }
  mesh_fruit_02_55.castShadow = options.castShadow ?? true;
  mesh_fruit_02_55.receiveShadow = options.receiveShadow ?? true;
  mesh_fruit_02_55.userData.sculptComponent = {"id": "fruit-02", "name": "Truss 1 fruit 3", "level": "micro", "role": "fruit", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Glossy round cherry.", "geometryDescriptor": {"topologyIntent": "Glossy round cherry. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "peduncle-0", "attachment": {"parentId": "peduncle-0", "parentSocket": "peduncle-0:node", "localStart": [0.33, -0.031999999999999994, 0.055], "localEnd": [0.33, -0.148, 0.055], "contactType": "butt", "embedDepth": 0.004, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.116, "height": 0.1102, "depth": 0.116, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.33, -0.09, 0.055], "rotation": [0, 0, 0], "scale": [0.116, 0.1102, 0.116]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-02", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "fruit-ripe", "materialLayers": ["fruit-ripe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ripeness", "kind": "stain", "description": "ripe orange", "evidenceRefs": ["full-object"]}, {"id": "calyx", "kind": "bevel", "description": "calyx star (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.2, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "smooth glossy skin", "displacementPattern": "", "occlusionPattern": "AO between touching fruits and under the calyx", "edgeWearPattern": "", "notes": "clearcoat highlight"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 122, 26, 1.0)", "secondaryAlbedo": "rgba(200, 90, 14, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_fruit_02_55.add(mesh_fruit_02_55);
  meshes["fruit-02"] = mesh_fruit_02_55;
  colliders["fruit-02"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["fruit-02"] ??= [];
  destructionGroups["fruit-02"].push(node_fruit_02_55);

  const endpoint_fruit_03_56 = makeAttachmentEndpoint(null);
  const node_fruit_03_56 = new THREE.Group();
  node_fruit_03_56.name = "Truss 1 fruit 4__pivot";
  node_fruit_03_56.scale.set(1, 1, 1);
  if (endpoint_fruit_03_56) {
    node_fruit_03_56.position.copy(endpoint_fruit_03_56.start);
    node_fruit_03_56.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_fruit_03_56.position.set(0.3, -0.22, 0.0);
    node_fruit_03_56.rotation.set(0.0, 0.0, 0.0);
  }
  node_fruit_03_56.userData.sculptComponent = {"id": "fruit-03", "name": "Truss 1 fruit 4", "level": "micro", "role": "fruit", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Glossy round cherry.", "geometryDescriptor": {"topologyIntent": "Glossy round cherry. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "peduncle-0", "attachment": {"parentId": "peduncle-0", "parentSocket": "peduncle-0:node", "localStart": [0.3, -0.168, 0.0], "localEnd": [0.3, -0.272, 0.0], "contactType": "butt", "embedDepth": 0.004, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.104, "height": 0.09879999999999999, "depth": 0.104, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.3, -0.22, 0.0], "rotation": [0, 0, 0], "scale": [0.104, 0.09879999999999999, 0.104]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "fruit-green", "materialLayers": ["fruit-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ripeness", "kind": "stain", "description": "unripe green", "evidenceRefs": ["full-object"]}, {"id": "calyx", "kind": "bevel", "description": "calyx star (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.2, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "smooth glossy skin", "displacementPattern": "", "occlusionPattern": "AO between touching fruits and under the calyx", "edgeWearPattern": "", "notes": "clearcoat highlight"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 190, 74, 1.0)", "secondaryAlbedo": "rgba(111, 160, 52, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_fruit_03_56.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["peduncle-0"] ?? root).add(node_fruit_03_56);
  nodes["fruit-03"] = node_fruit_03_56;
  const mesh_fruit_03_56Geometry = endpoint_fruit_03_56
    ? new THREE.CylinderGeometry(endpoint_fruit_03_56.endRadius, endpoint_fruit_03_56.baseRadius, endpoint_fruit_03_56.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_fruit_03_56) {
    mesh_fruit_03_56Geometry.scale(0.104, 0.09879999999999999, 0.104);
  }
  const mesh_fruit_03_56 = new THREE.Mesh(
    mesh_fruit_03_56Geometry,
    materialMap["fruit-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fruit_03_56.name = "Truss 1 fruit 4";
  if (endpoint_fruit_03_56) {
    mesh_fruit_03_56.position.copy(endpoint_fruit_03_56.midpoint);
    mesh_fruit_03_56.quaternion.copy(endpoint_fruit_03_56.quaternion);
  }
  mesh_fruit_03_56.castShadow = options.castShadow ?? true;
  mesh_fruit_03_56.receiveShadow = options.receiveShadow ?? true;
  mesh_fruit_03_56.userData.sculptComponent = {"id": "fruit-03", "name": "Truss 1 fruit 4", "level": "micro", "role": "fruit", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Glossy round cherry.", "geometryDescriptor": {"topologyIntent": "Glossy round cherry. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "peduncle-0", "attachment": {"parentId": "peduncle-0", "parentSocket": "peduncle-0:node", "localStart": [0.3, -0.168, 0.0], "localEnd": [0.3, -0.272, 0.0], "contactType": "butt", "embedDepth": 0.004, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.104, "height": 0.09879999999999999, "depth": 0.104, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.3, -0.22, 0.0], "rotation": [0, 0, 0], "scale": [0.104, 0.09879999999999999, 0.104]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-03", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "fruit-green", "materialLayers": ["fruit-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ripeness", "kind": "stain", "description": "unripe green", "evidenceRefs": ["full-object"]}, {"id": "calyx", "kind": "bevel", "description": "calyx star (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.2, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "smooth glossy skin", "displacementPattern": "", "occlusionPattern": "AO between touching fruits and under the calyx", "edgeWearPattern": "", "notes": "clearcoat highlight"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 190, 74, 1.0)", "secondaryAlbedo": "rgba(111, 160, 52, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_fruit_03_56.add(mesh_fruit_03_56);
  meshes["fruit-03"] = mesh_fruit_03_56;
  colliders["fruit-03"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["fruit-03"] ??= [];
  destructionGroups["fruit-03"].push(node_fruit_03_56);

  const endpoint_peduncle_1_57 = makeAttachmentEndpoint(null);
  const node_peduncle_1_57 = new THREE.Group();
  node_peduncle_1_57.name = "Truss 2 peduncle__pivot";
  node_peduncle_1_57.scale.set(1, 1, 1);
  if (endpoint_peduncle_1_57) {
    node_peduncle_1_57.position.copy(endpoint_peduncle_1_57.start);
    node_peduncle_1_57.rotation.set(0.0, 1.9199, 0.0);
  } else {
    node_peduncle_1_57.position.set(0.0, 0.58, 0.0);
    node_peduncle_1_57.rotation.set(0.0, 1.9199, 0.0);
  }
  node_peduncle_1_57.userData.sculptComponent = {"id": "peduncle-1", "name": "Truss 2 peduncle", "level": "meso", "role": "stem", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Peduncle carrying a hanging truss.", "geometryDescriptor": {"topologyIntent": "Peduncle carrying a hanging truss. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0, 0, 0], "rx": 0.008, "rz": 0.008, "twist": 0}, {"position": [0.15, 0.0, 0], "rx": 0.008, "rz": 0.008, "twist": 0}, {"position": [0.27, -0.06, 0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.58, 0.0], "localEnd": [-0.0923, 0.52, -0.2537], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.58, 0.0], "rotation": [0, 1.9199, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "peduncle-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "truss", "kind": "fastener", "description": "4 fruits per truss", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_peduncle_1_57.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "peduncle-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_peduncle_1_57);
  nodes["peduncle-1"] = node_peduncle_1_57;
  const mesh_peduncle_1_57Geometry = endpoint_peduncle_1_57
    ? new THREE.CylinderGeometry(endpoint_peduncle_1_57.endRadius, endpoint_peduncle_1_57.baseRadius, endpoint_peduncle_1_57.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0, 0, 0], "rx": 0.008, "rz": 0.008, "twist": 0}, {"position": [0.15, 0.0, 0], "rx": 0.008, "rz": 0.008, "twist": 0}, {"position": [0.27, -0.06, 0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 5, "capEnds": true});
  if (!endpoint_peduncle_1_57) {
    mesh_peduncle_1_57Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_peduncle_1_57 = new THREE.Mesh(
    mesh_peduncle_1_57Geometry,
    materialMap["stem"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_peduncle_1_57.name = "Truss 2 peduncle";
  if (endpoint_peduncle_1_57) {
    mesh_peduncle_1_57.position.copy(endpoint_peduncle_1_57.midpoint);
    mesh_peduncle_1_57.quaternion.copy(endpoint_peduncle_1_57.quaternion);
  }
  mesh_peduncle_1_57.castShadow = options.castShadow ?? true;
  mesh_peduncle_1_57.receiveShadow = options.receiveShadow ?? true;
  mesh_peduncle_1_57.userData.sculptComponent = {"id": "peduncle-1", "name": "Truss 2 peduncle", "level": "meso", "role": "stem", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Peduncle carrying a hanging truss.", "geometryDescriptor": {"topologyIntent": "Peduncle carrying a hanging truss. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0, 0, 0], "rx": 0.008, "rz": 0.008, "twist": 0}, {"position": [0.15, 0.0, 0], "rx": 0.008, "rz": 0.008, "twist": 0}, {"position": [0.27, -0.06, 0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.58, 0.0], "localEnd": [-0.0923, 0.52, -0.2537], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.58, 0.0], "rotation": [0, 1.9199, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "peduncle-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "truss", "kind": "fastener", "description": "4 fruits per truss", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_peduncle_1_57.add(mesh_peduncle_1_57);
  meshes["peduncle-1"] = mesh_peduncle_1_57;
  colliders["peduncle-1"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["peduncle-1"] ??= [];
  destructionGroups["peduncle-1"].push(node_peduncle_1_57);

  const endpoint_fruit_10_58 = makeAttachmentEndpoint(null);
  const node_fruit_10_58 = new THREE.Group();
  node_fruit_10_58.name = "Truss 2 fruit 1__pivot";
  node_fruit_10_58.scale.set(1, 1, 1);
  if (endpoint_fruit_10_58) {
    node_fruit_10_58.position.copy(endpoint_fruit_10_58.start);
    node_fruit_10_58.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_fruit_10_58.position.set(0.22, -0.1, 0.05);
    node_fruit_10_58.rotation.set(0.0, 0.0, 0.0);
  }
  node_fruit_10_58.userData.sculptComponent = {"id": "fruit-10", "name": "Truss 2 fruit 1", "level": "micro", "role": "fruit", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Glossy round cherry.", "geometryDescriptor": {"topologyIntent": "Glossy round cherry. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "peduncle-1", "attachment": {"parentId": "peduncle-1", "parentSocket": "peduncle-1:node", "localStart": [0.22, -0.042, 0.05], "localEnd": [0.22, -0.158, 0.05], "contactType": "butt", "embedDepth": 0.004, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.116, "height": 0.1102, "depth": 0.116, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.22, -0.1, 0.05], "rotation": [0, 0, 0], "scale": [0.116, 0.1102, 0.116]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-10", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "fruit-ripe", "materialLayers": ["fruit-ripe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ripeness", "kind": "stain", "description": "ripe orange", "evidenceRefs": ["full-object"]}, {"id": "calyx", "kind": "bevel", "description": "calyx star (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.2, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "smooth glossy skin", "displacementPattern": "", "occlusionPattern": "AO between touching fruits and under the calyx", "edgeWearPattern": "", "notes": "clearcoat highlight"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 122, 26, 1.0)", "secondaryAlbedo": "rgba(200, 90, 14, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_fruit_10_58.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-10", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["peduncle-1"] ?? root).add(node_fruit_10_58);
  nodes["fruit-10"] = node_fruit_10_58;
  const mesh_fruit_10_58Geometry = endpoint_fruit_10_58
    ? new THREE.CylinderGeometry(endpoint_fruit_10_58.endRadius, endpoint_fruit_10_58.baseRadius, endpoint_fruit_10_58.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_fruit_10_58) {
    mesh_fruit_10_58Geometry.scale(0.116, 0.1102, 0.116);
  }
  const mesh_fruit_10_58 = new THREE.Mesh(
    mesh_fruit_10_58Geometry,
    materialMap["fruit-ripe"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fruit_10_58.name = "Truss 2 fruit 1";
  if (endpoint_fruit_10_58) {
    mesh_fruit_10_58.position.copy(endpoint_fruit_10_58.midpoint);
    mesh_fruit_10_58.quaternion.copy(endpoint_fruit_10_58.quaternion);
  }
  mesh_fruit_10_58.castShadow = options.castShadow ?? true;
  mesh_fruit_10_58.receiveShadow = options.receiveShadow ?? true;
  mesh_fruit_10_58.userData.sculptComponent = {"id": "fruit-10", "name": "Truss 2 fruit 1", "level": "micro", "role": "fruit", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Glossy round cherry.", "geometryDescriptor": {"topologyIntent": "Glossy round cherry. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "peduncle-1", "attachment": {"parentId": "peduncle-1", "parentSocket": "peduncle-1:node", "localStart": [0.22, -0.042, 0.05], "localEnd": [0.22, -0.158, 0.05], "contactType": "butt", "embedDepth": 0.004, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.116, "height": 0.1102, "depth": 0.116, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.22, -0.1, 0.05], "rotation": [0, 0, 0], "scale": [0.116, 0.1102, 0.116]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-10", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "fruit-ripe", "materialLayers": ["fruit-ripe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ripeness", "kind": "stain", "description": "ripe orange", "evidenceRefs": ["full-object"]}, {"id": "calyx", "kind": "bevel", "description": "calyx star (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.2, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "smooth glossy skin", "displacementPattern": "", "occlusionPattern": "AO between touching fruits and under the calyx", "edgeWearPattern": "", "notes": "clearcoat highlight"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 122, 26, 1.0)", "secondaryAlbedo": "rgba(200, 90, 14, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_fruit_10_58.add(mesh_fruit_10_58);
  meshes["fruit-10"] = mesh_fruit_10_58;
  colliders["fruit-10"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["fruit-10"] ??= [];
  destructionGroups["fruit-10"].push(node_fruit_10_58);

  const endpoint_fruit_11_59 = makeAttachmentEndpoint(null);
  const node_fruit_11_59 = new THREE.Group();
  node_fruit_11_59.name = "Truss 2 fruit 2__pivot";
  node_fruit_11_59.scale.set(1, 1, 1);
  if (endpoint_fruit_11_59) {
    node_fruit_11_59.position.copy(endpoint_fruit_11_59.start);
    node_fruit_11_59.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_fruit_11_59.position.set(0.28, -0.15, -0.05);
    node_fruit_11_59.rotation.set(0.0, 0.0, 0.0);
  }
  node_fruit_11_59.userData.sculptComponent = {"id": "fruit-11", "name": "Truss 2 fruit 2", "level": "micro", "role": "fruit", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Glossy round cherry.", "geometryDescriptor": {"topologyIntent": "Glossy round cherry. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "peduncle-1", "attachment": {"parentId": "peduncle-1", "parentSocket": "peduncle-1:node", "localStart": [0.28, -0.098, -0.05], "localEnd": [0.28, -0.20199999999999999, -0.05], "contactType": "butt", "embedDepth": 0.004, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.104, "height": 0.09879999999999999, "depth": 0.104, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.28, -0.15, -0.05], "rotation": [0, 0, 0], "scale": [0.104, 0.09879999999999999, 0.104]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-11", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "fruit-green", "materialLayers": ["fruit-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ripeness", "kind": "stain", "description": "unripe green", "evidenceRefs": ["full-object"]}, {"id": "calyx", "kind": "bevel", "description": "calyx star (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.2, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "smooth glossy skin", "displacementPattern": "", "occlusionPattern": "AO between touching fruits and under the calyx", "edgeWearPattern": "", "notes": "clearcoat highlight"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 190, 74, 1.0)", "secondaryAlbedo": "rgba(111, 160, 52, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_fruit_11_59.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-11", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["peduncle-1"] ?? root).add(node_fruit_11_59);
  nodes["fruit-11"] = node_fruit_11_59;
  const mesh_fruit_11_59Geometry = endpoint_fruit_11_59
    ? new THREE.CylinderGeometry(endpoint_fruit_11_59.endRadius, endpoint_fruit_11_59.baseRadius, endpoint_fruit_11_59.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_fruit_11_59) {
    mesh_fruit_11_59Geometry.scale(0.104, 0.09879999999999999, 0.104);
  }
  const mesh_fruit_11_59 = new THREE.Mesh(
    mesh_fruit_11_59Geometry,
    materialMap["fruit-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fruit_11_59.name = "Truss 2 fruit 2";
  if (endpoint_fruit_11_59) {
    mesh_fruit_11_59.position.copy(endpoint_fruit_11_59.midpoint);
    mesh_fruit_11_59.quaternion.copy(endpoint_fruit_11_59.quaternion);
  }
  mesh_fruit_11_59.castShadow = options.castShadow ?? true;
  mesh_fruit_11_59.receiveShadow = options.receiveShadow ?? true;
  mesh_fruit_11_59.userData.sculptComponent = {"id": "fruit-11", "name": "Truss 2 fruit 2", "level": "micro", "role": "fruit", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Glossy round cherry.", "geometryDescriptor": {"topologyIntent": "Glossy round cherry. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "peduncle-1", "attachment": {"parentId": "peduncle-1", "parentSocket": "peduncle-1:node", "localStart": [0.28, -0.098, -0.05], "localEnd": [0.28, -0.20199999999999999, -0.05], "contactType": "butt", "embedDepth": 0.004, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.104, "height": 0.09879999999999999, "depth": 0.104, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.28, -0.15, -0.05], "rotation": [0, 0, 0], "scale": [0.104, 0.09879999999999999, 0.104]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-11", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "fruit-green", "materialLayers": ["fruit-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ripeness", "kind": "stain", "description": "unripe green", "evidenceRefs": ["full-object"]}, {"id": "calyx", "kind": "bevel", "description": "calyx star (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.2, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "smooth glossy skin", "displacementPattern": "", "occlusionPattern": "AO between touching fruits and under the calyx", "edgeWearPattern": "", "notes": "clearcoat highlight"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 190, 74, 1.0)", "secondaryAlbedo": "rgba(111, 160, 52, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_fruit_11_59.add(mesh_fruit_11_59);
  meshes["fruit-11"] = mesh_fruit_11_59;
  colliders["fruit-11"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["fruit-11"] ??= [];
  destructionGroups["fruit-11"].push(node_fruit_11_59);

  const endpoint_fruit_12_60 = makeAttachmentEndpoint(null);
  const node_fruit_12_60 = new THREE.Group();
  node_fruit_12_60.name = "Truss 2 fruit 3__pivot";
  node_fruit_12_60.scale.set(1, 1, 1);
  if (endpoint_fruit_12_60) {
    node_fruit_12_60.position.copy(endpoint_fruit_12_60.start);
    node_fruit_12_60.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_fruit_12_60.position.set(0.33, -0.09, 0.055);
    node_fruit_12_60.rotation.set(0.0, 0.0, 0.0);
  }
  node_fruit_12_60.userData.sculptComponent = {"id": "fruit-12", "name": "Truss 2 fruit 3", "level": "micro", "role": "fruit", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Glossy round cherry.", "geometryDescriptor": {"topologyIntent": "Glossy round cherry. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "peduncle-1", "attachment": {"parentId": "peduncle-1", "parentSocket": "peduncle-1:node", "localStart": [0.33, -0.038, 0.055], "localEnd": [0.33, -0.142, 0.055], "contactType": "butt", "embedDepth": 0.004, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.104, "height": 0.09879999999999999, "depth": 0.104, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.33, -0.09, 0.055], "rotation": [0, 0, 0], "scale": [0.104, 0.09879999999999999, 0.104]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-12", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "fruit-green", "materialLayers": ["fruit-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ripeness", "kind": "stain", "description": "unripe green", "evidenceRefs": ["full-object"]}, {"id": "calyx", "kind": "bevel", "description": "calyx star (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.2, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "smooth glossy skin", "displacementPattern": "", "occlusionPattern": "AO between touching fruits and under the calyx", "edgeWearPattern": "", "notes": "clearcoat highlight"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 190, 74, 1.0)", "secondaryAlbedo": "rgba(111, 160, 52, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_fruit_12_60.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-12", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["peduncle-1"] ?? root).add(node_fruit_12_60);
  nodes["fruit-12"] = node_fruit_12_60;
  const mesh_fruit_12_60Geometry = endpoint_fruit_12_60
    ? new THREE.CylinderGeometry(endpoint_fruit_12_60.endRadius, endpoint_fruit_12_60.baseRadius, endpoint_fruit_12_60.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_fruit_12_60) {
    mesh_fruit_12_60Geometry.scale(0.104, 0.09879999999999999, 0.104);
  }
  const mesh_fruit_12_60 = new THREE.Mesh(
    mesh_fruit_12_60Geometry,
    materialMap["fruit-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fruit_12_60.name = "Truss 2 fruit 3";
  if (endpoint_fruit_12_60) {
    mesh_fruit_12_60.position.copy(endpoint_fruit_12_60.midpoint);
    mesh_fruit_12_60.quaternion.copy(endpoint_fruit_12_60.quaternion);
  }
  mesh_fruit_12_60.castShadow = options.castShadow ?? true;
  mesh_fruit_12_60.receiveShadow = options.receiveShadow ?? true;
  mesh_fruit_12_60.userData.sculptComponent = {"id": "fruit-12", "name": "Truss 2 fruit 3", "level": "micro", "role": "fruit", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Glossy round cherry.", "geometryDescriptor": {"topologyIntent": "Glossy round cherry. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "peduncle-1", "attachment": {"parentId": "peduncle-1", "parentSocket": "peduncle-1:node", "localStart": [0.33, -0.038, 0.055], "localEnd": [0.33, -0.142, 0.055], "contactType": "butt", "embedDepth": 0.004, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.104, "height": 0.09879999999999999, "depth": 0.104, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.33, -0.09, 0.055], "rotation": [0, 0, 0], "scale": [0.104, 0.09879999999999999, 0.104]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-12", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "fruit-green", "materialLayers": ["fruit-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ripeness", "kind": "stain", "description": "unripe green", "evidenceRefs": ["full-object"]}, {"id": "calyx", "kind": "bevel", "description": "calyx star (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.2, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "smooth glossy skin", "displacementPattern": "", "occlusionPattern": "AO between touching fruits and under the calyx", "edgeWearPattern": "", "notes": "clearcoat highlight"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 190, 74, 1.0)", "secondaryAlbedo": "rgba(111, 160, 52, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_fruit_12_60.add(mesh_fruit_12_60);
  meshes["fruit-12"] = mesh_fruit_12_60;
  colliders["fruit-12"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["fruit-12"] ??= [];
  destructionGroups["fruit-12"].push(node_fruit_12_60);

  const endpoint_fruit_13_61 = makeAttachmentEndpoint(null);
  const node_fruit_13_61 = new THREE.Group();
  node_fruit_13_61.name = "Truss 2 fruit 4__pivot";
  node_fruit_13_61.scale.set(1, 1, 1);
  if (endpoint_fruit_13_61) {
    node_fruit_13_61.position.copy(endpoint_fruit_13_61.start);
    node_fruit_13_61.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_fruit_13_61.position.set(0.3, -0.22, 0.0);
    node_fruit_13_61.rotation.set(0.0, 0.0, 0.0);
  }
  node_fruit_13_61.userData.sculptComponent = {"id": "fruit-13", "name": "Truss 2 fruit 4", "level": "micro", "role": "fruit", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Glossy round cherry.", "geometryDescriptor": {"topologyIntent": "Glossy round cherry. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "peduncle-1", "attachment": {"parentId": "peduncle-1", "parentSocket": "peduncle-1:node", "localStart": [0.3, -0.162, 0.0], "localEnd": [0.3, -0.278, 0.0], "contactType": "butt", "embedDepth": 0.004, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.116, "height": 0.1102, "depth": 0.116, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.3, -0.22, 0.0], "rotation": [0, 0, 0], "scale": [0.116, 0.1102, 0.116]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-13", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "fruit-ripe", "materialLayers": ["fruit-ripe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ripeness", "kind": "stain", "description": "ripe orange", "evidenceRefs": ["full-object"]}, {"id": "calyx", "kind": "bevel", "description": "calyx star (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.2, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "smooth glossy skin", "displacementPattern": "", "occlusionPattern": "AO between touching fruits and under the calyx", "edgeWearPattern": "", "notes": "clearcoat highlight"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 122, 26, 1.0)", "secondaryAlbedo": "rgba(200, 90, 14, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_fruit_13_61.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-13", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["peduncle-1"] ?? root).add(node_fruit_13_61);
  nodes["fruit-13"] = node_fruit_13_61;
  const mesh_fruit_13_61Geometry = endpoint_fruit_13_61
    ? new THREE.CylinderGeometry(endpoint_fruit_13_61.endRadius, endpoint_fruit_13_61.baseRadius, endpoint_fruit_13_61.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_fruit_13_61) {
    mesh_fruit_13_61Geometry.scale(0.116, 0.1102, 0.116);
  }
  const mesh_fruit_13_61 = new THREE.Mesh(
    mesh_fruit_13_61Geometry,
    materialMap["fruit-ripe"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fruit_13_61.name = "Truss 2 fruit 4";
  if (endpoint_fruit_13_61) {
    mesh_fruit_13_61.position.copy(endpoint_fruit_13_61.midpoint);
    mesh_fruit_13_61.quaternion.copy(endpoint_fruit_13_61.quaternion);
  }
  mesh_fruit_13_61.castShadow = options.castShadow ?? true;
  mesh_fruit_13_61.receiveShadow = options.receiveShadow ?? true;
  mesh_fruit_13_61.userData.sculptComponent = {"id": "fruit-13", "name": "Truss 2 fruit 4", "level": "micro", "role": "fruit", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Glossy round cherry.", "geometryDescriptor": {"topologyIntent": "Glossy round cherry. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "peduncle-1", "attachment": {"parentId": "peduncle-1", "parentSocket": "peduncle-1:node", "localStart": [0.3, -0.162, 0.0], "localEnd": [0.3, -0.278, 0.0], "contactType": "butt", "embedDepth": 0.004, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.116, "height": 0.1102, "depth": 0.116, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.3, -0.22, 0.0], "rotation": [0, 0, 0], "scale": [0.116, 0.1102, 0.116]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-13", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "fruit-ripe", "materialLayers": ["fruit-ripe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ripeness", "kind": "stain", "description": "ripe orange", "evidenceRefs": ["full-object"]}, {"id": "calyx", "kind": "bevel", "description": "calyx star (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.2, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "smooth glossy skin", "displacementPattern": "", "occlusionPattern": "AO between touching fruits and under the calyx", "edgeWearPattern": "", "notes": "clearcoat highlight"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 122, 26, 1.0)", "secondaryAlbedo": "rgba(200, 90, 14, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_fruit_13_61.add(mesh_fruit_13_61);
  meshes["fruit-13"] = mesh_fruit_13_61;
  colliders["fruit-13"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["fruit-13"] ??= [];
  destructionGroups["fruit-13"].push(node_fruit_13_61);

  const endpoint_peduncle_2_62 = makeAttachmentEndpoint(null);
  const node_peduncle_2_62 = new THREE.Group();
  node_peduncle_2_62.name = "Truss 3 peduncle__pivot";
  node_peduncle_2_62.scale.set(1, 1, 1);
  if (endpoint_peduncle_2_62) {
    node_peduncle_2_62.position.copy(endpoint_peduncle_2_62.start);
    node_peduncle_2_62.rotation.set(0.0, 4.0143, 0.0);
  } else {
    node_peduncle_2_62.position.set(0.0, 0.78, 0.0);
    node_peduncle_2_62.rotation.set(0.0, 4.0143, 0.0);
  }
  node_peduncle_2_62.userData.sculptComponent = {"id": "peduncle-2", "name": "Truss 3 peduncle", "level": "meso", "role": "stem", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Peduncle carrying a hanging truss.", "geometryDescriptor": {"topologyIntent": "Peduncle carrying a hanging truss. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0, 0, 0], "rx": 0.008, "rz": 0.008, "twist": 0}, {"position": [0.15, 0.0, 0], "rx": 0.008, "rz": 0.008, "twist": 0}, {"position": [0.27, -0.06, 0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.78, 0.0], "localEnd": [-0.1736, 0.72, 0.2068], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.78, 0.0], "rotation": [0, 4.0143, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "peduncle-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "truss", "kind": "fastener", "description": "4 fruits per truss", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_peduncle_2_62.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "peduncle-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["stem-main"] ?? root).add(node_peduncle_2_62);
  nodes["peduncle-2"] = node_peduncle_2_62;
  const mesh_peduncle_2_62Geometry = endpoint_peduncle_2_62
    ? new THREE.CylinderGeometry(endpoint_peduncle_2_62.endRadius, endpoint_peduncle_2_62.baseRadius, endpoint_peduncle_2_62.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0, 0, 0], "rx": 0.008, "rz": 0.008, "twist": 0}, {"position": [0.15, 0.0, 0], "rx": 0.008, "rz": 0.008, "twist": 0}, {"position": [0.27, -0.06, 0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 5, "capEnds": true});
  if (!endpoint_peduncle_2_62) {
    mesh_peduncle_2_62Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_peduncle_2_62 = new THREE.Mesh(
    mesh_peduncle_2_62Geometry,
    materialMap["stem"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_peduncle_2_62.name = "Truss 3 peduncle";
  if (endpoint_peduncle_2_62) {
    mesh_peduncle_2_62.position.copy(endpoint_peduncle_2_62.midpoint);
    mesh_peduncle_2_62.quaternion.copy(endpoint_peduncle_2_62.quaternion);
  }
  mesh_peduncle_2_62.castShadow = options.castShadow ?? true;
  mesh_peduncle_2_62.receiveShadow = options.receiveShadow ?? true;
  mesh_peduncle_2_62.userData.sculptComponent = {"id": "peduncle-2", "name": "Truss 3 peduncle", "level": "meso", "role": "stem", "importance": 0.7, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "continuous-sculpt", "topologyRationale": "Peduncle carrying a hanging truss.", "geometryDescriptor": {"topologyIntent": "Peduncle carrying a hanging truss. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0, 0, 0], "rx": 0.008, "rz": 0.008, "twist": 0}, {"position": [0.15, 0.0, 0], "rx": 0.008, "rz": 0.008, "twist": 0}, {"position": [0.27, -0.06, 0], "rx": 0.0, "rz": 0.0, "twist": 0}], "radialSegments": 5, "capEnds": true}}, "parent": "stem-main", "attachment": {"parentId": "stem-main", "parentSocket": "stem-main:node", "localStart": [0.0, 0.78, 0.0], "localEnd": [-0.1736, 0.72, 0.2068], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0, 0.78, 0.0], "rotation": [0, 4.0143, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "peduncle-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "stem", "materialLayers": ["stem"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "truss", "kind": "fastener", "description": "4 fruits per truss", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.7, "microRoughness": 0.15, "bumpAmplitude": 0.0, "normalPattern": "matte hairy stem", "displacementPattern": "", "occlusionPattern": "AO at nodes", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(110, 158, 62, 1.0)", "secondaryAlbedo": "rgba(85, 126, 48, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_peduncle_2_62.add(mesh_peduncle_2_62);
  meshes["peduncle-2"] = mesh_peduncle_2_62;
  colliders["peduncle-2"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["peduncle-2"] ??= [];
  destructionGroups["peduncle-2"].push(node_peduncle_2_62);

  const endpoint_fruit_20_63 = makeAttachmentEndpoint(null);
  const node_fruit_20_63 = new THREE.Group();
  node_fruit_20_63.name = "Truss 3 fruit 1__pivot";
  node_fruit_20_63.scale.set(1, 1, 1);
  if (endpoint_fruit_20_63) {
    node_fruit_20_63.position.copy(endpoint_fruit_20_63.start);
    node_fruit_20_63.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_fruit_20_63.position.set(0.22, -0.1, 0.05);
    node_fruit_20_63.rotation.set(0.0, 0.0, 0.0);
  }
  node_fruit_20_63.userData.sculptComponent = {"id": "fruit-20", "name": "Truss 3 fruit 1", "level": "micro", "role": "fruit", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Glossy round cherry.", "geometryDescriptor": {"topologyIntent": "Glossy round cherry. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "peduncle-2", "attachment": {"parentId": "peduncle-2", "parentSocket": "peduncle-2:node", "localStart": [0.22, -0.04800000000000001, 0.05], "localEnd": [0.22, -0.152, 0.05], "contactType": "butt", "embedDepth": 0.004, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.104, "height": 0.09879999999999999, "depth": 0.104, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.22, -0.1, 0.05], "rotation": [0, 0, 0], "scale": [0.104, 0.09879999999999999, 0.104]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-20", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "fruit-green", "materialLayers": ["fruit-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ripeness", "kind": "stain", "description": "unripe green", "evidenceRefs": ["full-object"]}, {"id": "calyx", "kind": "bevel", "description": "calyx star (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.2, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "smooth glossy skin", "displacementPattern": "", "occlusionPattern": "AO between touching fruits and under the calyx", "edgeWearPattern": "", "notes": "clearcoat highlight"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 190, 74, 1.0)", "secondaryAlbedo": "rgba(111, 160, 52, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_fruit_20_63.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-20", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["peduncle-2"] ?? root).add(node_fruit_20_63);
  nodes["fruit-20"] = node_fruit_20_63;
  const mesh_fruit_20_63Geometry = endpoint_fruit_20_63
    ? new THREE.CylinderGeometry(endpoint_fruit_20_63.endRadius, endpoint_fruit_20_63.baseRadius, endpoint_fruit_20_63.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_fruit_20_63) {
    mesh_fruit_20_63Geometry.scale(0.104, 0.09879999999999999, 0.104);
  }
  const mesh_fruit_20_63 = new THREE.Mesh(
    mesh_fruit_20_63Geometry,
    materialMap["fruit-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fruit_20_63.name = "Truss 3 fruit 1";
  if (endpoint_fruit_20_63) {
    mesh_fruit_20_63.position.copy(endpoint_fruit_20_63.midpoint);
    mesh_fruit_20_63.quaternion.copy(endpoint_fruit_20_63.quaternion);
  }
  mesh_fruit_20_63.castShadow = options.castShadow ?? true;
  mesh_fruit_20_63.receiveShadow = options.receiveShadow ?? true;
  mesh_fruit_20_63.userData.sculptComponent = {"id": "fruit-20", "name": "Truss 3 fruit 1", "level": "micro", "role": "fruit", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Glossy round cherry.", "geometryDescriptor": {"topologyIntent": "Glossy round cherry. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "peduncle-2", "attachment": {"parentId": "peduncle-2", "parentSocket": "peduncle-2:node", "localStart": [0.22, -0.04800000000000001, 0.05], "localEnd": [0.22, -0.152, 0.05], "contactType": "butt", "embedDepth": 0.004, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.104, "height": 0.09879999999999999, "depth": 0.104, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.22, -0.1, 0.05], "rotation": [0, 0, 0], "scale": [0.104, 0.09879999999999999, 0.104]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-20", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "fruit-green", "materialLayers": ["fruit-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ripeness", "kind": "stain", "description": "unripe green", "evidenceRefs": ["full-object"]}, {"id": "calyx", "kind": "bevel", "description": "calyx star (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.2, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "smooth glossy skin", "displacementPattern": "", "occlusionPattern": "AO between touching fruits and under the calyx", "edgeWearPattern": "", "notes": "clearcoat highlight"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 190, 74, 1.0)", "secondaryAlbedo": "rgba(111, 160, 52, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_fruit_20_63.add(mesh_fruit_20_63);
  meshes["fruit-20"] = mesh_fruit_20_63;
  colliders["fruit-20"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["fruit-20"] ??= [];
  destructionGroups["fruit-20"].push(node_fruit_20_63);

  const endpoint_fruit_21_64 = makeAttachmentEndpoint(null);
  const node_fruit_21_64 = new THREE.Group();
  node_fruit_21_64.name = "Truss 3 fruit 2__pivot";
  node_fruit_21_64.scale.set(1, 1, 1);
  if (endpoint_fruit_21_64) {
    node_fruit_21_64.position.copy(endpoint_fruit_21_64.start);
    node_fruit_21_64.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_fruit_21_64.position.set(0.28, -0.15, -0.05);
    node_fruit_21_64.rotation.set(0.0, 0.0, 0.0);
  }
  node_fruit_21_64.userData.sculptComponent = {"id": "fruit-21", "name": "Truss 3 fruit 2", "level": "micro", "role": "fruit", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Glossy round cherry.", "geometryDescriptor": {"topologyIntent": "Glossy round cherry. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "peduncle-2", "attachment": {"parentId": "peduncle-2", "parentSocket": "peduncle-2:node", "localStart": [0.28, -0.098, -0.05], "localEnd": [0.28, -0.20199999999999999, -0.05], "contactType": "butt", "embedDepth": 0.004, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.104, "height": 0.09879999999999999, "depth": 0.104, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.28, -0.15, -0.05], "rotation": [0, 0, 0], "scale": [0.104, 0.09879999999999999, 0.104]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-21", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "fruit-green", "materialLayers": ["fruit-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ripeness", "kind": "stain", "description": "unripe green", "evidenceRefs": ["full-object"]}, {"id": "calyx", "kind": "bevel", "description": "calyx star (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.2, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "smooth glossy skin", "displacementPattern": "", "occlusionPattern": "AO between touching fruits and under the calyx", "edgeWearPattern": "", "notes": "clearcoat highlight"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 190, 74, 1.0)", "secondaryAlbedo": "rgba(111, 160, 52, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_fruit_21_64.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-21", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["peduncle-2"] ?? root).add(node_fruit_21_64);
  nodes["fruit-21"] = node_fruit_21_64;
  const mesh_fruit_21_64Geometry = endpoint_fruit_21_64
    ? new THREE.CylinderGeometry(endpoint_fruit_21_64.endRadius, endpoint_fruit_21_64.baseRadius, endpoint_fruit_21_64.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_fruit_21_64) {
    mesh_fruit_21_64Geometry.scale(0.104, 0.09879999999999999, 0.104);
  }
  const mesh_fruit_21_64 = new THREE.Mesh(
    mesh_fruit_21_64Geometry,
    materialMap["fruit-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fruit_21_64.name = "Truss 3 fruit 2";
  if (endpoint_fruit_21_64) {
    mesh_fruit_21_64.position.copy(endpoint_fruit_21_64.midpoint);
    mesh_fruit_21_64.quaternion.copy(endpoint_fruit_21_64.quaternion);
  }
  mesh_fruit_21_64.castShadow = options.castShadow ?? true;
  mesh_fruit_21_64.receiveShadow = options.receiveShadow ?? true;
  mesh_fruit_21_64.userData.sculptComponent = {"id": "fruit-21", "name": "Truss 3 fruit 2", "level": "micro", "role": "fruit", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Glossy round cherry.", "geometryDescriptor": {"topologyIntent": "Glossy round cherry. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "peduncle-2", "attachment": {"parentId": "peduncle-2", "parentSocket": "peduncle-2:node", "localStart": [0.28, -0.098, -0.05], "localEnd": [0.28, -0.20199999999999999, -0.05], "contactType": "butt", "embedDepth": 0.004, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.104, "height": 0.09879999999999999, "depth": 0.104, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.28, -0.15, -0.05], "rotation": [0, 0, 0], "scale": [0.104, 0.09879999999999999, 0.104]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-21", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "fruit-green", "materialLayers": ["fruit-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ripeness", "kind": "stain", "description": "unripe green", "evidenceRefs": ["full-object"]}, {"id": "calyx", "kind": "bevel", "description": "calyx star (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.2, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "smooth glossy skin", "displacementPattern": "", "occlusionPattern": "AO between touching fruits and under the calyx", "edgeWearPattern": "", "notes": "clearcoat highlight"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 190, 74, 1.0)", "secondaryAlbedo": "rgba(111, 160, 52, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_fruit_21_64.add(mesh_fruit_21_64);
  meshes["fruit-21"] = mesh_fruit_21_64;
  colliders["fruit-21"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["fruit-21"] ??= [];
  destructionGroups["fruit-21"].push(node_fruit_21_64);

  const endpoint_fruit_22_65 = makeAttachmentEndpoint(null);
  const node_fruit_22_65 = new THREE.Group();
  node_fruit_22_65.name = "Truss 3 fruit 3__pivot";
  node_fruit_22_65.scale.set(1, 1, 1);
  if (endpoint_fruit_22_65) {
    node_fruit_22_65.position.copy(endpoint_fruit_22_65.start);
    node_fruit_22_65.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_fruit_22_65.position.set(0.33, -0.09, 0.055);
    node_fruit_22_65.rotation.set(0.0, 0.0, 0.0);
  }
  node_fruit_22_65.userData.sculptComponent = {"id": "fruit-22", "name": "Truss 3 fruit 3", "level": "micro", "role": "fruit", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Glossy round cherry.", "geometryDescriptor": {"topologyIntent": "Glossy round cherry. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "peduncle-2", "attachment": {"parentId": "peduncle-2", "parentSocket": "peduncle-2:node", "localStart": [0.33, -0.031999999999999994, 0.055], "localEnd": [0.33, -0.148, 0.055], "contactType": "butt", "embedDepth": 0.004, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.116, "height": 0.1102, "depth": 0.116, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.33, -0.09, 0.055], "rotation": [0, 0, 0], "scale": [0.116, 0.1102, 0.116]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-22", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "fruit-ripe", "materialLayers": ["fruit-ripe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ripeness", "kind": "stain", "description": "ripe orange", "evidenceRefs": ["full-object"]}, {"id": "calyx", "kind": "bevel", "description": "calyx star (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.2, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "smooth glossy skin", "displacementPattern": "", "occlusionPattern": "AO between touching fruits and under the calyx", "edgeWearPattern": "", "notes": "clearcoat highlight"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 122, 26, 1.0)", "secondaryAlbedo": "rgba(200, 90, 14, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_fruit_22_65.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-22", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["peduncle-2"] ?? root).add(node_fruit_22_65);
  nodes["fruit-22"] = node_fruit_22_65;
  const mesh_fruit_22_65Geometry = endpoint_fruit_22_65
    ? new THREE.CylinderGeometry(endpoint_fruit_22_65.endRadius, endpoint_fruit_22_65.baseRadius, endpoint_fruit_22_65.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_fruit_22_65) {
    mesh_fruit_22_65Geometry.scale(0.116, 0.1102, 0.116);
  }
  const mesh_fruit_22_65 = new THREE.Mesh(
    mesh_fruit_22_65Geometry,
    materialMap["fruit-ripe"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fruit_22_65.name = "Truss 3 fruit 3";
  if (endpoint_fruit_22_65) {
    mesh_fruit_22_65.position.copy(endpoint_fruit_22_65.midpoint);
    mesh_fruit_22_65.quaternion.copy(endpoint_fruit_22_65.quaternion);
  }
  mesh_fruit_22_65.castShadow = options.castShadow ?? true;
  mesh_fruit_22_65.receiveShadow = options.receiveShadow ?? true;
  mesh_fruit_22_65.userData.sculptComponent = {"id": "fruit-22", "name": "Truss 3 fruit 3", "level": "micro", "role": "fruit", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Glossy round cherry.", "geometryDescriptor": {"topologyIntent": "Glossy round cherry. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "peduncle-2", "attachment": {"parentId": "peduncle-2", "parentSocket": "peduncle-2:node", "localStart": [0.33, -0.031999999999999994, 0.055], "localEnd": [0.33, -0.148, 0.055], "contactType": "butt", "embedDepth": 0.004, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.116, "height": 0.1102, "depth": 0.116, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.33, -0.09, 0.055], "rotation": [0, 0, 0], "scale": [0.116, 0.1102, 0.116]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-22", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "fruit-ripe", "materialLayers": ["fruit-ripe"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ripeness", "kind": "stain", "description": "ripe orange", "evidenceRefs": ["full-object"]}, {"id": "calyx", "kind": "bevel", "description": "calyx star (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.2, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "smooth glossy skin", "displacementPattern": "", "occlusionPattern": "AO between touching fruits and under the calyx", "edgeWearPattern": "", "notes": "clearcoat highlight"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(240, 122, 26, 1.0)", "secondaryAlbedo": "rgba(200, 90, 14, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_fruit_22_65.add(mesh_fruit_22_65);
  meshes["fruit-22"] = mesh_fruit_22_65;
  colliders["fruit-22"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["fruit-22"] ??= [];
  destructionGroups["fruit-22"].push(node_fruit_22_65);

  const endpoint_fruit_23_66 = makeAttachmentEndpoint(null);
  const node_fruit_23_66 = new THREE.Group();
  node_fruit_23_66.name = "Truss 3 fruit 4__pivot";
  node_fruit_23_66.scale.set(1, 1, 1);
  if (endpoint_fruit_23_66) {
    node_fruit_23_66.position.copy(endpoint_fruit_23_66.start);
    node_fruit_23_66.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_fruit_23_66.position.set(0.3, -0.22, 0.0);
    node_fruit_23_66.rotation.set(0.0, 0.0, 0.0);
  }
  node_fruit_23_66.userData.sculptComponent = {"id": "fruit-23", "name": "Truss 3 fruit 4", "level": "micro", "role": "fruit", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Glossy round cherry.", "geometryDescriptor": {"topologyIntent": "Glossy round cherry. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "peduncle-2", "attachment": {"parentId": "peduncle-2", "parentSocket": "peduncle-2:node", "localStart": [0.3, -0.168, 0.0], "localEnd": [0.3, -0.272, 0.0], "contactType": "butt", "embedDepth": 0.004, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.104, "height": 0.09879999999999999, "depth": 0.104, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.3, -0.22, 0.0], "rotation": [0, 0, 0], "scale": [0.104, 0.09879999999999999, 0.104]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-23", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "fruit-green", "materialLayers": ["fruit-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ripeness", "kind": "stain", "description": "unripe green", "evidenceRefs": ["full-object"]}, {"id": "calyx", "kind": "bevel", "description": "calyx star (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.2, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "smooth glossy skin", "displacementPattern": "", "occlusionPattern": "AO between touching fruits and under the calyx", "edgeWearPattern": "", "notes": "clearcoat highlight"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 190, 74, 1.0)", "secondaryAlbedo": "rgba(111, 160, 52, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_fruit_23_66.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-23", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["peduncle-2"] ?? root).add(node_fruit_23_66);
  nodes["fruit-23"] = node_fruit_23_66;
  const mesh_fruit_23_66Geometry = endpoint_fruit_23_66
    ? new THREE.CylinderGeometry(endpoint_fruit_23_66.endRadius, endpoint_fruit_23_66.baseRadius, endpoint_fruit_23_66.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_fruit_23_66) {
    mesh_fruit_23_66Geometry.scale(0.104, 0.09879999999999999, 0.104);
  }
  const mesh_fruit_23_66 = new THREE.Mesh(
    mesh_fruit_23_66Geometry,
    materialMap["fruit-green"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_fruit_23_66.name = "Truss 3 fruit 4";
  if (endpoint_fruit_23_66) {
    mesh_fruit_23_66.position.copy(endpoint_fruit_23_66.midpoint);
    mesh_fruit_23_66.quaternion.copy(endpoint_fruit_23_66.quaternion);
  }
  mesh_fruit_23_66.castShadow = options.castShadow ?? true;
  mesh_fruit_23_66.receiveShadow = options.receiveShadow ?? true;
  mesh_fruit_23_66.userData.sculptComponent = {"id": "fruit-23", "name": "Truss 3 fruit 4", "level": "micro", "role": "fruit", "importance": 0.7, "confidence": 0.75, "primitive": "sphere", "topologyClass": "assembled-solid", "topologyRationale": "Glossy round cherry.", "geometryDescriptor": {"topologyIntent": "Glossy round cherry. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "peduncle-2", "attachment": {"parentId": "peduncle-2", "parentSocket": "peduncle-2:node", "localStart": [0.3, -0.168, 0.0], "localEnd": [0.3, -0.272, 0.0], "contactType": "butt", "embedDepth": 0.004, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.104, "height": 0.09879999999999999, "depth": 0.104, "units": "relative", "confidence": 0.8}, "transform": {"position": [0.3, -0.22, 0.0], "rotation": [0, 0, 0], "scale": [0.104, 0.09879999999999999, 0.104]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "fruit-23", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "fruit-green", "materialLayers": ["fruit-green"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "ripeness", "kind": "stain", "description": "unripe green", "evidenceRefs": ["full-object"]}, {"id": "calyx", "kind": "bevel", "description": "calyx star (not modelled at in-app scale)", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.2, "microRoughness": 0.02, "bumpAmplitude": 0.0, "normalPattern": "smooth glossy skin", "displacementPattern": "", "occlusionPattern": "AO between touching fruits and under the calyx", "edgeWearPattern": "", "notes": "clearcoat highlight"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(141, 190, 74, 1.0)", "secondaryAlbedo": "rgba(111, 160, 52, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_fruit_23_66.add(mesh_fruit_23_66);
  meshes["fruit-23"] = mesh_fruit_23_66;
  colliders["fruit-23"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["fruit-23"] ??= [];
  destructionGroups["fruit-23"].push(node_fruit_23_66);
  // repetition system "compound-leaves" describes 12 parts that are already built individually; not instanced.
  // repetition system "leaflets" describes 36 parts that are already built individually; not instanced.
  // repetition system "fruit-trusses" describes 12 parts that are already built individually; not instanced.

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createCherryTomatoPlantLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Cherry tomato plant look-dev lights";
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
  lights.userData.lightingFromPhoto = [{"id": "key", "type": "sun", "direction": "top-right, warm late light", "intensity": "high", "color": "#FFF4E0", "evidence": "sharp highlights on fruit, bright deck boards", "hostMapping": "DirectionalLight (3,7,4) 2.2"}, {"id": "fill", "type": "sky", "direction": "above", "intensity": "medium", "color": "#EAF0F4", "evidence": "open shade on inner leaves", "hostMapping": "HemisphereLight 1.6 + Ambient 0.9"}, {"id": "rim", "type": "back light", "direction": "behind-right", "intensity": "medium", "color": "#FFF4E0", "evidence": "bright leaf edges top-right", "hostMapping": "none"}, {"id": "exposure-shadow", "type": "render settings", "exposure": "neutral 1.0, sRGB, no tone mapping (host renderer); photo is graded warm", "contactShadow": "bush casts soft contact shadow on the soil; AO between fruits", "evidence": "dark soil under the foliage"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createCherryTomatoPlantEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
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
export function frameCherryTomatoPlantCamera(
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
export function createCherryTomatoPlantPresentationComposer(
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

export function configureCherryTomatoPlantRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createCherryTomatoPlantInspectControls(
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
