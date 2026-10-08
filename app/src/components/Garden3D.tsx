// 3D-огород на главной: горшок на каждое растение, растение растёт с возрастом,
// жаждущие помечены каплей (тап по ней — полив), готовые к сбору — лаймовым
// кольцом. Вращается пальцем, тап по горшку открывает карточку растения.
//
// Модели — Kenney Nature Kit и Furniture Kit (CC0, models/LICENSE-kenney-*.txt),
// не рисованные руками. Процедурные здесь только служебные метки: пол-сцена,
// кольцо готовности, капля и колышек с фото растения — это интерфейс поверх
// сцены, а не арт.
//
// Модуль грузится лениво (React.lazy в Home): three весит больше всего
// приложения, первый кадр главной его ждать не должен.

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { ASSET_ROOT, img } from '../lib/assets'
import { hPct, isEdible, wDue, type Plant } from '../lib/plants'

/** Модель по виду. Точных моделей на все 29 культур в наборе нет — берём
    ближайшую по форме роста. */
const MODEL: Record<string, string> = {
  lettuce: 'crops_leafsStageB', chard: 'crops_leafsStageB', mustard: 'crops_leafsStageB',
  kale: 'crops_leafsStageB', microgreens: 'crops_leafsStageA',
  radish: 'crop_turnip', turnips: 'crop_turnip', beets: 'crop_turnip', carrots: 'crop_carrot',
  squash: 'crop_pumpkin', cucumber: 'crop_melon',
  basil: 'plant_bushSmall', parsley: 'plant_bushSmall', cilantro: 'plant_bushSmall',
  chives: 'plant_flatShort', onions: 'plant_flatShort', beans: 'plant_flatTall',
  tomato: 'plant_bushDetailed', cherrytomato: 'plant_bushDetailed',
  pepper: 'plant_bushDetailed', eggplant: 'plant_bushDetailed',
  monstera: 'plant_bushLarge', fiddleleaf: 'plant_bushLargeTriangle', snakeplant: 'plant_flatTall',
  pothos: 'plant_bush', zzplant: 'plant_bushTriangle', peacelily: 'plant_bushLarge',
  aloe: 'plant_flatShort', calathea: 'plant_bush',
}
const modelOf = (p: Plant) => MODEL[p.s.id] || 'plant_bush'
const bigPot = (p: Plant) => /gal/.test(p.s.pot) && !/^0\.5/.test(p.s.pot)
const tallPlant = (p: Plant) => /bushLarge|flatTall|bushDetailed/.test(modelOf(p))
/** Три горшка: высокий под высокие кусты (Furniture pottedPlant), широкий под
    крупные овощи (Nature pot_large), малый под зелень и травы (Furniture plantSmall1). */
const potOf = (p: Plant): [string, number] =>
  tallPlant(p) ? ['pot_tall', 0.56] : bigPot(p) ? ['pot_large', 0.8] : ['pot_herb', 0.56]

const LIME = 0xB4F461, GREEN = 0x3FA34D
/** Палитра набора → палитра бренда: бирюза Kenney читалась как пластик. */
const TINT: Record<string, number> = { grass: GREEN, leafsGreen: 0x5DBB5A, leafsDark: 0x2F8A4C, stone: 0xC9CFC7 }

const cache = new Map<string, Promise<THREE.Group>>()
const loader = new GLTFLoader()
function model(name: string): Promise<THREE.Group> {
  if (!cache.has(name)) {
    cache.set(name, loader.loadAsync(`${ASSET_ROOT}models/${name}.glb`).then(g => {
      // В материалах набора не задан metallic, а по glTF его умолчание — 1.
      // Металл без карты окружения в тени чёрный: листья шли чёрными клиньями.
      // Заодно бирюзовая «трава» набора → зелень бренда.
      // Горшки Furniture Kit продаются с растением внутри — его снимаем.
      const strip: THREE.Object3D[] = []
      g.scene.traverse(o => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        if (name.startsWith('pot_') && (m.material as THREE.Material).name === 'plant') { strip.push(m); return }
        for (const x of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[]) {
          x.metalness = 0; x.roughness = 0.85
          if (TINT[x.name] !== undefined) x.color = new THREE.Color(TINT[x.name])
        }
      })
      strip.forEach(o => o.removeFromParent())
      // Горшок и растение там делят один буфер вершин: без пересборки рамка
      // горшка включала снятое растение, и посадка уезжала вверх.
      if (strip.length) g.scene.traverse(o => {
        const m = o as THREE.Mesh
        if (m.isMesh) m.geometry = m.geometry.toNonIndexed()
      })
      return g.scene
    }))
  }
  return cache.get(name)!.then(s => s.clone(true))
}

