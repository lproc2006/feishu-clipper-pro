const SERVER = "http://127.0.0.1:8787";
const BUILD_VERSION = "1.0.6";

if (chrome.runtime.getManifest().version !== BUILD_VERSION) {
  chrome.runtime.reload();
}

const statusEl = document.getElementById("status");
const titleEl = document.getElementById("title");
const urlEl = document.getElementById("url");
const resultEl = document.getElementById("result");
const errorEl = document.getElementById("error");

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

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function extractPage(tab) {
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: "FEISHU_FULL_CLIP_EXTRACT_V5" });
    if (response?.error) throw new Error(response.error);
    return response;
  } catch (_err) {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["vendor/Readability.js", "content.js"]
    });
    const response = await chrome.tabs.sendMessage(tab.id, { type: "FEISHU_FULL_CLIP_EXTRACT_V5" });
    if (response?.error) throw new Error(response.error);
    return response;
  }
}

async function markClipped(tab, url) {
  await chrome.runtime.sendMessage({
    type: "FEISHU_CLIP_MARKED",
    tabId: tab.id,
    url
  });
}

async function clipCurrentPage() {
  clearOutput();
  setStatus("正在剪存...");

  try {
    const tab = await getActiveTab();
    const payload = await extractPage(tab);
    titleEl.textContent = payload.title || tab.title || "未命名网页";
    urlEl.textContent = payload.url || tab.url || "";

    const response = await fetch(`${SERVER}/clip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `本机服务返回异常：${response.status}`);
    }

    await markClipped(tab, payload.url || tab.url).catch(() => {});
    resultEl.hidden = false;
    resultEl.innerHTML = [
      "已剪存完毕。",
      data.docUrl ? `<br><a href="${data.docUrl}" target="_blank">打开飞书云文档</a>` : "",
      data.baseUrl ? `<br><a href="${data.baseUrl}" target="_blank">打开网页剪存库</a>` : "",
      data.publishedAt ? `<br>发布时间：${data.publishedAt}` : "",
      data.imageCount ? `<br>图片：${data.imageCount} 张` : "",
      data.tags?.length ? `<br>标签：${data.tags.join("、")}` : ""
    ].join("");
    setStatus("已剪存完毕");
  } catch (err) {
    showError(
      [
        "剪存失败。",
        "请确认已按项目安装说明完成本机配套服务和飞书授权。",
        "本机服务状态：http://127.0.0.1:8787/health",
        "",
        err.message
      ].join("\n")
    );
    setStatus("剪存失败");
  }
}

clipCurrentPage();
