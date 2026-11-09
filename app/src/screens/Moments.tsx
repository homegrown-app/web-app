// Экраны-моменты: milestone, recap, week complete, shopping, paywall.
// Все цифры и формулировки берутся из настоящих растений, а не захардкожены —
// один экран, две ветки: съедобное считается в сборах, комнатное в поливах.

import { Screen } from '../components/Chrome'
import { Task, useCamera } from '../components/parts'
import { photoStyle } from '../components/bits'
import { Icon } from '../icons/Icon'
import { bg, img } from '../lib/assets'
import { FEATS, POTPRICE } from '../data/onboarding'
import { SPECIES } from '../data/species'
import {
  allPhotos, careStats, fmtPot, hPct, isEdible, lc, wDue,
  weekTasks, phUrl,
} from '../lib/plants'
import { buildPlan, cap, inDays, inOn, listNames } from '../lib/plan'
import { zipInfo } from '../lib/season'
import { useStore } from '../state/store'
import { usePlanCtx } from './Preview'

type Go = (id: string) => void

const Close = ({ onClick }: { onClick: () => void }) => (
  <div className="xbtn" role="button" tabIndex={0} aria-label="Close"
       style={{ alignSelf: 'flex-end' }} onClick={onClick}>
    <Icon name="x" color="rgba(255,255,255,.8)" size={20} sw={2} />
  </div>
)

