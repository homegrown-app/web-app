// Состояние приложения. В прототипе это были ~58 глобалов; здесь один контекст
// с той же семантикой, чтобы порт можно было сверять с оригиналом по числам.
//
// Специально НЕ разносим по мелким сторам: экраны читают почти всё вместе
// (календарь зависит от zip+outdoor+track, дашборд от MY_PLANTS+isPro), и
// дробление дало бы связность без выгоды.

import {
  createContext, useContext, useEffect, useMemo, useReducer, type ReactNode,
} from 'react'
import { load, save } from '../lib/persist'
import { mkPlant, tkey, trackOfPlants, uid, type Plant, type Task } from '../lib/plants'
import { speciesPool, type Ctx, type Pool } from '../lib/season'
import type { Species } from '../data/species'
import type { Track } from '../data/onboarding'

export type { Track }
export type Units = 'imperial' | 'metric'
export type AuthVia = 'google' | 'apple' | 'email'
/** Аккаунт. demo=true — вход без подключённого провайдера, так и подписано в UI.
    uid — идентификатор в Supabase: по нему экран аккаунта читает снимок отправки,
    и без него пришлось бы спрашивать сессию запросом, то есть заводить на экране
    состояние «загружается». У демонстрационного входа его нет. */
export interface Account { email: string; via: AuthVia; demo?: boolean; uid?: string }
export type CalView = 'month' | 'year'
/** 'own' — у человека уже есть растения, 'plan' — начинает с нуля, null — не в онбординге */
export type OnbMode = 'own' | 'plan' | null

export interface Choices {
  track: Track
  space: string
  outdoor: boolean
  sun: string
  sunRank: number
  goals: string[]
  effort: number
  zip: string
}

/** какие типы задач попадают в недельную карточку. Полив не отключается — это ядро. */
export interface Care { pick: boolean; leaf: boolean; rotate: boolean; feed: boolean }
export interface Mail { weekly: boolean; water: boolean; news: boolean }

export interface ToastMsg { html: string; ms: number; at: number; undo?: boolean; unpro?: boolean }

export interface State {
  choices: Choices
  plants: Plant[]
  selected: number
  isPro: boolean
  /** Срок доступа Pro. Записывается в момент покупки из НАСТОЯЩЕЙ даты, а не из
      условного «сегодня» прототипа: подписка живёт в календаре человека.
      null — Pro включён сборкой, которая срока не писала (или чипом в /review):
      тогда экран настроек честно молчит про дату вместо того, чтобы её выдумать. */
  proUntil: string | null
  /** Какой тариф выбрали на пейволле. Колонки в базе под него нет (проверено
      пробой: profiles.pro_plan не существует), поэтому живёт только локально —
      на другом устройстве покажется дата без названия тарифа. */
  proPlan: 'year' | 'month' | null
  units: Units
  /** индекс в REMIND_AT */
  remind: number
  care: Care
  mail: Mail
  /** отмеченные задачи недели, ключ = tkey(task) */
  done: Record<string, boolean>
  weekOpen: boolean
  calView: CalView
  calMonth: number | null
  calOpen: string | null
  /** id вида на странице культуры */
  cropId: string | null
  /** развёрнутые полки сезонов, ключ — id полки */
  shelves: Record<string, boolean>
  /** одноразовая передача вида из календаря в библиотеку */
  libSeek: string | null
  onbMode: OnbMode
  /** выбранное в библиотеке, но ещё не добавленное */
  pending: string[]
  /** снимок из камеры: показывается на экране скана */
  scanUrl: string | null
  /** снимок, ждущий, пока человек выберет вид в библиотеке */
  scanKeep: string | null
  /** какая настройка открыта на экране выбора */
  pickKey: string
  /** откуда пришли в пейволл — туда и вернёмся */
  pwFrom: string
  /** удалённое растение для Undo */
  undo: { p: Plant; i: number } | null
  toast: ToastMsg | null
  /** поисковый запрос библиотеки */
  query: string
  /** null — не входил. Живёт между сессиями вместе с остальным состоянием. */
  account: Account | null
  /**
   * Живая ли сессия НА СЕРВЕРЕ. Это не то же самое, что account: аккаунт лежит
   * в localStorage и переживает смерть сессии, а доступ к приложению даёт только
   * сессия. 'unknown' — клиент Supabase ещё не ответил: он грузится отдельным
   * чанком, и до его ответа гасить приложение нельзя, иначе вошедший человек
   * увидит стену на полсекунды при каждом запуске. В localStorage НЕ пишется:
   * это факт текущего запуска, а не состояние сада.
   */
  session: 'unknown' | 'live' | 'none'
  /** откуда пришли во вход: из онбординга — дальше в пейволл, с возврата — на Home */
  authFrom: string
  /** введённый адрес: экран кода показывает его и подписывает им аккаунт */
  authEmail: string
}

