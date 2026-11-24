/**
 * opencode-xiaoyiwork-auth
 * ---------------------------------------------------------------------------
 * magpie / OpenCode 供应商插件：把小艺Work（华为小艺 Celia）的模型接进 magpie。
 *
 * 逆向要点（详见 README）：
 *   · 上游网关  POST https://hag-drcn.op.dbankcloud.com/celia/v1/sse-api/chat/completions
 *     只吃 accept: text/event-stream；OpenAI chat 格式；工具调用为原生 tool_calls。
 *   · 鉴权三件套：businessCredential（7 天）+ x-uid + x-device-id
 *     x-device-id = sha256(MachineGuid).hex(小写) + "_" + uid —— 必须是已登记设备。
 *   · 续期闭环（不需要小艺Work 常驻）：
 *       businessCredential ──网关代刷──> accessToken(1h) ──立刻签票──> 新 businessCredential
 *     accessToken 有「新鲜度」窗口（几分钟），所以刷新和签票必须背靠背。
 */

import crypto from 'node:crypto'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const PROVIDER = 'xiaoyiwork'
const HAG = 'https://hag-drcn.op.dbankcloud.com'
const SSE_BASE = `${HAG}/celia/v1/sse-api`
const CHAT_PATH = '/chat/completions'
// 实测华为小艺网关请求体超过 5 MiB (5,242,880 B) 时不返回 413，而是挂起 ~56s 后返回 408。
// 前置限制在 4.5 MiB (4,718,592 B) 并返回标准 413，让 magpie 自动裁剪最早的历史图片后重试。
const MAX_HAG_BODY_BYTES = 4_718_592 // 4.5 MiB

const ENDPOINTS = {
  authorize: 'https://oauth-login.cloud.huawei.com/oauth2/v3/authorize',
  token: 'https://oauth-login.cloud.huawei.com/oauth2/v3/token',
  gallery: `${HAG}/user-ability-gallery/v1/agent/user/query`,
  billing: `${HAG}/ability-billing/v1/agent-purchases-client/privilege/query`,
  credential: `${HAG}/user-credential/v1/business-credential/create`,
  refresh: `${HAG}/user-credential/v1/xiaoyiwork/refresh-token`,
}

const OAUTH = {
  clientId: '6917612679526496902',
  redirectUri: 'http://127.0.0.1:17355/auth/callback',
  callbackPort: 17355,
  callbackPath: '/auth/callback',
  scope: 'openid profile https://www.huawei.com/auth/drive https://www.huawei.com/auth/drive.xiaoyiwork',
  accessType: 'offline',
  codeTtlMs: 5 * 60 * 1000,
}

const PLATFORM_AGENT_ID = 'agent208b6760552b4fa0b395e5165d0d771e'
const CELIA_PREMIUM_AGENT_ID = '1'

/**
 * 供应商 / 插件图标：直接用 package.json 里 magpie.icon 的那份
 * （官方小艺Work 图标，160×160 PNG 的 data URI）。
 * 这里再读一次是为了让 `auth.icon` 也带上，账号卡片和供应商行都能显示；
 * 读不到就算了 —— magpie 自己会用 magpie.icon 兜底。
 */
const PLUGIN_ICON = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    const icon = pkg?.magpie?.icon
    return typeof icon === 'string' ? icon : ''
  } catch {
    return ''
  }
})()

/**
 * 上游标灰的模型：小艺Work 的模型选择器对 `gray === true` 给的是
 * `disabled: true` + title「灰度中，暂不可选」——即官方也不让选。
 * 所以插件默认隐藏；要放开用 options.showGray = true（会用 13x 的点数）。
 */
const GRAY_MODELS = new Set(['Kimi_K3.1_Pro_VE'])

/**
 * 静态兜底模型表；真实列表由 provider.models 钩子按账号拉取（带倍率）。
 *
 * `modalities.input` 里的 image 是**实测**出来的：拿一张写着 "MAGPIE-7391" 的图
 * 逐个模型问编号，只有这几个能读出来，其余会答"没有看到图片/无法识别"。
 * `rate` 是上游 aiPointConsumptionRatio 的静态副本，目录拉不到时也能显示倍率。
 */
const DEFAULT_MODELS = {
  'LLM_DeepSeekV4_Think': {
    name: 'DeepSeek-V4-Flash',
    reasoning: true,
    tool_call: true,
    rate: 'x1',
    modalities: { input: ['text'], output: ['text'] },
    limit: { context: 1000000, output: 32000 },
  },
  'DeepSeek_V4.1_Flash_VE': {
    name: 'DeepSeek-V4.1-Flash',
    reasoning: true,
    tool_call: true,
    rate: 'x1',
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 1000000, output: 32000 },
  },
  'LLM_GLM5.3': {
    name: 'GLM-5.3',
    reasoning: true,
    tool_call: true,
    rate: 'x8',
    modalities: { input: ['text'], output: ['text'] },
    limit: { context: 1000000, output: 32768 },
  },
  'GLM_5.3_FLASH_VE': {
    name: 'GLM-5.3-Flash',
    reasoning: true,
    tool_call: true,
    rate: 'x0.8',
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 1000000, output: 32768 },
  },
  'MiniMax_M3.1_Flash': {
    name: 'MiniMax M3.1 Flash',
    reasoning: true,
    tool_call: true,
    rate: 'x1',
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 1000000, output: 32768 },
  },
  'Kimi_K3.1_Pro_VE': {
    name: 'Kimi K3.1 Pro',
    reasoning: true,
    tool_call: true,
    rate: 'x13',
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 1000000, output: 32768 },
  },
  'OpenPanguV2-Pro': {
    name: 'openPangu-2.1-Pro',
    reasoning: true,
    tool_call: true,
    rate: 'x1',
    modalities: { input: ['text'], output: ['text'] },
    limit: { context: 1000000, output: 32000 },
  },
  'Auto-Model': {
    name: 'Auto-Model',
    tool_call: true,
    modalities: { input: ['text'], output: ['text'] },
    limit: { context: 1000000, output: 32000 },
  },
}

/* ========================================================================== */
/* 小工具                                                                      */
/* ========================================================================== */

const traceId = () => 'mp-' + crypto.randomBytes(8).toString('hex')
const b64url = (buf) => Buffer.from(buf).toString('base64url')

function messages(content) {
  return Array.isArray(content) ? content.join(' ') : String(content ?? '')
}

function readJsonSafe(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** "消耗8x" → "x8"；magpie 的 rate 字段 */
function normalizeRate(raw) {
  if (typeof raw !== 'string') return undefined
  const m = raw.match(/(\d+(?:\.\d+)?)\s*[x×]/i)
  if (!m) return undefined
  const n = Number(m[1])
  if (!Number.isFinite(n) || n === 0) return undefined
  return `x${n}`
}

/* ========================================================================== */
/* 设备 / 机器标识                                                              */
/* ========================================================================== */

let cachedMachineId = null

function machineGuid() {
  if (process.platform !== 'win32') return null
  for (const key of [
    'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Cryptography',
  ]) {
    try {
      const out = execFileSync('reg.exe', ['query', key, '/v', 'MachineGuid'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8000,
      })
      const m = out.match(/MachineGuid\s+REG_SZ\s+(.*)/)
      if (m?.[1]) return m[1].trim()
    } catch {
      /* 下一个 */
    }
  }
  return null
}

/**
 * deviceId 必须是这个 uid 名下「已登记」的设备：
 *   小艺Work 首次登录时用 sha256(MachineGuid) 登记过，换一个值上游会以
 *   clientId is invalid 拒绝（名字骗人，其实是设备校验）。
 */
function machineId() {
  if (cachedMachineId) return cachedMachineId
  const guid = machineGuid()
  if (guid) cachedMachineId = crypto.createHash('sha256').update(guid).digest('hex').toLowerCase()
  else cachedMachineId = crypto.createHash('sha256').update(`${os.hostname()}|${os.userInfo().username}`).digest('hex').toLowerCase()
  return cachedMachineId
}

function deviceIdFor(uid) {
  return `${machineId()}_${uid}`
}

/* ========================================================================== */
/* 上游请求                                                                    */
/* ========================================================================== */

function hagHeaders({ credential, uid, deviceId, trace = traceId(), sse = true }) {
  const headers = {
    'content-type': 'application/json',
    accept: sse ? 'text/event-stream' : 'application/json',
    businessCredential: credential,
    'x-uid': uid,
    'x-device-id': deviceId,
    'x-request-from': 'xiaoyiWork',
    'x-businessId': 'WINPC_XIAOYI_WORK',
    'x-hag-trace-id': trace,
  }
  return headers
}

async function postJson(url, { headers, body, signal, timeoutMs = 30000 }) {
  const signal2 = signal ?? AbortSignal.timeout(timeoutMs)
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: signal2 })
  const text = await res.text()
  return { status: res.status, ok: res.ok, text, json: readJsonSafe(text) }
}

