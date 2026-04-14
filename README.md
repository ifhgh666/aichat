# DeepSeek Stream Chat Box v1

一个基于 `Node.js + Express` 的简易智能聊天框项目，前端页面和后端服务都包含在仓库中，并且已经接入 DeepSeek API 的流式回复。

## 项目特点

- 前端聊天页面，支持用户输入和消息展示
- 后端使用 `Node.js + Express`
- 已接入 DeepSeek `chat/completions` 接口
- 支持流式回复，消息会边生成边显示
- 使用 `.env` 管理本地密钥，不把真实 API Key 提交到仓库
- 附带一份学习笔记，记录本项目开发过程中学到的概念和实现方式

## 项目结构

```text
.
├─ 1/
│  ├─ app.js
│  └─ index.html
├─ app.js
├─ index.js
├─ start.cmd
├─ package.json
├─ .env.example
├─ 笔记001.md
└─ README.md
```

## 运行环境

- Node.js 18+ 以上

## 安装依赖

```bash
npm install
```

## 环境变量

根目录新建 `.env`，可以参考 `.env.example`：

```env
DEEPSEEK_API_KEY=your_deepseek_api_key
DEEPSEEK_MODEL=deepseek-chat
PORT=3000
```

说明：

- `.env` 不会提交到 GitHub
- 请把 `DEEPSEEK_API_KEY` 替换成你自己的真实 key

## 启动项目

### 方式 1

```bash
node app.js
```

### 方式 2

直接运行：

```text
start.cmd
```

启动后默认访问：

```text
http://localhost:3000
```

如果 `3000` 端口被占用，后端会自动切换到下一个可用端口。

## 当前版本

### v1

当前版本已经完成：

- 基础聊天页面
- 前后端联通
- DeepSeek API 接入
- 流式回复显示
- `.env` 配置
- 学习笔记整理

## 流式回复说明

当前项目的流式回复链路如下：

```text
浏览器前端
-> 请求自己的后端 /api/chat
-> 后端请求 DeepSeek API
-> DeepSeek 以流式方式返回
-> 后端逐段转发给前端
-> 前端逐段读取并更新页面
```

## 学习笔记

项目中包含一份学习笔记：

- `笔记001.md`

内容包括：

- 前后端和模型接口的调用关系
- `.env`、`.gitignore` 的作用
- JSON、messages、system prompt
- SDK、SSE、流式回复
- 当前项目的实现思路

## 后续可迭代方向

- 多轮上下文记忆
- 停止生成按钮
- 更完善的聊天 UI
- 实时联网搜索或工具调用
- 聊天记录保存
