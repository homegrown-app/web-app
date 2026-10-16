// Обновление установленного приложения.
//
// Сервис-воркер (его пишет сборка, см. pwaWorker в vite.config.ts) открывает
// приложение из кэша, а новую сборку скачивает в фоне и держит в ожидании.
// Установленное на рабочий стол приложение iOS не перезагружается при возврате
// из фона, поэтому без плашки человек сидел бы на старой версии днями.
//
// В установленном приложении ожидающая версия показывается плашкой «New version
// · Update» — включает её только человек. Во вкладке браузера плашки нет:
// версия включается молча и придёт со следующей загрузкой страницы.

import { useEffect, useState } from 'react'

export const installed = () =>
  matchMedia('(display-mode: standalone)').matches
  || matchMedia('(display-mode: fullscreen)').matches
  || (navigator as unknown as { standalone?: boolean }).standalone === true

/** Ожидающая версия: функция, которая её включает, или null. */
export function useUpdate(): (() => void) | null {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null)

  useEffect(() => {
    // В dev воркера нет: он кэшировал бы модули Vite и ломал горячую замену.
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
    const base = import.meta.env.BASE_URL
    const sw = navigator.serviceWorker
    // Контроллера нет — это первая установка воркера, а не обновление.
    const found = (w: ServiceWorker) => {
      if (!sw.controller) return
      if (installed()) setWaiting(w)
      else w.postMessage('skip')
    }
    let reg: ServiceWorkerRegistration | undefined
    const check = () => { if (document.visibilityState === 'visible') reg?.update().catch(() => {}) }

    sw.register(`${base}sw.js`, { scope: base }).then(r => {
      reg = r
      if (r.waiting) found(r.waiting)
      r.addEventListener('updatefound', () => {
        const w = r.installing
        w?.addEventListener('statechange', () => { if (w.state === 'installed') found(w) })
      })
    }).catch(() => {})

    // Возврат из фона — главный момент проверки: установленное приложение
    // живёт неделями без перезагрузки. Таймер — для открытого подолгу экрана.
    document.addEventListener('visibilitychange', check)
    const timer = window.setInterval(check, 30 * 60 * 1000)
    return () => {
      document.removeEventListener('visibilitychange', check)
      clearInterval(timer)
    }
  }, [])

  if (!waiting) return null
  return () => {
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true })
    waiting.postMessage('skip')
  }
}