/** Привести модель к нужной высоте/ширине и поставить низом на y=0. */
function fit(obj: THREE.Object3D, size: number, by: 'h' | 'w') {
  const b = new THREE.Box3().setFromObject(obj)
  const s = b.getSize(new THREE.Vector3())
  const k = size / (by === 'h' ? s.y : Math.max(s.x, s.z))
  obj.scale.setScalar(k)
  const b2 = new THREE.Box3().setFromObject(obj)
  const c = b2.getCenter(new THREE.Vector3())
  obj.position.set(-c.x, -b2.min.y, -c.z)
  return b2.max.y - b2.min.y
}

/** Капля — иконка Phosphor drop, нарисованная в canvas-текстуру спрайта. */
function dropSprite(): THREE.Sprite {
  const c = document.createElement('canvas'); c.width = c.height = 128
  const g = c.getContext('2d')!
  // Синяя: капля должна читаться как вода с первого взгляда.
  g.fillStyle = '#2F8FE0'; g.beginPath(); g.arc(64, 64, 60, 0, Math.PI * 2); g.fill()
  g.translate(24, 22); g.scale(80 / 256, 80 / 256)
  g.fillStyle = '#FFFFFF'
  g.fill(new Path2D('M174,47.75a254.19,254.19,0,0,0-41.45-38.3,8,8,0,0,0-9.18,0A254.19,254.19,0,0,0,82,47.75C54.51,79.32,40,112.6,40,144a88,88,0,0,0,176,0C216,112.6,201.49,79.32,174,47.75Z'))
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false }))
  sp.scale.setScalar(0.42); sp.renderOrder = 10
  return sp
}

/** Фото с карточки растения — круглое, в белой рамке: табличка на колышке. */
const photos = new Map<string, THREE.CanvasTexture>()
function photoTex(name: string): THREE.CanvasTexture {
  let t = photos.get(name)
  if (t) return t
  const c = document.createElement('canvas'); c.width = c.height = 128
  t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  photos.set(name, t)
  const im = new Image()
  im.onload = () => {
    const g = c.getContext('2d')!
    g.fillStyle = '#FFFFFF'; g.beginPath(); g.arc(64, 64, 62, 0, Math.PI * 2); g.fill()
    g.save(); g.beginPath(); g.arc(64, 64, 54, 0, Math.PI * 2); g.clip()
    const k = Math.max(108 / im.width, 108 / im.height)
    g.drawImage(im, 64 - im.width * k / 2, 64 - im.height * k / 2, im.width * k, im.height * k)
    g.restore(); t!.needsUpdate = true
  }
  im.src = img(name)
  return t
}

/** Табличка над растением: фото на колышке, воткнутом в центр горшка (ствол
    колышка прячется в листве). Фото — спрайт, всегда лицом к камере. */
const PHOTO = 0.5
function photoStake(name: string, soil: number, at: number, slot: number): THREE.Group {
  const g = new THREE.Group()
  const len = at - soil
  const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, len, 6),
    new THREE.MeshStandardMaterial({ color: 0xC9A27A, roughness: 0.9 }))
  stick.position.y = soil + len / 2; stick.castShadow = true; stick.userData.slot = slot
  // alphaTest: прозрачные углы квадрата иначе писали глубину и срезали то, что за ними.
  const ph = new THREE.Sprite(new THREE.SpriteMaterial({ map: photoTex(name), alphaTest: 0.5 }))
  ph.scale.setScalar(PHOTO); ph.position.y = at; ph.userData.slot = slot
  g.add(stick, ph)
  return g
}

