// Вход. Три способа: Google, Apple, почта с кодом.
//
// ВАЖНО, что здесь НЕ происходит: у прототипа нет бэкенда, поэтому письмо с
// кодом никто не отправляет и код не проверяется на сервере. Это написано на
// самом экране — притворяться авторизацией нельзя. Валидация адреса, состояния
// кнопок, таймер повторной отправки и ошибки — настоящие.
//
// Google — НАСТОЯЩИЙ: OAuth-клиент заведён, провайдер включён в проекте,
// вход идёт через Supabase (PKCE). Почта и Apple пока демонстрационные:
// письмо с кодом невозможно без своего SMTP (на встроенной почте Supabase
// шаблоны не редактируются и дефолтное письмо присылает ссылку, а не код), а
// Apple требует платного Apple Developer, Services ID и .p8-ключа.
// Как только появятся SMTP или ключи Apple — меняются только эти две ветки,
// экраны переделывать не придётся.

import { useEffect, useRef, useState } from 'react'
import { NO_AUTH } from '../lib/demo'
import { Screen } from '../components/Chrome'
import { ASSET_ROOT, bg } from '../lib/assets'
import { cap } from '../lib/plan'
import { Icon } from '../icons/Icon'
import {
  authError, authRedirect, authReturn, clearAuthError, clearAuthUrl, setAuthError,
  setAuthNext, supa, takeAuthNext, wasOnPurpose, type AuthErr,
} from '../lib/supabase'
import { useStore, type Account, type AuthVia } from '../state/store'

type Go = (id: string) => void

/** Официальный логотип Google (img/google-g.png, см. img/CREDITS.txt). */
const GOOGLE_LOGO = ASSET_ROOT + 'img/google-g.png'

/** Знак Apple — глиф U+F8FF из системного SF Pro Text, снят из шрифта, а не
    нарисован от руки. Брендовые кнопки требуют родной формы знака. */
const APPLE_MARK = 'M859 248C907 190 941 111 941 31C941 20 940 9 938 0C860 3 766 52 710 118C666 168 625 248 625 328C625 340 627 352 628 356C633 357 641 358 649 358C719 358 807 311 859 248ZM914 375C797 375 748 431 667 431C584 431 511 379 404 379C299 379 187 443 116 553C16 708 33 1000 196 1250C254 1341 332 1443 434 1444C525 1445 551 1386 675 1385C800 1384 823 1444 914 1444C1016 1443 1098 1331 1156 1240C1198 1174 1214 1141 1246 1067C1013 978 976 646 1206 519C1136 431 1037 375 914 375Z'

/**
 * Apple выключен, пока нет ключей. Раньше кнопка молча впускала в приложение
 * с придуманным адресом — это не вход, а обход входа. Кнопку, которая не
 * работает, не показываем вовсе: мёртвая кнопка хуже её отсутствия.
 * Появятся Services ID и .p8 — флаг в true, ветка ниже уже готова.
 */
const APPLE_READY = false

/**
 * Почта выключена по той же причине, по которой выключен Apple, и это следствие
 * правила «без входа приложение недоступно». Вход по почте здесь
 * демонстрационный: письма никто не отправляет, кода на сервере нет, и аккаунт
 * он выдаёт БЕЗ серверной сессии. Пока приложение открывалось и анонимно, такая
 * дверь была честной демонстрацией экранов. Теперь она вела бы человека прямо в
 * стену: он «вошёл», а приложение его не пускает. Мёртвая дверь хуже её
 * отсутствия — та же логика, что у APPLE_READY.
 *
 * Экраны email и code никуда не удалены и остаются в маршрутах: появится свой
 * SMTP — флаг в true, и ветка снова живая.
 */
