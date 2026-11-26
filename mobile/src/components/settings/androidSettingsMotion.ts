const timeline = 1000
const duration = 300
const handoff = 0.35
const distance = 40
const fadeOut = 'cubic-bezier(0.4, 0, 1, 1)'
const fadeIn = 'cubic-bezier(0.022, 0.021, 0.186, 1)'
const slideOut = 'cubic-bezier(0.415, 0, 0.63, 0.225)'
const slideIn = 'cubic-bezier(0.04, 0.085, 0.19, 1)'

type Direction = 'enter' | 'back'
type Property = 'backgroundColor' | 'opacity' | 'transform'
type Value = string | number

const firstPhase = (property: Property, from: Value, to: Value, easing: string): Keyframe[] => [
  { [property]: from, easing },
  { [property]: to, offset: handoff },
  { [property]: to },
]

const secondPhase = (property: Property, from: Value, to: Value, easing: string): Keyframe[] => [
  { [property]: from },
  { [property]: from, offset: handoff, easing },
  { [property]: to },
]

const waitForAnimation = (
  animation: Animation,
  registerCleanup: (cleanup: (cancelled: boolean) => void) => void
): Promise<boolean> => {
  if (animation.playState === 'finished') {
    return Promise.resolve(true)
  }
  if (animation.playState === 'idle') {
    return Promise.resolve(false)
  }
  const fallbackMs = Math.ceil(duration * 2)
  return new Promise<boolean>((resolve) => {
    let settled = false
    const timer = window.setTimeout(() => finish(true), fallbackMs)
    const cleanup = () => {
      window.clearTimeout(timer)
      animation.removeEventListener('finish', onFinish)
      animation.removeEventListener('cancel', onCancel)
    }
    const finish = (result: boolean) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(result)
    }
    const onFinish = () => finish(true)
    const onCancel = () => finish(false)

    registerCleanup((cancelled) => {
      if (cancelled) {
        finish(false)
      } else {
        cleanup()
      }
    })
    // Animation.finished landed in Chrome 84; fall back to Web Animations events and a timeout on older WebView.
    if (animation.finished) {
      void animation.finished.then(onFinish, onCancel)
    } else {
      animation.addEventListener('finish', onFinish)
      animation.addEventListener('cancel', onCancel)
    }
  })
}

// A back gesture seeks through the same keyframes as a press of the back button.
export const createSettingsPageMotion = (
  page: HTMLElement,
  content: HTMLElement,
  previous: HTMLElement | null
) => {
  const timing = { duration: timeline, fill: 'both' } as const
  const right = `translateX(${distance}px)`
  const left = `translateX(${-distance}px)`
  const rest = 'translateX(0)'
  let animations: Animation[] = []
  let direction: Direction | undefined
  let cleanups: Array<(cancelled: boolean) => void> = []

  const cancel = () => {
    const activeCleanups = cleanups
    cleanups = []
    for (const cleanup of activeCleanups) {
      cleanup(true)
    }
    for (const animation of animations) {
      animation.cancel()
    }
    animations = []
    direction = undefined
  }

  const prepare = (next: Direction) => {
    if (direction === next) {
      return
    }
    cancel()
    if (typeof page.animate !== 'function' || typeof content.animate !== 'function') {
      return
    }
    direction = next
    const returning = next === 'back'
    const computedBackground = getComputedStyle(page).backgroundColor
    const background =
      computedBackground && computedBackground !== 'transparent' ? computedBackground : '#f8f8f8'
    try {
      const created = [
        page.animate(
          returning
            ? secondPhase('backgroundColor', background, 'transparent', fadeIn)
            : firstPhase('backgroundColor', 'transparent', background, fadeOut),
          timing
        ),
        content.animate(
          returning ? firstPhase('opacity', 1, 0, fadeOut) : secondPhase('opacity', 0, 1, fadeIn),
          timing
        ),
        content.animate(
          returning
            ? firstPhase('transform', rest, right, slideOut)
            : secondPhase('transform', right, rest, slideIn),
          timing
        ),
      ]
      if (previous && typeof previous.animate === 'function') {
        created.push(
          previous.animate(
            returning
              ? secondPhase('transform', left, rest, slideIn)
              : firstPhase('transform', rest, left, slideOut),
            timing
          )
        )
      }
      for (const animation of created) {
        animation.pause()
        animation.currentTime = 0
      }
      animations = created
    } catch {
      cancel()
    }
  }

  return {
    seek(progress: number) {
      prepare('back')
      for (const animation of animations) {
        animation.pause()
        animation.currentTime = progress * timeline
      }
    },
    play(next: Direction) {
      prepare(next)
      const target = animations[1] ?? animations[0]
      if (!target) {
        return Promise.resolve(true)
      }
      if (target.currentTime === timeline) {
        return Promise.resolve(true)
      }
      for (const animation of animations) {
        animation.playbackRate = timeline / duration
        animation.play()
      }
      return waitForAnimation(target, (cleanup) => {
        cleanups.push(cleanup)
      })
    },
    cancel,
  }
}
