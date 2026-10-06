// Шасси экрана. Структура DOM повторяет прототип буквально
// (.screen.on > .sb + .hd + .bd + .ofr + .nav), потому что CSS перенесён
// дословно и рассчитывает именно на неё. Отступ под плавающими баннером и
// подвалом считается от РЕАЛЬНЫХ высот через --ofr-bottom и --foot-h:
// три правила под конкретные высоты один раз уже положили баннер на кнопку.

import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Icon } from '../icons/Icon'
import { dismissOffer, useOfferOff } from '../lib/offer'
import { useStore } from '../state/store'

export function StatusBar() {
  return (
    <div className="sb">
      <span>9:41</span>
      <span style={{ letterSpacing: '.06em' }}>
        <Icon name="sun" color="var(--ink)" size={15} sw={2} />
      </span>
    </div>
  )
}

export function Header({ back, onBack, title, gear }:
    { back?: boolean; onBack?: () => void; title?: string; gear?: () => void }) {
  return (
    <div className="hd">
      <div className="hd-l">
        {back && (
          <div className="back" role="button" tabIndex={0} aria-label="Back"
               onClick={onBack} onKeyDown={e => {
                 if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onBack?.() }
               }}>
            <Icon name="caret-right" color="var(--ink)" size={20} />
          </div>
        )}
      </div>
      {/* С title логотип уступает место названию раздела, когда крупный
          заголовок страницы уезжает под шапку (класс is-titled на .screen). */}
      {title
        ? <div className="wm-swap"><div className="wm">HOMEGROWN</div><div className="hd-t">{title}</div></div>
        : <div className="wm">HOMEGROWN</div>}
      <div className="hd-r">
        {/* Настройки живут в шапке: середина таб-бара отдана сканеру. */}
        {gear && (
          <div className="hd-gear" role="button" tabIndex={0} aria-label="Settings"
               onClick={gear} onKeyDown={e => {
                 if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); gear() }
               }}>
            <Icon name="settings-2" color="currentColor" size={22} />
          </div>
        )}
      </div>
    </div>
  )
}

// Середина — сканер: главное действие приложения, крупной лаймовой кнопкой.
// Настройки переехали в шапку (шестерёнка справа).
const NAVI: Array<[string, string, string]> = [
  ['Week', 'calendar-days', 'home'],
  ['Scan', 'camera', 'scan'],
  ['Calendar', 'plant', 'calendar'],
]

export function Nav({ active, badge, go }: { active: string; badge?: boolean; go: (id: string) => void }) {
  return (
    <nav className="nav" aria-label="Main">
      {NAVI.map(([name, icon, target]) => {
        const on = name === active
        return (
          <div key={name} className={'ni' + (on ? ' on' : '')} role="link" tabIndex={0}
               aria-current={on ? 'page' : undefined}
               onClick={() => go(target)}
               onKeyDown={e => {
                 if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(target) }
               }}>
            {badge && name === 'Week' && <div className="bdg" aria-hidden="true" />}
            {name === 'Scan'
              ? <div className="ni-scan" aria-hidden="true"><Icon name={icon} color="currentColor" size={24} /></div>
              : <Icon name={icon} color="currentColor" size={23} />}
            <span>{name}</span>
          </div>
        )
      })}
    </nav>
  )
}

export function Offer({ txt = 'Unlock the full care plan', sub = '$29/yr', onClick }:
                      { txt?: string; sub?: string; onClick?: () => void }) {
  const off = useOfferOff()
  const { d } = useStore()
  if (off) return null
  const close = (e: { stopPropagation: () => void }) => {
    e.stopPropagation()
    dismissOffer()
    d({ t: 'toast', v: { html: '<span>Pro is always in <b>Settings</b></span><a href="#settings">Open Settings</a>',
                         ms: 6000, at: Date.now() } })
  }
  return (
    <div className="ofr" role="button" tabIndex={0} onClick={onClick} aria-label={`${txt}, ${sub}`}
         onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.() } }}>
      <div className="ofr-in">
        <div className="ofr-ic"><Icon name="sprout" color="var(--lime)" size={19} sw={2} /></div>
        <div className="ofr-tx"><b>{txt}</b><s>{sub}</s></div>
        <div className="ofr-go"><Icon name="chevron-right" color="var(--lime)" size={18} sw={2.4} /></div>
      </div>
      {/* Крестик снаружи .ofr-in: у той overflow:hidden, кружок в углу обрезался. */}
      <div className="ofr-x" role="button" tabIndex={0} aria-label="Close"
           onClick={close}
           onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); close(e) } }}>
        <Icon name="x" color="var(--deepest)" size={12} sw={3} />
      </div>
    </div>
  )
}

