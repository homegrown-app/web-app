// Масштаб приложения.
//
// Канвас нарисован на ширине 390 — все числа в CSS пришли оттуда. На экране
// другой ширины приложение не растягивается по месту, а целиком меняет
// масштаб: один множитель --k, который mobile.css применяет к .mob через zoom.
// Поэтому в стилях по-прежнему стоят те же числа, что в макете, а пропорции
// на любом телефоне остаются макетными.
//
// Множитель ограничен с двух сторон:
//   0.95 — ниже основной текст уходит за 15px и читается хуже. На 360-пиксельных
//          андроидах честный множитель был бы 0.92; недостающие 5% ширины
//          забирает резиновая раскладка, а размер шрифта остаётся.
//   1.15 — выше это уже не телефон: на планшете и раскрытой раскладушке
//          интерфейс выглядел бы нарисованным для слабовидящих.

const BASE = 390
const MIN = 0.95
const MAX = 1.15

// Шире этого mobile.css показывает телефон в рамке на светлом фоне: там макет
// идёт один к одному, масштабировать нечего.
const FRAME = 768

export function screenScale(w: number): number {
  if (w >= FRAME) return 1
  return Math.min(MAX, Math.max(MIN, w / BASE))
}

export function watchScale(): void {
  const el = document.documentElement
  const apply = () => el.style.setProperty('--k', String(screenScale(el.clientWidth)))
  apply()
  window.addEventListener('resize', apply)
  window.addEventListener('orientationchange', apply)
}
