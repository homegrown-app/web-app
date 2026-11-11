// Разрешение на напоминания.
//
// Само окно «Homegrown would like to send you notifications» рисует не
// приложение, а браузер или система — в канвасе это подписано прямо на
// артборде (onb-15b). Наше дело: спросить в понятный момент, показать до
// окна, о чём речь, и честно сказать, когда просить нельзя.
//
// Нельзя — это обычная вкладка Safari на айфоне: там `Notification` просто
// нет, разрешение умеет запросить только приложение, добавленное на домашний
// экран. Пока экрана не было, нажимать было не на что, и окно не приходило
// ни на телефоне, ни на ноутбуке.

import { useState } from 'react'
import { Screen } from '../components/Chrome'
import { Seed, SeedAsk } from '../icons/Icon'
import { REMIND_AT } from '../data/onboarding'
import { appIcon } from '../lib/assets'
import { useStore } from '../state/store'

type Go = (id: string) => void

/** Четвёртое состояние — «спросить нельзя»: API в этом браузере нет. */
type Perm = 'unsupported' | 'default' | 'granted' | 'denied'

const readPerm = (): Perm =>
  typeof window === 'undefined' || !('Notification' in window)
    ? 'unsupported'
    : (Notification.permission as Perm)

/**
 * Показать уведомление. В установленном PWA конструктор `new Notification`
 * запрещён — там показывает только сервис-воркер, поэтому сначала он.
 *
 * Молча глотаем отказ: это показательное уведомление, и если оно не вышло,
 * разрешение всё равно получено, а человека нельзя оставлять на экране,
 * с которого он уже ушёл бы дальше.
 */
async function show(title: string, body: string) {
  try {
    const reg = await navigator.serviceWorker?.getRegistration()
    if (reg) {
      await reg.showNotification(title, { body, icon: appIcon(), badge: appIcon(), tag: 'hg-test' })
      return
    }
    new Notification(title, { body, icon: appIcon() })
  } catch { /* показать не вышло — не повод ломать переход */ }
}

/** Образец уведомления: так оно выглядит на телефоне. */
function Banner({ when, text }: { when: string; text: string }) {
  return (
    <div className="nf-ban">
      <span className="ic"><Seed size={28} /></span>
      <span className="tx">
        <span className="ln"><b>Homegrown</b><u>{when}</u></span>
        <span className="bd2">{text}</span>
      </span>
    </div>
  )
}

export function NotifScreen({ go }: { go: Go }) {
  const { s } = useStore()
  const [perm, setPerm] = useState<Perm>(readPerm)
  const at = REMIND_AT[s.remind]
  const next = () => go(s.nfFrom || 'home')

  const ask = async () => {
    const r = await Notification.requestPermission()
    setPerm(r as Perm)
    if (r === 'granted') {
      await show('Homegrown', `Reminders are on. One a day at ${at}, only when a plant needs you.`)
      next()
    }
  }

  return (
    <Screen id="notif" scrollKey="notif"
            foot={
              <>
                {perm === 'default' && (
                  <div className="btn b-pri" role="button" tabIndex={0} onClick={ask}
                       onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ask() } }}>
                    Turn on reminders
                  </div>
                )}
                {perm === 'granted' && (
                  <div className="btn b-pri" role="button" tabIndex={0}
                       onClick={() => show('Homegrown', 'Basil wants a drink · 1 min')}
                       onKeyDown={e => {
                         if (e.key === 'Enter' || e.key === ' ') {
                           e.preventDefault(); show('Homegrown', 'Basil wants a drink · 1 min')
                         }
                       }}>
                    Send a test reminder
                  </div>
                )}
                <div className="tlink" role="button" tabIndex={0} onClick={next}
                     onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); next() } }}>
                  {perm === 'default' ? 'Not now' : 'Continue'}
                </div>
              </>
            }>
      <div className="nf">
        <span className="nf-mark"><SeedAsk size={88} /></span>
        <h1 className="h1">Want a nudge on watering days?</h1>
        <p className="lead">
          One reminder at {at}, only when a plant needs you. No streaks, no nagging.
        </p>
      </div>

      <div className="nf-bans">
        <Banner when={at} text="Basil wants a drink · 1 min" />
        <div className="nf-dim"><Banner when="Sat" text="The radish is ready to pick" /></div>
      </div>
      <p className="nf-note">Sample copy</p>

      {/* Обещание «одно напоминание в 18:00» этой сборке пока нечем выполнить:
          рассылки нет, см. supabase/README.md. Экран говорит это сам — так же,
          как экран кода говорит, что письма не уходят. */}
      {perm === 'default' && (
        <div className="note nf-why">
          <b>No sender behind it yet</b>
          <p>Allowing shows one notification right away, so you can see how it looks.
            The daily reminder needs a server, and this build has none.</p>
        </div>
      )}
      {perm === 'granted' && (
        <div className="note nf-why">
          <b>Reminders are on</b>
          <p>Change the time in Settings → Reminders.</p>
        </div>
      )}
      {perm === 'denied' && (
        <div className="note nf-why">
          <b>Notifications are blocked</b>
          <p>The browser will not ask again. Allow them for this site in its settings,
            then come back here.</p>
        </div>
      )}
      {perm === 'unsupported' && (
        <div className="note nf-why">
          <b>Add Homegrown to the Home Screen first</b>
          <p>On iPhone reminders work only in an installed app: open the share menu
            in Safari, choose “Add to Home Screen”, and open Homegrown from there.</p>
        </div>
      )}
    </Screen>
  )
}
