// Распознавание растения по снимку. Перенесено из прототипа (proto.py, identify
// и matchSpecies): запрос идёт в PlantNet через воркер-прокси из worker/, ключ
// живёт секретом воркера и в клиент не попадает.
//
// Адрес воркера — SCAN_ENDPOINT. Пусто = распознавание выключено: экран скана
// честно об этом пишет и предлагает выбрать вид в библиотеке, ничего не угадывая.
// Как развернуть воркер и получить адрес — worker/README.md.

import { SP, SPECIES, type Species } from '../data/species'

export const SCAN_ENDPOINT = ''

/** Урезанный ответ воркера: вид, род, обиходные имена и score 0…1. */
interface Hit { score: number; latin?: string; genus?: string; common?: string[] }

export type ScanResult =
  | { t: 'match'; sp: Species; pct: number; latin: string; common: string }
  | { t: 'foreign'; pct: number; latin: string; common: string }   // распознан, но не наш вид
  | { t: 'none' }                                                    // PlantNet не узнал
  | { t: 'offline' }                                                 // воркер недоступен

// Латынь → наш вид. Сначала точный вид, потом род как запасной.
const LATIN: Record<string, string> = {
  'Monstera deliciosa': 'monstera', 'Monstera': 'monstera',
  'Dracaena trifasciata': 'snakeplant', 'Sansevieria trifasciata': 'snakeplant',
  'Epipremnum aureum': 'pothos', 'Epipremnum': 'pothos',
  'Zamioculcas zamiifolia': 'zzplant', 'Zamioculcas': 'zzplant',
  'Ficus lyrata': 'fiddleleaf', 'Ficus': 'fiddleleaf',
  'Spathiphyllum wallisii': 'peacelily', 'Spathiphyllum': 'peacelily',
  'Aloe vera': 'aloe', 'Aloe': 'aloe',
  'Goeppertia orbifolia': 'calathea', 'Goeppertia': 'calathea', 'Calathea': 'calathea',
  'Ocimum basilicum': 'basil', 'Ocimum': 'basil',
  'Raphanus sativus': 'radish', 'Raphanus': 'radish',
  'Lactuca sativa': 'lettuce', 'Lactuca': 'lettuce',
  'Coriandrum sativum': 'cilantro', 'Coriandrum': 'cilantro',
  'Petroselinum crispum': 'parsley', 'Petroselinum': 'parsley',
  'Allium tuberosum': 'chives', 'Allium schoenoprasum': 'chives',
  'Allium fistulosum': 'onions', 'Allium cepa': 'onions', 'Allium': 'onions',
  'Solanum lycopersicum': 'cherrytomato', 'Lycopersicon esculentum': 'cherrytomato',
  'Solanum melongena': 'eggplant',
  'Capsicum annuum': 'pepper', 'Capsicum': 'pepper',
  'Cucumis sativus': 'cucumber', 'Cucumis': 'cucumber',
  'Cucurbita pepo': 'squash', 'Cucurbita': 'squash',
  'Beta vulgaris': 'chard', 'Beta': 'beets',
  'Daucus carota': 'carrots', 'Daucus': 'carrots',
  'Brassica oleracea': 'kale', 'Brassica juncea': 'mustard',
  'Brassica rapa': 'turnips', 'Brassica': 'kale',
  'Phaseolus vulgaris': 'beans', 'Phaseolus': 'beans',
}

export function matchSpecies(r: Hit): Species | null {
  const byLatin = LATIN[r.latin ?? ''] || LATIN[r.genus ?? '']
  if (byLatin) return SP(byLatin) ?? null
  // Подстраховка по обиходному имени. Только безопасное направление: обиходное
  // имя целиком содержит наше. Обратное давало 'Pea' → Peace lily и '' → первый вид.
  const names = (r.common ?? []).map(n => (n || '').toLowerCase().trim()).filter(n => n.length >= 4)
  return SPECIES.find(sp => {
    const n = sp.name.toLowerCase()
    return names.some(c => c === n || (c.indexOf(n) > -1 && c.length - n.length <= 12))
  }) ?? null
}

export async function identify(photo: string): Promise<ScanResult> {
  try {
    const fd = new FormData()
    fd.append('images', await (await fetch(photo)).blob(), 'plant.jpg')
    fd.append('organs', 'auto')
    const res = await fetch(SCAN_ENDPOINT, { method: 'POST', body: fd })
    const data = await res.json() as { results?: Hit[]; error?: string }
    const top = data.results?.[0]
    if (data.error || !top) return { t: 'none' }
    const pct = Math.round((top.score || 0) * 100)
    const latin = top.latin || '—'
    const common = top.common?.[0] ?? ''
    const sp = matchSpecies(top)
    return sp ? { t: 'match', sp, pct, latin, common } : { t: 'foreign', pct, latin, common }
  } catch {
    return { t: 'offline' }
  }
}
