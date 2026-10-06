// Стенд: ящик с тремя секциями, у каждой свой QR. QR открывает экран секции,
// посетитель снимает растение и получает одно действие. Распознавания нет и
// здесь: секцию называет QR, а не догадка по фото, — снимок уходит только в
// кадр, чтобы человек видел своё растение.
//
// Демо идёт на планшете стенда, поэтому общее состояние стенда (полит ли
// базилик сегодня, сколько раз срезали салат) живёт в localStorage этого
// устройства. Отметка полива держится до конца дня: следующий посетитель не
// льёт в тот же горшок второй раз.

import { useEffect, useState } from 'react'
import { Arc } from '../components/bits'
import { useCamera } from '../components/parts'
import { Icon } from '../icons/Icon'
import { img } from '../lib/assets'
import { hPct, mkPlant, weekTasks, type Plant } from '../lib/plants'

type Go = (id: string) => void
export type BoothId = 'basil' | 'lettuce' | 'tomato'

/** Растения стенда и их история. since — дней с полива, day — возраст. */
const PLANTS: Record<BoothId, Plant> = {
  basil: mkPlant('basil', 3, 34),
  lettuce: mkPlant('lettuce', 1, 32),
  tomato: mkPlant('cherrytomato', 1, 21),
}

// ── состояние стенда ────────────────────────────────────────────────
const KEY = 'hg.booth'
interface Stand { wateredAt: number | null; picks: number; pickDay: string }
const today = () => new Date().toDateString()
function readStand(): Stand {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}') as Partial<Stand>
    const picks = v.pickDay === today() ? v.picks || 0 : 0
    return { wateredAt: v.wateredAt ?? null, picks, pickDay: today() }
  } catch { return { wateredAt: null, picks: 0, pickDay: today() } }
}
function writeStand(v: Stand) {
  try { localStorage.setItem(KEY, JSON.stringify(v)) } catch { /* приватный режим */ }
}
const wateredToday = (st: Stand) =>
  st.wateredAt !== null && new Date(st.wateredAt).toDateString() === today()

const hhmm = (t: number) =>
  new Date(t).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
const plusDays = (n: number) =>
  new Date(Date.now() + n * 864e5).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })

/** Через минуту без касаний экран секции возвращается к началу: следующий
    посетитель не должен видеть чужой снимок и чужой ответ. */
const IDLE_MS = 60_000

