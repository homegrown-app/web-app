// Страница культуры. Открывается из календаря — из ленты и из полки сезона.
//
// Это НЕ screen('plant'): там растение из MY_PLANTS со своей историей полива,
// здесь вид из справочника и его окна в выбранном ZIP. Раскладка одинаковая
// намеренно: фото .score с градиентом, как на Week, дальше блоки-виджеты прямо
// на ground'е. Белого контейнера вокруг всего нет — иначе страница читается
// попапом.
//
// Три дорожки и два окна: рассада дома → высадка → прямой посев, весной и
// второй волной в конце лета. «N/A» — полноценное значение: у томата и перца
// прямого посева не бывает, и об этом надо сказать, а не спрятать строку.

import { Screen } from '../components/Chrome'
import { Icon } from '../icons/Icon'
import { bg } from '../lib/assets'
import { SP, type Species as Sp } from '../data/species'
import {
  MON, ahead, daysBetween, fmtMD, fmtRange, frostDates, live, nextWin, nowMonth,
  today, windows, zipInfo, type Ctx, type Range, type Window,
} from '../lib/season'
import { useStore } from '../state/store'

const NOW = today()
const d0 = (m: number, day: number) => new Date(2026, m - 1, day)

/** Что делать с этой культурой прямо сейчас — одной строкой. */
function status(w: Window): { k: string; t: string; e: string } {
  if (w.any) return { k: 'go', t: 'Sow any month', e: 'indoors, no season to wait for' }
  if (live(w.sow, NOW)) return { k: 'go', t: 'Sow now', e: `closes in ${daysBetween(NOW, w.sow![1])} days` }
  if (live(w.plant, NOW)) return { k: 'go', t: 'Plant out now', e: `closes in ${daysBetween(NOW, w.plant![1])} days` }
  if (live(w.indoors, NOW)) return { k: 'go', t: 'Start indoors', e: `plant out ${fmtMD(w.plant![0])}` }
  if (ahead(w.sow, NOW)) return { k: 'soon', t: `Opens ${fmtMD(w.sow![0])}`, e: `in ${daysBetween(NOW, w.sow![0])} days` }
  if (ahead(w.indoors, NOW)) return { k: 'soon', t: `Start indoors ${fmtMD(w.indoors![0])}`, e: '' }
  if (live(w.fall, NOW)) return { k: 'go', t: 'Sow now', e: `fall window · closes ${fmtMD(w.fall![1])}` }
  if (ahead(w.fall, NOW)) return { k: 'shut', t: `Next window ${fmtMD(w.fall![0])}`, e: 'too hot until then' }
  if (w.plant && NOW > w.plant[1]) {
    return { k: 'shut', t: `Missed by ${daysBetween(w.plant[1], NOW)} days`,
             e: w.indoors ? `next start indoors ${fmtMD(w.indoors[0])}` : '' }
  }
  return { k: 'shut', t: 'Closed for this season', e: '' }
}

