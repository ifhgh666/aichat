//后端
const express = require("express")
const fs = require("fs")
const path = require("path")
const { DatabaseSync } = require("node:sqlite")

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
const systemPrompt = process.env.SYSTEM_PROMPT || "你是一个简洁、友好的中文助手。"
const defaultWeatherCity = process.env.DEFAULT_WEATHER_CITY || "广州"
const tavilyApiKey = process.env.TAVILY_API_KEY
const searchToolEnabled = process.env.SEARCH_TOOL_ENABLED !== "false"
const requestTimeoutMs = 30000
const dataDir = path.join(__dirname, "..", "data")
const databasePath = path.join(dataDir, "chat-history.db")

fs.mkdirSync(dataDir, { recursive: true })

const database = new DatabaseSync(databasePath)

database.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`)

function getApiKeyStatusText() {
  // 这里只告诉开发者“有没有配置”，绝对不要把真实 API Key 打印出来。
  return deepSeekApiKey ? "已配置" : "未配置"
}

function getCurrentTimeText() {
  // 大模型本身不知道真实时间，所以每次请求前由后端生成当前时间，再传给模型。
  const now = new Date()

  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "long",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(now)
}

function getDeepSeekErrorMessage(status, errorText) {
  // DeepSeek 返回失败时，后端日志里保留原始错误，页面上显示更容易理解的中文提示。
  const lowerErrorText = errorText.toLowerCase()

  if (status === 401 || status === 403) {
    return "DeepSeek API Key 无效或没有权限，请检查 .env 里的 DEEPSEEK_API_KEY"
  }

  if (status === 402 || lowerErrorText.includes("insufficient") || lowerErrorText.includes("balance")) {
    return "DeepSeek 账户余额不足，请检查平台余额"
  }

  if (status === 400 || status === 404 || lowerErrorText.includes("model")) {
    return `DeepSeek 请求参数或模型名有问题，请检查 DEEPSEEK_MODEL，当前模型是 ${deepSeekModel}`
  }

  if (status === 429 || lowerErrorText.includes("rate limit")) {
    return "DeepSeek 请求太频繁了，请稍后再试"
  }

  if (status >= 500) {
    return "DeepSeek 服务端暂时异常，请稍后再试"
  }

  return "调用 DeepSeek 失败了，请查看后端控制台日志"
}

function normalizeChatMessages(body) {
  // 新版前端会传 messages 数组，用来支持多轮对话。
  // 这里同时兼容旧版的 message 字符串，方便项目平滑迭代。
  if (Array.isArray(body.messages)) {
    return body.messages
      .filter((message) => {
        return (
          message &&
          ["user", "assistant"].includes(message.role) &&
          typeof message.content === "string" &&
          message.content.trim()
        )
      })
      .map((message) => {
        return {
          role: message.role,
          content: message.content.trim()
        }
      })
  }

  const userMessage = (body.message || "").trim()

  if (!userMessage) {
    return []
  }

  return [
    {
      role: "user",
      content: userMessage
    }
  ]
}

async function buildDeepSeekMessages(chatMessages, currentTimeText) {
  // system 消息由后端统一添加，避免前端随便传系统提示词影响安全和稳定性。
  const systemMessages = [
    systemPrompt,
    `当前真实时间是：${currentTimeText}。`,
    "如果用户问今天、现在、今年、几点、日期、星期几等和时间有关的问题，必须以这条当前真实时间为准，不要根据训练数据猜。"
  ]

  const weatherContext = await buildWeatherContextForMessages(chatMessages)
  if (weatherContext) {
    systemMessages.push(weatherContext)
  }

  const searchContext = await buildSearchContextForMessages(chatMessages)
  if (searchContext) {
    systemMessages.push(searchContext)
  }

  return [
    {
      role: "system",
      content: systemMessages.join("\n")
    },
    ...chatMessages
  ]
}

function getLastUserMessage(chatMessages) {
  for (let index = chatMessages.length - 1; index >= 0; index--) {
    if (chatMessages[index].role === "user") {
      return chatMessages[index].content
    }
  }

  return ""
}

function shouldUseWeatherTool(message) {
  const weatherKeywords = [
    "天气",
    "温度",
    "气温",
    "下雨",
    "降雨",
    "雨",
    "风速",
    "刮风",
    "冷不冷",
    "热不热",
    "会不会冷",
    "会不会热",
    "会不会下雨"
  ]

  return weatherKeywords.some((keyword) => message.includes(keyword))
}

function extractWeatherCity(message) {
  const cityPattern = /([\u4e00-\u9fa5]{2,10})(?:今天|现在|明天|后天)?(?:会不会|会|有没有|是否|的)?(?:天气|温度|气温|下雨|降雨|冷不冷|热不热|风速)/
  const matchedCity = message.match(cityPattern)?.[1]

  if (matchedCity) {
    const city = matchedCity
      .replace(/今天|现在|明天|后天/g, "")
      .replace(/会不会|有没有|是否|会/g, "")
      .replace(/我想|帮我|查一下|查询|看看/g, "")
      .trim()

    if (city && !["今天", "现在", "明天", "后天"].includes(city)) {
      return city
    }
  }

  return defaultWeatherCity
}

function getWeatherDescription(weatherCode) {
  const descriptions = {
    0: "晴朗",
    1: "大致晴朗",
    2: "局部多云",
    3: "阴天",
    45: "雾",
    48: "雾凇",
    51: "小毛毛雨",
    53: "中等毛毛雨",
    55: "大毛毛雨",
    61: "小雨",
    63: "中雨",
    65: "大雨",
    80: "小阵雨",
    81: "中等阵雨",
    82: "强阵雨",
    95: "雷暴"
  }

  return descriptions[weatherCode] || `未知天气代码 ${weatherCode}`
}

async function getCityLocation(city) {
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search")
  url.searchParams.set("name", city)
  url.searchParams.set("count", "1")
  url.searchParams.set("language", "zh")
  url.searchParams.set("format", "json")

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10000)
  })

  if (!response.ok) {
    throw new Error(`Open-Meteo 城市查询失败：${response.status}`)
  }

  const data = await response.json()
  const location = data.results?.[0]

  if (!location) {
    throw new Error(`没有找到城市：${city}`)
  }

  return {
    name: location.name,
    country: location.country,
    admin1: location.admin1,
    latitude: location.latitude,
    longitude: location.longitude,
    timezone: location.timezone || "auto"
  }
}

async function getWeather(city) {
  const location = await getCityLocation(city)
  const url = new URL("https://api.open-meteo.com/v1/forecast")
  url.searchParams.set("latitude", String(location.latitude))
  url.searchParams.set("longitude", String(location.longitude))
  url.searchParams.set("current", "temperature_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m")
  url.searchParams.set("timezone", location.timezone)

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10000)
  })

  if (!response.ok) {
    throw new Error(`Open-Meteo 天气查询失败：${response.status}`)
  }

  const data = await response.json()
  const current = data.current

  if (!current) {
    throw new Error("Open-Meteo 没有返回当前天气")
  }

  return {
    city: location.name,
    region: location.admin1,
    country: location.country,
    time: current.time,
    temperature: current.temperature_2m,
    apparentTemperature: current.apparent_temperature,
    precipitation: current.precipitation,
    weatherCode: current.weather_code,
    weatherDescription: getWeatherDescription(current.weather_code),
    windSpeed: current.wind_speed_10m,
    source: "Open-Meteo"
  }
}

function buildWeatherContext(weather) {
  return [
    "以下是后端天气工具查询到的实时天气，请优先依据这些数据回答用户天气问题：",
    `城市：${weather.city}${weather.region ? `，${weather.region}` : ""}${weather.country ? `，${weather.country}` : ""}`,
    `观测时间：${weather.time}`,
    `当前温度：${weather.temperature}°C`,
    `体感温度：${weather.apparentTemperature}°C`,
    `天气情况：${weather.weatherDescription}`,
    `风速：${weather.windSpeed} km/h`,
    `降水：${weather.precipitation} mm`,
    `数据来源：${weather.source}`
  ].join("\n")
}

async function buildWeatherContextForMessages(chatMessages) {
  const lastUserMessage = getLastUserMessage(chatMessages)

  if (!lastUserMessage || !shouldUseWeatherTool(lastUserMessage)) {
    return ""
  }

  const city = extractWeatherCity(lastUserMessage)

  try {
    const weather = await getWeather(city)
    return buildWeatherContext(weather)
  } catch (error) {
    console.error("Weather tool failed:", error)

    return [
      "用户正在询问天气，但后端天气工具查询失败。",
      `尝试查询的城市：${city}`,
      "请用中文友好说明暂时无法获取实时天气，并建议用户稍后再试或换一个城市。"
    ].join("\n")
  }
}

function shouldUseSearchTool(message) {
  if (!searchToolEnabled || !tavilyApiKey) {
    return false
  }

  const searchKeywords = [
    "最新",
    "新闻",
    "最近",
    "资料",
    "搜索",
    "查一下",
    "今天发生",
    "现在的",
    "实时",
    "联网",
    "新消息",
    "新进展"
  ]

  return searchKeywords.some((keyword) => message.includes(keyword))
}

function getSearchTopic(message) {
  const newsKeywords = ["新闻", "今天发生", "最新消息", "新消息", "热点"]
  return newsKeywords.some((keyword) => message.includes(keyword)) ? "news" : "general"
}

async function searchWeb(query) {
  const topic = getSearchTopic(query)
  const requestBody = {
    query: query,
    search_depth: "basic",
    topic: topic,
    max_results: 5,
    include_answer: false,
    include_raw_content: false,
    include_images: false
  }

  // Tavily 官方文档说明 country 仅适用于 general topic，news 不强行传，避免请求失败。
  if (topic === "general") {
    requestBody.country = "china"
  }

  const response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${tavilyApiKey}`
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(15000)
  })

  if (!response.ok) {
    const errorText = await response.text()
    throw new Error(`Tavily 搜索失败：${response.status} ${errorText}`)
  }

  return response.json()
}

