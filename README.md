# AI 简历分析（本地开发版）

粘贴简历 + 粘贴 JD，30 秒拿到一份**每条判断都能戳回原文**的匹配报告：总分 + 一句话结论、五维雷达、逐条判定（标签/理由/可点击的原文引用）、逐条改写建议（一键复制）。第一版**完全免费**，服务端限次风控。

架构：**微信小程序（前端） + 本地 Node 服务（后端）**，无云开发、无数据库依赖（JSON 文件存储）。

```
微信开发者工具 ──wx.request──▶ localhost:8787（Node 零依赖 http 服务）
                                 ├─ 任务：POST /api/analyze 立即返回 jobId，前端轮询 /api/job/:id 看真实进度
                                 ├─ 流水线：切分 → JD拆解(LLM，按 JD 缓存) → 检索 → 判定(LLM，批次独立) → 引用校验(代码) → 打分(代码)
                                 ├─ 改写建议：主报告出来后后台生成，报告页自动刷新
                                 ├─ 风控：身份日限 / 10分钟窗 / IP限制 / 全站日限 / 复制限3条
                                 └─ 存储：data/db.json（脱敏报告 30 天 + 限流计数 90 天；简历按行脱敏后存储，见下方隐私说明）
```

三条灵魂（区别于"ChatGPT 套壳"的壁垒，参考 [resume-matcher](https://provecv.com) 思路，设计文档见 [docs/design.md](docs/design.md)）：

1. LLM 每条判断**必须给出原文引用片段**
2. **代码逐字校验**引用是否真的在简历/JD 里，找不到就降级 `unclear`（`server/verify.js`）
3. **打分由代码算**（`server/score.js`）；同一份简历 + JD 重复提交直接复用已有报告，**同输入同分**、不扣次数

## 快速开始

### 1. 启动本地服务

```bash
cd server && npm install    # 唯一依赖 pdfjs-dist（PDF 解析用，需 Node 18+；更低版本只是 PDF 上传不可用）
npm start                   # 或项目根目录 npm start / node server/index.js
# AI 简历分析服务已启动: http://127.0.0.1:8787
# ⚠ 当前为 MOCK 模式（未配置 LLM_API_KEY），用启发式规则代替模型
```

不配任何环境变量也能跑（mock 模式，报告带「演示模式」标识）。

### 2. 接模型（可选）

在启动服务的环境里设置（OpenAI 兼容协议均可）：

**上线推荐：阿里云百炼 · 千问**（中文强、JSON 稳、每次分析约几分钱；关闭思考模式，否则容易超出 75s 时限）

```bash
export LLM_API_KEY=你的百炼key
export LLM_API_BASE=https://dashscope.aliyuncs.com/compatible-mode/v1
export LLM_MODEL=qwen-flash         # 主模型：JD 拆解 + 改写建议（任务简单，用便宜的）
export LLM_JUDGE_MODEL=qwen-plus    # 判定模型：逐条核对 + 逐字引用（最吃能力，单独用强的）
node server/index.js
```

判定是整条流水线里最难的一步：模型要从简历里**一字不改**地摘出证据，小模型常把原句改写，代码校验就会拒收、条目被灰成「待核对」。所以判定单独配强模型，拆解和改写用便宜模型，成本只多一点，报告质量差别明显。
- `LLM_JUDGE_MODEL` 不设时沿用 `LLM_MODEL`；两者共用同一个 key 和 `LLM_API_BASE`
- 想要更高质量：`LLM_MODEL=qwen-plus` + `LLM_JUDGE_MODEL=qwen-max`（更贵也更慢，注意 75s 时限）
- 启动日志会打印两个模型；`GET /api/health` 也会返回 `model` 和 `judgeModel`
- 换判定模型后，同一份简历 + JD 会重新分析，不会复用用旧模型生成的报告；JD 拆解缓存不受影响

**联调可用：智谱 GLM-4.7-Flash（免费，代码默认值）**

```bash
export LLM_API_KEY=你的智谱key       # LLM_API_BASE / LLM_MODEL 不设即为智谱 glm-4.7-flash
node server/index.js
```

> 免费版限 1 个并发，而判定会把要求分 2~4 批并行发出，容易触发 429 重试、拖慢分析，只适合联调。

> ⚠️ 只选承诺「不拿请求数据训练」的厂商——简历是敏感个人信息，别赌（设计文档 §4）。

### 3. 跑内核测试（不需要任何账号）

```bash
npm test    # 66 项断言：脱敏 / 引用定位 / 幻觉降级 / 打分确定性 / 一句话结论 / 风控 / 身份与 IP / LLM 重试与时限 / 判定部分失败 / JD 缓存 / mock 全链路
```

### 4. 微信开发者工具

1. 「导入项目」选本目录（`project.config.json` 已配好 `miniprogramRoot: miniprogram/`）
2. **详情 → 本地设置 → 勾选「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」**（否则 localhost 请求会被拦）
3. 编译运行；服务端不启动时页面会提示「连不上分析服务」

### 5.（可选）用 openid 做身份

默认身份是设备 ID + IP 双重限制（够本地验证用）。要更强的风控：

```bash
export WX_APPID=wx1234567890
export WX_APPSECRET=你的secret   # 小程序后台「开发管理→开发设置」
```

小程序端 `wx.login` 的 code 会自动换取 openid 作为身份。**配置后强制 openid**：换不到 openid 就拒绝建立会话，不再退回设备 ID（否则不传 code 就能绕过）。

### 6.（部署时）反向代理

服务默认**不信任** `X-Real-IP` / `X-Forwarded-For`（客户端可伪造，会让 IP 限制失效）。只有部署在 nginx 等反向代理后面、且代理会覆盖这两个头时，才设置：

```bash
export TRUST_PROXY=1
```

## 第一版功能（对照验收清单）

| 区块 | 实现 | 位置 |
|---|---|---|
| 总分 0-100 大数字 + 一句话结论 | ✅ 模板确定性生成 | `server/conclude.js` |
| 雷达图 5 维度 | ✅ canvas 自绘，无图表库 | `miniprogram/components/radar/` |
| 问题列表（标签+理由+引用） | ✅ 每条要求一行 | `server/verify.js` → 报告页 |
| 引用可点击看上下文 | ✅ 点击弹出该片段前后 2 行（脱敏 spans 存在报告里） | 报告页弹层 |
| 改写建议（缺失/部分命中各 1 句） | ✅ 分析时同步生成 | `server/rewrite.js` |
| 复制按钮限每人每天 3 条 | ✅ 一键复制按钮由服务端计数（`/api/report/:id/copy`，同一条重复复制不重复计）。注意：改写内容本身全文下发，限的只是"一键复制"；将来要分层需在 `reportView` 裁剪 | `server/limits.js` |
| 反馈入口「这份报告准吗」 | ✅ 3 题表单（准确性/最有用模块/**付费意愿**——保留需求验证） | 报告页底部 |

免费与限次：分析每人每天 3 次（10 分钟内最多 3 次）、复制每人每天 3 条、IP 日限 10 次、全站日限 200 次，全部在 `server/config.js` 可调。分析失败不扣次数。

## 风控设计（`server/limits.js`，纯函数可单测）

```
检查顺序：全站日限 → IP 10分钟窗 → 身份 10分钟窗 → IP 日限 → 身份日限
```

- 连刷用户先看到「操作太频繁」，额度真正耗尽才看到「明天再来」
- 身份 = openid（配了 AppSecret）或设备 ID（兜底），IP 一律加盐哈希存储（`server/auth.js`）
- 输入上限：简历 4000 字 / JD 2000 字，超长截断；PDF ≤ 5MB
- 隐私：邮箱/手机/身份证在**手机端 + 服务端双重脱敏**，姓名在服务端切分后脱敏（header 首行名字、「姓名：」字段）；发给模型和存进报告的都是脱敏后的简历行（供引用上下文用，**内容本身是完整简历正文**，只是去掉了联系方式和姓名）；报告 30 天自动清理（启动时 + 每日定时）
- 流程：主报告（拆解 + 判定 + 打分）时限 75s（`ANALYZE_DEADLINE_MS`），超时即失败并退还次数；改写建议在报告返回后后台生成（时限 `REWRITE_DEADLINE_MS` 60s），失败时重新提交同一输入可补生成
- 复用：同一身份提交相同简历 + JD（忽略空白差异）直接返回已有报告；同一份 JD 的拆解结果缓存 7 天（`JD_CACHE_TTL_DAYS`），换简历分析同一职位少一轮模型调用
- 容错：判定按批次独立，少量批次失败只把对应条目标「待核对」，失败超过约 1/3 才整份失败；同一身份同时只跑一个分析任务；服务重启时退还未完成任务的预占次数
- 存储：内存为准，200ms 内的写入合并为一次落盘，退出时同步刷盘
- PDF：在独立 worker 线程解析（15s 超时 + 内存上限，禁用 pdfjs eval），每人 10 分钟 5 次 / 每天 20 次

## 项目结构

```
├── project.config.json        # 微信开发者工具配置
├── miniprogram/               # 小程序端（无云开发依赖）
│   ├── pages/                 # index / analyze / report / legal
│   ├── components/radar/      # canvas 2d 雷达图
│   ├── utils/                 # api(wx.request+会话) / redact 脱敏 / validate 校验
│   └── config.js              # API_BASE 等前端配置
├── server/                    # 本地 Node 服务（零依赖，仅 pdfjs-dist 可选）
│   ├── index.js               # http 路由：session/quota/analyze/report/copy/feedback/extract-pdf
│   ├── core.js                # 流水线编排（纯逻辑，可本地直跑）
│   ├── verify.js              # ⑥ 引用逐字校验（护城河）
│   ├── score.js + conclude.js # ⑦ 确定性打分 + 一句话结论
│   ├── jdSplit/judge/rewrite.js  # 三个 LLM 阶段
│   ├── llm.js                 # OpenAI 兼容客户端（内置 https，零依赖）
│   ├── mock.js                # 无 API_KEY 时启发式替身
│   ├── prompts/               # 三个 prompt 集中管理（调手感只改这里）
│   ├── limits.js / auth.js / db.js  # 风控 / 身份 / JSON 存储
│   └── config.js              # 所有参数集中一处
├── examples/                  # 测试简历 + JD
├── scripts/test-local.js      # 66 项内核测试
└── docs/design.md             # 设计文档（含云开发版的历史方案，可对照）
```

## 接口一览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/session` | `{deviceId, code?}` → token（业务错误统一 200 + `{ok:false,code,message}`） |
| GET | `/api/quota` | 今日余量（分析/复制） |
| POST | `/api/analyze` | `{resumeText, jdText}` → 完整报告（含 spans） |
| GET | `/api/reports` | 我的报告列表 |
| GET | `/api/report/:id` | 报告全文 |
| DELETE | `/api/report/:id` | 删除 |
| POST | `/api/report/:id/copy` | `{index}` 计一次复制（每日限 3） |
| POST | `/api/feedback` | `{reportId, q1, q2, q3}` 3 题反馈 |
| POST | `/api/extract-pdf` | `{dataBase64}` → `{text}` |
| GET | `/api/health` | 健康检查（返回是否 mock 模式） |

## 已知边界与上线提醒

- **localhost 只能在开发者工具里跑**：真机预览需要服务部署到带 HTTPS 域名的服务器（小程序强制要求），到那一步再考虑服务器部署 / 备案
- 法律文案仍是草案（legal 页有水印），**开始收钱前找律师过一遍**
- 内容安全检查（msgSecCheck）本地版未接：公开发布前在服务端接入或依赖小程序平台侧审核
- 反馈里的「付费意愿」数据存在 `data/db.json` 的 feedback 集合——这就是设计文档 D.1 要的付费验证数据
