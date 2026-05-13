import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

loadDotEnv();

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const KB_FILE = path.join(DATA_DIR, "kb.json");
const PUBLIC_DIR = path.join(__dirname, "public");

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "is", "are", "for", "on", "with", "as", "by", "be",
  "this", "that", "it", "from", "at", "can", "will", "you", "your", "we", "our", "i",
  "的", "了", "和", "是", "在", "有", "与", "及", "或", "为", "对", "中", "可以", "一个"
]);

const tools = [
  {
    type: "function",
    function: {
      name: "search_knowledge_base",
      description: "Search the local vector knowledge base for passages relevant to the user's question.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query." },
          topK: { type: "number", description: "Maximum number of passages to return." }
        },
        required: ["query"]
      }
    }
  }
];

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, {
        ok: true,
        llmConfigured: hasLlmConfig(),
        model: process.env.LLM_MODEL || "gpt-4.1-mini"
      });
    }

    if (req.method === "GET" && url.pathname === "/api/kb") {
      const kb = await readKb();
      return sendJson(res, summarizeKb(kb));
    }

    if (req.method === "POST" && url.pathname === "/api/kb/documents") {
      const body = await readJson(req);
      const result = await addDocument(body);
      return sendJson(res, result, 201);
    }

    if (req.method === "DELETE" && url.pathname.startsWith("/api/kb/documents/")) {
      const id = decodeURIComponent(url.pathname.split("/").pop());
      const result = await deleteDocument(id);
      return sendJson(res, result);
    }

    if (req.method === "POST" && url.pathname === "/api/search") {
      const body = await readJson(req);
      const results = await searchKnowledgeBase(String(body.query || ""), Number(body.topK || 5));
      return sendJson(res, { results });
    }

    if (req.method === "POST" && url.pathname === "/api/chat") {
      const body = await readJson(req);
      return streamChat(res, body);
    }

    return serveStatic(req, res, url);
  } catch (error) {
    console.error(error);
    if (!res.headersSent) {
      sendJson(res, { error: error.message || "Internal server error" }, error.statusCode || 500);
    } else {
      res.end();
    }
  }
});

server.listen(PORT, () => {
  console.log(`RAG knowledge app running at http://localhost:${PORT}`);
});

async function addDocument(body) {
  const title = String(body.title || "").trim() || "Untitled";
  const content = String(body.content || "").trim();
  if (!content) throw httpError(400, "Document content is required.");

  const kb = await readKb();
  const docId = randomUUID();
  const chunks = chunkText(content).map((text, index) => {
    const tokens = tokenize(`${title}\n${text}`);
    return {
      id: randomUUID(),
      docId,
      title,
      text,
      index,
      tokenCount: tokens.length,
      vector: termFrequency(tokens)
    };
  });

  kb.documents.unshift({
    id: docId,
    title,
    content,
    chunkCount: chunks.length,
    createdAt: new Date().toISOString()
  });
  kb.chunks.push(...chunks);
  await writeKb(kb);

  return { document: kb.documents[0], chunks: chunks.length };
}

async function deleteDocument(id) {
  const kb = await readKb();
  const before = kb.documents.length;
  kb.documents = kb.documents.filter((doc) => doc.id !== id);
  kb.chunks = kb.chunks.filter((chunk) => chunk.docId !== id);
  await writeKb(kb);
  return { deleted: before !== kb.documents.length };
}

