// iOS long-press compatibility for the Android-style selection menu.
//
// The web UI enters its custom text-selection mode from a `contextmenu` event, which
// Android WebView emits on long-press but WKWebView does not. We synthesise that event
// and swallow the click that would otherwise start editing a user message.
(function () {
  'use strict'

  if (!window.DeepSeekAndroid || window.__dsLongPressInstalled) {
    return
  }
  window.__dsLongPressInstalled = true

  var HOLD_MS = 380
  var MOVE_SLOP = 10

  var timer = 0
  var start = null
  var synthetic = false
  var suppressClickUntil = 0

  function log(message) {
    try {
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.dsLog) {
        window.webkit.messageHandlers.dsLog.postMessage('LP: ' + message)
      }
    } catch (error) {
      // Logging is best-effort.
    }
  }

  log('installed')

  function installStyle() {
    var style = document.createElement('style')
    style.setAttribute('data-ds-ios', '')
    style.textContent =
      'html{-webkit-touch-callout:none}' +
      'input,textarea,[contenteditable="true"]{-webkit-touch-callout:none}' +
      'img,a{-webkit-touch-callout:none}'
    ;(document.head || document.documentElement).appendChild(style)
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installStyle, { once: true })
  } else {
    installStyle()
  }

  function clearTimer() {
    if (timer) {
      clearTimeout(timer)
      timer = 0
    }
    start = null
  }

  function isEditable(target) {
    return !!(target && target.closest && target.closest('input,textarea,[contenteditable="true"]'))
  }

  function fire(x, y) {
    var target = document.elementFromPoint(x, y)
    log('fire target=' + (target ? target.tagName + '.' + (target.className || '') : 'null'))
    if (!target || isEditable(target)) {
      return
    }
    synthetic = true
    suppressClickUntil = Date.now() + 800
    try {
      target.dispatchEvent(
        new MouseEvent('contextmenu', {
          bubbles: true,
          cancelable: true,
          composed: true,
          clientX: x,
          clientY: y,
          screenX: x,
          screenY: y,
          button: 2,
          buttons: 2,
        })
      )
      log('contextmenu dispatched')
    } finally {
      synthetic = false
    }
  }

  document.addEventListener(
    'pointerdown',
    function (event) {
      if (event.pointerType !== 'touch') {
        // WebKit may deliver compatibility mouse pointer events around a touch press;
        // they must not cancel the pending long-press timer.
        log('ignore pointerdown type=' + event.pointerType)
        return
      }
      if (!event.isPrimary) {
        log('ignore non-primary pointerdown')
        clearTimer()
        return
      }
      if (isEditable(event.target)) {
        return
      }
      var x = event.clientX
      var y = event.clientY
      log('pointerdown x=' + Math.round(x) + ' y=' + Math.round(y) + ' type=' + event.pointerType)
      clearTimer()
      start = { x: x, y: y }
      timer = setTimeout(function () {
        timer = 0
        if (!start) {
          return
        }
        log('timer fired')
        fire(start.x, start.y)
        start = null
      }, HOLD_MS)
    },
    { capture: true, passive: true }
  )

  document.addEventListener(
    'pointermove',
    function (event) {
      if (!start) {
        return
      }
      if (Math.abs(event.clientX - start.x) > MOVE_SLOP || Math.abs(event.clientY - start.y) > MOVE_SLOP) {
        log('pointermove cancel')
        clearTimer()
      }
    },
    { capture: true, passive: true }
  )

  document.addEventListener(
    'pointerup',
    function () {
      if (start) log('pointerup')
      clearTimer()
    },
    { capture: true, passive: true }
  )
  document.addEventListener(
    'pointercancel',
    function () {
      if (start) log('pointercancel')
      clearTimer()
    },
    { capture: true, passive: true }
  )

  document.addEventListener(
    'contextmenu',
    function (event) {
      log('contextmenu target=' + (event.target ? event.target.tagName : 'null') + ' synthetic=' + synthetic)
      // A genuine WebKit context menu wins; drop a pending synthetic one.
      if (!synthetic && start) {
        clearTimer()
      }
    },
    { capture: true }
  )

  document.addEventListener(
    'click',
    function (event) {
      // Only the click WebKit synthesises after a touch must be swallowed. The menu's
      // own trigger uses element.click(), which is not trusted and must reach React.
      if (!event.isTrusted || Date.now() >= suppressClickUntil) {
        return
      }
      suppressClickUntil = 0
      event.preventDefault()
      event.stopPropagation()
      event.stopImmediatePropagation()
    },
    { capture: true, passive: false }
  )
})()
