// Home. Один экран, два состояния: пусто — акцентный блок зовёт добавить
// растение; есть растения — health score, виджеты и 3D-огород.
// Задачи недели СЧИТАЮТСЯ из растений, а не захардкожены.

import { Suspense, lazy } from 'react'
import { Screen } from '../components/Chrome'
import { DropLevel, MetricRow, RingBig, dropTone } from '../components/bits'
import { Icon, IcCheck2, IcChevD, IcLeafLime } from '../icons/Icon'
import { bg } from '../lib/assets'
import {
  hEta, hPct, isEdible, lc, lightShort, pState, tkey, verdict, wDue, weekTasks,
  healthScore, type Task,
} from '../lib/plants'
import { useStore } from '../state/store'
import '../styles/dash.css'

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

// 3D-огород грузится отдельным куском: three тяжелее всего приложения.
const Garden3D = lazy(() => import('../components/Garden3D'))

function Dash({ go, onOpen }: { go: (id: string) => void; onOpen: (i: number) => void }) {
  const { s, d } = useStore()
  const thirsty = s.plants.filter(p => wDue(p) <= 0).length
  const ready = s.plants.filter(p => isEdible(p) && hPct(p) >= 100).length
  return (
    <div className="dash">
      {/* Ярлык и сцена — одна обёртка: она же граница залипания ярлыка.
          Прямым ребёнком .dash он липнул над всем листом, включая карточку
          недели, которую не подписывает. */}
      <div className="dash-plants">
        <div className="sec-h dash-sec">
          <span>My plants</span>
          <i role="button" tabIndex={0} onClick={() => go('add-plant')}>Add</i>
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
          <div className="g3d-tip" aria-hidden="true">{thirsty ? 'Tap a drop to water · drag to turn' : 'Drag to turn · tap a pot to open it'}</div>
        </div>
      </div>
      <Week />
    </div>
  )
}

function Week() {
  const { s, d } = useStore()
  const week: Task[] = weekTasks(s.plants, s.care)
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

/** Герой дашборда: общее фото урожая во всю ширину до верха экрана, а на нём —
 *  приветствие, счёт, вердикт и две карточки. Фото едет медленнее блока, и
 *  оба уходят в блюр: параллакс считает CSS из --p. */
function Hero() {
  const { s } = useStore()
  const plants = s.plants
  const sc = healthScore(plants)
  const due = plants.filter(p => wDue(p) <= 0)
  const v = verdict(sc, due.length)
  const soon = plants.filter(p => { const d = wDue(p); return d > 0 && d <= 2 })
  const nextP = plants.slice().sort((a, b) => wDue(a) - wDue(b))[0]

  return (
    <>
      <div className="hero-ph" style={{ backgroundImage: bg('hero-basket') }} />
      <div className="hero-dim" />
      <div className="hero-sc" />
      <div className="hero-in">
        <div className="hero-k">Good morning</div>
        <div className="eh-h">Plant parent</div>
        <div className="score-row">
          <div className="score-top"><RingBig pct={sc} sz={56} /><span><IcLeafLime /></span></div>
          <div>
            <div className="score-n"><b>{sc}</b><s>/100</s></div>
            <div className="score-v">{v[0]}</div>
          </div>
        </div>
        <div className="score-s">{v[1]}</div>

        <div className="wgrid">
          {/* Обе карточки белые. Тёмная слева была третьим тёмным слоем поверх
              фотографии и её скрима — на белом пара читается как одна группа, а
              не как «эта важнее». Каплю тоже пришлось перекрасить: лаймовая
              давала на белом 1.31:1 и просто исчезала, --bright даёт 3.18:1 —
              порог для нетекстовой графики 3:1. */}
          <div className="wg wg-lite">
            {/* Здесь число — СЧЁТЧИК растений, которым нужен полив, а не
                уровень одного растения. Заливать его наполовину нечем, поэтому
                капля показывает исход: пустая и тревожная, пока кто-то ждёт
                воды, полная и зелёная, когда не ждёт никто. */}
            <div className="wg-top"><div className="num">{due.length}</div>
              <DropLevel tone={due.length ? 'bad' : 'ok'} /></div>
            <div className="lbl">Water today</div>
            <MetricRow items={[['Soon', soon.length], ['Plants', plants.length]]} />
          </div>
          <div className="wg wg-lite">
            <div className="wg-top">
              <div className="num">{Math.max(0, wDue(nextP))}<span>d</span></div>
              <DropLevel tone={dropTone(nextP)} />
            </div>
            <div className="lbl">
              {wDue(nextP) <= 0 ? `${nextP.s.name} is thirsty` : `Until ${lc(nextP.s.name)}`}
            </div>
            <MetricRow items={[
              ['Light', lightShort(nextP.s)],
              [isEdible(nextP) ? 'Harvest' : 'Humidity',
               isEdible(nextP) ? hEta(nextP) : nextP.s.hum],
            ]} />
          </div>
        </div>
      </div>
    </>
  )
}

export function HomeScreen({ go }: { go: (id: string) => void }) {
  const { s, d } = useStore()
  const has = s.plants.length > 0
  const open = (i: number) => { d({ t: 'select', v: i }); go('plant') }
  return (
    <Screen id="home" nav={{ active: 'Week', badge: true, go }}
            offer={{ onClick: () => go('paywall') }} scrollKey="home"
            hero={has ? <Hero /> : undefined}>
      {has ? <Dash go={go} onOpen={open} /> : (
        <>
          <div className="greet" />
          <div className="h1">Let’s get you growing.</div>
          <EmptyHero go={go} />
            </>
      )}
    </Screen>
  )
}
