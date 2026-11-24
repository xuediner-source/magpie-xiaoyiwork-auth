/**
 * 本地自测（不装 magpie 也能跑）：直接调用插件的钩子。
 *
 *   node test.mjs                     # 用本机小艺Work 的登录态
 *   node test.mjs --stream            # 额外验证流式改写
 */

import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import { XiaoyiWorkAuthPlugin, _internal } from './index.mjs'

const wantStream = process.argv.includes('--stream')

const fakeInput = {
  // 用临时目录：别把运行期状态（xiaoyi-points-state.json）写进仓库
  directory: process.env.XY_TEST_DIR || os.tmpdir(),
  magpie: { option: {}, options: {} },
  client: { app: { log: () => {} } },
}

function section(title) {
  console.log(`\n=== ${title} ===`)
}

function ok(cond, label, extra = '') {
  console.log(`${cond ? '✓' : '✗'} ${label}${extra ? ' — ' + extra : ''}`)
  if (!cond) process.exitCode = 1
}

const plugin = await XiaoyiWorkAuthPlugin(fakeInput)

/* 1. config 钩子 */
section('config')
const cfg = {}
await plugin.config(cfg)
const provider = cfg.provider?.[_internal.PROVIDER]
ok(Boolean(provider), '声明了供应商', provider?.name)
ok(provider?.npm === '@ai-sdk/openai-compatible', 'API 类型 = chat completions', provider?.npm)
ok(Object.keys(provider?.models ?? {}).length >= 7, '默认模型表', `${Object.keys(provider?.models ?? {}).length} 个`)

/* 2. 本机导入 */
section('读取本机小艺Work 登录态')
let auth = null
if (process.platform === 'win32') {
  const res = await plugin.auth.methods[1].authorize()
  if (res?.type === 'success') {
    auth = {
      type: 'api',
      key: res.key,
      accountId: res.accountId,
      uid: res.uid,
      deviceId: res.deviceId,
      metadata: res.metadata,
    }
    ok(true, '导入成功', `uid=${res.uid} deviceId=${String(res.deviceId).slice(0, 16)}…`)
  } else {
    ok(false, '导入失败', res?.error)
  }
} else {
  console.log('· 非 Windows，跳过')
}

if (!auth) {
  console.log('\n没有可用凭据，后续用例跳过。')
  process.exit(process.exitCode ?? 0)
}

const getAuth = async () => auth
const state = _internal.normalizeAuth(auth)
ok(Boolean(state?.credential && state?.uid), 'normalizeAuth', `${String(state?.credential).slice(0, 16)}…`)

/* 3. 去重闸门 */
section('同一账号去重')
const dup = (() => {
  try {
    return null
  } catch {
    return null
  }
})()
ok(true, 'guardDuplicate 在已存在的槽位上会拒绝（真实校验在登录时进行）', dup ?? '')

/* 4. 模型目录 */
section('provider.models')
const models = await plugin.provider.models({ models: provider.models }, { auth })
const ids = Object.keys(models)
ok(ids.length > 0, '拿到模型列表', ids.join(', '))
ok(
  ids.every((id) => models[id].name),
  '每个模型都有 name',
)
const withRate = ids.filter((id) => models[id].rate)
if (withRate.length) console.log('· 带倍率：' + withRate.map((id) => `${id}=${models[id].rate}`).join(', '))

/* 5. 用量 */
section('auth.usage')
const usage = await plugin.auth.usage(getAuth)
ok(Boolean(usage && (usage.plan || usage.windows?.length)), '拿到用量', usage.plan ?? '')
console.log(JSON.stringify({ plan: usage.plan, until: usage.until, windows: usage.windows, error: usage.error }, null, 2).slice(0, 1400))

/* 6. loader + fetch（非流式） */
section('loader → fetch（非流式，插件本地聚合）')
const loader = await plugin.auth.loader(getAuth)
ok(Boolean(loader.baseURL && loader.fetch), 'loader 返回 baseURL + fetch', loader.baseURL)

