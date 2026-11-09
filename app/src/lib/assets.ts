// Фото лежат в /img у корня репозитория и НЕ дублируются в public: их 4.5 МБ.
// База сборки — /web-app/react/, значит корень ассетов на уровень выше.
// В dev-сервере base = '/', и фото берутся из ../img относительно app/.
const BASE = import.meta.env.BASE_URL // '/web-app/react/' в сборке, '/' в dev

export const ASSET_ROOT = BASE.endsWith('react/')
  ? BASE.slice(0, -'react/'.length)
  : BASE

/** Путь к фото вида или журнала: img('radish') -> '/web-app/img/radish.jpg' */
export const img = (name: string) => `${ASSET_ROOT}img/${name}.jpg`

/** Вырезанное фото без фона для колодца онбординга:
    cut('tomato') -> '/web-app/img/cut-tomato.webp' */
export const cut = (name: string) => `${ASSET_ROOT}img/cut-${name}.webp`

/** CSS-значение для background-image. Пустое имя даёт 'none', а не битую ссылку. */
export const bg = (name: string | null | undefined) =>
  name ? `url(${img(name)})` : 'none'

/**
 * Какая именно сборка загружена. Имя файла бандла содержит хеш его содержимого,
 * то есть отвечает на вопрос точно и совпадает с тем, что видно снаружи обычным
 * curl по index.html. Дата рядом — из коммита, её подставляет сборка.
 */
export function buildId(): string {
  const m = /index-([A-Za-z0-9_-]+)\.js/.exec(import.meta.url)
  return `${m ? m[1] : 'dev'} · ${__BUILD__}`
}
