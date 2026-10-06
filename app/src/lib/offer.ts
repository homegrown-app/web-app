// Баннер «Unlock the full care plan» можно закрыть. Решение помнится на
// устройстве и действует на всех экранах с баннером. Pro после этого остаётся
// в настройках — туда ведёт тост, который показывается при закрытии.
import { useSyncExternalStore } from 'react'

const KEY = 'hg.ofrOff'
const subs = new Set<() => void>()
const read = () => { try { return localStorage.getItem(KEY) === '1' } catch { return false } }

export function dismissOffer() {
  try { localStorage.setItem(KEY, '1') } catch { /* приватный режим: закроется до перезагрузки */ }
  off = true
  subs.forEach(f => f())
}
let off = read()
export const useOfferOff = () => useSyncExternalStore(
  f => { subs.add(f); return () => { subs.delete(f) } },
  () => off,
)