const EMAIL_READY = false

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i
/** Код, которым в прототипе можно посмотреть состояние ошибки. */
const BAD_CODE = '000000'
// 60, а не 30: Supabase пускает новый код на один адрес раз в 60 секунд
// (docs → Auth → Rate limits). Таймер короче лимита обещал бы то, что сервер
// откажет, и «Resend code» отдавал бы ошибку.
const RESEND_S = 60
/** 00:59 — как в референсе: секунды подряд читаются хуже, чем часовой формат. */
const mmss = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

function AppleMark({ size = 17 }: { size?: number }) {
  return (
    <svg width={size * 0.813} height={size} viewBox="0 0 1261 1551" aria-hidden="true">
      <path d={APPLE_MARK} fill="currentColor" />
    </svg>
  )
}

/** Аккаунт из пользователя Supabase. Провайдер берём из app_metadata. */
function accountOf(u: { id?: string; email?: string | null
                        app_metadata?: { provider?: string } }): Account {
  const p = u.app_metadata?.provider
  const via: AuthVia = p === 'apple' ? 'apple' : p === 'email' ? 'email' : 'google'
  return { email: u.email || '', via, uid: u.id }
}

/**
 * Слова провайдера — человеку, а не только мне. «Unable to exchange external
 * code: 4/0A» — это правда, но правда для того, кто держит ключи: человек с
 * растениями не может с ней сделать ничего и видит только, что приложение
 * сломалось. И «попробуй ещё раз» тут была бы ЛОЖЬ — пока настройка на сервере
 * не поправлена, повтор упадёт так же. Поэтому у каждой причины свой хвост.
 *
 * Технический текст не выбрасываем: он уходит строкой ниже мелким серым, потому
 * что именно по нему настоящая причина и находится.
 */
function humanWhy(why: string): { say: string; tail: string; raw: string | null } {
  const safe = 'Your plants stay on this phone either way — nothing is lost.'
  if (/exchange external code/i.test(why)) {
    return {
      say: 'Google confirmed it was you, but our server could not finish the handshake',
      tail: 'That is a setting on our side, not anything you did, and trying again '
          + "won't move it. " + safe,
      raw: why,
    }
  }
  if (/came back to a different address/i.test(why)) {
    return {
      say: 'The sign-in started in one browser and came back in another, so the key '
         + 'that closes it was gone',
      tail: 'Starting over in this same browser usually works. ' + safe,
      raw: null,
    }
  }
  return { say: cap(why), tail: 'Signing in again is all it takes. ' + safe, raw: null }
}

/** Нота с причиной. Одна и та же в настройках и на экране входа. */
function WhyNote({ err, mt }: { err: AuthErr; mt: number }) {
  const h = humanWhy(err.why)
  return (
    <div className="note" style={{ marginTop: mt }}>
      <b>{err.kind === 'expired' ? 'You were signed out' : 'The last sign-in did not finish'}</b>
      <p>{h.say}. {h.tail}</p>
      {h.raw && (
        <p style={{ fontSize: 'var(--t-12)', color: 'var(--muted)',
                    marginTop: 'var(--sp-8)' }}>
          {h.raw}
        </p>
      )}
    </div>
  )
}

/**
 * Сессия Supabase → состояние приложения. Живёт в App, потому что после
 * возврата от провайдера надо ещё и увести на нужный экран.
 *
 * Отсутствие сессии НЕ гасит аккаунт: иначе демонстрационный вход (Apple,
 * почта) исчезал бы при каждой перезагрузке. Гасим только по настоящему
 * событию выхода.
 *
 * Провал возврата обязан быть ВИДИМЫМ. Раньше здесь был только успешный путь:
 * если провайдер вернул ошибку или обмен кода на сессию не удался (а он не
 * удаётся, когда круг начался на одном адресе, а вернулся на другой — PKCE-
 * верификатор лежит в localStorage того origin, где нажали кнопку), человек
 * возвращался и снова видел кнопку входа. Ни слова о том, что случилось, ни в
 * интерфейсе, ни в консоли.
 */
