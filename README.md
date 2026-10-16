# Model Studio

一个可自行部署的多模型文本对话服务，包含 Codex、Claude、Gemini 风格的三种页面，以及统一的登录、历史会话和管理设置。界面为独立实现，不代表这些产品的官方服务。

## 功能

- OpenAI Responses / Chat Completions、Anthropic Messages、Gemini generateContent API。
- 填写 API 地址和 Key 后获取模型列表，支持搜索、键盘选择和手动模型 ID；个人连接与管理员平台连接均可使用。
- 三个工作空间均可选择 OpenAI 兼容协议，也支持 Anthropic、Gemini 原生模型列表。
- 管理员配置 API 地址、模型名称、API Key、输出长度和启用状态；输出预算支持自行填写，已移除统一的 4,096 限制。
- 每个账号可独立设置、替换和删除个人 API Key、API 地址和模型；新成员默认使用自己的 Key，平台 Key 需要管理员单独授权。
- 保留用户名和密码登录；配置 Google 登录后，所有通过 Google 验证的账号均可首次自动注册为普通成员，无应用内邮箱白名单。
- 管理员创建或禁用成员、重置密码、设置每日请求额度；全站最多 100 个账号，普通成员默认每人每日 50 次、普通成员合计每日 500 次；管理员不限每日次数。
- 服务端保存会话，API Key 加密存储，提供来源检查、CSRF 防护、限流和账号数据隔离。
- SQLite 持久化，提供非 root、只读根文件系统的 Docker Compose 配置。

当前支持文本对话；不执行终端命令、不操作代码仓库，不包含图片/文件输入或流式返回。

## 本地启动

需要 Node.js 24。服务使用 Node 内置模块和仓库内已收录的 `jose@6.2.12`，后者用于验证 Google ID Token。无需 `npm install`；构建不需要下载依赖。依赖来源和许可见 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。

```bash
git clone https://github.com/IXYTYXI/model-studio-test.git
cd model-studio-test
npm run setup
npm start
```

`setup` 会提示设置管理员账号和密码，并生成随机主密钥。打开 <http://localhost:8080> 登录，在管理设置填写有效 API Key、你有权使用的模型名称，并启用对应服务。

首次登录成功后，从 `.env` 删除 `BOOTSTRAP_PASSWORD` 并重启。保留 `MASTER_KEY`，它用于解密已保存的 API Key。不要把 `.env`、数据库或密钥提交到仓库。

## 部署

初始化 `.env` 后，可在允许出站 HTTPS 的独立 Docker 主机运行：

```bash
docker compose build --pull=false
docker compose up -d
```

构建不下载依赖，固定的基础镜像需预先缓存。公网部署需要 HTTPS 反向代理，并将 `PUBLIC_ORIGIN` 设置为实际访问的 HTTPS origin；默认宿主机只绑定 `127.0.0.1:8080`。

Awesome Deploy 使用仓库根目录的 [awesome.yaml](awesome.yaml)，应用前缀为 `chatstd`。管理员须启用 `public-https-v1` 并准备清单引用的业务秘密。模型 Key 可通过 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY` 注入；在清单中仅启用自己已准备好 Key 的供应商引用。平台连接内环境 Key 优先，页面只显示“由平台管理”，不会返回密钥值。

平台不会读取 Compose 或本地 `.env` 来替代部署清单。现有应用已部署于 [Chat Studio](https://chatstd.awesome.guanghexinzhi.cn)，appId 为 `30ee5b3e97d44708a2b7e97ca9815e10`；后续更新沿用此 appId 和持久卷。真实模型调用仍需使用你自己的有效 Key 验收。

详细步骤见 [使用说明](README.txt) 和 [部署、配置及备份说明](DEPLOYMENT.txt)。

## Google 账号登录（可选）

在 Google Cloud 创建 **Web application** OAuth 客户端，受众选择 External，本应用仅请求 `openid email`。同时配置 `GOOGLE_CLIENT_ID` 与 `GOOGLE_CLIENT_SECRET`：Client ID 不是秘密，可放在平台 `env`；Client Secret 必须由平台 `secretRefs` 注入。两个配置示例默认都保留注释；没有真实凭据时 Google 登录关闭，页面不显示不可用按钮。只配置其中一个会导致启动校验失败。

授权重定向地址必须与 `PUBLIC_ORIGIN` 生成的地址完全一致：

- 生产：`https://chatstd.awesome.guanghexinzhi.cn/api/auth/google/callback`
- 本机：`http://localhost:8080/api/auth/google/callback`

首次登录创建 `member`，受账号总数和每日额度限制。身份只按 Google `sub` 绑定，**不会依据邮箱合并现有密码账号，也不会自动获得管理员权限**。Google 身份资料仅持久化 `sub` 和邮箱，不保存 Google 访问令牌、刷新令牌或 ID Token。仅使用 Google 登录的成员可由管理员设置本地密码，之后使用页面显示的用户名登录。