interface Slot { i: number; root: THREE.Group; plant: THREE.Object3D; drop?: THREE.Sprite; ring?: THREE.Mesh; h: number; dropY: number; bounce: number }

export default function Garden3D({ plants, onOpen, onWater }:
    { plants: Plant[]; onOpen: (i: number) => void; onWater: (i: number) => void }) {
  const host = useRef<HTMLDivElement>(null)
  const api = useRef<{ build: (p: Plant[]) => void } | null>(null)
  const cb = useRef({ onOpen, onWater })
  cb.current = { onOpen, onWater }

  useEffect(() => {
    const el = host.current!
    const strong = (navigator.hardwareConcurrency || 4) >= 6
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.shadowMap.enabled = strong
    renderer.shadowMap.type = THREE.PCFShadowMap
    el.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    const cam = new THREE.PerspectiveCamera(32, 1, 0.1, 100)
    // Мягкий заполняющий свет: без него нижние грани тонких листьев уходили
    // в чёрное и читались как дыры.
    scene.add(new THREE.HemisphereLight(0xF2F4F0, 0x5E8F55, 1.6))
    scene.add(new THREE.AmbientLight(0xffffff, 0.9))
    const sun = new THREE.DirectionalLight(0xffffff, 2.2)
    sun.position.set(3, 7, 4); sun.castShadow = strong
    sun.shadow.mapSize.set(1024, 1024)
    // Без смещения тонкие листья Kenney ловят собственную тень полосами.
    sun.shadow.bias = -0.0006; sun.shadow.normalBias = 0.03
    Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5 })
    scene.add(sun)

    const world = new THREE.Group(); scene.add(world)
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 3.5, 0.18, 48),
      new THREE.MeshStandardMaterial({ color: 0x4E9A45, roughness: 0.95 }))
    floor.position.y = -0.09; floor.receiveShadow = true; world.add(floor)
    // Заборчик по задней дуге: балкон, а не поле.
    for (let k = 0; k < 7; k++) {
      const a = Math.PI * (0.15 + 0.7 * k / 6) + Math.PI
      model('fence_simple').then(f => {
        fit(f, 1.0, 'w'); const w = new THREE.Group(); w.add(f)
        w.position.set(Math.cos(a) * 3.1, 0, Math.sin(a) * 3.1)
        w.rotation.y = -a + Math.PI / 2; world.add(w)
      })
    }

    // Окружение — деревня: дома соседей с огородами и деревья по кольцу вокруг
    // площадки. Кольцо крутится вместе с ней (неподвижный задник висел в
    // воздухе мёртвой картинкой). Радиус больше дистанции камеры: передняя дуга
    // уходит ЗА камеру, а боковые — за края кадра, так что перед горшками
    // ничего не проходит. Блеклость — туман, а не перекраска моделей.
    scene.fog = new THREE.Fog(0xDCEBD9, 8, 24)
    // Луг до горизонта; край растворяется по альфе в CSS-небо.
    const fade = document.createElement('canvas'); fade.width = fade.height = 256
    const fc = fade.getContext('2d')!
    const fg = fc.createRadialGradient(128, 128, 0, 128, 128, 128)
    fg.addColorStop(0.7, '#fff'); fg.addColorStop(1, '#000')
    fc.fillStyle = fg; fc.fillRect(0, 0, 256, 256)
    const meadow = new THREE.Mesh(new THREE.CircleGeometry(24, 64),
      new THREE.MeshStandardMaterial({ color: 0x6FAE5C, roughness: 1, transparent: true,
        alphaMap: new THREE.CanvasTexture(fade), depthWrite: false }))
    meadow.rotation.x = -Math.PI / 2; meadow.position.y = -0.18; meadow.receiveShadow = true
    scene.add(meadow)
    const place = (name: string, size: number, by: 'h' | 'w', x: number, z: number, parent: THREE.Group, ry = 0, shadow = strong) =>
      model(name).then(m => {
        fit(m, size, by); const w = new THREE.Group(); w.add(m)
        w.position.set(x, 0, z); w.rotation.y = ry
        m.traverse(o => { if ((o as THREE.Mesh).isMesh) o.castShadow = shadow })
        parent.add(w)
      })
    const HOUSES = ['i', 'j', 'm', 'n', 'r', 's', 't', 'u']
    const TREES = ['tree_oak', 'tree_default', 'tree_fat', 'tree_pineRoundA']
    const BEDS = ['crops_leafsStageB', 'crop_pumpkin', 'crop_carrot', 'plant_bushSmall']
    const village = new THREE.Group(); world.add(village)
    // Локальные координаты двора: дом смотрит на +z, то есть на площадку.
    const at = (phi: number, r: number, dx: number, dz: number): [number, number] => {
      const fx = -Math.sin(phi), fz = -Math.cos(phi) // к центру
      const rx = Math.cos(phi), rz = -Math.sin(phi)  // вправо
      return [Math.sin(phi) * r + rx * dx + fx * dz, Math.cos(phi) * r + rz * dx + fz * dz]
    }
    const N = 12
    for (let k = 0; k < N; k++) {
      const h = HOUSES[k % HOUSES.length]
      const phi = (k / N) * Math.PI * 2 + 0.3, r = 13 + (k % 3) * 0.9, ry = phi + Math.PI
      place('suburban/building-type-' + h, 2.2, 'w', ...at(phi, r, 0, 0), village, ry, false)
      // Огород соседа перед домом: грядка в три куста.
      for (let j = 0; j < 3; j++)
        place(BEDS[(k + j) % BEDS.length], 0.45, 'h', ...at(phi, r, -0.6 + j * 0.6, 1.9), village, ry, false)
      // Дерево между дворами.
      place(TREES[k % TREES.length], 2.0 + (k % 2) * 0.5, 'h', ...at(phi + Math.PI / N, r + 0.8, 0, 0), village, 0, false)
    }
    let seed = 7
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 }
    const DECOR: Array<[string, number]> = [['grass', 0.32], ['grass_large', 0.4], ['flower_redB', 0.42],
      ['flower_yellowB', 0.4], ['flower_purpleA', 0.4], ['stone_smallA', 0.28], ['stone_smallFlatA', 0.3],
      ['mushroom_redGroup', 0.3]]
    for (let k = 0; k < 26; k++) {
      const [n, s] = DECOR[k % DECOR.length]
      const a = (k / 26) * Math.PI * 2 + rnd() * 0.2, r = 2.55 + rnd() * 0.7
      // Камни плоские: их меряем по ширине, иначе масштаб по высоте раздувал их в глыбы.
      place(n, s * (0.8 + rnd() * 0.5), n.startsWith('stone') ? 'w' : 'h', Math.cos(a) * r, Math.sin(a) * r, world, rnd() * 6)
    }

    let slots: Slot[] = []
    const pots = new THREE.Group(); world.add(pots)
    const build = (list: Plant[]) => {
      pots.clear(); slots = []
      const n = list.length
      const cols = Math.max(1, Math.ceil(Math.sqrt(n)))
      const gap = n > 9 ? 1.0 : 1.25
      list.forEach((p, i) => {
        const r = Math.floor(i / cols), c = i % cols
        const rows = Math.ceil(n / cols)
        const root = new THREE.Group()
        root.position.set((c - (cols - 1) / 2) * gap, 0, (r - (rows - 1) / 2) * gap)
        pots.add(root)
        const [potName, potW] = potOf(p)
        const slot: Slot = { i, root, plant: new THREE.Group(), h: 0, dropY: 0, bounce: 0 }
        slots.push(slot)
        Promise.all([model(potName), model(modelOf(p))]).then(([pot, pl]) => {
          const ph = fit(pot, potW, 'w')
          pot.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.userData.slot = i } })
          root.add(pot)
          // Рост: от 45% до полного размера к сроку урожая (комнатные — сразу полные).
          const grow = isEdible(p) ? 0.45 + 0.55 * Math.min(1, hPct(p) / 100) : 1
          const tall = tallPlant(p) ? 1.35 : 0.95
          const h = fit(pl, tall * grow, 'h')
          const wrap = new THREE.Group(); wrap.add(pl); wrap.position.y = ph * 0.86
          // Листья в наборе односторонние: с обратной стороны лист пропадал.
          pl.traverse(o => {
            const m = o as THREE.Mesh
            if (!m.isMesh) return
            m.castShadow = true; m.userData.slot = i
            const mats = Array.isArray(m.material) ? m.material : [m.material]
            mats.forEach(x => { x.side = THREE.DoubleSide })
          })
          root.add(wrap)
          slot.plant = wrap; slot.h = ph * 0.86 + h
          // Фото над верхушкой, капля — бейджем на его правом верхнем углу:
          // столбиком над фото она уходила за край кадра под плашки.
          const at = slot.h + PHOTO / 2 + 0.02
          if (p.s.img) root.add(photoStake(p.s.img, ph * 0.86, at, i))
          slot.dropY = p.s.img ? at : slot.h + 0.32
          if (wDue(p) <= 0) {
            const d = dropSprite(); d.position.y = slot.dropY; d.userData.drop = i
            if (p.s.img) { d.scale.setScalar(0.3); d.center.set(0.5 - 0.2 / 0.3, 0.5 - 0.2 / 0.3) }
            root.add(d); slot.drop = d
          }
          if (isEdible(p) && hPct(p) >= 100) {
            const ring = new THREE.Mesh(new THREE.TorusGeometry(bigPot(p) ? 0.52 : 0.42, 0.035, 8, 40),
              new THREE.MeshBasicMaterial({ color: LIME, transparent: true }))
            ring.rotation.x = -Math.PI / 2; ring.position.y = 0.02
            root.add(ring); slot.ring = ring
          }
        })
      })
    }
    api.current = { build: (l: Plant[]) => { build(l); size() } }

    // ── вращение пальцем с инерцией, тап — открыть или полить
    let rot = -0.5, vel = 0.0025, dragging = false, x0 = 0, xl = 0, moved = 0, idle = 0
    const ray = new THREE.Raycaster(), ndc = new THREE.Vector2()
    const splash: Array<{ m: THREE.Points; t: number }> = []
    const onDown = (e: PointerEvent) => { dragging = true; x0 = xl = e.clientX; moved = 0; vel = 0; el.setPointerCapture(e.pointerId) }
    const onMove = (e: PointerEvent) => {
      if (!dragging) return
      const dx = e.clientX - xl; xl = e.clientX; moved += Math.abs(dx)
      rot += dx * 0.009; vel = dx * 0.009; idle = 0
    }
    const onUp = (e: PointerEvent) => {
      if (!dragging) return
      dragging = false
      if (moved > 6 || Math.abs(e.clientX - x0) > 6) return
      const r = el.getBoundingClientRect()
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1)
      ray.setFromCamera(ndc, cam)
      const hits = ray.intersectObjects(pots.children, true)
      // Капля рисуется поверх фото и стоит на том же расстоянии — она главнее.
      const hit = hits.find(h => h.object.userData.drop !== undefined) || hits[0]
      if (!hit) return
      const di = hit.object.userData.drop
      if (di !== undefined) { water(di); return }
      const si = hit.object.userData.slot
      if (si !== undefined) cb.current.onOpen(si)
    }
    const water = (i: number) => {
      const s = slots[i]; if (!s) return
      if (s.drop) { s.root.remove(s.drop); s.drop = undefined }
      s.bounce = 1
      // Брызги: горсть лаймовых точек вверх и в стороны, гаснут за секунду.
      const N = 26, pos = new Float32Array(N * 3), v: number[] = []
      for (let k = 0; k < N; k++) { pos[k * 3 + 1] = s.h; v.push((Math.random() - .5) * .05, .05 + Math.random() * .05, (Math.random() - .5) * .05) }
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.userData.v = v
      const m = new THREE.Points(g, new THREE.PointsMaterial({ color: LIME, size: 0.07, transparent: true }))
      s.root.add(m); splash.push({ m, t: 0 })
      // В состояние — после брызг: смена состояния перестраивает горшки.
      window.setTimeout(() => cb.current.onWater(i), 900)
    }
    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', () => { dragging = false })

    const size = () => {
      const w = el.clientWidth, h = el.clientHeight
      renderer.setSize(w, h, false)
      cam.aspect = w / h
      const d = 5.6 + Math.max(0, Math.sqrt(slots.length || 4) - 2) * 1.5
      // Ширина охвата — как у прежнего кадра 358×340 (FOV 32 по вертикали),
      // чтобы горшки не резались по бокам в высокой карточке. Низ кадра там
      // же, где был, а вся добавленная высота уходит вверх — на деревню.
      const half = Math.atan(Math.tan(THREE.MathUtils.degToRad(16)) * (358 / 340) / cam.aspect)
      const pitch = Math.atan((d * 0.55 - 0.55) / d) + THREE.MathUtils.degToRad(16) - half
      cam.fov = THREE.MathUtils.radToDeg(half * 2)
      cam.position.set(0, d * 0.55, d); cam.rotation.set(-pitch, 0, 0)
      cam.updateProjectionMatrix()
    }
    const ro = new ResizeObserver(size); ro.observe(el); size()

    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    let raf = 0, t = 0
    const tick = () => {
      raf = requestAnimationFrame(tick)
      t += 1 / 60
      if (!dragging) {
        idle += 1 / 60
        vel *= 0.94
        rot += vel + (idle > 2 && !reduce ? 0.0018 : 0)
      }
      world.rotation.y = rot
      for (const s of slots) {
        if (s.drop) s.drop.position.y = s.dropY + (reduce ? 0 : Math.sin(t * 3 + s.i) * 0.05)
        if (s.ring) {
          const k = reduce ? 1 : 1 + Math.sin(t * 2.4 + s.i) * 0.06
          s.ring.scale.set(k, k, k)
          ;(s.ring.material as THREE.MeshBasicMaterial).opacity = 0.65 + Math.sin(t * 2.4 + s.i) * 0.3
        }
        if (s.bounce > 0) {
          s.bounce = Math.max(0, s.bounce - 0.03)
          const b = Math.sin((1 - s.bounce) * Math.PI) * 0.18 * s.bounce
          s.plant.scale.set(1 + b, 1 - b * 0.6, 1 + b)
        }
      }
      for (let k = splash.length - 1; k >= 0; k--) {
        const sp = splash[k]; sp.t += 1 / 60
        const a = sp.m.geometry.getAttribute('position') as THREE.BufferAttribute
        const v = sp.m.geometry.userData.v as number[]
        for (let j = 0; j < a.count; j++) {
          v[j * 3 + 1] -= 0.004
          a.setXYZ(j, a.getX(j) + v[j * 3], a.getY(j) + v[j * 3 + 1], a.getZ(j) + v[j * 3 + 2])
        }
        a.needsUpdate = true
        ;(sp.m.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - sp.t)
        if (sp.t > 1) { sp.m.parent?.remove(sp.m); sp.m.geometry.dispose(); splash.splice(k, 1) }
      }
      renderer.render(scene, cam)
    }
    tick()

    return () => {
      cancelAnimationFrame(raf); ro.disconnect()
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      renderer.dispose(); el.removeChild(renderer.domElement)
      api.current = null
    }
  }, [])

  // Перестраиваем горшки, когда меняется состав или состояние растений.
  const sig = plants.map(p => `${p.id}:${p.since}:${p.day}`).join('|')
  useEffect(() => { api.current?.build(plants) }, [sig]) // eslint-disable-line react-hooks/exhaustive-deps

  // Сцена — картинка для глаза; для скринридера и клавиатуры тот же огород
  // дублирует список кнопок в Home (.g3d-list).
  return <div className="g3d-canvas" ref={host} aria-hidden="true" />
}