export function useAuthSession(go: Go) {
  const { d } = useStore()
  useEffect(() => {
    let alive = true
    let off: (() => void) | undefined
    // Читаем адрес ДО создания клиента: detectSessionInUrl вычистит из него код.
    const ret = authReturn()
    supa().then(sb => {
      if (!alive) return
      sb.auth.getSession().then(({ data }) => {
        if (!alive) return
        d({ t: 'session', v: data.session ? 'live' : 'none' })
        if (data.session) {
          clearAuthError()
          d({ t: 'signIn', v: accountOf(data.session.user) })
          // Уводим либо туда, куда собирались, либо на home — но ТОЛЬКО если это
          // возврат от провайдера. Иначе прямая ссылка на любой экран у вошедшего
          // человека молча превращалась бы в home.
          //
          // Ключ забираем ВСЕГДА, а слушаемся его только на возврате, и это не
          // придирка. Брошенная попытка входа (ушёл на Google и вернулся назад
          // кнопкой браузера) оставляет в hg.authNext слово «paywall» — и раньше
          // оно срабатывало на СЛЕДУЮЩЕМ обычном запуске: человек открывал
          // приложение и попадал на пейволл, ничего не нажимая. Отсюда «после
          // входа всегда подписка». Забранный ключ обезвреживает и старую мину.
          const next = takeAuthNext()
          if (ret.code) { go(next || 'home'); clearAuthUrl() }
          return
        }
        // Сессии нет. Если в адресе был код или ошибка — круг был и он провалился.
        if (!ret.code && !ret.error) return
        setAuthNext('')
        clearAuthUrl()
        const why = ret.error
          ? ret.error
          : 'the link came back to a different address than it started from'
        console.error('[auth] возврат без сессии:', why)
        setAuthError(why)
        d({ t: 'toast', v: { html: '<span>Sign-in did not finish — ' + why
          + '. Nothing was saved; try again.</span>', ms: 7000, at: Date.now() } })
      })
      const { data: sub } = sb.auth.onAuthStateChange((event, session) => {
        if (session) {
          clearAuthError()
          d({ t: 'session', v: 'live' })
          d({ t: 'signIn', v: accountOf(session.user) })
          return
        }
        if (event !== 'SIGNED_OUT') return
        // Умершая сессия гасит ДОСТУП, но не память о том, кто вошёл. Это две
        // разные вещи, и раньше они были склеены: account очищался вместе с
        // сессией. Из-за склейки льгота офлайна оставалась без опоры — библиотека
        // сносит сессию и когда токен не обновить из-за отсутствия связи, и
        // человек в саду без сети упирался бы в стену перед собственным списком
        // полива. Теперь доступ решает стена в App (живая сессия ЛИБО офлайн при
        // known аккаунте), а забыть аккаунт может только сам человек кнопкой
        // Sign out — там dispatch signOut стоит явно.
        d({ t: 'session', v: 'none' })
        // Сессия умерла сама: access-токен живёт час, и если обновить его не
        // удалось (нет сети, либо refresh-токен уже забрало другое устройство),
        // библиотека сносит сессию — а приложение молча гасило аккаунт. Человек
        // видел ровно то, на что и жаловался: он входил, а потом в настройках
        // опять «Sign in», и ни слова о том, что случилось.
        if (wasOnPurpose()) return
        if ('onLine' in navigator && !navigator.onLine) return   // офлайн объясняется сам
        const why = 'the session expired and could not be renewed'
        console.error('[auth] непрошеный выход:', why)
        setAuthError(why, 'expired')
        d({ t: 'toast', v: { html: '<span>Signed out — ' + why + '. Your plants are '
          + 'safe on this phone; sign in again to keep them syncing.</span>',
          ms: 7000, at: Date.now() } })
      })
      off = () => sub.subscription.unsubscribe()
    })
    return () => { alive = false; off?.() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

/** Список способов входа. Один и тот же на экране онбординга и на возврате. */
export function Providers({ go, from }: { go: Go; from: string }) {
  const { d } = useStore()

  // Настоящий вход. Браузер уходит на Google, возвращается уже с сессией —
  // поэтому экран, куда надо попасть после возврата, кладём в localStorage:
  // страница перезагружается целиком и состояние в памяти не доживает.
  const google = async () => {
    setAuthNext(from === 'save' ? 'paywall' : 'home')
    const sb = await supa()
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: authRedirect() },
    })
    // Сюда доходим только если увести на Google не удалось: обычно браузер уже
    // ушёл. Молчать нельзя — человек нажал и ничего не произошло.
    if (error) {
      setAuthNext('')
      d({ t: 'toast', v: { html: '<span>Google did not open — check the connection '
        + 'and try again</span>', ms: 4000, at: Date.now() } })
    }
  }

  const apple = async () => {
    setAuthNext(from === 'save' ? 'paywall' : 'home')
    const sb = await supa()
    const { error } = await sb.auth.signInWithOAuth({
      provider: 'apple',
      options: { redirectTo: authRedirect() },
    })
    if (error) {
      setAuthNext('')
      d({ t: 'toast', v: { html: '<span>Apple did not open — try Google or email</span>',
                           ms: 4000, at: Date.now() } })
    }
  }
  return (
    <>
      <div className="btn b-white prov" role="button" tabIndex={0}
           onClick={google}
           onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); google() } }}>
        <img className="prov-ic" src={GOOGLE_LOGO} alt="" width={18} height={18} />
        <span>Continue with Google</span>
      </div>
      {APPLE_READY && (
        <div className="btn prov b-dark" role="button" tabIndex={0}
             onClick={apple}
             onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); apple() } }}>
          <span className="prov-ic"><AppleMark /></span>
          <span>Continue with Apple</span>
        </div>
      )}
      {EMAIL_READY && (
        <div className="btn b-ghost" role="button" tabIndex={0}
             onClick={() => { d({ t: 'authFrom', v: from }); go('email') }}
             onKeyDown={e => {
               if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); d({ t: 'authFrom', v: from }); go('email') }
             }}>Continue with email</div>
      )}
      {(!APPLE_READY || !EMAIL_READY) && (
        <div className="prov-note">
          {!EMAIL_READY && !APPLE_READY
            ? 'Apple and email sign-in come next — both need keys of their own.'
            : !EMAIL_READY ? 'Email sign-in comes next — it needs its own mail server.'
            : 'Apple sign-in comes next — it needs its own developer keys.'}
        </div>
      )}
    </>
  )
}

