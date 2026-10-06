// Библиотека и скан.
//
// Библиотека — ОДИН справочник на 29 видов: 8 комнатных и 21 съедобная культура.
// Показывается подмножество под трек и место; тем, чему не хватает света, ставим
// блок «Needs more light than you have» — погашено, а не спрятано.
//
// Скан: распознавание идёт по-настоящему через воркер-прокси, но если endpoint
// не задан, мы НЕ выдумываем ответ и не притворяемся, что это ошибка. Снимок
// сделан, человек выбирает вид сам, фото уезжает в журнал вместе с растением.

import { useMemo } from 'react'
import { Screen } from '../components/Chrome'
import { useCamera, useLiveCamera } from '../components/parts'
import { Note, SpThumb } from '../components/bits'
import { Icon, IcCheck, IcCheckG, IcPlus } from '../icons/Icon'
import { LIBNOTE } from '../data/onboarding'
import { SPECIES, ofKind, type Species } from '../data/species'
import { fitsLight, spSub } from '../lib/plan'
import { fmtPot, limit } from '../lib/plants'
import { useStore } from '../state/store'

type Go = (id: string) => void

function SpRow({ sp, have, pick, onAdd, note }:
    { sp: Species; have: boolean; pick: boolean; onAdd: () => void; note: string }) {
  const label = have ? `${sp.name} — already in your plants`
    : pick ? `Remove ${sp.name} from the selection` : `Add ${sp.name} to your plants`
  return (
    <div className={'pl' + (pick ? ' added' : '') + (have ? ' have' : '')}
         {...(have ? { 'aria-disabled': true } : { role: 'button', tabIndex: 0, onClick: onAdd })}
         aria-label={label}
         onKeyDown={e => {
           if (!have && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onAdd() }
         }}>
      <SpThumb s={sp} />
      <div className="nm"><b>{sp.name}</b><s>{note}</s></div>
      {/* Обе иконки лежат в разметке, как в прототипе: какая видна — решает CSS
          по классу .added. С одной иконкой правило гасило её саму. */}
      <div className="addbtn" aria-hidden="true">
        {have ? <IcCheckG /> : <><IcPlus /><IcCheck /></>}
      </div>
    </div>
  )
}