/** Полоса года: жирные метки действий сверху, мягкая полоса сбора снизу. */
function Strip({ sp, w, ctx }: { sp: Sp; w: Window; ctx: Ctx }) {
  const W = 326, H = 84, BY = 32, BH = 48, R = 12, L1 = BY + 7, L2 = BY + 27, BAR = 14
  const at = (d: Date) => W * ((+d - +new Date(2026, 0, 1)) / 86400000) / 365
  const f = frostDates(ctx.zip)
  const bar = (r: Range | undefined, cls: string, y: number, h: number) => {
    if (!r) return null
    const a = at(r[0]), b = Math.max(at(r[1]), a + h)
    return <rect key={cls + y + a} className={cls} x={a} y={y} width={b - a} height={h} rx={h / 2} />
  }
  const ticks: JSX.Element[] = []
  if (sp.successionDays && !w.any) {
    for (const r of [w.sow, w.fall]) {
      if (!r) continue
      for (let t = new Date(+r[0] + sp.successionDays * 864e5); t < r[1];
           t = new Date(+t + sp.successionDays * 864e5)) {
        ticks.push(<rect key={'t' + +t} className="tick" x={at(t)} y={L1 + 2} width={1.4} height={BAR - 4} />)
      }
    }
  }
  const label = (r: Range | undefined, t: string) => r ? `${t} ${fmtRange(r)}` : ''
  const aria = [w.any ? 'no season, any month indoors' : '', label(w.indoors, 'start indoors'),
                label(w.plant, 'plant out'), label(w.sow, 'sow'), label(w.fall, 'sow again'),
                label(w.pick, 'harvest')].filter(Boolean).join(', ')

  return (
    <svg className="ystrip" viewBox={`0 0 ${W} ${H}`} height={H} role="img"
         aria-label={`${sp.name} in ${zipInfo(ctx.zip).city}: ${aria || 'no outdoor window'}`}>
      {[0, 3, 6, 9].map(i => (
        <text key={i} className={'mon' + (Math.floor(nowMonth() / 3) === i / 3 ? ' on' : '')}
              x={at(d0(i + 1, 1)) + 3} y={12}>{MON[i]}</text>
      ))}
      <rect className="bandbg" x={0} y={BY} width={W} height={BH} rx={R} />
      <path className="frost" d={
        `M${R} ${BY} H${at(f.last).toFixed(1)} V${BY + BH} H${R} A${R} ${R} 0 0 1 0 ${BY + BH - R}`
        + ` V${BY + R} A${R} ${R} 0 0 1 ${R} ${BY} Z`
        + `M${at(f.first).toFixed(1)} ${BY} H${W - R} A${R} ${R} 0 0 1 ${W} ${BY + R}`
        + ` V${BY + BH - R} A${R} ${R} 0 0 1 ${W - R} ${BY + BH} H${at(f.first).toFixed(1)} Z`} />
      {[3, 6, 9].map(q => (
        <line key={q} className="mgrid" x1={at(d0(q + 1, 1))} y1={BY} x2={at(d0(q + 1, 1))} y2={BY + BH} />
      ))}
      {[f.last, f.first].map((x, i) => (
        <line key={i} className="fline" x1={at(x)} y1={BY} x2={at(x)} y2={BY + BH} />
      ))}
      {w.any && bar([d0(1, 1), d0(12, 31)], 'b-sow', L1, BAR)}
      {bar(w.pick, 'b-pick', L2, BAR)}
      {bar(w.fallPick, 'b-pick', L2, BAR)}
      {bar(w.indoors, 'b-ind', L1 + 1, BAR - 2)}
      {bar(w.plant, 'b-plant', L1, BAR)}
      {bar(w.sow, 'b-sow', L1, BAR)}
      {bar(w.fall, 'b-sow', L1, BAR)}
      {ticks}
      <line className="now" x1={at(NOW)} y1={BY - 5} x2={at(NOW)} y2={BY + BH + 3} />
      <circle className="nowdot" cx={at(NOW)} cy={BY - 7} r={2.5} />
    </svg>
  )
}

function Chips({ sp, w }: { sp: Sp; w: Window }) {
  type C = { s: string; k: string; v: string | null; on: boolean }
  const c: C[] = [{ s: 'Direct sow', k: 'sow', v: w.any ? 'Any month' : fmtRange(w.sow),
                    on: !!w.any || live(w.sow, NOW) }]
  if (sp.transplant) {
    c.push({ s: 'Indoors', k: 'ind', v: fmtRange(w.indoors), on: live(w.indoors, NOW) })
    c.push({ s: 'Plant out', k: 'plant', v: fmtRange(w.plant), on: live(w.plant, NOW) })
  }
  if (w.fall) c.push({ s: 'Sow again', k: 'sow', v: fmtRange(w.fall), on: live(w.fall, NOW) })
  if (c.length < 3) {
    const pick = w.pick && NOW <= w.pick[1] ? w.pick : (w.fallPick || w.pick)
    c.push({ s: 'Harvest', k: 'pick', v: fmtRange(pick), on: live(pick, NOW) })
  }
  return (
    <div className="wchips" style={{ gridTemplateColumns: `repeat(${c.length > 3 ? 2 : 3},1fr)` }}>
      {c.map(x => (
        <div key={x.s} className={'wchip' + (x.v ? '' : ' na') + (x.on ? ' live' : '')}>
          <s><i className={'k-' + x.k} /><u>{x.s}</u></s>
          <b>{x.v || 'N/A'}</b>
        </div>
      ))}
    </div>
  )
}