async function searchKnowledgeBase(query, topK = 5) {
  const normalizedTopK = Math.max(1, Math.min(12, Number.isFinite(topK) ? topK : 5));
  const queryVector = termFrequency(tokenize(query));
  const kb = await readKb();

  return kb.chunks
    .map((chunk) => ({
      id: chunk.id,
      docId: chunk.docId,
      title: chunk.title,
      text: chunk.text,
      score: cosineSimilarity(queryVector, chunk.vector)
    }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, normalizedTopK);
}

async function streamChat(res, body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const latestUser = [...messages].reverse().find((msg) => msg.role === "user")?.content || "";
  const topK = Number(body.topK || 5);
  const contexts = await searchKnowledgeBase(latestUser, topK);
  const useTools = body.useTools !== false;

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });

  sendEvent(res, "meta", {
    llmConfigured: hasLlmConfig(),
    contexts,
    tools: useTools ? tools : []
  });

  if (!hasLlmConfig()) {
    const fallback = buildFallbackAnswer(latestUser, contexts);
    await writeTextStream(res, fallback);
    sendEvent(res, "done", {});
    return res.end();
  }

  try {
    await streamLlmAnswer(res, messages, contexts, useTools);
    sendEvent(res, "done", {});
  } catch (error) {
    sendEvent(res, "error", { message: error.message || "LLM request failed." });
  } finally {
    res.end();
  }
}

async function streamLlmAnswer(res, messages, contexts, useTools) {
  const system = [
    "You are a RAG assistant for a local knowledge base.",
    "Answer in the user's language.",
    "Use the provided knowledge base context first. If context is insufficient, say what is missing.",
    "Cite sources inline as [1], [2] using the context numbers.",
    useTools ? "You can call search_knowledge_base when you need another retrieval pass." : ""
  ].filter(Boolean).join("\n");

  const contextText = contexts.length
    ? contexts.map((item, index) => `[${index + 1}] ${item.title}\n${item.text}`).join("\n\n")
    : "No relevant local context was found.";

  const llmMessages = [
    { role: "system", content: system },
    { role: "system", content: `Knowledge base context:\n${contextText}` },
    ...messages.slice(-12).map((msg) => ({
      role: ["system", "user", "assistant", "tool"].includes(msg.role) ? msg.role : "user",
      content: String(msg.content || "")
    }))
  ];

  const payload = {
    model: process.env.LLM_MODEL || "gpt-4.1-mini",
    stream: true,
    messages: llmMessages
  };

  if (useTools) {
    payload.tools = tools;
    payload.tool_choice = "auto";
  }

  const firstPass = await requestLlmStream(payload, res);

  if (firstPass.toolCalls.size > 0) {
    const assistantToolCalls = [];
    const toolMessages = [];

    for (const call of firstPass.toolCalls.values()) {
      if (call.name !== "search_knowledge_base") continue;
      const args = safeJsonParse(call.arguments, {});
      const results = await searchKnowledgeBase(String(args.query || ""), Number(args.topK || 5));
      const toolCallId = call.id || randomUUID();

      assistantToolCalls.push({
        id: toolCallId,
        type: "function",
        function: {
          name: call.name,
          arguments: call.arguments || "{}"
        }
      });
      toolMessages.push({
        role: "tool",
        tool_call_id: toolCallId,
        content: JSON.stringify(results)
      });

      sendEvent(res, "tool", {
        name: call.name,
        arguments: args,
        result: results
      });
    }

    if (toolMessages.length) {
      await requestLlmStream({
        model: process.env.LLM_MODEL || "gpt-4.1-mini",
        stream: true,
        messages: [
          ...llmMessages,
          {
            role: "assistant",
            content: firstPass.content || null,
            tool_calls: assistantToolCalls
          },
          ...toolMessages
        ]
      }, res);
    }
  }
}

async function requestLlmStream(payload, res) {
  const response = await fetch(`${getBaseUrl()}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(`LLM HTTP ${response.status}: ${text.slice(0, 400)}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  const toolCalls = new Map();

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") continue;

      const parsed = JSON.parse(data);
      const delta = parsed.choices?.[0]?.delta || {};
      if (delta.content) {
        content += delta.content;
        sendEvent(res, "token", { text: delta.content });
      }
      if (delta.tool_calls) collectToolCalls(toolCalls, delta.tool_calls);
    }
  }

  return { content, toolCalls };
}

function collectToolCalls(buffer, deltas) {
  for (const delta of deltas) {
    const key = delta.index ?? delta.id ?? buffer.size;
    const current = buffer.get(key) || { id: delta.id, name: "", arguments: "" };
    current.id = delta.id || current.id;
    current.name += delta.function?.name || "";
    current.arguments += delta.function?.arguments || "";
    buffer.set(key, current);
  }
}

