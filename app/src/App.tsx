// Роутер на хеше. Хеш, а не history: GitHub Pages не умеет rewrite, а прототип
// и так адресовал экраны через #id — ссылки остаются рабочими.

import { useCallback, useEffect, useRef, useState } from 'react'
import { useAuthSession } from './screens/Auth'
import { hasStoredSession, supa } from './lib/supabase'
import { lastReport, runSync, type SyncReport } from './lib/sync'
import { Toast } from './components/parts'
import { Welcome } from './components/Welcome'
import { Review } from './review/Review'
import { ROUTE, ROUTES } from './routes'
import { useStore, type Pulled } from './state/store'
import type { Species } from './data/species'

export function useHash(): [string, (id: string) => void] {
  const read = () => location.hash.slice(1) || 'home'
  const [id, setId] = useState(read)
  useEffect(() => {
    const on = () => setId(read())
    addEventListener('hashchange', on)
    return () => removeEventListener('hashchange', on)
  }, [])
  const go = useCallback((next: string) => {
    if (location.hash.slice(1) === next) setId(next)
    else location.hash = next
  }, [])
  return [id, go]
}

/**
 * Синхронизация с базой. Здесь только повод её запустить — вся работа в
 * lib/sync.ts.
 *
 * Три повода: изменилось синхронизируемое (с задержкой, иначе каждая буква в
 * ZIP была бы запросом), вкладку снова открыли (с другого устройства могло
 * приехать новое) и появился аккаунт. Таймера нет: приложение и без сети
 * полное, а опрос по расписанию — это трафик без повода.
 *
 * Ошибки наружу не выходят: неудачная синхронизация ничего не показывает и
 * повторится в следующий раз. Посмотреть, чем закончилась, можно из консоли —
 * window.__sync() гоняет проход и отдаёт отчёт.
 */
function useSync() {
  const { s, d } = useStore()
  // Проход асинхронный, за это время состояние успевает измениться: отправлять
  // надо СВЕЖЕЕ, а не то, что было на момент запуска.
  const cur = useRef(s)
  useEffect(() => { cur.current = s }, [s])
  const apply = useCallback((p: Pulled) => d({ t: 'pulled', v: p }), [d])
  // catch, а не голый then: без сети import() клиента отваливается, и без него
  // это стало бы необработанным отказом промиса — то есть ошибкой в консоли,
  // на которую свип вёрстки справедливо ругается.
  const run = useCallback((): Promise<SyncReport> =>
    supa().then(sb => runSync(sb, () => cur.current, apply))
          .catch(e => ({ ok: false, error: e instanceof Error ? e.message : String(e) })),
    [apply])
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const kick = useCallback((ms: number) => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => { void run() }, ms)
  }, [run])

  const on = s.account !== null

  useEffect(() => {
    if (!on) return
    kick(1500)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, s.plants, s.choices, s.isPro, s.units, s.remind, s.care, s.mail, s.done, s.calView])

  useEffect(() => {
    if (!on) return
    const back = () => { if (!document.hidden) kick(0) }
    document.addEventListener('visibilitychange', back)
    return () => document.removeEventListener('visibilitychange', back)
  }, [on, kick])

  // Крючок для стендов, как __state()/__audit(): проход по требованию и отчёт.
  useEffect(() => {
    window.__sync = run
    window.__syncReport = lastReport
  }, [run])

  useEffect(() => () => clearTimeout(timer.current), [])
}

declare global {
  interface Window {
    __sync?: () => Promise<SyncReport>
    __syncReport?: () => SyncReport
  }
}

/** Приветствие показано в этом визите. Визит = вкладка, отсюда sessionStorage. */
const GREET_KEY = 'hg.greeted'

/**
 * Есть ли сеть. Нужна не для красоты: без сети сессию не обновить, и человек с
 * умершим токеном оказался бы отрезан от собственного сада — а это приложение
 * про полив на балконе, где связи может не быть вовсе.
 */
function useOnline(): boolean {
  const [on, setOn] = useState(() => !('onLine' in navigator) || navigator.onLine)
  useEffect(() => {
    const up = () => setOn(true), down = () => setOn(false)
    addEventListener('online', up); addEventListener('offline', down)
    return () => { removeEventListener('online', up); removeEventListener('offline', down) }
  }, [])
  return on
}

