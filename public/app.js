const state = {
  messages: []
};

const els = {
  healthText: document.querySelector("#healthText"),
  llmBadge: document.querySelector("#llmBadge"),
  documentForm: document.querySelector("#documentForm"),
  docTitle: document.querySelector("#docTitle"),
  docContent: document.querySelector("#docContent"),
  kbStats: document.querySelector("#kbStats"),
  documentList: document.querySelector("#documentList"),
  chatForm: document.querySelector("#chatForm"),
  chatInput: document.querySelector("#chatInput"),
  messages: document.querySelector("#messages"),
  contextBar: document.querySelector("#contextBar"),
  useTools: document.querySelector("#useTools")
};

boot();

async function boot() {
  bindEvents();
  await Promise.all([loadHealth(), loadKnowledgeBase()]);
  addMessage("assistant", "请先添加知识库文档，然后输入问题。我会用本地向量检索结果作为上下文进行流式回答。");
}

function bindEvents() {
  els.documentForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = els.docTitle.value.trim();
    const content = els.docContent.value.trim();
    if (!content) return;

    await api("/api/kb/documents", {
      method: "POST",
      body: { title, content }
    });
    els.docTitle.value = "";
    els.docContent.value = "";
    await loadKnowledgeBase();
  });

  els.chatForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const question = els.chatInput.value.trim();
    if (!question) return;
    els.chatInput.value = "";
    await ask(question);
  });

  els.chatInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      els.chatForm.requestSubmit();
    }
  });
}

async function loadHealth() {
  const data = await api("/api/health");
  console.log(data);

  els.healthText.textContent = data.llmConfigured
    ? `已连接模型：${data.model}`
    : "未配置 LLM，当前使用本地检索降级回答";
  els.llmBadge.textContent = data.llmConfigured ? "已配置" : "未配置";
  els.llmBadge.classList.toggle("ready", data.llmConfigured);
}

async function loadKnowledgeBase() {
  const data = await api("/api/kb");
  els.kbStats.textContent = `${data.documentCount} 文档 / ${data.chunkCount} 分片`;
  els.documentList.innerHTML = "";

  if (!data.documents.length) {
    els.documentList.innerHTML = `<div class="empty">暂无文档</div>`;
    return;
  }

  for (const doc of data.documents) {
    const card = document.createElement("article");
    card.className = "document-card";
    card.innerHTML = `
      <strong></strong>
      <div class="meta">${doc.chunkCount} 分片 · ${formatDate(doc.createdAt)}</div>
      <button class="danger" type="button">删除</button>
    `;
    card.querySelector("strong").textContent = doc.title;
    card.querySelector("button").addEventListener("click", async () => {
      await api(`/api/kb/documents/${encodeURIComponent(doc.id)}`, { method: "DELETE" });
      await loadKnowledgeBase();
    });
    els.documentList.appendChild(card);
  }
}

async function ask(question) {
  addMessage("user", question);
  state.messages.push({ role: "user", content: question });

  const assistantNode = addMessage("assistant", "");
  const response = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: state.messages,
      topK: 5,
      useTools: els.useTools.checked
    })
  });

  if (!response.ok || !response.body) {
    assistantNode.textContent = `请求失败：${response.status}`;
    return;
  }

  let answer = "";
  await readEventStream(response.body, {
    meta(data) {
      renderContexts(data.contexts || []);
    },
    token(data) {
      answer += data.text || "";
      assistantNode.textContent = answer;
      scrollMessages();
    },
    tool(data) {
      const count = Array.isArray(data.result) ? data.result.length : 0;
      addMessage("tool", `Function call: ${data.name}(${JSON.stringify(data.arguments)})\n返回 ${count} 条检索结果`);
    },
    error(data) {
      assistantNode.textContent += `\n\n错误：${data.message}`;
    }
  });

  state.messages.push({ role: "assistant", content: answer });
}

async function readEventStream(body, handlers) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() || "";

    for (const raw of events) {
      const lines = raw.split("\n");
      const eventLine = lines.find((line) => line.startsWith("event:"));
      const dataLine = lines.find((line) => line.startsWith("data:"));
      if (!eventLine || !dataLine) continue;
      const name = eventLine.slice(6).trim();
      const data = JSON.parse(dataLine.slice(5).trim());
      handlers[name]?.(data);
    }
  }
}

function renderContexts(contexts) {
  if (!contexts.length) {
    els.contextBar.textContent = "未检索到相关知识库片段";
    return;
  }

  els.contextBar.textContent = contexts
    .map((item, index) => `[${index + 1}] ${item.title} · score ${item.score.toFixed(3)}`)
    .join("   ");
}

function addMessage(role, content) {
  const node = document.createElement("div");
  node.className = `message ${role}`;
  node.textContent = content;
  els.messages.appendChild(node);
  scrollMessages();
  return node;
}

function scrollMessages() {
  els.messages.scrollTop = els.messages.scrollHeight;
}

async function api(url, options = {}) {
  console.log("url ---->", url);

  const response = await fetch(url, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function formatDate(value) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}
