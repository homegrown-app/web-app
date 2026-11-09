// Home. Один экран, два состояния: пусто — фото зовёт добавить растение;
// есть растения — здоровье огорода, срочное, список, 3D-огород и неделя.
// Всё считается из растений, ничего не захардкожено.
//
// Фотография во всю ширину с приветствием и счётом на ней снята: в канвасе
// Home начинается с текста, а счёт живёт отдельной тёмной карточкой на
// расфокусированном фото растения — тем же приёмом, что и рост на карточке
// растения. Машинерия героя осталась в Chrome.tsx: ею пользуются другие экраны.

import { Suspense, lazy } from 'react'
import { Screen } from '../components/Chrome'
import { RingBig } from '../components/bits'
import { Icon, IcCheck2, IcChevD } from '../icons/Icon'
import { bg, img } from '../lib/assets'
import {
  hEta, hPct, isEdible, lc, pState, phUrl, tkey, verdict, wDue, weekTasks,
  healthScore, type Plant, type Task,
} from '../lib/plants'
import { zipInfo } from '../lib/season'
import { useStore } from '../state/store'
import '../styles/dash.css'

/** Плашка состояния: лайм у здорового, лиловая у «скоро», красная у просроченного. */
const TONE: Record<string, string> = { ok: 'b-lime', warn: 'b-act', bad: 'b-warn' }

/** Снимок растения: сначала настоящий кадр из журнала, потом фото вида. */
const shotOf = (p: Plant): string | null =>
  p.photos[0] ? phUrl(p.photos[0]) : (p.s.img ? img(p.s.img) : null)

/** Вид задачи — из её ключа: water:0, pick:1, check:2, rotate:0, wipe:0. */
const kindOf = (t: Task) => (t[3] || '').split(':')[0]
const minsOf = (t: Task) => parseInt(t[1], 10) || 0

function EmptyHero({ go }: { go: (id: string) => void }) {
  const { s } = useStore()
  const HEAD: Record<string, [string, JSX.Element]> = {
    edible: ['One pot is enough to start',
             <>Grow something<br />you can<br />actually eat.</>],
    house: ['One plant is enough to start',
            <>Every room<br />feels better<br />with something<br />alive in it.</>],
    both: ['One pot is enough to start',
           <>One pot,<br />one plant,<br />and you have<br />started.</>],
  }
  const [k, h] = HEAD[s.choices.track] || HEAD.both
  return (
    <div className="empty-hero">
      <div className="eh-shot" style={{ backgroundImage: bg('hero-garden') }} />
      <div className="eh-ov">
        <div>
          <div className="eh-k">{k}</div>
          <div className="eh-h">{h}</div>
        </div>
        <div className="btn b-lime" role="button" tabIndex={0} onClick={() => go('add-plant')}>
          Add your first plant
        </div>
        <div className="eh-alt" role="button" tabIndex={0} onClick={() => go('add-plant')}>
          or pick from the library
        </div>
      </div>
    </div>
  )
}

/** Здоровье огорода: счёт кольцом и три числа, которые его объясняют. */
function Health() {
  const { s } = useStore()
  const plants = s.plants
  const sc = healthScore(plants)
  const due = plants.filter(p => wDue(p) <= 0).length
  const soon = plants.filter(p => { const w = wDue(p); return w > 0 && w <= 2 }).length
  const ready = plants.filter(p => isEdible(p) && hPct(p) >= 100).length
  const v = verdict(sc, due)
  const tone = due >= 2 ? 'bad' : due === 1 ? 'warn' : 'ok'
  const pic = plants.map(shotOf).find(Boolean) || null
  const where = s.choices.zip ? zipInfo(s.choices.zip).city : null
  return (
    <div className="ph-card">
      {pic && <div className="ph-bg" style={{ backgroundImage: `url(${pic})` }} />}
      <div className="ph-sc green" />
      <div className="ph-in">
        <div className="ph-h">
          <span>
            <b>Garden health</b>
            <s>{plants.length} {plants.length === 1 ? 'plant' : 'plants'}{where && ` · ${where}`}</s>
          </span>
          <span className={'pill ' + (TONE[tone] || 'b-meta')}>
            {tone === 'ok' && <Icon name="check-circle" color="var(--ink)" size={14} />}
            {v[0]}
          </span>
        </div>
        <div className="ph-r">
          <span style={{ width: 200, height: 200 }}>
            <RingBig pct={sc} sz={200} />
            <span><b>{sc}</b><u>of 100</u></span>
          </span>
        </div>
        <div className="ph-chips">
          <span><b className={due ? 'warm' : undefined}>{due}</b><u>water today</u></span>
          <span><b>{soon}</b><u>water soon</u></span>
          <span><b className={ready ? 'lime' : undefined}>{ready}</b><u>ready to pick</u></span>
        </div>
      </div>
    </div>
  )
}

