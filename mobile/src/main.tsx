import 'abortcontroller-polyfill'
import './utils/abort.js'
import './utils/resizeObserver.js'
import { createRoot } from 'react-dom/client'
import { App } from './app/App.js'
import { android } from './app/android.js'
import { setupTheme } from './app/theme.js'
import { installTextInteractionBridge } from './app/textInteraction.js'
import { ensureKatex } from './services/markdown/katex.js'
import './app/theme.css'
import './app/global.css'
import './app/android.css'

const supportsFlexGap = () => {
  if (typeof document === 'undefined' || !document.body) {
    return true
  }
  const flex = document.createElement('div')
  flex.style.position = 'absolute'
  flex.style.visibility = 'hidden'
  flex.style.display = 'flex'
  flex.style.flexDirection = 'column'
  flex.style.rowGap = '1px'
  flex.appendChild(document.createElement('div'))
  flex.appendChild(document.createElement('div'))
  document.body.appendChild(flex)
  const supported = flex.scrollHeight === 1
  document.body.removeChild(flex)
  return supported
}

ensureKatex()
if (!supportsFlexGap()) {
  document.documentElement.setAttribute('data-no-flex-gap', '')
}
if (android) {
  document.title = ''
  const root = document.documentElement
  const buttonNavigationInset = android.buttonNavigationInset()
  root.dataset.android = ''
  if (android.isTablet?.()) {
    root.setAttribute('data-ios-tablet', '')
  }
  root.style.setProperty('--android-status-inset', `${android.statusInset()}px`)
  root.style.setProperty('--android-button-nav-inset', `${buttonNavigationInset}px`)
  if (buttonNavigationInset > 0) {
    root.setAttribute('data-button-navigation', '')
  } else {
    root.removeAttribute('data-button-navigation')
  }
}
setupTheme()
installTextInteractionBridge()

createRoot(document.getElementById('root') as HTMLElement).render(<App />)