function buildSearchContext(searchData) {
  const results = Array.isArray(searchData.results) ? searchData.results.slice(0, 5) : []

  if (results.length === 0) {
    return "后端搜索工具没有找到可用结果，请告诉用户暂时没有搜索到相关实时资料。"
  }

  const lines = [
    "以下是后端搜索工具查询到的实时资料，请优先依据这些资料回答，并在答案末尾列出来源链接：",
    `搜索问题：${searchData.query || ""}`
  ]

  results.forEach((result, index) => {
    lines.push("")
    lines.push(`${index + 1}. 标题：${result.title || "无标题"}`)
    lines.push(`链接：${result.url || "无链接"}`)
    lines.push(`摘要：${result.content || "无摘要"}`)
  })

  return lines.join("\n")
}

async function buildSearchContextForMessages(chatMessages) {
  const lastUserMessage = getLastUserMessage(chatMessages)

  if (!lastUserMessage || !shouldUseSearchTool(lastUserMessage)) {
    return ""
  }

  try {
    const searchData = await searchWeb(lastUserMessage)
    return buildSearchContext(searchData)
  } catch (error) {
    console.error("Search tool failed:", error)

    return [
      "用户正在询问最新、实时或需要联网搜索的信息，但后端搜索工具查询失败。",
      "请用中文友好说明暂时无法获取实时资料，并建议用户稍后再试。"
    ].join("\n")
  }
}