export function App() {
  const [hash, go] = useHash()
  const { s, d } = useStore()
  const route = ROUTE(hash)
  const id = route ? hash : 'home'

  // Режим для CSS: мобильные оверрайды применяются только к приложению,
  // на /review нужна рамка телефона со статус-баром и обычный скролл.
  useEffect(() => {
    document.body.dataset.mode = hash === 'review' ? 'review' : 'app'
  }, [hash])

  // Полоса «Unlock the full care plan» скрыта у Pro правилом body.is-pro .ofr —
  // правило перенесли, а класс ставить забыли, и апсейл висел уже после покупки.
  useEffect(() => {
    document.body.classList.toggle('is-pro', s.isPro)
  }, [s.isPro])

  // Пейволл закрывается туда, откуда пришли. Запоминаем предыдущий экран.
  useEffect(() => {
    if (id !== 'paywall') return
    const from = s.pwFrom
    if (from === 'paywall') d({ t: 'pwFrom', v: 'home' })
  }, [id, s.pwFrom, d])

  // Home — конец обоих онбордингов. Если человек ушёл с середины и вернулся
  // (состояние теперь переживает перезагрузку), режим не должен жить дальше:
  // иначе библиотека остаётся в онбординговом виде и без таб-бара.
  useEffect(() => {
    if (id === 'home' && s.onbMode) d({ t: 'onb', v: null })
  }, [id, s.onbMode, d])

  // Вход на экран: сброс того, что не должно переживать уход.
  useEffect(() => {
    if (id === 'calendar') d({ t: 'enterCalendar' })
    if (id === 'add-plant') d({ t: 'enterLibrary', seek: s.libSeek })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // ── Стена. Без живой сессии приложение недоступно: решение владельца продукта.
  //
  // Стена стоит ПОСЛЕ превью плана. Онбординг — вопросы, план, превью — открыт
  // и без аккаунта: человек сначала видит, за чем регистрируется. Дальше экран
  // Save, и в приложение он не пускает.
  //
  // Две защиты от ложного срабатывания:
  // 1. session === 'unknown' — клиент Supabase грузится отдельным чанком и ещё
  //    не ответил. Гасить приложение в этот момент нельзя: вошедший человек
  //    видел бы стену на полсекунды при каждом запуске. Но если аккаунта нет в
  //    localStorage вовсе, ответа ждать нечего — сессии заведомо нет.
  // 2. Льгота офлайна: сети нет, а вход когда-то был — приложение работает от
  //    телефона. Демо-аккаунт (вход по почте) льготы не даёт: за ним никогда не
  //    стояло сессии, и выдавать по нему доступ значило бы обходить стену.
  const online = useOnline()
  const known = s.session !== 'unknown' || !hasStoredSession()
  const offlineGrace = !online && !!s.account && !s.account.demo
  const access = s.session === 'live' || offlineGrace
  // Онбординг — это не только группа «Онбординг» в карте маршрутов. Библиотека
  // и сканер лежат в группе Home, но обе ветки онбординга ходят через них:
  // «уже есть растения» с q0 и «I’ll pick my own» с preview. Без этой поправки
  // стена рубила онбординг на первом же шаге ветки «уже есть».
  const onboarding = ROUTE(id)?.group === 'Онбординг'
    || (s.onbMode !== null && (id === 'add-plant' || id === 'scan'))
  const booth = ROUTE(id)?.group === 'Стенд'
  const walled = known && !access && !onboarding && !booth && hash !== 'review'
  // Цель одна — экран входа, и это не упрощение. Ветка «посреди онбординга →
  // Save» проигрывала гонку: эффект «home завершает онбординг» гасит onbMode
  // раньше, чем стена успевает его прочитать, и ветка всё равно уводила на
  // signin. А главное, она и не нужна: на signin есть оба способа входа и
  // ссылка «New here? Start free» назад в онбординг, так что тупика нет.
  // Идущий по флоу человек попадает на Save сам, кнопкой, а не стеной.
  useEffect(() => { if (walled) go('signin') }, [walled, go])

  // Режим льготы помечен на body. ЭТО ПОКА ТОЛЬКО КРЮЧОК: ни одно правило CSS
  // и ни один компонент класс не читают, то есть человек без сети никакого
  // объяснения не видит — приложение просто работает. Раньше здесь было
  // написано «настройки объясняют, почему приложение работает без сессии», и
  // это была неправда: такого текста в настройках нет. Крючок оставлен, потому
  // что на нём держится проверка льготы в tools/stands/gatecheck.html; текст
  // объяснения — отдельная задача, и решает её владелец продукта.
  useEffect(() => {
    document.body.classList.toggle('is-offline', offlineGrace)
  }, [offlineGrace])

  // Экрана входа для вошедшего не существует. «Welcome back + Continue with
  // Google» человеку с живой сессией — это предложение сделать то, что уже
  // сделано; он попадал сюда потому, что уводило отсюда только сохранённое
  // hg.authNext, а оно привязано к origin и после возврата на другой адрес
  // пустое. Теперь уводит само состояние.
  //
  // ТОЛЬКО signin, и это важно. Экраны email и code — середина входа: там
  // аккаунт появляется в состоянии РАНЬШЕ, чем меняется хеш (dispatch немедленно,
  // hashchange — следующим тиком), и эффект успевал перебить go('paywall') на
  // home. Онбординг из-за этого не доводил до пейволла.
  // Условие «вошедшему не показываем экран входа» требует ЖИВОЙ сессии, а не
  // просто памяти об аккаунте. Иначе оно воевало со стеной: у человека с
  // запомненным аккаунтом и умершей сессией стена уводила с home на signin, а
  // этот эффект тут же возвращал на home — сотни переходов в секунду, вкладка
  // Safari падала целиком. Аккаунт теперь помнится и после смерти сессии
  // (иначе не на что опереть льготу офлайна), поэтому проверять надо сессию.
  useEffect(() => {
    if (s.account && s.session === 'live' && id === 'signin') go('home')
  }, [id, s.account, s.session, go])

  // Приветствие: один раз за визит. Визит — это вкладка, поэтому флаг в
  // sessionStorage, а не в состоянии: переходы внутри приложения и перерисовки
  // его не сбрасывают, а новая вкладка сбрасывает.
  const [greet, setGreet] = useState(false)
  useEffect(() => {
    if (!s.account || greet) return
    // В онбординге и на лендинге приветствовать нечего: человек в другом деле,
    // и попап туда влез бы поперёк шага. На /review — тоже: это стенд сверки, а
    // не приложение, и приветствие там сожгло бы флаг визита впустую.
    if (hash === 'review' || ROUTE(id)?.group === 'Онбординг' || ROUTE(id)?.group === 'Стенд') return
    try {
      if (sessionStorage.getItem(GREET_KEY)) return
      sessionStorage.setItem(GREET_KEY, '1')
    } catch { return }            // приватный режим: молча не показываем
    setGreet(true)
  }, [s.account, id, hash, greet])

  const goTracked = useCallback((next: string) => {
    // save ведёт в пейволл, но возвращаться из него надо на home, а не на save
    if (next === 'paywall') d({ t: 'pwFrom', v: id === 'save' ? 'home' : id })
    go(next)
  }, [go, d, id])

  // Вход через Google возвращает человека уже с сессией: подхватываем её и
  // уводим на экран, с которого начинали.
  useAuthSession(goTracked)
  useSync()

  if (hash === 'review') return <Review />

  const openSpecies = (sp: Species) => {
    d({ t: 'cropId', v: sp.id })
    goTracked('crop')
  }

  // Экран аккаунта приходит ЛИСТОМ поверх настроек: он оттуда открывается и туда
  // же возвращает, значит это слой над местом, а не отдельное место. Маршрут при
  // этом сохранён целиком — прямая ссылка, каталог /review и стенды работают
  // как раньше, а go('settings') закрывает лист. Под листом рисуем настройки:
  // иначе за скримом была бы пустота и таб-бар взять было бы негде.
  const sheet = id === 'account' ? ROUTE('account') : null
  const base = sheet ? ROUTE('settings') : ROUTE(id)

  return (
    <main className="mob">
      {(base || ROUTES[0]).render({ go: goTracked, openSpecies })}
      {sheet && sheet.render({ go: goTracked, openSpecies })}
      {greet && (
        <Welcome onClose={() => setGreet(false)}
                 onAccount={() => { setGreet(false); goTracked('account') }} />
      )}
      <Toast />
    </main>
  )
}
