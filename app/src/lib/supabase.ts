// Клиент Supabase: база и вход.
//
// URL и publishable-ключ лежат прямо здесь и это нормально: ключ по замыслу
// публичный, он уходит в браузер к каждому человеку. Данные закрывает не
// секретность ключа, а RLS — политики привязаны к auth.uid(), и без входа
// анонимный запрос не отдаёт и не пишет ни строки (проверено: POST в plants
// возвращает 42501). Секретный service_role в клиент не попадает никогда.

import type { SupabaseClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://bslttprzsbigcfplpxff.supabase.co'
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_QpG40q5C2r7sUf5Lx2GwGA_PjLfeqVm'

// Библиотека грузится отдельным чанком и НЕ блокирует первый кадр: она весит
// больше, чем всё приложение (+59 КБ в гзипе), а экраны рисуются из
// localStorage мгновенно и без сети. Сессия подхватывается чуть позже — это
// незаметно, а задержка первого кадра была бы заметна.
let client: SupabaseClient | null = null
let loading: Promise<SupabaseClient> | null = null

export function supa(): Promise<SupabaseClient> {
  if (client) return Promise.resolve(client)
  if (!loading) {
    loading = import('@supabase/supabase-js').then(({ createClient }) => {
      client = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
        auth: {
          // PKCE задан явно: он возвращает код в query (?code=…), а implicit
          // кладёт токены в хеш — а на хеше у нас висит роутер экранов.
          flowType: 'pkce',
          detectSessionInUrl: true,
          persistSession: true,
          autoRefreshToken: true,
        },
      })
      return client
    })
  }
  return loading
}

// Хук для проверки, как __state()/__audit(): даёт стенду дотянуться до клиента
// и, например, получить ссылку входа без настоящего перехода на Google.
;(window as unknown as { __supa?: typeof supa }).__supa = supa

/**
 * Лежит ли в браузере сохранённая сессия. Нужен синхронный ответ ДО загрузки
 * клиента Supabase: стена не должна гасить приложение, пока клиент отвечает, но
 * и ждать его вечно нельзя. Раньше признаком служило «нет аккаунта в состоянии»,
 * и это была догадка: состояние могло быть чистым (стёрли данные сайта, новое
 * устройство, стенд) при живой сессии в localStorage — человека вышибало на
 * экран входа за миг до того, как клиент сказал «сессия есть».
 * Ключ формирует сам supabase-js: sb-<ref>-auth-token.
 */
const SESSION_KEY = 'sb-' + SUPABASE_URL.split('//')[1].split('.')[0] + '-auth-token'
export function hasStoredSession(): boolean {
  try { return !!localStorage.getItem(SESSION_KEY) } catch { return false }
}

/** Куда Google возвращает человека. Работает и на Pages, и на localhost. */
export const authRedirect = () => location.origin + import.meta.env.BASE_URL
// Крючок для стендов, как __state()/__supa(). Нужен, чтобы authcheck сверял
// НАСТОЯЩИЙ адрес возврата, а не зашитую в него строку: при переезде на другой
// хост зашитая строка проверяла бы прошлое, а не то, что уходит провайдеру.
;(window as unknown as { __authRedirect?: typeof authRedirect }).__authRedirect = authRedirect

/**
 * Что вернул провайдер. Читаем и ?query, и #hash: GoTrue кладёт код в query
 * (PKCE), а ошибку — то туда, то туда, в зависимости от того, на каком шаге она
 * случилась. Раньше это не читалось вовсе, и провал возврата выглядел как
 * «ничего не произошло»: человек снова видел кнопку входа.
 */
export interface AuthReturn {
  /** пришёл код обмена — значит круг с провайдером состоялся */
  code: boolean
  /** текст ошибки от провайдера или GoTrue, уже человекочитаемый */
  error: string | null
}