function getSavedMessages() {
  return database
    .prepare(`
      SELECT
        id,
        role,
        content,
        created_at AS createdAt
      FROM messages
      ORDER BY id ASC
    `)
    .all()
}

function saveMessage(role, content) {
  const trimmedContent = typeof content === "string" ? content.trim() : ""

  if (!["user", "assistant"].includes(role) || !trimmedContent) {
    return null
  }

  const result = database
    .prepare("INSERT INTO messages (role, content) VALUES (?, ?)")
    .run(role, trimmedContent)

  return database
    .prepare(`
      SELECT
        id,
        role,
        content,
        created_at AS createdAt
      FROM messages
      WHERE id = ?
    `)
    .get(result.lastInsertRowid)
}

function clearSavedMessages() {
  database.exec("DELETE FROM messages")
}

// 解析前端发来的 JSON 请求体。
app.use(express.json())
// 直接把 1 目录作为静态资源目录，这样浏览器可以访问 index.html。
app.use(express.static(__dirname))

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"))
})

app.get("/api/status", (req, res) => {
  res.json({
    ok: true,
    model: deepSeekModel,
    systemPrompt: systemPrompt,
    weatherTool: {
      enabled: true,
      defaultCity: defaultWeatherCity
    },
    searchTool: {
      enabled: searchToolEnabled,
      configured: Boolean(tavilyApiKey)
    },
    apiKeyConfigured: Boolean(deepSeekApiKey),
    currentTime: getCurrentTimeText()
  })
})