/* ========================================================================== */
/* 凭据：签发 / 代刷                                                            */
/* ========================================================================== */

function credentialExtras(json) {
  const credential =
    json?.credentialResult?.businessCredential ||
    json?.credentialResult?.credential ||
    json?.data?.businessCredential ||
    json?.data?.credential ||
    json?.businessCredential ||
    json?.credential ||
    null
  const validTimeSec =
    (typeof json?.credentialResult?.validTime === 'number' && json.credentialResult.validTime) ||
    (typeof json?.data?.validTime === 'number' && json.data.validTime) ||
    (typeof json?.validTime === 'number' && json.validTime) ||
    null
  return { credential, validTimeSec }
}

/**
 * 用「刚签发」的 accessToken 换 businessCredential。
 * accessToken 必须新鲜（几分钟窗口），否则后端回 clientId is invalid。
 */
async function createCredential(uat, uid, deviceId) {
  const res = await postJson(ENDPOINTS.credential, {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${uat}`,
      'x-uid': uid,
      'x-client-version': '1.0.0',
      'x-hag-trace-id': traceId(),
    },
    body: { deviceId, uid, clientId: OAUTH.clientId, sysVer: '5.0.0', version: '1.0.0', ts: String(Date.now()) },
  })
  const { credential, validTimeSec } = credentialExtras(res.json)
  if (!res.ok || !credential) {
    const message = res.json?.desc || res.json?.message || res.text.slice(0, 200) || `HTTP ${res.status}`
    return { ok: false, status: res.status, message: `${message}（HTTP ${res.status}）`, raw: res.json }
  }
  return {
    ok: true,
    credential,
    validTimeSec: validTimeSec ?? Math.floor(Date.now() / 1000) + 7 * 86400,
    raw: res.json,
  }
}

/** 网关代刷：把 refreshToken 交给 HAG 换新 accessToken（client_secret 在服务端） */
async function gatewayRefreshToken({ credential, uid, deviceId, refreshToken }) {
  const res = await postJson(ENDPOINTS.refresh, {
    headers: hagHeaders({ credential, uid, deviceId, sse: false }),
    body: { refreshToken },
  })
  const token = typeof res.json?.token === 'string' ? res.json.token.trim() : ''
  if (!res.ok || !token) {
    const message = res.json?.desc || res.json?.message || res.text.slice(0, 200) || `HTTP ${res.status}`
    return { ok: false, status: res.status, message: `${message}（HTTP ${res.status}）` }
  }
  return { ok: true, token }
}

/** 完整续期：代刷 → 立刻签票。两步必须紧挨着（token 有新鲜度窗口） */
async function renewCredential(state) {
  const { credential, refreshToken, uid, deviceId } = state
  if (!refreshToken) return { ok: false, message: '没有 refreshToken，请重新登录' }
  const refreshed = await gatewayRefreshToken({ credential, uid, deviceId, refreshToken })
  if (!refreshed.ok) return { ok: false, message: `网关代刷失败：${refreshed.message}` }
  const created = await createCredential(refreshed.token, uid, deviceId)
  if (!created.ok) return { ok: false, message: `签票失败：${created.message}` }
  return { ok: true, credential: created.credential, validTimeSec: created.validTimeSec, accessToken: refreshed.token }
}

/* ========================================================================== */
/* OAuth（浏览器登录）                                                          */
/* ========================================================================== */

function buildAuthorizeUrl(challenge, state) {
  const q = new URLSearchParams({
    response_type: 'code',
    access_type: OAUTH.accessType,
    client_id: OAUTH.clientId,
    redirect_uri: OAUTH.redirectUri,
    scope: OAUTH.scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    display: 'page',
  })
  return `${ENDPOINTS.authorize}?${q.toString()}`
}

function startCallbackServer(expectedState, signal) {
  let settle
  const codePromise = new Promise((resolve, reject) => {
    settle = { resolve, reject }
  })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${OAUTH.callbackPort}`)
    if (url.pathname !== OAUTH.callbackPath) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return
    }
    const code = url.searchParams.get('code')
    const gotState = url.searchParams.get('state')
    const error = url.searchParams.get('error')
    const html = (body) =>
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }).end(
        `<!doctype html><meta charset="utf-8"><body style="font:16px/1.7 system-ui;margin:48px">${body}</body>`,
      )
    if (error || !code) {
      html('<h2>授权失败</h2><p>回到 magpie 看错误信息。</p>')
      settle.reject(new Error(`授权回调失败：${error || '缺少 code'} ${url.searchParams.get('error_description') || ''}`))
      return
    }
    if (gotState !== expectedState) {
      html('<h2>state 不匹配</h2><p>请重新登录。</p>')
      settle.reject(new Error('回调 state 不匹配（可能是过期的授权链接）'))
      return
    }
    html('<h2>登录成功 ✅</h2><p>可以关闭这个页面了。</p>')
    settle.resolve(code)
  })
  const timer = setTimeout(() => settle.reject(new Error('授权超时（5 分钟）')), OAUTH.codeTtlMs)

  const close = () => {
    clearTimeout(timer)
    try {
      server.closeAllConnections?.()
      server.close()
    } catch {
      /* ignore */
    }
  }
  signal?.addEventListener?.('abort', () => settle.reject(new Error('登录已取消')))
  codePromise.catch(() => {}).finally(close)

  const listening = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(OAUTH.callbackPort, '127.0.0.1', resolve)
  })

  return { codePromise, listening, close }
}

async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: OAUTH.clientId,
    code_verifier: verifier,
    redirect_uri: OAUTH.redirectUri,
  })
  const res = await fetch(ENDPOINTS.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  const text = await res.text()
  const json = readJsonSafe(text) ?? {}
  if (!res.ok || !json.access_token) {
    throw new Error(`换 token 失败（HTTP ${res.status}）：${json.error_description || text.slice(0, 200)}`)
  }
  const claims = readJsonSafe(Buffer.from(String(json.id_token || '').split('.')[1] || '', 'base64url').toString('utf8')) ?? {}
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || null,
    idToken: json.id_token || '',
    scope: json.scope || OAUTH.scope,
    expiresIn: Number(json.expires_in) || 3600,
    user: {
      uid: claims.uid,
      openid: claims.openid,
      unionId: claims.sub,
      aud: claims.aud,
      displayName: claims.display_name || claims.nickname,
    },
  }
}

/* ========================================================================== */
/* 读取本机小艺Work 凭据（Windows：注册表 + DPAPI + AES-256-GCM）                */
/* ========================================================================== */

const KEYCHAIN = 'HKCU\\Software\\ClawDesktop\\keychain'
const USER_DATA_NAMES = ['xiaoyiWork', 'xiaoyiwork']

function regQuery(keyPath, valueName) {
  try {
    const out = execFileSync('reg.exe', ['query', keyPath, '/v', valueName], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    })
    for (const line of String(out).split(/\r?\n/)) {
      const m = line.match(/^\s+(\S+)\s+REG_SZ\s+(.*)$/)
      if (m && m[1] === valueName) return m[2].trim()
    }
  } catch {
    /* 没有 */
  }
  return null
}