// Съедобное — основной трек продукта. Комнатные остаются полноценной ветвью.
const CHOICES0: Choices = {
  track: 'edible', space: 'patio', outdoor: true,
  sun: '6–8 hours of sun', sunRank: 2, goals: [], effort: 4, zip: '78704',
}

export const seedPlants = (): Plant[] => [
  mkPlant('radish', 0, 27, [{ f: 'radish', day: 24 }, { f: 'leaves1', day: 11 }]),
  mkPlant('lettuce', 1, 24, [{ f: 'leaves3', day: 18 }]),
  mkPlant('basil', 3, 34, [{ f: 'basil', day: 21 }]),
  mkPlant('cherrytomato', 1, 12, []),
]
export const seedHouseDemo = (): Plant[] => [
  mkPlant('monstera', 4, 210, [{ f: 'leaves3', day: 18 }]),
  mkPlant('snakeplant', 20, 430, []),
  mkPlant('pothos', 9, 96, [{ f: 'leaves1', day: 11 }]),
  mkPlant('peacelily', 2, 64, [{ f: 'flowers', day: 21 }]),
]
export const seedMixed = (): Plant[] => [
  mkPlant('monstera', 4, 210, [{ f: 'leaves3', day: 18 }]),
  mkPlant('pothos', 9, 96, []),
  mkPlant('basil', 1, 34, [{ f: 'basil', day: 21 }]),
  mkPlant('radish', 0, 27, [{ f: 'radish', day: 24 }]),
]

// Экспортируется ради проверки слияния (lib/sync-audit.ts): ей нужно исходное
// состояние, а собирать его копией значило бы проверять копию, а не продукт.
export const INIT: State = {
  choices: CHOICES0,
  plants: seedPlants(),
  selected: 0,
  isPro: false,
  proUntil: null,
  proPlan: null,
  units: 'imperial',
  remind: 3,
  care: { pick: true, leaf: true, rotate: true, feed: true },
  mail: { weekly: true, water: true, news: false },
  done: {},
  weekOpen: true,
  calView: 'month',
  calMonth: null,
  calOpen: null,
  cropId: null,
  shelves: {},
  libSeek: null,
  onbMode: null,
  pending: [],
  scanUrl: null,
  scanKeep: null,
  pickKey: 'space',
  pwFrom: 'home',
  undo: null,
  toast: null,
  query: '',
  account: null,
  session: 'unknown',
  authFrom: 'save',
  authEmail: '',
}

/**
 * Слитое из базы. Только синхронизируемые срезы: экранное — раскрытая строка
 * календаря, тост, поиск — приезжать из базы не должно, иначе синхронизация
 * начала бы двигать экран под руками.
 */
export interface Pulled {
  plants?: Plant[]
  choices?: Partial<Choices>
  units?: Units
  remind?: number
  care?: Care
  mail?: Mail
  calView?: CalView
  isPro?: boolean
  /** Срок Pro приезжает с другого устройства вместе с профилем. Тарифа рядом
      нет: колонки profiles.pro_plan не существует, он остаётся локальным. */
  proUntil?: string | null
  done?: Record<string, boolean>
}

