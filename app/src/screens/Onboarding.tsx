// Онбординг. Развилка на входе: приложение — трекер ухода, а не только
// планировщик посадки, поэтому у «уже есть растения» и «хочу начать» разные
// вопросы и разные концы. Обе ветки сходятся на Home.

import { useState } from 'react'
import { NO_AUTH } from '../lib/demo'
import { Screen } from '../components/Chrome'
import { Opt, Pg, PickRow } from '../components/parts'
import { Icon, SeedLine } from '../icons/Icon'
import { bg, cut } from '../lib/assets'
import { trackOfPlants } from '../lib/plants'
import {
  CUTS, GOALS, Q4TITLE, SPACES, SUNLABEL, SUNRANK, TRACKOF, goalIcon, goalTag,
  isOutdoorSpace, spaceIcon,
} from '../data/onboarding'
import { ZIPS } from '../data/zips'
import { useStore } from '../state/store'
import { frostDates, seasonDays } from '../lib/season'

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
        <div style={{ fontSize: 'var(--t-16)', lineHeight: 1.5, marginTop: 16, color: 'rgba(255,255,255,.9)' }}>
          Tell us what you have and how much light it gets. We’ll tell you what it needs
          this week.
        </div>
        <div className="btn b-lime" style={{ marginTop: 24 }} role="button" tabIndex={0}
             onClick={() => go('q0')}>Get started free</div>
        <div style={{ fontSize: 'var(--t-13)', color: 'rgba(255,255,255,.8)', textAlign: 'center', marginTop: 12 }}>
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
    <Screen id="q0" steps={<Pg id="q0" />} back={() => go('landing')} scrollKey="q0"
            foot={<StepBtn on={own !== null} onNext={next} />}>
      {/* Семечко встречает человека на первом вопросе и больше в онбординге
          не появляется: по правилу канваса знак живёт там, где эмоция. */}
      <div className="h1 h1-seed" style={{ marginTop: 16 }}>
        Where are you<br />starting from?
        <i><SeedLine size={64} /></i>
      </div>
      <div className="greet" style={{ marginTop: 8 }}>
        Two very different jobs, so we ask different things.
      </div>
      {/* Развилка — единственный экран с крупными карточками: два пути стоят
          рядом целиком, с растением и глифом, а не строкой текста. */}
      <div style={{ marginTop: 16 }}>
        <Opt big label="I already have plants" sub="Get them on a care schedule"
             pic={cut(CUTS.house)} icon="potted-plant"
             on={own === true} onPick={() => setOwn(true)} />
        <Opt big label="I want to start growing" sub="Tell me what to plant and buy"
             pic={cut(CUTS.edible)} icon="trowel"
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
    <Screen id="qwhat" steps={<Pg id="qwhat" />} back={() => go('q0')} scrollKey="qwhat"
            foot={<StepBtn on={!!pick} onNext={next} />}>
      <div className="h1" style={{ marginTop: 16 }}>What are you growing?</div>
      <div className="greet">
        This decides the rest of the questions.
      </div>
      <div style={{ marginTop: 16 }}>
        <Opt label="Something to eat" sub="Radishes, greens, tomatoes in pots"
             pic={cut(CUTS.edible)}
             on={pick === 'Something to eat'} onPick={() => setPick('Something to eat')} />
        <Opt label="Houseplants" sub="Monstera, pothos, snake plant"
             pic={cut(CUTS.house)}
             on={pick === 'Houseplants'} onPick={() => setPick('Houseplants')} />
        <Opt label="Both" sub="Something edible, plants inside too"
             pic={cut(CUTS.both)}
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
  // «Outside» на каждой из шести плиток — шум: подпись нужна там, где вариант
  // выбивается. Помечаем меньшую сторону, и только если стороны вообще две.
  const out = opts.filter(([l]) => isOutdoorSpace(l)).length
  const odd = out === opts.length || out === 0 ? null : out * 2 > opts.length
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
    <Screen id="q1" steps={<Pg id="q1" />} back={() => go(s.onbMode === 'own' ? 'add-plant' : 'q0')} scrollKey="q1"
            foot={<StepBtn on={!!sel} onNext={next} />}>
      <div className="h1" style={{ marginTop: 16 }}>
        {s.choices.track === 'edible' ? 'Where will you grow?' : 'Where will it live?'}
      </div>
      {/* Две колонки: названия мест короткие. Вариант с пояснением шире —
          ему нужна строка целиком, и он единственный «внутри» среди уличных. */}
      <div className="optgrid">
        {opts.map(([label, sub, to]) => (
          <Opt key={label} label={label} sub={sub} wide={!!sub} on={sel?.[0] === label}
               icon={spaceIcon(label)}
               meta={odd !== null && isOutdoorSpace(label) !== odd
                     ? (isOutdoorSpace(label) ? 'Outside' : 'Inside') : undefined}
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
    <Screen id="q2" steps={<Pg id="q2" />} back={() => go('q1')} scrollKey="q2"
            foot={<StepBtn on={!!known} onNext={() => go('q3')} />}>
      <div className="h1" style={{ marginTop: 16 }}>What’s your ZIP?</div>
      <div className="greet" style={{ marginTop: 8 }}>
        Frost dates decide what can go outside, and when.
      </div>

      {/* Одно поле, а не пять: пять input-ов ломают вставку и автозаполнение
          индекса. Клетки — рисунок поверх, поле лежит прозрачным сверху.
          Тот же приём, что у кода из письма (Auth). */}
      <div className="ziplbl">ZIP code</div>
      <label className={'zipc' + (full && !known ? ' bad' : '')}>
        <input inputMode="numeric" autoComplete="postal-code" pattern="[0-9]*" maxLength={5}
               enterKeyHint="done" aria-label="Your ZIP code"
               value={val} onChange={e => type(e.target.value)} />
        <span className="zipc-cells" aria-hidden="true">
          {[0, 1, 2, 3, 4].map(i => (
            <i key={i} className={val.length === i ? 'on' : undefined}>{val[i] || ''}</i>
          ))}
        </span>
      </label>

      {known ? (
        <ZipCard z={known} />
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

/**
 * Климат найденного индекса. Всё на карточке считается из дат заморозков:
 * длина сезона, доли полосы года и её подпись — ни одно число не вписано.
 *
 * Сноска про станционные нормали стоит ТОЛЬКО у сверенных индексов. У Нью-Йорка
 * в справочнике checked:false — его станцию не сверяли, и подписывать его
 * нормалями NOAA значило бы соврать на экране (см. data/zips.ts).
 */
function ZipCard({ z }: { z: typeof ZIPS[number] }) {
  const { last, first } = frostDates(z.zip)
  const JAN = new Date(2026, 0, 1)
  const doy = (d: Date) => Math.round((+d - +JAN) / 86400000)
  const a = doy(last)                 // зима до последних заморозков
  const b = doy(first) - a            // сезон
  const c = 365 - a - b               // зима после первых
  return (
    <div className="zcard">
      <div className="zc-top">
        <span className="zc-pin"><Icon name="map-pin" color="var(--primary)" size={22} /></span>
        <span className="zc-nm"><b>{z.city}</b><s>Zone {z.zone}</s></span>
        <span className="pill b-lime">
          <Icon name="check-circle" color="var(--ink)" size={14} />Matched
        </span>
      </div>
      <div className="zc-stats">
        <div><s>Last frost</s><b>{z.last}</b></div>
        <div><s>First frost</s><b>{z.first}</b></div>
        <div><s>Season</s><b>{seasonDays(z.zip)} <u>days</u></b></div>
      </div>
      <div className="zc-year">
        <div className="zc-bar" role="img"
             aria-label={`Frost until ${z.last}, growing season to ${z.first}`}
             style={{ gridTemplateColumns: `${a}fr ${b}fr ${c}fr` }}>
          <span /><span /><span />
        </div>
        <div className="zc-leg"><span>Jan</span><b>{z.last} → {z.first}</b><span>Dec</span></div>
      </div>
      <p className="zc-note">
        <Icon name="seal-check" color={z.checked ? 'var(--primary)' : 'var(--muted)'} size={16} />
        {z.checked
          ? 'Station dates · NOAA normals 1991–2020'
          : 'Dates inherited, not yet checked against a station'}
      </p>
    </div>
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
/** Растение в колодце подобрано под свет: алоэ на юг, кинза на восток-запад,
    листья замиокулькаса на север. У «не знаю» растения нет — там глиф. */
const IN_CUT: Record<string, string> = {
  'South window': CUTS.south, 'East or West': CUTS.eastwest, 'North window': CUTS.north,
}

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
    <Screen id="q3" steps={<Pg id="q3" />} back={() => go('q2')} scrollKey="q3"
            foot={<StepBtn on={!!sel} onNext={() => sel && sun(sel, false)} />}>
      <div className="h1" style={{ marginTop: 16 }}>How much direct sun<br />does that spot get?</div>
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
    <Screen id="q2i" steps={<Pg id="q2i" />} back={() => go('q1')} scrollKey="q2i"
            foot={<StepBtn on={!!sel} onNext={() => sel && sun(sel, true)} />}>
      <div className="h1" style={{ marginTop: 16 }}>How bright is<br />that spot?</div>
      <div style={{ marginTop: 16 }}>
        {SUN_IN.map(([l, sub]) => (
          <Opt key={l} small label={l} sub={sub} on={sel === l} onPick={() => setSel(l)}
               pic={IN_CUT[l] ? cut(IN_CUT[l]) : undefined}
               wellIcon={IN_CUT[l] ? undefined : 'question'} />
        ))}
      </div>
      {/* Приписка, а не карточка: это замечание к списку, и в канвасе оно
          идёт обычной строкой под ним. Карточка равняла его с вариантами. */}
      <p className="optnote">
        Got a grow light? <b>Tell us</b> — it upgrades your options.
      </p>
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
    <Screen id="q4" steps={<Pg id="q4" />} back={() => go(s.choices.outdoor ? 'q3' : 'q2i')} scrollKey="q4"
            foot={<>
              <div style={{ fontSize: 'var(--t-13)', color: 'var(--muted)', marginBottom: 8,
                            textAlign: 'center' }}>
                {picked.length ? `${picked.length} of 3 picked.` : 'Pick at least one.'}
              </div>
              <StepBtn on={!!picked.length} onNext={() => go('q5')} />
            </>}>
      <div className="h1" style={{ marginTop: 16 }}>{Q4TITLE[s.choices.track] || Q4TITLE.both}</div>
      {/* Счёт выбранного — часть вопроса, поэтому тем же весом, что заголовок
          подводки, а не вполсилы: по нему решают, можно ли взять ещё. */}
      <div className="greet strong" style={{ marginTop: 8 }}>
        Up to 3 · {picked.length ? `${picked.length} selected` : 'nothing selected yet'}
      </div>
      <div className="optgrid">
        {opts.map(([label, tag]) => {
          const on = picked.indexOf(tag) > -1
          // лишние гаснут, а не исчезают
          return <Opt key={tag} chip label={label} multi on={on} dim={full && !on}
                      icon={goalIcon(tag)} onPick={() => toggle(label)} />
        })}
      </div>
    </Screen>
  )
}

// ─────────────────────────────────────────── Q5: время в неделю
/** Ряд горшков: столько растений даст план этого варианта. */
function Pots({ n }: { n: number }) {
  return (
    <span className="pots" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <span key={i}><Icon name="potted-plant" size={18} /></span>
      ))}
    </span>
  )
}

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
    <Screen id="q5" steps={<Pg id="q5" />} back={() => go('q4')} scrollKey="q5"
            foot={<StepBtn on={sel !== null} onNext={next} />}>
      <div className="h1" style={{ marginTop: 16 }}>How much time can<br />you give it?</div>
      {/* Размер плана виден горшками, а не только числом в строке: три, четыре
          и «до шести» — ряд из стольких же глифов. Шесть горшков в ряд не
          влезают и читались бы как точный счёт, поэтому там плашка. */}
      <div style={{ marginTop: 16 }}>
        <Opt label="About 10 minutes" sub="Keep it very simple · 3 plants"
             meta={<Pots n={3} />} on={sel === 3} onPick={() => setSel(3)} />
        <Opt label="About 20 minutes" sub="I can do a bit more · 4 plants"
             meta={<Pots n={4} />} on={sel === 4} onPick={() => setSel(4)} />
        <Opt label="30+ minutes" sub={`I want ${many} · up to 6 plants`}
             meta={<span className="pill b-meta">up to 6</span>}
             on={sel === 6} onPick={() => setSel(6)} />
      </div>
    </Screen>
  )
}
