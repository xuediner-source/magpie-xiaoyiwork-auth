import test from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { XiaoyiWorkAuthPlugin, _internal } from './index.mjs'

test('normalizeToolSchemas fills untyped enum/const and inlines local $ref/$defs safely', () => {
  const body = {
    model: 'Kimi_K3.1_Pro_VE',
    tools: [
      {
        type: 'function',
        function: {
          name: 'cua_like',
          parameters: {
            type: 'object',
            $defs: {
              __schema0: { oneOf: [{ type: 'string' }, { type: 'number' }] },
              __schema1: { $ref: '#/$defs/__schema2', description: 'chained' },
              __schema2: { properties: { k: { enum: ['x', 'y'] } } },
              __cycle: { type: 'object', properties: { next: { $ref: '#/$defs/__cycle' } } },
            },
            properties: {
              mode: { enum: ['a', 'b'] },
              count: { enum: [1, 2] },
              ratio: { enum: [1, 1.5] },
              opt: { enum: ['x', null] },
              tag: { const: 'v1' },
              kinds: { items: { enum: ['text', 'icon'] }, enum: ['text'] },
              refA: { $ref: '#/$defs/__schema0' },
              refB: { $ref: '#/$defs/__schema1' },
              cycle: { $ref: '#/$defs/__cycle' },
            },
          },
        },
      },
    ],
  }

  _internal.normalizeToolSchemas(body)
  const p = body.tools[0].function.parameters
  assert.equal(p.$defs, undefined)
  assert.equal(p.properties.mode.type, 'string')
  assert.equal(p.properties.count.type, 'integer')
  assert.equal(p.properties.ratio.type, 'number')
  assert.deepEqual(p.properties.opt.type, ['string', 'null'])
  assert.equal(p.properties.tag.type, 'string')
  assert.equal(p.properties.kinds.type, 'array')
  assert.equal(p.properties.kinds.items.type, 'string')
  assert.deepEqual(p.properties.refA.oneOf, [{ type: 'string' }, { type: 'number' }])
  assert.equal(p.properties.refB.description, 'chained')
  assert.equal(p.properties.refB.properties.k.type, 'string')
  assert.equal(p.properties.cycle.properties.next.type, 'object')
  assert.equal(p.properties.cycle.properties.next.$ref, undefined)
  assert.equal(JSON.stringify(p).includes('$ref'), false)
})

test('aggregate propagates upstream SSE error frames (wrapped and bare)', async () => {
  const errStream1 = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: {"error":{"code":"11115","message":"server inner"}}\n\n'))
      c.close()
    },
  })
  const out1 = await _internal.aggregate(errStream1, 'Kimi_K3.1_Pro_VE')
  assert.deepEqual(out1, { error: { code: '11115', message: 'server inner' } })

  const errStream2 = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode('data: {"code":"11115","message":"server inner"}\n\n'))
      c.close()
    },
  })
  const out2 = await _internal.aggregate(errStream2, 'Kimi_K3.1_Pro_VE')
  assert.deepEqual(out2, { error: { code: '11115', message: 'server inner' } })
})

test('normalizeRequestBody normalizes temperature and tool_choice for Kimi models', () => {
  const bodyKimi = {
    model: 'Kimi_K3.1_Pro_VE',
    temperature: 0,
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
  }
  _internal.normalizeRequestBody(bodyKimi)
  assert.equal(bodyKimi.temperature, undefined)
  assert.equal(bodyKimi.tool_choice, 'required')

  const bodyKimi1 = {
    model: 'Kimi_K3.1_Pro_VE',
    temperature: 1,
    tool_choice: 'auto',
  }
  _internal.normalizeRequestBody(bodyKimi1)
  assert.equal(bodyKimi1.temperature, 1)
  assert.equal(bodyKimi1.tool_choice, 'auto')

  const bodyDeepSeek = {
    model: 'LLM_DeepSeekV4_Think',
    temperature: 0,
    tool_choice: { type: 'function', function: { name: 'get_weather' } },
  }
  _internal.normalizeRequestBody(bodyDeepSeek)
  assert.equal(bodyDeepSeek.temperature, 0)
  assert.deepEqual(bodyDeepSeek.tool_choice, { type: 'function', function: { name: 'get_weather' } })
})

test('transformSse terminates immediately on error frame without hanging', async () => {
  const errStream = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(': keepalive\n\ndata: {"code":"11115","message":"server inner"}\n\n'))
      c.close()
    },
  })
  const transformed = _internal.transformSse(errStream, 'Kimi_K3.1_Pro_VE')
  const reader = transformed.getReader()
  const decoder = new TextDecoder()
  let collected = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    collected += decoder.decode(value)
  }
  assert.match(collected, /"code":"11115"/)
  assert.match(collected, /data: \[DONE\]/)
})

test('loader.fetch rejects bodies above 4.5 MiB with standard HTTP 413 without network call', async () => {
  assert.equal(_internal.MAX_HAG_BODY_BYTES, 4_718_592)
  const plugin = await XiaoyiWorkAuthPlugin({
    directory: os.tmpdir(),
    magpie: { option: {}, options: {} },
    client: { app: { log: () => {} } },
  })
  const loader = await plugin.auth.loader(async () => ({
    type: 'oauth',
    access: 'dummy-cred',
    uid: '123456',
    deviceId: 'dummy-device',
  }))
  const oversized = JSON.stringify({
    model: 'Kimi_K3.1_Pro_VE',
    stream: true,
    messages: [{ role: 'user', content: 'x'.repeat(4_800_000) }],
  })
  const res = await loader.fetch(`${loader.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: oversized,
  })
  assert.equal(res.status, 413)
  const payload = await res.json()
  assert.equal(payload.error.code, 'request_too_large')
  assert.match(payload.error.message, /4718592 bytes/)
})
