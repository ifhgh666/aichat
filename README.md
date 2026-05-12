# AI Chat Box

一个基于 `Node.js + Express` 的智能聊天框项目。前端是单页 `HTML/CSS/JavaScript`，后端负责保护 API Key、调用 DeepSeek、处理流式回复，并接入天气和联网搜索工具。

## 功能

- DeepSeek 流式聊天回复
- 多轮对话上下文
- 停止生成按钮
- SQLite 本地聊天记录保存
- Markdown 渲染、代码高亮、代码复制
- `.env` 配置 system prompt
- Open-Meteo 实时天气工具
- Tavily 联网搜索工具
- Render 部署支持

## 项目结构

```text
.
├─ 1/
│  ├─ app.js        # 后端主程序
│  └─ index.html    # 前端页面
├─ app.js           # 根入口代理
├─ index.js         # 根入口代理
├─ start.cmd        # Windows 启动脚本
├─ package.json
├─ package-lock.json
├─ .env.example     # 环境变量模板
├─ .gitignore
├─ 笔记001.md
└─ README.md
```

## 本地运行

要求：

```text
Node.js >= 22.17.0
```

安装依赖：

```bash
npm install
```

复制 `.env.example` 为 `.env`，并填入自己的密钥：

```env
DEEPSEEK_API_KEY=your_deepseek_api_key
DEEPSEEK_MODEL=deepseek-v4-pro
PORT=3000
SYSTEM_PROMPT=你是一个简洁、友好的中文助手。
DEFAULT_WEATHER_CITY=广州
TAVILY_API_KEY=your_tavily_api_key
SEARCH_TOOL_ENABLED=true
```

启动：

```bash
npm start
```

浏览器访问：

```text
http://localhost:3000
```

## 环境变量

| 变量名 | 作用 | 是否必填 |
| --- | --- | --- |
| `DEEPSEEK_API_KEY` | DeepSeek API Key | 是 |
| `DEEPSEEK_MODEL` | DeepSeek 模型名 | 否 |
| `PORT` | 本地端口 | 否 |
| `SYSTEM_PROMPT` | 机器人角色和行为提示词 | 否 |
| `DEFAULT_WEATHER_CITY` | 天气工具默认城市 | 否 |
| `TAVILY_API_KEY` | Tavily 搜索 API Key | 否 |
| `SEARCH_TOOL_ENABLED` | 是否启用搜索工具 | 否 |

`.env` 只用于本地运行，不能上传 GitHub。

## API

主要接口：

```text
GET    /
GET    /api/status
GET    /api/messages
POST   /api/messages
DELETE /api/messages
POST   /api/chat
```

聊天链路：

```text
前端输入
-> POST /api/chat
-> 后端按需查询天气/搜索
-> 后端请求 DeepSeek
-> DeepSeek 流式返回
-> 后端逐段转发
-> 前端逐段显示
```

## 部署到 Render

第一版部署目标是“别人可以通过公开网址访问”。当前 SQLite 聊天记录保存在 `data/chat-history.db`，在免费部署环境中可能不会长期持久保存。

Render 配置：

```text
Service Type: Web Service
Root Directory: 仓库根目录
Build Command: npm install
Start Command: npm start
```

Render 环境变量：

```env
DEEPSEEK_API_KEY=你的线上DeepSeekKey
DEEPSEEK_MODEL=deepseek-v4-pro
SYSTEM_PROMPT=你是一个简洁、友好的中文助手。
DEFAULT_WEATHER_CITY=广州
TAVILY_API_KEY=你的TavilyKey
SEARCH_TOOL_ENABLED=true
```

部署后打开 Render 提供的公开 URL 测试：

```text
什么是 JSON？
广州今天天气怎么样？
今天 AI 有什么最新新闻？
用 Markdown 解释数组，并给 JS 代码
```

## 安全说明

- 不要把 `.env` 上传到 GitHub。
- 不要把 `DEEPSEEK_API_KEY` 或 `TAVILY_API_KEY` 写进代码。
- 如果 Key 曾经发到聊天、截图或公开仓库里，建议去对应平台重置。
- `.gitignore` 已忽略 `.env`、`data/`、`*.db`。

## 学习重点

- 前端如何调用后端接口
- 后端如何保护 API Key
- 大模型 `messages` 格式
- system prompt 和配置的区别
- SSE/流式回复
- SQLite 本地保存聊天记录
- 工具调用：天气、搜索
- 本地运行和线上部署的区别