function dpapiUnprotect(data) {
  const tmp = path.join(os.tmpdir(), `magpie-dpapi-${process.pid}-${crypto.randomBytes(4).toString('hex')}.bin`)
  fs.writeFileSync(tmp, data, { mode: 0o600 })
  const script = [
    "$ErrorActionPreference='Stop'",
    `Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public class MagpieDpapi {
  [DllImport("crypt32.dll", SetLastError=true)] public static extern bool CryptUnprotectData(ref BLOB i, IntPtr d, IntPtr e, IntPtr r, IntPtr p, int f, ref BLOB o);
  [StructLayout(LayoutKind.Sequential)] public struct BLOB { public int cbData; public IntPtr pbData; }
  public static byte[] U(byte[] data) {
    BLOB i = new BLOB(); BLOB o = new BLOB();
    i.cbData = data.Length; i.pbData = Marshal.AllocHGlobal(data.Length); Marshal.Copy(data,0,i.pbData,data.Length);
    if (!CryptUnprotectData(ref i, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, 0, ref o)) throw new Exception("dpapi " + Marshal.GetLastWin32Error());
    byte[] r = new byte[o.cbData]; Marshal.Copy(o.pbData, r, 0, o.cbData); return r;
  }
}
'@`,
    `$b=[IO.File]::ReadAllBytes('${tmp.replace(/'/g, "''")}')`,
    '[Convert]::ToBase64String([MagpieDpapi]::U($b))',
  ].join('\n')
  try {
    const shell = process.platform === 'win32' ? 'pwsh' : null
    const candidates = ['pwsh', 'powershell']
    let out = null
    for (const exe of candidates) {
      try {
        out = execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], {
          encoding: 'utf8',
          timeout: 60000,
          windowsHide: true,
        })
        break
      } catch {
        /* 换下一个 */
      }
    }
    if (!out) throw new Error(shell ? 'PowerShell 调用失败' : '找不到 PowerShell')
    return Buffer.from(out.trim(), 'base64')
  } finally {
    try {
      fs.rmSync(tmp, { force: true })
    } catch {
      /* ignore */
    }
  }
}

function readLocalCredential() {
  if (process.platform !== 'win32') throw new Error('读取本机凭据仅支持 Windows')
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  let stateFile = null
  for (const name of USER_DATA_NAMES) {
    const candidate = path.join(appData, name, 'Local State')
    if (fs.existsSync(candidate)) {
      stateFile = candidate
      break
    }
  }
  if (!stateFile) throw new Error(`找不到小艺Work 数据目录（${path.join(appData, 'xiaoyiWork')}）`)

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  const encKey = state?.os_crypt?.encrypted_key
  if (!encKey) throw new Error('Local State 缺少 os_crypt.encrypted_key')
  const raw = Buffer.from(encKey, 'base64')
  if (raw.subarray(0, 5).toString('latin1') !== 'DPAPI') throw new Error('不支持的 os_crypt 加密方案（并非 DPAPI）')
  const masterKey = dpapiUnprotect(raw.subarray(5))

  const decrypt = (blobB64) => {
    const blob = Buffer.from(blobB64, 'base64')
    if (blob.subarray(0, 3).toString('latin1') !== 'v10') throw new Error('无法识别的密文前缀')
    const nonce = blob.subarray(3, 15)
    const tag = blob.subarray(blob.length - 16)
    const ct = blob.subarray(15, blob.length - 16)
    const d = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce)
    d.setAuthTag(tag)
    return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'))
  }
  const readSecret = (service, account) => {
    const value = regQuery(`${KEYCHAIN}\\${service}`, b64url(account))
    if (!value) return null
    try {
      return decrypt(value).v
    } catch {
      return null
    }
  }

  const credRaw = readSecret('business-credential', 'default')
  const cred = readJsonSafe(credRaw)
  if (!cred?.credential || !cred?.uid) throw new Error('本机没有 businessCredential：先打开小艺Work 登录一次')
  const sessionRaw = readSecret('auth-session', 'default')
  const session = readJsonSafe(sessionRaw)
  return {
    credential: cred.credential,
    uid: cred.uid,
    deviceId: `${machineId()}_${cred.uid}`,
    validTimeSec: cred.validTimeSec ?? null,
    refreshToken: session?.refreshToken ?? null,
  }
}

/* ========================================================================== */
/* 模型目录 / 积分                                                              */
/* ========================================================================== */

async function queryCatalog(state) {
  const res = await postJson(ENDPOINTS.gallery, {
    headers: {
      ...hagHeaders({ ...state, sse: false }),
      // 缺这个头网关直接 400（Parameter is not valid），目录/倍率就全丢了
      'x-prd-pkg-name': 'com.huawei.hmos.vassistant',
    },
    body: {
      type: 'CELIA_CLAW_USER_MODEL_QUERY',
      terminalInfo: {
        agentId: PLATFORM_AGENT_ID,
        brand: 'HUAWEI',
        countryCode: 'CN',
        deviceType: 'PC',
        language: 'zh_CN',
        locale: 'zh-CN',
        manufacturer: 'HUAWEI',
        osType: 'Hap',
        phoneType: 'ALN-AL80',
        prdVer: '11.6.5.414',
        privacyOption: {},
        sysVer: 'OpenHarmony-6.1.1.35(Beta1)',
        ohosApiVersion: 24,
      },
      pagination: { limit: 500, start: '0' },
    },
  })
  if (!res.ok) return null
  const list = []
  for (const content of res.json?.contents ?? []) {
    for (const item of content.modelList ?? []) {
      const id = String(item.modelValue || '').trim()
      if (!id) continue
      list.push({
        id,
        name: String(item.modelName || id).trim(),
        description: String(item.modelDescription || '').trim(),
        rate: normalizeRate(item.aiPointConsumptionRatio),
        gray: item.gray === true,
      })
    }
  }
  return list.length ? list : null
}

function parseCompactTime(value) {
  if (typeof value !== 'string') return null
  const m = value.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{1,3})?$/)
  if (!m) return null
  const [, y, mo, d, h, mi, s, ms = '0'] = m
  const time = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h) - 8, Number(mi), Number(s), Number(ms.padEnd(3, '0')))
  return { iso: new Date(time).toISOString(), epoch: time }
}

const num = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return 0
}

async function queryBilling(agentId, state) {
  // agentId=1 那个接口偶发 408（Request Timeout），多试几次能显著提升成功率
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await postJson(ENDPOINTS.billing, {
      headers: hagHeaders({ ...state, sse: false }),
      body: {
        accountType: 'HW_UID',
        agentId,
        endpoint: {
          device: { brand: 'HUAWEI', deviceId: state.deviceId },
          eduMode: 'NONEDU',
          foregroundPkgName: '',
          isXiaoyiAPP: false,
          language: 'zh_CN',
          languageMode: 'MANDARIN',
          locale: 'default',
        },
      },
    }).catch(() => null)
    if (res?.ok) return res.json
    if (attempt < 2) await new Promise((r) => setTimeout(r, 700 * (attempt + 1)))
  }
  return null
}

/* ========================================================================== */
/* SSE 改写 / 聚合                                                              */
/* ========================================================================== */

function patchChunk(obj, modelHint) {
  const out = { ...obj }
  out.object ??= 'chat.completion.chunk'
  out.created ??= Math.floor(Date.now() / 1000)
  if (!out.model) out.model = modelHint || ''
  out.id ??= 'chatcmpl-' + crypto.randomBytes(9).toString('hex')
  if (Array.isArray(out.choices)) {
    out.choices = out.choices.map((c, i) => ({ ...c, index: typeof c.index === 'number' ? c.index : i }))
  }
  return out
}

function frameToText(block, modelHint) {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n')
    .trim()
  if (!data) return null
  if (data === '[DONE]') return null
  const parsed = readJsonSafe(data)
  if (!parsed) return null
  return `data: ${JSON.stringify(patchChunk(parsed, modelHint))}\n\n`
}

function transformSse(upstream, modelHint) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buf = ''
  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader()
      const push = (text) => text && controller.enqueue(encoder.encode(text))
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n')
          let idx
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            push(frameToText(block, modelHint))
          }
        }
        push(frameToText(buf, modelHint)) // 尾部残帧
      } catch (err) {
        push(`data: ${JSON.stringify({ error: { message: `上游流式中断: ${err?.message || err}` } })}\n\n`)
      } finally {
        // 上游不发 [DONE]，这里补上，否则不少客户端会一直挂着等
        push('data: [DONE]\n\n')
        try {
          reader.releaseLock()
        } catch {
          /* ignore */
        }
        controller.close()
      }
    },
  })
}

