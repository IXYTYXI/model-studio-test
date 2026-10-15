# Model Studio

一个可自行部署的多模型文本对话服务，包含 Codex、Claude、Gemini 风格的三种页面，以及统一的登录、历史会话和管理设置。界面为独立实现，不代表这些产品的官方服务。

## 功能

- OpenAI Responses / Chat Completions、Anthropic Messages、Gemini generateContent API。
- 管理员配置 API 地址、模型名称、API Key、输出长度和启用状态。
- 每个账号可独立设置、替换和删除个人 API Key、API 地址和模型；新成员默认使用自己的 Key，平台 Key 需要管理员单独授权。
- 保留用户名和密码登录；配置 Google 登录后，所有通过 Google 验证的账号均可首次自动注册为普通成员，无应用内邮箱白名单。
- 管理员创建或禁用成员、重置密码、设置每日请求额度；全站最多 100 个账号，默认每账号每日 50 次、全站每日 500 次。
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

Awesome Deploy 0.5.0 使用仓库根目录的 [awesome.yaml](awesome.yaml)，应用前缀为 `chatstd`。管理员须启用 `public-https-v1` 并准备清单引用的业务秘密。模型 Key 可通过 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY` 注入；在清单中仅启用自己已准备好 Key 的供应商引用。平台连接内环境 Key 优先，页面只显示“由平台管理”，不会返回密钥值。

平台不会读取 Compose 或本地 `.env` 来替代部署清单。当前尚未完成线上预检、域名占用检查和真实模型调用，配置文件不代表已上线。

详细步骤见 [使用说明](README.txt) 和 [部署、配置及备份说明](DEPLOYMENT.txt)。

## Google 账号登录（可选）

在 Google Cloud 创建 **Web application** OAuth 客户端，受众选择 External，本应用仅请求 `openid email`。同时配置 `GOOGLE_CLIENT_ID` 与 `GOOGLE_CLIENT_SECRET`：Client ID 不是秘密，可放在平台 `env`；Client Secret 必须由平台 `secretRefs` 注入。两个配置示例默认都保留注释；没有真实凭据时 Google 登录关闭，页面不显示不可用按钮。只配置其中一个会导致启动校验失败。

授权重定向地址必须与 `PUBLIC_ORIGIN` 生成的地址完全一致：

- 生产：`https://chatstd.awesome.guanghexinzhi.cn/api/auth/google/callback`
- 本机：`http://localhost:8080/api/auth/google/callback`

首次登录创建 `member`，受账号总数和每日额度限制。身份只按 Google `sub` 绑定，**不会依据邮箱合并现有密码账号，也不会自动获得管理员权限**。Google 身份资料仅持久化 `sub` 和邮箱，不保存 Google 访问令牌、刷新令牌或 ID Token。仅使用 Google 登录的成员可由管理员设置本地密码，之后使用页面显示的用户名登录。

Google 的 External + Testing 通常受测试用户名单限制，但仅请求 `openid`、`email`、`profile` 基本身份范围的应用有明确例外；本项目的 `openid email` 属于该例外。生产使用仍应按 Google 控制台要求完成正式发布及适用验证，并实测目标账号；Workspace 管理策略等仍可能阻止授权。参见 [Google 受众与发布状态](https://support.google.com/cloud/answer/15549945?hl=en)、[OpenID Connect 身份说明](https://developers.google.com/identity/openid-connect/openid-connect) 和 [Web OAuth 配置](https://developers.google.com/identity/protocols/oauth2/web-server)。当前未配置真实 Google 凭据，也未完成公网登录验收。

## 个人 API Key

登录后打开侧栏的 **个人 API Key**，为 OpenAI、Claude 或 Gemini 填写服务商提供的 API 地址、模型名称和 Key，启用并保存即可。每个账号独立配置；密钥使用 AES-256-GCM 加密，并绑定所属用户和供应商。保存后只显示“密钥已保存”，不会返回密钥原文。更改 API 地址必须重新填写对应 Key；自定义主机须由部署者加入 `ALLOWED_API_HOSTS`。

个人连接一经选择，调用失败、停用或删除密钥都不会自动改用平台 Key。管理员可在成员管理中授权“允许使用平台连接”；有权限的成员可在个人设置中选择平台连接。平台环境 Key 只对平台连接生效，不覆盖个人 Key。Google 新成员和新建本地成员默认没有平台连接权限；升级前的已有成员保留原权限，管理员可撤销。

个人与平台调用都受账号每日额度、全站限额和并发限制。升级自动添加数据表与权限字段；生产 HTTPS 会话改用 `__Host-` Cookie，原登录会话需重新登录，账号及历史记录保留。

## 验证

```bash
npm test
```

验证范围与测试数量见 [VALIDATION.json](VALIDATION.json)，平台清单静态校验见 [PLATFORM-VALIDATION.json](PLATFORM-VALIDATION.json)。尚未进行真实 Google 账号登录、付费模型调用或公网部署验收。
