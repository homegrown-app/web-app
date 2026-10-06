// Маршрут-лист: экран, который приходит снизу поверх места, откуда его открыли
// (добавление растения, настройки). Под листом остаётся живой экран за
// скримом — это слой над местом, а не новое место.
//
// Закрывается тремя путями, все равнозначны: потянуть за ручку вниз (дальше
// порога или быстрым смахиванием), тап по скриму, Escape. Тянется только за
// ручку: внутри листа свой скролл, и жест «вниз» там значит «прокрутить».

import { useEffect, useRef, useState, type ReactNode } from 'react'

const CLOSE_PX = 120          // дальше — закрываем
const CLOSE_V = 0.6           // px/мс: быстрое смахивание закрывает и с короткого хода
const OUT_MS = 220

export function RouteSheet({ label, onClose, children }:
    { label: string; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null)
  const [dy, setDy] = useState(0)
  const [leaving, setLeaving] = useState(false)
  const drag = useRef<{ y0: number; t0: number; last: number; tl: number } | null>(null)

  const close = () => {
    if (leaving) return
    setLeaving(true)
    window.setTimeout(onClose, OUT_MS)
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  })

  const down = (e: React.PointerEvent) => {
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { y0: e.clientY, t0: e.timeStamp, last: e.clientY, tl: e.timeStamp }
  }
  const move = (e: React.PointerEvent) => {
    const g = drag.current
    if (!g) return
    g.last = e.clientY; g.tl = e.timeStamp
    setDy(Math.max(0, e.clientY - g.y0))
  }
  const up = () => {
    const g = drag.current
    drag.current = null
    if (!g) return
    const dist = g.last - g.y0
    const v = dist / Math.max(1, g.tl - g.t0)
    if (dist > CLOSE_PX || (dist > 24 && v > CLOSE_V)) close()
    else setDy(0)
  }

  const moving = drag.current !== null
  return (
    <div className={'rsh' + (leaving ? ' out' : '')}>
      <div className="rsh-sc" onClick={close} aria-hidden="true"
           style={{ opacity: leaving ? 0 : Math.max(0, 1 - dy / 400) }} />
      <div className="rsh-box" ref={box} role="dialog" aria-modal="true" aria-label={label}
           style={{ transform: leaving ? 'translateY(100%)' : `translateY(${dy}px)`,
                    transition: moving ? 'none' : undefined }}>
        <div className="rsh-grab" onPointerDown={down} onPointerMove={move}
             onPointerUp={up} onPointerCancel={up}
             role="button" tabIndex={0} aria-label={`Close ${label}`}
             onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); close() } }}>
          <i />
        </div>
        <div className="rsh-body">{children}</div>
      </div>
    </div>
  )
}