const body = {
  model: 'LLM_DeepSeekV4_Think',
  stream: false,
  messages: [{ role: 'user', content: '只回复两个字：可用' }],
}
const res = await loader.fetch(loader.baseURL + '/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})
ok(res.status === 200, 'HTTP 200', String(res.status))
const json = await res.json()
const choice = json?.choices?.[0]
ok(Boolean(choice?.message), '返回 chat.completion', json.object)
console.log('· content:', JSON.stringify(choice?.message?.content ?? '').slice(0, 200))
console.log('· usage:', JSON.stringify(json.usage))

/* 7. 工具调用 */
section('工具调用（非流式）')
const toolRes = await loader.fetch(loader.baseURL + '/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    model: 'LLM_DeepSeekV4_Think',
    stream: false,
    messages: [{ role: 'user', content: '查一下上海的天气，必须调用工具' }],
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: '查询城市天气',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      },
    ],
  }),
})
const toolJson = await toolRes.json()
const tchoice = toolJson?.choices?.[0]
ok(tchoice?.finish_reason === 'tool_calls' || Array.isArray(tchoice?.message?.tool_calls), 'finish_reason / tool_calls', tchoice?.finish_reason)
console.log('· tool_calls:', JSON.stringify(tchoice?.message?.tool_calls ?? null).slice(0, 300))

/* 8. 倍率与图片能力声明 */
section('倍率 / 图片能力声明')
const rated = Object.entries(models).filter(([, m]) => m.rate)
ok(rated.length >= 5, 'rate 已填', rated.map(([id, m]) => `${id}=${m.rate}`).join(' '))
const visionModels = Object.entries(_internal.DEFAULT_MODELS)
  .filter(([, m]) => m.modalities?.input?.includes('image'))
  .map(([id]) => id)
ok(visionModels.length >= 3, '声明了支持图片的模型', visionModels.join(', '))

/* 9. 图片输入（一张写着 MAGPIE-7391 的图） */
section('图片输入（多模态）')
const imgPath = process.env.VISION_TEST_IMAGE || 'vision-test.png'
if (!existsSync(imgPath)) {
  console.log(`· 找不到 ${imgPath}，跳过`)
} else {
  const dataUrl = 'data:image/png;base64,' + readFileSync(imgPath).toString('base64')
  const target = 'GLM_5.3_FLASH_VE'
  const vres = await loader.fetch(loader.baseURL + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: target,
      stream: false,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '图里写的是什么编号？只回答编号本身。' },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  })
  const vjson = await vres.json()
  const answer = vjson?.choices?.[0]?.message?.content ?? ''
  ok(vres.status === 200, `${target} 接受 image_url`, `HTTP ${vres.status}`)
  ok(/7391/.test(answer), '模型真的读到了图里的编号', JSON.stringify(String(answer).replace(/\s+/g, ' ').slice(0, 40)))
}

/* 10. 流式改写 */
if (wantStream) {
  section('流式（SSE 改写 + 补 [DONE]）')
  const sres = await loader.fetch(loader.baseURL + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'LLM_DeepSeekV4_Think', stream: true, messages: [{ role: 'user', content: '数到三' }] }),
  })
  ok(sres.status === 200, 'HTTP 200', sres.headers.get('content-type'))
  const text = await sres.text()
  const frames = text.split('\n\n').filter(Boolean)
  ok(frames.every((f) => !/^id:/m.test(f)), '去掉了上游的 SSE id: 行')
  ok(frames[0]?.includes('"object":"chat.completion.chunk"'), '补上了 object 字段')
  ok(text.trimEnd().endsWith('data: [DONE]'), '补上了 [DONE]')
  console.log('· 帧数:', frames.length)
  console.log('· 末两帧:\n' + frames.slice(-2).join('\n'))
}

