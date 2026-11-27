/**
 * 服务端是否配置了 DeepSeek Key。
 * 由 /api/auth/status 的布尔字段更新，只影响网页端是否还要求用户填写本机 Key；
 * Key 本身永远不会下发到浏览器。
 */
let configured = false

export const setServerApiKeyConfigured = (value: boolean): void => {
  configured = value
}

export const isServerApiKeyConfigured = (): boolean => configured