// ─────────────────────────────────────────── Возврат: «уже есть аккаунт»
export function SignInScreen({ go }: { go: Go }) {
  // Причина прошлого провала. Читаем один раз на входе: она меняется только
  // после настоящей попытки, а та перезагружает страницу целиком.
  const [err] = useState(authError)
  return (
    <Screen id="signin" back={() => go('landing')} scrollKey="signin">
      <div className="h1" style={{ marginTop: 16 }}>Welcome back</div>
      <div style={{ fontSize: 'var(--t-14)', color: 'var(--muted)', marginTop: 4 }}>
        Your plants and their schedule are waiting.
      </div>
      {err && <WhyNote err={err} mt={16} />}
      <div style={{ marginTop: 16 }}><Providers go={go} from="signin" /></div>
      <div className="tlink2" role="button" tabIndex={0} style={{ marginTop: 16 }}
           onClick={() => go('q0')}>New here? Start free</div>
    </Screen>
  )
}

// ─────────────────────────────────────────── Почта
export function EmailScreen({ go }: { go: Go }) {
  const { s, d } = useStore()
  const [val, setVal] = useState(s.authEmail)
  const [err, setErr] = useState('')
  const ok = EMAIL_RE.test(val.trim())

  const send = () => {
    if (!ok) { setErr('That address looks off — check it once more.'); return }
    d({ t: 'authEmail', v: val.trim().toLowerCase() })
    go('code')
  }

  return (
    <Screen id="email" back={() => go(s.authFrom === 'save' ? 'save' : 'signin')} scrollKey="email"
            foot={
              <div className={'btn b-pri' + (ok ? '' : ' off')} role="button" tabIndex={0}
                   onClick={send}
                   onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); send() } }}>
                Send me a code
              </div>
            }>
      <div className="h1" style={{ marginTop: 16 }}>What’s your email?</div>
      <div style={{ fontSize: 'var(--t-14)', color: 'var(--muted)', marginTop: 4 }}>
        We send a 6-digit code. No password to remember.
      </div>

      <label className={'fld' + (err ? ' bad' : '')} style={{ marginTop: 16 }}>
        <span className="fld-l">Email</span>
        <input type="email" inputMode="email" autoComplete="email" autoCapitalize="off"
               autoCorrect="off" spellCheck={false} enterKeyHint="go" name="email"
               placeholder="you@email.com" value={val}
               onChange={e => { setVal(e.target.value); if (err) setErr('') }}
               onKeyDown={e => { if (e.key === 'Enter') send() }} />
      </label>
      {err && <div className="fld-err" role="alert">{err}</div>}

      <div className="note" style={{ marginTop: 16 }}>
        <b>This build does not send mail</b>
        <p>There is no server behind the prototype yet, so no code arrives. On the next
          screen any six digits sign you in — that is the demo, not the product.</p>
      </div>
    </Screen>
  )
}

