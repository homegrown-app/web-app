// Онбординг. Развилка на входе: приложение — трекер ухода, а не только
// планировщик посадки, поэтому у «уже есть растения» и «хочу начать» разные
// вопросы и разные концы. Обе ветки сходятся на Home.

import { useState } from 'react'
import { NO_AUTH } from '../lib/demo'
import { Screen } from '../components/Chrome'
import { Opt, Pg, PickRow } from '../components/parts'
import { Icon } from '../icons/Icon'
import { bg } from '../lib/assets'
import { trackOfPlants } from '../lib/plants'
import {
  GOALS, Q4TITLE, SPACES, SUNLABEL, SUNRANK, TRACKOF, goalTag, isOutdoorSpace,
} from '../data/onboarding'
import { ZIPS } from '../data/zips'
import { useStore } from '../state/store'
import { seasonDays } from '../lib/season'

type Go = (id: string) => void

/** Кнопка шага онбординга. Гаснет, пока ничего не выбрано: экран ничего не
    выбирает за человека, а сделанный выбор видно до перехода — раньше опция
    уводила дальше тем же тапом, и подтверждения выбора человек не видел. */
function StepBtn({ on, onNext, label = 'Continue' }:
    { on: boolean; onNext: () => void; label?: string }) {
  return (
    <div className={'btn b-pri' + (on ? '' : ' off')} role="button" tabIndex={0}
         onClick={() => { if (on) onNext() }}
         onKeyDown={e => {
           if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (on) onNext() }
         }}>{label}</div>
  )
}

// ─────────────────────────────────────────── Landing
export function LandingScreen({ go }: { go: Go }) {
  return (
    <div className="screen on" id="s-landing">
      <div className="sb"><span>9:41</span>
        <span style={{ letterSpacing: '.06em' }}>
          <Icon name="sun" color="var(--ink)" size={15} sw={2} />
        </span></div>
      <div className="shot" style={{ backgroundImage: bg('hero-basket'), top: 48 }} />
      <div className="scrim" style={{ top: 48 }} />
      <div className="overlay" style={{ top: 48 }}>
        <div className="wm" style={{ color: '#fff' }}>HOMEGROWN</div>
        <div style={{ flex: 1 }} />
        <div className="cap-f" style={{ fontSize: 'var(--t-40)', lineHeight: 1.02 }}>
          Green thumb<br /><span style={{ color: 'var(--lime)' }}>not required.</span>
        </div>
        <div style={{ fontSize: 'var(--t-16)', lineHeight: 1.5, marginTop: 16, color: '#DCE7DE' }}>
          Tell us what you have and how much light it gets. We’ll tell you what it needs
          this week.
        </div>
        <div className="btn b-lime" style={{ marginTop: 24 }} role="button" tabIndex={0}
             onClick={() => go('q0')}>Get started free</div>
        <div style={{ fontSize: 'var(--t-13)', color: '#C3D2C7', textAlign: 'center', marginTop: 12 }}>
          No card. Takes 90 seconds.
        </div>
        {/* Возврат: без этой ссылки вошедшему некуда деться с лендинга.
            В демо без регистрации входа нет — и ссылки нет. */}
        {!NO_AUTH && <div className="signin-l" role="button" tabIndex={0} onClick={() => go('signin')}
             onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go('signin') } }}>
          Already have an account? <b>Sign in</b>
        </div>}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────── Q0: развилка
export function Q0Screen({ go }: { go: Go }) {
  const { d } = useStore()
  const [own, setOwn] = useState<boolean | null>(null)
  const next = () => {
    if (own === null) return
    d({ t: 'onbReset', v: own ? 'own' : 'plan' })
    go(own ? 'add-plant' : 'qwhat')
  }
  return (
    <Screen id="q0" back={() => go('landing')} scrollKey="q0"
            foot={<StepBtn on={own !== null} onNext={next} />}>
      <div className="h1" style={{ marginTop: 16 }}>Where are you<br />starting from?</div>
      <div style={{ fontSize: 'var(--t-14)', color: 'var(--muted)', marginTop: 4 }}>
        Two very different jobs, so we ask different things.
      </div>
      <Pg id="q0" />
      <div style={{ marginTop: 16 }}>
        <Opt label="I already have plants" sub="Get them on a care schedule"
             on={own === true} onPick={() => setOwn(true)} />
        <Opt label="I want to start growing" sub="Tell me what to plant and buy"
             on={own === false} onPick={() => setOwn(false)} />
      </div>
    </Screen>
  )
}

