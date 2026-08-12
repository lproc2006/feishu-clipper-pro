const SERVER = "http://127.0.0.1:8787";
const BUILD_VERSION = "1.1.6";

if (chrome.runtime.getManifest().version !== BUILD_VERSION) chrome.runtime.reload();

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
  } catch (_error) {
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

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !/^https?:\/\//i.test(tab.url || "")) {
    const error = new Error("当前页面不允许扩展读取");
    error.code = "PAGE_UNREADABLE";
    throw error;
  }
  return tab;
}

function failureMessage(error) {
  const guidance = {
    PAGE_UNREADABLE: "页面无法读取。原网页可能已关闭、跳转，或属于浏览器保护页面。",
    ARTICLE_EMPTY: "正文识别失败。页面可能需要登录、滚动加载或尚未显示正文。",
    SERVICE_UNAVAILABLE: "本机配套服务未连接。请确认服务已启动。",
    SERVICE_TIMEOUT: "本机服务处理超时。任务会保留，可重新点击图标查看进度。",
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

async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response?.ok) {
    const error = new Error(response?.error?.message || "扩展后台任务异常");
    error.code = response?.error?.code || "SERVICE_ERROR";
    error.hint = response?.error?.hint || "";
    throw error;
  }
  return response.task;
}

function stageMessage(stage) {
  return {
    queued: "正在准备剪存...",
    lookup: "正在检查是否已剪存...",
    extract: "正在读取正文...",
    submit: "正在提交后台任务...",
    feishu: "正在写入飞书，可放心切换标签页..."
  }[stage] || "正在后台剪存...";
}

function renderDuplicate(tab, task) {
  const existing = task.result || {};
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
      const next = await sendMessage({
        type: "FEISHU_CLIP_START",
        tabId: tab.id,
        url: tab.url,
        title: tab.title,
        forceCopy: true
      });
      await watchTask(tab, next);
    } catch (error) {
      showError(failureMessage(error));
      setStatus("剪存失败");
    }
  });
  setStatus("已剪存过");
}

async function watchTask(tab, initialTask) {
  let task = initialTask;
  while (task.status === "running") {
    titleEl.textContent = task.title || tab.title || "未命名网页";
    urlEl.textContent = task.url || tab.url || "";
    setStatus(stageMessage(task.stage));
    await new Promise((resolve) => setTimeout(resolve, 650));
    task = await sendMessage({ type: "FEISHU_CLIP_STATUS", taskId: task.id });
  }
  if (task.status === "succeeded") {
    renderSuccess(task.result || {});
    return;
  }
  if (task.status === "duplicate") {
    renderDuplicate(tab, task);
    return;
  }
  const error = new Error(task.error?.message || "剪存失败");
  error.code = task.error?.code || "SERVICE_ERROR";
  error.hint = task.error?.hint || "";
  throw error;
}

async function clipCurrentPage() {
  clearOutput();
  try {
    const tab = await getActiveTab();
    titleEl.textContent = tab.title || "未命名网页";
    urlEl.textContent = tab.url || "";
    const task = await sendMessage({
      type: "FEISHU_CLIP_START",
      tabId: tab.id,
      url: tab.url,
      title: tab.title
    });
    await watchTask(tab, task);
  } catch (error) {
    showError(failureMessage(error));
    setStatus("剪存失败");
  }
}

settingsEl.addEventListener("click", () => chrome.runtime.openOptionsPage());
clipCurrentPage();
