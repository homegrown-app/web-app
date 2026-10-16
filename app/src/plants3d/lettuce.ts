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

// Generated from ObjectSculptSpec target: Lettuce plant
// Sculpt build pass: optimization-pass
// This factory is intentionally pass-gated. Finish browser screenshot review before unlocking deeper passes.
export function createLettucePlantModel(options: ProceduralModelOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = "Lettuce plant";
  root.userData.reconstructionEvidence = {"itemFamily": null, "subtype": null, "componentAdapter": null, "route": null, "exactnessTier": null, "referenceCamera": {"solved": false, "fovDegrees": 40.0, "aspect": 1.0, "orientation": {"yaw": 0.0, "pitch": 0.0, "roll": 0.0}, "positionHint": [0.0, 0.0, 3.0], "note": "For likeness work, solve the reference camera (forge/stage1_intake/solve_camera_pose.py) so the review render aligns with the photo and the reference can be projected. Confirm by overlay review."}, "approximationNotes": []};
  root.userData.materialPipeline = {};
  root.userData.materialReferenceRegistry = null;

  const materialMap: Record<string, THREE.Material> = {};
  materialMap["leaf"] = createSculptMaterial(
    "leaf",
    {"id": "leaf", "name": "Lettuce outer leaf (satin)", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#7CC94F", "color": "#7CC94F", "albedo": {"dominant": "#7CC94F", "secondary": ["#4E8A2A", "#A9D45C"], "samplingNotes": "Sampled from reference regions; see image-analysis.md L6."}, "colorVariation": {"palette": ["#7CC94F"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.45, "variation": 0.08, "map": "independent-procedural-field", "localResponse": "satin on lit faces, rougher toward margins"}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "pale-base", "region": "leaf bases and midribs", "effect": "albedo #D6EBA8 toward the base", "evidenceRefs": ["full-object"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "doubleSided": true, "flatShading": true, "textureless": {"declared": true, "evidence": ["Style target is the host scene: Kenney Nature Kit models in Garden3D.tsx are flat-shaded solid-colour materials with no texture maps (measured: no map/normalMap on any Kenney material after GLTFLoader).", "User directive 2026-10-08: match the scene style (bigger, simpler, fewer details)."]}},
    options
  );
  materialMap["leaf-heart"] = createSculptMaterial(
    "leaf-heart",
    {"id": "leaf-heart", "name": "Lettuce heart leaf (lighter, glossier)", "type": "standard", "shaderModel": "MeshStandardMaterial / PBR approximation", "baseColor": "#B4E27A", "color": "#B4E27A", "albedo": {"dominant": "#B4E27A", "secondary": ["#9CCF55", "#D6EBA8"], "samplingNotes": "Sampled from reference regions; see image-analysis.md L6."}, "colorVariation": {"palette": ["#B4E27A"], "pattern": "flat", "amplitude": 0.0, "heightCorrelation": 0.0}, "roughness": {"base": 0.3, "variation": 0.08, "map": "independent-procedural-field", "localResponse": "satin on lit faces, rougher toward margins"}, "metalness": {"base": 0.0, "variation": 0.0}, "ambientOcclusion": {"cavityStrength": 0.25, "contactShadowBias": 0.35, "notes": "Darken creases, seams, intersections, and recessed local features."}, "wear": {"edgeWear": 0.0, "scratches": [], "chips": []}, "dirt": {"amount": 0.0, "cavityBias": 0.0, "color": "#2F2A22"}, "localOverrides": [{"id": "heart-tint", "region": "heart leaves", "effect": "lighter albedo, roughness 0.3", "evidenceRefs": ["full-object"]}], "shaderNotes": ["Prefer MeshPhysicalMaterial when clearcoat, sheen, transmission, or thin-surface response is observed; otherwise use MeshStandardMaterial-compatible PBR channels.", "Generate albedo, roughness, height/normal, and AO independently; never alias albedo into roughness.", "Use normal/bump/displacement only when they map to observed surface relief.", "Use displacement geometry when the observed relief changes the close-up silhouette; texture-only relief is insufficient there."], "notes": "Replace with image-derived color, roughness, noise, and edge-wear notes.", "doubleSided": true, "flatShading": true, "clearcoat": {"base": 0.3, "variation": 0.0}, "textureless": {"declared": true, "evidence": ["Style target is the host scene: Kenney Nature Kit models in Garden3D.tsx are flat-shaded solid-colour materials with no texture maps (measured: no map/normalMap on any Kenney material after GLTFLoader).", "User directive 2026-10-08: match the scene style (bigger, simpler, fewer details)."]}},
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
  node_soil_disc_0.userData.sculptComponent = {"id": "soil-disc", "name": "Soil disc", "level": "macro", "role": "base", "importance": 0.5, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Flat soil disc the head sits in; seats into any host pot.", "geometryDescriptor": {"topologyIntent": "Flat soil disc the head sits in; seats into any host pot. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 0.92, "height": 0.06, "depth": 0.92, "units": "relative", "confidence": 0.6}, "transform": {"position": [0, -0.03, 0], "rotation": [0, 0, 0], "scale": [0.92, 0.06, 0.92]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soil-disc", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "soil", "materialLayers": ["soil"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "perlite-flecks", "kind": "stain", "description": "pale flecks", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.95, "microRoughness": 0.2, "bumpAmplitude": 0.02, "normalPattern": "granular crumbs", "displacementPattern": "", "occlusionPattern": "contact AO under the outer whorl", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 28, 20, 1.0)", "secondaryAlbedo": "rgba(58, 40, 28, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
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
  mesh_soil_disc_0.userData.sculptComponent = {"id": "soil-disc", "name": "Soil disc", "level": "macro", "role": "base", "importance": 0.5, "confidence": 0.75, "primitive": "cylinder", "topologyClass": "assembled-solid", "topologyRationale": "Flat soil disc the head sits in; seats into any host pot.", "geometryDescriptor": {"topologyIntent": "Flat soil disc the head sits in; seats into any host pot. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": null, "attachment": null, "dimensions": {"width": 0.92, "height": 0.06, "depth": 0.92, "units": "relative", "confidence": 0.6}, "transform": {"position": [0, -0.03, 0], "rotation": [0, 0, 0], "scale": [0.92, 0.06, 0.92]}, "actionProfile": {"animationRole": "root", "pivot": {"mode": "base", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "cylinder", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "soil-disc", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "soil", "materialLayers": ["soil"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "perlite-flecks", "kind": "stain", "description": "pale flecks", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.95, "microRoughness": 0.2, "bumpAmplitude": 0.02, "normalPattern": "granular crumbs", "displacementPattern": "", "occlusionPattern": "contact AO under the outer whorl", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(42, 28, 20, 1.0)", "secondaryAlbedo": "rgba(58, 40, 28, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_soil_disc_0.add(mesh_soil_disc_0);
  meshes["soil-disc"] = mesh_soil_disc_0;
  colliders["soil-disc"] = {"type": "cylinder", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["soil-disc"] ??= [];
  destructionGroups["soil-disc"].push(node_soil_disc_0);

  const endpoint_heart_core_1 = makeAttachmentEndpoint(null);
  const node_heart_core_1 = new THREE.Group();
  node_heart_core_1.name = "Heart core__pivot";
  node_heart_core_1.scale.set(1, 1, 1);
  if (endpoint_heart_core_1) {
    node_heart_core_1.position.copy(endpoint_heart_core_1.start);
    node_heart_core_1.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_heart_core_1.position.set(0.0, 0.12, 0.0);
    node_heart_core_1.rotation.set(0.0, 0.0, 0.0);
  }
  node_heart_core_1.userData.sculptComponent = {"id": "heart-core", "name": "Heart core", "level": "macro", "role": "core", "importance": 0.7, "confidence": 0.75, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Pale core under the heart leaves; embedded in the soil.", "geometryDescriptor": {"topologyIntent": "Pale core under the heart leaves; embedded in the soil. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "soil-disc", "attachment": {"parentId": "soil-disc", "parentSocket": "soil-disc:node", "localStart": [0, 0.0, 0], "localEnd": [0, 0.23, 0], "contactType": "embed", "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.2, "height": 0.22, "depth": 0.2, "units": "relative", "confidence": 0.5}, "transform": {"position": [0, 0.12, 0], "rotation": [0, 0, 0], "scale": [0.2, 0.22, 0.2]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "heart-core", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf-heart", "materialLayers": ["leaf-heart"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "core", "kind": "bevel", "description": "pale core", "evidenceRefs": ["full-object"]}, {"id": "heart", "kind": "contour", "description": "tight heart", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.4, "microRoughness": 0.05, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "AO between heart leaves", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(181, 220, 106, 1.0)", "secondaryAlbedo": "rgba(156, 207, 85, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_heart_core_1.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "heart-core", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["soil-disc"] ?? root).add(node_heart_core_1);
  nodes["heart-core"] = node_heart_core_1;
  const mesh_heart_core_1Geometry = endpoint_heart_core_1
    ? new THREE.CylinderGeometry(endpoint_heart_core_1.endRadius, endpoint_heart_core_1.baseRadius, endpoint_heart_core_1.length, 8, 4)
    : new THREE.SphereGeometry(0.5, 16, 10);
  if (!endpoint_heart_core_1) {
    mesh_heart_core_1Geometry.scale(0.2, 0.22, 0.2);
  }
  const mesh_heart_core_1 = new THREE.Mesh(
    mesh_heart_core_1Geometry,
    materialMap["leaf-heart"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_heart_core_1.name = "Heart core";
  if (endpoint_heart_core_1) {
    mesh_heart_core_1.position.copy(endpoint_heart_core_1.midpoint);
    mesh_heart_core_1.quaternion.copy(endpoint_heart_core_1.quaternion);
  }
  mesh_heart_core_1.castShadow = options.castShadow ?? true;
  mesh_heart_core_1.receiveShadow = options.receiveShadow ?? true;
  mesh_heart_core_1.userData.sculptComponent = {"id": "heart-core", "name": "Heart core", "level": "macro", "role": "core", "importance": 0.7, "confidence": 0.75, "primitive": "ellipsoid", "topologyClass": "continuous-sculpt", "topologyRationale": "Pale core under the heart leaves; embedded in the soil.", "geometryDescriptor": {"topologyIntent": "Pale core under the heart leaves; embedded in the soil. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry"}, "parent": "soil-disc", "attachment": {"parentId": "soil-disc", "parentSocket": "soil-disc:node", "localStart": [0, 0.0, 0], "localEnd": [0, 0.23, 0], "contactType": "embed", "embedDepth": 0.02, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 0.2, "height": 0.22, "depth": 0.2, "units": "relative", "confidence": 0.5}, "transform": {"position": [0, 0.12, 0], "rotation": [0, 0, 0], "scale": [0.2, 0.22, 0.2]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "heart-core", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf-heart", "materialLayers": ["leaf-heart"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "core", "kind": "bevel", "description": "pale core", "evidenceRefs": ["full-object"]}, {"id": "heart", "kind": "contour", "description": "tight heart", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.4, "microRoughness": 0.05, "bumpAmplitude": 0.0, "normalPattern": "smooth", "displacementPattern": "", "occlusionPattern": "AO between heart leaves", "edgeWearPattern": "", "notes": ""}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(181, 220, 106, 1.0)", "secondaryAlbedo": "rgba(156, 207, 85, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_heart_core_1.add(mesh_heart_core_1);
  meshes["heart-core"] = mesh_heart_core_1;
  colliders["heart-core"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["heart-core"] ??= [];
  destructionGroups["heart-core"].push(node_heart_core_1);

  const endpoint_outer_0_2 = makeAttachmentEndpoint(null);
  const node_outer_0_2 = new THREE.Group();
  node_outer_0_2.name = "Outer leaf 1__pivot";
  node_outer_0_2.scale.set(1, 1, 1);
  if (endpoint_outer_0_2) {
    node_outer_0_2.position.copy(endpoint_outer_0_2.start);
    node_outer_0_2.rotation.set(0.0, 0.0, 0.0);
  } else {
    node_outer_0_2.position.set(0.05, -0.09, 0.0);
    node_outer_0_2.rotation.set(0.0, 0.0, 0.0);
  }
  node_outer_0_2.userData.sculptComponent = {"id": "outer-0", "name": "Outer leaf 1", "level": "meso", "role": "leaf", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the outer whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the outer whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0333, 0.0204, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0695, 0.0488, 0.0], "rx": 0.0219, "rz": 0.0139, "twist": -22}, {"position": [0.1405, 0.095, 0.0], "rx": 0.1194, "rz": 0.0756, "twist": -22}, {"position": [0.2116, 0.127, 0.0], "rx": 0.1853, "rz": 0.1174, "twist": -22}, {"position": [0.2826, 0.1447, 0.0], "rx": 0.2037, "rz": 0.1291, "twist": -22}, {"position": [0.3537, 0.1483, 0.0], "rx": 0.1508, "rz": 0.0956, "twist": -22}, {"position": [0.4247, 0.1376, 0.0], "rx": 0.0, "rz": 0.0, "twist": -22}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [0.05, -0.09, 0.0], "localEnd": [0.4747, 0.0476, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.05, -0.09, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "outer-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "outer whorl, offset 0 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 198, 63, 1.0)", "secondaryAlbedo": "rgba(78, 138, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_outer_0_2.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "outer-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["heart-core"] ?? root).add(node_outer_0_2);
  nodes["outer-0"] = node_outer_0_2;
  const mesh_outer_0_2Geometry = endpoint_outer_0_2
    ? new THREE.CylinderGeometry(endpoint_outer_0_2.endRadius, endpoint_outer_0_2.baseRadius, endpoint_outer_0_2.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0333, 0.0204, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0695, 0.0488, 0.0], "rx": 0.0219, "rz": 0.0139, "twist": -22}, {"position": [0.1405, 0.095, 0.0], "rx": 0.1194, "rz": 0.0756, "twist": -22}, {"position": [0.2116, 0.127, 0.0], "rx": 0.1853, "rz": 0.1174, "twist": -22}, {"position": [0.2826, 0.1447, 0.0], "rx": 0.2037, "rz": 0.1291, "twist": -22}, {"position": [0.3537, 0.1483, 0.0], "rx": 0.1508, "rz": 0.0956, "twist": -22}, {"position": [0.4247, 0.1376, 0.0], "rx": 0.0, "rz": 0.0, "twist": -22}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_outer_0_2) {
    mesh_outer_0_2Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_outer_0_2 = new THREE.Mesh(
    mesh_outer_0_2Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_outer_0_2.name = "Outer leaf 1";
  if (endpoint_outer_0_2) {
    mesh_outer_0_2.position.copy(endpoint_outer_0_2.midpoint);
    mesh_outer_0_2.quaternion.copy(endpoint_outer_0_2.quaternion);
  }
  mesh_outer_0_2.castShadow = options.castShadow ?? true;
  mesh_outer_0_2.receiveShadow = options.receiveShadow ?? true;
  mesh_outer_0_2.userData.sculptComponent = {"id": "outer-0", "name": "Outer leaf 1", "level": "meso", "role": "leaf", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the outer whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the outer whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0333, 0.0204, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0695, 0.0488, 0.0], "rx": 0.0219, "rz": 0.0139, "twist": -22}, {"position": [0.1405, 0.095, 0.0], "rx": 0.1194, "rz": 0.0756, "twist": -22}, {"position": [0.2116, 0.127, 0.0], "rx": 0.1853, "rz": 0.1174, "twist": -22}, {"position": [0.2826, 0.1447, 0.0], "rx": 0.2037, "rz": 0.1291, "twist": -22}, {"position": [0.3537, 0.1483, 0.0], "rx": 0.1508, "rz": 0.0956, "twist": -22}, {"position": [0.4247, 0.1376, 0.0], "rx": 0.0, "rz": 0.0, "twist": -22}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [0.05, -0.09, 0.0], "localEnd": [0.4747, 0.0476, 0.0], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.05, -0.09, 0.0], "rotation": [0, 0.0, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "outer-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "outer whorl, offset 0 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 198, 63, 1.0)", "secondaryAlbedo": "rgba(78, 138, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_outer_0_2.add(mesh_outer_0_2);
  meshes["outer-0"] = mesh_outer_0_2;
  colliders["outer-0"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["outer-0"] ??= [];
  destructionGroups["outer-0"].push(node_outer_0_2);

  const endpoint_outer_1_3 = makeAttachmentEndpoint(null);
  const node_outer_1_3 = new THREE.Group();
  node_outer_1_3.name = "Outer leaf 2__pivot";
  node_outer_1_3.scale.set(1, 1, 1);
  if (endpoint_outer_1_3) {
    node_outer_1_3.position.copy(endpoint_outer_1_3.start);
    node_outer_1_3.rotation.set(0.0, 1.1828, 0.0);
  } else {
    node_outer_1_3.position.set(0.0189, -0.09, -0.0463);
    node_outer_1_3.rotation.set(0.0, 1.1828, 0.0);
  }
  node_outer_1_3.userData.sculptComponent = {"id": "outer-1", "name": "Outer leaf 2", "level": "meso", "role": "leaf", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the outer whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the outer whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0361, 0.0221, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0754, 0.0529, 0.0], "rx": 0.0238, "rz": 0.0151, "twist": 22}, {"position": [0.1524, 0.103, 0.0], "rx": 0.1295, "rz": 0.0821, "twist": 22}, {"position": [0.2295, 0.1377, 0.0], "rx": 0.201, "rz": 0.1274, "twist": 22}, {"position": [0.3065, 0.1569, 0.0], "rx": 0.221, "rz": 0.14, "twist": 22}, {"position": [0.3836, 0.1608, 0.0], "rx": 0.1636, "rz": 0.1037, "twist": 22}, {"position": [0.4606, 0.1492, 0.0], "rx": 0.0, "rz": 0.0, "twist": 22}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [0.0189, -0.09, -0.0463], "localEnd": [0.1932, 0.0592, -0.4727], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0189, -0.09, -0.0463], "rotation": [0, 1.1828, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "outer-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "outer whorl, offset 0 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 198, 63, 1.0)", "secondaryAlbedo": "rgba(78, 138, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_outer_1_3.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "outer-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["heart-core"] ?? root).add(node_outer_1_3);
  nodes["outer-1"] = node_outer_1_3;
  const mesh_outer_1_3Geometry = endpoint_outer_1_3
    ? new THREE.CylinderGeometry(endpoint_outer_1_3.endRadius, endpoint_outer_1_3.baseRadius, endpoint_outer_1_3.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0361, 0.0221, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0754, 0.0529, 0.0], "rx": 0.0238, "rz": 0.0151, "twist": 22}, {"position": [0.1524, 0.103, 0.0], "rx": 0.1295, "rz": 0.0821, "twist": 22}, {"position": [0.2295, 0.1377, 0.0], "rx": 0.201, "rz": 0.1274, "twist": 22}, {"position": [0.3065, 0.1569, 0.0], "rx": 0.221, "rz": 0.14, "twist": 22}, {"position": [0.3836, 0.1608, 0.0], "rx": 0.1636, "rz": 0.1037, "twist": 22}, {"position": [0.4606, 0.1492, 0.0], "rx": 0.0, "rz": 0.0, "twist": 22}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_outer_1_3) {
    mesh_outer_1_3Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_outer_1_3 = new THREE.Mesh(
    mesh_outer_1_3Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_outer_1_3.name = "Outer leaf 2";
  if (endpoint_outer_1_3) {
    mesh_outer_1_3.position.copy(endpoint_outer_1_3.midpoint);
    mesh_outer_1_3.quaternion.copy(endpoint_outer_1_3.quaternion);
  }
  mesh_outer_1_3.castShadow = options.castShadow ?? true;
  mesh_outer_1_3.receiveShadow = options.receiveShadow ?? true;
  mesh_outer_1_3.userData.sculptComponent = {"id": "outer-1", "name": "Outer leaf 2", "level": "meso", "role": "leaf", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the outer whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the outer whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0361, 0.0221, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0754, 0.0529, 0.0], "rx": 0.0238, "rz": 0.0151, "twist": 22}, {"position": [0.1524, 0.103, 0.0], "rx": 0.1295, "rz": 0.0821, "twist": 22}, {"position": [0.2295, 0.1377, 0.0], "rx": 0.201, "rz": 0.1274, "twist": 22}, {"position": [0.3065, 0.1569, 0.0], "rx": 0.221, "rz": 0.14, "twist": 22}, {"position": [0.3836, 0.1608, 0.0], "rx": 0.1636, "rz": 0.1037, "twist": 22}, {"position": [0.4606, 0.1492, 0.0], "rx": 0.0, "rz": 0.0, "twist": 22}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [0.0189, -0.09, -0.0463], "localEnd": [0.1932, 0.0592, -0.4727], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0189, -0.09, -0.0463], "rotation": [0, 1.1828, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "outer-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "outer whorl, offset 0 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 198, 63, 1.0)", "secondaryAlbedo": "rgba(78, 138, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_outer_1_3.add(mesh_outer_1_3);
  meshes["outer-1"] = mesh_outer_1_3;
  colliders["outer-1"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["outer-1"] ??= [];
  destructionGroups["outer-1"].push(node_outer_1_3);

  const endpoint_outer_2_4 = makeAttachmentEndpoint(null);
  const node_outer_2_4 = new THREE.Group();
  node_outer_2_4.name = "Outer leaf 3__pivot";
  node_outer_2_4.scale.set(1, 1, 1);
  if (endpoint_outer_2_4) {
    node_outer_2_4.position.copy(endpoint_outer_2_4.start);
    node_outer_2_4.rotation.set(0.0, 1.9575, 0.0);
  } else {
    node_outer_2_4.position.set(-0.0189, -0.09, -0.0463);
    node_outer_2_4.rotation.set(0.0, 1.9575, 0.0);
  }
  node_outer_2_4.userData.sculptComponent = {"id": "outer-2", "name": "Outer leaf 3", "level": "meso", "role": "leaf", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the outer whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the outer whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0389, 0.0238, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0811, 0.057, 0.0], "rx": 0.0256, "rz": 0.0162, "twist": -22}, {"position": [0.164, 0.1108, 0.0], "rx": 0.1394, "rz": 0.0884, "twist": -22}, {"position": [0.2469, 0.1481, 0.0], "rx": 0.2163, "rz": 0.137, "twist": -22}, {"position": [0.3298, 0.1689, 0.0], "rx": 0.2378, "rz": 0.1507, "twist": -22}, {"position": [0.4127, 0.173, 0.0], "rx": 0.176, "rz": 0.1116, "twist": -22}, {"position": [0.4956, 0.1606, 0.0], "rx": 0.0, "rz": 0.0, "twist": -22}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [-0.0189, -0.09, -0.0463], "localEnd": [-0.2058, 0.0706, -0.5053], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.0189, -0.09, -0.0463], "rotation": [0, 1.9575, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "outer-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "outer whorl, offset 0 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 198, 63, 1.0)", "secondaryAlbedo": "rgba(78, 138, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_outer_2_4.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "outer-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["heart-core"] ?? root).add(node_outer_2_4);
  nodes["outer-2"] = node_outer_2_4;
  const mesh_outer_2_4Geometry = endpoint_outer_2_4
    ? new THREE.CylinderGeometry(endpoint_outer_2_4.endRadius, endpoint_outer_2_4.baseRadius, endpoint_outer_2_4.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0389, 0.0238, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0811, 0.057, 0.0], "rx": 0.0256, "rz": 0.0162, "twist": -22}, {"position": [0.164, 0.1108, 0.0], "rx": 0.1394, "rz": 0.0884, "twist": -22}, {"position": [0.2469, 0.1481, 0.0], "rx": 0.2163, "rz": 0.137, "twist": -22}, {"position": [0.3298, 0.1689, 0.0], "rx": 0.2378, "rz": 0.1507, "twist": -22}, {"position": [0.4127, 0.173, 0.0], "rx": 0.176, "rz": 0.1116, "twist": -22}, {"position": [0.4956, 0.1606, 0.0], "rx": 0.0, "rz": 0.0, "twist": -22}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_outer_2_4) {
    mesh_outer_2_4Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_outer_2_4 = new THREE.Mesh(
    mesh_outer_2_4Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_outer_2_4.name = "Outer leaf 3";
  if (endpoint_outer_2_4) {
    mesh_outer_2_4.position.copy(endpoint_outer_2_4.midpoint);
    mesh_outer_2_4.quaternion.copy(endpoint_outer_2_4.quaternion);
  }
  mesh_outer_2_4.castShadow = options.castShadow ?? true;
  mesh_outer_2_4.receiveShadow = options.receiveShadow ?? true;
  mesh_outer_2_4.userData.sculptComponent = {"id": "outer-2", "name": "Outer leaf 3", "level": "meso", "role": "leaf", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the outer whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the outer whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0389, 0.0238, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0811, 0.057, 0.0], "rx": 0.0256, "rz": 0.0162, "twist": -22}, {"position": [0.164, 0.1108, 0.0], "rx": 0.1394, "rz": 0.0884, "twist": -22}, {"position": [0.2469, 0.1481, 0.0], "rx": 0.2163, "rz": 0.137, "twist": -22}, {"position": [0.3298, 0.1689, 0.0], "rx": 0.2378, "rz": 0.1507, "twist": -22}, {"position": [0.4127, 0.173, 0.0], "rx": 0.176, "rz": 0.1116, "twist": -22}, {"position": [0.4956, 0.1606, 0.0], "rx": 0.0, "rz": 0.0, "twist": -22}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [-0.0189, -0.09, -0.0463], "localEnd": [-0.2058, 0.0706, -0.5053], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.0189, -0.09, -0.0463], "rotation": [0, 1.9575, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "outer-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "outer whorl, offset 0 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 198, 63, 1.0)", "secondaryAlbedo": "rgba(78, 138, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_outer_2_4.add(mesh_outer_2_4);
  meshes["outer-2"] = mesh_outer_2_4;
  colliders["outer-2"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["outer-2"] ??= [];
  destructionGroups["outer-2"].push(node_outer_2_4);

  const endpoint_outer_3_5 = makeAttachmentEndpoint(null);
  const node_outer_3_5 = new THREE.Group();
  node_outer_3_5.name = "Outer leaf 4__pivot";
  node_outer_3_5.scale.set(1, 1, 1);
  if (endpoint_outer_3_5) {
    node_outer_3_5.position.copy(endpoint_outer_3_5.start);
    node_outer_3_5.rotation.set(0.0, 3.1442, 0.0);
  } else {
    node_outer_3_5.position.set(-0.05, -0.09, 0.0001);
    node_outer_3_5.rotation.set(0.0, 3.1442, 0.0);
  }
  node_outer_3_5.userData.sculptComponent = {"id": "outer-3", "name": "Outer leaf 4", "level": "meso", "role": "leaf", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the outer whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the outer whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0375, 0.023, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0783, 0.055, 0.0], "rx": 0.0247, "rz": 0.0157, "twist": 22}, {"position": [0.1583, 0.107, 0.0], "rx": 0.1345, "rz": 0.0853, "twist": 22}, {"position": [0.2383, 0.143, 0.0], "rx": 0.2088, "rz": 0.1323, "twist": 22}, {"position": [0.3184, 0.163, 0.0], "rx": 0.2295, "rz": 0.1454, "twist": 22}, {"position": [0.3984, 0.167, 0.0], "rx": 0.1699, "rz": 0.1076, "twist": 22}, {"position": [0.4784, 0.155, 0.0], "rx": 0.0, "rz": 0.0, "twist": 22}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [-0.05, -0.09, 0.0001], "localEnd": [-0.5284, 0.065, 0.0014], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.05, -0.09, 0.0001], "rotation": [0, 3.1442, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "outer-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "outer whorl, offset 0 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 198, 63, 1.0)", "secondaryAlbedo": "rgba(78, 138, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_outer_3_5.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "outer-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["heart-core"] ?? root).add(node_outer_3_5);
  nodes["outer-3"] = node_outer_3_5;
  const mesh_outer_3_5Geometry = endpoint_outer_3_5
    ? new THREE.CylinderGeometry(endpoint_outer_3_5.endRadius, endpoint_outer_3_5.baseRadius, endpoint_outer_3_5.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0375, 0.023, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0783, 0.055, 0.0], "rx": 0.0247, "rz": 0.0157, "twist": 22}, {"position": [0.1583, 0.107, 0.0], "rx": 0.1345, "rz": 0.0853, "twist": 22}, {"position": [0.2383, 0.143, 0.0], "rx": 0.2088, "rz": 0.1323, "twist": 22}, {"position": [0.3184, 0.163, 0.0], "rx": 0.2295, "rz": 0.1454, "twist": 22}, {"position": [0.3984, 0.167, 0.0], "rx": 0.1699, "rz": 0.1076, "twist": 22}, {"position": [0.4784, 0.155, 0.0], "rx": 0.0, "rz": 0.0, "twist": 22}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_outer_3_5) {
    mesh_outer_3_5Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_outer_3_5 = new THREE.Mesh(
    mesh_outer_3_5Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_outer_3_5.name = "Outer leaf 4";
  if (endpoint_outer_3_5) {
    mesh_outer_3_5.position.copy(endpoint_outer_3_5.midpoint);
    mesh_outer_3_5.quaternion.copy(endpoint_outer_3_5.quaternion);
  }
  mesh_outer_3_5.castShadow = options.castShadow ?? true;
  mesh_outer_3_5.receiveShadow = options.receiveShadow ?? true;
  mesh_outer_3_5.userData.sculptComponent = {"id": "outer-3", "name": "Outer leaf 4", "level": "meso", "role": "leaf", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the outer whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the outer whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0375, 0.023, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0783, 0.055, 0.0], "rx": 0.0247, "rz": 0.0157, "twist": 22}, {"position": [0.1583, 0.107, 0.0], "rx": 0.1345, "rz": 0.0853, "twist": 22}, {"position": [0.2383, 0.143, 0.0], "rx": 0.2088, "rz": 0.1323, "twist": 22}, {"position": [0.3184, 0.163, 0.0], "rx": 0.2295, "rz": 0.1454, "twist": 22}, {"position": [0.3984, 0.167, 0.0], "rx": 0.1699, "rz": 0.1076, "twist": 22}, {"position": [0.4784, 0.155, 0.0], "rx": 0.0, "rz": 0.0, "twist": 22}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [-0.05, -0.09, 0.0001], "localEnd": [-0.5284, 0.065, 0.0014], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.05, -0.09, 0.0001], "rotation": [0, 3.1442, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "outer-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "outer whorl, offset 0 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 198, 63, 1.0)", "secondaryAlbedo": "rgba(78, 138, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_outer_3_5.add(mesh_outer_3_5);
  meshes["outer-3"] = mesh_outer_3_5;
  colliders["outer-3"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["outer-3"] ??= [];
  destructionGroups["outer-3"].push(node_outer_3_5);

  const endpoint_outer_4_6 = makeAttachmentEndpoint(null);
  const node_outer_4_6 = new THREE.Group();
  node_outer_4_6.name = "Outer leaf 5__pivot";
  node_outer_4_6.scale.set(1, 1, 1);
  if (endpoint_outer_4_6) {
    node_outer_4_6.position.copy(endpoint_outer_4_6.start);
    node_outer_4_6.rotation.set(0.0, 4.323, 0.0);
  } else {
    node_outer_4_6.position.set(-0.019, -0.09, 0.0463);
    node_outer_4_6.rotation.set(0.0, 4.323, 0.0);
  }
  node_outer_4_6.userData.sculptComponent = {"id": "outer-4", "name": "Outer leaf 5", "level": "meso", "role": "leaf", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the outer whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the outer whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.034, 0.0208, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0711, 0.0499, 0.0], "rx": 0.0224, "rz": 0.0142, "twist": -22}, {"position": [0.1437, 0.0971, 0.0], "rx": 0.1221, "rz": 0.0774, "twist": -22}, {"position": [0.2163, 0.1298, 0.0], "rx": 0.1895, "rz": 0.1201, "twist": -22}, {"position": [0.289, 0.148, 0.0], "rx": 0.2083, "rz": 0.1319, "twist": -22}, {"position": [0.3616, 0.1516, 0.0], "rx": 0.1542, "rz": 0.0977, "twist": -22}, {"position": [0.4342, 0.1407, 0.0], "rx": 0.0, "rz": 0.0, "twist": -22}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [-0.019, -0.09, 0.0463], "localEnd": [-0.1838, 0.0507, 0.448], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.019, -0.09, 0.0463], "rotation": [0, 4.323, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "outer-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "outer whorl, offset 0 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 198, 63, 1.0)", "secondaryAlbedo": "rgba(78, 138, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_outer_4_6.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "outer-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["heart-core"] ?? root).add(node_outer_4_6);
  nodes["outer-4"] = node_outer_4_6;
  const mesh_outer_4_6Geometry = endpoint_outer_4_6
    ? new THREE.CylinderGeometry(endpoint_outer_4_6.endRadius, endpoint_outer_4_6.baseRadius, endpoint_outer_4_6.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.034, 0.0208, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0711, 0.0499, 0.0], "rx": 0.0224, "rz": 0.0142, "twist": -22}, {"position": [0.1437, 0.0971, 0.0], "rx": 0.1221, "rz": 0.0774, "twist": -22}, {"position": [0.2163, 0.1298, 0.0], "rx": 0.1895, "rz": 0.1201, "twist": -22}, {"position": [0.289, 0.148, 0.0], "rx": 0.2083, "rz": 0.1319, "twist": -22}, {"position": [0.3616, 0.1516, 0.0], "rx": 0.1542, "rz": 0.0977, "twist": -22}, {"position": [0.4342, 0.1407, 0.0], "rx": 0.0, "rz": 0.0, "twist": -22}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_outer_4_6) {
    mesh_outer_4_6Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_outer_4_6 = new THREE.Mesh(
    mesh_outer_4_6Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_outer_4_6.name = "Outer leaf 5";
  if (endpoint_outer_4_6) {
    mesh_outer_4_6.position.copy(endpoint_outer_4_6.midpoint);
    mesh_outer_4_6.quaternion.copy(endpoint_outer_4_6.quaternion);
  }
  mesh_outer_4_6.castShadow = options.castShadow ?? true;
  mesh_outer_4_6.receiveShadow = options.receiveShadow ?? true;
  mesh_outer_4_6.userData.sculptComponent = {"id": "outer-4", "name": "Outer leaf 5", "level": "meso", "role": "leaf", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the outer whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the outer whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.034, 0.0208, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0711, 0.0499, 0.0], "rx": 0.0224, "rz": 0.0142, "twist": -22}, {"position": [0.1437, 0.0971, 0.0], "rx": 0.1221, "rz": 0.0774, "twist": -22}, {"position": [0.2163, 0.1298, 0.0], "rx": 0.1895, "rz": 0.1201, "twist": -22}, {"position": [0.289, 0.148, 0.0], "rx": 0.2083, "rz": 0.1319, "twist": -22}, {"position": [0.3616, 0.1516, 0.0], "rx": 0.1542, "rz": 0.0977, "twist": -22}, {"position": [0.4342, 0.1407, 0.0], "rx": 0.0, "rz": 0.0, "twist": -22}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [-0.019, -0.09, 0.0463], "localEnd": [-0.1838, 0.0507, 0.448], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.019, -0.09, 0.0463], "rotation": [0, 4.323, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "outer-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "outer whorl, offset 0 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 198, 63, 1.0)", "secondaryAlbedo": "rgba(78, 138, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_outer_4_6.add(mesh_outer_4_6);
  meshes["outer-4"] = mesh_outer_4_6;
  colliders["outer-4"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["outer-4"] ??= [];
  destructionGroups["outer-4"].push(node_outer_4_6);

  const endpoint_outer_5_7 = makeAttachmentEndpoint(null);
  const node_outer_5_7 = new THREE.Group();
  node_outer_5_7.name = "Outer leaf 6__pivot";
  node_outer_5_7.scale.set(1, 1, 1);
  if (endpoint_outer_5_7) {
    node_outer_5_7.position.copy(endpoint_outer_5_7.start);
    node_outer_5_7.rotation.set(0.0, 5.0978, 0.0);
  } else {
    node_outer_5_7.position.set(0.0188, -0.09, 0.0463);
    node_outer_5_7.rotation.set(0.0, 5.0978, 0.0);
  }
  node_outer_5_7.userData.sculptComponent = {"id": "outer-5", "name": "Outer leaf 6", "level": "meso", "role": "leaf", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the outer whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the outer whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0335, 0.0205, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.07, 0.0492, 0.0], "rx": 0.0221, "rz": 0.014, "twist": 22}, {"position": [0.1416, 0.0957, 0.0], "rx": 0.1203, "rz": 0.0761, "twist": 22}, {"position": [0.2131, 0.1279, 0.0], "rx": 0.1867, "rz": 0.1183, "twist": 22}, {"position": [0.2847, 0.1458, 0.0], "rx": 0.2052, "rz": 0.13, "twist": 22}, {"position": [0.3562, 0.1493, 0.0], "rx": 0.1519, "rz": 0.0963, "twist": 22}, {"position": [0.4278, 0.1386, 0.0], "rx": 0.0, "rz": 0.0, "twist": 22}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [0.0188, -0.09, 0.0463], "localEnd": [0.1796, 0.0486, 0.4427], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0188, -0.09, 0.0463], "rotation": [0, 5.0978, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "outer-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "outer whorl, offset 0 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 198, 63, 1.0)", "secondaryAlbedo": "rgba(78, 138, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_outer_5_7.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "outer-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["heart-core"] ?? root).add(node_outer_5_7);
  nodes["outer-5"] = node_outer_5_7;
  const mesh_outer_5_7Geometry = endpoint_outer_5_7
    ? new THREE.CylinderGeometry(endpoint_outer_5_7.endRadius, endpoint_outer_5_7.baseRadius, endpoint_outer_5_7.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0335, 0.0205, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.07, 0.0492, 0.0], "rx": 0.0221, "rz": 0.014, "twist": 22}, {"position": [0.1416, 0.0957, 0.0], "rx": 0.1203, "rz": 0.0761, "twist": 22}, {"position": [0.2131, 0.1279, 0.0], "rx": 0.1867, "rz": 0.1183, "twist": 22}, {"position": [0.2847, 0.1458, 0.0], "rx": 0.2052, "rz": 0.13, "twist": 22}, {"position": [0.3562, 0.1493, 0.0], "rx": 0.1519, "rz": 0.0963, "twist": 22}, {"position": [0.4278, 0.1386, 0.0], "rx": 0.0, "rz": 0.0, "twist": 22}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_outer_5_7) {
    mesh_outer_5_7Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_outer_5_7 = new THREE.Mesh(
    mesh_outer_5_7Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_outer_5_7.name = "Outer leaf 6";
  if (endpoint_outer_5_7) {
    mesh_outer_5_7.position.copy(endpoint_outer_5_7.midpoint);
    mesh_outer_5_7.quaternion.copy(endpoint_outer_5_7.quaternion);
  }
  mesh_outer_5_7.castShadow = options.castShadow ?? true;
  mesh_outer_5_7.receiveShadow = options.receiveShadow ?? true;
  mesh_outer_5_7.userData.sculptComponent = {"id": "outer-5", "name": "Outer leaf 6", "level": "meso", "role": "leaf", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the outer whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the outer whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0335, 0.0205, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.07, 0.0492, 0.0], "rx": 0.0221, "rz": 0.014, "twist": 22}, {"position": [0.1416, 0.0957, 0.0], "rx": 0.1203, "rz": 0.0761, "twist": 22}, {"position": [0.2131, 0.1279, 0.0], "rx": 0.1867, "rz": 0.1183, "twist": 22}, {"position": [0.2847, 0.1458, 0.0], "rx": 0.2052, "rz": 0.13, "twist": 22}, {"position": [0.3562, 0.1493, 0.0], "rx": 0.1519, "rz": 0.0963, "twist": 22}, {"position": [0.4278, 0.1386, 0.0], "rx": 0.0, "rz": 0.0, "twist": 22}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [0.0188, -0.09, 0.0463], "localEnd": [0.1796, 0.0486, 0.4427], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0188, -0.09, 0.0463], "rotation": [0, 5.0978, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "outer-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "outer whorl, offset 0 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 198, 63, 1.0)", "secondaryAlbedo": "rgba(78, 138, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_outer_5_7.add(mesh_outer_5_7);
  meshes["outer-5"] = mesh_outer_5_7;
  colliders["outer-5"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["outer-5"] ??= [];
  destructionGroups["outer-5"].push(node_outer_5_7);

  const endpoint_middle_0_8 = makeAttachmentEndpoint(null);
  const node_middle_0_8 = new THREE.Group();
  node_middle_0_8.name = "Middle leaf 1__pivot";
  node_middle_0_8.scale.set(1, 1, 1);
  if (endpoint_middle_0_8) {
    node_middle_0_8.position.copy(endpoint_middle_0_8.start);
    node_middle_0_8.rotation.set(0.0, 0.4538, 0.0);
  } else {
    node_middle_0_8.position.set(0.0315, -0.07, -0.0153);
    node_middle_0_8.rotation.set(0.0, 0.4538, 0.0);
  }
  node_middle_0_8.userData.sculptComponent = {"id": "middle-0", "name": "Middle leaf 1", "level": "meso", "role": "leaf", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the middle whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the middle whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0276, 0.045, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0576, 0.098, 0.0], "rx": 0.0182, "rz": 0.0137, "twist": -34}, {"position": [0.1165, 0.1863, 0.0], "rx": 0.099, "rz": 0.0742, "twist": -34}, {"position": [0.1753, 0.2511, 0.0], "rx": 0.1536, "rz": 0.115, "twist": -34}, {"position": [0.2342, 0.2923, 0.0], "rx": 0.1688, "rz": 0.1264, "twist": -34}, {"position": [0.2931, 0.31, 0.0], "rx": 0.125, "rz": 0.0936, "twist": -34}, {"position": [0.352, 0.3041, 0.0], "rx": 0.0, "rz": 0.0, "twist": -34}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [0.0315, -0.07, -0.0153], "localEnd": [0.3479, 0.2341, -0.1696], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0315, -0.07, -0.0153], "rotation": [0, 0.4538, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "middle whorl, offset 26 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 198, 63, 1.0)", "secondaryAlbedo": "rgba(78, 138, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_middle_0_8.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["heart-core"] ?? root).add(node_middle_0_8);
  nodes["middle-0"] = node_middle_0_8;
  const mesh_middle_0_8Geometry = endpoint_middle_0_8
    ? new THREE.CylinderGeometry(endpoint_middle_0_8.endRadius, endpoint_middle_0_8.baseRadius, endpoint_middle_0_8.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0276, 0.045, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0576, 0.098, 0.0], "rx": 0.0182, "rz": 0.0137, "twist": -34}, {"position": [0.1165, 0.1863, 0.0], "rx": 0.099, "rz": 0.0742, "twist": -34}, {"position": [0.1753, 0.2511, 0.0], "rx": 0.1536, "rz": 0.115, "twist": -34}, {"position": [0.2342, 0.2923, 0.0], "rx": 0.1688, "rz": 0.1264, "twist": -34}, {"position": [0.2931, 0.31, 0.0], "rx": 0.125, "rz": 0.0936, "twist": -34}, {"position": [0.352, 0.3041, 0.0], "rx": 0.0, "rz": 0.0, "twist": -34}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_middle_0_8) {
    mesh_middle_0_8Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_middle_0_8 = new THREE.Mesh(
    mesh_middle_0_8Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_0_8.name = "Middle leaf 1";
  if (endpoint_middle_0_8) {
    mesh_middle_0_8.position.copy(endpoint_middle_0_8.midpoint);
    mesh_middle_0_8.quaternion.copy(endpoint_middle_0_8.quaternion);
  }
  mesh_middle_0_8.castShadow = options.castShadow ?? true;
  mesh_middle_0_8.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_0_8.userData.sculptComponent = {"id": "middle-0", "name": "Middle leaf 1", "level": "meso", "role": "leaf", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the middle whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the middle whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0276, 0.045, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0576, 0.098, 0.0], "rx": 0.0182, "rz": 0.0137, "twist": -34}, {"position": [0.1165, 0.1863, 0.0], "rx": 0.099, "rz": 0.0742, "twist": -34}, {"position": [0.1753, 0.2511, 0.0], "rx": 0.1536, "rz": 0.115, "twist": -34}, {"position": [0.2342, 0.2923, 0.0], "rx": 0.1688, "rz": 0.1264, "twist": -34}, {"position": [0.2931, 0.31, 0.0], "rx": 0.125, "rz": 0.0936, "twist": -34}, {"position": [0.352, 0.3041, 0.0], "rx": 0.0, "rz": 0.0, "twist": -34}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [0.0315, -0.07, -0.0153], "localEnd": [0.3479, 0.2341, -0.1696], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0315, -0.07, -0.0153], "rotation": [0, 0.4538, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "middle whorl, offset 26 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 198, 63, 1.0)", "secondaryAlbedo": "rgba(78, 138, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_middle_0_8.add(mesh_middle_0_8);
  meshes["middle-0"] = mesh_middle_0_8;
  colliders["middle-0"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["middle-0"] ??= [];
  destructionGroups["middle-0"].push(node_middle_0_8);

  const endpoint_middle_1_9 = makeAttachmentEndpoint(null);
  const node_middle_1_9 = new THREE.Group();
  node_middle_1_9.name = "Middle leaf 2__pivot";
  node_middle_1_9.scale.set(1, 1, 1);
  if (endpoint_middle_1_9) {
    node_middle_1_9.position.copy(endpoint_middle_1_9.start);
    node_middle_1_9.rotation.set(0.0, 1.487, 0.0);
  } else {
    node_middle_1_9.position.set(0.0029, -0.07, -0.0349);
    node_middle_1_9.rotation.set(0.0, 1.487, 0.0);
  }
  node_middle_1_9.userData.sculptComponent = {"id": "middle-1", "name": "Middle leaf 2", "level": "meso", "role": "leaf", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the middle whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the middle whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0301, 0.0492, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0629, 0.1071, 0.0], "rx": 0.0199, "rz": 0.0149, "twist": 34}, {"position": [0.1272, 0.2036, 0.0], "rx": 0.1081, "rz": 0.081, "twist": 34}, {"position": [0.1915, 0.2743, 0.0], "rx": 0.1678, "rz": 0.1256, "twist": 34}, {"position": [0.2559, 0.3193, 0.0], "rx": 0.1844, "rz": 0.1381, "twist": 34}, {"position": [0.3202, 0.3386, 0.0], "rx": 0.1365, "rz": 0.1022, "twist": 34}, {"position": [0.3845, 0.3322, 0.0], "rx": 0.0, "rz": 0.0, "twist": 34}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [0.0029, -0.07, -0.0349], "localEnd": [0.0351, 0.2622, -0.4181], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0029, -0.07, -0.0349], "rotation": [0, 1.487, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "middle whorl, offset 26 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 198, 63, 1.0)", "secondaryAlbedo": "rgba(78, 138, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_middle_1_9.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["heart-core"] ?? root).add(node_middle_1_9);
  nodes["middle-1"] = node_middle_1_9;
  const mesh_middle_1_9Geometry = endpoint_middle_1_9
    ? new THREE.CylinderGeometry(endpoint_middle_1_9.endRadius, endpoint_middle_1_9.baseRadius, endpoint_middle_1_9.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0301, 0.0492, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0629, 0.1071, 0.0], "rx": 0.0199, "rz": 0.0149, "twist": 34}, {"position": [0.1272, 0.2036, 0.0], "rx": 0.1081, "rz": 0.081, "twist": 34}, {"position": [0.1915, 0.2743, 0.0], "rx": 0.1678, "rz": 0.1256, "twist": 34}, {"position": [0.2559, 0.3193, 0.0], "rx": 0.1844, "rz": 0.1381, "twist": 34}, {"position": [0.3202, 0.3386, 0.0], "rx": 0.1365, "rz": 0.1022, "twist": 34}, {"position": [0.3845, 0.3322, 0.0], "rx": 0.0, "rz": 0.0, "twist": 34}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_middle_1_9) {
    mesh_middle_1_9Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_middle_1_9 = new THREE.Mesh(
    mesh_middle_1_9Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_1_9.name = "Middle leaf 2";
  if (endpoint_middle_1_9) {
    mesh_middle_1_9.position.copy(endpoint_middle_1_9.midpoint);
    mesh_middle_1_9.quaternion.copy(endpoint_middle_1_9.quaternion);
  }
  mesh_middle_1_9.castShadow = options.castShadow ?? true;
  mesh_middle_1_9.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_1_9.userData.sculptComponent = {"id": "middle-1", "name": "Middle leaf 2", "level": "meso", "role": "leaf", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the middle whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the middle whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0301, 0.0492, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0629, 0.1071, 0.0], "rx": 0.0199, "rz": 0.0149, "twist": 34}, {"position": [0.1272, 0.2036, 0.0], "rx": 0.1081, "rz": 0.081, "twist": 34}, {"position": [0.1915, 0.2743, 0.0], "rx": 0.1678, "rz": 0.1256, "twist": 34}, {"position": [0.2559, 0.3193, 0.0], "rx": 0.1844, "rz": 0.1381, "twist": 34}, {"position": [0.3202, 0.3386, 0.0], "rx": 0.1365, "rz": 0.1022, "twist": 34}, {"position": [0.3845, 0.3322, 0.0], "rx": 0.0, "rz": 0.0, "twist": 34}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [0.0029, -0.07, -0.0349], "localEnd": [0.0351, 0.2622, -0.4181], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0029, -0.07, -0.0349], "rotation": [0, 1.487, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "middle whorl, offset 26 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 198, 63, 1.0)", "secondaryAlbedo": "rgba(78, 138, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_middle_1_9.add(mesh_middle_1_9);
  meshes["middle-1"] = mesh_middle_1_9;
  colliders["middle-1"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["middle-1"] ??= [];
  destructionGroups["middle-1"].push(node_middle_1_9);

  const endpoint_middle_2_10 = makeAttachmentEndpoint(null);
  const node_middle_2_10 = new THREE.Group();
  node_middle_2_10.name = "Middle leaf 3__pivot";
  node_middle_2_10.scale.set(1, 1, 1);
  if (endpoint_middle_2_10) {
    node_middle_2_10.position.copy(endpoint_middle_2_10.start);
    node_middle_2_10.rotation.set(0.0, 2.1121, 0.0);
  } else {
    node_middle_2_10.position.set(-0.018, -0.07, -0.03);
    node_middle_2_10.rotation.set(0.0, 2.1121, 0.0);
  }
  node_middle_2_10.userData.sculptComponent = {"id": "middle-2", "name": "Middle leaf 3", "level": "meso", "role": "leaf", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the middle whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the middle whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0299, 0.0488, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0624, 0.1062, 0.0], "rx": 0.0197, "rz": 0.0148, "twist": -34}, {"position": [0.1261, 0.2018, 0.0], "rx": 0.1072, "rz": 0.0803, "twist": -34}, {"position": [0.1899, 0.2719, 0.0], "rx": 0.1663, "rz": 0.1246, "twist": -34}, {"position": [0.2536, 0.3166, 0.0], "rx": 0.1828, "rz": 0.137, "twist": -34}, {"position": [0.3174, 0.3357, 0.0], "rx": 0.1354, "rz": 0.1013, "twist": -34}, {"position": [0.3812, 0.3293, 0.0], "rx": 0.0, "rz": 0.0, "twist": -34}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [-0.018, -0.07, -0.03], "localEnd": [-0.2144, 0.2593, -0.3567], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.018, -0.07, -0.03], "rotation": [0, 2.1121, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "middle whorl, offset 26 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 198, 63, 1.0)", "secondaryAlbedo": "rgba(78, 138, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_middle_2_10.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["heart-core"] ?? root).add(node_middle_2_10);
  nodes["middle-2"] = node_middle_2_10;
  const mesh_middle_2_10Geometry = endpoint_middle_2_10
    ? new THREE.CylinderGeometry(endpoint_middle_2_10.endRadius, endpoint_middle_2_10.baseRadius, endpoint_middle_2_10.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0299, 0.0488, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0624, 0.1062, 0.0], "rx": 0.0197, "rz": 0.0148, "twist": -34}, {"position": [0.1261, 0.2018, 0.0], "rx": 0.1072, "rz": 0.0803, "twist": -34}, {"position": [0.1899, 0.2719, 0.0], "rx": 0.1663, "rz": 0.1246, "twist": -34}, {"position": [0.2536, 0.3166, 0.0], "rx": 0.1828, "rz": 0.137, "twist": -34}, {"position": [0.3174, 0.3357, 0.0], "rx": 0.1354, "rz": 0.1013, "twist": -34}, {"position": [0.3812, 0.3293, 0.0], "rx": 0.0, "rz": 0.0, "twist": -34}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_middle_2_10) {
    mesh_middle_2_10Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_middle_2_10 = new THREE.Mesh(
    mesh_middle_2_10Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_2_10.name = "Middle leaf 3";
  if (endpoint_middle_2_10) {
    mesh_middle_2_10.position.copy(endpoint_middle_2_10.midpoint);
    mesh_middle_2_10.quaternion.copy(endpoint_middle_2_10.quaternion);
  }
  mesh_middle_2_10.castShadow = options.castShadow ?? true;
  mesh_middle_2_10.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_2_10.userData.sculptComponent = {"id": "middle-2", "name": "Middle leaf 3", "level": "meso", "role": "leaf", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the middle whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the middle whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0299, 0.0488, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0624, 0.1062, 0.0], "rx": 0.0197, "rz": 0.0148, "twist": -34}, {"position": [0.1261, 0.2018, 0.0], "rx": 0.1072, "rz": 0.0803, "twist": -34}, {"position": [0.1899, 0.2719, 0.0], "rx": 0.1663, "rz": 0.1246, "twist": -34}, {"position": [0.2536, 0.3166, 0.0], "rx": 0.1828, "rz": 0.137, "twist": -34}, {"position": [0.3174, 0.3357, 0.0], "rx": 0.1354, "rz": 0.1013, "twist": -34}, {"position": [0.3812, 0.3293, 0.0], "rx": 0.0, "rz": 0.0, "twist": -34}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [-0.018, -0.07, -0.03], "localEnd": [-0.2144, 0.2593, -0.3567], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.018, -0.07, -0.03], "rotation": [0, 2.1121, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "middle whorl, offset 26 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 198, 63, 1.0)", "secondaryAlbedo": "rgba(78, 138, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_middle_2_10.add(mesh_middle_2_10);
  meshes["middle-2"] = mesh_middle_2_10;
  colliders["middle-2"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["middle-2"] ??= [];
  destructionGroups["middle-2"].push(node_middle_2_10);

  const endpoint_middle_3_11 = makeAttachmentEndpoint(null);
  const node_middle_3_11 = new THREE.Group();
  node_middle_3_11.name = "Middle leaf 4__pivot";
  node_middle_3_11.scale.set(1, 1, 1);
  if (endpoint_middle_3_11) {
    node_middle_3_11.position.copy(endpoint_middle_3_11.start);
    node_middle_3_11.rotation.set(0.0, 3.1492, 0.0);
  } else {
    node_middle_3_11.position.set(-0.035, -0.07, 0.0003);
    node_middle_3_11.rotation.set(0.0, 3.1492, 0.0);
  }
  node_middle_3_11.userData.sculptComponent = {"id": "middle-3", "name": "Middle leaf 4", "level": "meso", "role": "leaf", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the middle whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the middle whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0272, 0.0444, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0568, 0.0966, 0.0], "rx": 0.0179, "rz": 0.0135, "twist": 34}, {"position": [0.1148, 0.1836, 0.0], "rx": 0.0975, "rz": 0.0731, "twist": 34}, {"position": [0.1728, 0.2474, 0.0], "rx": 0.1514, "rz": 0.1134, "twist": 34}, {"position": [0.2308, 0.2881, 0.0], "rx": 0.1664, "rz": 0.1246, "twist": 34}, {"position": [0.2888, 0.3055, 0.0], "rx": 0.1232, "rz": 0.0922, "twist": 34}, {"position": [0.3468, 0.2997, 0.0], "rx": 0.0, "rz": 0.0, "twist": 34}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [-0.035, -0.07, 0.0003], "localEnd": [-0.3818, 0.2297, 0.0029], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.035, -0.07, 0.0003], "rotation": [0, 3.1492, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "middle whorl, offset 26 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 198, 63, 1.0)", "secondaryAlbedo": "rgba(78, 138, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_middle_3_11.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["heart-core"] ?? root).add(node_middle_3_11);
  nodes["middle-3"] = node_middle_3_11;
  const mesh_middle_3_11Geometry = endpoint_middle_3_11
    ? new THREE.CylinderGeometry(endpoint_middle_3_11.endRadius, endpoint_middle_3_11.baseRadius, endpoint_middle_3_11.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0272, 0.0444, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0568, 0.0966, 0.0], "rx": 0.0179, "rz": 0.0135, "twist": 34}, {"position": [0.1148, 0.1836, 0.0], "rx": 0.0975, "rz": 0.0731, "twist": 34}, {"position": [0.1728, 0.2474, 0.0], "rx": 0.1514, "rz": 0.1134, "twist": 34}, {"position": [0.2308, 0.2881, 0.0], "rx": 0.1664, "rz": 0.1246, "twist": 34}, {"position": [0.2888, 0.3055, 0.0], "rx": 0.1232, "rz": 0.0922, "twist": 34}, {"position": [0.3468, 0.2997, 0.0], "rx": 0.0, "rz": 0.0, "twist": 34}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_middle_3_11) {
    mesh_middle_3_11Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_middle_3_11 = new THREE.Mesh(
    mesh_middle_3_11Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_3_11.name = "Middle leaf 4";
  if (endpoint_middle_3_11) {
    mesh_middle_3_11.position.copy(endpoint_middle_3_11.midpoint);
    mesh_middle_3_11.quaternion.copy(endpoint_middle_3_11.quaternion);
  }
  mesh_middle_3_11.castShadow = options.castShadow ?? true;
  mesh_middle_3_11.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_3_11.userData.sculptComponent = {"id": "middle-3", "name": "Middle leaf 4", "level": "meso", "role": "leaf", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the middle whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the middle whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0272, 0.0444, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0568, 0.0966, 0.0], "rx": 0.0179, "rz": 0.0135, "twist": 34}, {"position": [0.1148, 0.1836, 0.0], "rx": 0.0975, "rz": 0.0731, "twist": 34}, {"position": [0.1728, 0.2474, 0.0], "rx": 0.1514, "rz": 0.1134, "twist": 34}, {"position": [0.2308, 0.2881, 0.0], "rx": 0.1664, "rz": 0.1246, "twist": 34}, {"position": [0.2888, 0.3055, 0.0], "rx": 0.1232, "rz": 0.0922, "twist": 34}, {"position": [0.3468, 0.2997, 0.0], "rx": 0.0, "rz": 0.0, "twist": 34}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [-0.035, -0.07, 0.0003], "localEnd": [-0.3818, 0.2297, 0.0029], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.035, -0.07, 0.0003], "rotation": [0, 3.1492, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "middle whorl, offset 26 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 198, 63, 1.0)", "secondaryAlbedo": "rgba(78, 138, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_middle_3_11.add(mesh_middle_3_11);
  meshes["middle-3"] = mesh_middle_3_11;
  colliders["middle-3"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["middle-3"] ??= [];
  destructionGroups["middle-3"].push(node_middle_3_11);

  const endpoint_middle_4_12 = makeAttachmentEndpoint(null);
  const node_middle_4_12 = new THREE.Group();
  node_middle_4_12.name = "Middle leaf 5__pivot";
  node_middle_4_12.scale.set(1, 1, 1);
  if (endpoint_middle_4_12) {
    node_middle_4_12.position.copy(endpoint_middle_4_12.start);
    node_middle_4_12.rotation.set(0.0, 4.1784, 0.0);
  } else {
    node_middle_4_12.position.set(-0.0178, -0.07, 0.0301);
    node_middle_4_12.rotation.set(0.0, 4.1784, 0.0);
  }
  node_middle_4_12.userData.sculptComponent = {"id": "middle-4", "name": "Middle leaf 5", "level": "meso", "role": "leaf", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the middle whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the middle whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.026, 0.0425, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0543, 0.0924, 0.0], "rx": 0.0171, "rz": 0.0128, "twist": -34}, {"position": [0.1098, 0.1757, 0.0], "rx": 0.0933, "rz": 0.0698, "twist": -34}, {"position": [0.1653, 0.2367, 0.0], "rx": 0.1448, "rz": 0.1084, "twist": -34}, {"position": [0.2208, 0.2756, 0.0], "rx": 0.1592, "rz": 0.1192, "twist": -34}, {"position": [0.2763, 0.2922, 0.0], "rx": 0.1178, "rz": 0.0882, "twist": -34}, {"position": [0.3318, 0.2867, 0.0], "rx": 0.0, "rz": 0.0, "twist": -34}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [-0.0178, -0.07, 0.0301], "localEnd": [-0.1867, 0.2167, 0.3157], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.0178, -0.07, 0.0301], "rotation": [0, 4.1784, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "middle whorl, offset 26 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 198, 63, 1.0)", "secondaryAlbedo": "rgba(78, 138, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_middle_4_12.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["heart-core"] ?? root).add(node_middle_4_12);
  nodes["middle-4"] = node_middle_4_12;
  const mesh_middle_4_12Geometry = endpoint_middle_4_12
    ? new THREE.CylinderGeometry(endpoint_middle_4_12.endRadius, endpoint_middle_4_12.baseRadius, endpoint_middle_4_12.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.026, 0.0425, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0543, 0.0924, 0.0], "rx": 0.0171, "rz": 0.0128, "twist": -34}, {"position": [0.1098, 0.1757, 0.0], "rx": 0.0933, "rz": 0.0698, "twist": -34}, {"position": [0.1653, 0.2367, 0.0], "rx": 0.1448, "rz": 0.1084, "twist": -34}, {"position": [0.2208, 0.2756, 0.0], "rx": 0.1592, "rz": 0.1192, "twist": -34}, {"position": [0.2763, 0.2922, 0.0], "rx": 0.1178, "rz": 0.0882, "twist": -34}, {"position": [0.3318, 0.2867, 0.0], "rx": 0.0, "rz": 0.0, "twist": -34}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_middle_4_12) {
    mesh_middle_4_12Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_middle_4_12 = new THREE.Mesh(
    mesh_middle_4_12Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_4_12.name = "Middle leaf 5";
  if (endpoint_middle_4_12) {
    mesh_middle_4_12.position.copy(endpoint_middle_4_12.midpoint);
    mesh_middle_4_12.quaternion.copy(endpoint_middle_4_12.quaternion);
  }
  mesh_middle_4_12.castShadow = options.castShadow ?? true;
  mesh_middle_4_12.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_4_12.userData.sculptComponent = {"id": "middle-4", "name": "Middle leaf 5", "level": "meso", "role": "leaf", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the middle whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the middle whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.026, 0.0425, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0543, 0.0924, 0.0], "rx": 0.0171, "rz": 0.0128, "twist": -34}, {"position": [0.1098, 0.1757, 0.0], "rx": 0.0933, "rz": 0.0698, "twist": -34}, {"position": [0.1653, 0.2367, 0.0], "rx": 0.1448, "rz": 0.1084, "twist": -34}, {"position": [0.2208, 0.2756, 0.0], "rx": 0.1592, "rz": 0.1192, "twist": -34}, {"position": [0.2763, 0.2922, 0.0], "rx": 0.1178, "rz": 0.0882, "twist": -34}, {"position": [0.3318, 0.2867, 0.0], "rx": 0.0, "rz": 0.0, "twist": -34}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [-0.0178, -0.07, 0.0301], "localEnd": [-0.1867, 0.2167, 0.3157], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.0178, -0.07, 0.0301], "rotation": [0, 4.1784, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "middle whorl, offset 26 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 198, 63, 1.0)", "secondaryAlbedo": "rgba(78, 138, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_middle_4_12.add(mesh_middle_4_12);
  meshes["middle-4"] = mesh_middle_4_12;
  colliders["middle-4"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["middle-4"] ??= [];
  destructionGroups["middle-4"].push(node_middle_4_12);

  const endpoint_middle_5_13 = makeAttachmentEndpoint(null);
  const node_middle_5_13 = new THREE.Group();
  node_middle_5_13.name = "Middle leaf 6__pivot";
  node_middle_5_13.scale.set(1, 1, 1);
  if (endpoint_middle_5_13) {
    node_middle_5_13.position.copy(endpoint_middle_5_13.start);
    node_middle_5_13.rotation.set(0.0, 4.8036, 0.0);
  } else {
    node_middle_5_13.position.set(0.0032, -0.07, 0.0349);
    node_middle_5_13.rotation.set(0.0, 4.8036, 0.0);
  }
  node_middle_5_13.userData.sculptComponent = {"id": "middle-5", "name": "Middle leaf 6", "level": "meso", "role": "leaf", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the middle whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the middle whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0281, 0.0458, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0586, 0.0997, 0.0], "rx": 0.0185, "rz": 0.0139, "twist": 34}, {"position": [0.1185, 0.1896, 0.0], "rx": 0.1007, "rz": 0.0754, "twist": 34}, {"position": [0.1784, 0.2555, 0.0], "rx": 0.1563, "rz": 0.117, "twist": 34}, {"position": [0.2383, 0.2974, 0.0], "rx": 0.1718, "rz": 0.1287, "twist": 34}, {"position": [0.2982, 0.3154, 0.0], "rx": 0.1272, "rz": 0.0952, "twist": 34}, {"position": [0.3581, 0.3094, 0.0], "rx": 0.0, "rz": 0.0, "twist": 34}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [0.0032, -0.07, 0.0349], "localEnd": [0.0358, 0.2394, 0.3915], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0032, -0.07, 0.0349], "rotation": [0, 4.8036, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "middle whorl, offset 26 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 198, 63, 1.0)", "secondaryAlbedo": "rgba(78, 138, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_middle_5_13.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["heart-core"] ?? root).add(node_middle_5_13);
  nodes["middle-5"] = node_middle_5_13;
  const mesh_middle_5_13Geometry = endpoint_middle_5_13
    ? new THREE.CylinderGeometry(endpoint_middle_5_13.endRadius, endpoint_middle_5_13.baseRadius, endpoint_middle_5_13.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0281, 0.0458, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0586, 0.0997, 0.0], "rx": 0.0185, "rz": 0.0139, "twist": 34}, {"position": [0.1185, 0.1896, 0.0], "rx": 0.1007, "rz": 0.0754, "twist": 34}, {"position": [0.1784, 0.2555, 0.0], "rx": 0.1563, "rz": 0.117, "twist": 34}, {"position": [0.2383, 0.2974, 0.0], "rx": 0.1718, "rz": 0.1287, "twist": 34}, {"position": [0.2982, 0.3154, 0.0], "rx": 0.1272, "rz": 0.0952, "twist": 34}, {"position": [0.3581, 0.3094, 0.0], "rx": 0.0, "rz": 0.0, "twist": 34}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_middle_5_13) {
    mesh_middle_5_13Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_middle_5_13 = new THREE.Mesh(
    mesh_middle_5_13Geometry,
    materialMap["leaf"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_middle_5_13.name = "Middle leaf 6";
  if (endpoint_middle_5_13) {
    mesh_middle_5_13.position.copy(endpoint_middle_5_13.midpoint);
    mesh_middle_5_13.quaternion.copy(endpoint_middle_5_13.quaternion);
  }
  mesh_middle_5_13.castShadow = options.castShadow ?? true;
  mesh_middle_5_13.receiveShadow = options.receiveShadow ?? true;
  mesh_middle_5_13.userData.sculptComponent = {"id": "middle-5", "name": "Middle leaf 6", "level": "meso", "role": "leaf", "importance": 0.75, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the middle whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the middle whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0281, 0.0458, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0586, 0.0997, 0.0], "rx": 0.0185, "rz": 0.0139, "twist": 34}, {"position": [0.1185, 0.1896, 0.0], "rx": 0.1007, "rz": 0.0754, "twist": 34}, {"position": [0.1784, 0.2555, 0.0], "rx": 0.1563, "rz": 0.117, "twist": 34}, {"position": [0.2383, 0.2974, 0.0], "rx": 0.1718, "rz": 0.1287, "twist": 34}, {"position": [0.2982, 0.3154, 0.0], "rx": 0.1272, "rz": 0.0952, "twist": 34}, {"position": [0.3581, 0.3094, 0.0], "rx": 0.0, "rz": 0.0, "twist": 34}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [0.0032, -0.07, 0.0349], "localEnd": [0.0358, 0.2394, 0.3915], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0032, -0.07, 0.0349], "rotation": [0, 4.8036, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "middle-5", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf", "materialLayers": ["leaf"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "middle whorl, offset 26 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(140, 198, 63, 1.0)", "secondaryAlbedo": "rgba(78, 138, 42, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_middle_5_13.add(mesh_middle_5_13);
  meshes["middle-5"] = mesh_middle_5_13;
  colliders["middle-5"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["middle-5"] ??= [];
  destructionGroups["middle-5"].push(node_middle_5_13);

  const endpoint_heart_0_14 = makeAttachmentEndpoint(null);
  const node_heart_0_14 = new THREE.Group();
  node_heart_0_14.name = "Heart leaf 1__pivot";
  node_heart_0_14.scale.set(1, 1, 1);
  if (endpoint_heart_0_14) {
    node_heart_0_14.position.copy(endpoint_heart_0_14.start);
    node_heart_0_14.rotation.set(0.0, 0.2269, 0.0);
  } else {
    node_heart_0_14.position.set(0.0146, -0.05, -0.0034);
    node_heart_0_14.rotation.set(0.0, 0.2269, 0.0);
  }
  node_heart_0_14.userData.sculptComponent = {"id": "heart-0", "name": "Heart leaf 1", "level": "meso", "role": "leaf", "importance": 0.6, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the heart whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the heart whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0109, 0.0332, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0227, 0.0665, 0.0], "rx": 0.0068, "rz": 0.0033, "twist": -55}, {"position": [0.0458, 0.1242, 0.0], "rx": 0.0371, "rz": 0.032, "twist": -55}, {"position": [0.069, 0.1701, 0.0], "rx": 0.0576, "rz": 0.0497, "twist": -55}, {"position": [0.0922, 0.2042, 0.0], "rx": 0.0633, "rz": 0.0547, "twist": -55}, {"position": [0.1153, 0.2266, 0.0], "rx": 0.0468, "rz": 0.0405, "twist": -55}, {"position": [0.1385, 0.2371, 0.0], "rx": 0.0, "rz": 0.0, "twist": -55}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [0.0146, -0.05, -0.0034], "localEnd": [0.1496, 0.1871, -0.0346], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0146, -0.05, -0.0034], "rotation": [0, 0.2269, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "heart-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf-heart", "materialLayers": ["leaf-heart"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "heart whorl, offset 13 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(181, 220, 106, 1.0)", "secondaryAlbedo": "rgba(156, 207, 85, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_heart_0_14.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "heart-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["heart-core"] ?? root).add(node_heart_0_14);
  nodes["heart-0"] = node_heart_0_14;
  const mesh_heart_0_14Geometry = endpoint_heart_0_14
    ? new THREE.CylinderGeometry(endpoint_heart_0_14.endRadius, endpoint_heart_0_14.baseRadius, endpoint_heart_0_14.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0109, 0.0332, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0227, 0.0665, 0.0], "rx": 0.0068, "rz": 0.0033, "twist": -55}, {"position": [0.0458, 0.1242, 0.0], "rx": 0.0371, "rz": 0.032, "twist": -55}, {"position": [0.069, 0.1701, 0.0], "rx": 0.0576, "rz": 0.0497, "twist": -55}, {"position": [0.0922, 0.2042, 0.0], "rx": 0.0633, "rz": 0.0547, "twist": -55}, {"position": [0.1153, 0.2266, 0.0], "rx": 0.0468, "rz": 0.0405, "twist": -55}, {"position": [0.1385, 0.2371, 0.0], "rx": 0.0, "rz": 0.0, "twist": -55}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_heart_0_14) {
    mesh_heart_0_14Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_heart_0_14 = new THREE.Mesh(
    mesh_heart_0_14Geometry,
    materialMap["leaf-heart"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_heart_0_14.name = "Heart leaf 1";
  if (endpoint_heart_0_14) {
    mesh_heart_0_14.position.copy(endpoint_heart_0_14.midpoint);
    mesh_heart_0_14.quaternion.copy(endpoint_heart_0_14.quaternion);
  }
  mesh_heart_0_14.castShadow = options.castShadow ?? true;
  mesh_heart_0_14.receiveShadow = options.receiveShadow ?? true;
  mesh_heart_0_14.userData.sculptComponent = {"id": "heart-0", "name": "Heart leaf 1", "level": "meso", "role": "leaf", "importance": 0.6, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the heart whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the heart whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0109, 0.0332, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0227, 0.0665, 0.0], "rx": 0.0068, "rz": 0.0033, "twist": -55}, {"position": [0.0458, 0.1242, 0.0], "rx": 0.0371, "rz": 0.032, "twist": -55}, {"position": [0.069, 0.1701, 0.0], "rx": 0.0576, "rz": 0.0497, "twist": -55}, {"position": [0.0922, 0.2042, 0.0], "rx": 0.0633, "rz": 0.0547, "twist": -55}, {"position": [0.1153, 0.2266, 0.0], "rx": 0.0468, "rz": 0.0405, "twist": -55}, {"position": [0.1385, 0.2371, 0.0], "rx": 0.0, "rz": 0.0, "twist": -55}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [0.0146, -0.05, -0.0034], "localEnd": [0.1496, 0.1871, -0.0346], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0146, -0.05, -0.0034], "rotation": [0, 0.2269, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "heart-0", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf-heart", "materialLayers": ["leaf-heart"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "heart whorl, offset 13 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(181, 220, 106, 1.0)", "secondaryAlbedo": "rgba(156, 207, 85, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_heart_0_14.add(mesh_heart_0_14);
  meshes["heart-0"] = mesh_heart_0_14;
  colliders["heart-0"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["heart-0"] ??= [];
  destructionGroups["heart-0"].push(node_heart_0_14);

  const endpoint_heart_1_15 = makeAttachmentEndpoint(null);
  const node_heart_1_15 = new THREE.Group();
  node_heart_1_15.name = "Heart leaf 2__pivot";
  node_heart_1_15.scale.set(1, 1, 1);
  if (endpoint_heart_1_15) {
    node_heart_1_15.position.copy(endpoint_heart_1_15.start);
    node_heart_1_15.rotation.set(0.0, 1.4097, 0.0);
  } else {
    node_heart_1_15.position.set(0.0024, -0.05, -0.0148);
    node_heart_1_15.rotation.set(0.0, 1.4097, 0.0);
  }
  node_heart_1_15.userData.sculptComponent = {"id": "heart-1", "name": "Heart leaf 2", "level": "meso", "role": "leaf", "importance": 0.6, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the heart whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the heart whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0118, 0.036, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0246, 0.0721, 0.0], "rx": 0.0074, "rz": 0.0035, "twist": 55}, {"position": [0.0497, 0.1347, 0.0], "rx": 0.0402, "rz": 0.0347, "twist": 55}, {"position": [0.0748, 0.1845, 0.0], "rx": 0.0624, "rz": 0.054, "twist": 55}, {"position": [0.1, 0.2215, 0.0], "rx": 0.0686, "rz": 0.0592, "twist": 55}, {"position": [0.1251, 0.2457, 0.0], "rx": 0.0508, "rz": 0.0439, "twist": 55}, {"position": [0.1502, 0.2571, 0.0], "rx": 0.0, "rz": 0.0, "twist": 55}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [0.0024, -0.05, -0.0148], "localEnd": [0.0265, 0.2071, -0.1631], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0024, -0.05, -0.0148], "rotation": [0, 1.4097, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "heart-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf-heart", "materialLayers": ["leaf-heart"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "heart whorl, offset 13 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(181, 220, 106, 1.0)", "secondaryAlbedo": "rgba(156, 207, 85, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_heart_1_15.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "heart-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["heart-core"] ?? root).add(node_heart_1_15);
  nodes["heart-1"] = node_heart_1_15;
  const mesh_heart_1_15Geometry = endpoint_heart_1_15
    ? new THREE.CylinderGeometry(endpoint_heart_1_15.endRadius, endpoint_heart_1_15.baseRadius, endpoint_heart_1_15.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0118, 0.036, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0246, 0.0721, 0.0], "rx": 0.0074, "rz": 0.0035, "twist": 55}, {"position": [0.0497, 0.1347, 0.0], "rx": 0.0402, "rz": 0.0347, "twist": 55}, {"position": [0.0748, 0.1845, 0.0], "rx": 0.0624, "rz": 0.054, "twist": 55}, {"position": [0.1, 0.2215, 0.0], "rx": 0.0686, "rz": 0.0592, "twist": 55}, {"position": [0.1251, 0.2457, 0.0], "rx": 0.0508, "rz": 0.0439, "twist": 55}, {"position": [0.1502, 0.2571, 0.0], "rx": 0.0, "rz": 0.0, "twist": 55}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_heart_1_15) {
    mesh_heart_1_15Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_heart_1_15 = new THREE.Mesh(
    mesh_heart_1_15Geometry,
    materialMap["leaf-heart"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_heart_1_15.name = "Heart leaf 2";
  if (endpoint_heart_1_15) {
    mesh_heart_1_15.position.copy(endpoint_heart_1_15.midpoint);
    mesh_heart_1_15.quaternion.copy(endpoint_heart_1_15.quaternion);
  }
  mesh_heart_1_15.castShadow = options.castShadow ?? true;
  mesh_heart_1_15.receiveShadow = options.receiveShadow ?? true;
  mesh_heart_1_15.userData.sculptComponent = {"id": "heart-1", "name": "Heart leaf 2", "level": "meso", "role": "leaf", "importance": 0.6, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the heart whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the heart whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0118, 0.036, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0246, 0.0721, 0.0], "rx": 0.0074, "rz": 0.0035, "twist": 55}, {"position": [0.0497, 0.1347, 0.0], "rx": 0.0402, "rz": 0.0347, "twist": 55}, {"position": [0.0748, 0.1845, 0.0], "rx": 0.0624, "rz": 0.054, "twist": 55}, {"position": [0.1, 0.2215, 0.0], "rx": 0.0686, "rz": 0.0592, "twist": 55}, {"position": [0.1251, 0.2457, 0.0], "rx": 0.0508, "rz": 0.0439, "twist": 55}, {"position": [0.1502, 0.2571, 0.0], "rx": 0.0, "rz": 0.0, "twist": 55}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [0.0024, -0.05, -0.0148], "localEnd": [0.0265, 0.2071, -0.1631], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [0.0024, -0.05, -0.0148], "rotation": [0, 1.4097, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "heart-1", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf-heart", "materialLayers": ["leaf-heart"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "heart whorl, offset 13 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(181, 220, 106, 1.0)", "secondaryAlbedo": "rgba(156, 207, 85, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_heart_1_15.add(mesh_heart_1_15);
  meshes["heart-1"] = mesh_heart_1_15;
  colliders["heart-1"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["heart-1"] ??= [];
  destructionGroups["heart-1"].push(node_heart_1_15);

  const endpoint_heart_2_16 = makeAttachmentEndpoint(null);
  const node_heart_2_16 = new THREE.Group();
  node_heart_2_16.name = "Heart leaf 3__pivot";
  node_heart_2_16.scale.set(1, 1, 1);
  if (endpoint_heart_2_16) {
    node_heart_2_16.position.copy(endpoint_heart_2_16.start);
    node_heart_2_16.rotation.set(0.0, 2.1844, 0.0);
  } else {
    node_heart_2_16.position.set(-0.0086, -0.05, -0.0123);
    node_heart_2_16.rotation.set(0.0, 2.1844, 0.0);
  }
  node_heart_2_16.userData.sculptComponent = {"id": "heart-2", "name": "Heart leaf 3", "level": "meso", "role": "leaf", "importance": 0.6, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the heart whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the heart whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0127, 0.0388, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0264, 0.0776, 0.0], "rx": 0.008, "rz": 0.0038, "twist": -55}, {"position": [0.0535, 0.145, 0.0], "rx": 0.0433, "rz": 0.0374, "twist": -55}, {"position": [0.0805, 0.1985, 0.0], "rx": 0.0672, "rz": 0.058, "twist": -55}, {"position": [0.1075, 0.2383, 0.0], "rx": 0.0738, "rz": 0.0637, "twist": -55}, {"position": [0.1346, 0.2644, 0.0], "rx": 0.0547, "rz": 0.0472, "twist": -55}, {"position": [0.1616, 0.2767, 0.0], "rx": 0.0, "rz": 0.0, "twist": -55}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [-0.0086, -0.05, -0.0123], "localEnd": [-0.1016, 0.2267, -0.1444], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.0086, -0.05, -0.0123], "rotation": [0, 2.1844, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "heart-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf-heart", "materialLayers": ["leaf-heart"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "heart whorl, offset 13 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(181, 220, 106, 1.0)", "secondaryAlbedo": "rgba(156, 207, 85, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_heart_2_16.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "heart-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["heart-core"] ?? root).add(node_heart_2_16);
  nodes["heart-2"] = node_heart_2_16;
  const mesh_heart_2_16Geometry = endpoint_heart_2_16
    ? new THREE.CylinderGeometry(endpoint_heart_2_16.endRadius, endpoint_heart_2_16.baseRadius, endpoint_heart_2_16.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0127, 0.0388, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0264, 0.0776, 0.0], "rx": 0.008, "rz": 0.0038, "twist": -55}, {"position": [0.0535, 0.145, 0.0], "rx": 0.0433, "rz": 0.0374, "twist": -55}, {"position": [0.0805, 0.1985, 0.0], "rx": 0.0672, "rz": 0.058, "twist": -55}, {"position": [0.1075, 0.2383, 0.0], "rx": 0.0738, "rz": 0.0637, "twist": -55}, {"position": [0.1346, 0.2644, 0.0], "rx": 0.0547, "rz": 0.0472, "twist": -55}, {"position": [0.1616, 0.2767, 0.0], "rx": 0.0, "rz": 0.0, "twist": -55}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_heart_2_16) {
    mesh_heart_2_16Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_heart_2_16 = new THREE.Mesh(
    mesh_heart_2_16Geometry,
    materialMap["leaf-heart"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_heart_2_16.name = "Heart leaf 3";
  if (endpoint_heart_2_16) {
    mesh_heart_2_16.position.copy(endpoint_heart_2_16.midpoint);
    mesh_heart_2_16.quaternion.copy(endpoint_heart_2_16.quaternion);
  }
  mesh_heart_2_16.castShadow = options.castShadow ?? true;
  mesh_heart_2_16.receiveShadow = options.receiveShadow ?? true;
  mesh_heart_2_16.userData.sculptComponent = {"id": "heart-2", "name": "Heart leaf 3", "level": "meso", "role": "leaf", "importance": 0.6, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the heart whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the heart whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0127, 0.0388, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0264, 0.0776, 0.0], "rx": 0.008, "rz": 0.0038, "twist": -55}, {"position": [0.0535, 0.145, 0.0], "rx": 0.0433, "rz": 0.0374, "twist": -55}, {"position": [0.0805, 0.1985, 0.0], "rx": 0.0672, "rz": 0.058, "twist": -55}, {"position": [0.1075, 0.2383, 0.0], "rx": 0.0738, "rz": 0.0637, "twist": -55}, {"position": [0.1346, 0.2644, 0.0], "rx": 0.0547, "rz": 0.0472, "twist": -55}, {"position": [0.1616, 0.2767, 0.0], "rx": 0.0, "rz": 0.0, "twist": -55}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [-0.0086, -0.05, -0.0123], "localEnd": [-0.1016, 0.2267, -0.1444], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.0086, -0.05, -0.0123], "rotation": [0, 2.1844, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "heart-2", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf-heart", "materialLayers": ["leaf-heart"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "heart whorl, offset 13 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(181, 220, 106, 1.0)", "secondaryAlbedo": "rgba(156, 207, 85, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_heart_2_16.add(mesh_heart_2_16);
  meshes["heart-2"] = mesh_heart_2_16;
  colliders["heart-2"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["heart-2"] ??= [];
  destructionGroups["heart-2"].push(node_heart_2_16);

  const endpoint_heart_3_17 = makeAttachmentEndpoint(null);
  const node_heart_3_17 = new THREE.Group();
  node_heart_3_17.name = "Heart leaf 4__pivot";
  node_heart_3_17.scale.set(1, 1, 1);
  if (endpoint_heart_3_17) {
    node_heart_3_17.position.copy(endpoint_heart_3_17.start);
    node_heart_3_17.rotation.set(0.0, 3.3711, 0.0);
  } else {
    node_heart_3_17.position.set(-0.0146, -0.05, 0.0034);
    node_heart_3_17.rotation.set(0.0, 3.3711, 0.0);
  }
  node_heart_3_17.userData.sculptComponent = {"id": "heart-3", "name": "Heart leaf 4", "level": "meso", "role": "leaf", "importance": 0.6, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the heart whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the heart whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0122, 0.0374, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0255, 0.0749, 0.0], "rx": 0.0077, "rz": 0.0037, "twist": 55}, {"position": [0.0516, 0.1399, 0.0], "rx": 0.0418, "rz": 0.0362, "twist": 55}, {"position": [0.0777, 0.1917, 0.0], "rx": 0.0648, "rz": 0.056, "twist": 55}, {"position": [0.1038, 0.2301, 0.0], "rx": 0.0713, "rz": 0.0616, "twist": 55}, {"position": [0.1299, 0.2552, 0.0], "rx": 0.0528, "rz": 0.0455, "twist": 55}, {"position": [0.156, 0.2671, 0.0], "rx": 0.0, "rz": 0.0, "twist": 55}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [-0.0146, -0.05, 0.0034], "localEnd": [-0.1665, 0.2171, 0.0389], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.0146, -0.05, 0.0034], "rotation": [0, 3.3711, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "heart-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf-heart", "materialLayers": ["leaf-heart"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "heart whorl, offset 13 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(181, 220, 106, 1.0)", "secondaryAlbedo": "rgba(156, 207, 85, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_heart_3_17.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "heart-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["heart-core"] ?? root).add(node_heart_3_17);
  nodes["heart-3"] = node_heart_3_17;
  const mesh_heart_3_17Geometry = endpoint_heart_3_17
    ? new THREE.CylinderGeometry(endpoint_heart_3_17.endRadius, endpoint_heart_3_17.baseRadius, endpoint_heart_3_17.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0122, 0.0374, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0255, 0.0749, 0.0], "rx": 0.0077, "rz": 0.0037, "twist": 55}, {"position": [0.0516, 0.1399, 0.0], "rx": 0.0418, "rz": 0.0362, "twist": 55}, {"position": [0.0777, 0.1917, 0.0], "rx": 0.0648, "rz": 0.056, "twist": 55}, {"position": [0.1038, 0.2301, 0.0], "rx": 0.0713, "rz": 0.0616, "twist": 55}, {"position": [0.1299, 0.2552, 0.0], "rx": 0.0528, "rz": 0.0455, "twist": 55}, {"position": [0.156, 0.2671, 0.0], "rx": 0.0, "rz": 0.0, "twist": 55}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_heart_3_17) {
    mesh_heart_3_17Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_heart_3_17 = new THREE.Mesh(
    mesh_heart_3_17Geometry,
    materialMap["leaf-heart"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_heart_3_17.name = "Heart leaf 4";
  if (endpoint_heart_3_17) {
    mesh_heart_3_17.position.copy(endpoint_heart_3_17.midpoint);
    mesh_heart_3_17.quaternion.copy(endpoint_heart_3_17.quaternion);
  }
  mesh_heart_3_17.castShadow = options.castShadow ?? true;
  mesh_heart_3_17.receiveShadow = options.receiveShadow ?? true;
  mesh_heart_3_17.userData.sculptComponent = {"id": "heart-3", "name": "Heart leaf 4", "level": "meso", "role": "leaf", "importance": 0.6, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the heart whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the heart whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0122, 0.0374, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0255, 0.0749, 0.0], "rx": 0.0077, "rz": 0.0037, "twist": 55}, {"position": [0.0516, 0.1399, 0.0], "rx": 0.0418, "rz": 0.0362, "twist": 55}, {"position": [0.0777, 0.1917, 0.0], "rx": 0.0648, "rz": 0.056, "twist": 55}, {"position": [0.1038, 0.2301, 0.0], "rx": 0.0713, "rz": 0.0616, "twist": 55}, {"position": [0.1299, 0.2552, 0.0], "rx": 0.0528, "rz": 0.0455, "twist": 55}, {"position": [0.156, 0.2671, 0.0], "rx": 0.0, "rz": 0.0, "twist": 55}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [-0.0146, -0.05, 0.0034], "localEnd": [-0.1665, 0.2171, 0.0389], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.0146, -0.05, 0.0034], "rotation": [0, 3.3711, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "heart-3", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf-heart", "materialLayers": ["leaf-heart"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "heart whorl, offset 13 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(181, 220, 106, 1.0)", "secondaryAlbedo": "rgba(156, 207, 85, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_heart_3_17.add(mesh_heart_3_17);
  meshes["heart-3"] = mesh_heart_3_17;
  colliders["heart-3"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["heart-3"] ??= [];
  destructionGroups["heart-3"].push(node_heart_3_17);

  const endpoint_heart_4_18 = makeAttachmentEndpoint(null);
  const node_heart_4_18 = new THREE.Group();
  node_heart_4_18.name = "Heart leaf 5__pivot";
  node_heart_4_18.scale.set(1, 1, 1);
  if (endpoint_heart_4_18) {
    node_heart_4_18.position.copy(endpoint_heart_4_18.start);
    node_heart_4_18.rotation.set(0.0, 4.5499, 0.0);
  } else {
    node_heart_4_18.position.set(-0.0024, -0.05, 0.0148);
    node_heart_4_18.rotation.set(0.0, 4.5499, 0.0);
  }
  node_heart_4_18.userData.sculptComponent = {"id": "heart-4", "name": "Heart leaf 5", "level": "meso", "role": "leaf", "importance": 0.6, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the heart whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the heart whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0111, 0.034, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0232, 0.068, 0.0], "rx": 0.007, "rz": 0.0033, "twist": -55}, {"position": [0.0469, 0.127, 0.0], "rx": 0.0379, "rz": 0.0328, "twist": -55}, {"position": [0.0705, 0.1739, 0.0], "rx": 0.0589, "rz": 0.0508, "twist": -55}, {"position": [0.0942, 0.2088, 0.0], "rx": 0.0647, "rz": 0.056, "twist": -55}, {"position": [0.1179, 0.2317, 0.0], "rx": 0.0479, "rz": 0.0414, "twist": -55}, {"position": [0.1416, 0.2424, 0.0], "rx": 0.0, "rz": 0.0, "twist": -55}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [-0.0024, -0.05, 0.0148], "localEnd": [-0.0253, 0.1924, 0.1545], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.0024, -0.05, 0.0148], "rotation": [0, 4.5499, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "heart-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf-heart", "materialLayers": ["leaf-heart"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "heart whorl, offset 13 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(181, 220, 106, 1.0)", "secondaryAlbedo": "rgba(156, 207, 85, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_heart_4_18.userData.actionProfile = {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "heart-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}};
  (nodes["heart-core"] ?? root).add(node_heart_4_18);
  nodes["heart-4"] = node_heart_4_18;
  const mesh_heart_4_18Geometry = endpoint_heart_4_18
    ? new THREE.CylinderGeometry(endpoint_heart_4_18.endRadius, endpoint_heart_4_18.baseRadius, endpoint_heart_4_18.length, 8, 4)
    : buildTaperedSweepGeometry({"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0111, 0.034, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0232, 0.068, 0.0], "rx": 0.007, "rz": 0.0033, "twist": -55}, {"position": [0.0469, 0.127, 0.0], "rx": 0.0379, "rz": 0.0328, "twist": -55}, {"position": [0.0705, 0.1739, 0.0], "rx": 0.0589, "rz": 0.0508, "twist": -55}, {"position": [0.0942, 0.2088, 0.0], "rx": 0.0647, "rz": 0.056, "twist": -55}, {"position": [0.1179, 0.2317, 0.0], "rx": 0.0479, "rz": 0.0414, "twist": -55}, {"position": [0.1416, 0.2424, 0.0], "rx": 0.0, "rz": 0.0, "twist": -55}], "radialSegments": 4, "capEnds": false});
  if (!endpoint_heart_4_18) {
    mesh_heart_4_18Geometry.scale(1.0, 1.0, 1.0);
  }
  const mesh_heart_4_18 = new THREE.Mesh(
    mesh_heart_4_18Geometry,
    materialMap["leaf-heart"] ?? new THREE.MeshStandardMaterial({ color: 0x888888 })
  );
  mesh_heart_4_18.name = "Heart leaf 5";
  if (endpoint_heart_4_18) {
    mesh_heart_4_18.position.copy(endpoint_heart_4_18.midpoint);
    mesh_heart_4_18.quaternion.copy(endpoint_heart_4_18.quaternion);
  }
  mesh_heart_4_18.castShadow = options.castShadow ?? true;
  mesh_heart_4_18.receiveShadow = options.receiveShadow ?? true;
  mesh_heart_4_18.userData.sculptComponent = {"id": "heart-4", "name": "Heart leaf 5", "level": "meso", "role": "leaf", "importance": 0.6, "confidence": 0.75, "primitive": "tapered-sweep", "topologyClass": "open-shell", "topologyRationale": "Broad orbicular cupped leaf of the heart whorl, very short petiole, attached at the crown.", "geometryDescriptor": {"topologyIntent": "Broad orbicular cupped leaf of the heart whorl, very short petiole, attached at the crown. Low-poly flat-shaded restyle to match the host scene (Kenney Nature Kit).", "edgeTreatment": {"type": "none", "bevelRadius": 0.0, "segments": 1}, "deformationStack": [], "uvStrategy": "generated procedural coordinates", "normalStrategy": "vertex normals from generated geometry", "taperedSweep": {"stations": [{"position": [0.0, 0.0, 0.0], "rx": 0.012, "rz": 0.0216, "twist": 0}, {"position": [0.0111, 0.034, 0.0], "rx": 0.009600000000000001, "rz": 0.009600000000000001, "twist": 0}, {"position": [0.0232, 0.068, 0.0], "rx": 0.007, "rz": 0.0033, "twist": -55}, {"position": [0.0469, 0.127, 0.0], "rx": 0.0379, "rz": 0.0328, "twist": -55}, {"position": [0.0705, 0.1739, 0.0], "rx": 0.0589, "rz": 0.0508, "twist": -55}, {"position": [0.0942, 0.2088, 0.0], "rx": 0.0647, "rz": 0.056, "twist": -55}, {"position": [0.1179, 0.2317, 0.0], "rx": 0.0479, "rz": 0.0414, "twist": -55}, {"position": [0.1416, 0.2424, 0.0], "rx": 0.0, "rz": 0.0, "twist": -55}], "radialSegments": 4, "capEnds": false}}, "parent": "heart-core", "attachment": {"parentId": "heart-core", "parentSocket": "heart-core:node", "localStart": [-0.0024, -0.05, 0.0148], "localEnd": [-0.0253, 0.1924, 0.1545], "contactType": "socket", "embedDepth": 0.01, "gapTolerance": 0.01, "evidenceRefs": ["full-object"]}, "dimensions": {"width": 1.0, "height": 1.0, "depth": 1.0, "units": "relative", "confidence": 0.75}, "transform": {"position": [-0.0024, -0.05, 0.0148], "rotation": [0, 4.5499, 0], "scale": [1, 1, 1]}, "actionProfile": {"animationRole": "bendable-child", "pivot": {"mode": "socket", "localPosition": [0, 0, 0], "axis": [0, 1, 0], "confidence": 0.75}, "transformChannels": {"translate": true, "rotate": true, "scale": true, "bend": false, "twist": false, "detach": false, "visibility": true, "materialState": true}, "sockets": [], "collider": {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."}, "constraints": [], "destruction": {"breakable": false, "fractureGroup": "heart-4", "seamRefs": [], "detachableFragments": [], "breakImpulse": 0.0, "debrisMaterial": "base"}}, "material": "leaf-heart", "materialLayers": ["leaf-heart"], "deformations": [], "joints": [], "seams": [], "localFeatures": [{"id": "cup-camber", "kind": "bevel", "description": "strongly cupped blade", "evidenceRefs": ["full-object"]}, {"id": "apex-droop", "kind": "contour", "description": "margin curls outward", "evidenceRefs": ["full-object"]}, {"id": "margin", "kind": "contour", "description": "undulate margin", "evidenceRefs": ["full-object"]}, {"id": "whorl", "kind": "fastener", "description": "heart whorl, offset 13 deg", "evidenceRefs": ["full-object"]}], "surfaceDetail": {"macroRoughness": 0.45, "microRoughness": 0.08, "bumpAmplitude": 0.01, "normalPattern": "soft puckered blade with pale midrib (reference-derived normal map)", "displacementPattern": "", "occlusionPattern": "darker deep inside the cups and where whorls overlap", "edgeWearPattern": "", "notes": "satin, wet-glossy toward the heart"}, "evidenceRefs": ["full-object"], "details": [], "fidelityTier": "blockout", "colorMaterialRecipe": {"dominantAlbedo": "rgba(181, 220, 106, 1.0)", "secondaryAlbedo": "rgba(156, 207, 85, 1.0)", "materialClass": "unknown", "materialClassConfidence": 0.6, "notes": "Organic plant tissue / soil: not in the fixed class list (metal..stone); dielectric, metalness 0.", "evidenceRefs": ["full-object"]}};
  node_heart_4_18.add(mesh_heart_4_18);
  meshes["heart-4"] = mesh_heart_4_18;
  colliders["heart-4"] = {"type": "capsule", "offset": [0, 0, 0], "scale": [1, 1, 1], "isTrigger": false, "notes": "Proxy only."};
  destructionGroups["heart-4"] ??= [];
  destructionGroups["heart-4"].push(node_heart_4_18);
  // repetition system "outer-whorl" describes 6 parts that are already built individually; not instanced.
  // repetition system "middle-whorl" describes 6 parts that are already built individually; not instanced.
  // repetition system "heart-whorl" describes 6 parts that are already built individually; not instanced.

  root.userData.sculptRuntime = { nodes, meshes, sockets, colliders, destructionGroups } satisfies ProceduralModelRuntime;
  root.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  root.userData.actionReadiness = {
    note: 'Use root.userData.sculptRuntime.nodes for transforms, sockets for attachments, colliders for physics proxies, and destructionGroups for breakable sets.',
  };
  return root;
}

export function createLettucePlantLookDevLights(
  mode: 'neutral' | 'grazing' | 'reference' = 'neutral',
): THREE.Group {
  const lights = new THREE.Group();
  lights.name = "Lettuce plant look-dev lights";
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
  lights.userData.lightingFromPhoto = [{"id": "key", "type": "large softbox", "direction": "top-front", "intensity": "high", "color": "#FFFFFF", "evidence": "bright tops of the cups, soft specular on wet heart", "hostMapping": "DirectionalLight (3,7,4) 2.2"}, {"id": "fill", "type": "environment bounce", "direction": "white seamless sweep", "intensity": "high", "color": "#F6F8F4", "evidence": "low-contrast shadows inside cups", "hostMapping": "HemisphereLight 1.6 + Ambient 0.9"}, {"id": "rim", "type": "transmission", "direction": "behind", "intensity": "low", "color": "#E8F5D0", "evidence": "translucent lighter leaf margins", "hostMapping": "none; lighter margins via albedo"}, {"id": "exposure-shadow", "type": "render settings", "exposure": "neutral 1.0, sRGB, no tone mapping (host renderer)", "contactShadow": "outer whorl casts a soft contact shadow on the soil disc; AO inside the cups", "evidence": "soft shadow under the head in the photo"}];
  lights.userData.lookDevTargets = {"qualityPriority": "reference-fidelity", "materialPass": {"albedoPaletteRequired": true, "roughnessVariationRequired": true, "normalOrBumpRequired": true, "localOverridesRequired": true, "minimumTextureResolution": 1024, "preferredTextureResolution": 2048, "independentMapChannels": ["albedo", "roughness", "height", "normal", "ambient-occlusion"], "requiredSurfaceFrequencyBands": ["macro", "meso", "micro"], "geometryReliefRequiredWhenSilhouetteAffected": true, "referencePbrExtraction": {"requiredWhenSourceImagePresent": true, "targetThreshold": 0.7, "stopOnLowConfidence": true, "script": "forge/stage1_intake/extract_pbr_evidence.py", "acceptedLimitation": "single-image extraction is reference-derived inference, not exact photogrammetry"}, "mustAvoid": ["single flat albedo per material", "uniform roughness", "albedo texture reused as roughness/height/normal/AO", "single-frequency random noise", "plastic-looking smooth bark, stone, cloth, foliage, or aged material", "local color/detail described only in prose without material masks", "claiming exact PBR recovery when confidence is below the target threshold"]}, "lightingPass": {"requiredTerms": ["key light", "fill light", "rim or environment light", "exposure", "tone mapping", "background", "contact shadow"], "mustAvoid": ["ambient-only lighting", "flat value range", "missing contact shadow", "reference lighting copied without separating material readability"]}, "screenshotReview": ["Compare albedo palette and local color zones.", "Compare roughness/normal/bump response under light.", "Compare cavity dirt, edge wear, stains, moss, scratches, or other local masks.", "Compare key/fill/rim structure, exposure, tone mapping, background, and contact shadows.", "Capture a neutral-light render to verify material readability without reference lighting.", "Capture a grazing-light close-up to expose flat normals, uniform roughness, tiling, and plastic highlights.", "Capture a reference-matched render from the same camera framing as the source."]};
  return lights;
}

// PBR materials (clearcoat/iridescence/transmission/anisotropy) need an environment
// map to visually behave as intended — call this once per renderer and assign the
// result to scene.environment before rendering. No external HDR asset required.
export function createLettucePlantEnvironment(renderer: THREE.WebGLRenderer): THREE.Texture {
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
export function frameLettucePlantCamera(
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
export function createLettucePlantPresentationComposer(
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

export function configureLettucePlantRenderer(renderer: THREE.WebGLRenderer): void {
  // Load-bearing for view-dependent finishes (anodized / Doppler): without ACES + sRGB
  // the environment reflection reads flat/washed instead of a believable metal response.
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
}

export function createLettucePlantInspectControls(
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