/**
 * Демо-набор из INIT — витрина для первого запуска, а не данные человека.
 * Синхронизации это нужно знать: отдавать витрину в чужой настоящий сад нельзя,
 * а занесённое руками — нужно. Состав видов и есть опознавательный знак.
 */
export const isDemoGarden = (ps: Plant[]): boolean =>
  ps.map(p => p.s.id).join(',') === INIT.plants.map(p => p.s.id).join(',')

export type Action =
  | { t: 'choices'; v: Partial<Choices> }
  | { t: 'plants'; v: Plant[] }
  | { t: 'select'; v: number }
  | { t: 'water'; v: number }
  | { t: 'remove'; v: number }
  | { t: 'undo' }
  | { t: 'pro'; v: boolean; plan?: 'year' | 'month'; until?: string }
  | { t: 'units'; v: Units }
  | { t: 'remind'; v: number }
  | { t: 'care'; v: keyof Care }
  | { t: 'mail'; v: keyof Mail }
  | { t: 'toggleTask'; v: Task }
  | { t: 'weekOpen'; v: boolean }
  | { t: 'calView'; v: CalView }
  | { t: 'calMonth'; v: number | null }
  | { t: 'calOpen'; v: string | null }
  | { t: 'cropId'; v: string | null }
  | { t: 'shelf'; v: string }
  | { t: 'shelvesInit'; v: Record<string, boolean> }
  | { t: 'libSeek'; v: string | null }
  | { t: 'onb'; v: OnbMode }
  | { t: 'onbReset'; v: OnbMode }
  | { t: 'wipe' }
  | { t: 'pendingToggle'; v: string }
  | { t: 'pending'; v: string[] }
  | { t: 'addPending' }
  | { t: 'applyPlan'; v: Species[]; room: number }
  | { t: 'scanUrl'; v: string | null }
  | { t: 'scanKeep'; v: string | null }
  | { t: 'pickKey'; v: string }
  | { t: 'pwFrom'; v: string }
  | { t: 'toast'; v: ToastMsg | null }
  | { t: 'query'; v: string }
  | { t: 'addPhoto'; v: { i: number; url: string } }
  | { t: 'signIn'; v: Account }
  | { t: 'signOut' }
  | { t: 'session'; v: State['session'] }
  | { t: 'authFrom'; v: string }
  | { t: 'authEmail'; v: string }
  | { t: 'enterCalendar' }
  | { t: 'enterLibrary'; seek: string | null }
  | { t: 'pulled'; v: Pulled }

