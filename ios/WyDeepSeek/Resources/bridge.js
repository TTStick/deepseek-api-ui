// iOS synchronous bridge for the bundled WyDeepSeek web app.
//
// The web layer was written against Android's @JavascriptInterface, which is fully
// synchronous. WKWebView has no synchronous message handler, so requests are tunnelled
// through window.prompt(); WKUIDelegate answers before prompt() returns, giving the
// page the same blocking behaviour without exposing secrets over the loopback server.
(function () {
  'use strict'

  if (window.DeepSeekAndroid) {
    return
  }

  var PREFIX = '__ds_bridge__'
  var nativePrompt = window.prompt

  function call(method, args) {
    var reply
    try {
      reply = nativePrompt.call(window, PREFIX + JSON.stringify({ m: method, a: args || [] }))
    } catch (error) {
      throw new Error('Native bridge unavailable: ' + method)
    }
    if (typeof reply !== 'string') {
      throw new Error('Native bridge unavailable: ' + method)
    }
    var result = JSON.parse(reply)
    if (result && result.error) {
      throw new Error(result.error)
    }
    return result ? result.value : undefined
  }

  function number(method, args) {
    var value = call(method, args)
    return typeof value === 'number' ? value : Number(value) || 0
  }

  function bool(method, args) {
    return call(method, args) === true
  }

  var bridge = {
    statusInset: function () {
      return number('statusInset')
    },
    buttonNavigationInset: function () {
      return number('buttonNavigationInset')
    },
    systemFontScale: function () {
      return number('systemFontScale')
    },
    isTablet: function () {
      return bool('isTablet')
    },
    getMusicVolume: function () {
      return number('getMusicVolume')
    },
    openAppPermissions: function () {
      call('openAppPermissions')
    },
    updateStatus: function () {
      return String(call('updateStatus') || '')
    },
    checkForUpdate: function () {
      call('checkForUpdate')
    },
    installUpdate: function () {
      call('installUpdate')
    },
    openSourcePage: function (url, dark, closeLabel, browserLabel, loadingLabel, errorLabel, retryLabel) {
      call('openSourcePage', [
        url,
        dark === true,
        closeLabel || '',
        browserLabel || '',
        loadingLabel || '',
        errorLabel || '',
        retryLabel || '',
      ])
    },
    readApiKey: function () {
      var value = call('readApiKey')
      return typeof value === 'string' ? value : null
    },
    writeApiKey: function (value) {
      return bool('writeApiKey', [value === null || value === undefined ? null : String(value)])
    },
    readChatConfig: function () {
      var value = call('readChatConfig')
      return typeof value === 'string' ? value : null
    },
    writeChatConfig: function (value) {
      return bool('writeChatConfig', [value === null || value === undefined ? null : String(value)])
    },
    beginChatRequest: function (endpoint, format, body) {
      var value = call('beginChatRequest', [String(endpoint), String(format), String(body)])
      return typeof value === 'string' ? value : null
    },
    cancelChatRequest: function (id) {
      call('cancelChatRequest', [String(id)])
    },
    readAccountProfile: function () {
      var value = call('readAccountProfile')
      return typeof value === 'string' ? value : null
    },
    writeAccountProfile: function (value) {
      return bool('writeAccountProfile', [value === null || value === undefined ? null : String(value)])
    },
    setDarkBars: function (dark) {
      call('setDarkBars', [dark === true])
    },
    setTextInteraction: function (enabled) {
      call('setTextInteraction', [enabled === true])
    },
    setHandlesBack: function (handlesBack) {
      call('setHandlesBack', [handlesBack === true])
    },
    setBackPreviewEnabled: function (enabled) {
      call('setBackPreviewEnabled', [enabled === true])
    },
    setImageViewerFullscreen: function (fullscreen) {
      call('setImageViewerFullscreen', [fullscreen === true])
    },
    requestRecentPhotos: function () {
      call('requestRecentPhotos')
    },
    prefetchRecentPhotos: function () {
      call('prefetchRecentPhotos')
    },
    requestHistoryExport: function (name) {
      call('requestHistoryExport', [String(name)])
    },
    writeHistoryExport: function (bytes) {
      return bool('writeHistoryExport', [String(bytes)])
    },
    finishHistoryExport: function () {
      return bool('finishHistoryExport')
    },
    chatStorage: function (method, payload) {
      var value = call('chatStorage', [String(method), String(payload)])
      return typeof value === 'string' ? value : ''
    },
    shadowList: function (dir) {
      var value = call('shadowList', [String(dir)])
      return typeof value === 'string' ? value : null
    },
    shadowReadChunk: function (path, offset) {
      var value = call('shadowReadChunk', [String(path), Number(offset) || 0])
      return typeof value === 'string' ? value : null
    },
    shadowClearAll: function () {
      return bool('shadowClearAll')
    },
    requestImageSavePermission: function () {
      call('requestImageSavePermission')
    },
    beginImageSave: function (name, mime) {
      return bool('beginImageSave', [String(name), String(mime)])
    },
    writeImageSave: function (bytes) {
      return bool('writeImageSave', [String(bytes)])
    },
    finishImageSave: function (keep) {
      return bool('finishImageSave', [keep === true])
    },
    requestRecording: function () {
      call('requestRecording')
    },
    finishRecording: function (keep) {
      return bool('finishRecording', [keep === true])
    },
    recordingLevel: function () {
      return number('recordingLevel')
    },
    setSelectionExclusion: function () {
      // Android-only system gesture exclusion; iOS has no equivalent.
    },
    tsStart: function (authKey, target, hostname) {
      var value = call('tsStart', [String(authKey || ''), String(target || ''), String(hostname || '')])
      return typeof value === 'string' ? value : ''
    },
    tsStatus: function () {
      var value = call('tsStatus')
      return typeof value === 'string' ? value : ''
    },
    tsStop: function () {
      call('tsStop')
    },
    tsOpenLogin: function () {
      return bool('tsOpenLogin')
    },
    tsAuthKey: function () {
      var value = call('tsAuthKey')
      return typeof value === 'string' ? value : null
    },
    tsSetAuthKey: function (value) {
      return bool('tsSetAuthKey', [value === null || value === undefined ? null : String(value)])
    },
  }

  Object.defineProperty(window, 'DeepSeekAndroid', {
    value: bridge,
    enumerable: false,
    configurable: false,
    writable: false,
  })
})()
