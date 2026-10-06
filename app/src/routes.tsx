// Карта экранов. Один список — источник и для роутера, и для индекса на /review:
// раньше два места расходились, и экран мог появиться в приложении, но не в ревью.

import type { ReactElement } from 'react'
import { CalendarScreen } from './screens/Calendar'
import { CropScreen } from './screens/Crop'
import { HomeScreen } from './screens/Home'
import { PlantScreen } from './screens/Plant'
import { IndoorScreen } from './screens/Indoor'
import { AddPlantScreen, ScanScreen } from './screens/Library'
import {
  HarvestScreen, PaywallScreen, SeasonEndScreen, ShoppingScreen, WeekDoneScreen,
} from './screens/Moments'
import {
  LandingScreen, Q0Screen, Q1Screen, Q2Screen, Q2iScreen, Q3Screen, Q4Screen,
  Q5Screen, QWhatScreen,
} from './screens/Onboarding'
import { AccountScreen } from './screens/Account'
import { BoothHubScreen, BoothScreen } from './screens/Booth'
import { CodeScreen, EmailScreen, SignInScreen } from './screens/Auth'
import { PreviewScreen, SaveScreen } from './screens/Preview'
import { PickScreen, SettingsScreen } from './screens/Settings'
import {
  WeekBackScreen, WeekEmptyScreen, WeekLockScreen, WeekLongScreen,
} from './screens/Week'
import type { Species } from './data/species'

export type Go = (id: string) => void
export interface RouteProps { go: Go; openSpecies: (sp: Species) => void }

export interface Route {
  id: string
  title: string
  group: string
  note: string
  render: (p: RouteProps) => ReactElement
}