// ─────────────────────────────────────────── Код
export function CodeScreen({ go }: { go: Go }) {
  const { s, d } = useStore()
  const [code, setCode] = useState('')
  const [err, setErr] = useState('')
  const [left, setLeft] = useState(RESEND_S)
  const box = useRef<HTMLInputElement>(null)

  // Таймер повторной отправки: секунду за секундой, без перерисовки экрана.
  useEffect(() => {
    if (left <= 0) return
    const t = window.setTimeout(() => setLeft(left - 1), 1000)
    return () => window.clearTimeout(t)
  }, [left])

  useEffect(() => { box.current?.focus() }, [])

  const full = code.length === 6
  const submit = (val = code) => {
    if (val.length !== 6) return
    if (val === BAD_CODE) {
      setErr('That code has expired. Ask for a new one.')
      setCode('')
      return
    }
    d({ t: 'signIn', v: { email: s.authEmail, via: 'email', demo: true } })
    go(s.authFrom === 'save' ? 'paywall' : 'home')
  }

  // Шестая цифра отправляет сама: на телефоне клавиатура накрывает подвал, и
  // кнопка под ней недосягаема, пока не свернёшь ввод. Кнопка остаётся для
  // повторной попытки и для тех, кто ходит с клавиатуры.
  const onDigits = (raw: string) => {
    const next = raw.replace(/\D/g, '').slice(0, 6)
    setCode(next)
    if (err) setErr('')
    if (next.length === 6) submit(next)
  }

  return (
    <Screen id="code" back={() => go('email')} scrollKey="code"
            foot={
              <div className={'btn b-pri' + (full ? '' : ' off')} role="button" tabIndex={0}
                   onClick={() => submit()}
                   onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); submit() } }}>
                Sign in
              </div>
            }>
      <div className="h1" style={{ marginTop: 16 }}>Enter the code</div>
      <div style={{ fontSize: 'var(--t-14)', color: 'var(--muted)', marginTop: 4 }}>
        {s.authEmail
          ? <>Sent to <b style={{ color: 'var(--ink)' }}>{s.authEmail}</b></>
          : 'Six digits from the email we just sent.'}
      </div>

      {/* Одно поле, а не шесть: шесть input-ов ломают вставку кода и автозаполнение
          из письма. Клетки — рисунок поверх, поле лежит прозрачным сверху. */}
      <label className={'otp' + (err ? ' bad' : '')} style={{ marginTop: 16 }}>
        <input ref={box} inputMode="numeric" autoComplete="one-time-code" name="one-time-code"
               pattern="[0-9]*" maxLength={6} enterKeyHint="go" aria-label="6-digit code"
               value={code}
               onChange={e => onDigits(e.target.value)}
               onKeyDown={e => { if (e.key === 'Enter') submit() }} />
        <span className="otp-cells" aria-hidden="true">
          {[0, 1, 2, 3, 4, 5].map(i => (
            <i key={i} className={code.length === i ? 'on' : undefined}>{code[i] || ''}</i>
          ))}
        </span>
      </label>
      {err && <div className="fld-err" role="alert">{err}</div>}

      {/* Смена адреса — отдельная кнопка во всю ширину, как в референсе: раньше
          это была мелкая ссылка в строке с таймером. */}
      <div className="btn b-ghost" role="button" tabIndex={0} onClick={() => go('email')}
           onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go('email') } }}>
        Use another email
      </div>

      <div className="otp-again">
        {left > 0
          ? <>Ask for a new code in <b>{mmss(left)}</b></>
          : <b role="button" tabIndex={0} className="otp-link"
               onClick={() => { setLeft(RESEND_S); setCode(''); setErr('') }}
               onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') {
                 e.preventDefault(); setLeft(RESEND_S); setCode(''); setErr('') } }}>
              Ask for a new code
            </b>}
      </div>

      <div className="note" style={{ marginTop: 16 }}>
        <b>Demo: any six digits work</b>
        <p>No mail is sent — there is no server yet. Type <b>000000</b> to see what a
          rejected code looks like. With the backend on, a code lives 60 minutes
          and a new one can be asked once a minute.</p>
      </div>
    </Screen>
  )
}

