// Секрет для «Sign in with Apple» в Supabase → Authentication → Providers → Apple.
//
// Apple не выдаёт постоянный client secret: это JWT, подписанный ключом .p8, и
// живёт он не дольше 180 дней. Потом вход через Apple молча перестаёт работать —
// скрипт надо прогнать заново и вставить новый секрет в то же поле.
//
//   node tools/apple-secret.mjs <AuthKey_XXXX.p8> <TEAM_ID> <KEY_ID> <SERVICES_ID>
//
// Ключ .p8 в репозиторий не кладётся и в переписку не отправляется: скрипт
// читает его с диска и печатает только готовый JWT.

import { readFileSync } from 'node:fs'
import { createPrivateKey, sign } from 'node:crypto'

const [p8, team, kid, sub] = process.argv.slice(2)
if (!sub) {
  console.error('usage: node tools/apple-secret.mjs <AuthKey.p8> <TEAM_ID> <KEY_ID> <SERVICES_ID>')
  process.exit(1)
}

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url')
const now = Math.floor(Date.now() / 1000)
const exp = now + 180 * 24 * 3600 - 60

const head = b64({ alg: 'ES256', kid })
const body = b64({ iss: team, iat: now, exp, aud: 'https://appleid.apple.com', sub })
// ieee-p1363: JWT ждёт подпись r||s, а Node по умолчанию отдаёт DER.
const sig = sign('sha256', Buffer.from(head + '.' + body),
  { key: createPrivateKey(readFileSync(p8)), dsaEncoding: 'ieee-p1363' }).toString('base64url')

console.log(head + '.' + body + '.' + sig)
console.error('Истекает ' + new Date(exp * 1000).toISOString().slice(0, 10) + ' — к этой дате прогнать заново.')
