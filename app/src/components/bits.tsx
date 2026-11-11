// Мелкие переиспользуемые куски. Все SVG-формулы перенесены из proto.py как есть:
// кольцо рисуется на SVG, а не conic-gradient, потому что conic не умеет
// круглые концы.

import { useId, type ReactNode } from 'react'
import { Icon, IcBig, Seed } from '../icons/Icon'
import { FILL } from '../icons/paths'
import { bg } from '../lib/assets'
import { wDue, type Plant } from '../lib/plants'
import type { Species } from '../data/species'

/** Кольцо прогресса, светлый и тёмный вариант. Повторяет ring() из proto.py. */
export function Ring({ pct, dark = false, sz = 38, sw = 3.2 }:
                     { pct: number; dark?: boolean; sz?: number; sw?: number }) {
  const r = (sz - sw) / 2
  const circ = 2 * Math.PI * r
  const off = circ * (1 - Math.max(0, Math.min(100, pct)) / 100)
  return (
    <svg aria-hidden="true" width={sz} height={sz} viewBox={`0 0 ${sz} ${sz}`}>
      <circle cx={sz / 2} cy={sz / 2} r={r} fill="none"
              stroke={dark ? 'rgba(255,255,255,.20)' : '#ECE8F6'} strokeWidth={sw} />
      <circle cx={sz / 2} cy={sz / 2} r={r} fill="none"
              stroke={dark ? 'var(--lime)' : 'var(--bright)'} strokeWidth={sw}
              strokeLinecap="round" strokeDasharray={circ.toFixed(1)}
              strokeDashoffset={off.toFixed(1)}
              transform={`rotate(-90 ${sz / 2} ${sz / 2})`} />
    </svg>
  )
}

/** Дуга для виджетов. arc() из proto.py. */
/**
 * Капля с уровнем воды.
 *
 * Заменила кольцо в карточке полива. Кольцо показывало ровно то же самое —
 * остаток интервала, — но было нечитаемо на обоих краях диапазона: полное
 * кольцо неотличимо от декоративной обводки, пустое — от дырки в макете, а
 * подписи у него нет. Владелец так и спросил: «что это за круг?». Капля
 * объясняет метафору сама: это вода, и её видно сколько.
 *
 * Три ступени, а не плавная заливка, и они НЕ придуманы: это ровно три
 * состояния, которые уже есть в pState() и которыми уже подписана пилюля на
 * экране растения.
 *     Healthy      (дней до полива > 2)   полная
 *     Water soon   (0 < дней ≤ 2)         половина
 *     Needs water  (дней ≤ 0)             пустая
 *
 * Цвета тоже не новые — те же, что у .st-ok / .st-warn / .st-bad. На белой
 * карточке дают 3.18, 3.25 и 5.18 к единице при пороге 3:1 для нетекстовой
 * графики.
 *
 * Подложка — тот же цвет с прозрачностью, а не серый: пустая капля обязана
 * читаться как тревога, а серая читалась бы как «выключено».
 */
export type DropTone = 'ok' | 'warn' | 'bad'
const DROP_COLOR: Record<DropTone, string> = {
  ok: 'var(--bright)', warn: '#5236E0', bad: '#B42318',
}
const DROP_FILL: Record<DropTone, number> = { ok: 100, warn: 50, bad: 0 }

/** Состояние полива для капли. Тот же порог, что у pState. */
export function dropTone(p: Plant): DropTone {
  const d = wDue(p)
  return d <= 0 ? 'bad' : d <= 2 ? 'warn' : 'ok'
}

/** Только внешний контур капли: в глифе Phosphor второй подпутью идёт блик,
    и обводить его вместе с силуэтом — рисовать лишнюю дугу внутри. */
const DROP_OUTLINE = (FILL['drop'].match(/ d="([^"]+)"/)?.[1] ?? '').split('M').filter(Boolean)[0]
const DROP_D = 'M' + DROP_OUTLINE