// ─────────────────────────────────────────── QWhat: трек
export function QWhatScreen({ go }: { go: Go }) {
  const { d } = useStore()
  const [pick, setPick] = useState<string | null>(null)
  const next = () => {
    if (!pick) return
    d({ t: 'choices', v: { track: TRACKOF[pick] || 'edible', goals: [] } })
    go('q1')
  }
  return (
    <Screen id="qwhat" back={() => go('q0')} scrollKey="qwhat"
            foot={<StepBtn on={!!pick} onNext={next} />}>
      <div className="h1" style={{ marginTop: 16 }}>What are you growing?</div>
      <div style={{ fontSize: 'var(--t-14)', color: 'var(--muted)', marginTop: 4 }}>
        This decides the rest of the questions.
      </div>
      <Pg id="qwhat" />
      <div style={{ marginTop: 16 }}>
        <Opt label="Something to eat" sub="Radishes, greens, tomatoes in pots"
             on={pick === 'Something to eat'} onPick={() => setPick('Something to eat')} />
        <Opt label="Houseplants" sub="Monstera, pothos, snake plant"
             on={pick === 'Houseplants'} onPick={() => setPick('Houseplants')} />
        <Opt label="Both" sub="Something edible, plants inside too"
             on={pick === 'Both'} onPick={() => setPick('Both')} />
      </div>
    </Screen>
  )
}

// ─────────────────────────────────────────── Q1: место
export function Q1Screen({ go }: { go: Go }) {
  const { s, d } = useStore()
  const opts = SPACES[s.choices.track] || SPACES.both
  const [sel, setSel] = useState<[string, string] | null>(null)
  const next = () => {
    if (!sel) return
    const [label, to] = sel
    d({ t: 'choices', v: {
      outdoor: isOutdoorSpace(label),
      space: label.indexOf('Windowsill') > -1 ? 'windowsill' : label.toLowerCase(),
    } })
    go(to)
  }
  return (
    // Назад на ветке «уже есть» — в библиотеку, откуда сюда и пришли.
    <Screen id="q1" back={() => go(s.onbMode === 'own' ? 'add-plant' : 'q0')} scrollKey="q1"
            foot={<StepBtn on={!!sel} onNext={next} />}>
      <div className="h1" style={{ marginTop: 16 }}>
        {s.choices.track === 'edible' ? 'Where will you grow?' : 'Where will it live?'}
      </div>
      <Pg id="q1" />
      <div style={{ marginTop: 16 }}>
        {opts.map(([label, sub, to]) => (
          <Opt key={label} label={label} sub={sub} on={sel?.[0] === label}
               onPick={() => setSel([label, to])} />
        ))}
      </div>
    </Screen>
  )
}