Google 的 External + Testing 通常受测试用户名单限制，但仅请求 `openid`、`email`、`profile` 基本身份范围的应用有明确例外；本项目的 `openid email` 属于该例外。生产使用仍应按 Google 控制台要求完成正式发布及适用验证，并实测目标账号；Workspace 管理策略等仍可能阻止授权。参见 [Google 受众与发布状态](https://support.google.com/cloud/answer/15549945?hl=en)、[OpenID Connect 身份说明](https://developers.google.com/identity/openid-connect/openid-connect) 和 [Web OAuth 配置](https://developers.google.com/identity/protocols/oauth2/web-server)。当前未配置真实 Google 凭据，也未完成公网登录验收。

## 个人 API Key

登录后打开侧栏的 **个人 API Key**，填写服务商提供的 API 地址和 Key，点击 **获取模型**，搜索并选择模型，勾选 **启用连接** 后保存。第三方地址默认选择 OpenAI 兼容 Chat Completions；若服务商使用其他协议，手动选择对应协议。每个账号独立配置；密钥使用 AES-256-GCM 加密，并绑定所属用户和供应商。保存后只显示“密钥已保存”，不会返回密钥原文。更改 API 地址必须重新填写对应 Key；部署清单已启用 `ALLOW_CUSTOM_API_HOSTS=true`，支持第三方公网 HTTPS 域名（443 端口），并保留私网阻断、DNS 校验与 IP 固定、TLS 校验及禁止重定向。设为 `false` 时，只允许官方主机及 `ALLOWED_API_HOSTS` 中的精确域名。

获取列表不会保存、启用或切换连接，也不发起生成请求。已保存的 Key 留空即可复用，但仅限原 API 地址。列表为空或服务商不支持列表时可手动填写模型 ID。列表只代表服务商返回的目录，不保证每个模型都有调用权限；只有服务商明确返回输出 Token 上限时，页面才显示并据此校验；缺少元数据时允许手填，不把上下文长度当作输出能力。价格、余额和其他功能也不保证包含在列表中。查询有 20 秒总超时，最多 10 页、1000 个模型；每账号每分钟最多 10 次、全站 60 次，同时最多 4 个账号查询。

个人连接一经选择，调用失败、停用或删除密钥都不会自动改用平台 Key。管理员可在成员管理中授权“允许使用平台连接”；有权限的成员可在个人设置中选择平台连接。平台环境 Key 只对平台连接生效，不覆盖个人 Key。Google 新成员和新建本地成员默认没有平台连接权限；升级前的已有成员保留原权限，管理员可撤销。

普通成员的个人与平台调用均受账号每日额度、成员合计日额度和每分钟 8 次的频率限制。管理员免除这些次数限制，其调用不消耗普通成员的合计日额度。升级自动添加数据表与权限字段；生产 HTTPS 会话改用 `__Host-` Cookie，原登录会话需重新登录，账号及历史记录保留。

## 等待回复时切换页面

生成期间可切换 Codex、Claude、Gemini，打开历史对话、新建对话、查看设置或使用浏览器前进后退。请求始终绑定原对话；切到别处时会显示进度，完成或失败后可点击提示返回。每个对话和工作空间的新对话分别保留当前页面内的草稿，完成回复不会覆盖正在编辑的内容。失败消息可展开查看；输入框已有后续草稿时会保留它。

不同模型、同一模型的不同对话可同时生成，各自显示状态、完成或失败通知。只有正在生成的同一对话暂时不能再次发送或删除，其余对话可正常提问或删除。服务整体保留最多 4 个进行中生成请求的容量保护，繁忙时返回明确提示；这是服务容量限制，不是管理员日额度。站内切换会继续等待，刷新、关闭页面或退出登录不属于持久后台任务，可能中断尚未完成的请求；草稿仅存在当前页面内存，不写入浏览器持久存储。

## 输出长度与等待时间

最大输出 Token 接受正整数，例如 `32768`、`65536` 或模型支持的更大值；新连接默认 `8192`，升级保留已有保存值。获取模型后，若服务商返回输出上限，页面显示该值并阻止超限保存；更换地址、Key、协议或手填其他模型后会清除失效的上限信息。上限提示来自本次查询，实际参数仍由服务商校验；基本 OpenAI 模型列表未提供上限时不会猜测。

生成请求默认总超时为 300 秒，可通过 `PROVIDER_TIMEOUT_SECONDS` 设置为 10–1800 秒。服务每 15 秒发送 JSON 空白保活，并关闭该响应的代理缓冲，避免平台 60 秒空闲超时中断长回答；这不是逐 Token 展示。错误发生在保活开始后时，HTTP 状态已固定为 200，JSON 的 `error.status` 保存实际错误状态，内置前端会识别并显示；直连接口的其他客户端也应检查 `error`。仍保留 8 MiB 上游响应体、100 万字符单条输出以及并发、每日请求数量限制。实际模型权限、输出能力和上游自身的等待限制以服务商为准。

## 验证

```bash
npm test
```

验证范围与测试数量见 [VALIDATION.json](VALIDATION.json)，平台清单静态校验见 [PLATFORM-VALIDATION.json](PLATFORM-VALIDATION.json)。自动化模型列表测试使用模拟响应；真实 Google 账号登录和付费模型调用尚未验证。公网发布与本地测试记录分别记录，避免将测试环境结果视为真实供应商验收。
