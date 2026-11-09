// Иконка. Повторяет ic() из proto.py один в один:
//   — простые глифы (check, plus, x, caret) рисуются ШТРИХОМ: у Phosphor они
//     залитые и на мелком размере читаются как плашки;
//   — всё остальное — Phosphor fill, viewBox 256, заливка цветом.
// Старые имена (Lucide) разрешаются через ALIAS, чтобы не править десятки вызовов.

import { useMemo } from 'react'
import { FILL, STROKE, ALIAS } from './paths'

interface Props {
  name: string
  color?: string
  size?: number
  /** толщина штриха; на залитых иконках не используется */
  sw?: number
  className?: string
}

export function Icon({ name, color = 'currentColor', size = 22, sw, className }: Props) {
  if (name in STROKE) {
    return (
      <svg aria-hidden="true" viewBox="0 0 24 24" width={size} height={size} fill="none"
           stroke={color} strokeWidth={sw ?? 2.4} strokeLinecap="round"
           strokeLinejoin="round" className={className}>
        <path d={STROKE[name]} />
      </svg>
    )
  }
  const body = FILL[ALIAS[name] ?? name] ?? FILL[ALIAS['leaf']]
  return (
    <svg aria-hidden="true" viewBox="0 0 256 256" width={size} height={size}
         fill={color} className={className}
         dangerouslySetInnerHTML={{ __html: body }} />
  )
}

// Готовые начертания из ICON_JS: те же имена, размеры и цвета, что в прототипе.
export const IcPlus     = () => <Icon name="plus" color="var(--primary)" size={17} sw={2.4} />
export const IcCheck    = () => <Icon name="check" color="#fff" size={17} sw={3} />
export const IcCheck2   = () => <Icon name="check" color="#fff" size={16} sw={3} />
export const IcCheckG   = () => <Icon name="check" color="var(--bright)" size={17} sw={3} />
export const IcLeafLime = () => <Icon name="leaf" color="var(--lime)" size={20} />
export const IcChevD    = () => <Icon name="chevron-right" color="var(--muted)" size={18} sw={2.4} />
export const IcChev     = () => <Icon name="chevron-right" color="#8E88A8" size={20} sw={2.2} />
export const IcCaret    = () => <Icon name="caret-right" color="var(--primary)" size={20} sw={2.6} />
export const IcCam      = () => <Icon name="camera" color="var(--primary)" size={22} sw={2} />
/** крупный глиф для плитки-заглушки, когда настоящей фотографии вида нет */
export const IcBig = ({ name }: { name: string }) =>
  <Icon name={name} color="rgba(180,244,97,.42)" size={64} />

/**
 * Семечко — знак HOMEGROWN. Контуры сняты с канваса «Мягкий свет» (sys-logo12)
 * один в один, включая фильтр дрожания: без него линия выходит слишком ровной
 * и знак перестаёт быть рисованным. id фильтра и маски уникальны на экземпляр —
 * двух знаков на одном экране хватило бы, чтобы они подрались за один id.
 */
let seedN = 0
export function Seed({ size = 24, color = 'currentColor' }: { size?: number; color?: string }) {
  const id = useMemo(() => 'sd' + (++seedN), [])
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" aria-hidden="true">
      <defs>
        <filter id={'f' + id} x="-10%" y="-10%" width="120%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="2" seed="4" />
          <feDisplacementMap in="SourceGraphic" scale="1.8" xChannelSelector="R" yChannelSelector="G" />
        </filter>
        <mask id={'m' + id} maskUnits="userSpaceOnUse" x="0" y="0" width="120" height="120">
          <rect width="120" height="120" fill="#fff" />
          <path d="M40,66 Q46,58 52,66" fill="none" stroke="#000" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M68,66 Q74,58 80,66" fill="none" stroke="#000" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M44,80 Q60,94 76,80" fill="none" stroke="#000" strokeWidth="6" strokeLinecap="round" strokeLinejoin="round" />
        </mask>
      </defs>
      <g filter={`url(#f${id})`}>
        <path d="M60,34 C88,33 106,50 106,72 C106,96 88,108 60,108 C32,108 14,96 14,72 C14,50 32,35 60,34Z"
              fill={color} mask={`url(#m${id})`} />
        <path d="M60,34 C60,26 60,20 61,14" fill="none" stroke={color} strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M60,22 C52,24 42,20 40,10 C50,8 58,12 60,22Z" fill="none" stroke={color} strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M61,16 C66,8 76,4 86,8 C82,18 72,20 61,16Z" fill="none" stroke={color} strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" />
      </g>
    </svg>
  )
}

