// Состояния недели. Продукт НИКОГДА не показывает список из двадцати
// просроченных задач: пропуск сворачивается в две задачи из настоящих растений,
// остальное закрывается статусом expired без обвинения.

import { Screen } from '../components/Chrome'
import { Note, Ring } from '../components/bits'
import { Task } from '../components/parts'
import { Icon } from '../icons/Icon'
import { inDays } from '../lib/plan'
import {
  hEta, hPct, hStage, isEdible, lc, wDue, weekTasks, type Plant,
} from '../lib/plants'
import { useStore } from '../state/store'

type Go = (id: string) => void

const pPct = (p: Plant) => (isEdible(p) ? hPct(p)
  : Math.max(0, Math.min(100, Math.round((p.since / p.s.water) * 100))))
const pSub = (p: Plant) => isEdible(p)
  ? `Day ${p.day} · ${hStage(p)}`
  : `${p.s.light} · every ${p.s.water}d`

// ─────────────────────────────────────────── Week · пусто
export function WeekEmptyScreen({ go }: { go: Go }) {
  const { s, d } = useStore()
  const future = s.plants.filter(p => wDue(p) > 0).sort((a, b) => wDue(a) - wDue(b))
  const nextP = future[0]
  const open = (i: number) => { d({ t: 'select', v: i }); go('plant') }

  return (
    <Screen id="week-empty" nav={{ active: 'Week', go }} scrollKey="week-empty">
      <div className="greet">Good morning · nothing due</div>
      <div className="h1">Nothing needed<br /><span className="m">this week.</span></div>
      {!s.plants.length
        ? <Note title="Nothing to do yet">Add a plant and the week fills itself in.</Note>
        : nextP
        ? <Note title="Just water and watch">
            Everything is on schedule. The next real job is{' '}
            {isEdible(nextP) && hPct(nextP) >= 100 ? 'picking the ' : 'watering the '}
            {lc(nextP.s.name)} {inDays(wDue(nextP))} — we’ll put it on that week’s card.
          </Note>
        : <Note title="Everything is thirsty at once">
            Water them today and the week clears itself. After that the schedule spreads
            them out again.
          </Note>}
      <div className="sl">Your plants</div>
      {s.plants.length > 0 && (
        <div className="plist">
          {s.plants.map((p, i) => (
            <div className="pl" key={i} role="button" tabIndex={0} onClick={() => open(i)}>
              <div className="rw">
                <Ring pct={pPct(p)} />
                <i><Icon name={p.s.icon} color="var(--primary)" size={15} sw={1.9} /></i>
              </div>
              <div className="nm"><b>{p.s.name}</b><s>{pSub(p)}</s></div>
              <div className="eta">
                {isEdible(p) ? hEta(p) : (wDue(p) <= 0 ? 'water' : `~${wDue(p)}d`)}
              </div>
            </div>
          ))}
        </div>
      )}
    </Screen>
  )
}

// ─────────────────────────────────────────── Week · возврат
export function WeekBackScreen({ go }: { go: Go }) {
  const { s } = useStore()
  const t = weekTasks(s.plants, s.care).slice(0, 2)
  return (
    <Screen id="week-back" nav={{ active: 'Week', badge: true, go }} scrollKey="week-back">
      <div className="greet">You were away 2 weeks</div>
      <div className="h1">Welcome back.<br /><span className="m">Here’s what matters now.</span></div>
      <Note title="Most of it doesn’t matter now">
        Nine tasks stopped being useful and closed themselves. The ones below still pay off.
      </Note>
      <div className="sl">Still worth doing</div>
      {t.length
        ? t.map((x, i) => <Task key={i} t={[x[0], x[1], x[2]]} />)
        : <Note title="Nothing is waiting" mt={0}>Your plants held out fine.</Note>}
      <div className="btn b-pri" role="button" tabIndex={0} onClick={() => go('home')}>
        Continue with this week
      </div>
    </Screen>
  )
}

// ─────────────────────────────────────────── Week · долгий пропуск
export function WeekLongScreen({ go }: { go: Go }) {
  const { s } = useStore()
  // Нижняя строка называет растения, которые реально пересохли, а не выдуманный редис.
  const dry = s.plants.filter(p => wDue(p) <= 0).map(p => lc(p.s.name))
  return (
    <Screen id="week-long" nav={{ active: 'Week', go }} scrollKey="week-long">
      <div className="greet">Last visit: 6 weeks ago</div>
      <div className="h1">It’s been a while.<br /><span className="m">Let’s restart from today.</span></div>
      <Note title="Your plan is out of date"
            cta={<>
              <div className="btn b-pri" role="button" tabIndex={0}
                   onClick={() => go('home')}>Rebuild my plan</div>
              <div className="btn b-ghost" role="button" tabIndex={0}
                   onClick={() => go('home')}>Keep the old one</div>
            </>}>
        Six weeks changed what needs doing. We’ll rebuild the schedule from today and keep
        everything you already did — every logged watering and photo stays.
      </Note>
      <div style={{ fontSize: 'var(--t-14)', color: 'var(--muted)', lineHeight: 1.45,
                    marginTop: 16, padding: '0 4px' }}>
        {dry.length
          ? `The ${dry.join(' and ')} may have dropped a leaf while you were away. `
            + 'If it did, that’s normal — water deeply once and it comes back.'
          : 'Nothing dried out completely. Water once, and the schedule picks up from today.'}
      </div>
    </Screen>
  )
}

// ─────────────────────────────────────────── Soft-lock
//
// Экран существует ради ОДНОГО: показать бесплатному человеку, что впереди
// запланировано больше, чем ему видно. Три вещи, которые он делал вместо этого,
// убраны — каждая была неправдой:
//
// 1. Заголовок обещал конкретное окно «Two weeks from now · Apr 24–30». Даты
//    считались от условного «сегодня» прототипа (season.ts: START + TODAY =
//    10 апреля 2026) — то есть настоящему человеку в августе показывали апрель.
//    Пока приложение живёт по замороженным часам, никакого окна тут называть
//    нельзя: «дальше этой недели» — единственное, что правда.
// 2. Число в h1 считалось из weekTasks(), а это задачи ТЕКУЩЕЙ недели.
//    Функции «что будет через две недели» в приложении нет вообще: weekTasks
//    берёт сегодняшнее состояние растений и времени не принимает. Заголовок
//    «через две недели» стоял над списком этой недели.
// 3. Pro-ветка печатала эти же задачи текущей недели под ярлыком «What they
//    are» — то есть дублировала Home и выдавала это за план на будущее.
//
