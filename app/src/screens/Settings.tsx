// Settings и экран выбора значения.
//
// Экран собирается из состояния целиком, и КАЖДАЯ строка что-то меняет.
// Значения не циклятся по тапу: строка открывает раздел со списком, где видно
// все варианты и что выбрано сейчас. У каждого варианта есть следствие.

import { AccountRow } from './Auth'
import { Screen } from '../components/Chrome'
import { PickRow, SetRow, SwRow } from '../components/parts'
import { bg, buildId } from '../lib/assets'
import {
  LIGHT_IN, LIGHT_OUT, LIGHT_RANK_IN, LIGHT_RANK_OUT, PICKS, REMIND_AT,
  SPACE_OPTS, TRACKWORD, isOutdoorSpace,
} from '../data/onboarding'
import { ZIPS } from '../data/zips'
import { isEdible } from '../lib/plants'
import { NO_AUTH } from '../lib/demo'
import { cap } from '../lib/plan'
import { MON, seasonDays, zipInfo } from '../lib/season'
import { useStore, type Units } from '../state/store'

type Go = (id: string) => void

export function SettingsScreen({ go }: { go: Go }) {
  const { s, d } = useStore()
  const c = s.choices
  const mins = c.effort === 3 ? 10 : c.effort === 4 ? 20 : 30
  const hasEdible = s.plants.some(isEdible)
  const openPick = (k: string) => { d({ t: 'pickKey', v: k }); go('pick') }
  const pic = s.plants.length && s.plants[0].s.img ? s.plants[0].s.img : 'hero-plants'

  // Срок Pro. Даты НЕТ, если Pro включили сборкой, которая её не писала, или
  // чипом в /review — тогда молчим, а не выдумываем: биллинга в приложении нет,
  // и придумать дату продления было бы ровно тем, чего делать нельзя.
  const until = s.isPro && s.proUntil ? new Date(s.proUntil) : null
  const termDate = until && !isNaN(until.getTime())
    ? `${MON[until.getMonth()]} ${until.getDate()}, ${until.getFullYear()}`
    : null
  const ended = !!until && until.getTime() < Date.now()
  const planWord = s.proPlan === 'year' ? 'Year pass'
                 : s.proPlan === 'month' ? 'Monthly' : null

  return (
    <Screen id="settings" title="Settings" back={() => go('home')} nav={{ active: 'Settings', go }} scrollKey="settings">
      <div className="h1" style={{ marginTop: 16 }}>Settings</div>

      {/* Кто вошёл — выше тарифа: это ответ на «мой ли это аккаунт». */}
      <AccountRow go={go} />

      <div className="acc" style={{ marginTop: 16 }}>
        <div className="acc-photo" style={{ backgroundImage: bg(pic) }} />
        <div className="row1">
          <span className="tag">
            {!s.isPro ? 'Free plan' : planWord ? `Pro · ${planWord.toLowerCase()}` : 'Pro · full plan'}
          </span>
        </div>
        {s.isPro ? <>
          <div className="big" style={{ fontSize: 'var(--t-24)', marginTop: 12 }}>
            Everything is open
          </div>
          {/* Срок настоящий: записан в момент покупки на пейволле из системной
              даты (Moments.tsx). Если его нет — строки про дату тоже нет.
              «Renews» здесь не пишем: продлевать некому, биллинга не существует;
              честное слово — до какого числа доступ открыт. */}
          <div className="sub">
            Every week planned, unlimited plants and photos.
            {termDate && (ended
              ? ` The ${planWord ? planWord.toLowerCase() : 'plan'} ran to ${termDate}.`
              : ` Open until ${termDate}.`)}
          </div>
          {/* Кнопка «Back to Free (demo)» убрана: у человека с активным Pro ей
              нечего делать среди фактов о подписке. Для проверки Pro-ветки
              остался чип Pro в каталоге /review. */}
        </> : <>
          <div className="big" style={{ fontSize: 'var(--t-24)', marginTop: 12 }}>
            {NO_AUTH ? '1 space' : '1 space · 3 plants'}<br />this week only
          </div>
          <div className="sub">
            Pro opens every week ahead, the whole library and unlimited photos.
          </div>
          <div className="btn b-lime" role="button" tabIndex={0} onClick={() => go('paywall')}>
            Compare with Pro
          </div>
        </>}
      </div>

      {/* Growing здесь нет: чем ты занимаешься, выбирается один раз в онбординге. */}
      <div className="sl">Your setup</div>
      <div className="plist">
        <SetRow label="Space" value={c.space} onOpen={() => openPick('space')} />
        {c.outdoor && (
          <SetRow label="ZIP" value={`${zipInfo(c.zip).zip} · ${zipInfo(c.zip).city}`}
                  onOpen={() => openPick('zip')} />
        )}
        <SetRow label="Light" value={c.sun} onOpen={() => openPick('light')} />
        <SetRow label="Time per week" value={`${mins} minutes`} onOpen={() => openPick('effort')} />
        <SetRow label="Units"
                value={s.units === 'metric' ? 'Metric · cm, litres' : 'Imperial · inches, gallons'}
                onOpen={() => openPick('units')} />
      </div>
      <div className="setnote">
        You picked {TRACKWORD[c.track].toLowerCase()} when you set up your plan.
        That one stays put.
      </div>

      <div className="sl">What goes on the week card</div>
      <div className="plist">
        <div className="pl">
          <div className="nm"><b>Watering</b><s>Always on — it is what keeps them alive</s></div>
          <span className="setval">Always</span>
        </div>
        {hasEdible && (
          <SwRow label="Harvest reminders" on={s.care.pick} sub="When something is ready to pick"
                 onToggle={() => d({ t: 'care', v: 'pick' })} />
        )}
        <SwRow label="Leaf care" on={s.care.leaf} sub="Wiping dust off the big leaves"
               onToggle={() => d({ t: 'care', v: 'leaf' })} />
        <SwRow label="Rotating" on={s.care.rotate} sub="A quarter turn so growth stays even"
               onToggle={() => d({ t: 'care', v: 'rotate' })} />
        <SwRow label="Feeding" on={s.care.feed} sub="Once a month while they are growing"
               onToggle={() => d({ t: 'care', v: 'feed' })} />
      </div>

      <div className="sl">Reminders</div>
      <div className="plist">
        <SetRow label="Remind me at" value={REMIND_AT[s.remind]} onOpen={() => openPick('remind')} />
        <SwRow label="Weekly task email" on={s.mail.weekly} onToggle={() => d({ t: 'mail', v: 'weekly' })} />
        <SwRow label="Watering reminders" on={s.mail.water} onToggle={() => d({ t: 'mail', v: 'water' })} />
        <SwRow label="Product updates" on={s.mail.news} onToggle={() => d({ t: 'mail', v: 'news' })} />
      </div>

      {/* Delete account и Sign out уехали на экран аккаунта: среди тумблеров
          необратимого не ждут, а строка аккаунта наверху туда и ведёт. */}

      {/* Номер сборки. Приложение открывают с телефона, с симулятора и с ноутбука,
          и отличить свежую страницу от страницы из кэша браузера было нечем. */}
      <div className="build">Build {buildId()}</div>
    </Screen>
  )
}

