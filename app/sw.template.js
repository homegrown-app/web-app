// Сервис-воркер React-версии. Шаблон: сборка (pwaWorker в vite.config.ts)
// подставляет версию и список файлов и кладёт результат в react/sw.js.
//
// Схема обычная для PWA: приложение открывается из кэша, новая сборка
// скачивается в фоне и ЖДЁТ. Включает её сообщение 'skip' со страницы —
// плашка «Update» в установленном приложении или молча во вкладке (src/lib/pwa.ts).
// Корневой ../sw.js прототипа сюда не ходит: он пропускает всё под /react/.

const VERSION = '__VERSION__'
const CACHE = 'hg-react-' + VERSION
const FILES = __FILES__
const SCOPE = new URL(self.registration.scope)
const at = f => new URL(f, SCOPE).href

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(at))))
})

self.addEventListener('message', e => { if (e.data === 'skip') self.skipWaiting() })

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