app.get("/api/messages", (req, res) => {
  res.json(getSavedMessages())
})

app.post("/api/messages", (req, res) => {
  const savedMessage = saveMessage(req.body.role, req.body.content)

  if (!savedMessage) {
    return res.status(400).json({
      error: "只能保存 role 为 user 或 assistant，且 content 不能为空的消息"
    })
  }

  res.status(201).json(savedMessage)
})

app.delete("/api/messages", (req, res) => {
  clearSavedMessages()
  res.json({
    ok: true
  })
})

app.post("/api/chat", async (req, res) => {
  // 多轮对话时，前端会传 messages；旧版单轮对话仍然可以传 message。
  const chatMessages = normalizeChatMessages(req.body)
  const deepSeekAbortController = new AbortController()
  let clientClosed = false

  res.on("close", () => {
    if (res.writableEnded) {
      return
    }

    // 用户点击“停止”或关闭页面时，浏览器会断开这个请求。
    // 这里同步中断 DeepSeek 请求，避免后端还在继续消耗时间和额度。
    clientClosed = true
    deepSeekAbortController.abort()
  })

  if (chatMessages.length === 0) {
    return res.status(400).send("messages 不能为空")
  }

  if (!deepSeekApiKey) {
    return res.status(500).send("后端没有配置 DEEPSEEK_API_KEY，请先在 .env 文件里配置 DeepSeek API Key")
  }

  try {
    const currentTimeText = getCurrentTimeText()
    const deepSeekMessages = await buildDeepSeekMessages(chatMessages, currentTimeText)

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
        messages: deepSeekMessages,
        stream: true
      }),
      signal: AbortSignal.any([
        deepSeekAbortController.signal,
        AbortSignal.timeout(requestTimeoutMs)
      ])
    })

    if (clientClosed) {
      return
    }

    if (!response.ok) {
      const errorText = await response.text()
      console.error("DeepSeek API error:", errorText)

      return res.status(response.status).send(getDeepSeekErrorMessage(response.status, errorText))
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
      if (clientClosed) {
        break
      }

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
          if (!clientClosed) {
            res.end()
          }
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
            if (!clientClosed) {
              res.write(chunk)
            }
          }
        } catch (error) {
          console.error("Failed to parse DeepSeek stream chunk:", error)
        }
      }
    }

    if (!clientClosed && !hasContent) {
      res.write("模型没有返回内容")
    }

    if (!clientClosed) {
      res.end()
    }
  } catch (error) {
    if (clientClosed) {
      return
    }

    console.error("DeepSeek request failed:", error)

    if (res.headersSent) {
      res.end()
      return
    }

    if (error.name === "AbortError" || error.name === "TimeoutError") {
      res.status(504).send("请求 DeepSeek 超时了，请稍后重试")
      return
    }

    res.status(500).send("请求 DeepSeek 时出错了，请查看后端控制台日志")
  }
})

function startServer(port) {
  const server = app.listen(port)

  server.once("listening", () => {
    console.log(`Server is running at http://localhost:${port}`)
    console.log(`DeepSeek model: ${deepSeekModel}`)
    console.log(`DeepSeek API Key: ${getApiKeyStatusText()}`)
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