function buildFallbackAnswer(question, contexts) {
  if (!contexts.length) {
    return [
      "当前没有检索到相关知识库内容。",
      "",
      "你可以先在左侧添加文档，或配置 `.env` 中的 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `LLM_MODEL` 来启用真实 LLM 流式回答。",
      "",
      `问题：${question || "未提供"}`
    ].join("\n");
  }

  const bullets = contexts
    .slice(0, 5)
    .map((item, index) => `[${index + 1}] ${item.title}：${item.text}`);
  return [
    "未配置 LLM，因此先返回本地向量检索结果：",
    "",
    ...bullets,
    "",
    "配置 `.env` 后，此接口会把这些片段作为上下文传给 LLM，并以 SSE 方式流式返回答案。"
  ].join("\n");
}

async function writeTextStream(res, text) {
  const pieces = text.match(/.{1,16}/gs) || [];
  for (const piece of pieces) {
    sendEvent(res, "token", { text: piece });
    await sleep(18);
  }
}

function chunkText(text) {
  const cleaned = text.replace(/\r\n/g, "\n").replace(/[ \t]+/g, " ").trim();
  const paragraphs = cleaned.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chunks = [];
  let current = "";
  const max = 900;

  for (const paragraph of paragraphs.length ? paragraphs : [cleaned]) {
    if ((current + "\n\n" + paragraph).trim().length <= max) {
      current = (current ? `${current}\n\n` : "") + paragraph;
      continue;
    }
    if (current) chunks.push(current);
    if (paragraph.length <= max) {
      current = paragraph;
    } else {
      for (let i = 0; i < paragraph.length; i += max) {
        chunks.push(paragraph.slice(i, i + max));
      }
      current = "";
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function tokenize(text) {
  const normalized = String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ");

  const words = normalized.match(/[\p{Script=Han}]{1,2}|[\p{L}\p{N}]+/gu) || [];
  return words.filter((word) => word.length > 1 && !STOP_WORDS.has(word));
}

function termFrequency(tokens) {
  const vector = {};
  for (const token of tokens) vector[token] = (vector[token] || 0) + 1;
  const total = tokens.length || 1;
  for (const token of Object.keys(vector)) vector[token] = vector[token] / total;
  return vector;
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const value of Object.values(a)) normA += value * value;
  for (const value of Object.values(b)) normB += value * value;
  for (const [key, value] of Object.entries(a)) {
    if (b[key]) dot += value * b[key];
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

async function readKb() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(KB_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      documents: Array.isArray(parsed.documents) ? parsed.documents : [],
      chunks: Array.isArray(parsed.chunks) ? parsed.chunks : []
    };
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { documents: [], chunks: [] };
  }
}

async function writeKb(kb) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(KB_FILE, JSON.stringify(kb, null, 2), "utf8");
}

function summarizeKb(kb) {
  return {
    documentCount: kb.documents.length,
    chunkCount: kb.chunks.length,
    documents: kb.documents.map(({ content, ...doc }) => doc)
  };
}

async function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.normalize(path.join(PUBLIC_DIR, pathname));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendJson(res, { error: "Forbidden" }, 403);
  }

  try {
    const file = await fs.readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream"
    });
    res.end(file);
  } catch (error) {
    if (error.code === "ENOENT") {
      const fallback = await fs.readFile(path.join(PUBLIC_DIR, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(fallback);
      return;
    }
    throw error;
  }
}

async function readJson(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw httpError(400, "Invalid JSON body.");
  }
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendEvent(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function hasLlmConfig() {
  return Boolean(process.env.OPENAI_API_KEY && process.env.OPENAI_BASE_URL);
}

function getBaseUrl() {
  return (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fsSync.existsSync(envPath)) return;
  const raw = fsSync.readFileSync(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const index = trimmed.indexOf("=");
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}
