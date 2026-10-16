/**
 * HOMEGROWN — прокси для распознавания растений.
 *
 * Зачем он нужен: сайт статический и публичный, поэтому ключ PlantNet нельзя
 * положить в клиент — его сразу заберут и исчерпают квоту. Ключ живёт секретом
 * воркера и наружу не выходит.
 *
 * Приложение шлёт сюда multipart с полем `images`, воркер добавляет ключ,
 * ходит в PlantNet и возвращает урезанный ответ: только вид, имена и score.
 */
const ALLOWED = [
  'https://homegrown-app.github.io',
  'http://localhost:5179',
  'http://localhost:8000',
];

function cors(origin) {
  const ok = ALLOWED.includes(origin) ? origin : ALLOWED[0];
  return {
    'Access-Control-Allow-Origin': ok,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors(origin) });
    if (request.method !== 'POST')
      return new Response('POST only', { status: 405, headers: cors(origin) });
    if (!env.PLANTNET_KEY)
      return Response.json({ error: 'PLANTNET_KEY not set' }, { status: 500, headers: cors(origin) });

    const form = await request.formData();
    const image = form.get('images');
    if (!image) return Response.json({ error: 'no image' }, { status: 400, headers: cors(origin) });

    const out = new FormData();
    out.append('images', image, 'plant.jpg');
    out.append('organs', form.get('organs') || 'auto');

    const url = 'https://my-api.plantnet.org/v2/identify/all'
      + '?include-related-images=false&no-reject=false&lang=en'
      + '&api-key=' + env.PLANTNET_KEY;

    const res = await fetch(url, { method: 'POST', body: out });
    if (!res.ok) {
      const text = await res.text();
      return Response.json({ error: 'plantnet ' + res.status, detail: text.slice(0, 300) },
        { status: res.status === 404 ? 200 : 502, headers: cors(origin) });
    }
    const data = await res.json();
    const results = (data.results || []).slice(0, 5).map(r => ({
      score: r.score,
      latin: r.species && r.species.scientificNameWithoutAuthor,
      genus: r.species && r.species.genus && r.species.genus.scientificNameWithoutAuthor,
      family: r.species && r.species.family && r.species.family.scientificNameWithoutAuthor,
      common: (r.species && r.species.commonNames) || [],
    }));
    return Response.json({ results }, { headers: cors(origin) });
  },
};
