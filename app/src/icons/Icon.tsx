// Иконка. Повторяет ic() из proto.py один в один:
//   — простые глифы (check, plus, x, caret) рисуются ШТРИХОМ: у Phosphor они
//     залитые и на мелком размере читаются как плашки;
//   — всё остальное — Phosphor fill, viewBox 256, заливка цветом.
// Старые имена (Lucide) разрешаются через ALIAS, чтобы не править десятки вызовов.

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