function reducer(s: State, a: Action): State {
  switch (a.t) {
    case 'choices': return { ...s, choices: { ...s.choices, ...a.v } }
    case 'plants': return { ...s, plants: a.v, selected: 0 }
    case 'select': return { ...s, selected: a.v }
    case 'water': return { ...s, plants: s.plants.map((p, i) => (i === a.v ? { ...p, since: 0 } : p)) }
    case 'remove': {
      const p = s.plants[a.v]
      if (!p) return s
      const plants = s.plants.filter((_, i) => i !== a.v)
      return { ...s, plants, undo: { p, i: a.v },
               selected: Math.min(s.selected, Math.max(0, plants.length - 1)) }
    }
    case 'undo': {
      if (!s.undo) return s
      const plants = s.plants.slice()
      plants.splice(s.undo.i, 0, s.undo.p)
      return { ...s, plants, undo: null, toast: null }
    }
    // Выключение Pro стирает и срок с тарифом: иначе экран настроек показывал бы
    // «до такого-то числа» человеку, у которого доступа уже нет.
    case 'pro': return a.v
      ? { ...s, isPro: true, proPlan: a.plan ?? s.proPlan, proUntil: a.until ?? s.proUntil }
      : { ...s, isPro: false, proPlan: null, proUntil: null }
    case 'units': return { ...s, units: a.v }
    case 'remind': return { ...s, remind: a.v }
    // Смена состава задач обнуляет отметки: ключи привязаны к позиции растения,
    // и старая галочка после фильтра означала бы уже другую задачу.
    case 'care': return { ...s, care: { ...s.care, [a.v]: !s.care[a.v] }, done: {} }
    case 'mail': return { ...s, mail: { ...s.mail, [a.v]: !s.mail[a.v] }, done: {} }
    case 'toggleTask': {
      const k = tkey(a.v)
      return { ...s, done: { ...s.done, [k]: !s.done[k] } }
    }
    case 'weekOpen': return { ...s, weekOpen: a.v }
    case 'calView': return { ...s, calView: a.v, calOpen: null }
    case 'calMonth': return { ...s, calMonth: a.v }
    case 'calOpen': return { ...s, calOpen: s.calOpen === a.v ? null : a.v }
    case 'cropId': return { ...s, cropId: a.v }
    case 'shelf': return { ...s, shelves: { ...s.shelves, [a.v]: !s.shelves[a.v] } }
    case 'shelvesInit': return { ...s, shelves: a.v }
    case 'libSeek': return { ...s, libSeek: a.v }
    case 'onb': return { ...s, onbMode: a.v }
    // Онбординг начинается с чистого листа: демо-набор не должен притворяться
    // растениями, которые человек занёс сам.
    case 'onbReset': return { ...s, onbMode: a.v, plants: [], pending: [], selected: 0,
                              done: {}, scanKeep: null }
    // Delete account: назад к состоянию до первого запуска. Не onbReset —
    // тот чистит только растения, а тут уходят и выбор места, и ZIP, и Pro.
    // Демо-набор не возвращаем: человек попадает в онбординг с пустыми руками.
    case 'wipe': return { ...INIT, plants: [] }
    case 'pendingToggle': {
      const k = s.pending.indexOf(a.v)
      if (k > -1) return { ...s, pending: s.pending.filter(x => x !== a.v) }
      return { ...s, pending: [...s.pending, a.v] }
    }
    case 'pending': return { ...s, pending: a.v }
    // Ветка «уже есть» после библиотеки идёт дальше (место → свет), поэтому
    // onbMode здесь НЕ гасим: его снимает последний шаг. Трек выводим сразу —
    // от него зависят варианты места на следующем экране.
    case 'addPending': {
      const add = s.pending.map(id => mkPlant(id, 0, 0,
        s.scanKeep ? [{ u: s.scanKeep, day: 0 }] : []))
      const plants = [...s.plants, ...add]
      const track = s.onbMode === 'own'
        ? trackOfPlants(plants, s.choices.track) : s.choices.track
      return { ...s, plants, pending: [], scanKeep: null,
               choices: { ...s.choices, track }, selected: s.plants.length }
    }
    // План — предложение. Раньше он строился, показывался и молча выбрасывался:
    // после save→paywall на Home лежал демо-набор, а не то, что человек видел.
    // План ДОБАВЛЯЕТ растения, а не становится ими: сад — список человека, а не
    // содержимое плана. В онбординге список и так пуст, но за его пределами
    // (повторный проход, план поверх уже занесённого) подмена стирала бы чужое.
    case 'applyPlan': {
      const have = new Set(s.plants.map(p => p.s.id))
      const add = a.v.slice(0, a.room).filter(sp => !have.has(sp.id))
      return { ...s, onbMode: null,
               plants: [...s.plants, ...add.map(sp => mkPlant(sp.id, 0, 0, []))] }
    }
    case 'scanUrl': return { ...s, scanUrl: a.v }
    case 'scanKeep': return { ...s, scanKeep: a.v }
    case 'pickKey': return { ...s, pickKey: a.v }
    case 'pwFrom': return { ...s, pwFrom: a.v }
    case 'toast': return { ...s, toast: a.v }
    case 'query': return { ...s, query: a.v }
    case 'addPhoto': return { ...s, plants: s.plants.map((p, i) =>
      i === a.v.i ? { ...p, photos: [{ id: uid(), u: a.v.url, day: p.day }, ...p.photos] } : p) }
    case 'session': return s.session === a.v ? s : { ...s, session: a.v }
    case 'signIn': return { ...s, account: a.v, authEmail: a.v.email }
    // Выход не трогает растения: это выход из аккаунта, а не удаление данных —
    // для удаления есть отдельная строка в настройках.
    case 'signOut': return { ...s, account: null, session: 'none' }
    case 'authFrom': return { ...s, authFrom: a.v }
    case 'authEmail': return { ...s, authEmail: a.v }
    // Вход на календарь всегда про «сейчас»: пролистанный месяц и раскрытая
    // строка не переживают уход с экрана. Вид — привычка человека, его храним.
    case 'enterCalendar': return { ...s, calMonth: null, calOpen: null }
    // Роутер прототипа на входе в библиотеку чистил и поиск, и выбор; передача
    // вида из календаря — единственное, что переживает вход.
    // Приехало из базы. Порядок в объекте важен: plants и choices идут ПОСЛЕ
    // спреда, иначе отсутствующее поле затёрло бы своё же значение undefined.
    case 'pulled': {
      const plants = a.v.plants ?? s.plants
      return {
        ...s, ...a.v, plants,
        choices: a.v.choices ? { ...s.choices, ...a.v.choices } : s.choices,
        selected: Math.min(s.selected, Math.max(0, plants.length - 1)),
      }
    }
    case 'enterLibrary': {
      const sk = a.seek
      const own = sk ? s.plants.some(p => p.s.id === sk) : false
      return { ...s, libSeek: null, query: '', pending: sk && !own ? [sk] : [] }
    }
  }
}

