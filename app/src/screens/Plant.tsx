// Карточка растения. Два вида — два прибора, как в канвасе: съедобному нужен
// срок до сбора, комнатному — то, что оно пережило неделю.
//
//   съедобное  фраза о поливе + три ближайших дня + тёмная карточка роста
//   комнатное  кольцо, которое пустеет, пока сохнет земля, + шкалы условий
//
// Если у вида нет настоящей фотографии, стоит плитка с иконкой, а не битая
// картинка: выдумывать ассеты нельзя.

import { Screen } from '../components/Chrome'
import { Dial, DropLevel, Note, PhotoTile, Ring, dropTone } from '../components/bits'
import { useCamera } from '../components/parts'
import { Icon, IcPlus } from '../icons/Icon'
import { img } from '../lib/assets'
import {
  HUM_STEPS, LIGHT_STEPS, fmtPot, hPct, humSpan, isEdible, lightSpan, pState, phUrl, wDue,
} from '../lib/plants'
import type { Plant } from '../lib/plants'
import { useStore } from '../state/store'

/** Плашка состояния: лайм у здорового, лиловая у «скоро», красная у просроченного. */
const TONE: Record<string, string> = { ok: 'b-lime', warn: 'b-act', bad: 'b-warn' }

/**
 * Три ближайших дня. Фиолетовый — полив уже был сегодня, лиловый с обводкой —
 * следующий. Третья клетка подписана настоящим сроком, если он дальше завтра:
 * иначе она обещала бы «через 2 дня» там, где полив уже назначен раньше.
 */
function WaterDays({ p }: { p: Plant }) {
  const due = wDue(p)
  const far = Math.max(2, due)
  const days: Array<[string, number]> = [['Today', 0], ['Tomorrow', 1], [`In ${far}d`, far]]
  return (
    <div className="wdays" aria-hidden="true">
      {days.map(([label, n]) => {
        const was = n === 0 && p.since === 0
        const next = n === due && due >= 0
        return (
          <span key={label} className={next ? 'next' : was ? 'was' : undefined}>
            <i>{(was || next) && <Icon name="drop" color="currentColor" size={16} />}</i>
            {label}
          </span>
        )
      })}
    </div>
  )
}

/** Шкала условия: ступень вида подсвечена, всё ниже — «тоже годится». */
function Scale({ icon, label, value, steps, span }:
    { icon: string; label: string; value: string; steps: string[]; span: [number, number] }) {
  return (
    <div className="happy-g">
      <div className="scale-h">
        <Icon name={icon} color="var(--primary-d)" size={16} />
        <b>{label}</b><s>{value}</s>
      </div>
      <div className="scale">
        {steps.map((t, i) => (
          <span key={t} className={i >= span[0] && i <= span[1] ? 'on' : i < span[0] ? 'near' : undefined}>
            <i /><u>{t}</u>
          </span>
        ))}
      </div>
    </div>
  )
}

