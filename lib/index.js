/**
 * dseyesopen — 让无识图能力的 DeepSeek 仿佛睁开了眼睛。
 *
 * 无感、自动、快速、纯插件：
 *  1. 发图（单独发或图文混发）→ dsh 挂 DeepSeek 也能发：运行时包装 deepseek adapter
 *     的 resolveModel，向服务端图片预检声明 image 输入模态（纯内存，不写任何 dsh 文件）；
 *  2. llm/stream 瀑布（adapter 调用前唯一拦截点）只拦发往 deepseek-official 且含图片的
 *     调用，把 image 块交给快速的小识图模型（智谱 glm-4.6v-flashx，极低价付费档 2.9元/千万token）识别，
 *     mutate options.messages 后放行——session/UI 保持"用户发了图片"原样（对话框里图还在），
 *     只有模型看到替换后的文字描述；
 *  3. 识别结果按 attachmentId+上下文缓存；失败注入降级文字，不让回合崩溃；
 *  4. 自愈：首次装载自动在 llm-pi-ai 写入 zhipu-vision 条目（含 image 输入声明），
 *     装上即出现 API Key 输入框，零手改配置；
 *  5. 卸载：disposer 清理自愈写入的 settings 条目，adapter 包装随插件 fiber 消失——
 *     拔掉插件，一切恢复原样不留痕迹。
 *
 * 配套配置：~/.dsh/profiles/web/cordis.patch.yml 里关闭 modlens 粘贴接管
 * （pasteToPath: false），让 Cmd+V 走 dsh 原生附件流程成为真图片。
 */

const PROVIDER = 'zhipu-vision'
const MODEL = 'glm-4.6v-flashx'
const KEY_ENV = 'ZHIPU_API_KEY'
const PROVIDER_BASE_URL = 'https://open.bigmodel.cn/api/paas/v4'
const DEEPSEEK_PROVIDER = 'deepseek-official'
const SETTINGS_NS = 'llm-pi-ai'
const CACHE_MAX = 200
const MAX_PATH_IMAGES = 4

const RECOGNITION_SYSTEM = '你是一个专业识图助手。仔细查看用户提供的图片，输出完整、准确、结构化的描述。'
const RECOGNITION_PROMPT = '请详细描述这张图片的内容：\n1. 图片类型（照片 / 截图 / 图表 / 文档等）；\n2. 图中所有文字逐字转录（如有，按阅读顺序）；\n3. 关键视觉信息（主体、数据、布局、颜色等）。\n直接输出描述内容，不要寒暄。'

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i
const MEDIA_BY_EXT = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }

export const name = 'dseyesopen'
export const inject = ['llm', 'tools', 'settings']

function cacheKey(ref, contextText) {
  return String(ref.attachmentId) + '::' + String(contextText || '').slice(0, 300)
}

function failureText(error) {
  return '【图片识别失败】未能调用 GLM 识图（原因：' + String((error && error.message) || error) + '）。请确认已在本网页「模型」设置页为 Zhipu GLM Vision 填写 API Key（open.bigmodel.cn 免费注册），然后重新发送图片；或直接在对话中描述图片内容。'
}

function extOf(path) {
  const match = String(path).toLowerCase().match(IMAGE_EXT_RE)
  return match ? match[0] : undefined
}