export function DropLevel({ tone, size = 28, onDark }:
    { tone: DropTone; size?: number; onDark?: boolean }) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '')
  const c = onDark ? '#fff' : DROP_COLOR[tone]
  const pct = DROP_FILL[tone]
  // Отсечка снизу: вода стоит в капле, а не висит сверху.
  const y = 256 - (256 * pct) / 100
  return (
    <svg aria-hidden="true" viewBox="0 0 256 256" width={size} height={size}>
      <defs>
        <clipPath id={'dl' + id}>
          <rect x="0" y={y} width="256" height={256 - y} />
        </clipPath>
      </defs>
      {/* «Стекло»: силуэт целиком, приглушённый. */}
      <path d={DROP_D} fill={c} opacity={onDark ? 0.32 : 0.22} />
      {/* Налитая часть. */}
      {pct > 0 && <path d={DROP_D} fill={c} clipPath={`url(#dl${id})`} />}
      {/* Контур. Без него пустая капля почти невидима, и самое тревожное
          состояние оказывалось самым бледным — иерархия наизнанку. Обводка
          держит форму при любом уровне, а уровень остаётся читаемым. */}
      <path d={DROP_D} fill="none" stroke={c} strokeWidth={14} strokeLinejoin="round" />
    </svg>
  )
}

/** Кольцо в карточке. Флага dark больше нет: тёмных карточек .wg в приложении
    не осталось, обе пары белые, и вторая раскраска стояла мёртвой веткой. */
export function Arc({ pct, sz }: { pct: number; sz: number }) {
  const sw = 5
  const r = (sz - sw) / 2
  const c = 2 * Math.PI * r
  const off = c * (1 - Math.min(100, pct) / 100)
  return (
    <svg aria-hidden="true" width={sz} height={sz} viewBox={`0 0 ${sz} ${sz}`}>
      <circle cx={sz / 2} cy={sz / 2} r={r} fill="none"
              stroke="#ECE8F6" strokeWidth={sw} />
      <circle cx={sz / 2} cy={sz / 2} r={r} fill="none"
              stroke="#6A4CFF" strokeWidth={sw} strokeLinecap="round"
              strokeDasharray={c.toFixed(1)} strokeDashoffset={off.toFixed(1)}
              transform={`rotate(-90 ${sz / 2} ${sz / 2})`} />
    </svg>
  )
}

/** Большое кольцо на тёмном (health score). ringBig() из proto.py. */
/**
 * Циферблат: шкала засечек, дуга значения и точка на её конце — так нарисованы
 * оба тёмных прибора в канвасе.
 *
 * Геометрия приходит числами, а не считается от размера: в канвасе это два
 * разных прибора, и пропорции у них не совпадают (200: кольцо 84 при обводке 6,
 * диск 66, 60 засечек; 180: кольцо 70 при обводке 8, диск 58, 40 засечек).
 * Общим остаётся устройство шкалы: засечки идут от disc−4 внутрь, каждая
 * пятая длиннее (6 против 3) и ярче.
 *
 * band — лаймовая дуга поверх дорожки: на экране растения ей отмечено окно
 * сбора, то есть куда дуга роста должна прийти.
 */
export function Dial({ sz, r, sw, disc, discFill, ticks, pct, band }: {
  sz: number; r: number; sw: number; disc: number; discFill: string
  ticks: number; pct: number; band?: [number, number]
}) {
  const c = sz / 2
  const circ = 2 * Math.PI * r
  const v = Math.max(0, Math.min(100, pct)) / 100
  const end = (v * 360 - 90) * (Math.PI / 180)
  const t0 = disc - 4                       // засечки начинаются внутри диска
  const at = (rad: number, a: number) => [c + rad * Math.cos(a), c + rad * Math.sin(a)]
  const [dx, dy] = at(r, end)
  return (
    <svg aria-hidden="true" width={sz} height={sz} viewBox={`0 0 ${sz} ${sz}`}>
      <circle cx={c} cy={c} r={r} fill="none" stroke="rgba(255,255,255,.22)" strokeWidth={sw} />
      {band && (
        <circle cx={c} cy={c} r={r} fill="none" stroke="var(--lime)" strokeWidth={sw}
                strokeDasharray={`${(circ * (band[1] - band[0])).toFixed(1)} ${circ.toFixed(1)}`}
                strokeDashoffset={(-circ * band[0]).toFixed(1)}
                transform={`rotate(-90 ${c} ${c})`} />
      )}
      <circle cx={c} cy={c} r={r} fill="none" stroke="#FFFFFF" strokeWidth={sw} strokeLinecap="round"
              strokeDasharray={`${(circ * v).toFixed(1)} ${circ.toFixed(1)}`}
              transform={`rotate(-90 ${c} ${c})`} />
      {v > 0 && <circle cx={dx.toFixed(1)} cy={dy.toFixed(1)} r={7} fill="#FFFFFF" />}
      <circle cx={c} cy={c} r={disc} fill={discFill} />
      {Array.from({ length: ticks }, (_, i) => {
        const big = i % 5 === 0
        const a = (i * 360 / ticks) * (Math.PI / 180)
        const [x1, y1] = at(t0, a)
        const [x2, y2] = at(t0 - (big ? 6 : 3), a)
        return (
          <line key={i} x1={x1.toFixed(1)} y1={y1.toFixed(1)} x2={x2.toFixed(1)} y2={y2.toFixed(1)}
                stroke={big ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.35)'}
                strokeWidth={big ? 2 : 1.2} strokeLinecap="round" />
        )
      })}
    </svg>
  )
}

