// Сервис-воркер React-версии. Шаблон: сборка (pwaWorker в vite.config.ts)
// подставляет версию и список файлов и кладёт результат в react/sw.js.
//
// Приложение открывается из кэша, новая сборка скачивается в фоне.
//
// Скачав, воркер включается СРАЗУ (skipWaiting), а не ждёт нажатия. Ждал он
// того, что обязано приехать внутри новой сборки: пока человек не нажмёт
// «Reload», страница крутит старый код, и починка механизма обновления,
// выложенная на прод, до него не доезжает никогда. Выложили редизайн — все,
// кто уже открывал приложение, продолжали видеть старое.
//
// Плашка «New version available» остаётся и остаётся решением человека:
// claim() отдаёт открытой вкладке новые файлы, плашка говорит, что версия
// сменилась, перезагрузку он выбирает сам (src/lib/pwa.ts).
// Корневой ../sw.js прототипа сюда не ходит: он пропускает всё под /react/.

const VERSION = '8c7adb9483'
const CACHE = 'hg-react-' + VERSION
const FILES = ["assets/Garden3D-DIEVjilP.js","assets/OrbitControls-CNAiOW6D.js","assets/basil-BC-_2tu_.js","assets/cherrytomato-jxm97i-s.js","assets/index-BJcZCyu0.js","assets/index-BNPNOxMg.js","assets/index-Ba8O3vgQ.js","assets/index-BkZBT0MF.js","assets/index-CwYJNqcG.css","assets/index-DlnUuaYE.js","assets/index-K8ajHGwt.js","assets/lettuce-BXACHoIu.js","assets/radish-BdBFcr4M.js","assets/shared-Gr6fiojY.js","fonts/InterTight-400-latin-ext.woff2","fonts/InterTight-400-latin.woff2","index.html","manifest.webmanifest"]
const SCOPE = new URL(self.registration.scope)
const at = f => new URL(f, SCOPE).href

self.addEventListener('install', e => {
  // cache: 'reload' обязателен. addAll ходит через HTTP-кэш браузера, а
  // GitHub Pages отдаёт index.html с max-age=600 — воркер новой сборки клал
  // себе страницу десятиминутной давности со старыми хешами ассетов и честно
  // раздавал её как «новую версию». Снаружи это выглядело как невыложенный
  // деплой: на сервере лежит новая сборка, в браузере крутится прошлая.
  e.waitUntil(caches.open(CACHE)
    .then(c => c.addAll(FILES.map(f => new Request(at(f), { cache: 'reload' }))))
    .then(() => self.skipWaiting()))
})

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(ks => Promise.all(ks.filter(k => k.startsWith('hg-react-') && k !== CACHE)
                              .map(k => caches.delete(k))))
    .then(() => self.clients.claim()))
})

self.addEventListener('fetch', e => {
  const req = e.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  // Фото из /web-app/img, Supabase, PlantNet — мимо: только файлы этой сборки.
  if (url.origin !== SCOPE.origin || !url.pathname.startsWith(SCOPE.pathname)) return
  // Любой адрес внутри приложения — одна страница; хеш и ?code= после входа не важны.
  const key = req.mode === 'navigate' ? at('index.html') : req
  e.respondWith(caches.open(CACHE)
    .then(c => c.match(key, { ignoreSearch: true }))
    .then(r => r || fetch(req)))
})