async function aggregate(upstream, modelHint) {
  const decoder = new TextDecoder()
  let buf = ''
  const acc = { content: '', reasoning: '', toolCalls: new Map(), finish: null, usage: null, error: null }
  const feed = (block) => {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
      .trim()
    if (!data || data === '[DONE]') return
    const frame = readJsonSafe(data)
    if (!frame) return
    if (frame.error && !acc.error) acc.error = frame.error
    if (frame.usage && typeof frame.usage === 'object') acc.usage = frame.usage
    const choice = Array.isArray(frame.choices) ? frame.choices[0] : null
    if (!choice) return
    const delta = choice.delta || {}
    if (typeof delta.content === 'string') acc.content += delta.content
    if (typeof delta.reasoning_content === 'string') acc.reasoning += delta.reasoning_content
    if (Array.isArray(delta.tool_calls)) {
      for (const [i, tc] of delta.tool_calls.entries()) {
        const key = typeof tc.index === 'number' ? tc.index : i
        const entry = acc.toolCalls.get(key) ?? { id: '', type: 'function', function: { name: '', arguments: '' } }
        if (tc.id) entry.id = tc.id
        const name = tc.function?.name ?? tc.name
        if (name) entry.function.name = entry.function.name || name
        const args = tc.function?.arguments ?? tc.arguments
        if (typeof args === 'string') entry.function.arguments += args
        else if (args && typeof args === 'object') entry.function.arguments += JSON.stringify(args)
        acc.toolCalls.set(key, entry)
      }
    }
    if (choice.finish_reason) acc.finish = choice.finish_reason
  }

  for await (const chunk of upstream) {
    buf += decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n')
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx)
      buf = buf.slice(idx + 2)
      feed(block)
    }
  }
  feed(buf)

  if (acc.error && !acc.content && !acc.reasoning && acc.toolCalls.size === 0) {
    return { error: acc.error }
  }

  const message = { role: 'assistant', content: acc.content }
  if (acc.reasoning) message.reasoning_content = acc.reasoning
  if (acc.toolCalls.size) {
    message.tool_calls = [...acc.toolCalls.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, tc]) => ({
        id: tc.id || 'call_' + crypto.randomBytes(6).toString('hex'),
        type: 'function',
        function: { name: tc.function.name, arguments: tc.function.arguments || '{}' },
      }))
    if (!message.content) message.content = null
  }
  const prompt = acc.usage?.prompt_tokens ?? acc.usage?.input_tokens ?? 0
  const completion = acc.usage?.completion_tokens ?? acc.usage?.output_tokens ?? 0
  return {
    id: 'chatcmpl-' + crypto.randomBytes(9).toString('hex'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelHint || '',
    choices: [
      {
        index: 0,
        message,
        finish_reason: acc.finish || (acc.toolCalls.size ? 'tool_calls' : 'stop'),
      },
    ],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: acc.usage?.total_tokens ?? prompt + completion,
    },
  }
}

/* ========================================================================== */
/* 工具 Schema 归一化（补全 Kimi 要求的 type）                                  */
/* ========================================================================== */

const SCHEMA_MAP_KEYS = ['properties', '$defs', 'definitions', 'dependentSchemas', 'patternProperties']
const SCHEMA_CHILD_KEYS = [
  'items',
  'additionalProperties',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'allOf',
  'anyOf',
  'oneOf',
  'prefixItems',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contentSchema',
]
const SCHEMA_NOTE_KEYS = new Set(['$ref', 'description', 'title', 'default', 'examples', '$comment'])
const ALL_SCHEMA_TYPES = ['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']

const hasOwn = (obj, k) => Object.prototype.hasOwnProperty.call(obj, k)
const isSchemaObj = (v) => Boolean(v && typeof v === 'object' && !Array.isArray(v))

