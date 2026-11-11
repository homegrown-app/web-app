// Обновление установленного приложения.
//
// Сервис-воркер (его пишет сборка, см. pwaWorker в vite.config.ts) открывает
// приложение из кэша, а новую сборку скачивает в фоне. Установленное на
// рабочий стол приложение iOS не перезагружается при возврате из фона,
// поэтому без плашки человек сидел бы на старой версии днями.
//
// Новая версия показывается плашкой «New version available · Reload» —
// перезагружает только человек. Плашка и в установленном приложении, и во
// вкладке: раньше во вкладке версия включалась молча, и после деплоя было
// непонятно, что уже загружено.
//
// Признаков новой версии ДВА, и второй главный.
//
// 1. Смена контроллера: новый воркер скачался, включился (skipWaiting) и забрал
//    открытую страницу. В хроме это происходит через полсекунды после запуска,
//    и плашка появляется сразу.
//
// 2. Прямая сверка с сервером. Признака №1 одного мало: он срабатывает только
//    когда браузер сам сходил за новым sw.js. iOS в установленном приложении
//    ходит за ним на своё усмотрение, и после деплоя человек неделю сидел на
//    старой сборке, не видя никакой плашки. Поэтому при запуске, при возврате
//    из фона и раз в полчаса приложение само спрашивает сервер: «файл бандла,
//    который я сейчас выполняю, ещё есть в свежей сборке?» Имя файла содержит
//    хеш его содержимого, так что ответ точный.
//
//    Спрашиваем у sw.js: в нём лежит список файлов сборки, и он единственный
//    файл, который воркер НЕ кладёт себе в кэш, — значит запрос честно уходит
//    в сеть и сквозь уже установленный у человека старый воркер тоже.
//
// Перезагрузка по кнопке сносит кэш сборки: без этого старый воркер отдал бы
// ту же самую страницу из кэша, и плашка вернулась бы на том же месте.

import { useEffect, useState } from 'react'

/**
 * Файлы, на которые ссылается открытая страница: бандл и стили. В имени
 * каждого — хеш содержимого, так что набор имён и есть «какая сборка открыта».
 * Берём из документа, а не из import.meta.url: правка одного только CSS имя
 * бандла не меняет, и такой деплой прошёл бы мимо плашки.
 */
function mine(): string[] {
  const nodes = [
    ...document.querySelectorAll<HTMLScriptElement>('script[type="module"][src]'),
    ...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]'),
  ]
  const names = nodes.map(n => ('src' in n ? n.src : n.href).split('/').pop() || '')
  return names.filter(n => /-[A-Za-z0-9_-]{8}\.(js|css)$/.test(n))
}

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
    const me = mine()

    // Сверка с сервером. Ошибка сети — не повод для плашки: молчим.
    const ask = async () => {
      if (!me.length) return
      try {
        const r = await fetch(`${base}sw.js`, { cache: 'no-store' })
        const txt = await r.text()
        // Отвечает именно наш воркер, а не страница ошибки хостинга: иначе
        // «моих файлов там нет» означало бы только «ответ не тот».
        if (!r.ok || !txt.includes("'hg-react-'")) return
        if (me.some(n => !txt.includes(n))) setFresh(true)
      } catch { /* офлайн */ }
    }

    const check = () => {
      if (document.visibilityState !== 'visible') return
      reg?.update().catch(() => {})
      ask()
    }
    sw.register(`${base}sw.js`, { scope: base }).then(r => { reg = r }).catch(() => {})
    ask()

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

  if (!fresh) return null
  return () => {
    // Сносим кэш сборки и добираем свежий index.html мимо кэша браузера
    // (GitHub Pages отдаёт его с max-age=600). Иначе перезагрузка вернула бы
    // ту же страницу, и плашка появилась бы снова.
    const wipe = async () => {
      try {
        const ks = await caches.keys()
        await Promise.all(ks.filter(k => k.startsWith('hg-react-')).map(k => caches.delete(k)))
        await fetch(location.href, { cache: 'reload' })
      } catch { /* нет caches или нет сети — перезагрузка всё равно нужна */ }
      location.reload()
    }
    wipe()
  }
}
