# dseyesopen

**无感、自动、快速、真插件——仿佛 DeepSeek 真能看图了。**

- 挂 DeepSeek（无识图能力）照样发图：单独发、图文混发都行
- 图片自动交给快速小识图模型（`glm-4.6v-flashx`，识一张约 0.001 元）后台描述
- 描述不进对话框：对话框里你发的图原样还在，后台 DeepSeek 处理的是转成的文字描述
- 真插件：拔掉即恢复原样，不留痕迹

---

## 安装

```bash
dsh plugin --profile web add file:/path/to/dseyesopen
```

重启 `dsh web`。

## 配置 API Key（3 步，2 分钟）

1. 打开 [open.bigmodel.cn](https://open.bigmodel.cn)，手机号/微信注册
2. 控制台 → **API 密钥** → 创建新密钥 → 复制
3. dsh → **模型设置页** → `Zhipu GLM Vision` → 粘贴密钥

`glm-4.6v-flashx` 是极低价付费档，账号里充几块钱就够用很久（如遇高峰限流，免费档 glm-4.6v-flash 可作备选）。密钥也可以放进环境变量 `ZHIPU_API_KEY`。

## 可选：粘贴截图走原生附件

在 `~/.dsh/profiles/web/cordis.patch.yml` 里关闭 modlens 的粘贴接管，让 Cmd+V 成为真图片附件：

```yaml
- id: modlens
  name: '@liustack/modlens'
  config:
    pasteToPath: false
```

## 工作原理

```
用户发图（单独/混发）
  → 服务端图片预检：dseyesopen 运行时包装 deepseek adapter 的 resolveModel，
    声明 image 输入模态 → 放行（纯内存包装，不写任何 dsh 文件）
  → llm/stream 瀑布：拦下发往 deepseek-official 且含图片的调用
  → image 块交给 glm-4.6v-flash 识别 → 原地替换为文字描述
  → DeepSeek 收到纯文字，会话历史与 UI 保持"用户发了图片"原样
```

识别结果按 attachmentId+上下文缓存；识别失败注入降级文字，回合不崩溃。

## 卸载

```bash
dsh plugin --profile web remove dseyesopen
```

拔掉即恢复原样：
- adapter 包装随插件 fiber 消失（内存态，无文件残留）
- 自动写入的 `zhipu-vision` settings 条目由 disposer 清理

## 诊断

对话中可调用工具：
- `dseyesopen_status` — 查看凭证配置、路由、输入模态、缓存状态
- `dseyesopen_selfcheck` — 端到端自检：给一个本地图片路径，真实跑一次识别

## 注意

- 识图模型默认 `zhipu-vision / glm-4.6v-flashx`（极低价付费档，OCR/截图/图表强；免费档 glm-4.6v-flash 作备选）
- 付费档稳定性好；若临时换回免费档，高峰时段偶有 429 限流，失败会降级为文字提示，不影响对话
- dsh 升级后图片预检包装会自动重建（监听 adapter 更新事件），无需手动维护
