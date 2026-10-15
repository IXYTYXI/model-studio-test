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

现有 Awesome Deploy 0.4.1 的内部网络会阻断外部模型 API。`awesome.blocked.yaml` 是限制说明，不能作为部署清单使用。

详细步骤见 [使用说明](README.txt) 和 [部署、配置及备份说明](DEPLOYMENT.txt)。

## 验证

```bash
npm test
```

目前 50 项测试通过；已验证离线镜像构建、容器访问控制与重建后的持久化。具体范围见 [VALIDATION.json](VALIDATION.json)。尚未进行真实付费模型调用或公网部署验收。