// ─────────────────────────────────────────── Q2: ZIP (только уличный трек)
export function Q2Screen({ go }: { go: Go }) {
  const { d } = useStore()
  // Поле пустое, пока человек не ввёл: раньше тап по плашке молча подставлял
  // 78704, и выглядело это как «приложение само что-то решило».
  const [val, setVal] = useState('')
  const known = ZIPS.find(z => z.zip === val)
  const full = val.length === 5

  const type = (raw: string) => {
    const next = raw.replace(/\D/g, '').slice(0, 5)
    setVal(next)
    const hit = ZIPS.find(z => z.zip === next)
    if (hit) d({ t: 'choices', v: { zip: hit.zip } })
  }
  const pick = (zip: string) => { setVal(zip); d({ t: 'choices', v: { zip } }) }

  return (
    <Screen id="q2" back={() => go('q1')} scrollKey="q2"
            foot={<StepBtn on={!!known} onNext={() => go('q3')} />}>
      <div className="h1" style={{ marginTop: 16 }}>What’s your ZIP?</div>
      <div style={{ fontSize: 'var(--t-14)', color: 'var(--muted)', marginTop: 4 }}>
        Frost dates decide what can go outside, and when.
      </div>
      <Pg id="q2" />

      <label className={'fld' + (full && !known ? ' bad' : '')} style={{ marginTop: 16 }}>
        <span className="fld-l">ZIP code</span>
        <input inputMode="numeric" autoComplete="postal-code" pattern="[0-9]*" maxLength={5}
               enterKeyHint="done" placeholder="00000" aria-label="Your ZIP code"
               value={val} onChange={e => type(e.target.value)} />
      </label>

      {known ? (
        <div className="acc" style={{ marginTop: 16 }}>
          <div className="row1"><span className="tag">Matched</span></div>
          <div className="lbl">Climate profile</div>
          <div className="big">{known.city}</div>
          <div className="duo">
            <div className="cell"><s>Last frost</s><b>{known.last}</b></div>
            <div className="cell"><s>Season</s><b>{seasonDays(known.zip)} days</b></div>
          </div>
        </div>
      ) : (
        <>
          {/* Честно про охват: даты сверены со станциями по четырём индексам, и
              весь календарь считается от них. Выдумывать пятый нельзя. */}
          {full && (
            <div className="fld-err" role="alert">
              No verified frost dates for {val} yet.
            </div>
          )}
          <div className="sl">{full ? 'Pick one of these instead' : 'Or pick a city we’ve verified'}</div>
          {ZIPS.map(z => (
            <PickRow key={z.zip} label={`${z.zip} · ${z.city}`} on={false}
                     sub={`Zone ${z.zone} · frost ${z.last} – ${z.first} · ${seasonDays(z.zip)}-day season`}
                     onPick={() => pick(z.zip)} />
          ))}
        </>
      )}
    </Screen>
  )
}

// ─────────────────────────────────────────── Q3 / Q2i: свет
const SUN_OUT: Array<[string, string]> = [
  ['3–5 hours', 'Mostly shade or morning sun'],
  ['6–8 hours', 'Good sun most of the day'],
  ['8+ hours', 'Full blazing sun'],
  ['Not sure yet', 'We’ll start you safe and check later'],
]
const SUN_IN: Array<[string, string]> = [
  ['South window', 'Brightest — aloe and basil work here'],
  ['East or West', 'Good for most houseplants and herbs'],
  ['North window', 'Low light — pothos, ZZ, snake plant'],
  ['Not sure', 'We’ll start you safe'],
]
/** Ключ ранга у внутренних вариантов короче подписи на экране. */
const IN_KEY: Record<string, string> = {
  'South window': 'South', 'East or West': 'East or West',
  'North window': 'North', 'Not sure': 'Not sure',
}

function sunPick(label: string, indoor: boolean) {
  const key = indoor ? (IN_KEY[label] || label) : label
  return { sun: SUNLABEL[key] || 'your light', sunRank: SUNRANK[key] || 1 }
}

/** Ветка «уже есть» заканчивается на Home, а не на плане: трек виден по растениям. */
function useSunNext(go: Go) {
  const { s, d } = useStore()
  return (label: string, indoor: boolean) => {
    d({ t: 'choices', v: sunPick(label, indoor) })
    if (s.onbMode === 'own') {
      d({ t: 'choices', v: { track: trackOfPlants(s.plants, s.choices.track) } })
      // Регистрация нужна и здесь: раньше эта ветка заканчивалась прямо на Home,
      // то есть человек попадал в приложение вообще без аккаунта — и его
      // растения жили только в этом браузере. onbMode гасит уже сам Home.
      go('save')
      return
    }
    go('q4')
  }
}

export function Q3Screen({ go }: { go: Go }) {
  const sun = useSunNext(go)
  const [sel, setSel] = useState<string | null>(null)
  return (
    <Screen id="q3" back={() => go('q2')} scrollKey="q3"
            foot={<StepBtn on={!!sel} onNext={() => sel && sun(sel, false)} />}>
      <div className="h1" style={{ marginTop: 16 }}>How much direct sun<br />does that spot get?</div>
      <Pg id="q3" />
      <div style={{ marginTop: 16 }}>
        {SUN_OUT.map(([l, sub]) => (
          <Opt key={l} label={l} sub={sub} on={sel === l} onPick={() => setSel(l)} />
        ))}
      </div>
    </Screen>
  )
}

