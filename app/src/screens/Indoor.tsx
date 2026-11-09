// Windowsill · edibles. Съедобный трек внутри дома.
//
// «Season ends: never» — вот почему подоконник закрывает сезонность: ритм тут
// срез каждую неделю, а не один сбор за 30 дней. Все четыре вида есть в
// справочнике с флагом sill. Экран показательный, содержимое статичное —
// таким он был и в прототипе, менять это при переносе не стали.

import { Screen } from '../components/Chrome'
import { Ring } from '../components/bits'
import { Task } from '../components/parts'
import { Icon } from '../icons/Icon'
import { bg } from '../lib/assets'

type Go = (id: string) => void

const ROWS: Array<[string, string, string, string, number]> = [
  ['leaf', 'Basil', 'Cut 7 times · regrows in 10d', 'ready', 100],
  ['grains', 'Microgreens', 'Tray 3 · day 8', '~2d', 80],
  ['leaf', 'Cilantro', 'Cut 2 times · next in 9d', '~9d', 60],
  ['plant', 'Garlic chives', 'Day 34 · first cut Jun 8', '~50d', 40],
]

export function IndoorScreen({ go }: { go: Go }) {
  return (
    <Screen id="indoor" nav={{ active: 'Week', badge: true, go }}
            scrollKey="indoor">
      <div className="greet">Good morning · week 12</div>
      <div className="h1">Basil is ready<br /><span className="m">to cut again.</span></div>

      <div className="acc">
        <div className="acc-photo" style={{ backgroundImage: bg('basil') }} />
        <div className="row1"><span className="tag">WINDOWSILL · YEAR-ROUND</span></div>
        <div className="plants">
          {ROWS.map(([icon, name, sub, right, pct], i) => (
            <div className="prow" key={name} role={i === 0 ? 'button' : undefined}
                 tabIndex={i === 0 ? 0 : undefined}
                 onClick={i === 0 ? () => go('plant') : undefined}>
              <div className="rw">
                <Ring pct={pct} />
                <i><Icon name={icon} color="var(--primary-d)" size={15} sw={1.9} /></i>
              </div>
              <div className="nm"><b>{name}</b><s>{sub}</s></div>
              <div className="rt">{right}</div>
            </div>
          ))}
        </div>
        <div className="duo">
          <div className="cell"><s>Cuts this year</s>
            <b>23</b></div>
          <div className="cell"><s>Season ends</s><b>never</b></div>
        </div>
      </div>

      <div className="sl">This week</div>
      <Task t={['Cut 6 basil leaves from the top', '2 min',
                'Cut above a leaf pair — it branches and doubles.']} />
      <Task t={['Sow a new microgreens tray', '5 min']} />
      <Task t={['Water check: soil top dry?', '2 min']} />
    </Screen>
  )
}
