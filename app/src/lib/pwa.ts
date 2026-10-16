// Обновление установленного приложения.
//
// Сервис-воркер (его пишет сборка, см. pwaWorker в vite.config.ts) открывает
// приложение из кэша, а новую сборку скачивает в фоне и держит в ожидании.
// Установленное на рабочий стол приложение iOS не перезагружается при возврате
// из фона, поэтому без плашки человек сидел бы на старой версии днями.
//
// Ожидающая версия показывается плашкой «New version available · Reload», как в
// Cramless (там vite-plugin-pwa в режиме prompt), — включает её только человек.
// Плашка и в установленном приложении, и во вкладке: раньше во вкладке версия
// включалась молча, и после деплоя было непонятно, что уже загружено.

import { useEffect, useState } from 'react'

/** Ожидающая версия: функция, которая её включает, или null. */
export function useUpdate(): (() => void) | null {
  const [waiting, setWaiting] = useState<ServiceWorker | null>(null)

  useEffect(() => {
    // В dev воркера нет: он кэшировал бы модули Vite и ломал горячую замену.
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
    const base = import.meta.env.BASE_URL
    const sw = navigator.serviceWorker
    // Контроллера нет — это первая установка воркера, а не обновление.
    const found = (w: ServiceWorker) => { if (sw.controller) setWaiting(w) }
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
