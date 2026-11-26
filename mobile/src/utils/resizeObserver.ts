import { ResizeObserver as ResizeObserverPolyfill } from '@juggle/resize-observer'

// Chrome 64 以下没有 ResizeObserver（EMUI 9 的系统 WebView 内核停留在 Chrome 63 时代）。
if (typeof window !== 'undefined' && typeof window.ResizeObserver === 'undefined') {
  window.ResizeObserver = ResizeObserverPolyfill as unknown as typeof window.ResizeObserver
}
