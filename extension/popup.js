const SERVER = "http://127.0.0.1:8787";
const BUILD_VERSION = "1.0.4";

if (chrome.runtime.getManifest().version !== BUILD_VERSION) {
  chrome.runtime.reload();
}

const statusEl = document.getElementById("status");
const titleEl = document.getElementById("title");
const urlEl = document.getElementById("url");
const clipButton = document.getElementById("clip");
const resultEl = document.getElementById("result");
const errorEl = document.getElementById("error");

let currentPayload = null;

function setBusy(isBusy, message) {
  clipButton.disabled = isBusy;
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

async function initialize() {
  clearOutput();
  const tab = await getActiveTab();
  currentPayload = await extractPage(tab);
  titleEl.textContent = currentPayload.title || tab.title || "未命名网页";
  urlEl.textContent = currentPayload.url || tab.url || "";
}

clipButton.addEventListener("click", async () => {
  clearOutput();
  setBusy(true, "正在完整剪存...");

  try {
    const tab = await getActiveTab();
    currentPayload = await extractPage(tab);

    const response = await fetch(`${SERVER}/clip`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(currentPayload)
    });

    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error(data.error || `本机服务返回异常：${response.status}`);
    }

    resultEl.hidden = false;
    resultEl.innerHTML = [
      "已保存。",
      data.docUrl ? `<br><a href="${data.docUrl}" target="_blank">打开飞书云文档</a>` : "",
      data.baseUrl ? `<br><a href="${data.baseUrl}" target="_blank">打开网页剪存库</a>` : "",
      data.publishedAt ? `<br>发布时间：${data.publishedAt}` : "",
      data.imageCount ? `<br>图片：${data.imageCount} 张` : "",
      data.tags?.length ? `<br>标签：${data.tags.join("、")}` : ""
    ].join("");
    setBusy(false, "剪存完成");
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
    setBusy(false, "剪存失败");
  }
});

initialize().catch((err) => {
  showError(err.message);
  setBusy(false, "读取网页失败");
});