// 从文本中检出本地图片路径（粘贴等场景的兜底）
function detectImagePaths(text) {
  const found = []
  const seen = new Set()
  const tokens = String(text || '').split(/\s+/)
  for (const token of tokens) {
    let cleaned = token.replace(/^["'(\[]+/, '').replace(/[)"'\],;:。：]+$/, '')
    if (cleaned.startsWith('file://')) cleaned = cleaned.slice('file://'.length)
    if (!IMAGE_EXT_RE.test(cleaned)) continue
    if (!cleaned.startsWith('/') && !cleaned.startsWith('~/')) continue
    if (seen.has(cleaned)) continue
    seen.add(cleaned)
    found.push(cleaned)
  }
  return found.slice(0, MAX_PATH_IMAGES)
}

export function apply(ctx, config = {}) {
  const provider = config.provider ?? PROVIDER
  const model = config.model ?? MODEL
  const cache = new Map()
  const tag = '[dseyesopen]'

  // 自愈 1：确保 llm-pi-ai 里存在 zhipu-vision 条目（glm-4.6v-flashx，声明图片输入）。
  // 首次装载时自动写入默认配置——别人装上插件即出现 API Key 输入框，无需手改 yaml。
  async function ensureProviderEntry() {
    const settings = ctx.settings
    if (settings === undefined) return
    try {
      const section = settings.get(SETTINGS_NS)
      const providers = section && typeof section === 'object' && section.providers ? section.providers : undefined
      const entry = providers && providers[provider]
      const modelEntry = entry && Array.isArray(entry.models) ? entry.models.find((m) => m && m.id === model) : undefined
      if (entry && modelEntry && Array.isArray(modelEntry.input) && modelEntry.input.includes('image')) return
      const models = [
        ...(entry && Array.isArray(entry.models) ? entry.models : []).filter((m) => m && m.id !== model),
        { id: model, name: 'GLM-4.6V FlashX', contextWindow: 131072, maxTokens: 8192, input: ['text', 'image'] },
      ]
      const patch = entry
        ? { providers: { [provider]: { models } } }
        : {
            providers: {
              [provider]: {
                apiKeyEnv: KEY_ENV,
                displayName: 'Zhipu GLM Vision',
                api: 'openai-completions',
                baseURL: PROVIDER_BASE_URL,
                models,
              },
            },
          }
      await settings.update(SETTINGS_NS, patch)
      console.log(tag, `provider entry ensured: ${provider}/${model}`)
    } catch (error) {
      console.error(tag, 'failed to ensure provider entry:', error && error.message)
    }
  }

  async function recognize(attachment, contextText, signal) {
    const key = cacheKey(attachment, contextText)
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    let result
    try {
      const prompt = contextText && String(contextText).trim().length > 0
        ? RECOGNITION_PROMPT + '\n\n用户发送这张图片时附带的文字（作为识别上下文）：\n' + contextText
        : RECOGNITION_PROMPT
      const stream = ctx.llm.stream({
        provider,
        model,
        system: RECOGNITION_SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'image', attachment }, { type: 'text', text: prompt }] }],
        maxTokens: 4000,
        signal,
      })
      let text = ''
      let finish = undefined
      for await (const chunk of stream) {
        if (chunk.type === 'text-delta') text += chunk.text
        else if (chunk.type === 'finish') finish = chunk.reason
      }
      if (finish && finish.kind === 'error') throw new Error((finish.failure && finish.failure.message) || '识图模型返回错误')
      if (finish && finish.kind === 'aborted') throw new Error('调用被中止')
      if (String(text).trim().length === 0) throw new Error('识图模型返回了空描述')
      result = { ok: true, text: String(text).trim() }
    } catch (error) {
      result = { ok: false, error: String((error && error.message) || error) }
    }
    if (result.ok) {
      if (cache.size >= CACHE_MAX) {
        const oldest = cache.keys().next().value
        if (oldest !== undefined) cache.delete(oldest)
      }
      cache.set(key, result)
    }
    return result
  }

  async function attachLocalImage(path, signal) {
    const fs = ctx.get('fs')
    if (fs === undefined) throw new Error('fs 服务不可用')
    const attachments = ctx.get('attachments')
    if (attachments === undefined) throw new Error('attachments 服务不可用')
    const mediaType = MEDIA_BY_EXT[extOf(path)]
    if (mediaType === undefined) throw new Error('不支持的图片扩展名')
    const target = await fs.resolve(path)
    const bytes = await fs.readBytes(target, signal, 20971520)
    const fileName = String(path).split('/').pop() || 'image'
    return await attachments.saveImage({ data: bytes, mediaType, name: fileName })
  }

  async function transformMessages(messages, signal) {
    const out = []
    for (const message of messages) {
      const content = message && message.content
      if (!Array.isArray(content)) { out.push(message); continue }
      const hasImageBlock = content.some((b) => b && b.type === 'image')
      const textBlocks = content.filter((b) => b && b.type === 'text')
      const hasPathText = textBlocks.some((b) => detectImagePaths(b.text).length > 0)
      if (!hasImageBlock && !hasPathText) { out.push(message); continue }
      const allText = textBlocks.map((b) => b.text).join('\n')
      const contextText = allText.replace(/\S+\.(png|jpe?g|webp|gif)\b/gi, ' ').trim()
      const blocks = []
      for (const block of content) {
        if (block && block.type === 'image') {
          const rec = await recognize(block.attachment, contextText, signal)
          if (rec.ok) blocks.push({ type: 'text', text: '【图片已由识图模型(' + model + ') 自动识别，以下为图片内容】\n' + rec.text })
          else blocks.push({ type: 'text', text: failureText(rec.error) })
          continue
        }
        if (block && block.type === 'text') {
          const paths = detectImagePaths(block.text)
          let text = block.text
          for (const path of paths) {
            let note
            try {
              const ref = await attachLocalImage(path, signal)
              const rec = await recognize(ref, contextText, signal)
              note = rec.ok
                ? '\n\n【图片 ' + (path.split('/').pop() || path) + ' 已由识图模型(' + model + ') 自动识别，以下为图片内容】\n' + rec.text
                : '\n\n' + failureText(rec.error)
            } catch (error) {
              note = '\n\n【图片读取失败】未能读取本地图片 ' + path + '（' + String((error && error.message) || error) + '）。'
            }
            text = text + note
          }
          blocks.push({ type: 'text', text })
          continue
        }
        blocks.push(block)
      }
      out.push({ ...message, content: blocks })
    }
    return out
  }

  // 挂载点说明：不能挂 agent/pre-step（修改会写回 session，UI 显示识别文字），
  // 也不能在 llm/stream 里改 options（buildRequest 对 request 做了 deepFreeze，
  // messages 只读）。最终方案：直接包装 deepseek adapter 的 stream 方法——
  // adapter 层是模型输入的最后一步，替换只影响本次调用，不碰会话历史与冻结对象。

  // 诊断工具（手写定义，零依赖）
  ctx.tools.register({
    name: 'dseyesopen_status',
    description: '诊断识图桥的运行状态：Zhipu GLM Vision 凭证是否已配置、zhipu-vision/glm-4.6v-flashx 路由与输入模态、识别缓存大小。',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      const facts = { model: provider + '/' + model, settingsNs: SETTINGS_NS }
      try {
        const providers = ctx.llm.listProviders()
        facts.registeredProviders = providers.map((p) => p.id)
      } catch (error) { facts.providersError = String((error && error.message) || error) }
      try {
        const info = await ctx.llm.resolveModelInfo(provider, model)
        facts.modelInput = Array.isArray(info && info.inputModalities) ? [...info.inputModalities] : null
        facts.contextWindow = info && info.context ? info.context.contextWindow : null
      } catch (error) { facts.modelInfoError = String((error && error.message) || error) }
      const credentials = ctx.get('credentials')
      if (credentials !== undefined) {
        try {
          const desc = await credentials.describe(KEY_ENV)
          facts.credential = { configured: desc.configured, source: desc.source === undefined ? null : desc.source, writable: desc.writable }
        } catch (error) { facts.credentialError = String((error && error.message) || error) }
      } else {
        facts.credential = 'credentials 服务不可用'
      }
      try {
        const section = ctx.settings && ctx.settings.get(SETTINGS_NS)
        const profile = section && typeof section === 'object' && section.providers ? section.providers[provider] : undefined
        facts.modelEntry = profile && Array.isArray(profile.models) ? profile.models.find((m) => m && m.id === model) || null : null
      } catch (error) { facts.settingsError = String((error && error.message) || error) }
      facts.cacheSize = cache.size
      return facts
    },
  })

  ctx.tools.register({
    name: 'dseyesopen_selfcheck',
    description: '端到端自检：读取一个本地图片文件、注册为附件并真实调用识图模型识别，返回识别结果。',
    parameters: {
      type: 'object',
      properties: {
        imagePath: {
          type: 'string',
          description: '本地图片文件的绝对路径（png/jpg/jpeg/webp/gif）。',
        },
      },
      required: ['imagePath'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args, exec) {
      try {
        const ref = await attachLocalImage(args.imagePath, exec && exec.signal)
        const rec = await recognize(ref, '', exec && exec.signal)
        return {
          ref: { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height },
          recognition: rec,
        }
      } catch (error) {
        return { error: String((error && error.message) || error) }
      }
    },
  })

  // 自愈 2：包装 deepseek adapter 的 resolveModel（图片预检）与 stream（识图替换）。
  // 纯运行时包装（不写任何 dsh 文件）：卸载本插件即完全恢复 dsh 原样。
  // 监听 llm/adapters-updated 防 dsh-llm-deepseek 的 registration.replace 回滚包装。
  const MODEL_WRAP_FLAG = Symbol.for('dseyesopen.model-wrapped')
  const STREAM_WRAP_FLAG = Symbol.for('dseyesopen.stream-wrapped')
  function wrapDeepseekAdapter() {
    const reg = ctx.llm.adapters && ctx.llm.adapters.get(DEEPSEEK_PROVIDER)
    if (!reg || !reg.adapter) {
      console.error(tag, 'deepseek adapter registration not found; image admission will be blocked by precheck')
      return
    }
    try {
      if (!reg.adapter[MODEL_WRAP_FLAG]) {
        const original = reg.adapter.resolveModel
        if (typeof original === 'function') {
          reg.adapter.resolveModel = async function resolveModelWithImage(provider, model, signal) {
            const info = await original.call(this, provider, model, signal)
            const modalities = Array.isArray(info && info.inputModalities) ? info.inputModalities : []
            return modalities.includes('image') ? info : { ...info, inputModalities: [...modalities, 'image'] }
          }
          reg.adapter[MODEL_WRAP_FLAG] = true
          console.log(tag, 'deepseek adapter wrapped: image modality declared for precheck')
        }
      }
      if (!reg.adapter[STREAM_WRAP_FLAG]) {
        const originalStream = reg.adapter.stream
        if (typeof originalStream === 'function') {
          reg.adapter.stream = async function* streamWithVision(options) {
            const messages = options.messages
            const hasImage = Array.isArray(messages) && messages.some((m) => Array.isArray(m && m.content) && m.content.some((b) => b && b.type === 'image'))
            if (!hasImage) {
              yield* originalStream.call(this, options)
              return
            }
            try {
              const transformed = await transformMessages(messages, options.signal)
              yield* originalStream.call(this, { ...options, messages: transformed })
            } catch (error) {
              console.error(tag, 'stream vision transform failed, passing original messages through:', error)
              yield* originalStream.call(this, options)
            }
          }
          reg.adapter[STREAM_WRAP_FLAG] = true
          console.log(tag, 'deepseek adapter stream wrapped: image blocks replaced before dispatch')
        }
      }
    } catch (error) {
      console.error(tag, 'failed to wrap deepseek adapter:', error && error.message)
    }
  }
  ctx.on('llm/adapters-updated', () => {
    wrapDeepseekAdapter()
    void ensureProviderEntry()
  })
  void ensureProviderEntry()
  wrapDeepseekAdapter()

  // 新装兜底：插件树并发加载时 llm-pi-ai 的 settings 命名空间可能晚于本插件注册，
  // 且 adapters-updated 事件可能已错过——按 1s/3s/10s 阶梯重试直至条目就位。
  ;[1000, 3000, 10000].forEach((delay) => {
    setTimeout(() => { void ensureProviderEntry() }, delay)
  })

  // 卸载清理：移除自愈写入的 provider 条目，做到"拔掉插件不留痕迹"。
  ctx.effect(function* () {
    yield () => {
      try {
        const section = ctx.settings && ctx.settings.get(SETTINGS_NS)
        const entry = section && typeof section === 'object' && section.providers ? section.providers[provider] : undefined
        if (entry === undefined) return
        void ctx.settings.mutate(SETTINGS_NS, [{ op: 'unset', path: ['providers', provider] }])
        console.log(tag, 'provider entry cleaned on dispose:', provider)
      } catch (error) {
        console.error(tag, 'failed to clean provider entry on dispose:', error && error.message)
      }
    }
  })
}