/**
 * Строка аккаунта в настройках: кто вошёл и вход на экран аккаунта.
 *
 * Выход отсюда УБРАН. Он висел крестиком 32x32 — и мимо правила про тап-зону в
 * 44, и рядом с тумблерами, где необратимого не ждут. Теперь строка ведёт на
 * экран аккаунта, а выход и удаление живут там, где им и место. Тап-зона стала
 * всей строкой: 40 аватар плюс 12 отступа сверху и снизу.
 */
export function AccountRow({ go }: { go: Go }) {
  const { s } = useStore()
  // Демо без регистрации: входа нет — нет и кнопки, иначе она молча вела бы на Home.
  if (!s.account && NO_AUTH) return null
  if (!s.account) {
    // Причина прошлого провала живёт ЗДЕСЬ, а не только на экране входа. Раньше
    // она лежала на экран глубже: человек смотрел в настройки, видел «Sign in» и
    // делал вывод «вход не работает» — не зная, что приложение уже знает ответ.
    const err = authError()
    return (
      <>
        {err && <WhyNote err={err} mt={12} />}
        <div className="btn b-white" role="button" tabIndex={0} style={{ marginTop: 12 }}
             onClick={() => go('signin')}>Sign in</div>
      </>
    )
  }
  const via = s.account.via === 'google' ? 'Google'
            : s.account.via === 'apple' ? 'Apple' : 'Email code'
  return (
    <div className="acct">
      <div className="acc-who" role="button" tabIndex={0}
           aria-label={`Account: ${s.account.email}. Opens account settings`}
           onClick={() => go('account')}
           onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go('account') } }}>
        <div className="acc-av" style={{ backgroundImage: bg('hero-plants') }} aria-hidden="true" />
        <div className="acc-tx">
          <b>{s.account.email}</b>
          <s>{via}{s.account.demo ? ' · demo sign-in, not wired yet' : ''}</s>
        </div>
        <span className="acc-go" aria-hidden="true">
          <Icon name="chevron-right" color="#fff" size={18} sw={2.4} />
        </span>
      </div>
    </div>
  )
}
