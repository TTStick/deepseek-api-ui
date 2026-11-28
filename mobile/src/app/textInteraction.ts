import { android } from './android.js'

const EDITABLE = 'input,textarea,[contenteditable="true"]'

const isEditableTarget = (target: EventTarget | null) =>
  target instanceof Element && Boolean(target.closest(EDITABLE))

/**
 * iOS keeps native text interaction off so long-press uses the custom Android-style
 * selection menu. Form controls still need it while editing; toggling on `focusin`
 * is too late for the first tap (WebKit has already created the input session), so
 * switch it on `pointerdown`, before the field receives focus.
 */
export const installTextInteractionBridge = () => {
  const setTextInteraction = android?.setTextInteraction
  if (!setTextInteraction) {
    return
  }

  setTextInteraction(false)
  let enabled = false
  const sync = (next: boolean) => {
    if (next === enabled) {
      return
    }
    enabled = next
    setTextInteraction(next)
  }

  document.addEventListener(
    'pointerdown',
    (event) => sync(isEditableTarget(event.target)),
    true
  )
  document.addEventListener(
    'focusin',
    (event) => {
      if (isEditableTarget(event.target)) {
        sync(true)
      }
    },
    true
  )
  // Covers programmatic blurs and focus moving to the page body.
  document.addEventListener(
    'focusout',
    () => {
      requestAnimationFrame(() => sync(isEditableTarget(document.activeElement)))
    },
    true
  )
}
