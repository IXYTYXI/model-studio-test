Model Studio

一个可自行运行的多模型文本对话网站。提供三种独立布局、历史会话、模型服务配置、管理员创建成员、账号每日额度。OpenAI 支持 Responses 与 Chat Completions，Anthropic 与 Gemini 可使用各自协议，也可选择 OpenAI 兼容协议。界面灵感来自 Codex、Claude、Gemini；这是独立实现，不代表这些产品的官方服务。

本地启动
1. 安装 Node.js 24，在此目录打开终端。项目使用 Node 内置模块和仓库内已收录的 jose@6.2.12 来验证 Google ID Token，不需要 npm install，也不在构建时下载依赖；来源和许可见 THIRD_PARTY_NOTICES.txt。
2. 运行 npm run setup。输入管理员用户名和 14–128 字符密码；密码不显示。脚本生成随机主密钥，并以 0600 权限原子创建 .env；已有 .env 时拒绝覆盖。
3. 运行 npm start，打开 http://localhost:8080，使用刚设置的管理员账号登录。
4. 在管理设置中填写对应服务的 API 地址和 API key，点击“获取模型”，搜索并选择模型，勾选“启用连接”后保存。也可手动填写模型 ID。空白 API key 表示保留已有密钥。
   如需仅供自己使用，请打开侧栏“个人 API Key”；管理员“平台连接”用于提供给获授权成员共享。
5. 首次成功登录后，从 .env 删除 BOOTSTRAP_PASSWORD 并重启。保留 MASTER_KEY；它用于解密存储的 API key。首次启动的管理员密码只用于空数据库初始化。

setup 为兼容 Node 与 Docker Compose 的 .env 读取，使用单引号保存密码，因而不接受含单引号或换行的初始化密码；其他符号（含 $）可用。实际账号密码可在登录后修改。禁止将 .env、数据库或密钥提交至源码仓库。

账号与额度
新 Google 成员和新建本地成员默认没有平台 Key 使用权。管理员可在成员管理中勾选“允许使用平台连接”，仅向同意承担费用的成员授权；已有旧版成员升级时保留原共享权限，可由管理员撤销。
管理员可以创建本地成员，配置其每日请求次数，或禁用账号。配置 Google 登录后，所有通过 Google 验证的账号均可首次自动注册为普通成员（member），不设置应用内邮箱白名单，也不会自动成为管理员。全站最多 100 个账号；普通成员默认每人每日 50 次、普通成员合计每日 500 次；管理员不限每日次数。按 Asia/Shanghai 的日历日统计；已扣额的请求即使模型调用失败也消耗额度。账号额度与全站额度都限制请求次数，不是费用或 token 上限。请同时在模型供应商后台设置消费限制。

Google 登录（可选）
在 Google Cloud 创建 Web application 类型的 OAuth 客户端，选择 External 受众；本应用仅请求 openid email。GOOGLE_CLIENT_ID 与 GOOGLE_CLIENT_SECRET 必须同时配置，只配置一个会使启动校验失败。Client ID 不是秘密，可放入 awesome.yaml 的 env；Client Secret 通过平台 secretRefs 配置。本机可在 .env 中同时配置。当前示例均未启用，未提供真实凭据时保持关闭，登录页不显示 Google 按钮。
生产授权回调：https://chatstd.awesome.guanghexinzhi.cn/api/auth/google/callback
本机授权回调：http://localhost:8080/api/auth/google/callback
回调由 PUBLIC_ORIGIN 加 /api/auth/google/callback 生成；Google 控制台的授权重定向 URI 必须完全匹配。详情见 DEPLOYMENT.txt。
账号只按稳定的 Google sub 绑定，不按 email 合并已有密码账号。即使邮箱相同，也不会继承本地账号的数据或权限。Google 身份资料只持久化 sub 和 email，不保存 Google 访问令牌、刷新令牌或 ID Token。Google-only 账号初始没有本地密码，管理员可在成员管理中设置；设置后使用页面显示的用户名和该密码登录。
External + Testing 通常只允许测试用户；Google 对仅请求 openid/email/profile 基本身份范围的应用设有例外，本项目的 openid email 属于该例外，不应将测试名单当作访问控制。生产使用应完成正式发布及适用验证，并实测目标账号；组织管理策略仍可能阻止 Google 授权。当前没有配置真实 Google 凭据，也未完成真实公网登录验收。
官方说明：
Google 受众与发布状态：https://support.google.com/cloud/answer/15549945?hl=en
OpenID Connect：https://developers.google.com/identity/openid-connect/openid-connect
Web OAuth 客户端配置：https://developers.google.com/identity/protocols/oauth2/web-server