export function Q2iScreen({ go }: { go: Go }) {
  const sun = useSunNext(go)
  const [sel, setSel] = useState<string | null>(null)
  return (
    <Screen id="q2i" back={() => go('q1')} scrollKey="q2i"
            foot={<StepBtn on={!!sel} onNext={() => sel && sun(sel, true)} />}>
      <div className="h1" style={{ marginTop: 16 }}>How bright is<br />that spot?</div>
      <Pg id="q2i" />
      <div style={{ marginTop: 16 }}>
        {SUN_IN.map(([l, sub]) => (
          <Opt key={l} label={l} sub={sub} on={sel === l} onPick={() => setSel(l)} />
        ))}
      </div>
      <div className="card" style={{ marginTop: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
        <Icon name="lightbulb" color="var(--primary)" size={24} />
        <div style={{ fontSize: 'var(--t-14)', color: 'var(--ink-2)', lineHeight: 1.4 }}>
          Got a grow light? <b style={{ color: 'var(--ink)' }}>Tell us</b> — it upgrades your options.
        </div>
      </div>
    </Screen>
  )
}

// ─────────────────────────────────────────── Q4: цели, лимит 3
const MAXG = 3
export function Q4Screen({ go }: { go: Go }) {
  const { s, d } = useStore()
  const opts = GOALS[s.choices.track] || GOALS.both
  const picked = s.choices.goals
  const toggle = (label: string) => {
    const tag = goalTag(label)
    if (!tag) return
    const has = picked.indexOf(tag) > -1
    if (has) d({ t: 'choices', v: { goals: picked.filter(x => x !== tag) } })
    else if (picked.length < MAXG) d({ t: 'choices', v: { goals: [...picked, tag] } })
  }
  const full = picked.length >= MAXG
  return (
    <Screen id="q4" back={() => go(s.choices.outdoor ? 'q3' : 'q2i')} scrollKey="q4"
            foot={<>
              <div style={{ fontSize: 'var(--t-13)', color: 'var(--muted)', marginBottom: 8,
                            textAlign: 'center' }}>
                {picked.length ? `${picked.length} of 3 picked.` : 'Pick at least one.'}
              </div>
              <StepBtn on={!!picked.length} onNext={() => go('q5')} />
            </>}>
      <div className="h1" style={{ marginTop: 16 }}>{Q4TITLE[s.choices.track] || Q4TITLE.both}</div>
      <div style={{ fontSize: 'var(--t-14)', color: 'var(--muted)', marginTop: 4 }}>
        Up to 3 · {picked.length ? `${picked.length} selected` : 'nothing selected yet'}
      </div>
      <Pg id="q4" />
      <div style={{ marginTop: 16 }}>
        {opts.map(([label, tag]) => {
          const on = picked.indexOf(tag) > -1
          // лишние гаснут, а не исчезают
          return <Opt key={tag} label={label} multi on={on} dim={full && !on}
                      onPick={() => toggle(label)} />
        })}
      </div>
    </Screen>
  )
}

// ─────────────────────────────────────────── Q5: время в неделю
export function Q5Screen({ go }: { go: Go }) {
  const { s, d } = useStore()
  const many = s.choices.track === 'edible' ? 'a real garden' : 'a real collection'
  const [sel, setSel] = useState<number | null>(null)
  const next = () => {
    if (sel === null) return
    d({ t: 'choices', v: { effort: sel } })
    go('preview')
  }
  return (
    <Screen id="q5" back={() => go('q4')} scrollKey="q5"
            foot={<StepBtn on={sel !== null} onNext={next} />}>
      <div className="h1" style={{ marginTop: 16 }}>How much time can<br />you give it?</div>
      <Pg id="q5" />
      <div style={{ marginTop: 16 }}>
        <Opt label="About 10 minutes" sub="Keep it very simple · 3 plants"
             on={sel === 3} onPick={() => setSel(3)} />
        <Opt label="About 20 minutes" sub="I can do a bit more · 4 plants"
             on={sel === 4} onPick={() => setSel(4)} />
        <Opt label="30+ minutes" sub={`I want ${many} · up to 6 plants`}
             on={sel === 6} onPick={() => setSel(6)} />
      </div>
    </Screen>
  )
}
