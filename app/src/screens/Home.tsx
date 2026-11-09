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
import { Dial } from '../components/bits'
import { Icon } from '../icons/Icon'
import { Task as TaskRow } from '../components/parts'
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
            <Dial sz={200} r={84} sw={6} disc={66} discFill="rgba(18,53,31,.28)" ticks={60} pct={sc} />
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
  // hEta у созревшего отдаёт «ready», и с приставкой выходит «in ready».
  const ripe = hPct(eds[0]) >= 100
  return (
    <div className="card nxt" role="button" tabIndex={0} onClick={() => go('calendar')}
         onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go('calendar') } }}>
      <span className="nxt-d">
        {ripe ? <><s>ready</s><b>now</b></> : <><s>in</s><b>{hEta(eds[0])}</b></>}
      </span>
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
/** Краска доли по её месту в списке: первая — основная, дальше светлее. */
const tone = (i: number) => 'tw-c' + Math.min(4, i + 1)
function TimeWeek({ week }: { week: Task[] }) {
  const total = week.reduce((a, t) => a + minsOf(t), 0)
  if (!total) return null
  const by: Record<string, number> = {}
  week.forEach(t => { const k = kindOf(t); by[k] = (by[k] || 0) + minsOf(t) })
  const parts = Object.keys(by).sort((a, b) => by[b] - by[a])
  return (
    <div className="card tw">
      <div className="tw-top">
        <span className="tw-n">
          <span className="lbl">Time this week</span>
          <b>{total} min</b>
        </span>
        <div className="tw-bar">
          {parts.map((k, i) => {
            const pct = Math.round((by[k] / total) * 100)
            // Засечка стоит у каждой доли, число — только там, где помещается:
            // при ширине макета 375 полоса выходит ~232, и доля меньше 18%
            // даёт колонку уже 31px, в которую «18%» не влезает. Обрезанное
            // число врёт («18%» превращается в «1»), поэтому его нет.
            return (
              <span key={k} style={{ flex: by[k] }}>
                <u>{pct >= 18 ? pct + '%' : ''}</u>
                <i className={tone(i)} />
              </span>
            )
          })}
        </div>
      </div>
      <div className="tw-key">
        {parts.map((k, i) => (
          <span key={k}><i className={tone(i)} />{KIND_WORD[k] || k}</span>
        ))}
      </div>
    </div>
  )
}

/** Срочное: задачи, у которых есть своё действие прямо здесь. */
function NeedsNow({ week, urgent, go }:
    { week: Task[]; urgent: Task[]; go: (id: string) => void }) {
  const { s, d } = useStore()
  if (!urgent.length) return null
  const done = week.filter(t => s.done[tkey(t)]).length
  return (
    <>
      <div className="sec-h">
        <span>Needs you now</span>
        <i className="hint" aria-hidden="true">{done} of {week.length} this week</i>
      </div>
      {urgent.map(t => {
        const i = +(t[3] || '').split(':')[1]
        const pick = kindOf(t) === 'pick'
        const shot = s.plants[i] ? shotOf(s.plants[i]) : null
        return (
          <div className="card urg" key={t[3]}>
            <div className="urg-b">
              <span className="urg-ph" style={shot ? { backgroundImage: `url(${shot})` } : undefined} />
              <span className="urg-t">
                <span className="urg-h">
                  <span className={'pill ' + (pick ? 'b-lime' : 'b-act')}>
                    <Icon name={pick ? 'scissors' : 'drop'} color="currentColor" size={14} />
                    {pick ? 'Ready' : 'Thirsty'}
                  </span>
                  <i>{t[1]}</i>
                </span>
                <b>{t[0]}</b>
                {t[2] && <s>{t[2]}</s>}
              </span>
            </div>
            <div className={'btn ' + (pick ? 'b-white' : 'b-pri')} role="button" tabIndex={0}
                 onClick={() => { if (pick) { d({ t: 'select', v: i }); go('harvest') } else d({ t: 'water', v: i }) }}>
              <Icon name={pick ? 'scissors' : 'drop'} color={pick ? 'var(--ink)' : '#fff'} size={18} />
              {pick ? 'Pick it — first harvest' : 'Water it now'}
            </div>
          </div>
        )
      })}
    </>
  )
}

/** Список растений: кадр, день и состояние. Открывает карточку растения. */
/** Строка про полив под именем: отдельно от плашки сбора на кадре. */
function waterLine(p: Plant): [string, boolean] {
  const d = wDue(p)
  if (d <= 0) return ['Needs water', true]
  if (d <= 2) return ['Water soon', false]
  return [`Water in ${d}d`, false]
}