export function AddPlantScreen({ go }: { go: Go }) {
  const { s, d, pool } = useStore()
  const q = s.query.trim().toLowerCase()
  const own = s.onbMode === 'own'
  // Экран открыт КАК ШАГ онбординга, а не из приложения. Сюда приходят двумя
  // ветками: «уже есть растения» с q0 и «I’ll pick my own» с preview — и в обеих
  // регистрация ещё впереди. Проверять надо onbMode целиком, а не только 'own':
  // на плановой ветке все три выхода (назад, таб-бар и кнопка внизу) вели на
  // Home, то есть человек оказывался внутри приложения без аккаунта, а в
  // настройках висело «Sign in». Ровно эта жалоба и пришла.
  // applyPlan гасит onbMode сам, поэтому у прошедшего план флаг уже пуст.
  const onb = s.onbMode !== null
  const lim = limit(s.isPro)

  const groups = useMemo(() => {
    const match = (x: Species) => !q || x.name.toLowerCase().indexOf(q) > -1
      || (x.latin || '').toLowerCase().indexOf(q) > -1
      || x.tags.some(t => t.indexOf(q) > -1)
    const hit = pool.filter(match)
    // Вид, которому не хватает света, БОЛЬШЕ НЕ ГАСИТСЯ и не уезжает в отдельный
    // ящик «Needs more light than you have». Тап по нему работал и раньше, но
    // 50% прозрачности плюс отдельная секция внизу читались как «нельзя» — и
    // человек в онбординге видел половину справочника недоступной. Свет остаётся
    // фактом в подписи строки: это информация, а не запрет. Решает человек.
    const house = hit.filter(x => x.kind === 'house')
    const edible = hit.filter(x => x.kind === 'edible')
    // Оба вида доступны ВСЕГДА. Трек решает, что человек увидит первым, и
    // только это: выбор на первом экране онбординга не должен навсегда лишать
    // половины справочника. Внутри своего вида сохраняется прежнее деление —
    // комнатные по требовательности, съедобные по скорости.
    const houseGroups: Array<[string, Species[], boolean]> = [
      ['Hard to kill', house.filter(x => x.water >= 12), false],
      ['A bit more attention', house.filter(x => x.water < 12), false],
    ]
    const edibleLabel = s.choices.outdoor ? 'Edible — container crops'
                                          : 'Edible — windowsill crops'
    const edibleGroups: Array<[string, Species[], boolean]> = house.length && edible.length
      ? [[edibleLabel, edible, false]]
      : [['Fast wins', edible.filter(x => x.days <= 35), false],
         ['Worth the wait', edible.filter(x => x.days > 35), false]]
    const houseFirst = own ? false : s.choices.track === 'house'
    const out: Array<[string, Species[], boolean]> = houseFirst
      ? [...houseGroups, ...edibleGroups]
      : [...edibleGroups, ['Houseplants', house, false]]
    return { out: out.filter(g => g[1].length), empty: !hit.length }
  }, [pool, q, own, s.choices.track, s.choices.outdoor, s.choices.sunRank])

  const atLimit = !s.isPro && s.plants.length + s.pending.length >= lim
  const cta = own
    // в онбординге пустой выбор не тупик: можно пройти дальше и добавить позже
    ? (s.pending.length ? `Add ${s.pending.length} and continue` : 'Skip for now')
    : (s.pending.length ? `Add ${s.pending.length} to my plants` : 'Add to my plants')

  const submit = () => {
    if (!own && !s.pending.length) return
    d({ t: 'addPending' })
    // Онбординг «уже есть» продолжается: где растения живут и сколько там света.
    // Без этих двух шагов движок ухода считал по умолчанию «улица, 6–8 часов»
    // даже для монстеры в комнате, а точки прогресса обещали пять шагов из двух.
    go(own ? 'q1' : onb ? 'save' : 'home')
  }

  // На лимите строка не выбирается, а объяснение лежит в самом низу списка —
  // на экран оно не попадает. Тап должен отвечать сразу.
  const tapRow = (id: string) => {
    if (atLimit && s.pending.indexOf(id) < 0) {
      d({ t: 'toast', v: { html: '<span>Free plans keep 3 plants</span>', ms: 3500,
                           at: Date.now() } })
      return
    }
    d({ t: 'pendingToggle', v: id, limit: lim })
  }

  return (
    // Пока онбординг не пройден, таб-бара нет: из него можно было уйти на Home
    // мимо оставшихся шагов, и настройки ухода оставались пустыми.
    <Screen id="add-plant" back={() => go(own ? 'q0' : onb ? 'preview' : 'home')}
            nav={onb ? undefined : { active: 'Week', go }} scrollKey="add-plant"
            foot={
              <div className={'btn b-pri' + (own || s.pending.length ? '' : ' off')}
                   role="button" tabIndex={0} onClick={submit}>{cta}</div>
            }>
      <div className="h1" style={{ marginTop: 16 }}>{own ? 'What do you have?' : 'Add a plant'}</div>
      <div style={{ fontSize: 'var(--t-14)', color: 'var(--muted)', marginTop: 4 }}>
        {/* Подзаголовок обещал один вид («finishes in one season»), а в списке
            теперь оба — это было бы неправдой про половину списка. */}
        {own ? 'Everything we know how to look after' : LIBNOTE.both}
        {' · '}{s.pending.length ? `${s.pending.length} selected` : 'nothing selected'}
      </div>

      <div className="searchrow">
        <div className={'search' + (s.query ? ' has' : '')}>
          <span className="si" aria-hidden="true">
            <Icon name="search" color="#8E9A93" size={19} sw={2} />
          </span>
          <input type="search" inputMode="search" autoComplete="off" spellCheck={false}
                 aria-label="Search the plant library"
                 placeholder="Search by name or latin…"
                 value={s.query} onChange={e => d({ t: 'query', v: e.target.value })} />
          <span className="sx" role="button" tabIndex={0} aria-label="Clear search"
                onClick={() => d({ t: 'query', v: '' })}>
            <Icon name="x" color="#8E9A93" size={17} sw={2.4} />
          </span>
        </div>
        <div className="scanbtn" role="button" tabIndex={0}
             aria-label="Identify a plant by photo" onClick={() => go('scan')}>
          <Icon name="camera" color="#fff" size={22} />
        </div>
      </div>
      <div className="scanhint">
        Don’t know what it is?{' '}
        <b role="button" tabIndex={0} onClick={() => go('scan')}>Point the camera at it</b>
      </div>

      {s.scanKeep && (
        <div className="scanwait">
          <div className="sw-ph" style={{ backgroundImage: `url(${s.scanKeep})` }} />
          <div className="sw-tx"><b>Your photo is waiting</b>
            <s>Pick what it is and the shot goes into its journal.</s></div>
        </div>
      )}

      {groups.empty
        ? <div className="empty">
            Nothing matches “{s.query}”.<br />
            We know {SPECIES.length} plants — {ofKind('house').length} houseplants
            and {ofKind('edible').length} edible.
          </div>
        : groups.out.map(([label, list, dim]) => (
            <div key={label}>
              <div className="gsec">{label}</div>
              <div className="plist" style={dim ? { opacity: .5 } : undefined}>
                {list.map(sp => (
                  <SpRow key={sp.id} sp={sp}
                         note={spSub(sp, s.units, fmtPot)
                               + (fitsLight(sp, s.choices.sunRank)
                                  ? '' : ' · needs more light')}
                         have={s.plants.some(p => p.s.id === sp.id)}
                         pick={s.pending.indexOf(sp.id) > -1}
                         onAdd={() => tapRow(sp.id)} />
                ))}
              </div>
            </div>
          ))}

      {atLimit && (
        <Note title="That’s the free limit"
              cta={<div className="btn b-pri" role="button" tabIndex={0}
                        onClick={() => go('paywall')}>Unlock — $29/yr</div>}>
          Free plans keep 3 plants. Pro keeps everything your light and space allow —
          and the whole care calendar for all of them.
        </Note>
      )}

    </Screen>
  )
}