/** Ближайший сбор: когда и у кого. Только когда в огороде есть съедобное. */
function NextPick({ go }: { go: (id: string) => void }) {
  const { s } = useStore()
  const eds = s.plants.filter(isEdible).slice().sort((a, b) => hPct(b) - hPct(a))
  if (!eds.length) return null
  const first = eds.slice(0, 2)
  return (
    <div className="card nxt" role="button" tabIndex={0} onClick={() => go('calendar')}
         onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go('calendar') } }}>
      <span className="nxt-d"><s>in</s><b>{hEta(eds[0])}</b></span>
      <span className="nxt-ph">
        {first.map(p => (
          <i key={p.id} style={{ backgroundImage: `url(${shotOf(p) || ''})` }} />
        ))}
      </span>
      <span className="nxt-t">
        <b>Next pick</b>
        <s>{first.map(p => lc(p.s.name)).join(' and ')}</s>
      </span>
    </div>
  )
}

/** Сколько времени возьмёт неделя и на что оно уйдёт. */
const KIND_WORD: Record<string, string> = {
  pick: 'Picking', check: 'Soil checks', water: 'Watering',
  rotate: 'Rotating', wipe: 'Wiping leaves', feed: 'Feeding',
}
function TimeWeek({ week }: { week: Task[] }) {
  const total = week.reduce((a, t) => a + minsOf(t), 0)
  if (!total) return null
  const by: Record<string, number> = {}
  week.forEach(t => { const k = kindOf(t); by[k] = (by[k] || 0) + minsOf(t) })
  const parts = Object.keys(by).sort((a, b) => by[b] - by[a])
  return (
    <div className="card tw">
      <span className="tw-n">
        <span className="lbl">Time this week</span>
        <b>{total} min</b>
      </span>
      <div className="tw-bar">
        {parts.map((k, i) => (
          <span key={k} style={{ flex: by[k] }}>
            <u>{Math.round((by[k] / total) * 100)}%</u>
            <i className={i ? 'r' + Math.min(3, i) : undefined} />
            <em>{KIND_WORD[k] || k}</em>
          </span>
        ))}
      </div>
    </div>
  )
}

/** Срочное: задачи, у которых есть своё действие прямо здесь. */
function NeedsNow({ week, go }: { week: Task[]; go: (id: string) => void }) {
  const { s, d } = useStore()
  const urgent = week.filter(t => kindOf(t) === 'water' || kindOf(t) === 'pick')
  if (!urgent.length) return null
  const done = week.filter(t => s.done[tkey(t)]).length
  return (
    <>
      <div className="sec-h">
        <span>Needs you now</span>
        <i className="hint" aria-hidden="true">{done} of {week.length} this week</i>
      </div>
      {urgent.slice(0, 2).map(t => {
        const i = +(t[3] || '').split(':')[1]
        const pick = kindOf(t) === 'pick'
        return (
          <div className="card urg" key={t[3]}>
            <div className="urg-h">
              <span className={'pill ' + (pick ? 'b-lime' : 'b-act')}>
                <Icon name={pick ? 'scissors' : 'drop'} color="currentColor" size={14} />
                {pick ? 'Ready' : 'Thirsty'}
              </span>
              <i>{t[1]}</i>
            </div>
            <b>{t[0]}</b>
            {t[2] && <s>{t[2]}</s>}
            <div className={'btn ' + (pick ? 'b-white' : 'b-pri')} role="button" tabIndex={0}
                 onClick={() => { if (pick) { d({ t: 'select', v: i }); go('harvest') } else d({ t: 'water', v: i }) }}>
              {pick ? 'Pick it — first harvest' : 'Water it now'}
            </div>
          </div>
        )
      })}
    </>
  )
}

/** Список растений: кадр, день и состояние. Открывает карточку растения. */
function PlantRows({ onOpen, go }: { onOpen: (i: number) => void; go: (id: string) => void }) {
  const { s } = useStore()
  return (
    <>
      <div className="sec-h">
        <span>My plants <u>{s.plants.length}</u></span>
        <i role="button" tabIndex={0} onClick={() => go('add-plant')}
           onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go('add-plant') } }}>Add</i>
      </div>
      <div className="bed-rows plist-c">
        {s.plants.map((p, i) => {
          const st = pState(p)
          return (
            <div className="bed-row" key={p.id} role="button" tabIndex={0}
                 onClick={() => onOpen(i)}
                 onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(i) } }}>
              <span className="bed-th" style={{ backgroundImage: `url(${shotOf(p) || ''})` }} />
              <div className="nm"><b>{p.s.name}</b><s>Day {p.day}</s></div>
              <span className={'pill ' + (TONE[st[1]] || 'b-meta')}>
                {st[1] === 'ok' && <Icon name="check-circle" color="var(--ink)" size={14} />}
                {st[0]}
              </span>
            </div>
          )
        })}
      </div>
    </>
  )
}