// ── экран секции ────────────────────────────────────────────────────
export function BoothScreen({ id }: { id: BoothId }) {
  const p = PLANTS[id]
  const [shot, setShot] = useState<string | null>(null)
  const [step, setStep] = useState<string>('start')
  const [st, setSt] = useState<Stand>(readStand)
  const cam = useCamera(url => { setShot(url); setStep('result') })

  const reset = () => { setShot(null); setStep('start'); setSt(readStand()) }
  useEffect(() => {
    if (step === 'start') return
    const t = window.setTimeout(reset, IDLE_MS)
    return () => window.clearTimeout(t)
  }, [step, shot])

  const save = (v: Stand) => { writeStand(v); setSt(v) }

  return (
    <div className="screen on" id={'s-booth-' + id}>
      <div className="dark" style={{ padding: 0 }}>
        {cam.input}
        {/* До снимка в рамке фото культуры из библиотеки: посетитель сразу
            видит, что снимать. Снимок посетителя его заменяет. */}
        <div className="scan-shot" style={{ backgroundImage: `url(${shot || img(p.s.img || "")})` }} />
        <div className="scan-ov">
          <div className={'scan-frame' + (shot ? ' ok' : '')} />
          <div className="scan-foot booth-foot">
            {step === 'start'
              ? <Start p={p} id={id} st={st} onShot={cam.open} />
              : id === 'basil' ? <Care p={p} step={step} setStep={setStep} st={st} save={save} />
              : id === 'lettuce' ? <Pick p={p} step={step} setStep={setStep} st={st} save={save} />
              : <Grow p={p} />}
            {step !== 'start' && (
              <div className="btn booth-next" role="button" tabIndex={0} onClick={reset}>
                Next visitor
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

/** История растения одной строкой: то, что приложение уже знает до снимка. */
function History({ p, watered }: { p: Plant; watered: boolean }) {
  return (
    <div className="booth-hist">
      <span><b>Day {p.day}</b> since sowing</span>
      <span><b>{watered ? 0 : p.since}d</b> since water</span>
      <span>harvest at <b>day {p.s.days}{p.s.daysMax !== p.s.days ? '–' + p.s.daysMax : ''}</b></span>
    </div>
  )
}

function Start({ p, id, st, onShot }: { p: Plant; id: BoothId; st: Stand; onShot: () => void }) {
  const done = id === 'basil' && wateredToday(st)
  return (
    <>
      <span className="pill b-lime booth-tag">{p.s.name}</span>
      <b style={{ marginTop: 12 }}>Point the camera at the {p.s.name.toLowerCase()}</b>
      <s>
        {done
          ? `Already watered today at ${hhmm(st.wateredAt!)}. Take a photo anyway — we’ll show what comes next.`
          : 'We know this plant and its history. Take a photo and we’ll tell you what it needs today.'}
      </s>
      <History p={p} watered={done} />
      <div className="btn b-lime" role="button" tabIndex={0} onClick={onShot}>
        <Icon name="camera" size={20} color="var(--deepest)" />&nbsp; Take a photo
      </div>
    </>
  )
}

interface StepProps {
  p: Plant; step: string; setStep: (s: string) => void; st: Stand; save: (v: Stand) => void
}

// 🌱 Нужен уход. По фото листьев сухость почвы не узнать, поэтому спрашиваем.
function Care({ p, step, setStep, st, save }: StepProps) {
  if (wateredToday(st) && step !== 'thanks') {
    return (
      <>
        <span className="pill booth-ok">Done today</span>
        <b style={{ marginTop: 12 }}>Nothing to do right now</b>
        <s>Watered at {hhmm(st.wateredAt!)}. The soil needs time to dry out — next check on {plusDays(p.s.water)}.</s>
      </>
    )
  }
  if (step === 'result') {
    return (
      <>
        <span className="pill b-lime booth-tag">One question</span>
        <b style={{ marginTop: 12 }}>Push a finger into the soil</b>
        <s>About 3 cm (1 in) deep, next to the stem. A photo can’t tell us this — your finger can. How does it feel?</s>
        <div className="booth-two">
          <div className="btn b-lime" role="button" tabIndex={0} onClick={() => setStep('dry')}>Dry</div>
          <div className="btn booth-alt" role="button" tabIndex={0} onClick={() => setStep('damp')}>Still damp</div>
        </div>
      </>
    )
  }
  if (step === 'dry') {
    return (
      <>
        <span className="pill b-lime booth-tag"><Icon name="drop" size={14} color="var(--deepest)" />&nbsp;Water today</span>
        <b style={{ marginTop: 12 }}>Water the basil</b>
        <s>About 1 cup (250 ml), slowly, at the base — stop when it starts to drain. Leaves stay dry.</s>
        <div className="btn b-lime" role="button" tabIndex={0}
             onClick={() => { save({ ...st, wateredAt: Date.now() }); setStep('thanks') }}>
          Done — I watered it
        </div>
      </>
    )
  }
  if (step === 'thanks') {
    return (
      <>
        <span className="pill booth-ok">Done</span>
        <b style={{ marginTop: 12 }}>Watering done</b>
        <s>Marked as done for everyone at the stand. Next check on {plusDays(p.s.water)}.</s>
      </>
    )
  }
  return (
    <>
      <span className="pill booth-ok">No water needed</span>
      <b style={{ marginTop: 12 }}>Leave it for today</b>
      <s>Damp soil means the roots still have water. Watering now would only drown them. Check again tomorrow.</s>
    </>
  )
}

// 🥬 Пора собирать. Схема показывает, где резать, и что оставить.
function Pick({ step, setStep, st, save }: StepProps) {
  if (step === 'picked') {
    return (
      <>
        <span className="pill booth-ok">Your harvest</span>
        <b style={{ marginTop: 12 }}>That’s homegrown</b>
        <s>The heart keeps growing — this pot is ready to pick again in 7–10 days.
           {st.picks > 1 ? ` ${st.picks} harvests at the stand today.` : ''}</s>
      </>
    )
  }
  return (
    <>
      <span className="pill b-lime booth-tag"><Icon name="scissors" size={14} color="var(--deepest)" />&nbsp;Ready to pick</span>
      <b style={{ marginTop: 12 }}>Pick the first leaves</b>
      <CutDiagram />
      <ol className="booth-steps">
        <li>Take the <em>outer</em> leaves — the biggest, lowest ones.</li>
        <li>Cut 2–3 cm (1 in) above the soil.</li>
        <li>Leave the heart. It regrows from the middle.</li>
      </ol>
      <div className="btn b-lime" role="button" tabIndex={0}
           onClick={() => { save({ ...st, picks: st.picks + 1, pickDay: today() }); setStep('picked') }}>
        I picked some
      </div>
    </>
  )
}

// 🌿 Продолжаем выращивать. Задачи — из того же движка, что и неделя на Home.
function Grow({ p }: { p: Plant }) {
  const tasks = weekTasks([p]).slice(0, 3)
  const left = p.s.days - p.day
  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Arc pct={hPct(p)} sz={44} />
        <div>
          <span className="pill booth-ok">Still growing</span>
        </div>
      </div>
      <b style={{ marginTop: 12 }}>First tomatoes in about {left} days</b>
      <s>Day {p.day} of {p.s.days}–{p.s.daysMax}. Nothing to pick yet — here’s what keeps it on track.</s>
      <ul className="booth-tasks">
        {tasks.map(t => <li key={t[3]}><i />{t[0]}<span>{t[1]}</span></li>)}
      </ul>
    </>
  )
}

/** Срез салата сбоку: внешние листья режутся над почвой, сердцевина остаётся. */
function CutDiagram() {
  const outer = ['M160 150 C120 140 70 110 50 70 C90 80 130 110 160 150Z',
                 'M160 150 C200 140 250 110 270 70 C230 80 190 110 160 150Z',
                 'M160 150 C135 130 105 95 100 50 C125 75 150 110 160 150Z',
                 'M160 150 C185 130 215 95 220 50 C195 75 170 110 160 150Z']
  const heart = ['M160 150 C150 120 145 90 152 62 C165 90 168 120 160 150Z',
                 'M160 150 C170 120 178 95 175 70 C160 95 155 122 160 150Z']
  return (
    <svg className="booth-cut" viewBox="0 0 320 196" role="img"
         aria-label="Side view of a lettuce: cut the outer leaves 2 to 3 centimetres above the soil, leave the inner leaves">
      <path d="M96 160 H224 L212 196 H108Z" fill="#1B3527" />
      <rect x="96" y="150" width="128" height="12" rx="3" fill="#3A2E22" />
      {outer.map(d => <path key={d} d={d} fill="#22A559" />)}
      {heart.map(d => <path key={d} d={d} fill="#B4F461" />)}
      <line x1="40" y1="138" x2="280" y2="138" stroke="#FF7043" strokeWidth="2.5" strokeDasharray="7 6" />
      <line x1="86" y1="138" x2="86" y2="150" stroke="#A9BCB0" strokeWidth="1.5" />
      <text x="40" y="160" fill="#A9BCB0" fontSize="11" fontFamily="Inter Tight, sans-serif">2–3 cm</text>
      <text x="40" y="130" fill="#FF7043" fontSize="12" fontWeight="600" fontFamily="Inter Tight, sans-serif">cut here</text>
      <text x="163" y="40" textAnchor="middle" fill="#B4F461" fontSize="12" fontWeight="600" fontFamily="Inter Tight, sans-serif">leave the heart</text>
    </svg>
  )
}

// ── хаб для персонала ────────────────────────────────────────────────
const SECTIONS: { id: BoothId; route: string; label: string }[] = [
  { id: 'basil', route: 'booth-basil', label: 'Needs care' },
  { id: 'lettuce', route: 'booth-lettuce', label: 'Ready to pick' },
  { id: 'tomato', route: 'booth-tomato', label: 'Keeps growing' },
]

export function BoothHubScreen({ go }: { go: Go }) {
  const [st, setSt] = useState<Stand>(readStand)
  const base = location.origin + location.pathname
  return (
    <div className="screen on" id="s-booth">
      <div className="dark">
        <b className="booth-h">Stand</b>
        <s className="booth-sub">Each section has its own QR. Tap a section to run it on this tablet.</s>
        {SECTIONS.map(x => (
          <div key={x.id} className="booth-row" role="button" tabIndex={0} onClick={() => go(x.route)}>
            <div>
              <b>{PLANTS[x.id].s.name}</b>
              <s>{x.label}{x.id === 'basil' && wateredToday(st) ? ` · watered ${hhmm(st.wateredAt!)}` : ''}
                 {x.id === 'lettuce' && st.picks ? ` · picked ${st.picks}× today` : ''}</s>
              <code>{base}#{x.route}</code>
            </div>
            <Icon name="chevron-right" color="#A9BCB0" size={20} sw={2.2} />
          </div>
        ))}
        <div className="btn booth-alt" role="button" tabIndex={0}
             onClick={() => { const v = { wateredAt: null, picks: 0, pickDay: today() }; writeStand(v); setSt(v) }}>
          Reset the stand
        </div>
        <s className="booth-sub">Clears today’s watering mark and harvest count — after swapping pots or at the start of a day.</s>
      </div>
    </div>
  )
}
