// Экран аккаунта. Отвечает на три вопроса, которые до него задать было некому:
// в какой я аккаунт вошёл, как именно я в него попал и что из моего уже лежит на
// сервере, а что пока только здесь.
//
// Цифры берутся из снимка последней отправки (lib/sync.ts), а не запросом: снимок
// И ЕСТЬ ответ на «что уже в базе», он лежит рядом с состоянием и читается
// мгновенно. Поэтому у экрана нет ни спиннера, ни состояния «не удалось».
//
// Sign out и Delete account переехали сюда с экрана настроек: там они висели
// среди тумблеров, а это не настройка, а действие над аккаунтом.
//
// ФОРМА — ЛИСТ, а не отдельный экран. Открывается он из настроек и возвращает
// туда же, то есть это не место в приложении, а слой над местом: настройки
// остаются видны за скримом, таб-бар — их. Форма ровно та же, что у приветствия
// и у подтверждения удаления: в приложении одна форма всплывающего слоя, и
// третья читалась бы как третья система.
//
// role=dialog, а НЕ alertdialog: alertdialog остаётся единственным и только на
// необратимом — на подтверждении удаления, которое приходит ПОВЕРХ этого листа.
// Выходов три и все равнозначны: крестик, тап по скриму, Escape.
//
// Маршрут #account сохранён. Лист рендерит App: увидев id === 'account', он
// показывает настройки, а лист кладёт сверху. Поэтому прямая ссылка, каталог
// /review и стенды продолжают работать, а go('settings') закрывает лист.

import { useEffect, useRef, useState } from 'react'
import { Confirm } from '../components/Confirm'
import { Icon } from '../icons/Icon'
import { bg } from '../lib/assets'
import { allPhotos } from '../lib/plants'
import { clearAuthError, markSignOut, supa } from '../lib/supabase'
import { forgetSnap, syncFacts, wipeCloud } from '../lib/sync'
import { useStore } from '../state/store'

type Go = (id: string) => void


const plural = (n: number, one: string) => `${n} ${n === 1 ? one : one + 's'}`


