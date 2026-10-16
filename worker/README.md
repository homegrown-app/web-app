# Прокси распознавания растений

Ключ PlantNet нельзя положить в `index.html` — репозиторий публичный, ключ утечёт
и квоту исчерпают за сутки. Поэтому запрос идёт через воркер, который держит ключ
секретом.

## Что нужно один раз

**1. Получить ключ PlantNet** — https://my.plantnet.org/ → Sign up → API key.
Бесплатный тариф: 500 запросов в день, некоммерческое использование.

**2. Развернуть воркер** (нужен аккаунт Cloudflare, бесплатного тарифа хватает):

```bash
cd worker
npx wrangler login
npx wrangler secret put PLANTNET_KEY   # вставить ключ в приглашении
npx wrangler deploy
```

Команда напечатает адрес вида `https://homegrown-plantid.<subdomain>.workers.dev`.

**3. Прописать адрес в прототипе** — `scan-config.js` в корне и `python3 proto.py`.
React-версия этот воркер не использует: она узнаёт растения на телефоне
(`app/src/lib/recognize.ts`).

## Пока адрес не задан

Приложение честно говорит, что распознавание не подключено, и предлагает выбрать
культуру руками через поиск. Ничего не ломается.

## Проверить, что воркер жив

```bash
curl -F images=@../img/basil.jpg -F organs=leaf https://homegrown-plantid.<subdomain>.workers.dev
```

Ответ — JSON со списком видов и score.