/** Четыре факта плитками. Выделена морозостойкость — единственная из четырёх,
    что меняет поведение календаря: она решает, когда культура уходит в грунт. */
function Facts({ sp }: { sp: Sp }) {
  const cold = /Tolerant|Hardy/i.test(sp.hum) || sp.hardiness === 'hardy'
  const frost = sp.hardiness === 'hardy' ? 'Tolerant'
    : sp.hardiness === 'half' ? 'Half-hardy' : 'Tender'
  const tile = (icon: string, label: string, val: string, cls = '') => (
    <div key={label} className={'fact' + (cls ? ' ' + cls : '')}>
      <span className="fi"><Icon name={icon} size={18} /></span>
      <div><s>{label}</s><b>{val}</b></div>
    </div>
  )
  return (
    <div className="facts">
      {tile('basket', 'To harvest', (sp.days === sp.daysMax ? sp.days : `${sp.days}–${sp.daysMax}`) + ' days')}
      {tile('potted-plant', 'Pot', sp.pot)}
      {tile('sun', 'Sun', sp.light)}
      {tile('snowflake', 'Frost', sp.anyMonth ? 'Indoors' : frost, cold ? 'cold' : 'warm')}
    </div>
  )
}

export function CropScreen({ go }: { go: (id: string) => void }) {
  const { s, ctx } = useStore()
  const sp = s.cropId ? SP(s.cropId) : undefined
  const w = sp ? windows(sp, ctx) : null

  if (!sp || !w) {
    return (
      <Screen id="crop" back={() => go('calendar')} nav={{ active: 'Calendar', go }}>
        <div className="note" style={{ marginTop: 16 }}>
          <b>Nothing to show</b>
          <p>Open a crop from the calendar and its windows land here.</p>
        </div>
      </Screen>
    )
  }

  const st = status(w)
  const open = st.k === 'go'
  const nx = nextWin(w, NOW)
  const sowings = [w.sow, w.fall].filter(Boolean)
    .reduce((n, r) => n + Math.floor(daysBetween(r![0], r![1]) / (sp.successionDays || 1)) + 1, 0)
  const note = sp.successionDays && !w.any
    ? <><b>Sow again every {sp.successionDays} days</b> while the window is open — that is {sowings} sowings, not one.</>
    : (sp.transplant && !sp.direct
        ? <><b>No direct sowing.</b> Seed goes in a tray indoors first, then the seedling goes out.</>
        : null)
  const z = zipInfo(ctx.zip)

  return (
    <Screen id="crop" back={() => go('calendar')} nav={{ active: 'Calendar', go }} scrollKey={sp.id}>
      {/* Имя под фотографией, а не на ней: в канвасе (app-16) кадр чистый,
          а заголовок, латынь и срок стоят текстом под ним. */}
      <div className="crop-ph" style={{ backgroundImage: bg(sp.img) }} role="img"
           aria-label={sp.name} />
      <div className="crop-h">
        <div className="h1">{sp.name}</div>
        {sp.latin && <p className="crop-lat">{sp.latin}</p>}
        <span className={'pill ' + (open ? 'b-act' : 'b-meta')}>
          <Icon name="clock" color="currentColor" size={14} />
          {st.t}{st.e ? ` · ${st.e}` : ''}
        </span>
      </div>

      <div className="wbox" style={{ marginTop: 16 }}>
        <Strip sp={sp} w={w} ctx={ctx} />
      </div>

      <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <Chips sp={sp} w={w} />
        <Facts sp={sp} />
        {note && (
          <div className="wnote">
            <span className="fi">
              <Icon name={sp.successionDays && !w.any ? 'arrows-clockwise' : 'grains'} size={15} />
            </span>
            <div>{note}</div>
          </div>
        )}
        <div className={'btn ' + (open ? 'b-pri' : 'b-sec')} role="button" tabIndex={0}
             onClick={() => go('add-plant')}
             onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go('add-plant') } }}>
          {open ? 'Add to my garden' : `Remind me ${nx ? fmtMD(nx[0]) : 'next season'}`}
        </div>
        <div className="wsrc">From your frost dates · {z.city} · {z.last} / {z.first}</div>
      </div>
    </Screen>
  )
}