export const ROUTES: Route[] = [
  // ── Онбординг
  { id: 'landing', title: 'Landing', group: 'Онбординг',
    note: 'Фото на весь экран, лайм-кнопка. Никаких попапов и логина. Обещание про '
        + 'растения в целом, но ведёт съедобным: это основной трек.',
    render: p => <LandingScreen go={p.go} /> },
  { id: 'q0', title: 'Q0 · Старт', group: 'Онбординг',
    note: 'Развилка: приложение — трекер ухода, а онбординг строил план посадки. Человеку '
        + 'с готовой монстерой пять вопросов про то, что сажать, были бесполезны. Начало '
        + 'обнуляет растения: демо-набор не притворяется твоими.',
    render: p => <Q0Screen go={p.go} /> },
  { id: 'qwhat', title: 'Q1 · Track', group: 'Онбординг',
    note: 'Виден только ветке «хочу начать». Кто уже держит растения, трек не выбирает — '
        + 'он выводится из того, что человек занёс.',
    render: p => <QWhatScreen go={p.go} /> },
  { id: 'q1', title: 'Q1 · Space', group: 'Онбординг',
    note: 'Варианты рендерятся из трека. Уличное место включает outdoor — только тогда '
        + 'спрашиваем ZIP и заморозки.',
    render: p => <Q1Screen go={p.go} /> },
  { id: 'q2', title: 'Q2 · ZIP', group: 'Онбординг',
    note: 'Спрашивается только на уличном треке: комнатным растениям заморозки не нужны.',
    render: p => <Q2Screen go={p.go} /> },
  { id: 'q3', title: 'Q3 · Sun', group: 'Онбординг',
    note: 'Главный фильтр качества плана, только для улицы. «Not sure» → ранг 1.',
    render: p => <Q3Screen go={p.go} /> },
  { id: 'q2i', title: 'Q2-indoor · Light', group: 'Онбординг',
    note: 'Внутри свет меряется стороной окна, не часами. Ложится в тот же sunRank, '
        + 'движок один.',
    render: p => <Q2iScreen go={p.go} /> },
  { id: 'q4', title: 'Q4 · Goals', group: 'Онбординг',
    note: 'Варианты из трека. Лимит 3, лишние гаснут, а не исчезают.',
    render: p => <Q4Screen go={p.go} /> },
  { id: 'q5', title: 'Q5 · Effort', group: 'Онбординг',
    note: 'Определяет размер плана: 3 / 4 / 5–6 растений.',
    render: p => <Q5Screen go={p.go} /> },
  { id: 'preview', title: 'Plan Preview', group: 'Онбординг',
    note: '⚠ Цитата — плейсхолдер: настоящий отзыв надо получить у реального человека '
        + 'с его согласия. План показывается до регистрации; съедобным даём дату первого '
        + 'сбора, комнатным интервал полива. Блок «Why these» объясняет и отказы.',
    render: p => <PreviewScreen go={p.go} /> },
  { id: 'save', title: 'Save Plan', group: 'Онбординг',
    note: 'Регистрация после показанной ценности. Пилюля считается из плана: '
        + '«4 PLANTS · YEAR-ROUND» внутри, «· 30 WEEKS» на улице.',
    render: p => <SaveScreen go={p.go} /> },

  { id: 'signin', title: 'Sign in', group: 'Онбординг',
    note: 'Возврат: те же три способа, что и на Save, но без плана и с другой подводкой. '
        + 'Вход в него — ссылка на лендинге.',
    render: p => <SignInScreen go={p.go} /> },
  { id: 'email', title: 'Вход · почта', group: 'Онбординг',
    note: 'Настоящее поле: type=email, автозаполнение, проверка адреса, погашенная кнопка '
        + 'до валидного адреса. Письмо НЕ отправляется — у прототипа нет бэкенда, и это '
        + 'сказано на экране, а не скрыто.',
    render: p => <EmailScreen go={p.go} /> },
  { id: 'code', title: 'Вход · код', group: 'Онбординг',
    note: 'Одно поле с autocomplete=one-time-code, клетки — рисунок поверх: шесть input-ов '
        + 'ломают вставку кода из письма. Таймер повторной отправки 30 с. Любые шесть цифр '
        + 'впускают, 000000 показывает состояние ошибки — это демо, и так подписано.',
    render: p => <CodeScreen go={p.go} /> },

  // ── Home
  { id: 'home', title: 'Home', group: 'Home',
    note: 'Один экран, два состояния. Пусто — акцентный блок зовёт добавить растение. '
        + 'Есть растения — health score, виджеты и список. Задачи недели считаются из '
        + 'растений: полив по просрочке, сбор для созревших, протирка листьев для крупных.',
    render: p => <HomeScreen go={p.go} /> },
  { id: 'add-plant', title: 'Add a plant', group: 'Home',
    note: 'Один справочник на 29 видов: 8 комнатных и 21 съедобная культура. Показывается '
        + 'подмножество под трек и место; чему не хватает света — погашено, а не спрятано.',
    render: p => <AddPlantScreen go={p.go} /> },
  { id: 'week-lock', title: 'Soft-lock', group: 'Home',
    note: 'Даты и объём видны, скрыты только формулировки. Это не стена.',
    render: p => <WeekLockScreen go={p.go} /> },
  { id: 'week-empty', title: 'Week · пусто', group: 'Home',
    note: '«Nothing needed this week» — подтверждение, что всё идёт по плану. Список '
        + 'растений и срок следующей задачи считаются из данных.',
    render: p => <WeekEmptyScreen go={p.go} /> },
  { id: 'week-back', title: 'Week · возврат', group: 'Home',
    note: 'Продукт никогда не показывает список из двадцати просроченных задач. Пропуск '
        + 'сворачивается в две задачи из настоящих растений.',
    render: p => <WeekBackScreen go={p.go} /> },
  { id: 'week-long', title: 'Week · долгий пропуск', group: 'Home',
    note: 'Пересчёт предлагается, но никогда не делается автоматически. Нижняя строка '
        + 'называет растения, которые реально пересохли.',
    render: p => <WeekLongScreen go={p.go} /> },
  { id: 'season-end', title: 'Recap · OFF-11', group: 'Home',
    note: 'На уличном треке итог в сборах; для комнатных сезон не кончается никогда, '
        + 'поэтому итог в поливах, растениях и снимках. Один экран, две формулировки.',
    render: p => <SeasonEndScreen go={p.go} /> },

  // ── Растения
  { id: 'scan', title: 'Scan a plant', group: 'Plants',
    note: 'Камера открывается по-настоящему. Если распознавание не подключено, мы не '
        + 'выдумываем ответ и не делаем вид, что это ошибка: снимок сделан, человек '
        + 'выбирает вид сам, фото уезжает в журнал вместе с растением.',
    render: p => <ScanScreen go={p.go} /> },
  { id: 'plant', title: 'Plant detail', group: 'Plants',
    note: 'Второй виджет зависит от вида: комнатному — свет и влажность, съедобному — '
        + 'прогресс до сбора и типичный диапазон. Внизу удаление с Undo.',
    render: p => <PlantScreen go={p.go} /> },

  // ── Growth
  { id: 'harvest', title: 'Milestone', group: 'Growth',
    note: 'Пик удержания. Для съедобных «First harvest», для комнатных «It is thriving» '
        + 'с числом дней и поливов. Берёт настоящее фото растения из журнала.',
    render: p => <HarvestScreen go={p.go} /> },
  { id: 'shopping', title: 'Shopping list', group: 'Growth',
    note: 'Собирается из плана: горшки по размеру каждого вида, поддоны, грунт, лейка, '
        + 'удобрение — и строка семян только если в плане есть съедобное. Сумма считается.',
    render: p => <ShoppingScreen go={p.go} /> },
  { id: 'calendar', title: 'Harvest calendar', group: 'Growth',
    note: 'Два вида под два вопроса. This month — рейка месяцев и плитки, отсортированные '
        + 'по скорости до урожая. Whole year — непрерывные полосы, по две дорожки на '
        + 'культуру, группы cool/warm-season, пунктир заморозков и оранжевая линия сегодня. '
        + 'Окна выводятся из даты заморозков ZIP, длины сезона и дней до сбора.',
    render: p => <CalendarScreen go={p.go} openSpecies={p.openSpecies} /> },
  { id: 'crop', title: 'Crop', group: 'Growth',
    note: 'Страница культуры из справочника — не растение из My plants. Три дорожки '
        + '(рассада → высадка → прямой посев), два окна в году и «N/A» там, где способа '
        + 'нет вовсе. Открывается из календаря: из ленты и из полки сезона.',
    render: p => <CropScreen go={p.go} /> },

  // ── Деньги
  { id: 'paywall', title: 'Paywall', group: 'Деньги',
    note: 'Тёмный фон, лаймовый glow, сегмент тарифов, фичи с точками, белый CTA. '
        + 'Закрывается в тот экран, откуда пришёл.',
    render: p => <PaywallScreen go={p.go} /> },
  { id: 'week-done', title: 'Week complete · OFF-05', group: 'Деньги',
    note: 'Не чаще раза в 7 дней. Прозрачного скрима нет — полный экран. Цифры и строка '
        + '«что дальше» берутся из настоящих растений.',
    render: p => <WeekDoneScreen go={p.go} /> },

  // ── Стенд. Планшет у ящика с тремя секциями; каждую открывает свой QR.
  // Открыты без входа: на стенде нет аккаунта, и стена отрезала бы демо.
  { id: 'booth', title: 'Стенд · хаб', group: 'Стенд',
    note: 'Для персонала: ссылки секций для QR, отметка полива и счётчик срезок за день, '
        + 'сброс стенда после замены горшков.',
    render: p => <BoothHubScreen go={p.go} /> },
  { id: 'booth-basil', title: 'Стенд · уход', group: 'Стенд',
    note: 'Базилик. Сухость почвы по фото не узнать, поэтому спрашиваем: сухая — задача '
        + 'полить с объёмом; влажная — ничего не делать. Полив отмечается на весь день.',
    render: p => <BoothScreen key="basil" id="basil" go={p.go} /> },
  { id: 'booth-lettuce', title: 'Стенд · сбор', group: 'Стенд',
    note: 'Салат готов к срезке. Схема: внешние листья на 2–3 см над почвой, сердцевину '
        + 'оставить. Счётчик срезок за день — подсказка персоналу менять горшки.',
    render: p => <BoothScreen key="lettuce" id="lettuce" go={p.go} /> },
  { id: 'booth-tomato', title: 'Стенд · растёт', group: 'Стенд',
    note: 'Молодой черри. Прогресс до урожая и три задачи из того же движка weekTasks, '
        + 'что и неделя на Home.',
    render: p => <BoothScreen key="tomato" id="tomato" go={p.go} /> },

  // ── Система
  { id: 'settings', title: 'Settings', group: 'Система',
    note: 'Собирается из состояния целиком, и каждая строка что-то меняет. Units переводит '
        + 'объёмы по всему приложению. Тумблеры реально фильтруют движок задач; полив не '
        + 'отключается, это ядро. Export отдаёт настоящий JSON файлом.',
    render: p => <SettingsScreen go={p.go} /> },
  { id: 'account', title: 'Account', group: 'Система',
    note: 'Три вопроса, которые до него задать было некому: в какой я аккаунт вошёл, '
        + 'как в него попал и что из моего уже на сервере. Цифры из снимка последней '
        + 'отправки, а не запросом — поэтому ни спиннера, ни отказа. Sign out и '
        + 'Delete account переехали сюда с настроек: это действия над аккаунтом, а не '
        + 'настройки. Без аккаунта экран уводит в настройки.',
    render: p => <AccountScreen go={p.go} /> },
  { id: 'pick', title: 'Настройка · выбор', group: 'Система',
    note: 'Значения не циклятся по тапу: строка открывает список, где видно все варианты '
        + 'и что выбрано. У каждого варианта есть следствие — для света «сколько растений '
        + 'подойдёт», для ZIP зона, заморозки и длина сезона.',
    render: p => <PickScreen go={p.go} /> },

  // ── Подоконник
  { id: 'indoor', title: 'Windowsill · edibles', group: 'Windowsill',
    note: '«Season ends: never» — вот почему подоконник закрывает сезонность: ритм тут '
        + 'срез каждую неделю, а не один сбор за 30 дней. Экран показательный, '
        + 'содержимое статичное.',
    render: p => <IndoorScreen go={p.go} /> },
]

export const ROUTE = (id: string) => ROUTES.find(r => r.id === id)
export const GROUPS = ROUTES.reduce<Record<string, Route[]>>((a, r) => {
  ;(a[r.group] = a[r.group] || []).push(r)
  return a
}, {})
