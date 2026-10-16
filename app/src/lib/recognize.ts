// Распознавание на телефоне, без ключа и сервера. Выбор владельца: на стенде
// три растения — перец, салат, базилик — и узнавать надо только их.
//
// Как устроено: MobileNet v2 (веса лежат в /models/mobilenet-v2, грузятся один
// раз и дальше из кэша) превращает снимок в вектор из 1280 чисел. Векторы
// эталонов посчитаны заранее (data/refs.json, генератор — build-refs.html) по
// фото из img/ref/<вид>/. Снимок сравнивается с эталонами каждого класса,
// побеждает класс с самыми близкими (см. decide). Среди эталонов есть класс 'other' — столы, провода, комнаты,
// другие растения: если ближе всего он, мы говорим «это не ваше растение», а не
// натягиваем ответ на ближайший из трёх.
//
// Чтобы узнавание стало точнее, достаточно положить снимки самих растений со
// стенда в img/ref/<вид>/ и пересчитать refs.json.

import { ASSET_ROOT } from './assets'
import REFS from '../data/refs.json'
import { SP, type Species } from '../data/species'

export const SIZE = 224
const M = 3      // ближайших эталонов на класс
const T = 30     // «температура» уверенности: разница сходства 0.05 ≈ 4.5 раза
const MARGIN = 0.03  // отрыв от второго класса меньше — ничья, не узнали

type Graph = import('@tensorflow/tfjs-converter').GraphModel
type TF = typeof import('@tensorflow/tfjs-core')
let ready: Promise<{ tf: TF; model: Graph }> | null = null

/** Модель и tfjs (~1 МБ кода + 14 МБ весов) грузятся только при первом скане. */
export function loadModel() {
  ready ??= (async () => {
    const [tf, conv] = await Promise.all([
      import('@tensorflow/tfjs-core'),
      import('@tensorflow/tfjs-converter'),
      import('@tensorflow/tfjs-backend-webgl'),
      import('@tensorflow/tfjs-backend-cpu'),
    ])
    // WebGL есть не везде (старые устройства, режим энергосбережения) — тогда CPU:
    // медленнее, но ответ тот же.
    if (!(await tf.setBackend('webgl').catch(() => false))) await tf.setBackend('cpu')
    await tf.ready()
    const model = await conv.loadGraphModel(`${ASSET_ROOT}models/mobilenet-v2/model.json`)
    return { tf, model }
  })()
  ready.catch(() => { ready = null })   // сбой сети не должен навсегда ломать скан
  return ready
}

/** Центральный квадрат кадра, 224×224 — одинаково для эталонов и для снимка. */
export function square(src: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement): HTMLCanvasElement {
  const w = 'naturalWidth' in src ? src.naturalWidth : 'videoWidth' in src ? src.videoWidth : src.width
  const h = 'naturalHeight' in src ? src.naturalHeight : 'videoHeight' in src ? src.videoHeight : src.height
  const s = Math.min(w, h)
  const c = document.createElement('canvas')
  c.width = c.height = SIZE
  c.getContext('2d')!.drawImage(src, (w - s) / 2, (h - s) / 2, s, s, 0, 0, SIZE, SIZE)
  return c
}

/** Вектор снимка единичной длины: дальше сходство — просто скалярное произведение. */
export async function embed(c: HTMLCanvasElement): Promise<Float32Array> {
  const { tf, model } = await loadModel()
  const out = tf.tidy(() => {
    const x = tf.expandDims(tf.div(tf.cast(tf.browser.fromPixels(c), 'float32'), 255), 0)
    return tf.reshape(model.execute(x, 'module_apply_default/MobilenetV2/Logits/AvgPool') as import('@tensorflow/tfjs-core').Tensor, [-1])
  })
  const v = (await out.data()) as Float32Array
  out.dispose()
  let n = 0
  for (const a of v) n += a * a
  n = Math.sqrt(n) || 1
  return v.map(a => a / n)
}

// ── эталоны: int8, по строке base64 на снимок
interface RefFile { dim: number; labels: string[]; vecs: string[]; minSim: number }
const R = REFS as RefFile
let refVecs: Float32Array[] | null = null
function refs(): Float32Array[] {
  refVecs ??= R.vecs.map(b => {
    const bin = atob(b)
    const v = new Float32Array(R.dim)
    for (let i = 0; i < R.dim; i++) v[i] = ((bin.charCodeAt(i) << 24) >> 24) / 127
    return v
  })
  return refVecs
}

/** all — среднее сходство по каждому классу: по нему подбирают порог. */
export type Guess = { id: string | null; score: number; sim: number; all: Record<string, number> }

/**
 * Сбалансированное правило: у каждого класса — среднее сходство его M ближайших
 * эталонов. Голосование K ближайших по всем эталонам сразу отдавало победу
 * классу, у которого эталонов больше (14 базиликов против 5 салатов — салат не
 * узнавался вовсе). score — уверенность: мягкий максимум по классам.
 * skip — индекс эталона, который не учитывать (проверка «один на выход»).
 */
export function decide(v: Float32Array, vecs: Float32Array[], labels: string[], minSim: number, skip = -1): Guess {
  const by: Record<string, number[]> = {}
  vecs.forEach((r, i) => {
    if (i === skip) return
    let s = 0
    for (let j = 0; j < r.length; j++) s += r[j] * v[j]
    ;(by[labels[i]] ??= []).push(s)
  })
  const cls = Object.entries(by).map(([c, ss]) => {
    const top = ss.sort((a, b) => b - a).slice(0, M)
    return { c, s: top.reduce((a, b) => a + b, 0) / top.length }
  }).sort((a, b) => b.s - a.s)
  const e = cls.map(x => Math.exp((x.s - cls[0].s) * T))
  const score = e[0] / e.reduce((a, b) => a + b, 0)
  const { c: top, s: sim } = cls[0]
  // Ближе всего «не то», далеко от всего, что мы видели, или ничья со вторым
  // классом — честнее сказать «не узнали», чем угадывать.
  const all = Object.fromEntries(cls.map(x => [x.c, +x.s.toFixed(3)]))
  const tie = cls.length > 1 && sim - cls[1].s < MARGIN
  return { id: top === 'other' || sim < minSim || tie ? null : top, score, sim, all }
}

export const classify = (v: Float32Array) => decide(v, refs(), R.labels, R.minSim)

/** Снимок из data-URL → догадка. */
export async function recognize(photo: string): Promise<Guess> {
  const im = new Image()
  im.src = photo
  await im.decode()
  return classify(await embed(square(im)))
}

// ── для экрана скана

/** Виды, которые умеем узнавать, — те, для которых есть эталоны. */
export const KNOWN: Species[] = [...new Set(R.labels)].filter(l => l !== 'other')
  .map(id => SP(id)).filter((x): x is Species => !!x)

export type ScanResult =
  | { t: 'match'; sp: Species; pct: number }
  | { t: 'none' }       // не похоже ни на одно из наших растений
  | { t: 'offline' }    // модель не загрузилась (первый скан без сети)

export async function identify(photo: string): Promise<ScanResult> {
  try {
    const g = await recognize(photo)
    const sp = g.id ? SP(g.id) : undefined
    return sp ? { t: 'match', sp, pct: Math.round(g.score * 100) } : { t: 'none' }
  } catch {
    return { t: 'offline' }
  }
}