function schemaKeywordType(s) {
  const hasAny = (keys) => keys.some((k) => hasOwn(s, k) && s[k] !== undefined)
  if (
    hasAny([
      'properties',
      'required',
      'additionalProperties',
      'patternProperties',
      'minProperties',
      'maxProperties',
      'propertyNames',
      'dependentRequired',
      'dependentSchemas',
      'unevaluatedProperties',
    ])
  ) {
    return 'object'
  }
  if (hasAny(['items', 'prefixItems', 'minItems', 'maxItems', 'uniqueItems', 'contains', 'unevaluatedItems'])) {
    return 'array'
  }
  if (hasAny(['minLength', 'maxLength', 'pattern', 'format', 'contentEncoding', 'contentMediaType'])) {
    return 'string'
  }
  if (hasAny(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'])) {
    return 'number'
  }
  return ''
}

function scalarJsonType(v) {
  if (typeof v === 'string') return 'string'
  if (typeof v === 'boolean') return 'boolean'
  if (typeof v === 'number' && Number.isFinite(v)) return Number.isInteger(v) ? 'integer' : 'number'
  return ''
}

function inferEnumType(vals) {
  if (!Array.isArray(vals) || vals.length === 0) return null
  let hasNull = false
  let baseType = ''
  for (const v of vals) {
    if (v === null) {
      hasNull = true
      continue
    }
    const vt = scalarJsonType(v)
    if (!vt) return null
    if (!baseType || baseType === vt) baseType = vt
    else if ((baseType === 'integer' && vt === 'number') || (baseType === 'number' && vt === 'integer')) {
      baseType = 'number'
    } else return null
  }
  if (!baseType) return hasNull ? 'null' : null
  return hasNull ? [baseType, 'null'] : baseType
}

function fillUntypedEnums(node, inSchema) {
  if (Array.isArray(node)) {
    for (const item of node) fillUntypedEnums(item, inSchema)
    return
  }
  if (!isSchemaObj(node)) return

  if (inSchema && !hasOwn(node, 'type')) {
    const vals = Array.isArray(node.enum) ? node.enum : hasOwn(node, 'const') ? [node.const] : null
    if (vals) {
      const kt = schemaKeywordType(node)
      if (kt === 'object' || kt === 'array') {
        node.type = kt
      } else {
        const inferred = inferEnumType(vals)
        if (inferred) node.type = inferred
      }
    }
  }

  if (!inSchema) {
    if (hasOwn(node, 'parameters')) fillUntypedEnums(node.parameters, true)
    if (hasOwn(node, 'input_schema')) fillUntypedEnums(node.input_schema, true)
    if (hasOwn(node, 'function')) fillUntypedEnums(node.function, false)
    return
  }

  for (const k of SCHEMA_MAP_KEYS) {
    const m = node[k]
    if (isSchemaObj(m)) {
      for (const sub of Object.values(m)) fillUntypedEnums(sub, true)
    }
  }
  for (const k of SCHEMA_CHILD_KEYS) {
    const child = node[k]
    if (child && typeof child === 'object') fillUntypedEnums(child, true)
  }
}

function walkSchema(node, fn) {
  if (Array.isArray(node)) {
    for (const item of node) walkSchema(item, fn)
    return
  }
  if (!isSchemaObj(node)) return
  fn(node)
  for (const k of SCHEMA_MAP_KEYS) {
    const m = node[k]
    if (isSchemaObj(m)) {
      for (const sub of Object.values(m)) walkSchema(sub, fn)
    }
  }
  for (const k of SCHEMA_CHILD_KEYS) {
    const child = node[k]
    if (child && typeof child === 'object') walkSchema(child, fn)
  }
}

function resolveRefTarget(root, ref) {
  if (typeof ref !== 'string') return null
  if (ref === '#') return root
  if (!ref.startsWith('#/')) return null
  let cur = root
  for (let tok of ref.slice(2).split('/')) {
    tok = tok.replace(/~1/g, '/').replace(/~0/g, '~')
    try {
      tok = decodeURIComponent(tok)
    } catch {
      /* keep raw token */
    }
    if (!cur || typeof cur !== 'object') return null
    if (Array.isArray(cur)) {
      const idx = Number(tok)
      if (!Number.isInteger(idx) || idx < 0 || idx >= cur.length) return null
      cur = cur[idx]
    } else if (hasOwn(cur, tok)) {
      cur = cur[tok]
    } else {
      return null
    }
  }
  return cur && typeof cur === 'object' ? cur : null
}

function needsRefTargetType(s) {
  if (!isSchemaObj(s) || hasOwn(s, 'type') || hasOwn(s, 'anyOf')) return false
  const keys = Object.keys(s)
  if (keys.length === 0) return false
  const onlyNotes = keys.every((k) => SCHEMA_NOTE_KEYS.has(k))
  return !(onlyNotes && typeof s.$ref === 'string')
}

function collectSchemaTypes(root, s, depth = 0) {
  if (depth > 16 || !isSchemaObj(s)) return null
  const ts = new Set()
  if (hasOwn(s, 'type')) {
    const arr = Array.isArray(s.type) ? s.type : typeof s.type === 'string' ? [s.type] : []
    for (const t of arr) if (typeof t === 'string' && t) ts.add(t)
    return ts
  }
  if (typeof s.$ref === 'string') {
    const target = resolveRefTarget(root, s.$ref)
    return target ? collectSchemaTypes(root, target, depth + 1) : null
  }
  if (Array.isArray(s.enum) || hasOwn(s, 'const')) {
    const vals = Array.isArray(s.enum) ? s.enum : [s.const]
    for (const v of vals) {
      if (v === null) ts.add('null')
      else if (Array.isArray(v)) ts.add('array')
      else if (typeof v === 'object') ts.add('object')
      else {
        const vt = scalarJsonType(v)
        if (vt) ts.add(vt)
      }
    }
    return ts
  }
  for (const k of ['oneOf', 'anyOf', 'allOf']) {
    if (!Array.isArray(s[k])) continue
    let known = false
    for (const branch of s[k]) {
      const bt = collectSchemaTypes(root, branch, depth + 1)
      if (!bt || bt.size === 0) {
        if (k !== 'allOf') return null
        continue
      }
      for (const t of bt) {
        ts.add(t)
        known = true
      }
    }
    if (known) return ts
  }
  const kt = schemaKeywordType(s)
  if (!kt) return null
  ts.add(kt)
  return ts
}

function inferRefTargetType(root, s) {
  const kt = schemaKeywordType(s)
  if (kt === 'object' || kt === 'array') return kt
  if (Array.isArray(s.enum)) return inferEnumType(s.enum)
  if (hasOwn(s, 'const')) return inferEnumType([s.const])
  const ts = collectSchemaTypes(root, s, 0)
  if (!ts || ts.size === 0) return ALL_SCHEMA_TYPES
  if (ts.has('integer') && ts.has('number')) ts.delete('integer')
  const ordered = ALL_SCHEMA_TYPES.filter((t) => ts.has(t))
  if (ordered.length === 0) return ALL_SCHEMA_TYPES
  return ordered.length === 1 ? ordered[0] : ordered
}

function cloneJson(v) {
  return v && typeof v === 'object' ? JSON.parse(JSON.stringify(v)) : v
}

function inlineLocalRefs(root) {
  let unresolved = false
  const budget = { left: 1000 }

  const expand = (node, seen, depth) => {
    if (Array.isArray(node)) {
      return node.map((item) => expand(item, seen, depth))
    }
    if (!isSchemaObj(node)) return node

    if (typeof node.$ref === 'string') {
      const ref = node.$ref
      const target = resolveRefTarget(root, ref)
      if (!target) {
        unresolved = true
        return node
      }
      const { $ref: _drop, ...siblings } = node
      if (seen.has(ref) || depth > 24 || budget.left <= 0) {
        const kt = schemaKeywordType(target)
        const fallback = hasOwn(siblings, 'type') ? siblings : { type: kt || 'object', ...siblings }
        return expand(fallback, seen, depth + 1)
      }
      budget.left -= 1
      const nextSeen = new Set(seen)
      nextSeen.add(ref)
      const expandedTarget = expand(cloneJson(target), nextSeen, depth + 1)
      const expandedSiblings = {}
      for (const [k, v] of Object.entries(siblings)) {
        expandedSiblings[k] = expand(v, seen, depth + 1)
      }
      return isSchemaObj(expandedTarget) ? { ...expandedTarget, ...expandedSiblings } : expandedSiblings
    }

    for (const k of SCHEMA_MAP_KEYS) {
      if (k === '$defs' || k === 'definitions') continue
      const m = node[k]
      if (isSchemaObj(m)) {
        for (const [prop, sub] of Object.entries(m)) {
          m[prop] = expand(sub, seen, depth + 1)
        }
      }
    }
    for (const k of SCHEMA_CHILD_KEYS) {
      if (hasOwn(node, k) && node[k] && typeof node[k] === 'object') {
        node[k] = expand(node[k], seen, depth + 1)
      }
    }
    return node
  }

  expand(root, new Set(), 0)
  if (!unresolved) {
    delete root.$defs
    delete root.definitions
  }
}

function fillUntypedRefs(root) {
  walkSchema(root, (node) => {
    if (typeof node.$ref !== 'string') return
    let target = resolveRefTarget(root, node.$ref)
    for (let i = 0; target && typeof target.$ref === 'string'; i += 1) {
      if (i > 16) return
      target = resolveRefTarget(root, target.$ref)
    }
    if (!target || !needsRefTargetType(target)) return
    const inferred = inferRefTargetType(root, target)
    if (inferred) target.type = inferred
  })
}

/** Kimi/小艺Work 拒绝无 type 的 enum/const 及 $ref，转发前内联 $ref 并补全 type */
function normalizeToolSchemas(bodyObj) {
  if (!bodyObj || typeof bodyObj !== 'object') return bodyObj
  const fixRoot = (root) => {
    if (!isSchemaObj(root)) return
    inlineLocalRefs(root)
    fillUntypedEnums(root, true)
    fillUntypedRefs(root)
  }
  if (Array.isArray(bodyObj.tools)) {
    for (const tool of bodyObj.tools) {
      if (!isSchemaObj(tool)) continue
      fixRoot(tool.function?.parameters)
      fixRoot(tool.parameters)
      fixRoot(tool.input_schema)
    }
  }
  if (Array.isArray(bodyObj.functions)) {
    for (const fn of bodyObj.functions) {
      if (isSchemaObj(fn)) fixRoot(fn.parameters)
    }
  }
  return bodyObj
}

/* ========================================================================== */
/* 登录态归一化                                                                 */
/* ========================================================================== */

function normalizeAuth(auth) {
  if (!auth || typeof auth !== 'object') return null
  const credential = auth.access || auth.key || null
  const uid = auth.uid || auth.metadata?.uid || null
  if (!credential || !uid) return null
  return {
    credential,
    uid,
    deviceId: auth.deviceId || auth.metadata?.deviceId || deviceIdFor(uid),
    refreshToken: auth.refresh || auth.metadata?.refreshToken || null,
    validTimeSec: auth.metadata?.expires ? Math.floor(auth.metadata.expires / 1000) : auth.expires ? Math.floor(auth.expires / 1000) : null,
    fromLocal: auth.type === 'api',
  }
}

/* ========================================================================== */
/* 同一账号去重                                                                */
/* ========================================================================== */
/*
 * magpie 只对 oauth 账号按 accountId/uid 覆盖，api 账号基本只比 key ——
 * 两种登录方式给出的 credential 每次都不一样，所以「先本机导入、再浏览器登录」
 * 会变成两个同 uid 的账号。这里自己把关：
 *   直接读 magpie 自己的 plugin-auth.json，看这个 uid 是否已经占了槽位。
 * 好处：用户在 magpie 里把账号删掉后，判断立刻失效，不会留下永久黑名单。
 */

function readPluginAuth(directory) {
  if (!directory) return null
  try {
    return readJsonSafe(fs.readFileSync(path.join(directory, 'plugin-auth.json'), 'utf8'))
  } catch {
    return null
  }
}

/** 返回该 uid 已经占用的账号槽位（xiaoyiwork / xiaoyiwork#xxxxxx） */
function findAccountSlots(directory, uid) {
  if (!uid) return []
  const all = readPluginAuth(directory)
  if (!all) return []
  const hits = []
  for (const [slot, value] of Object.entries(all)) {
    if (slot !== PROVIDER && !slot.startsWith(PROVIDER + '#')) continue
    const owner = value?.uid ?? value?.accountId ?? value?.metadata?.uid
    if (owner && String(owner) === String(uid)) hits.push(slot)
  }
  return hits
}

function duplicateError(slots, uid) {
  const slot = slots[0]
  const how = slot.includes('#') ? `（槽位 ${slot}）` : ''
  return (
    `账号 ${uid} 已经添加过了${how}，同一个账号只允许一个。` +
    '要换登录方式（比如从“读取本机登录态”换成“浏览器登录”），' +
    '先在 magpie 的插件页把旧账号删掉再回来添加；' +
    '若确实需要并存，给插件开 allowDuplicate 选项。'
  )
}

/* ========================================================================== */
/* 额度观测（给「剩余 / 总计」找分母）                                          */
/* ========================================================================== */
/*
 * 上游**没有**发放总量字段：
 *   · 会员积分池只有余额分解（freePoints/purchasedPoints/... 之和 = totalPoints）
 *   · 权益包只有 privilegeDetail 里的「剩余积分：N」，没有"发了多少"
 * 所以「总计」只能取"装本插件之后观测到的最大值"当分母 —— 首次读取时
 * 剩余即总计（对全新权益包是准确的），之后随消耗呈现 剩余/总计。
 * 状态存在 magpie 配置目录里，按 uid + 额度名分别记。
 */

const POINTS_STATE_FILE = 'xiaoyi-points-state.json'

function readPointsState(configDir) {
  if (!configDir) return {}
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir, POINTS_STATE_FILE), 'utf8')) ?? {}
  } catch {
    return {}
  }
}