/**
 * Строка метрик: подпись и под ней значение, две ячейки в ряд.
 *
 * Иконок у подписей больше НЕТ, и это не вкусовщина. Иконка стояла первым
 * элементом в потоке внутри <s>, поэтому слово уезжало вправо на её ширину плюс
 * зазор, а значение оставалось у левого края ячейки: замер дал расхождение
 * ровно 22px во всех четырёх ячейках дашборда. Боксом этого не увидеть — и <s>,
 * и <b> начинаются в 16 от края карточки, расходятся именно чернила.
 * Вторая цена: ячейка 64.3px при подписи «Humidity» шириной 64 — запас ноль,
 * на узких экранах это упиралось. Без иконки освобождается 22px.
 * Так уже было устроено большинство вызовов: на экране растения MetricRow
 * зовётся без иконок, это и есть основная идиома приложения.
 */
export function MetricRow({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <div className="mrow">
      {items.map(([k, v], i) => (
        <div key={i}>
          <s>{k}</s>
          <b>{v}</b>
        </div>
      ))}
    </div>
  )
}

/** Фон плитки вида: настоящий снимок либо тёмный градиент под иконку. */
export const photoStyle = (s: Species): React.CSSProperties =>
  s.img
    ? { backgroundImage: bg(s.img) }
    : { background: 'linear-gradient(160deg,#4C7A3E 0%,#2E5C2C 60%,#12351F 100%)' }

/**
 * Плитка вида. Если у вида нет настоящей фотографии — рисуем плитку с иконкой,
 * а не битую картинку. Выдумывать ассеты нельзя.
 */
export function PhotoTile({ s, cls, style, children }:
    { s: Species; cls: string; style?: React.CSSProperties; children?: ReactNode }) {
  return (
    <div className={cls + (s.img ? '' : ' no-ph')} style={{ ...photoStyle(s), ...style }}>
      {!s.img && <span className="ph-ic"><IcBig name={s.icon} /></span>}
      {children}
    </div>
  )
}

/** Круглая миниатюра вида для списков. */
export function SpThumb({ s }: { s: Species }) {
  return s.img
    ? <div className="spic has" style={{ backgroundImage: bg(s.img) }} />
    : <div className="spic"><Icon name={s.icon} color="var(--primary)" size={15} sw={1.9} /></div>
}

export function Note({ title, children, cta, mt = 16, seed }:
                     { title: string; children?: ReactNode; cta?: ReactNode; mt?: number
                       seed?: boolean }) {
  // Отступ сверху в прототипе проставлен по месту, а не один на все вызовы:
  // в пустой ветке week-back его нет вовсе.
  // seed — знак слева, как на артборде app-07: он там единственный такой,
  // поэтому это модификатор, а не общее устройство ноты.
  const body = (
    <>
      <b>{title}</b>
      {children && <p>{children}</p>}
      {cta}
    </>
  )
  if (!seed) return <div className="note" style={{ marginTop: mt }}>{body}</div>
  return (
    <div className="note note-seed" style={{ marginTop: mt }}>
      <span className="note-ic"><Seed size={56} color="var(--ink)" /></span>
      <span>{body}</span>
    </div>
  )
}

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="sl">{children}</div>
}

export function Tappable({ cls, onClick, children, label, style }:
    { cls: string; onClick?: () => void; children: ReactNode; label?: string; style?: React.CSSProperties }) {
  return (
    <div className={cls} role="button" tabIndex={0} aria-label={label} style={style}
         onClick={onClick}
         onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.() } }}>
      {children}
    </div>
  )
}
