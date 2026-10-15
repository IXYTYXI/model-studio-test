# Model Studio

一个可自行部署的多模型文本对话服务，包含 Codex、Claude、Gemini 风格的三种页面，以及统一的登录、历史会话和管理设置。界面为独立实现，不代表这些产品的官方服务。

## 功能

- OpenAI Responses / Chat Completions、Anthropic Messages、Gemini generateContent API。
- 管理员配置 API 地址、模型名称、API Key、输出长度和启用状态。
- 管理员创建或禁用成员、重置密码、设置每日请求额度；不开放公共注册。
- 服务端保存会话，API Key 加密存储，提供来源检查、CSRF 防护、限流和账号数据隔离。
- SQLite 持久化，提供非 root、只读根文件系统的 Docker Compose 配置。

当前支持文本对话；不执行终端命令、不操作代码仓库，不包含图片/文件输入或流式返回。

## 本地启动

需要 Node.js 24。项目只使用 Node 内置模块，不需要 `npm install`。

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

Awesome Deploy 0.5.0 使用仓库根目录的 [awesome.yaml](awesome.yaml)，应用前缀为 `chatstd`。管理员须启用 `public-https-v1` 并准备清单引用的业务秘密。模型 Key 可通过 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY` 注入；在清单中仅启用自己已准备好 Key 的供应商引用。环境 Key 优先，页面只显示“由平台管理”，不会返回密钥值。

平台不会读取 Compose 或本地 `.env` 来替代部署清单。当前尚未完成线上预检、域名占用检查和真实模型调用，配置文件不代表已上线。

详细步骤见 [使用说明](README.txt) 和 [部署、配置及备份说明](DEPLOYMENT.txt)。

## 验证

```bash
npm test
```

目前 56 项测试通过；已验证离线镜像构建、容器访问控制、环境密钥管理与重建后的持久化。具体范围见 [VALIDATION.json](VALIDATION.json)，平台清单静态校验见 [PLATFORM-VALIDATION.json](PLATFORM-VALIDATION.json)。尚未进行真实付费模型调用或公网部署验收。
