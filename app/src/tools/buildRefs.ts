// Генератор src/data/refs.json — см. build-refs.html и lib/recognize.ts.
import { decide, embed, square } from '../lib/recognize'
import CURRENT from '../data/refs.json'

const files = import.meta.glob('../../../img/ref/*/*.{jpg,jpeg,png,JPG,JPEG,PNG}',
  { query: '?url', import: 'default', eager: true }) as Record<string, string>
const log = (s: string) => { document.getElementById('log')!.textContent += '\n' + s }

const toB64 = (v: Float32Array) => {
  let s = ''
  for (const a of v) s += String.fromCharCode(Math.max(-127, Math.min(127, Math.round(a * 127))) & 255)
  return btoa(s)
}

async function main() {
  const entries = Object.entries(files).sort()
  log(`фото: ${entries.length}`)
  const labels: string[] = [], vecs: Float32Array[] = [], names: string[] = []
  for (const [path, url] of entries) {
    const label = path.split('/').slice(-2)[0]
    const im = new Image(); im.src = url; await im.decode()
    vecs.push(await embed(square(im))); labels.push(label); names.push(path.split('/').pop()!)
  }
  // Квантование int8 — тем же путём, каким приложение их читает.
  const q = vecs.map(v => { const b = atob(toB64(v)); const o = new Float32Array(v.length); for (let i = 0; i < v.length; i++) o[i] = ((b.charCodeAt(i) << 24) >> 24) / 127; return o })
  // Проверка «один на выход»: каждое фото против всех остальных — тем же
  // правилом, что в приложении (decide), без порога.
  const rows = q.map((v, i) => {
    const g = decide(v, q, labels, -1, i)
    return { label: labels[i], got: g.id ?? 'other', best: g.sim, name: names[i] }
  })
  const cls = [...new Set(labels)]
  for (const c of cls) {
    const r = rows.filter(x => x.label === c)
    const ok = r.filter(x => x.got === c).length
    log(`${c}: ${ok}/${r.length} верно` + r.filter(x => x.got !== c).map(x => `\n   ✗ ${x.name} → ${x.got}`).join(''))
  }
  // Порог: ниже всех верно узнанных растений с запасом — он режет только то,
  // что далеко от любого эталона, а не сомнительные, но правильные ответы.
  const okSims = rows.filter(x => x.label !== 'other' && x.got === x.label).map(x => x.best).sort((a, b) => a - b)
  const minSim = okSims.length ? +(okSims[0] - 0.05).toFixed(3) : 0.5
  log(`minSim = ${minSim}`)
  const json = JSON.stringify({ dim: q[0].length, labels, vecs: vecs.map(toB64), minSim })
  // Запись refs.json перезагружает эту страницу (Vite следит за импортом), и
  // без проверки она считала бы и писала по кругу.
  if (JSON.stringify(CURRENT) === json) {
    log('refs.json не изменился')
    ;(window as unknown as { __done: boolean }).__done = true
    return
  }
  const r = await fetch('/__refs', { method: 'POST', body: json })
  log(r.ok ? `записано: src/data/refs.json (${json.length} символов)` : `ОШИБКА записи ${r.status}`)
  ;(window as unknown as { __done: boolean }).__done = true
}
main().catch(e => log('ОШИБКА ' + e))