// 3D-огород грузится отдельным куском: three тяжелее всего приложения.
const Garden3D = lazy(() => import('../components/Garden3D'))

function GardenView({ onOpen }: { onOpen: (i: number) => void }) {
  const { s, d } = useStore()
  const thirsty = s.plants.filter(p => wDue(p) <= 0).length
  const ready = s.plants.filter(p => isEdible(p) && hPct(p) >= 100).length
  return (
    <>
      <div className="sec-h">
        <span>Garden view</span>
        <i className="hint" aria-hidden="true">{thirsty ? 'Tap a drop to water' : 'Tap a pot to open it'}</i>
      </div>
      <div className="g3d">
        <div className="g3d-hud">
          <span className={'g3d-chip' + (thirsty ? ' warn' : '')}>
            <Icon name="drop" size={14} color="currentColor" /> {thirsty ? `${thirsty} thirsty` : 'All watered'}
          </span>
          {ready > 0 && <span className="g3d-chip lime"><Icon name="scissors" size={14} color="currentColor" /> {ready} ready</span>}
        </div>
        <Suspense fallback={<div className="g3d-canvas g3d-load" />}>
          <Garden3D plants={s.plants} onOpen={onOpen} onWater={i => d({ t: 'water', v: i })} />
        </Suspense>
        {/* Растения без пальца: canvas не видят ни скринридер, ни клавиатура.
            Список спрятан, пока фокус не зайдёт внутрь, — тогда он
            всплывает плашками поверх сцены. */}
        <ul className="g3d-list" aria-label="My plants">
          {s.plants.map((p, i) => (
            <li key={p.id}>
              <button type="button" onClick={() => onOpen(i)}>{p.s.name}, {lc(pState(p)[0])}</button>
              {wDue(p) <= 0 && (
                <button type="button" onClick={() => d({ t: 'water', v: i })}>Water {lc(p.s.name)}</button>
              )}
            </li>
          ))}
        </ul>
        <div className="g3d-tip" aria-hidden="true">Drag to turn</div>
      </div>
    </>
  )
}

/** Остальная неделя: всё, что не вынесено в «Needs you now». */
function Week({ week }: { week: Task[] }) {
  const { s, d } = useStore()
  const n = week.filter(t => s.done[tkey(t)]).length
  const m = week.length
  const pct = m ? Math.round((n / m) * 100) : 0
  return (
    <div className={'wk' + (s.weekOpen ? ' open' : '')}>
      <div className="wk-h" role="button" tabIndex={0}
           onClick={() => d({ t: 'weekOpen', v: !s.weekOpen })}
           onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); d({ t: 'weekOpen', v: !s.weekOpen }) } }}>
        <div className="wk-title">{m} {m === 1 ? 'thing to do' : 'things to do'}</div>
        <div className="wk-row">
          <span className="pb-n">{n} of {m}</span>
          <span className="pb-track"><i style={{ width: pct + '%' }} /></span>
          <span className="pb-pct">{pct}%</span>
          <span className="pb-chev"><IcChevD /></span>
        </div>
      </div>
      {s.weekOpen && (
        <div className="wk-list">
          {week.map((t, i) => {
            const on = !!s.done[tkey(t)]
            return (
              <div key={i} className="br-row" role="checkbox" tabIndex={0} aria-checked={on}
                   onClick={() => d({ t: 'toggleTask', v: t })}
                   onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); d({ t: 'toggleTask', v: t }) } }}>
                <span className={'br-dot' + (on ? ' on' : '')}>{on && <IcCheck2 />}</span>
                <span className={'br-t' + (on ? ' done' : '')}>
                  {t[0]}{t[2] && !on && <s>{t[2]}</s>}
                </span>
                <span className="br-m">{t[1]}</span>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function HomeScreen({ go }: { go: (id: string) => void }) {
  const { s, d } = useStore()
  const has = s.plants.length > 0
  const open = (i: number) => { d({ t: 'select', v: i }); go('plant') }
  const week: Task[] = weekTasks(s.plants, s.care)
  const sc = healthScore(s.plants)
  const due = s.plants.filter(p => wDue(p) <= 0).length
  const v = verdict(sc, due)
  return (
    <Screen id="home" nav={{ active: 'Week', badge: true, go }} scrollKey="home">
      {has ? (
        <>
          <div className="greet">Good morning, plant parent</div>
          <div className="h1">{v[1]}</div>
          <Health />
          <NextPick go={go} />
          <TimeWeek week={week} />
          <NeedsNow week={week} go={go} />
          <PlantRows onOpen={open} go={go} />
          <GardenView onOpen={open} />
          <div className="sl">This week</div>
          <Week week={week} />
        </>
      ) : (
        <>
          <div className="greet" />
          <div className="h1">Let’s get you growing.</div>
          <EmptyHero go={go} />
        </>
      )}
    </Screen>
  )
}