interface ScreenProps {
  id: string
  /** Название раздела в шапке вместо логотипа, когда .h1 страницы ушёл под шапку. */
  title?: string
  children: ReactNode
  back?: () => void
  nav?: { active: string; badge?: boolean; go: (id: string) => void }
  offer?: { txt?: string; sub?: string; onClick?: () => void }
  /**
   * Подвал: прибит к низу и НЕ скроллится с контентом. Обязан быть соседом
   * .bd, а не его потомком: .bd — скролл-контейнер, и absolute внутри него
   * уезжает вместе с содержимым и обрезается.
   */
  foot?: ReactNode
  /** сбрасывать прокрутку при смене этого значения (в прототипе — при go()) */
  scrollKey?: string
  /**
   * Слой поверх экрана: лист подтверждения со скримом. Как и foot, обязан быть
   * соседом .bd, а не его потомком — внутри скролл-контейнера он уезжает вместе
   * с содержимым и обрезается.
   */
  overlay?: ReactNode
  /**
   * Слой под шапкой: фото во всю ширину до самого верха экрана. Лежит вне
   * потока, поэтому контент .bd проезжает поверх него. Высота — в --hero-h,
   * прогресс прокрутки — в --p (0…1), из них CSS считает параллакс и блюр.
   */
  hero?: ReactNode
}

