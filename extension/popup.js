const SERVER = "http://127.0.0.1:8787";
const BUILD_VERSION = "1.1.5";
const PREFERENCES_KEY = "clipperPreferencesV1";

if (chrome.runtime.getManifest().version !== BUILD_VERSION) {
  chrome.runtime.reload();
}

const statusEl = document.getElementById("status");
const titleEl = document.getElementById("title");
const urlEl = document.getElementById("url");
const resultEl = document.getElementById("result");
const errorEl = document.getElementById("error");
const settingsEl = document.getElementById("settings");

function setStatus(message) {
  statusEl.textContent = message;
}

function showError(message) {
  errorEl.hidden = false;
  errorEl.textContent = message;
}

function clearOutput() {
  resultEl.hidden = true;
  resultEl.textContent = "";
  errorEl.hidden = true;
  errorEl.textContent = "";
}

function safeLink(value) {
  try {
    const url = new URL(String(value || ""));
    return /^https?:$/.test(url.protocol) ? url.href : "";
  } catch (_err) {
    return "";
  }
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function getPreferences() {
  const stored = await chrome.storage.sync.get(PREFERENCES_KEY);
  const value = stored[PREFERENCES_KEY] || {};
  const folderMode = value.folderMode === "existing" ? "existing" : "managed";
  return {
    folderMode,
    folderToken: folderMode === "existing" ? String(value.folderToken || "").trim() : "",
    folderName: folderMode === "existing" ? String(value.folderName || "已选文件夹").trim() : "飞书剪存",
    folderPath: folderMode === "existing"
      ? String(value.folderPath || value.folderName || "已选文件夹").trim()
      : "云盘根目录 / 飞书剪存",
    baseName: String(value.baseName || "网页剪存库").trim(),
    duplicateBehavior: value.duplicateBehavior === "save_copy" ? "save_copy" : "show_existing"
  };
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:\/\//i.test(tab.url || "")) {
    const error = new Error("当前页面不允许扩展读取");
    error.code = "PAGE_UNREADABLE";
    throw error;
  }
  return tab;
}

async function extractPage(tab) {
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "FEISHU_FULL_CLIP_EXTRACT_V6" });
    if (response?.error) throw new Error(response.error);
    return response;
  } catch (_err) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["vendor/Readability.js", "content.js"]
      });
      const response = await chrome.tabs.sendMessage(tab.id, { type: "FEISHU_FULL_CLIP_EXTRACT_V6" });
      if (response?.error) throw new Error(response.error);
      return response;
    } catch (error) {
      error.code = "PAGE_UNREADABLE";
      throw error;
    }
  }
}

async function markClipped(tab, url) {
  await chrome.runtime.sendMessage({
    type: "FEISHU_CLIP_MARKED",
    tabId: tab.id,
    url
  });
}

async function postJson(path, payload, timeoutMs = 12_000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${SERVER}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) {
      const error = new Error(data.error || `本机服务返回异常：${response.status}`);
      error.code = data.code || "SERVICE_ERROR";
      error.hint = data.hint || "";
      throw error;
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      const timeoutError = new Error("本机服务响应超时");
      timeoutError.code = "SERVICE_TIMEOUT";
      throw timeoutError;
    }
    if (error instanceof TypeError) {
      error.code = "SERVICE_UNAVAILABLE";
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function failureMessage(error) {
  const guidance = {
    PAGE_UNREADABLE: "页面无法读取。请在普通网页中使用，并等待正文加载完成。",
    ARTICLE_EMPTY: "正文识别失败。页面可能需要登录、滚动加载或尚未显示正文。",
    SERVICE_UNAVAILABLE: "本机配套服务未连接。请确认服务已启动。",
    SERVICE_TIMEOUT: "本机服务处理超时。请稍后重试，或检查 AI 模型和飞书网络。",
    FEISHU_AUTH_INVALID: "飞书授权已失效或权限不足。",
    DOC_WRITE_FAILED: "云文档创建或图片上传失败。",
    BASE_SCHEMA_FAILED: "多维表格字段配置异常。",
    BASE_WRITE_FAILED: "多维表格记录写入失败。",
    WORKSPACE_UNAVAILABLE: "保存位置不可用。请在设置中重新读取并选择飞书云盘文件夹。"
  };
  return [
    "剪存失败。",
    guidance[error.code] || error.message,
    error.hint || "",
    "",
    `详情：${error.message}`,
    `本机服务状态：${SERVER}/health`
  ].filter(Boolean).join("\n");
}

function renderSuccess(data) {
  const docUrl = safeLink(data.docUrl);
  const baseUrl = safeLink(data.baseUrl);
  resultEl.hidden = false;
  resultEl.innerHTML = [
    "已剪存完毕。",
    docUrl ? `<br><a href="${docUrl}" target="_blank">打开飞书云文档</a>` : "",
    baseUrl ? `<br><a href="${baseUrl}" target="_blank">打开网页剪存库</a>` : "",
    data.publishedAt ? `<br>发布时间：${escapeHtml(data.publishedAt)}` : "",
    data.imageCount ? `<br>图片：${Number(data.imageCount)} 张` : "",
    data.tags?.length ? `<br>标签：${escapeHtml(data.tags.join("、"))}` : "",
    data.warnings?.length ? `<br>提示：${escapeHtml(data.warnings.join("；"))}` : ""
  ].join("");
  setStatus("已剪存完毕");
}

async function savePage(tab, preferences) {
  setStatus("正在读取正文...");
  const payload = await extractPage(tab);
  payload.preferences = preferences;
  titleEl.textContent = payload.title || tab.title || "未命名网页";
  urlEl.textContent = payload.url || tab.url || "";
  setStatus("正在写入飞书...");
  const data = await postJson("/clip", payload, 180_000);
  await markClipped(tab, payload.url || tab.url).catch(() => {});
  renderSuccess(data);
}

function renderDuplicate(tab, existing, preferences) {
  const docUrl = safeLink(existing.docUrl);
  const baseUrl = safeLink(existing.baseUrl);
  resultEl.hidden = false;
  resultEl.innerHTML = [
    "此网页已剪存。",
    docUrl ? `<br><a href="${docUrl}" target="_blank">打开已有云文档</a>` : "",
    baseUrl ? `<br><a href="${baseUrl}" target="_blank">打开网页剪存库</a>` : "",
    '<br><button id="save-copy" type="button">仍然另存一份</button>'
  ].join("");
  document.getElementById("save-copy").addEventListener("click", async () => {
    clearOutput();
    try {
      await savePage(tab, preferences);
    } catch (error) {
      showError(failureMessage(error));
      setStatus("剪存失败");
    }
  });
  setStatus("已剪存过");
}

async function clipCurrentPage() {
  clearOutput();
  try {
    const tab = await getActiveTab();
    const preferences = await getPreferences();
    titleEl.textContent = tab.title || "未命名网页";
    urlEl.textContent = tab.url || "";

    if (preferences.duplicateBehavior === "show_existing") {
      setStatus("正在检查是否已剪存...");
      try {
        const existing = await postJson("/lookup", { url: tab.url, preferences }, 8_000);
        if (existing.exists) {
          await markClipped(tab, tab.url).catch(() => {});
          renderDuplicate(tab, existing, preferences);
          return;
        }
      } catch (_error) {
        // Cross-device lookup is helpful but must never block a new clip.
      }
    }
    await savePage(tab, preferences);
  } catch (error) {
    showError(failureMessage(error));
    setStatus("剪存失败");
  }
}

settingsEl.addEventListener("click", () => chrome.runtime.openOptionsPage());
clipCurrentPage();