export function AccountScreen({ go }: { go: Go }) {
  const { s, d } = useStore()
  const [ask, setAsk] = useState(false)
  const acc = s.account
  const box = useRef<HTMLDivElement>(null)
  const close = () => go('settings')

  // Фокус на лист и Escape — как в приветствии: без этого с клавиатуры человек
  // остаётся в настройках под скримом. Пока открыто подтверждение удаления,
  // Escape отдаём ему: закрывать надо верхний слой, а не оба сразу.
  useEffect(() => {
    box.current?.focus()
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !ask) close() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ask])

  // Без аккаунта экрана нет: в настройках на его месте кнопка Sign in. Если
  // сюда пришли ссылкой — уводим, а не показываем пустую страницу.
  //
  // Проверка ОДИН РАЗ на входе, а не слежка за acc. Слежка перебивала переходы
  // самих действий: выход и удаление обнуляют аккаунт и сами уводят куда надо
  // (home и landing), а эффект успевал в том же коммите отправить в settings —
  // человек стирал всё и попадал в настройки вместо начала.
  useEffect(() => {
    if (!acc) go('settings')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (!acc) return null

  const f = syncFacts(s, acc.uid || null)
  const via = acc.via === 'google' ? 'Google'
            : acc.via === 'apple' ? 'Apple' : 'Email code'

  const signOut = async () => {
    // Выход нарочный: без метки приложение приняло бы его за умершую сессию и
    // сказало бы «the session expired» тому, кто сам нажал кнопку.
    markSignOut()
    // У демонстрационного входа сессии на сервере нет — закрывать нечего.
    // scope: 'local' — гасим ЭТО устройство, а не все сразу. По умолчанию
    // Supabase выходит глобально, и выход на телефоне молча выкидывал бы из
    // аккаунта на ноутбуке: там сессия теряла refresh-токен и человек снова
    // видел «Sign in», ничего не нажимав.
    // Выходим СНАЧАЛА у себя, и только потом сообщаем серверу. Порядок был
    // обратный, и это делало выход зависимым от сети: с мёртвым токеном или
    // офлайн запрос не отвечал, а всё, что стоит после await, не выполнялось —
    // человек нажал «Sign out» и остался вошедшим. Локальный выход обязан быть
    // мгновенным и безусловным, а сообщить серверу — побочное дело.
    // Снимок отправки привязан к аккаунту: оставить его — значит дать
    // следующему человеку на этом устройстве чужие id строк.
    forgetSnap()
    // И стираем объяснение. Метки времени тут недостаточно: SIGNED_OUT прилетает
    // и в другие контексты того же origin, а какой из них успеет раньше —
    // порядком не задано. Поэтому две независимые страховки: метка гасит запись
    // ДО, а этот вызов убирает запись ПОСЛЕ. Нарочный выход объясняется сам.
    clearAuthError()
    d({ t: 'signOut' })
    go('home')
    if (!acc.demo) {
      try { await (await supa()).auth.signOut({ scope: 'local' }) }
      catch { /* без сети сервер узнает при следующем входе */ }
    }
  }

  // Delete account убирает и копию в базе: без этого «Your plants go with it» —
  // ложь, при следующем входе сад приехал бы обратно.
  const wipe = () => {
    // Тоже нарочный выход — и здесь глобальный по делу: аккаунта больше нет,
    // и его сессии не должны жить ни на одном устройстве.
    markSignOut()
    // Метка ещё раз, вплотную к выходу: уборка в облаке не ждётся и на медленной
    // сети занимает секунды. Пока она идёт, окно от первой метки успевает
    // закрыться — и человеку, который сам удалил аккаунт, сообщали бы, что у
    // него истекла сессия.
    void supa().then(async sb => { await wipeCloud(sb); markSignOut(); await sb.auth.signOut() })
      .catch(() => { /* без сети уборка не состоялась: сад вернётся при входе */ })
    // Уводим ДО стирания: после d({t:'wipe'}) аккаунта уже нет, экран аккаунта
    // становится закрытым, и стена успевала перебить go('landing') на экран
    // входа. Порядок здесь — не косметика, а тот же класс гонки, что и в выходе.
    go('landing')
    d({ t: 'wipe' })
  }

  const photos = allPhotos(s.plants).length
  return (
    <>
      <div className="cf">
        <div className="cf-sc" onClick={close} aria-hidden="true" />
        <div className="cf-box cf-tall" role="dialog" aria-modal="true" aria-label="Account"
             tabIndex={-1} ref={box}>
          <div className="cf-head">
            <div className="cf-t">Account</div>
            <div className="xbtn" role="button" tabIndex={0} aria-label="Close"
                 onClick={close}
                 onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); close() } }}>
              {/* Цвет глифа --ink-2: без тёмной подложки светлый rgba(255,255,255,.8) давал
                  на листе 1.2:1 и просто исчезал. */}
              <Icon name="x" color="var(--ink-2)" size={17} sw={2} />
            </div>
          </div>

          <div className="acct">
            <div className="acc-who">
              <div className="acc-av" style={{ backgroundImage: bg('hero-plants') }} aria-hidden="true" />
              <div className="acc-tx">
                <b>{acc.email}</b>
                <s>Signed in with {via}{acc.demo ? ' · demo, not wired yet' : ''}</s>
              </div>
            </div>
          </div>

          {/* Карточки «Your data» здесь больше нет: три строки-факта («On the
              server», «Last synced», «Only on this phone») были инженерной
              версией того же, что нота ниже говорит человеческими словами.
              Владелец просил убрать карточку последней синхронизации — это она.
              Нота осталась: в ней настоящее объяснение, включая случай камерных
              фото и предупреждение про демо-вход. Цифры из снимка отправки
              никуда не делись, по ним по-прежнему выбирается ветка ноты. */}
          {acc.demo ? (
            <div className="note">
              <b>This sign-in is a demo</b>
              <p>The screens are real, the account is not: no code was sent and no server
                knows about it. Nothing syncs until you sign in with Google.</p>
            </div>
          ) : f.error ? (
            <div className="note">
              <b>Last sync did not go through</b>
              <p>{f.error}. Your plants are safe on this phone — the next change tries
                again on its own.</p>
            </div>
          ) : !f.at ? (
            <div className="note">
              <b>Nothing has gone up yet</b>
              <p>It happens by itself the moment you change something — water a plant,
                tick a task, edit a setting. There is no button to press.</p>
            </div>
          ) : f.localOnly > 0 ? (
            <div className="note">
              <b>Camera photos stay here for now</b>
              <p>They need file storage, which comes next. Plants, tasks and settings are
                already on the server and will follow you to another phone.</p>
            </div>
          ) : (
            <div className="note">
              <b>Open it anywhere</b>
              <p>Sign in with the same Google account on another phone or laptop and this
                garden is there — same plants, same schedule, same settings.</p>
            </div>
          )}

          <div className="btn b-ghost" role="button" tabIndex={0} style={{ marginTop: 16 }}
               onClick={signOut}
               onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void signOut() } }}>
            Sign out
          </div>
          <div className="dangernote" style={{ marginTop: 8 }}>
            Signing out leaves your plants on this phone.
          </div>

          <div className="danger" role="button" tabIndex={0}
               onClick={() => setAsk(true)}
               onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setAsk(true) } }}>
            Delete account
          </div>
          <div className="dangernote">Wipes your plants and settings here and on the
            server, and takes you back to the start.</div>
        </div>
      </div>
      {/* Подтверждение — СОСЕДОМ листа, а не внутри него: оно обязано лежать
          выше. z-index у обоих слоёв один (40), поэтому решает порядок в DOM, и
          скрим подтверждения гасит лист под собой. */}
      {ask && (
        <Confirm title="Delete everything?"
                 body={`${plural(s.plants.length, 'plant')}`
                     + (photos ? ` and ${plural(photos, 'photo')}` : '')
                     + ', your ZIP, your light and every reminder go with it — here and'
                     + ' on the server. This cannot be undone.'}
                 yes="Delete it all" no="Keep my plants"
                 onYes={wipe} onNo={() => setAsk(false)} />
      )}
    </>
  )
}
