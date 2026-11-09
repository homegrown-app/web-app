// Порядок импорта CSS важен: токены → дизайн-система → мобильные оверрайды.
// Оверрайды идут последними, они переопределяют базу.
// @font-face подключён в index.html — см. комментарий там.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/app.css'
import './styles/mobile.css'
// шкала отступов порта — слоем поверх перенесённого CSS
import './styles/system.css'
import { App } from './App'
import { StoreProvider } from './state/store'
// аудит модели сезона доступен как window.__audit() — страховка порта
import { stats } from './lib/audit'
// масштаб макета под ширину экрана — ставит --k до первого кадра
import { watchScale } from './lib/scale'
// проверка слияния доступна как window.__syncAudit() — там же, почему в бандле
import './lib/sync-audit'

// сверка чисел ухода с прототипом: __stats(plants)
window.__stats = stats

watchScale()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <StoreProvider>
      <App />
    </StoreProvider>
  </StrictMode>,
)
