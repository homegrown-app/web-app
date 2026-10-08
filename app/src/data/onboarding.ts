// Константы онбординга и настроек. Перенесены из proto.py без изменений
// значений: тексты опций, теги целей, ранги света, цены горшков.

import { NO_AUTH } from '../lib/demo'

export type Track = 'house' | 'edible' | 'both'

/** Варианты места. Третий элемент — куда ведёт ответ: q2 наружу, q2i внутрь. */
export const SPACES: Record<Track, Array<[string, string | null, string]>> = {
  house: [['Living room', 'The usual spot — bright but not direct', 'q2i'],
          ['Bedroom', 'Low light, steady temperature', 'q2i'],
          ['Kitchen', 'Warm, humid, good for most things', 'q2i'],
          ['Bathroom', 'High humidity, often low light', 'q2i'],
          ['Home office', 'Desk-side, artificial light too', 'q2i'],
          ['Windowsill', 'The brightest shelf you have', 'q2i']],
  edible: [['Patio', null, 'q2'], ['Deck', null, 'q2'], ['Porch', null, 'q2'],
           ['Backyard', null, 'q2'], ['Raised bed', null, 'q2'],
           ['Apartment balcony', null, 'q2'],
           ['Windowsill / indoors', 'Herbs and greens, year-round', 'q2i']],
  both: [['Living room', 'Plants inside, herbs on the sill', 'q2i'],
         ['Kitchen', 'Warm and humid — herbs do well', 'q2i'],
         ['Windowsill', 'The brightest shelf you have', 'q2i'],
         ['Patio', 'Pots outside, plants inside', 'q2'],
         ['Balcony', 'Containers out, greenery in', 'q2'],
         ['Backyard', 'Beds outside, plants inside', 'q2']],
}

export const GOALS: Record<Track, Array<[string, string]>> = {
  house: [['Hard to kill', 'hardy'], ['Low light room', 'lowlight'],
          ['A big statement plant', 'statement'], ['Flowers', 'flowers'],
          ['Trailing and hanging', 'trailing'], ['Cleaner air', 'air'],
          ['Kid-friendly project', 'kids']],
  edible: [['Salads and greens', 'salads'], ['Fresh herbs', 'herbs'],
           ['Fast first harvest', 'fast'], ['Tomatoes', 'tomatoes'],
           ['Peppers', 'peppers'], ['Beans and peas', 'beans'],
           ['Roots: radish, carrot', 'roots'], ['Kid-friendly project', 'kids']],
  both: [['Hard to kill', 'hardy'], ['Fresh herbs', 'herbs'],
         ['Salads and greens', 'salads'], ['A big statement plant', 'statement'],
         ['Fast first harvest', 'fast'], ['Flowers', 'flowers'],
         ['Cleaner air', 'air'], ['Kid-friendly project', 'kids']],
}

export const Q4TITLE: Record<Track, string> = {
  house: 'What are you after?', edible: 'What do you want to eat?', both: 'What are you after?',
}

export const SUNLABEL: Record<string, string> = {
  '3–5 hours': '3–5 hours of sun', '6–8 hours': '6–8 hours of sun',
  '8+ hours': '8+ hours of sun', 'Not sure yet': 'a safe 3–5 hours until you check',
  South: 'a south-facing window', 'East or West': 'an east or west window',
  North: 'a north window', 'Not sure': 'a cautious low-light start',
}
export const SUNRANK: Record<string, number> = {
  '3–5 hours': 1, '6–8 hours': 2, '8+ hours': 3, 'Not sure yet': 1,
  South: 2, 'East or West': 1, North: 1, 'Not sure': 1,
}
export const GOALWORD: Record<string, string> = {
  salads: 'salads', herbs: 'herbs', fast: 'a fast first harvest', tomatoes: 'tomatoes',
  peppers: 'peppers', beans: 'beans', roots: 'root crops', kids: 'a kid project',
  hardy: 'something hard to kill', lowlight: 'plants for a dim room',
  statement: 'a statement plant', flowers: 'flowers', trailing: 'trailing greenery',
  air: 'cleaner air', petsafe: 'pet-safe plants', useful: 'a plant that earns its keep',
}
export const SUNNEED: Record<string, string> = {
  tomatoes: '6–8 hours', peppers: '6–8 hours', beans: '6–8 hours',
}
export const TRACKOF: Record<string, Track> = {
  Houseplants: 'house', 'Something to eat': 'edible', Both: 'both',
}
export const TRACKWORD: Record<Track, string> = {
  house: 'Houseplants', edible: 'Edible crops', both: 'Houseplants and edibles',
}
export const LIBNOTE: Record<Track, string> = {
  house: 'Survives an ordinary room',
  edible: 'Finishes in one season',
  both: 'Houseplants, then edible',
}

/** Уличные места. Только они включают outdoor и вопрос про ZIP. */
const OUTDOOR = ['Patio', 'Deck', 'Porch', 'Backyard', 'Raised bed',
                 'Apartment balcony', 'Balcony']
export const isOutdoorSpace = (label: string) => OUTDOOR.indexOf(label) > -1

export function goalTag(label: string): string | null {
  const all = [...GOALS.house, ...GOALS.edible, ...GOALS.both]
  const hit = all.find(o => o[0] === label)
  return hit ? hit[1] : null
}