function writePointsState(configDir, state) {
  if (!configDir) return
  try {
    fs.writeFileSync(path.join(configDir, POINTS_STATE_FILE), JSON.stringify(state, null, 2))
  } catch {
    /* 只读目录之类，忽略 */
  }
}

/** 记录并返回某个额度桶观测到的最大余额（= 总计） */
function observeMax(bucket, key, amount) {
  const prev = num(bucket[key])
  const next = Math.max(prev, num(amount))
  if (next !== prev) bucket[key] = next
  return next
}

/* ========================================================================== */
/* 幂等续期（usage / models 内部复用）                                          */
/* ========================================================================== */

async function ensureFreshState(state) {
  if (!state) return state
  const remaining = state.validTimeSec ? state.validTimeSec * 1000 - Date.now() : Infinity
  if (remaining > 12 * 3600_000) return state
  const renewed = await renewCredential(state).catch(() => null)
  if (renewed?.ok) {
    state.credential = renewed.credential
    state.validTimeSec = renewed.validTimeSec
  }
  return state
}

/* ========================================================================== */
/* 插件                                                                        */
/* ========================================================================== */

export const XiaoyiWorkAuthPlugin = async (input) => {
  const magpieCtx = input?.magpie ?? {}
  const configDir = input?.directory || null
  const optionBag = magpieCtx.options && typeof magpieCtx.options === 'object' ? magpieCtx.options : null

  /**
   * 读插件选项。magpie 有两种形状：
   *   · `magpie.option(providerId, key)` —— 函数（opencode-workbuddy-auth 用这个）
   *   · `magpie.options = { key: value }` —— 对象
   * 外加 `magpie plugin options <名字> '<json>'` 写进来的是同一份。
   */
  /**
   * 第一优先：直接读 magpie 的 plugins.json。
   * 编辑页/CLI 的开关值最终就落在 `options.<providerId>.<key>` 里，这是最可靠的一份。
   * （0.1.3313 的运行时读取会给出过期的 false / 空对象，实测踩过。）
   */
  const readOptionFromConfig = (...keys) => {
    if (!configDir) return undefined
    try {
      const j = JSON.parse(fs.readFileSync(path.join(configDir, 'plugins.json'), 'utf8'))
      for (const entry of j.plugins ?? []) {
        const bag = entry?.options
        if (!bag || typeof bag !== 'object') continue
        for (const key of keys) {
          const perProvider = bag[PROVIDER]
          if (perProvider && typeof perProvider === 'object' && perProvider[key] !== undefined) return perProvider[key]
          if (bag[key] !== undefined && bag[key] !== null) return bag[key]
        }
      }
    } catch {
      /* plugins.json 还没写或读不到 */
    }
    return undefined
  }

  /**
   * 第二优先：magpie 交给插件的运行时值。两种形状：
   *   · `magpie.option(providerId, key)` —— 函数（opencode-workbuddy-auth 用这个）
   *   · `magpie.options = { key: value }` —— 对象
   * 注意它可能返回 `false`（表示 magpie 认为开关关着），所以不能用 `??` 短路。
   */
  const readOptionRuntime = (...keys) => {
    for (const key of keys) {
      if (typeof magpieCtx.option === 'function') {
        try {
          const v = magpieCtx.option(PROVIDER, key)
          if (v !== undefined && v !== null) return v
        } catch {
          /* 旧版 magpie 没有函数式读取 */
        }
      }
      if (optionBag && optionBag[key] !== undefined && optionBag[key] !== null) return optionBag[key]
      if (magpieCtx.option && typeof magpieCtx.option === 'object' && magpieCtx.option[key] !== undefined) {
        return magpieCtx.option[key]
      }
    }
    return undefined
  }

  const readOption = (...keys) => {
    const fromConfig = readOptionFromConfig(...keys)
    return fromConfig !== undefined ? fromConfig : readOptionRuntime(...keys)
  }

  const truthy = (...keys) => {
    const v = readOption(...keys)
    return v === true || v === 'true' || v === 1 || v === '1' || v === 'on'
  }

  // 注意：magpie 是插件工厂跑完之后才把选项灌进来的（工厂那一刻读到的是空），
  // 所以不能把值存成常量，必须每次用到时再读。
  const allowDuplicate = () => truthy('allow_duplicate', 'allowDuplicate')
  // 灰度模型：小艺Work 的模型选择器对 gray===true 是 `disabled: true` + 「灰度中，暂不可选」，
  // 所以默认隐藏；在编辑页的「插件选项」里打开「显示灰度测试模型」才列出来。
  const showGray = () => truthy('show_gray', 'showGray')

  /** 同一账号只允许一个：返回 null 表示可以继续，否则返回要报给用户的错误 */
  const guardDuplicate = (uid) => {
    if (allowDuplicate() || !uid) return null
    const slots = findAccountSlots(configDir, uid)
    return slots.length ? duplicateError(slots, uid) : null
  }

  /** 过滤灰度模型（showGray=false 时整条剔除） */
  const visibleModels = (models) => {
    const out = {}
    for (const [id, model] of Object.entries(models ?? {})) {
      if (GRAY_MODELS.has(id)) {
        if (!showGray()) continue
        out[id] = { ...model, name: `${model.name}（灰度）` }
        continue
      }
      out[id] = model
    }
    return out
  }

function bodyTooLargeResponse(actualBytes, limitBytes = MAX_HAG_BODY_BYTES) {
  const actualMB = (actualBytes / 1048576).toFixed(2)
  const limitMB = (limitBytes / 1048576).toFixed(2)
  return new Response(
    JSON.stringify({
      error: {
        message: `Request body is ${actualMB} MB, over the ${limitMB} MB limit for one request (${limitBytes} bytes)`,
        type: 'invalid_request_error',
        code: 'request_too_large',
      },
    }),
    { status: 413, headers: { 'content-type': 'application/json; charset=utf-8' } },
  )
}

/** 让 loader 的 fetch 能在 401 时静默换一份本机凭据 */
  const makeFetch = (state) => {
    const holder = { ...state }
    const doFetch = async (input0, init = {}) => {
      const url = typeof input0 === 'string' ? input0 : input0?.url ?? String(input0)
      const target = url.includes('/chat/completions') ? url : `${SSE_BASE}${CHAT_PATH}`

      const headers = new Headers(init.headers)
      headers.delete('authorization') // 上游用 businessCredential，不要 AI SDK 的 Bearer
      headers.delete('x-api-key')
      headers.delete('content-length')
      for (const [k, v] of Object.entries(hagHeaders({ ...holder }))) headers.set(k, v)

      let bodyObj = null
      let bodyText = null
      let rawBytes = 0
      if (typeof init.body === 'string') {
        bodyText = init.body
        rawBytes = Buffer.byteLength(bodyText, 'utf8')
        bodyObj = readJsonSafe(bodyText)
      } else if (ArrayBuffer.isView(init.body)) {
        rawBytes = init.body.byteLength
        bodyText = new TextDecoder().decode(init.body)
        bodyObj = readJsonSafe(bodyText)
      } else if (init.body instanceof ArrayBuffer) {
        rawBytes = init.body.byteLength
        bodyText = new TextDecoder().decode(new Uint8Array(init.body))
        bodyObj = readJsonSafe(bodyText)
      }
      const wantStream = Boolean(bodyObj?.stream)
      if (bodyObj && typeof bodyObj === 'object') {
        bodyObj.stream = true // 上游只吃 SSE，非流式由本地聚合
        normalizeToolSchemas(bodyObj)
        bodyText = JSON.stringify(bodyObj)
      }

      const bodyBytes = typeof bodyText === 'string' ? Buffer.byteLength(bodyText, 'utf8') : rawBytes
      if (bodyBytes > MAX_HAG_BODY_BYTES) {
        const reportedBytes = Math.max(rawBytes, bodyBytes)
        const limitBytes =
          rawBytes > 0 && rawBytes <= MAX_HAG_BODY_BYTES ? Math.max(1024, rawBytes - 1) : MAX_HAG_BODY_BYTES
        return bodyTooLargeResponse(reportedBytes, limitBytes)
      }

      let res = await fetch(target, {
        method: init.method || 'POST',
        headers,
        body: bodyText,
        signal: init.signal,
      })

      // 凭据过期：本机模式静默重读一次
      if ((res.status === 401 || res.status === 403) && holder.fromLocal) {
        try {
          const fresh = readLocalCredential()
          if (fresh.credential !== holder.credential) {
            Object.assign(holder, fresh, { fromLocal: true })
            for (const [k, v] of Object.entries(hagHeaders({ ...holder }))) headers.set(k, v)
            res = await fetch(target, { method: init.method || 'POST', headers, body: bodyText, signal: init.signal })
          }
        } catch {
          /* 保持原样 */
        }
      }

      if (!res.ok) {
        let text = ''
        try {
          text = await res.text()
        } catch {
          /* ignore */
        }
        if (res.status === 408 && bodyBytes >= 4 * 1024 * 1024) {
          return bodyTooLargeResponse(bodyBytes, Math.floor(bodyBytes * 0.75))
        }
        const authFailed = res.status === 401 || res.status === 403
        const payload =
          text ||
          JSON.stringify({ error: { message: `小艺Work 上游 ${res.status}`, type: authFailed ? 'authentication_error' : 'upstream_error' } })
        const out = new Response(payload, {
          status: res.status,
          headers: { 'content-type': res.headers.get('content-type') || 'application/json' },
        })
        if (authFailed) out.headers.set('X-Magpie-Sign-In', 'expired')
        return out
      }

      const modelHint = bodyObj?.model
      if (wantStream || !bodyObj) {
        return new Response(transformSse(res.body, modelHint), {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform' },
        })
      }
      const full = await aggregate(res.body, modelHint)
      if (full?.error && !full?.choices) {
        return new Response(JSON.stringify(full), {
          status: 502,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      }
      return new Response(JSON.stringify(full), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }
    return doFetch
  }

  return {
    /* ---------------- 供应商与默认模型 ---------------- */
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: '小艺Work（华为小艺）',
        npm: '@ai-sdk/openai-compatible',
        api: SSE_BASE,
        models: visibleModels(DEFAULT_MODELS),
      }
    },

    /* ---------------- 登录 + 请求 ---------------- */
    auth: {
      provider: PROVIDER,
      // 供应商图标（账号卡片、供应商行、额度卡片都用它）；空串时 magpie 用 magpie.icon
      ...(PLUGIN_ICON ? { icon: PLUGIN_ICON } : {}),
      methods: [
        {
          type: 'oauth',
          label: '华为账号登录（浏览器）',
          async authorize(_inputs, ctx = {}) {
            if (process.platform === 'win32') {
              try {
                const probe = http.createServer()
                await new Promise((resolve, reject) => {
                  probe.once('error', reject)
                  probe.listen(OAUTH.callbackPort, '127.0.0.1', resolve)
                })
                probe.close()
              } catch {
                return {
                  type: 'failed',
                  error: `端口 ${OAUTH.callbackPort} 被占用：登录需要它接回调，请先完全退出小艺Work 再重试`,
                }
              }
            }
            const verifier = b64url(crypto.randomBytes(32))
            const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
            const state = crypto.randomBytes(12).toString('hex')
            const server = startCallbackServer(state, ctx.signal)
            try {
              await server.listening
            } catch (err) {
              return { type: 'failed', error: `回调服务启动失败：${err.message}` }
            }
            return {
              url: buildAuthorizeUrl(challenge, state),
              instructions: '用华为账号登录。注意：小艺Work 若开着会占用 17355 端口，请先退出它。',
              method: 'auto',
              async callback() {
                try {
                  const code = await server.codePromise
                  const session = await exchangeCode(code, verifier)
                  const uid = session.user?.uid
                  if (!uid) return { type: 'failed', error: '华为账号信息里没有 uid' }
                  const dup = guardDuplicate(uid)
                  if (dup) return { type: 'failed', error: dup }
                  const deviceId = deviceIdFor(uid)
                  const created = await createCredential(session.accessToken, uid, deviceId)
                  if (!created.ok) {
                    return {
                      type: 'failed',
                      error:
                        `${created.message}。设备 ${deviceId.slice(0, 12)}… 可能尚未登记：` +
                        '先用小艺Work 在本机登录一次，或改用“读取本机登录态”方式。',
                    }
                  }
                  return {
                    type: 'success',
                    refresh: session.refreshToken,
                    access: created.credential,
                    expires: created.validTimeSec * 1000,
                    accountId: uid,
                    metadata: { uid, deviceId, displayName: session.user?.displayName || null, scope: session.scope },
                    uid,
                    deviceId,
                  }
                } catch (err) {
                  return { type: 'failed', error: err?.message || String(err) }
                } finally {
                  server.close()
                }
              },
            }
          },
        },
        {
          type: 'api',
          label: '读取本机小艺Work 登录态（免输入；下一格随意填）',
          placeholder: '直接回车或随便填 —— 插件自己读本机注册表',
          async authorize(inputs) {
            if (process.platform !== 'win32') {
              return { type: 'failed', error: '这种方式只支持 Windows（读注册表凭据）。请改用浏览器登录。' }
            }
            try {
              const local = readLocalCredential()
              const dup = guardDuplicate(local.uid)
              if (dup) return { type: 'failed', error: dup }
              // 若在 key 框里粘了完整凭据就用它（高级用法；uid/deviceId 仍取本机）
              const typed = String(inputs?.key ?? inputs?.text ?? inputs?.apiKey ?? '').trim()
              const usable = typed.length >= 100 && /^[\w.-]+$/.test(typed)
              return {
                type: 'success',
                key: usable ? typed : local.credential,
                accountId: local.uid,
                uid: local.uid,
                deviceId: local.deviceId,
                metadata: {
                  uid: local.uid,
                  deviceId: local.deviceId,
                  expires: local.validTimeSec ? local.validTimeSec * 1000 : undefined,
                  refreshToken: local.refreshToken || undefined,
                  ...(usable ? { importedFrom: 'pasted' } : {}),
                },
              }
            } catch (err) {
              return { type: 'failed', error: err?.message || String(err) }
            }
          },
        },
      ],

      /** 凭据 7 天，提前 12 小时续；续的动作是「代刷 + 立刻签票」 */
      refreshLead: 12 * 60 * 60 * 1000,

      /**
       * 编辑页「插件选项」里的开关。
       * 声明在这里 magpie 才会渲染成开关（跟 opencode-workbuddy-auth 一样的写法）；
       * 值通过 input.magpie.option(providerId, key) 读回来。
       */
      options: [
        {
          key: 'show_gray',
          label: 'Show grey (beta) models',
          description:
            'Also list the models XiaoyiWork marks grey (Kimi K3.1 Pro, 13x). XiaoyiWork\'s own model picker keeps them disabled as "in grey testing, not selectable yet", so they are hidden here by default; turning this on only makes them selectable, and they stay the most expensive.',
          labels: { zh: '显示灰度测试模型', 'zh-TW': '顯示灰度測試模型' },
          descriptions: {
            zh: '把上游标为灰度的模型也列出来（Kimi K3.1 Pro，13x 最贵）。小艺Work 自己的模型选择器对它们是禁用态「灰度中，暂不可选」，所以这里默认隐藏；打开只是让你能选到，仍属官方未开放、且最贵。',
            'zh-TW': '把上游標為灰度的模型也列出來（Kimi K3.1 Pro，13x 最貴）。小藝Work 自己的模型選擇器對它們是禁用態「灰度中，暫不可選」，所以這裡預設隱藏；打開只是讓你能選到，仍屬官方未開放、且最貴。',
          },
          filtersModels: true,
        },
        {
          key: 'allow_duplicate',
          label: 'Allow the same account twice',
          description:
            'By default one XiaoyiWork account can be added once, whichever sign-in you use; a second attempt is refused with the name of the existing slot. Turn this on only if you really want two slots for the same uid.',
          labels: { zh: '允许同一账号重复添加', 'zh-TW': '允許同一帳號重複新增' },
          descriptions: {
            zh: '默认同一个华为账号只能加一次（不论用本机导入还是浏览器登录），再登会提示已存在的槽位名。只有确实想让同一个 uid 占两个槽位时才打开。',
            'zh-TW': '預設同一個華為帳號只能加一次（不論用本機匯入還是瀏覽器登入），再登會提示已存在的槽位名。只有確實想讓同一個 uid 佔兩個槽位時才打開。',
          },
        },
      ],

      async refresh(auth) {
        const state = normalizeAuth(auth)
        if (!state) throw Object.assign(new Error('登录信息不完整，请重新登录'), { signIn: 'expired' })
        const renewed = await renewCredential(state)
        if (!renewed.ok) {
          throw Object.assign(new Error(`续期失败：${renewed.message}`), { signIn: 'expired' })
        }
        return {
          access: renewed.credential,
          refresh: auth.refresh ?? auth.metadata?.refreshToken,
          expires: renewed.validTimeSec * 1000,
          uid: state.uid,
          deviceId: state.deviceId,
          metadata: { ...(auth.metadata || {}), uid: state.uid, deviceId: state.deviceId, expires: renewed.validTimeSec * 1000 },
        }
      },

      async loader(getAuth) {
        const auth = await getAuth()
        const state = normalizeAuth(auth)
        if (!state) return {}
        return {
          baseURL: SSE_BASE,
          headers: { 'x-request-from': 'xiaoyiWork', 'x-businessId': 'WINPC_XIAOYI_WORK' },
          fetch: makeFetch(state),
        }
      },

      async usage(getAuth) {
        const auth = await getAuth()
        try {
        const base = normalizeAuth(auth)
        if (!base) return { error: '未登录' }
        let state = base
        try {
          state = await ensureFreshState(base)
        } catch {
          /* 续期失败也照常读用量 */
        }
        const [premium, platform] = await Promise.all([
          queryBilling(CELIA_PREMIUM_AGENT_ID, state),
          queryBilling(PLATFORM_AGENT_ID, state),
        ])

        const celia = premium?.celiaPremiumPrivilege ?? null
        const points = celia?.aiPoints ?? {}
        const membership = celia?.membership ?? {}
        const subscription = celia?.subscription ?? null
        const privileges = Array.isArray(platform?.privilegeList) ? platform.privilegeList : []

        /*
         * 额度有两个互不相干的桶，别混成一个数字：
         *   ① 会员积分 pool（agentId=1 的 celiaPremiumPrivilege.aiPoints）
         *      freePoints=200 免费额度 / purchasedPoints 购买 / giftPoints 赠送 / compstPoints 补偿
         *      —— 上游**不给**任何重置日期或有效期字段（aiPointDetailDisplay:false）
         *   ② 权益包（平台 agentId 的 privilegeList）
         *      privilegeDetail 里带"剩余积分：N"，expireTime 是**作废**时间（不是按月重置）
         * 所以：能报的日期只有一个——权益包到期（用 runsOutAt 表达），
         * 免费积分的"重置日"上游没给，不编。
         */
        const fmtDate = (ms) =>
          new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }).replace(/:\d{2}$/, '')

        const windows = []
        const totalPoints = num(points.totalPoints)
        const stateFile = readPointsState(configDir)
        const bucket = (stateFile[state.uid] ??= {})

        if (celia) {
          const breakdown = [
            points.freePoints != null ? `免费 ${num(points.freePoints)}` : null,
            num(points.purchasedPoints) ? `购买 ${num(points.purchasedPoints)}` : null,
            num(points.giftPoints) ? `赠送 ${num(points.giftPoints)}` : null,
            num(points.compstPoints) ? `补偿 ${num(points.compstPoints)}` : null,
          ].filter(Boolean)
          const total = observeMax(bucket, 'membership', totalPoints)
          windows.push({
            name: `会员积分（${membership.skuGroupName || '小艺'}）`,
            display: `剩余 ${totalPoints} / 总计 ${total} 点${breakdown.length ? '（' + breakdown.join(' / ') + '）' : ''}`,
            // magpie：amount = 已用，limit = 总量（反过来会把账号算成额度耗尽）
            amount: Math.max(0, total - totalPoints),
            limit: total,
            unit: '点',
          })
        }

        const expiries = []
        for (const p of privileges) {
          const detail = Array.isArray(p.privilegeDetail) ? p.privilegeDetail.join(' ') : String(p.privilegeDetail ?? '')
          const remain = num(detail.match(/(\d+(?:\.\d+)?)/)?.[1])
          const expire = parseCompactTime(p.expireTime)
          if (expire) expiries.push(expire.epoch)
          const label = p.privilegeName || '权益包'
          const bucketKey = `priv:${p.privilegeId || label}`
          const total = observeMax(bucket, bucketKey, remain)
          windows.push({
            name: expire ? `${label}（${fmtDate(expire.epoch)} 到期）` : label,
            display: `剩余 ${remain} / 总计 ${total} 点${expire ? ` · ${fmtDate(expire.epoch)} 到期` : ''}`,
            // amount = 已用，limit = 总量
            ...(total ? { amount: Math.max(0, total - remain), limit: total, unit: '点' } : {}),
            ...(expire ? { runsOutAt: expire.iso } : {}),
            aside: false,
          })
        }

        writePointsState(configDir, stateFile)

        const subExpire = parseCompactTime(subscription?.expireTime)
        const error =
          !celia && !privileges.length
            ? '两类查询都没拿到数据，可能是凭据过期或网络问题'
            : [premium ? null : '会员/积分查询失败', platform ? null : '权益包查询失败'].filter(Boolean).join('；')

        const result = {
          plan: membership.skuGroupName || undefined,
          user: state.uid,
          // until 只表达"套餐到期"；体验版没有 subscription 就不给，
          // 免得把权益包作废时间冒充成套餐到期
          ...(subExpire ? { until: subExpire.iso } : {}),
          renew: subscription?.autoRenew === true ? 'auto' : subscription ? 'off' : undefined,
          windows,
          ...(error ? { error } : {}),
        }

        /*
         * 上游额度接口偶发 408 / 超时。一旦这次一个窗口都没拿到，就回落到
         * 上次成功的结果 —— 否则 magpie 会把供应商判成 kind:"balance" 并清空窗口，
         * 看起来像"没有额度"。上次成功的结果一起存在状态文件里。
         */
        if (windows.length) {
          bucket.lastGood = { at: new Date().toISOString(), plan: result.plan, windows: result.windows, until: result.until }
          writePointsState(configDir, stateFile)
          return result
        }
        writePointsState(configDir, stateFile)
        if (bucket.lastGood?.windows?.length) {
          return {
            ...bucket.lastGood,
            user: state.uid,
            error: `${error || '上游暂时没返回额度'}；显示的是 ${bucket.lastGood.at} 读到的上一次结果`,
          }
        }
        return result
        } catch (err) {
          // 任何异常都别把 magpie 的空结果抛上去（那会被判成"没有额度端点"）
          console.log(`[xiaoyiwork] usage threw: ${err?.message || err}`)
          const state = normalizeAuth(auth)
          const bucket = state?.uid ? readPointsState(configDir)[state.uid] : null
          if (bucket?.lastGood?.windows?.length) {
            return { ...bucket.lastGood, user: state.uid, error: `读取失败：${err?.message || err}；显示上次结果` }
          }
          return { error: `读取额度失败：${err?.message || err}`, windows: [] }
        }
      },
    },

    /* ---------------- 每个账号的模型 ---------------- */
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const state = normalizeAuth(auth)
        if (!state) return visibleModels(provider.models)
        const catalog = await queryCatalog(state).catch(() => null)
        if (!catalog) return visibleModels(provider.models)
        const out = {}
        for (const item of catalog) {
          const gray = item.gray === true || GRAY_MODELS.has(item.id)
          if (gray && !showGray()) continue // 官方就是禁用态，默认不给选
          const base = provider.models[item.id] ?? DEFAULT_MODELS[item.id] ?? {
            name: item.name,
            tool_call: true,
            reasoning: true,
            limit: { context: 1000000, output: 32000 },
          }
          const { status, ...rest } = base
          out[item.id] = {
            ...rest,
            name: (item.name || base.name) + (gray ? '（灰度）' : ''),
            ...(item.rate ? { rate: item.rate } : {}),
          }
        }
        // 兜底：目录没列出的默认模型仍然保留（Auto-Model 之类），灰度的一样要挡掉
        for (const [id, model] of Object.entries(visibleModels(provider.models))) if (!out[id]) out[id] = model
        return out
      },
    },
  }
}

/**
 * 测试用。magpie 会把入口导出的每个「函数」当作插件调用，
 * 所以这里只放一个对象，别放函数。
 */
export const _internal = {
  PROVIDER,
  SSE_BASE,
  MAX_HAG_BODY_BYTES,
  DEFAULT_MODELS,
  OAUTH,
  machineId,
  deviceIdFor,
  normalizeAuth,
  normalizeRate,
  parseCompactTime,
  patchChunk,
  aggregate,
  transformSse,
  normalizeToolSchemas,
  createCredential,
  gatewayRefreshToken,
  renewCredential,
  readLocalCredential,
  queryCatalog,
  queryBilling,
  ensureFreshState,
}

/* 只导出这一个函数作为插件；magpie 会把入口的每个函数导出都当插件调用 */