export function Screen({ id, title, children, back, nav, offer, foot, scrollKey, hero, overlay }: ScreenProps) {
  const root = useRef<HTMLDivElement>(null)
  const bd = useRef<HTMLDivElement>(null)

  // Плавающие элементы: подвал садится ровно над таб-баром, иначе кнопка
  // накрывает навигацию. Мерить можно только после того, как всё в DOM.
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const navEl = el.querySelector<HTMLElement>('.nav')
    const footEl = el.querySelector<HTMLElement>('.foot')
    const nh = navEl ? navEl.offsetHeight : 0
    if (footEl) footEl.style.bottom = nh + 'px'
    const fh = footEl ? footEl.offsetHeight : 0
    // Кнопка Scan выступает над таб-баром на 24px — баннер встаёт выше неё.
    const lift = navEl ? 24 : 0
    el.style.setProperty('--ofr-bottom', fh + nh + lift + 12 + 'px')
    el.style.setProperty('--foot-h', fh + nh + 16 + 'px')
  })

  useLayoutEffect(() => { if (bd.current) bd.current.scrollTop = 0 }, [scrollKey])

  // Логотип → название раздела. Порог — низ первого .h1 страницы: пока
  // заголовок виден, дублировать его в шапке незачем. Класс, а не state:
  // перерисовывать React на каждый кадр скролла незачем.
  useLayoutEffect(() => {
    const el = root.current, box = bd.current
    if (!title || !el || !box) return
    const on = () => {
      const h1 = box.querySelector<HTMLElement>('.h1')
      const edge = h1 ? h1.offsetTop - box.offsetTop + h1.offsetHeight - 8 : 48
      el.classList.toggle('is-titled', box.scrollTop > edge)
    }
    on()
    box.addEventListener('scroll', on, { passive: true })
    return () => box.removeEventListener('scroll', on)
  }, [title])

  // Высота героя и прогресс прокрутки идут в CSS-переменные, а не в state:
  // перерисовывать React на каждый кадр скролла незачем.
  useLayoutEffect(() => {
    const el = root.current, box = bd.current
    if (!hero || !el || !box) return
    let h = 0, pad = 0, raf = 0
    const measure = () => {
      // 0.68 — фото должно вместить и шапку, и весь блок дашборда на себе, и
      // при этом остаться фотографией: сверху видна чистая полоса кадра. Но на
      // низких экранах (iPhone SE, 320x568) 68% МЕНЬШЕ блока, и его верх уезжал
      // под шапку. Поэтому высота считается от блока, а зона растушёвки ужимается.
      const r8 = (v: number) => Math.round(v / 8) * 8
      const FADE = 96
      const inn = el.querySelector<HTMLElement>('.hero-in')
      if (inn) {
        el.style.setProperty('--fade', '0px')
        const need = box.offsetTop + inn.offsetHeight   // шапка + блок без растушёвки
        const base = r8(el.clientHeight * 0.68)
        const cap = r8(el.clientHeight * 0.88)
        h = Math.max(need, Math.min(cap, Math.max(base, r8(need + FADE))))
        el.style.setProperty('--fade', Math.max(0, Math.min(FADE, h - need)) + 'px')
      } else {
        h = r8(el.clientHeight * 0.68)
      }
      el.style.setProperty('--hero-h', h + 'px')
      // .bd начинается ниже статус-бара и шапки, а фото — от нуля экрана.
      // Отступ считаем от РЕАЛЬНОГО верха .bd: в приложении статус-бара нет,
      // в ревью он есть, и захардкоженное число сдвинуло бы лист.
      pad = Math.max(0, h - 16 - box.offsetTop)
      el.style.setProperty('--hero-pad', pad + 'px')
    }
    const onScroll = () => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const p = h ? Math.min(1, Math.max(0, box.scrollTop / h)) : 0
        el.style.setProperty('--p', p.toFixed(3))
        // q — насколько лист подошёл к шапке. .bd обрезает содержимое по своей
        // границе, поэтому в полосе шапки всегда видно фото: без непрозрачного
        // фона там остаётся размытое пятно. Фон и цвет вордмарка ведём по q.
        const q = Math.min(1, Math.max(0, 1 - (pad - box.scrollTop) / 64))
        el.style.setProperty('--q', q.toFixed(3))
      })
    }
    measure(); onScroll()
    box.addEventListener('scroll', onScroll, { passive: true })
    // ResizeObserver, а не window.resize: событие окна не приходит при смене
    // метрик вьюпорта (эмуляция устройства), и высота героя оставалась от
    // прежнего размера — блок и скрим считались по чужой геометрии.
    const ro = new ResizeObserver(() => { measure(); onScroll() })
    ro.observe(el)
    // И сам блок: его высота меняется не только от размера экрана. На холодной
    // загрузке первый кадр рисуется системным шрифтом, Caprasimo подменяется
    // позже — блок вырастает, а отступ листа остаётся от прежней высоты, и на
    // невысоком экране (Safari отдаёт 714, а не 844) лист наезжал на виджеты.
    const inn0 = el.querySelector<HTMLElement>('.hero-in')
    if (inn0) ro.observe(inn0)
    // И скролл-контейнер: его высота меняется от любого позднего сдвига шапки
    // (режим экрана, подмена шрифта, схлопывание адресной строки), а размеры
    // .screen и .hero-in при этом остаются прежними.
    ro.observe(box)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      box.removeEventListener('scroll', onScroll)
      ro.disconnect()
    }
  }, [hero])

  return (
    <div className={'screen on' + (hero ? ' has-hero' : '')} id={'s-' + id} ref={root}>
      {hero && <div className="hero">{hero}</div>}
      <StatusBar />
      <Header back={!!back} onBack={back} title={title}
              gear={nav && nav.active !== 'Settings' ? () => nav.go('settings') : undefined} />
      {/* Распорка под фото, а НЕ padding-top у .bd: sticky внутри скролл-
          контейнера отсчитывает top:0 ниже его padding, и липкий заголовок
          вставал бы на 468px ниже шапки вместо того, чтобы встать под неё. */}
      <div className="bd" ref={bd}>
        {hero && <div className="hero-gap" aria-hidden="true" />}
        {children}
      </div>
      {foot && <div className="foot">{foot}</div>}
      {offer && <Offer {...offer} />}
      {nav && <Nav {...nav} />}
      {overlay}
    </div>
  )
}
