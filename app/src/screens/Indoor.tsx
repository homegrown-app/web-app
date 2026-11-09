// Windowsill · edibles. Съедобный трек внутри дома.
//
// «Season ends: never» — вот почему подоконник закрывает сезонность: ритм тут
// срез каждую неделю, а не один сбор за 30 дней. Все четыре вида есть в
// справочнике с флагом sill. Экран показательный, содержимое статичное —
// таким он был и в прототипе, менять это при переносе не стали.

import { Screen } from '../components/Chrome'
import { Task } from '../components/parts'
import { Icon } from '../icons/Icon'
import { bg } from '../lib/assets'

type Go = (id: string) => void

/** Фото, название, строка состояния, плашка справа. Готовое к срезке помечено
    лаймом, остальное — серым сроком: срок это справка, а не действие. */
const ROWS: Array<[string, string, string, string, boolean]> = [
  ['basil', 'Basil', 'Cut 7 times · regrows in 10d', 'Ready', true],
  ['microgreens', 'Microgreens', 'Tray 3 · day 8', '~2d', false],
  ['cilantro', 'Cilantro', 'Cut 2 times · next in 9d', '~9d', false],
  ['chives', 'Garlic chives', 'Day 34 · first cut Jun 8', '~50d', false],
]

export function IndoorScreen({ go }: { go: Go }) {
  return (
    <Screen id="indoor" nav={{ active: 'Week', badge: true, go }}
            scrollKey="indoor">
      <div className="greet">Good morning · week 12</div>
      <div className="h1">Basil is ready<br /><span className="m">to cut again.</span></div>

      <div className="bed">
        <div className="bed-ph" style={{ backgroundImage: bg('basil') }}>
          <span className="pill b-photo">Windowsill · year-round</span>
        </div>
        <div className="bed-rows">
          {ROWS.map(([pic, name, sub, right, ready], i) => (
            <div className="bed-row" key={name} role={i === 0 ? 'button' : undefined}
                 tabIndex={i === 0 ? 0 : undefined}
                 onClick={i === 0 ? () => go('plant') : undefined}>
              <span className="bed-th" style={{ backgroundImage: bg(pic) }} />
              <div className="nm"><b>{name}</b><s>{sub}</s></div>
              <span className={'pill ' + (ready ? 'b-lime' : 'b-meta')}>
                {ready && <Icon name="check-circle" color="var(--ink)" size={14} />}
                {right}
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Два числа, которые объясняют подоконник: срезок много, а сезон не
          кончается — на улице так не бывает. */}
      <div className="duo2">
        <div><b>23</b><s>Cuts this year</s></div>
        <div><b>never</b><s>Season ends</s></div>
      </div>

      <div className="tasks" style={{ marginTop: 24 }}>
        <h2>This week</h2>
        <Task t={['Cut 6 basil leaves from the top', '2 min',
                  'Cut above a leaf pair — it branches and doubles.']} />
        <Task t={['Sow a new microgreens tray', '5 min']} />
        <Task t={['Water check: soil top dry?', '2 min']} />
      </div>
    </Screen>
  )
}
