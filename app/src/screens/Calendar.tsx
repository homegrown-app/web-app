// Harvest calendar. Два вида под два разных вопроса:
//   By month  — «что делать в этом месяце»: пикер месяцев столбиками (высота =
//               сколько культур в этот месяц вообще чего-то требуют) и лента
//               под тремя вкладками: To do / Missed / Later.
//   By season — «как устроен год»: полки сезонов. Полка — это карточка недели
//               с главного экрана (.wk), не отдельный компонент: заголовок,
//               строка-сводка с диапазоном, шеврон на 90°, список внутри.
//
// Раньше здесь была таблица непрерывных полос на 21 строку. Она рисовала форму
// года второй раз — её уже показывает пикер, — и без единой фотографии читалась
// как спредшит. Культура с двумя окнами теперь просто стоит на двух полках.
//
// Прогресс-полосы в шапке полки не будет: сезон не «выполняется», такая полоса
// сообщала бы вымышленную величину. Справа стоит настоящий диапазон.

import { useLayoutEffect, useRef, useState } from 'react'
import { Screen } from '../components/Chrome'
import { Icon } from '../icons/Icon'
import { bg } from '../lib/assets'
import { isEdible, lc, wDue, type Plant } from '../lib/plants'
import type { Species as Sp } from '../data/species'
import {
  MON, MONF, daysBetween, entries, fmtMD, fmtRange, frostDates,
  live, nextWin, nowMonth, seasonDays, today, windows, zipInfo, type Ctx, type Range,
} from '../lib/season'
import { useStore } from '../state/store'

const NOW = today()
const dur = (sp: Sp) => (sp.days === sp.daysMax ? `${sp.days}` : `${sp.days}–${sp.daysMax}`) + ' d'
const inMonth = (r: Range | undefined, m: number) =>
  !!r && r[0].getMonth() <= m && r[1].getMonth() >= m

/* ── шапка: город и две даты заморозков вместо героя на пол-экрана ── */
function Context({ ctx, openCount }: { ctx: Ctx; openCount: number }) {
  const z = zipInfo(ctx.zip)
  const cell = (icon: string, label: string, val: string) => (
    <div key={label} className="cell">
      <s style={{ display: 'flex', alignItems: 'center', gap: 'var(--sp-8)' }}>
        <Icon name={icon} color="var(--lime)" size={14} />{label}
      </s>
      <b>{val}</b>
    </div>
  )
  return (
    <div className="acc">
      <div className="row1">
        <span className="tag">{z.city.toUpperCase()}</span>
        <span style={{ fontSize: 'var(--t-12)', color: '#B7C7BD' }}>
          zone {z.zone} · {seasonDays(ctx.zip)}-day season
        </span>
      </div>
      <div className="duo">
        {cell('snowflake', 'Last frost', z.last)}
        {cell('snowflake', 'First frost', z.first)}
        {cell('grains', 'Open now', `${openCount} crops`)}
      </div>
    </div>
  )
}