interface Store {
  s: State
  d: (a: Action) => void
  /** контекст сезона: от него зависят все окна */
  ctx: Ctx
  /** виды, уместные при текущем треке и месте */
  pool: Species[]
}

const Ctx0 = createContext<Store | null>(null)

export function StoreProvider({ children, initial }:
    { children: ReactNode; initial?: Partial<State> }) {
  const [s, d] = useReducer(reducer, { ...load(INIT), ...initial })
  const value = useMemo<Store>(() => {
    const ctx: Ctx = { zip: s.choices.zip, outdoor: s.choices.outdoor }
    // Справочник НЕ сужается ответами онбординга. Раньше выбор «комнатные»
    // означал, что съедобных в библиотеке не существует вовсе — человек выбрал
    // трек один раз на первом экране и лишился половины приложения навсегда.
    // Трек теперь решает только ПОРЯДОК показа (см. Library.tsx), а не то, что
    // вообще можно иметь: растения человека — его список, а не следствие плана.
    // И место тоже больше не отбирает. Правило «съедобное, которое не живёт на
    // подоконнике, не предлагаем тому, у кого нет улицы» прятало из поиска
    // помидоры у всех, кто выбрал комнатное место — а человек их искал. Теперь
    // справочник полный, а место и свет остаются подписью в строке.
    const p: Pool = { track: 'both', outdoor: true }
    return { s, d, ctx, pool: speciesPool(p) }
  }, [s])
  // Пишем только когда меняется сохраняемое. Ссылки на слайсы стабильны, так
  // что список зависимостей вместо целого s не даёт записи на каждый тост и на
  // каждую букву в поиске — а с фотографиями в блобе это уже заметно.
  useEffect(() => { save(s) },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [s.choices, s.plants, s.selected, s.isPro, s.units, s.remind, s.care, s.mail,
     s.done, s.calView, s.onbMode])
  // для сверки с прототипом из консоли: __state().plants
  useEffect(() => {
    ;(window as unknown as { __state?: () => State }).__state = () => s
  }, [s])
  return <Ctx0.Provider value={value}>{children}</Ctx0.Provider>
}

export function useStore(): Store {
  const v = useContext(Ctx0)
  if (!v) throw new Error('useStore вне StoreProvider')
  return v
}