export function PlantScreen({ go }: { go: (id: string) => void }) {
  const { s, d } = useStore()
  const p = s.plants[s.selected]
  const cam = useCamera(url => d({ t: 'addPhoto', v: { i: s.selected, url } }))

  if (!p) {
    return (
      <Screen id="plant" back={() => go('home')} nav={{ active: 'Week', go }} scrollKey="plant">
        <Note title="This plant is gone"
              cta={<div className="btn b-pri" role="button" tabIndex={0}
                        onClick={() => go('add-plant')}>Add a plant</div>}>
          You removed it. Nothing is lost — add it again whenever you like.
        </Note>
      </Screen>
    )
  }

  const st = pState(p)
  const due = wDue(p)
  const edible = isEdible(p)
  const ready = edible && hPct(p) >= 100
  const pic = p.photos[0] ? phUrl(p.photos[0]) : (p.s.img ? img(p.s.img) : null)
  const light = lightSpan(p.s.light)
  const hum = humSpan(p.s.hum)
  // Кольцо комнатного пустеет по мере высыхания: полный круг сразу после
  // полива, пустой — в день следующего.
  const wLeft = Math.max(0, Math.min(100, (due / Math.max(1, p.s.water)) * 100))
  // Шкала роста: конец окна сбора приходит на 87.5% круга, как в канвасе
  // (у редиса окно 25–35 дней при шкале в 40). Длину округляем вверх до пяти,
  // иначе засечки и окно разъезжаются на доли дня.
  const dMax = p.s.daysMax || p.s.days
  const span = Math.max(5, Math.ceil(dMax / 0.875 / 5) * 5)
  const band: [number, number] | undefined =
    dMax > 0 ? [p.s.days / span, dMax / span] : undefined

  return (
    <Screen id="plant" back={() => go('home')} nav={{ active: 'Week', go }}
            scrollKey={'plant' + s.selected}>
      <PhotoTile s={p.s} cls="det-ph" style={{ marginTop: 8 }} />

      <div className="pt-top">
        <div>
          <div className="h1">{p.s.name}</div>
          {p.s.latin && <div className="pt-lat">{p.s.latin}</div>}
        </div>
        <span className={'pill ' + (TONE[st[1]] || 'b-meta')}>
          {st[1] === 'ok' && <Icon name="check-circle" color="var(--ink)" size={14} />}
          {st[0]}
        </span>
      </div>

      {edible ? (
        <div className="card wcard">
          <div className="wcard-h">
            <span>
              <b>{due <= 0 ? 'Water it today' : `Next water in ${due} ${due === 1 ? 'day' : 'days'}`}</b>
              <s>Every {p.s.water}d · last {p.since === 0 ? 'today' : `${p.since}d ago`}</s>
            </span>
            <DropLevel tone={dropTone(p)} />
          </div>
          <WaterDays p={p} />
        </div>
      ) : (
        <div className="card wcard wring">
          <span className="wring-r">
            <Ring pct={wLeft} sz={88} sw={10} />
            <span><b>{Math.max(0, due)}d</b><u>to water</u></span>
          </span>
          <span style={{ flex: 1 }}>
            <b style={{ display: 'block', fontSize: 'var(--t-20)', lineHeight: '22px', fontWeight: 600 }}>
              {due <= 0 ? 'Water it today' : p.since === 0 ? 'Watered today' : `Watered ${p.since}d ago`}
            </b>
            <s style={{ display: 'block', marginTop: 2, textDecoration: 'none',
                        fontSize: 'var(--t-13)', lineHeight: '18px', fontWeight: 500,
                        color: 'var(--muted)' }}>
              Every {p.s.water} days. The ring empties as the soil dries.
            </s>
          </span>
        </div>
      )}

      {edible ? (
        <div className="ph-card">
          {pic && <div className="ph-bg" style={{ backgroundImage: `url(${pic})` }} />}
          <div className="ph-sc" />
          <div className="ph-in">
            <div className="ph-h">
              <span>
                <b>Growth</b>
                <s>Pick window {p.s.days}–{p.s.daysMax} days</s>
              </span>
              {ready && (
                <span className="pill b-lime">
                  <Icon name="check-circle" color="var(--ink)" size={14} />Ready
                </span>
              )}
            </div>
            <div className="ph-r">
              <span style={{ width: 180, height: 180 }}>
                <Dial sz={180} r={70} sw={8} disc={58} discFill="rgba(18,24,32,.28)" ticks={40}
                      pct={(p.day / span) * 100} band={band} />
                <span><b>{p.day}</b><u>days</u></span>
              </span>
            </div>
            <div className="ph-chips">
              <span><b>{hPct(p)}%</b><u>{ready ? 'ready to pick' : 'to first pick'}</u></span>
              <span><b>{fmtPot(p.s.pot, s.units)}</b><u>pot</u></span>
              <span><b>{p.s.days}–{p.s.daysMax}d</b><u>typical</u></span>
            </div>
          </div>
        </div>
      ) : (light || hum) && (
        <div className="card happy">
          <b>Where it’s happy</b>
          {light && <Scale icon="sun" label="Light" value={p.s.light}
                           steps={LIGHT_STEPS} span={light} />}
          {hum && <Scale icon="drop" label="Humidity" value={p.s.hum}
                         steps={HUM_STEPS} span={hum} />}
        </div>
      )}

      <div className="btn b-pri" role="button" tabIndex={0}
           onClick={() => d({ t: 'water', v: s.selected })}>
        <Icon name="drop" color="#fff" size={20} />Water it now
      </div>
      {ready && (
        <div className="btn b-white" role="button" tabIndex={0} onClick={() => go('harvest')}>
          <Icon name="scissors" color="currentColor" size={20} />Pick it — first harvest
        </div>
      )}

      <div className="sl">
        Journal{p.photos.length
          ? ` · ${p.photos.length} ${p.photos.length === 1 ? 'photo' : 'photos'}`
          : ''}
      </div>
      {p.photos.length > 0 && (
        <div className="jgrid">
          {p.photos.map((x, k) => (
            <figure className="jc" key={k}>
              <div className="jph" style={{ backgroundImage: `url(${phUrl(x)})` }} />
              <figcaption><b>{p.s.name}</b><s>Day {x.day} · {st[0]}</s></figcaption>
            </figure>
          ))}
        </div>
      )}
      <div className="btn-dash" role="button" tabIndex={0} onClick={cam.open}>
        <IcPlus /><span>{p.photos.length ? 'Add a photo' : 'Take the first photo'}</span>
      </div>
      {cam.input}

      <div className="danger" role="button" tabIndex={0}
           onClick={() => { d({ t: 'remove', v: s.selected }); go('home') }}>
        Remove from my plants
      </div>
    </Screen>
  )
}