// ─────────────────────────────────────────── Milestone
export function HarvestScreen({ go }: { go: Go }) {
  const { s, d } = useStore()
  const cam = useCamera(url => d({ t: 'addPhoto', v: { i: s.selected, url } }))
  const ready = s.plants.filter(p => isEdible(p) && hPct(p) >= 100)[0]
  const p = ready || s.plants.slice().sort((a, b) => b.day - a.day)[0]

  if (!p) {
    return (
      <div className="screen on" id="s-harvest">
        <div className="dark" style={{ padding: 0 }}>
          <div className="mile-tx">
            <span className="pill b-lime">Nothing yet</span>
            <div className="cap-f mile-h">Add a plant<br />and this fills up.</div>
            <div className="mile-s">Every first — a new leaf, a first pick — lands here.</div>
            <div className="btn b-lime" role="button" tabIndex={0}
                 onClick={() => go('add-plant')}>Add a plant</div>
          </div>
        </div>
      </div>
    )
  }

  const pic = p.photos[0] ? phUrl(p.photos[0]) : (p.s.img ? img(p.s.img) : null)
  const edible = isEdible(p) && hPct(p) >= 100
  const st = careStats(s.plants)

  return (
    <div className="screen on" id="s-harvest">
      <div className="dark" style={{ padding: 0 }}>
        {cam.input}
        {pic
          ? <div className="shot" style={{ backgroundImage: `url(${pic})`, height: '58%' }} />
          : <div className="shot" style={{ height: '58%', ...photoStyle(p.s) }} />}
        <div className="scrim mile-scrim" />
        <div className="mile-ov">
          <Close onClick={() => go('home')} />
          <div style={{ flex: 1 }} />
          <span className="pill b-lime" style={{ alignSelf: 'flex-start' }}>
            {edible ? `Day ${p.day}` : p.s.name}
          </span>
          <div className="cap-f mile-h">{edible ? 'First harvest.' : 'It is thriving.'}</div>
          <div className="mile-s">
            {edible
              ? `You grew this ${inOn(s.choices.outdoor)}${s.choices.space}. ${p.s.name} `
                + 'is ready — pick it and it keeps producing.'
              : `${p.s.name} has been with you ${p.day} days and ${st.waterings} waterings. `
                + 'That is the whole trick: showing up.'}
          </div>
          <div className="btn b-lime" role="button" tabIndex={0} onClick={cam.open}>Add a photo</div>
          <div className="btn" style={{ background: 'rgba(255,255,255,.14)', color: '#fff' }}
               role="button" tabIndex={0} onClick={() => go('home')}>Back to my plants</div>
        </div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────── Recap
export function SeasonEndScreen({ go }: { go: Go }) {
  const { s } = useStore()
  const st = careStats(s.plants)
  // На уличном треке итог в сборах; для комнатных сезон не кончается никогда,
  // поэтому итог считается в поливах, растениях и снимках.
  const outdoor = s.choices.outdoor && st.edible > 0
  const pic = allPhotos(s.plants)[0]
  const names = s.plants.map(p => p.s.name)

  return (
    <div className="screen on" id="s-season-end">
      <div className="dark">
        <div className="glow" />
        <Close onClick={() => go('home')} />
        <div className="recap-in">
          {pic
            ? <div className="recap-ph" style={{ backgroundImage: `url(${phUrl(pic)})` }} />
            : <div className="recap-ph"
                   style={photoStyle(s.plants[0] ? s.plants[0].s : SPECIES[0])} />}
          <span className="pill b-lime" style={{ alignSelf: 'flex-start', marginTop: 16 }}>
            {outdoor ? `Season 2026 · ${zipInfo(s.choices.zip).city}`
                     : 'Your year · year-round'}
          </span>
          <div className="cap-f recap-h">
            {outdoor
              ? <>{st.ready} {st.ready === 1 ? 'harvest.' : 'harvests.'}<br />{st.oldest} days.</>
              : <>{st.waterings} waterings.<br />{st.plants} {st.plants === 1 ? 'plant.' : 'plants.'}</>}
          </div>
          <div className="recap-s">
            {outdoor
              ? `${listNames(names) || 'Nothing yet'} all made it to the table. `
                + 'Next season starts in the fall window.'
              : `${listNames(names) || 'Nothing yet'} are all still alive — that is the whole `
                + `scoreboard. ${st.photos} ${st.photos === 1 ? 'photo shows' : 'photos show'} `
                + 'how they changed.'}
          </div>
        </div>
        <div className="btn b-lime" role="button" tabIndex={0} onClick={() => go('season')}>
          {outdoor ? 'Plan next season now' : 'Keep the whole calendar'}
        </div>
        <div className="tlink" role="button" tabIndex={0} onClick={() => go('home')}>Download recap</div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────── Week complete
export function WeekDoneScreen({ go }: { go: Go }) {
  const { s } = useStore()
  const st = careStats(s.plants)
  const tasks = weekTasks(s.plants, s.care).length
  const nextP = s.plants.slice().sort((a, b) => wDue(a) - wDue(b))[0]
  const line = nextP
    ? (isEdible(nextP) && hPct(nextP) < 100
        ? `Your ${lc(nextP.s.name)} is ${nextP.s.days - nextP.day} days out.`
        : `${cap(lc(nextP.s.name))} needs water ${inDays(wDue(nextP))}.`)
    : 'Add a plant and next week fills itself in.'

  return (
    <div className="screen on" id="s-week-done">
      <div className="dark">
        <div className="glow" />
        <Close onClick={() => go('home')} />
        <div className="recap-in">
          <div className="recap-ph" style={{ backgroundImage: bg('hero-plants') }} />
          <span className="pill b-lime" style={{ alignSelf: 'flex-start', marginTop: 16 }}>
            Week complete
          </span>
          <div className="done-h">Everything<br /><span style={{ color: 'var(--lime)' }}>on time.</span></div>
          <div className="recap-s">
            {line} The calendar maps every week ahead so you never wonder what’s next.
          </div>
          <div className="sg2">
            <div className="stat"><b style={{ color: 'var(--lime)' }}>{st.waterings}</b>
              <s>waterings logged</s></div>
            <div className="stat"><b>{tasks}/{tasks}</b><s>tasks this week</s></div>
          </div>
        </div>
        <div className="btn b-lime" role="button" tabIndex={0} onClick={() => go('calendar')}>
          See the whole calendar
        </div>
        <div className="tlink" role="button" tabIndex={0} onClick={() => go('home')}>Not now</div>
      </div>
    </div>
  )
}

// ─────────────────────────────────────────── Shopping list
export function ShoppingScreen({ go }: { go: Go }) {
  const { s } = useStore()
  const c = usePlanCtx()
  // Собирается ИЗ ПЛАНА, сумма считается, а не написана.
  const plan = s.plants.length ? s.plants.map(p => p.s) : buildPlan(c)
  const edible = plan.filter(x => x.kind === 'edible')

  const pots: Record<string, number> = {}
  plan.forEach(x => { const k = x.pot || 'pot'; pots[k] = (pots[k] || 0) + 1 })
  const items: Array<[string, number, string]> = []
  Object.keys(pots).forEach(k => {
    const who = plan.filter(x => (x.pot || 'pot') === k).map(x => lc(x.name))
    items.push([
      (k === 'tray' ? 'Seed tray' : `Pot — ${fmtPot(k, s.units)}`)
        + (pots[k] > 1 ? ` ×${pots[k]}` : ''),
      (POTPRICE[k] || 8) * pots[k],
      `For ${listNames(who)}.`,
    ])
  })
  items.push([`Saucers ×${plan.length}`, 2 * plan.length, 'Keeps water off the floor.'])
  items.push(['Potting mix, 1 cu ft', 12, 'Not garden soil — too much clay for a pot.'])
  items.push(['Watering can, 1 gal', 11, ''])
  items.push(['Liquid fertilizer', 9, 'Container soil runs out in about six weeks.'])
  // строка семян только если в плане есть съедобное
  if (edible.length) items.push([
    `Seed — ${edible.map(x => lc(x.name)).join(', ')}`, 3 * edible.length, '',
  ])
  const total = items.reduce((a, x) => a + x[1], 0)
  const gear = items.slice(0, items.length - (edible.length ? 1 : 0))

  return (
    <Screen id="shopping" back={() => go('home')} nav={{ active: 'Week', go }}
            scrollKey="shopping">
      <div className="h1" style={{ marginTop: 16 }}>Shopping list</div>
      <div className="greet">
        Everything for {plan.length} {plan.length === 1 ? 'plant' : 'plants'} · about ${total}
      </div>
      {/* Две группы: горшки с грунтом и семена. Каждая — одна карточка со
          строками, как в канвасе: это один список, а не стопка дел. */}
      <div className="sl">Pots and soil</div>
      <div className="tasks">
        {gear.map((x, i) => <Task key={i} t={[x[0], `~$${x[1]}`, x[2]]} />)}
      </div>
      {edible.length > 0 && <>
        <div className="sl">Seed</div>
        <div className="tasks">
          <Task t={[items[items.length - 1][0], `~$${items[items.length - 1][1]}`, '']} />
        </div>
      </>}
      {/* Печать средствами браузера: @media print в app.css прячет хром
          и печатает один список. Отдельного экспортёра в приложении нет. */}
      <div className="btn b-white" role="button" tabIndex={0} onClick={() => window.print()}>
        <Icon name="file-pdf" color="currentColor" size={20} sw={2} /> Printable PDF
      </div>
    </Screen>
  )
}

// ─────────────────────────────────────────── Paywall
const YEAR = 29
const MONTH = 4

export function PaywallScreen({ go }: { go: Go }) {
  const { s, d } = useStore()
  const yearly = s.pickKey !== 'pw-monthly'   // сегмент живёт локально в pickKey

  const buy = () => {
    // Срок считаем от НАСТОЯЩЕЙ даты, а не от условного «сегодня» прототипа
    // (season.ts: START + TODAY = 10 апреля 2026): подписка живёт в календаре
    // человека, а не в симуляции сада. Это единственное место, где срок
    // появляется, — поэтому он настоящий, а не вписанный руками.
    const until = new Date()
    if (yearly) until.setFullYear(until.getFullYear() + 1)
    else until.setMonth(until.getMonth() + 1)
    d({ t: 'pro', v: true, plan: yearly ? 'year' : 'month', until: until.toISOString() })
    d({ t: 'toast', v: { html: '<span>Pro unlocked — the whole calendar is open</span>',
                         ms: 5000, at: Date.now(), unpro: true } })
    // Кнопки обещают «весь календарь» — ведём В КАЛЕНДАРЬ. Раньше комментарий
    // говорил именно это, а код уводил на week-lock: то есть после покупки
    // человек попадал на экран, вся суть которого — тизер пейволла.
    // Исключения: лимит растений обещал библиотеку; без растений календарь
    // показывать нечем, и тогда нужен home с его приглашением добавить растение
    // (раньше здесь стоял s.pwFrom, и при pwFrom='paywall' покупка возвращала
    // на сам пейволл — тупик).
    go(s.pwFrom === 'add-plant' ? 'add-plant' : !s.plants.length ? 'home' : 'calendar')
  }

  return (
    <div className="screen on" id="s-paywall">
      <div className="pw">
        <div className="pw-hd">
          <div className="wm"><Icon name="sprout" color="var(--ink)" size={22} sw={2} />Homegrown</div>
          {/* Крестика нет: вход в приложение идёт через этот экран.
              Вернувшемуся человеку нужен не выход, а восстановление покупки. */}
          <div className="tlink2" style={{ margin: 0, padding: '12px 8px' }}
               role="button" tabIndex={0} onClick={() => go('signin')}>Restore</div>
        </div>

        <div className="bd">
          <div className="pw-top">
            <h1 className="pw-h">Every plant,<br />planned all year</h1>
            <p className="pw-lead">Built for your ZIP. Cancel anytime.</p>
          </div>

          <div className="pw-feats">
            {FEATS.map(([t, sub]) => (
              <div key={t} className="pw-f">
                <span className="pw-fi"><Icon name="check" color="var(--primary)" size={20} sw={2.4} /></span>
                <span><b>{t}</b><s>{sub}</s></span>
              </div>
            ))}
          </div>

          {/* Два тарифа карточками, а не переключателем: экономия видна цифрой,
              а не выводится в уме из двух цен на разных вкладках. */}
          <div className="pw-plans" role="radiogroup" aria-label="Billing period">
            <div className={'pw-p' + (yearly ? ' on' : '')} role="radio" tabIndex={0}
                 aria-checked={yearly} onClick={() => d({ t: 'pickKey', v: 'pw-yearly' })}
                 onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') {
                   e.preventDefault(); d({ t: 'pickKey', v: 'pw-yearly' }) } }}>
              <span className="pw-pt"><b>Year pass</b><s>${YEAR} billed once a year</s></span>
              <span className="pw-pp"><b>${(YEAR / 12).toFixed(2)}</b><s>per month</s></span>
              <span className="pill b-lime pw-best">Save ${MONTH * 12 - YEAR} a year</span>
            </div>
            <div className={'pw-p' + (yearly ? '' : ' on')} role="radio" tabIndex={0}
                 aria-checked={!yearly} onClick={() => d({ t: 'pickKey', v: 'pw-monthly' })}
                 onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') {
                   e.preventDefault(); d({ t: 'pickKey', v: 'pw-monthly' }) } }}>
              <span className="pw-pt"><b>Monthly</b><s>Billed every month</s></span>
              <span className="pw-pp"><b>${MONTH}</b><s>per month</s></span>
            </div>
          </div>
        </div>

        <div className="foot">
          <div className="btn b-pri" role="button" tabIndex={0} onClick={buy}>
            {yearly ? `Continue — $${YEAR} / year` : `Continue — $${MONTH} / month`}
          </div>
          <div className="pw-note">Your plants and photos stay yours.</div>
        </div>
      </div>
    </div>
  )
}