interface PickOpt { v: string | number; label: string; sub: string }

export function PickScreen({ go }: { go: Go }) {
  const { s, d, pool } = useStore()
  const c = s.choices
  const key = s.pickKey
  const meta = PICKS[key] || PICKS.space

  const opts: PickOpt[] = (() => {
    if (key === 'space') return (SPACE_OPTS[c.track] || SPACE_OPTS.both).map(v => ({
      v, label: cap(v), sub: isOutdoorSpace(cap(v)) ? 'Outside' : 'Indoors' }))
    if (key === 'zip') return ZIPS.map(z => ({
      v: z.zip, label: `${z.zip} · ${z.city}`,
      sub: `Zone ${z.zone} · frost ${z.last} – ${z.first} · ${seasonDays(z.zip)}-day season` }))
    if (key === 'light') {
      const L = c.outdoor ? LIGHT_OUT : LIGHT_IN
      const R = c.outdoor ? LIGHT_RANK_OUT : LIGHT_RANK_IN
      return L.map(v => ({ v, label: cap(v),
        sub: `Fits ${pool.filter(x => x.sun <= R[v]).length} of ${pool.length} plants` }))
    }
    if (key === 'effort') return [
      { v: 3, label: 'About 10 minutes', sub: '3 plants' },
      { v: 4, label: 'About 20 minutes', sub: '4 plants' },
      { v: 6, label: '30+ minutes', sub: 'up to 6 plants' }]
    if (key === 'units') return [
      { v: 'imperial', label: 'Imperial', sub: 'inches, gallons, pints' },
      { v: 'metric', label: 'Metric', sub: 'centimetres, litres' }]
    if (key === 'remind') return REMIND_AT.map((t, i) => ({
      v: i, label: t, sub: i <= 1 ? 'Before the day starts' : i === 2 ? 'Midday' : 'After work' }))
    return []
  })()

  const cur = key === 'space' ? c.space : key === 'zip' ? c.zip : key === 'light' ? c.sun
    : key === 'effort' ? c.effort : key === 'units' ? s.units : s.remind

  const apply = (raw: string | number) => {
    if (key === 'space') {
      const outdoor = isOutdoorSpace(cap(String(raw)))
      const v: Partial<typeof c> = { space: String(raw), outdoor }
      // Свет живёт в двух разных доменах: часы солнца снаружи, сторона окна внутри.
      if (!outdoor && LIGHT_IN.indexOf(c.sun) < 0) {
        v.sun = LIGHT_IN[1]; v.sunRank = LIGHT_RANK_IN[LIGHT_IN[1]]
      }
      if (outdoor && LIGHT_OUT.indexOf(c.sun) < 0) {
        v.sun = LIGHT_OUT[1]; v.sunRank = LIGHT_RANK_OUT[LIGHT_OUT[1]]
      }
      d({ t: 'choices', v })
    } else if (key === 'zip') {
      d({ t: 'choices', v: { zip: String(raw) } })
      d({ t: 'toast', v: { html: `<span>Frost dates set for ${zipInfo(String(raw)).city}</span>`,
                           ms: 3500, at: Date.now() } })
    } else if (key === 'light') {
      const R = c.outdoor ? LIGHT_RANK_OUT : LIGHT_RANK_IN
      d({ t: 'choices', v: { sun: String(raw), sunRank: R[String(raw)] || 1 } })
      d({ t: 'toast', v: { html: `<span>The library now shows what fits ${raw}</span>`,
                           ms: 3500, at: Date.now() } })
    } else if (key === 'effort') d({ t: 'choices', v: { effort: +raw } })
    else if (key === 'units') d({ t: 'units', v: raw as Units })
    else if (key === 'remind') {
      d({ t: 'remind', v: +raw })
      d({ t: 'toast', v: { html: `<span>Reminders at ${REMIND_AT[+raw]}</span>`,
                           ms: 3500, at: Date.now() } })
    }
    go('settings')
  }

  return (
    <Screen id="pick" back={() => go('settings')} nav={{ active: 'Settings', go }}
            scrollKey={'pick' + key}>
      <div className="h1" style={{ marginTop: 16 }}>{meta.title}</div>
      <div style={{ fontSize: 'var(--t-14)', color: 'var(--muted)', marginTop: 4 }}>{meta.note}</div>
      <div style={{ marginTop: 16 }}>
        <div className="plist">
          {opts.map(o => (
            <PickRow key={String(o.v)} label={o.label} sub={o.sub}
                     on={String(o.v) === String(cur)} onPick={() => apply(o.v)} />
          ))}
        </div>
      </div>
    </Screen>
  )
}