export function authReturn(): AuthReturn {
  const q = new URLSearchParams(location.search)
  const h = new URLSearchParams(location.hash.replace(/^#/, ''))
  const pick = (k: string) => q.get(k) || h.get(k)
  const err = pick('error_description') || pick('error')
  return { code: !!pick('code'), error: err ? err.replace(/\+/g, ' ') : null }
}

/**
 * Убирает служебные параметры из адреса: без этого перезагрузка повторяла бы
 * разбор и показывала ту же ошибку второй раз. Хеш чистим ТОЛЬКО если в нём
 * лежат параметры входа, а не имя экрана — иначе снесли бы маршрут.
 */
export function clearAuthUrl(): void {
  const url = new URL(location.href)
  for (const k of ['code', 'state', 'error', 'error_code', 'error_description', 'sb']) {
    url.searchParams.delete(k)
  }
  if (/(^|[#&])(code|state|error|access_token|refresh_token)=/.test(location.hash)) url.hash = ''
  history.replaceState(null, '', url.toString())
}

/**
 * Экран, на который надо попасть после возврата от провайдера. Страница при
 * этом перезагружается целиком, поэтому в состоянии его не сохранить — кладём
 * рядом с состоянием в localStorage.
 */
/**
 * Почему в прошлый раз не вошло. Тост живёт семь секунд и уходит, а человек
 * остаётся перед кнопкой входа без объяснения — и «ничего не произошло»
 * выглядит как поломка приложения, а не как отказ провайдера. Держим причину
 * рядом с состоянием и показываем на экране входа, пока вход не удастся.
 */
const ERR_KEY = 'hg.authErr'
/**
 * Вид события, а не только причина. Их два, и путать их нельзя: «возврат от
 * провайдера не довёл до сессии» — это незавершённая попытка, а «сессия умерла
 * через час» — это выход без спроса, попытка там как раз завершилась удачно.
 * Один заголовок на оба давал бессмыслицу вроде «последняя попытка не
 * завершилась: сессия истекла».
 */
export type AuthErrKind = 'return' | 'expired'
export interface AuthErr { at: number; why: string; kind: AuthErrKind }
export const setAuthError = (why: string, kind: AuthErrKind = 'return') => {
  try { localStorage.setItem(ERR_KEY, JSON.stringify({ at: Date.now(), why, kind })) }
  catch { /* приватный режим */ }
}
export const authError = (): AuthErr | null => {
  try {
    const raw = localStorage.getItem(ERR_KEY)
    if (!raw) return null
    const e = JSON.parse(raw) as AuthErr
    // Записи прошлых сборок вида не знают — считаем их незавершённой попыткой.
    return { at: e.at, why: e.why, kind: e.kind === 'expired' ? 'expired' : 'return' }
  } catch { return null }
}
export const clearAuthError = () => {
  try { localStorage.removeItem(ERR_KEY) } catch { /* приватный режим */ }
}

/**
 * Выход, который человек сделал САМ. Библиотека шлёт SIGNED_OUT и тогда, когда
 * сессия умерла без спроса: истёк access-токен, а обновить его не удалось — нет
 * сети, либо refresh-токен уже забрало другое устройство (по умолчанию signOut
 * у Supabase глобальный и гасит все устройства сразу). По событию одно от
 * другого не отличить, а разница для человека огромная: в первом случае он сам
 * нажал, во втором — молча оказался перед кнопкой «Sign in» без единого слова,
 * и это выглядит как «вход не работает». Флаг ставит тот, кто выходит нарочно.
 */
/**
 * Метка временем и В localStorage, а не флаг в памяти модуля. Причины две, и
 * обе настоящие:
 *
 * 1. SIGNED_OUT приходит не ровно один раз — сессия сносится в библиотеке из
 *    трёх разных мест. Одноразовый флаг истрачивался на первом событии.
 * 2. Событие приходит и в ДРУГИЕ контексты того же origin: библиотека рассылает
 *    его между вкладками. У соседней вкладки переменная в памяти своя, нулевая —
 *    и она честно сообщала «сессия истекла» человеку, который только что сам
 *    нажал «Sign out» в первой вкладке. Ровно это ловил стенд в Safari, где
 *    прошлый документ iframe живёт дольше, чем в Chromium.
 *
 * Окно с запасом: истечь за эти секунды нечему, сессии уже нет.
 */
const OUT_KEY = 'hg.signOutAt'
export const markSignOut = () => {
  try { localStorage.setItem(OUT_KEY, String(Date.now())) } catch { /* приватный режим */ }
}
export const wasOnPurpose = (): boolean => {
  try {
    const at = Number(localStorage.getItem(OUT_KEY) || 0)
    return at > 0 && Date.now() - at < 15000
  } catch { return false }
}

const NEXT_KEY = 'hg.authNext'
export const setAuthNext = (id: string) => {
  try { localStorage.setItem(NEXT_KEY, id) } catch { /* приватный режим */ }
}
export const takeAuthNext = (): string | null => {
  try {
    const v = localStorage.getItem(NEXT_KEY)
    if (v) localStorage.removeItem(NEXT_KEY)
    return v
  } catch { return null }
}
