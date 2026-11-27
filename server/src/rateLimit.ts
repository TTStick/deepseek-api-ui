import type { FastifyReply, FastifyRequest } from 'fastify'
import { getRuntimeConfig } from './runtimeConfig.js'

/**
 * 轻量内存限速：用于消耗 LLM 额度或发起出站连接的接口。
 * 单实例足够；多实例部署时应换成 Redis/网关级限速。
 */
export type RateLimitResult = { ok: true } | { ok: false; retryAfter: number }

export const createRateLimiter = (max: number, windowMs: number) => {
  const buckets = new Map<string, { count: number; resetAt: number }>()
  return (key: string): RateLimitResult => {
    const now = Date.now()
    if (buckets.size > 10_000) {
      for (const [bucketKey, bucket] of buckets) {
        if (bucket.resetAt <= now) {
          buckets.delete(bucketKey)
        }
      }
    }
    const current = buckets.get(key)
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs })
      return { ok: true }
    }
    if (current.count >= max) {
      return { ok: false, retryAfter: Math.max(1, Math.ceil((current.resetAt - now) / 1000)) }
    }
    current.count += 1
    return { ok: true }
  }
}

/**
 * 限速/登录用的客户端地址。
 * 默认取 TCP 对端地址：攻击者无法通过伪造 X-Forwarded-For 绕过。
 * 只有显式 TRUST_PROXY=true（且前置代理会覆写 XFF）时才读取该头。
 */
export const clientAddress = (request: FastifyRequest): string => {
  if (!getRuntimeConfig().trustProxy) {
    return request.socket.remoteAddress ?? request.ip
  }
  const forwarded = request.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0]!.trim()
  }
  return request.ip
}

const chatLimiters = new Map<number, (key: string) => RateLimitResult>()
const sshTestLimiter = createRateLimiter(10, 60_000)

const makeGuard = (limiter: (key: string) => RateLimitResult) => {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const result = limiter(clientAddress(request))
    if (!result.ok) {
      return reply
        .code(429)
        .header('Retry-After', String(result.retryAfter))
        .send({ error: { message: '请求过于频繁，请稍后再试' } })
    }
  }
}

/** 聊天/压缩共用同一个桶，避免切换接口绕过；超限返回 429 */
export const chatRateGuard: (
  request: FastifyRequest,
  reply: FastifyReply
) => Promise<unknown> = async (request, reply) => {
  const max = getRuntimeConfig().chatRateLimitPerMinute
  let limiter = chatLimiters.get(max)
  if (!limiter) {
    limiter = createRateLimiter(max, 60_000)
    chatLimiters.set(max, limiter)
  }
  return makeGuard(limiter)(request, reply)
}

/** SSH 连通性测试会主动出站，单独限速 */
export const sshTestRateGuard = makeGuard(sshTestLimiter)
