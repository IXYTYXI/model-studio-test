Model Studio

一个可自行运行的多模型文本对话网站。提供三种独立布局、历史会话、模型服务配置、管理员创建成员、账号每日额度。OpenAI 支持 Responses 与 Chat Completions，Anthropic 与 Gemini 使用各自协议。界面灵感来自 Codex、Claude、Gemini；这是独立实现，不代表这些产品的官方服务。

本地启动
1. 安装 Node.js 24，在此目录打开终端。项目没有第三方运行依赖，不需要 npm install。
2. 运行 npm run setup。输入管理员用户名和 14–128 字符密码；密码不显示。脚本生成随机主密钥，并以 0600 权限原子创建 .env；已有 .env 时拒绝覆盖。
3. 运行 npm start，打开 http://localhost:8080，使用刚设置的管理员账号登录。
4. 在管理设置中填写对应服务的 API 地址、API key、模型名称并启用。空白 API key 表示保留已有密钥。
5. 首次成功登录后，从 .env 删除 BOOTSTRAP_PASSWORD 并重启。保留 MASTER_KEY；它用于解密存储的 API key。首次启动的管理员密码只用于空数据库初始化。

setup 为兼容 Node 与 Docker Compose 的 .env 读取，使用单引号保存密码，因而不接受含单引号或换行的初始化密码；其他符号（含 $）可用。实际账号密码可在登录后修改。禁止将 .env、数据库或密钥提交至源码仓库。

账号与额度
没有开放注册。管理员创建成员，配置其每日请求次数，或禁用账号。按 Asia/Shanghai 的日历日统计；已扣额的请求即使模型调用失败也消耗额度。账号额度与全站额度都限制请求次数，不是费用或 token 上限。请同时在模型供应商后台设置消费限制。

安全与功能边界
API key 仅保存在服务器，使用 AES-256-GCM 加密。密码使用 scrypt。服务使用服务器会话、同源检查和 CSRF 防护。客户端不会拿到已存储的 API key。
默认允许 api.openai.com、api.anthropic.com 和 generativelanguage.googleapis.com。自定义兼容服务须添加精确 DNS 主机名到 ALLOWED_API_HOSTS，并重启；只支持可公开解析的 HTTPS 目标，不允许私网、IP 直连、重定向或通配符。
此版本是文本对话，不执行终端命令、不读取代码仓库，不是 Codex 终端代理；也不包含联网搜索、图片/文件输入或流式返回。

部署与验证
Docker、HTTPS、数据备份、密钥恢复及 Awesome Deploy 的已知阻塞见 DEPLOYMENT.txt。
本交付不代表已在公网发布。未配置真实供应商 API key，未验证付费模型调用。自动化测试不能替代部署后使用自有 key 的验收。