export function ScanScreen({ go }: { go: Go }) {
  const { s, d } = useStore()
  const cam = useCamera(url => d({ t: 'scanUrl', v: url }))
  // Живая камера в рамке, пока снимка нет; не дали — системная камера.
  const live = useLiveCamera(!s.scanUrl)
  const takePhoto = () => {
    const url = live.grab()
    if (url) d({ t: 'scanUrl', v: url })
    else cam.open()
  }
  // Распознавание подключается адресом воркера; в прототипе он пуст.
  const endpoint = (window as unknown as { HG_SCAN_ENDPOINT?: string }).HG_SCAN_ENDPOINT

  return (
    <div className="screen on" id="s-scan">
      <div className="dark" style={{ padding: 0 }}>
        {cam.input}
        <div className="scan-ov">
          {/* Рамка — окно камеры: до снимка в ней живое видео, после — кадр. */}
          <div className="booth-frame">
            {s.scanUrl && <div className="booth-media" style={{ backgroundImage: `url(${s.scanUrl})` }} />}
            <video ref={live.ref} className={'booth-media booth-live' + (live.on && !s.scanUrl ? ' on' : '')}
                   autoPlay playsInline muted />
            <div className={'scan-frame booth-border' + (s.scanUrl ? ' ok' : '')} />
          </div>
          <div className="scan-foot">
            {!s.scanUrl ? (
              <>
                <b>Point the camera at the plant</b>
                <s>One clear leaf fills the frame. We send the photo to PlantNet and match
                   the answer against our 29 species.</s>
                <div className="btn b-lime" role="button" tabIndex={0} onClick={takePhoto}>
                  Take a photo
                </div>
                <div className="btn" style={{ background: '#1B3527', color: '#fff' }}
                     role="button" tabIndex={0} onClick={() => go('add-plant')}>
                  Choose manually
                </div>
              </>
            ) : (
              <>
                <span className="pill b-lime" style={{ alignSelf: 'flex-start' }}>Photo saved</span>
                <b style={{ marginTop: 12 }}>Which one is it?</b>
                <s>
                  {endpoint
                    ? 'Recognition is connected — pick the match below or choose manually.'
                    : 'Automatic recognition is not switched on, so we won’t guess at your '
                      + 'plant. Pick it from the library and this photo becomes its first '
                      + 'journal shot.'}
                </s>
                {/* data-scanpick в прототипе: снимок надо донести до библиотеки,
                    чтобы он стал первой фотографией растения */}
                <div className="btn b-lime" role="button" tabIndex={0}
                     onClick={() => {
                       d({ t: 'scanKeep', v: s.scanUrl })
                       d({ t: 'scanUrl', v: null })
                       go('add-plant')
                     }}>Choose from the library</div>
                <div className="btn" style={{ background: '#1B3527', color: '#fff' }}
                     role="button" tabIndex={0} onClick={cam.open}>Try another photo</div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
