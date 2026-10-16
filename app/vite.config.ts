import { execSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Метка сборки. Появилась после вечера, потраченного на вопрос «а эта версия
// уже с правками?»: приложение открывают с телефона, с симулятора и с ноутбука,
// и отличить свежую страницу от страницы из кэша браузера было нечем, кроме
// инструментов разработчика. Теперь номер сборки написан внизу настроек.
function stamp(): string {
  try {
    // Дата коммита, и только она. Ни времени сборки (оно делало бы каждую сборку
    // отличной от предыдущей и убило проверку «пересборка не даёт диффа»), ни
    // короткого sha: собираем ДО коммита, поэтому sha назвал бы РОДИТЕЛЯ — ровно
    // та путаница, против которой метка и заводится. Кто именно загружен,
    // отвечает хеш бандла (см. buildId в src/lib/assets.ts).
    //
    // --date=short, потому что аргумент уходит через шелл: любой пробел в формате
    // распадается на два аргумента, git падает, и метка молча становится 'dev'.
    return execSync('git log -1 --format=%cd --date=short', { encoding: 'utf8' }).trim()
  } catch {
    return 'dev'          // собирают не из репозитория — не повод падать
  }
}

// Собираемся в /react у корня репозитория: GitHub Pages раздаёт корень, а живой
// прототип index.html остаётся на месте и не задет.
// Фото (4.5 МБ) не дублируем в public — они лежат в /img и берутся оттуда,
// см. src/lib/assets.ts. Шрифты (164 КБ) продублированы, потому что @font-face
// в собранном CSS не может ссылаться на путь за пределами базы.
// В dev корень репозитория лежит выше корня проекта, поэтому отдаём его сами:
// оттуда берутся фото (4.5 МБ, дублировать в public не станем) и сам прототип —
// он нужен в iframe на маршруте /review для сверки бок о бок.
// В сборке этого не требуется: на Pages и /web-app/img, и /web-app/index.html
// раздаются как есть.
const MIME: Record<string, string> = {
  '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript',
  '.json': 'application/json', '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
}
function serveRepoRoot() {
  return {
    name: 'serve-repo-root',
    configureServer(server: import('vite').ViteDevServer) {
      server.middlewares.use((req, res, next) => {
        const m = req.url?.match(/^\/web-app\/(?!react\/)(.+)$/)
        if (!m) return next()
        const rel = m[1].split('?')[0]
        const file = path.resolve(__dirname, '..', rel)
        // не выпускаем за пределы репозитория
        if (!file.startsWith(path.resolve(__dirname, '..'))) return next()
        if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return next()
        res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream')
        fs.createReadStream(file).pipe(res)
      })
    },
  }
}

// Сервис-воркер из sw.template.js: список файлов сборки и версия — хеш их
// содержимого. Пересборка без изменений даёт тот же sw.js, значит браузер не
// увидит «новой версии», которой нет. Зачем воркер — src/lib/pwa.ts.
function pwaWorker() {
  let out = ''
  return {
    name: 'pwa-worker',
    apply: 'build' as const,
    configResolved(c: import('vite').ResolvedConfig) { out = path.resolve(c.root, c.build.outDir) },
    closeBundle() {
      const files: string[] = []
      const walk = (dir: string) => {
        for (const n of fs.readdirSync(dir).sort()) {
          const f = path.join(dir, n)
          if (fs.statSync(f).isDirectory()) walk(f)
          else if (n !== 'sw.js') files.push(path.relative(out, f).split(path.sep).join('/'))
        }
      }
      walk(out)
      const h = createHash('sha1')
      for (const f of files) h.update(f).update(fs.readFileSync(path.join(out, f)))
      const sw = fs.readFileSync(path.resolve(__dirname, 'sw.template.js'), 'utf8')
        .replace('__VERSION__', h.digest('hex').slice(0, 10))
        .replace('__FILES__', JSON.stringify(files))
      fs.writeFileSync(path.join(out, 'sw.js'), sw)
    },
  }
}

export default defineConfig({
  plugins: [react(), serveRepoRoot(), pwaWorker()],
  define: { __BUILD__: JSON.stringify(stamp()) },
  base: '/web-app/react/',
  build: {
    outDir: '../react',
    emptyOutDir: true,
  },
})
