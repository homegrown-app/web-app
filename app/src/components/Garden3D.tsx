// 3D-огород на главной: горшок на каждое растение, растение растёт с возрастом,
// жаждущие помечены каплей (тап по ней — полив), готовые к сбору — лаймовым
// кольцом. Вращается пальцем, тап по горшку открывает карточку растения.
//
// Модели — Kenney Nature Kit (CC0, models/LICENSE-kenney-nature-kit.txt), не
// рисованные руками. Процедурные здесь только служебные метки: пол-сцена,
// кольцо готовности и капля — это интерфейс поверх сцены, а не арт.
//
// Модуль грузится лениво (React.lazy в Home): three весит больше всего
// приложения, первый кадр главной его ждать не должен.

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { ASSET_ROOT } from '../lib/assets'
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

const LIME = 0xB4F461, GREEN = 0x3FA34D

const cache = new Map<string, Promise<THREE.Group>>()
const loader = new GLTFLoader()
function model(name: string): Promise<THREE.Group> {
  if (!cache.has(name)) {
    cache.set(name, loader.loadAsync(`${ASSET_ROOT}models/${name}.glb`).then(g => {
      // В материалах набора не задан metallic, а по glTF его умолчание — 1.
      // Металл без карты окружения в тени чёрный: листья шли чёрными клиньями.
      // Заодно бирюзовая «трава» набора → зелень бренда.
      g.scene.traverse(o => {
        const m = o as THREE.Mesh
        if (!m.isMesh) return
        for (const x of (Array.isArray(m.material) ? m.material : [m.material]) as THREE.MeshStandardMaterial[]) {
          x.metalness = 0; x.roughness = 0.85
          if (x.name === 'grass') x.color = new THREE.Color(GREEN)
        }
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
  g.fillStyle = '#0B1F14'; g.beginPath(); g.arc(64, 64, 60, 0, Math.PI * 2); g.fill()
  g.translate(24, 22); g.scale(80 / 256, 80 / 256)
  g.fillStyle = '#B4F461'
  g.fill(new Path2D('M174,47.75a254.19,254.19,0,0,0-41.45-38.3,8,8,0,0,0-9.18,0A254.19,254.19,0,0,0,82,47.75C54.51,79.32,40,112.6,40,144a88,88,0,0,0,176,0C216,112.6,201.49,79.32,174,47.75Z'))
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false }))
  sp.scale.setScalar(0.42); sp.renderOrder = 10
  return sp
}

interface Slot { i: number; root: THREE.Group; plant: THREE.Object3D; drop?: THREE.Sprite; ring?: THREE.Mesh; h: number; bounce: number }

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
      new THREE.MeshStandardMaterial({ color: 0x17683C, roughness: 0.95 }))
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
        const slot: Slot = { i, root, plant: new THREE.Group(), h: 0, bounce: 0 }
        slots.push(slot)
        Promise.all([model(bigPot(p) ? 'pot_large' : 'pot_small'), model(modelOf(p))]).then(([pot, pl]) => {
          const ph = fit(pot, bigPot(p) ? 0.8 : 0.62, 'w')
          pot.traverse(o => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.userData.slot = i } })
          root.add(pot)
          // Рост: от 45% до полного размера к сроку урожая (комнатные — сразу полные).
          const grow = isEdible(p) ? 0.45 + 0.55 * Math.min(1, hPct(p) / 100) : 1
          const tall = /bushLarge|flatTall|bushDetailed/.test(modelOf(p)) ? 1.35 : 0.95
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
          if (wDue(p) <= 0) {
            const d = dropSprite(); d.position.y = slot.h + 0.32; d.userData.drop = i
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
      const hit = ray.intersectObjects(pots.children, true)[0]
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
      cam.position.set(0, d * 0.55, d); cam.lookAt(0, 0.55, 0)
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
        if (s.drop) s.drop.position.y = s.h + 0.32 + (reduce ? 0 : Math.sin(t * 3 + s.i) * 0.05)
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

  return <div className="g3d-canvas" ref={host} />
}
