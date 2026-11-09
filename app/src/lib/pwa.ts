// Обновление установленного приложения.
//
// Сервис-воркер (его пишет сборка, см. pwaWorker в vite.config.ts) открывает
// приложение из кэша, а новую сборку скачивает в фоне и держит в ожидании.
// Установленное на рабочий стол приложение iOS не перезагружается при возврате
// из фона, поэтому без плашки человек сидел бы на старой версии днями.
//
// Новая версия показывается плашкой «New version available · Reload» —
// перезагружает только человек. Плашка и в установленном приложении, и во
// вкладке: раньше во вкладке версия включалась молча, и после деплоя было
// непонятно, что уже загружено.
//
// Ловим смену контроллера, а не ожидающего воркера: воркер больше не ждёт
// (sw.template.js), иначе исправления механизма обновления не доезжали бы.

import { useEffect, useState } from 'react'

/** Пришла новая версия: функция перезагрузки, или null. */
export function useUpdate(): (() => void) | null {
  const [fresh, setFresh] = useState(false)

  useEffect(() => {
    // В dev воркера нет: он кэшировал бы модули Vite и ломал горячую замену.
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
    const base = import.meta.env.BASE_URL
    const sw = navigator.serviceWorker
    // Контроллера не было — это первая установка воркера, а не обновление,
    // и плашке тут сказать нечего.
    const had = !!sw.controller
    const onChange = () => { if (had) setFresh(true) }
    sw.addEventListener('controllerchange', onChange)

    let reg: ServiceWorkerRegistration | undefined
    const check = () => { if (document.visibilityState === 'visible') reg?.update().catch(() => {}) }
    sw.register(`${base}sw.js`, { scope: base }).then(r => { reg = r }).catch(() => {})

    // Возврат из фона — главный момент проверки: установленное приложение
    // живёт неделями без перезагрузки. Таймер — для открытого подолгу экрана.
    document.addEventListener('visibilitychange', check)
    const timer = window.setInterval(check, 30 * 60 * 1000)
    return () => {
      sw.removeEventListener('controllerchange', onChange)
      document.removeEventListener('visibilitychange', check)
      clearInterval(timer)
    }
  }, [])

  // Воркер уже активен и уже отдаёт новые файлы — перезагрузить достаточно.
  if (!fresh) return null
  return () => location.reload()
}
