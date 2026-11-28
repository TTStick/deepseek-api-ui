// Forwards uncaught JavaScript errors to the native log so simulator runs can be
// diagnosed without attaching Safari Web Inspector. Debug builds only.
(function () {
  'use strict'
  function send(message) {
    try {
      window.webkit.messageHandlers.dsLog.postMessage(String(message))
    } catch (error) {
      // The handler is absent when the page runs outside the app.
    }
  }
  window.addEventListener(
    'error',
    function (event) {
      var error = event.error
      send(
        'window.onerror: ' +
          (event.message || error) +
          ' @ ' +
          (event.filename || '') +
          ':' +
          (event.lineno || 0) +
          ':' +
          (event.colno || 0) +
          (error && error.stack ? '\n' + error.stack : '')
      )
    },
    true
  )
  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason
    send('unhandledrejection: ' + (reason && reason.stack ? reason.stack : String(reason)))
  })
  var originalError = console.error.bind(console)
  console.error = function () {
    var parts = Array.prototype.map.call(arguments, function (value) {
      try {
        return value && value.stack ? value.stack : String(value)
      } catch (error) {
        return '?'
      }
    })
    send('console.error: ' + parts.join(' '))
    originalError.apply(null, arguments)
  }
  send('errorlog installed')
})()