// ⚠ Цитата — ПЛЕЙСХОЛДЕР. Настоящий отзыв надо получить у реального человека
// с его согласия, выдумывать его нельзя.
export const QUOTE: Record<'house' | 'edible', [string, string, string]> = {
  house: ['Start with one plant that forgives you. A pothos will tell you it is thirsty and '
        + 'come back from it — that is the whole lesson, and it costs eight dollars.',
          'Placeholder name', 'Plant shop owner · sample quote'],
  edible: ['Radish and leaf lettuce are what we hand every first-timer — they finish before '
        + 'anyone has time to lose interest. The container sizes here are the ones we recommend.',
          'Placeholder name', 'Extension master gardener · sample quote'],
}

export const FEATS = [
  'Every week planned, not just this one',
  // В демо лимита нет — обещать «без потолка в три» как платное было бы неправдой.
  NO_AUTH ? 'Every plant in the library' : 'Every plant in the library, no cap of three',
  'Printable shopping list as PDF',
  'Unlimited journal photos + yearly recap',
  'Export your whole care history',
]

/** Экраны онбординга и путь точек прогресса для каждой ветки. */
export const ONB = ['q0', 'qwhat', 'q1', 'q2', 'q3', 'q2i', 'q4', 'q5']
export const STEPS: Record<string, string[]> = {
  plan_out: ['q0', 'qwhat', 'q1', 'q2', 'q3', 'q4', 'q5'],
  plan_in: ['q0', 'qwhat', 'q1', 'q2i', 'q4', 'q5'],
  own_out: ['q0', 'add-plant', 'q1', 'q2', 'q3'],
  own_in: ['q0', 'add-plant', 'q1', 'q2i'],
}

// ── настройки
export const SPACE_OPTS: Record<Track, string[]> = {
  house: ['living room', 'bedroom', 'kitchen', 'bathroom', 'home office', 'windowsill'],
  edible: ['patio', 'deck', 'porch', 'backyard', 'raised bed', 'balcony', 'windowsill'],
  both: ['living room', 'kitchen', 'windowsill', 'patio', 'balcony', 'backyard'],
}
// Свет живёт в двух разных доменах: часы солнца снаружи, сторона окна внутри.
export const LIGHT_IN = ['a south-facing window', 'an east or west window', 'a north window']
export const LIGHT_OUT = ['3–5 hours of sun', '6–8 hours of sun', '8+ hours of sun']
export const LIGHT_RANK_IN: Record<string, number> = {
  'a south-facing window': 2, 'an east or west window': 1, 'a north window': 1,
}
export const LIGHT_RANK_OUT: Record<string, number> = {
  '3–5 hours of sun': 1, '6–8 hours of sun': 2, '8+ hours of sun': 3,
}
export const REMIND_AT = ['07:00', '09:00', '12:00', '18:00', '21:00']

export const POTPRICE: Record<string, number> = {
  '6 inch': 6, '8 inch': 8, '10 inch': 12, '12 inch': 16, tray: 4,
  '1 pint': 3, '1 quart': 4, '0.5 gal': 5, '1 gal': 7, '2 gal': 10, '3 gal': 13, '5 gal': 18,
}

export const PICKS: Record<string, { title: string; note: string }> = {
  space: { title: 'Where it lives', note: 'Changes what the library offers you.' },
  zip: { title: 'Your ZIP', note: 'Frost dates decide what can go outside and when.' },
  light: { title: 'How much light', note: 'The single biggest filter on what will actually finish.' },
  effort: { title: 'Time per week', note: 'Sets how many plants the plan holds.' },
  units: { title: 'Units', note: 'Applies to pot sizes across the whole app.' },
  remind: { title: 'Remind me at', note: 'One notification a day, at this time.' },
}

// латинское имя → id вида. Ключи — род или вид, как их отдаёт PlantNet.
export const LATIN: Record<string, string> = {
  'Monstera deliciosa': 'monstera', Monstera: 'monstera',
  'Dracaena trifasciata': 'snakeplant', 'Sansevieria trifasciata': 'snakeplant',
  'Epipremnum aureum': 'pothos', Epipremnum: 'pothos',
  'Zamioculcas zamiifolia': 'zzplant', Zamioculcas: 'zzplant',
  'Ficus lyrata': 'fiddleleaf', Ficus: 'fiddleleaf',
  'Spathiphyllum wallisii': 'peacelily', Spathiphyllum: 'peacelily',
  'Aloe vera': 'aloe', Aloe: 'aloe',
  'Goeppertia orbifolia': 'calathea', Goeppertia: 'calathea', Calathea: 'calathea',
  'Ocimum basilicum': 'basil', Ocimum: 'basil',
  'Raphanus sativus': 'radish', Raphanus: 'radish',
  'Lactuca sativa': 'lettuce', Lactuca: 'lettuce',
  'Coriandrum sativum': 'cilantro', Coriandrum: 'cilantro',
  'Petroselinum crispum': 'parsley', Petroselinum: 'parsley',
  'Allium tuberosum': 'chives', 'Allium schoenoprasum': 'chives',
  'Allium fistulosum': 'onions', 'Allium cepa': 'onions', Allium: 'onions',
  'Solanum lycopersicum': 'cherrytomato', 'Lycopersicon esculentum': 'cherrytomato',
  'Solanum melongena': 'eggplant',
  'Capsicum annuum': 'pepper', Capsicum: 'pepper',
  'Cucumis sativus': 'cucumber', Cucumis: 'cucumber',
  'Cucurbita pepo': 'squash', Cucurbita: 'squash',
  'Beta vulgaris': 'chard', Beta: 'beets',
  'Daucus carota': 'carrots', Daucus: 'carrots',
  'Brassica oleracea': 'kale', 'Brassica juncea': 'mustard',
  'Brassica rapa': 'turnips', Brassica: 'kale',
  'Phaseolus vulgaris': 'beans', Phaseolus: 'beans',
}
