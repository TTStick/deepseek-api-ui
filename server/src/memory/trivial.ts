/**
 * trivial prompt 判定（移植 Hermes agent/memory_provider.py 的 TRIVIAL_PROMPT_RE）。
 * 零语义输入跳过召回，省一次往返，也避免陈旧上下文带偏单字回复。
 * 锚定且后随空白/标点才命中："k8s"/"yolo"/"note" 不命中，"hi!"/"done???" 命中。
 */
const TRIVIAL_PROMPT_RE =
  /^(?:yes|no|ok|okay|sure|thanks|thank you|y|n|yep|nope|yeah|nah|hi|hey|hello|yo|sup|continue|go ahead|do it|proceed|got it|cool|nice|great|done|next|lgtm|k)[\s!?.:;,"'~\u2018\u2019\u201c\u201d\u2014\u2013\u2026()[\]{}<>*&^%$#@!+=`\u00a0]*$/i

export const isTrivialPrompt = (text: string | null | undefined): boolean => {
  const stripped = (text ?? '').trim()
  if (!stripped || stripped.startsWith('/')) {
    return true
  }
  return TRIVIAL_PROMPT_RE.test(stripped)
}
