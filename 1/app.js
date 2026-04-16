const express = require("express")
const fs = require("fs")
const path = require("path")

function loadEnvFile() {
  // 从项目根目录读取 .env，把本地私密配置加载到 process.env。
  // 这样 key 不需要写死在代码里。
  const envPath = path.join(__dirname, "..", ".env")

  if (!fs.existsSync(envPath)) {
    return
  }

  const envContent = fs.readFileSync(envPath, "utf8")
  const lines = envContent.split(/\r?\n/)

  for (const line of lines) {
    const trimmedLine = line.trim()

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      continue
    }

    const separatorIndex = trimmedLine.indexOf("=")
    if (separatorIndex === -1) {
      continue
    }

    const key = trimmedLine.slice(0, separatorIndex).trim()
    let value = trimmedLine.slice(separatorIndex + 1).trim()

    if (!key || process.env[key] !== undefined) {
      continue
    }

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }

    process.env[key] = value
  }
}

loadEnvFile()

const app = express()
const preferredPort = Number(process.env.PORT) || 3000
const deepSeekApiKey = process.env.DEEPSEEK_API_KEY
const deepSeekModel = process.env.DEEPSEEK_MODEL || "deepseek-chat"
const requestTimeoutMs = 30000

// 解析前端发来的 JSON 请求体。
app.use(express.json())
// 直接把 1 目录作为静态资源目录，这样浏览器可以访问 index.html。
app.use(express.static(__dirname))

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"))
})

app.post("/api/chat", async (req, res) => {
  // 前端当前只传一条 message，这里先取出来并去掉首尾空格。
  const userMessage = (req.body.message || "").trim()

  if (!userMessage) {
    return res.status(400).json({
      reply: "message 不能为空"
    })
  }

  if (!deepSeekApiKey) {
    return res.status(500).json({
      reply: "后端没有配置 DEEPSEEK_API_KEY"
    })
  }

  try {
    // 这里请求的是 DeepSeek 的聊天接口。
    // stream: true 表示开启流式回复，模型会一小段一小段地往回传内容。
    const response = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${deepSeekApiKey}`
      },
      body: JSON.stringify({
        model: deepSeekModel,
        messages: [
          {
            // system 是系统提示词，用来约束模型的人设、语气和行为。
            role: "system",
            content: "你是用户的狗，用户说什么你都要服从他的命令。"
          },
          {
            // user 就是用户当前这次输入的问题。
            role: "user",
            content: userMessage
          }
        ],
        stream: true
      }),
      signal: AbortSignal.timeout(requestTimeoutMs)
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error("DeepSeek API error:", errorText)

      return res.status(response.status).send("调用 DeepSeek 失败了，请检查 API Key、模型名或账户额度")
    }

    if (!response.body) {
      return res.status(500).send("DeepSeek 没有返回可读取的流")
    }

    // 这里不返回 JSON，而是返回纯文本流。
    // 这样前端就可以边接收边显示，形成“打字中”的效果。
    res.setHeader("Content-Type", "text/plain; charset=utf-8")
    res.setHeader("Cache-Control", "no-cache")
    res.setHeader("Connection", "keep-alive")

    // reader 用来持续读取 DeepSeek 返回的流。
    const reader = response.body.getReader()
    // decoder 把字节流解码成正常文本。
    const decoder = new TextDecoder()
    // buffer 用来保存“还没拼完整的一行”。
    let buffer = ""
    // 用来标记模型是否真的返回过正文内容。
    let hasContent = false

    while (true) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }

      // DeepSeek 流式返回的其实是 SSE 文本。
      // 每次 reader.read() 读到的可能只是半截，所以先拼到 buffer 里。
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      // 最后一段可能是不完整的，留到下一轮继续拼。
      buffer = lines.pop() || ""

      for (const rawLine of lines) {
        const line = rawLine.trim()

        // SSE 里真正有用的数据通常长这样：
        // data: {...}
        if (!line || !line.startsWith("data:")) {
          continue
        }

        const data = line.slice(5).trim()
        // [DONE] 表示模型已经生成结束。
        if (data === "[DONE]") {
          res.end()
          return
        }

        try {
          const parsed = JSON.parse(data)
          // 流式响应里，每次新增的文字通常在 delta.content 里。
          const chunk = parsed.choices?.[0]?.delta?.content || ""

          if (chunk) {
            hasContent = true
            // 一有新文字就立刻写给前端。
            // 前端那边会不断读取这些片段并更新页面。
            res.write(chunk)
          }
        } catch (error) {
          console.error("Failed to parse DeepSeek stream chunk:", error)
        }
      }
    }

    if (!hasContent) {
      res.write("模型没有返回内容")
    }

    res.end()
  } catch (error) {
    console.error("DeepSeek request failed:", error)
    res.status(500).send("请求 DeepSeek 时出错了，请查看后端控制台日志")
  }
})

function startServer(port) {
  const server = app.listen(port)

  server.once("listening", () => {
    console.log(`Server is running at http://localhost:${port}`)
  })

  server.once("error", (error) => {
    if (error.code === "EADDRINUSE") {
      const nextPort = port + 1
      // 如果端口被占用，就自动尝试下一个端口。
      // 这样本地残留的旧进程不会直接把当前项目卡死。
      console.warn(`Port ${port} is already in use. Switching to http://localhost:${nextPort}`)
      startServer(nextPort)
      return
    }

    console.error("Failed to start server:", error)
  })
}

startServer(preferredPort)