/* ── пикер месяцев: кварталы 2×2, палец попадает в клетку 52×56 ── */
function MonthPicker({ pool, ctx, month, pick }:
                     { pool: Sp[]; ctx: Ctx; month: number; pick: (m: number) => void }) {
  // Сезонные культуры и только они: микрозелень растёт круглый год и, если её
  // считать, лето перестаёт быть пустым — а пустое лето здесь и есть сообщение.
  const load = MON.map((_, m) => pool.filter(sp => {
    const w = windows(sp, ctx)
    if (!w || w.any) return false
    return entries(w).some(r => inMonth(r, m))
  }).length)
  const max = Math.max(...load, 1)
  const n = load[month]
  const label = n ? '' : (month >= 4 && month <= 6 ? 'too hot to start' : 'too cold to start')

  const cell = (m: number) => {
    const h = load[m] ? 9 + Math.round(load[m] / max * 17) : 4
    const cls = [load[m] ? 'has' : '', m === month ? 'on' : '', m === nowMonth() ? 'now' : '']
      .filter(Boolean).join(' ')
    return (
      <button key={m} className={cls} aria-pressed={m === month} onClick={() => pick(m)}
              aria-label={`${MONF[m]} — ${load[m] ? load[m] + ' crops' : 'nothing to do'}`}>
        <i style={{ height: h }} /><span aria-hidden="true">{MON[m]}</span>
      </button>
    )
  }
  return (
    <div className="mcard">
      <div className="mtop"><b>{MONF[month]}</b>{label && <s>{label}</s>}</div>
      <div className="mbars" role="group" aria-label="Pick a month">
        {[0, 1, 2, 3].map(q => (
          <div key={q} className={'mq' + (Math.floor(month / 3) === q ? ' on' : '')}>
            <div className="mqb">{[0, 1, 2].map(i => cell(q * 3 + i))}</div>
            <s>Q{q + 1}</s>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── лента: три корзины под текстовыми табами ── */
type Item = { sp: Sp; sub: string; rt: string; hot: boolean; at?: number }

function buckets(pool: Sp[], ctx: Ctx, m: number) {
  const now: Item[] = [], missed: Item[] = [], later: Item[] = []
  pool.forEach(sp => {
    const w = windows(sp, ctx)
    if (!w) return
    if (w.any) { now.push({ sp, sub: `Any month indoors · ${dur(sp)}`, rt: 'any', hot: false }); return }
    const es = entries(w)
    if (es.some(r => inMonth(r, m))) {
      const open = es.find(r => live(r, NOW))
      if (open) {
        const what = open === w.sow || open === w.fall ? 'Direct sow'
          : open === w.plant ? 'Plant out' : 'Start indoors'
        now.push({ sp, sub: `${what} · ${dur(sp)}`, rt: String(daysBetween(NOW, open[1])), hot: true })
        return
      }
      const past = [w.sow, w.fall, w.plant].filter(r => r && r[1] < NOW && r[1].getMonth() === m)
        .sort((a, b) => +b![1] - +a![1])[0]
      if (past) {
        missed.push({ sp, rt: fmtMD(past[1]), hot: false,
          sub: `${w.plant === past ? 'Plant out' : 'Direct sow'} closed ${fmtMD(past[1])}` })
        return
      }
    }
    const nx = nextWin(w, NOW)
    if (nx) later.push({ sp, rt: fmtMD(nx[0]), hot: false, at: +nx[0],
      sub: `Opens ${fmtMD(nx[0])}${w.fall === nx ? ' · fall wave' : w.indoors === nx ? ' · indoors first' : ''}` })
  })
  now.sort((a, b) => (a.rt === 'any' ? 99 : +a.rt) - (b.rt === 'any' ? 99 : +b.rt))
  later.sort((a, b) => (a.at || 0) - (b.at || 0))
  return { now, missed, later }
}

const EMPTY: Record<string, string> = {
  now: 'Nothing goes in this month.',
  missed: 'Nothing slipped past this month.',
  later: 'Every crop already has its window open.',
}

function Feed({ pool, ctx, month, open }:
              { pool: Sp[]; ctx: Ctx; month: number; open: (sp: Sp) => void }) {
  const [tab, setTab] = useState<'now' | 'missed' | 'later'>('now')
  const box = useRef<HTMLDivElement>(null)
  const line = useRef<HTMLElement>(null)
  // Индикатор — постоянный элемент, едет transform'ом. Пересоздавать его на
  // каждый рендер нельзя: тогда переход не проигрывается.
  useLayoutEffect(() => {
    const on = box.current?.querySelector<HTMLElement>('button.on')
    if (on && line.current) {
      line.current.style.width = on.offsetWidth + 'px'
      line.current.style.transform = `translateX(${on.offsetLeft}px)`
    }
  })

  const b = buckets(pool, ctx, month)
  const TABS: Array<[typeof tab, string, Item[], string]> = [
    ['now', 'To do', b.now, ''],
    ['missed', 'Missed', b.missed,
     'The window shut earlier this month. Next chance is a tray on the windowsill in winter.'],
    ['later', 'Later', b.later, ''],
  ]
  const cur = TABS.find(t => t[0] === tab)!

  return (
    <>
      <div className="ftabs" role="tablist" ref={box}>
        {TABS.map(([k, t, list]) => (
          <button key={k} role="tab" aria-selected={k === tab} className={k === tab ? 'on' : ''}
                  onClick={() => setTab(k)}>{t} <em>{list.length}</em></button>
        ))}
        <i className="tl" ref={line as never} />
      </div>
      {!!cur[2].length && !!cur[3] && <p className="hint" style={{ marginTop: 0 }}>{cur[3]}</p>}
      {cur[2].length
        ? cur[2].map(({ sp, sub, rt, hot }) => (
            <button key={sp.id} className="frow" onClick={() => open(sp)}>
              <span className="fth" style={{ backgroundImage: bg(sp.img) }} />
              <span className="ftx"><b>{sp.name}</b><s>{sub}</s></span>
              {hot ? <span className="frt hot">{rt} <em>d</em></span>
                   : <span className="frt">{rt}</span>}
              <span className="fca"><Icon name="chevron-right" size={18} sw={2} /></span>
            </button>
          ))
        : <p className="hint" style={{ marginTop: 0 }}>{EMPTY[tab]}</p>}
    </>
  )
}

/* ── полки сезонов ── */
const GAP: Range = [new Date(2026, 3, 15), new Date(2026, 7, 18)]

function Shelf({ id, title, note, list, pickWin, verb, open }: {
  id: string; title: string; note?: string; list: Sp[]
  pickWin: (sp: Sp) => Range | undefined; verb: string; open: (sp: Sp) => void
}) {
  const { s, d } = useStore()
  if (!list.length) return null
  const on = !!s.shelves[id]
  const wins = list.map(pickWin).filter(Boolean) as Range[]
  const span = wins.length
    ? `${fmtMD(new Date(Math.min(...wins.map(w => +w[0]))))} – ${fmtMD(new Date(Math.max(...wins.map(w => +w[1]))))}`
    : note || ''
  return (
    <section className={'wk' + (on ? ' open' : '')}>
      <button className="wk-h" aria-expanded={on} onClick={() => d({ t: 'shelf', v: id })}>
        <div className="wk-title">{title}</div>
        <div className="wk-row">
          <span className="pb-n">{list.length} crop{list.length > 1 ? 's' : ''}</span>
          <span className="pb-range">{span}</span>
          <span className="pb-chev"><Icon name="chevron-right" size={18} sw={2.2} /></span>
        </div>
      </button>
      {on && (
        <div className="wk-list">
          {list.map(sp => {
            const w = pickWin(sp)
            return (
              <button key={sp.id} className="crow" onClick={() => open(sp)}>
                <span className="cth" style={{ backgroundImage: bg(sp.img) }} />
                <span className="crt"><b>{sp.name}</b><s>{verb} {fmtRange(w) || 'any month'}</s></span>
                {live(w, NOW) && <span className="cnow">NOW</span>}
                <span className="cca"><Icon name="chevron-right" size={16} sw={2} /></span>
              </button>
            )
          })}
        </div>
      )}
    </section>
  )
}

function Seasons({ pool, ctx, open }: { pool: Sp[]; ctx: Ctx; open: (sp: Sp) => void }) {
  const W = (sp: Sp) => windows(sp, ctx)
  const tray = pool.filter(sp => !sp.direct && sp.transplant)
  const spring = pool.filter(sp => sp.direct && !sp.anyMonth && W(sp)?.sow)
  const fall = pool.filter(sp => W(sp)?.fall)
  const any = pool.filter(sp => W(sp)?.any)
  return (
    <>
      {/* порядок календарный: рассада стартует в январе, до весенней волны */}
      <Shelf id="tray" title="Indoors first" list={tray} verb="Start" open={open}
             pickWin={sp => W(sp)?.indoors} />
      <Shelf id="spring" title="Spring wave" list={spring} verb="Sow" open={open}
             pickWin={sp => W(sp)?.sow} />
      <div className="gapline">
        <i><Icon name="sun" size={18} /></i>
        <div>
          <b>{fmtMD(GAP[0])} – {fmtMD(GAP[1])} · nothing goes in.</b>{' '}
          Greens bolt in the heat and warm-season crops set no fruit.
        </div>
      </div>
      <Shelf id="fall" title="Fall wave" list={fall} verb="Sow" open={open}
             pickWin={sp => W(sp)?.fall} />
      <Shelf id="any" title="No season" note="any month" list={any} verb="Sow" open={open}
             pickWin={() => undefined} />
    </>
  )
}

/* ── Календарь ухода: полив и подкормка комнатных ──
   Раньше комнатному человеку этот экран говорил «планировать нечего»: сезона и
   посева у монстеры нет, и harvest-календарь про неё молчал. Но ухаживать за
   ней надо ровно так же по календарю — просто ритм задаёт не заморозок, а
   интервал полива.

   Все числа настоящие: ритм — p.s.water из справочника, первый полив — wDue
   (дни до следующего; отрицательное значение = просрочен, тогда сегодня).
   Даты подкормки НЕ выдуманы: приложение пока не хранит, когда кормили, поэтому
   строка кормления называет правило и честно говорит, что даты у него нет. */
const SPAN = 28

function waterDays(p: Plant): number[] {
  const out: number[] = []
  for (let d = Math.max(0, wDue(p)); d < SPAN; d += p.s.water) out.push(d)
  return out
}

const dayName = (offset: number) => {
  const d = new Date(NOW)
  d.setDate(d.getDate() + offset)
  return `${MON[d.getMonth()]} ${d.getDate()}`
}

function CareRow({ p }: { p: Plant }) {
  const days = waterDays(p)
  const due = wDue(p)
  const next = due <= 0 ? 'today' : due === 1 ? 'tomorrow' : dayName(due)
  return (
    <div className="care-row">
      <span className="crow-ph" style={{ backgroundImage: bg(p.s.img) }} />
      <div className="crow-tx">
        <b>{p.s.name}</b>
        <s>every {p.s.water} days · next {next}</s>
      </div>
      <div className="cstrip" aria-hidden="true">
        {Array.from({ length: SPAN }, (_, i) => (
          <i key={i} className={days.indexOf(i) > -1 ? 'on' : undefined} />
        ))}
      </div>
    </div>
  )
}

function CareCalendar({ plants }: { plants: Plant[] }) {
  const soon = plants.filter(p => wDue(p) <= 0)
  return (
    <>
      <div className="gsec">Watering · next {SPAN} days</div>
      <div className="clist">
        {plants.map((p, i) => <CareRow key={p.id || i} p={p} />)}
      </div>
      {!!soon.length && (
        <p className="hint" style={{ marginTop: 0 }}>
          {soon.length === 1
            ? `The ${lc(soon[0].s.name)} is thirsty today.`
            : `${soon.length} plants are thirsty today.`}
        </p>
      )}
      <div className="gsec">Feeding</div>
      <div className="wchip">
        <b style={{ fontSize: 'var(--t-15)', fontWeight: 600 }}>Once a month, all pots together</b>
        <p style={{ fontSize: 'var(--t-13)', color: 'var(--muted)', lineHeight: 1.45,
                    marginTop: 'var(--sp-4)' }}>
          Container soil runs out faster than a bed. No date here on purpose: the app does not
          yet record when you last fed, and a made-up date is worse than none. The weekly list
          carries the reminder.
        </p>
      </div>
    </>
  )
}

export function CalendarScreen({ go, openSpecies }:
                               { go: (id: string) => void; openSpecies: (sp: Sp) => void }) {
  const { s, d, ctx, pool } = useStore()
  // Что показывать, решает САД человека, а не выбор на первом экране онбординга:
  // справочник больше не сужается треком, поэтому isHousePool(pool) всегда лгал
  // бы «тут есть съедобное». У кого комнатные — календарь ухода, у кого
  // съедобные — календарь урожая, у кого и те и те — оба.
  // Справочник стал полным — в pool теперь и комнатные. Календарю УРОЖАЯ они не
  // нужны: «посеять монстеру» бессмыслица, а полка «No season» с глаголом Sow
  // приняла бы их без разговоров. Поэтому здесь свой список: только съедобное, и
  // только то, что вообще может расти в его месте.
  const crops = pool.filter(sp => sp.kind === 'edible' && (ctx.outdoor || sp.sill))
  const houses = s.plants.filter(p => !isEdible(p))
  const edibles = s.plants.filter(isEdible)
  const harvest = !s.plants.length || !!edibles.length
  const view = s.calView
  const month = s.calMonth ?? nowMonth()
  const f = frostDates(ctx.zip)
  const openNow = crops.filter(sp => entries(windows(sp, ctx)).some(r => live(r, NOW))).length

  const calTitle = houses.length && harvest ? 'Calendar'
    : houses.length ? 'Care calendar' : 'Harvest calendar'
  return (
    <Screen id="calendar" title={calTitle} nav={{ active: 'Calendar', go }} scrollKey="calendar">
      <div className="h1" style={{ marginTop: 16 }}>{calTitle}</div>
      {harvest && <Context ctx={ctx} openCount={openNow} />}

      {!!houses.length && <CareCalendar plants={houses} />}

      {harvest && (
        <>
          <div className="seg wide" role="radiogroup" aria-label="Calendar view">
            {(['month', 'year'] as const).map(v => (
              <div key={v} className={view === v ? 'on' : undefined} role="radio" tabIndex={0}
                   aria-checked={view === v}
                   onClick={() => d({ t: 'calView', v })}
                   onKeyDown={e => {
                     if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); d({ t: 'calView', v }) }
                   }}>
                {v === 'month' ? 'By month' : 'By season'}
              </div>
            ))}
          </div>

          {view === 'month' ? (
            <>
              <MonthPicker pool={crops} ctx={ctx} month={month}
                           pick={m => d({ t: 'calMonth', v: m })} />
              <Feed pool={crops} ctx={ctx} month={month} open={openSpecies} />
            </>
          ) : (
            <Seasons pool={crops} ctx={ctx} open={openSpecies} />
          )}

          <p className="hint">
            Windows come from your frost dates — {fmtMD(f.last)} and {fmtMD(f.first)} — and how
            long each crop needs. One honest gap: this works off frost, not summer heat, so in a
            hot region the edge of a cool-season window will drift.
          </p>
        </>
      )}
    </Screen>
  )
}
