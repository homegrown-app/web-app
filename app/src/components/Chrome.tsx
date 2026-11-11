// Шасси экрана: .screen.on > .sb + .hd + .bd + .foot + .nav.
//
// Слой героя (фото во всю ширину с параллаксом под шапкой) снят вместе с
// переносом Home на канвас: там Home начинается с текста, и других экранов
// с героем не было. Код лежит в истории — вернуть его дешевле, чем держать
// мёртвым в шасси, которое читают при каждой правке экрана.
// Таб-бар — плавающая пилюля: лежит НАД .bd и отнимает снизу свою высоту
// плюс зазор NAV_GAP. Отступ под подвалом считается от РЕАЛЬНЫХ высот
// через --foot-h: правила под конкретные высоты один раз уже положили
// подвал на навигацию.

import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Icon, Seed } from '../icons/Icon'

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

export function Header({ back, onBack, title, gear, steps }:
    { back?: boolean; onBack?: () => void; title?: string; gear?: () => void
      steps?: ReactNode }) {
  // В онбординге шапка держит прогресс: полоса шагов и счётчик занимают
  // место вордмарка, и сетка 44/1fr/44 уступает ряду с зазором 16.
  if (steps) {
    return (
      <div className="hd hd-steps">
        <div className="back" role="button" tabIndex={0} aria-label="Back"
             onClick={onBack} onKeyDown={e => {
               if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onBack?.() }
             }}>
          <Icon name="caret-right" color="var(--ink)" size={20} />
        </div>
        {steps}
      </div>
    )
  }
  return (
    <div className={'hd' + (back ? '' : ' hd-lead')}>
      {back && (
        <div className="hd-l">
          <div className="back" role="button" tabIndex={0} aria-label="Back"
               onClick={onBack} onKeyDown={e => {
                 if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onBack?.() }
               }}>
            <Icon name="caret-right" color="var(--ink)" size={20} />
          </div>
        </div>
      )}
      {/* С title логотип уступает место названию раздела, когда крупный
          заголовок страницы уезжает под шапку (класс is-titled на .screen). */}
      {title
        ? <div className="wm-swap"><div className="wm"><Seed size={24} />Homegrown</div>
                                   <div className="hd-t">{title}</div></div>
        : <div className="wm"><Seed size={24} />Homegrown</div>}
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
          <div key={name} className={'ni' + (on ? ' on' : '') + (name === 'Scan' ? ' ni-s' : '')} role="link" tabIndex={0}
               aria-label={name}
               aria-current={on ? 'page' : undefined}
               onClick={() => go(target)}
               onKeyDown={e => {
                 if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(target) }
               }}>
            {badge && name === 'Week' && <div className="bdg" aria-hidden="true" />}
            {name === 'Scan'
              ? <div className="ni-scan" aria-hidden="true"><Icon name={icon} color="currentColor" size={26} /></div>
              : <><Icon name={icon} color="currentColor" size={22} /><span>{name}</span></>}
          </div>
        )
      })}
    </nav>
  )
}

interface ScreenProps {
  id: string
  /** Название раздела в шапке вместо логотипа, когда .h1 страницы ушёл под шапку. */
  title?: string
  /** Полоса шагов онбординга: занимает в шапке место вордмарка. */
  steps?: ReactNode
  children: ReactNode
  back?: () => void
  nav?: { active: string; badge?: boolean; go: (id: string) => void }
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
}

export function Screen({ id, title, children, back, nav, foot, scrollKey, overlay, steps }: ScreenProps) {
  const root = useRef<HTMLDivElement>(null)
  const bd = useRef<HTMLDivElement>(null)

  // Плавающие элементы: подвал садится ровно над таб-баром, иначе кнопка
  // накрывает навигацию. Мерить можно только после того, как всё в DOM.
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const navEl = el.querySelector<HTMLElement>('.nav')
    const footEl = el.querySelector<HTMLElement>('.foot')
    // Таб-бар висит в --nav-gap от низа экрана, поэтому снизу он занимает
    // свою высоту плюс этот зазор — подвал садится ровно над ним. Число берём
    // из той же переменной, что и CSS: копия здесь уже однажды разъехалась.
    const gap = parseFloat(getComputedStyle(el).getPropertyValue('--nav-gap')) || 16
    const nh = navEl ? navEl.offsetHeight + gap : 0
    if (footEl) footEl.style.bottom = nh + 'px'
    const fh = footEl ? footEl.offsetHeight : 0
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

  return (
    <div className="screen on" id={'s-' + id} ref={root}>
      <StatusBar />
      <Header back={!!back} onBack={back} title={title} steps={steps}
              gear={nav && nav.active !== 'Settings' ? () => nav.go('settings') : undefined} />
      <div className="bd" ref={bd}>{children}</div>
      {foot && <div className="foot">{foot}</div>}
      {nav && <Nav {...nav} />}
      {overlay}
    </div>
  )
}
