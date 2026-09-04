import { describe, expect, it } from 'vitest'
import { parsePublicError } from '../../src/renderer/src/utils/public-error'

describe('parsePublicError', () => {
  it('安全解析 percent-encoded validation issues/currentRevision，非法或路径泄漏编码 fail closed', () => {
    const issues = encodeURIComponent(JSON.stringify([{ severity: 'warning', code: 'WARN', path: '/description', message: '含 ] 和\n换行' }]))
    expect(parsePublicError(`[BACKEND_REJECTED] [backendCode=CHARACTER_VALIDATION] [currentRevision=3] [issues=${issues}] 校验失败`)).toMatchObject({
      backendCode: 'CHARACTER_VALIDATION', currentRevision: 3,
      issues: [{ severity: 'warning', code: 'WARN', path: '/description', message: '含 ] 和\n换行' }],
      message: '校验失败'
    })
    expect(parsePublicError('[BACKEND_REJECTED] [issues=%E0%A4%A] bad')).not.toHaveProperty('issues')
    const leaked = encodeURIComponent(JSON.stringify([{ severity: 'error', code: 'X', path: '/C:/Users/a.txt', message: 'x' }]))
    expect(parsePublicError(`[BACKEND_REJECTED] [issues=${leaked}] bad`)).not.toHaveProperty('issues')
  })
  it('解析 [code] message', () => {
    expect(parsePublicError('[CREDENTIAL_UNAVAILABLE] 后端 Token 未设置')).toEqual({ code: 'CREDENTIAL_UNAVAILABLE', message: '后端 Token 未设置' })
  })
  it('解析 [code] [backendCode=..] [retryable=..] message', () => {
    expect(parsePublicError('[BACKEND_REJECTED] [backendCode=QUEUE_FULL] [retryable=true] 队列已满')).toEqual({
      code: 'BACKEND_REJECTED', message: '队列已满', backendCode: 'QUEUE_FULL', retryable: true
    })
  })

  it('解析 clientRequestId/retryAfterMs/idempotencyDurable 公开字段', () => {
    expect(parsePublicError('[BACKEND_REJECTED] [clientRequestId=cr-1] [retryAfterMs=1000] [idempotencyDurable=false] 存储不可用')).toEqual({
      code: 'BACKEND_REJECTED', message: '存储不可用', clientRequestId: 'cr-1',
      retryAfterMs: 1000, idempotencyDurable: false
    })
  })
  it('无前缀回退 UNKNOWN', () => {
    expect(parsePublicError('plain error')).toEqual({ code: 'UNKNOWN', message: 'plain error' })
  })
  it('message 本身含 [] 不受影响', () => {
    expect(parsePublicError('[AUTHENTICATION_FAILED] 401 [detail]')).toEqual({ code: 'AUTHENTICATION_FAILED', message: '401 [detail]' })
  })
  it('requestId 段一并剥离', () => {
    expect(parsePublicError('[TIMEOUT] [requestId=r-1] 请求超时')).toEqual({ code: 'TIMEOUT', message: '请求超时', requestId: 'r-1' })
  })
})