function PlantRows({ onOpen, go }: { onOpen: (i: number) => void; go: (id: string) => void }) {
  const { s } = useStore()
  return (
    <>
      <div className="sec-h">
        <span>My plants <u>{s.plants.length}</u></span>
        <i role="button" tabIndex={0} onClick={() => go('add-plant')}
           onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go('add-plant') } }}>Add</i>
      </div>
      <div className="pcar">
        {s.plants.map((p, i) => {
          const ed = isEdible(p)
          const ripe = ed && hPct(p) >= 100
          const [wl, bad] = waterLine(p)
          return (
            <div className="card" key={p.id} role="button" tabIndex={0}
                 onClick={() => onOpen(i)}
                 onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(i) } }}>
              <span className="pcar-ph" style={{ backgroundImage: `url(${shotOf(p) || ''})` }}>
                {ripe && (
                  <span className="pill b-lime">
                    <Icon name="check-circle" color="var(--ink)" size={14} />Ready
                  </span>
                )}
                {ed && !ripe && <span className="pill b-photo">{hEta(p)}</span>}
              </span>
              <b>{p.s.name}</b>
              <s>Day {p.day}</s>
              <i className={bad ? 'bad' : undefined}>
                <Icon name="drop" color={bad ? 'var(--red)' : 'var(--muted)'} size={14} />{wl}
              </i>
            </div>
          )
        })}
      </div>
    </>
  )
}

/**
 * Когда что созреет. Ось — шесть недель от сегодня, как подписано в канвасе:
 * засечки на 0/2/4/6 неделях делят её на три равных куска. Растение дальше
 * шести недель упирается в правый край, и это честно: точного дня у него
 * всё равно нет.
 */
const SPAN = 42
function HarvestTimeline() {
  const { s } = useStore()
  const rows = s.plants
    .map((p, i) => ({ p, i, eta: p.s.days - p.day }))
    .filter(r => isEdible(r.p))
    .sort((a, b) => a.eta - b.eta)
  if (!rows.length) return null
  return (
    <div className="card htl">
      <div className="htl-h"><b>Harvest timeline</b><i>next 6 weeks</i></div>
      <div className="htl-g">
        {[0, 33.33, 66.67, 100].map(x => <u key={x} style={{ left: x + '%' }} />)}
        {rows.map(({ p, eta }) => {
          // Готовому — короткий огрызок полосы: кружок должен сесть у самого
          // начала оси, но полоса нулевой длины не рисуется вовсе.
          const at = Math.max(3.33, Math.min(100, (eta / SPAN) * 100))
          const tone = eta <= 0 ? 'now' : eta <= SPAN ? 'soon' : 'late'
          const far = at > 55           // подписи справа уже не хватит места
          return (
            <div className="htl-r" key={p.id}>
              <i className={tone} style={{ width: at + '%' }} />
              <span className="htl-th" style={{ left: `calc(${at}% - 14px)`,
                    backgroundImage: `url(${shotOf(p) || ''})` }} />
              <span className="htl-lb" style={far ? { left: 12 } : { left: `calc(${at}% + 20px)` }}>
                {p.s.name} <u>{eta <= 0 ? 'Ready' : hEta(p)}</u>
              </span>
            </div>
          )
        })}
        {([[0, 'Now'], [33.33, '2 wk'], [66.67, '4 wk'], [100, '6 wk']] as const).map(([x, w], n) => (
          <span key={w} className="htl-x"
                style={{ left: x + '%', transform: `translateX(${n === 0 ? '0' : n === 3 ? '-100%' : '-50%'})` }}>
            {w}
          </span>
        ))}
      </div>
    </div>
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
/**
 * Неделя одной карточкой: счёт, полоса по клетке на дело и список остального.
 *
 * Раскрывающийся блок снят. В канвасе неделя на Home всегда открыта: полоса
 * показывает, сколько уже сделано, и прятать под неё четыре строки незачем —
 * ради них и стоит карточка. Отмечать дела по-прежнему можно прямо здесь.
 */
function WeekCard({ week, rest }: { week: Task[]; rest: Task[] }) {
  const { s, d } = useStore()
  if (!week.length) return null
  const n = week.filter(t => s.done[tkey(t)]).length
  return (
    <div className="tasks" style={{ marginTop: 32 }}>
      <div className="tasks-h">
        <h2>This week</h2>
        <span>{n} of {week.length} done</span>
      </div>
      <div className="wkbar" style={{ gridTemplateColumns: `repeat(${week.length}, minmax(0,1fr))` }}>
        {week.map((t, i) => <i key={i} className={s.done[tkey(t)] ? 'on' : undefined} />)}
      </div>
      {rest.length > 0 && (
        <>
          <p className="tasks-l">Also this week</p>
          {rest.map((t, i) => (
            <TaskRow key={i} t={[t[0], t[1], t[2]]} done={!!s.done[tkey(t)]}
                  onToggle={() => d({ t: 'toggleTask', v: t })} />
          ))}
        </>
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
  // Срочное считаем здесь: тот же список нужен карточке недели, чтобы не
  // повторять в ней дела, которые уже стоят выше со своими кнопками.
  const urgent = week.filter(t => kindOf(t) === 'water' || kindOf(t) === 'pick').slice(0, 2)
  const rest = week.filter(t => !urgent.includes(t))
  return (
    <Screen id="home" nav={{ active: 'Week', badge: true, go }} scrollKey="home">
      {has ? (
        <>
          <div className="greet tight">Good morning, plant parent</div>
          <div className="h1">{v[1]}</div>
          <Health />
          <NextPick go={go} />
          <TimeWeek week={week} />
          <NeedsNow week={week} urgent={urgent} go={go} />
          <PlantRows onOpen={open} go={go} />
          <HarvestTimeline />
          <GardenView onOpen={open} />
          <WeekCard week={week} rest={rest} />
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