安全与功能边界
每人可在“个人 API Key”中独立配置三家供应商的地址、模型和 Key。个人 Key 使用 AES-256-GCM 加密，并绑定用户与供应商，读取设置不返回原文；其他成员不可读取或修改。留空保留已有 Key，输入新值替换；更改地址须重新输入 Key。“删除个人密钥”同时停用个人连接，之后不会自动使用平台 Key。已选择个人连接时，即使调用失败也不会回退到平台 Key。获得共享权限后，可显式选择“使用平台连接”。普通成员的个人 Key 同样受账号与成员合计调用限额约束；管理员仅统计使用次数。
管理页保存的 API key 仅保存在服务器，使用 AES-256-GCM 加密。也支持 OPENAI_API_KEY、ANTHROPIC_API_KEY、GEMINI_API_KEY 环境变量；平台可通过 secretRefs 注入。环境 Key 优先、不写入数据库，页面显示“由平台管理”并禁止修改该密钥。移除环境 Key 后恢复原数据库 Key（如有）。密码使用 scrypt。服务使用服务器会话、同源检查和 CSRF 防护。客户端不会拿到已存储或平台注入的 API key。
上述环境 Key 优先级仅适用于平台连接，不覆盖用户的个人 Key。生产 HTTPS 的会话和 Google 流程 Cookie 使用 __Host-、Secure、Path=/，防止兄弟子域植入同名 Cookie。旧版 HTTPS 会话升级后需重新登录，账号和历史记录保留。
awesome.yaml 与 .env.example 启用 ALLOW_CUSTOM_API_HOSTS=true，允许第三方公网 HTTPS 域名（443 端口），继续禁止私网、IP 直连和重定向。未设置该变量时默认关闭；关闭后额外主机须加入 ALLOWED_API_HOSTS 精确域名列表。查询模型不会保存配置或发送生成请求；列表为空或查询失败时仍可手填模型 ID。已保存 Key 仅能在原地址查询，个人查询不借用平台 Key。
此版本是文本对话，不执行终端命令、不读取代码仓库，不是 Codex 终端代理；也不包含联网搜索、图片/文件输入或流式返回。

部署与验证
Docker、HTTPS、数据备份、密钥恢复及 Awesome Deploy 的接入步骤见 DEPLOYMENT.txt。平台清单为根目录 awesome.yaml，用户指定前缀 chatstd；平台须启用 public-https-v1，并通过 secretRefs 注入实际使用的业务秘密。
现有服务已发布于 https://chatstd.awesome.guanghexinzhi.cn，后续更新沿用原 appId 与持久卷。未配置真实供应商 API key，未验证付费模型调用。自动化测试不能替代部署后使用自有 key 的验收。

输出长度
最大输出 Token 已取消应用统一的 4096 限制，可输入 32768、65536 或服务商支持的更大值。新连接默认 8192；旧设置保留，请按需要手动调整。获取模型后，接口明确返回的输出上限会显示并用于页面校验；未返回则手动填写，以服务商实际能力为准。
生成默认最多等待 5 分钟，PROVIDER_TIMEOUT_SECONDS 可配置 10–1800 秒。应用保活处理平台的空闲超时，仍由服务商决定其自身等待期限。此版本不逐字展示生成结果。

等待回复时可切换工作空间、浏览历史、新建对话和编辑草稿；结果归属原对话，并提供完成/失败返回提示。不同对话可同时生成，同一对话防止重复提交。应用不设置全站生成并发数量上限，管理员没有跨对话并发、每日次数或生成请求频率限制；普通成员仍遵守已有每日额度和发送频率。草稿仅保留在当前页面内存，刷新或关闭页面可能中断请求。
