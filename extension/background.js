const SERVER = "http://127.0.0.1:8787";
const PREFERENCES_KEY = "clipperPreferencesV1";
const CLIPPED_PAGES_KEY = "clippedPagesV1";
const CLIP_TASKS_KEY = "clipTasksV1";
const BADGE_COLOR = "#00B578";
const TRACKING_PARAMETERS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid", "spm"]);
const activeTaskRunners = new Set();

function normalizedPageUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!/^https?:$/.test(url.protocol)) return "";
    url.hash = "";
    for (const name of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(name) || TRACKING_PARAMETERS.has(name.toLowerCase())) url.searchParams.delete(name);
    }
    url.searchParams.sort();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.href;
  } catch (_error) {
    return "";
  }
}

async function clippedPages() {
  const stored = await chrome.storage.local.get(CLIPPED_PAGES_KEY);
  return stored[CLIPPED_PAGES_KEY] || {};
}

async function updateBadge(tabId, rawUrl) {
  const key = normalizedPageUrl(rawUrl);
  const pages = key ? await clippedPages() : {};
  const clipped = Boolean(key && pages[key]);
  await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR });
  await chrome.action.setBadgeText({ tabId, text: clipped ? "✓" : "" });
  await chrome.action.setTitle({
    tabId,
    title: clipped ? "飞书剪存pro：此网页已剪存" : "飞书剪存pro"
  });
}

async function markPageClipped(tabId, rawUrl) {
  const key = normalizedPageUrl(rawUrl);
  if (!key) return;
  const pages = await clippedPages();
  pages[key] = Date.now();
  await chrome.storage.local.set({ [CLIPPED_PAGES_KEY]: pages });
  await updateBadge(tabId, key).catch(() => {});
}

async function refreshAllBadges() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.filter((tab) => tab.id).map((tab) => updateBadge(tab.id, tab.url || "")));
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

async function extractPage(tabId) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "FEISHU_FULL_CLIP_EXTRACT_V6" });
    if (response?.error) throw new Error(response.error);
    return response;
  } catch (_error) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["vendor/Readability.js", "content.js"]
      });
      const response = await chrome.tabs.sendMessage(tabId, { type: "FEISHU_FULL_CLIP_EXTRACT_V6" });
      if (response?.error) throw new Error(response.error);
      return response;
    } catch (error) {
      error.code = "PAGE_UNREADABLE";
      throw error;
    }
  }
}

async function requestJson(path, { method = "GET", payload, timeoutMs = 15_000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${SERVER}${path}`, {
      method,
      ...(payload ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) } : {}),
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
    if (error instanceof TypeError) error.code = "SERVICE_UNAVAILABLE";
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function taskStore() {
  const stored = await chrome.storage.local.get(CLIP_TASKS_KEY);
  return stored[CLIP_TASKS_KEY] || {};
}

async function saveTask(task) {
  task.updatedAt = Date.now();
  const tasks = await taskStore();
  tasks[task.id] = task;
  const recent = Object.values(tasks)
    .filter((item) => Date.now() - item.updatedAt < 24 * 60 * 60 * 1000)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 30);
  await chrome.storage.local.set({
    [CLIP_TASKS_KEY]: Object.fromEntries(recent.map((item) => [item.id, item]))
  });
}

function publicTask(task) {
  return {
    id: task.id,
    status: task.status,
    stage: task.stage,
    title: task.title,
    url: task.url,
    ...(task.result ? { result: task.result } : {}),
    ...(task.error ? { error: task.error } : {})
  };
}

function serializedError(error) {
  return {
    code: error.code || "SERVICE_ERROR",
    message: error.message || "剪存失败",
    hint: error.hint || ""
  };
}

async function updateTask(task, changes) {
  Object.assign(task, changes);
  await saveTask(task);
}

async function pollServerJob(task) {
  while (task.serverJobId) {
    const data = await requestJson(`/clip-jobs/${encodeURIComponent(task.serverJobId)}?wait=1`, {
      timeoutMs: 250_000
    });
    const serverJob = data.job;
    if (["queued", "running"].includes(serverJob.status)) continue;
    if (serverJob.status === "failed") {
      const error = new Error(serverJob.error?.message || "剪存失败");
      error.code = serverJob.error?.code || "SERVICE_ERROR";
      error.hint = serverJob.error?.hint || "";
      throw error;
    }
    await markPageClipped(task.tabId, task.url).catch(() => {});
    await updateTask(task, { status: "succeeded", stage: "complete", result: serverJob.result });
    return;
  }
}

async function runTask(task, forceCopy = Boolean(task.forceCopy)) {
  if (activeTaskRunners.has(task.id)) return;
  activeTaskRunners.add(task.id);
  try {
    if (task.serverJobId) {
      await pollServerJob(task);
      return;
    }
    const tab = await chrome.tabs.get(task.tabId);
    if (!tab?.id || normalizedPageUrl(tab.url) !== task.url) {
      const error = new Error("原网页已关闭或地址已经改变，无法继续读取正文");
      error.code = "PAGE_UNREADABLE";
      throw error;
    }
    const preferences = await getPreferences();
    if (!forceCopy && preferences.duplicateBehavior === "show_existing") {
      await updateTask(task, { status: "running", stage: "lookup" });
      try {
        const existing = await requestJson("/lookup", {
          method: "POST",
          payload: { url: task.url, preferences },
          timeoutMs: 8_000
        });
        if (existing.exists) {
          await markPageClipped(task.tabId, task.url).catch(() => {});
          await updateTask(task, { status: "duplicate", stage: "complete", result: existing });
          return;
        }
      } catch (_error) {
        // Duplicate lookup is advisory and must not block a new clip.
      }
    }

    await updateTask(task, { status: "running", stage: "extract" });
    const payload = await extractPage(task.tabId);
    payload.preferences = preferences;
    task.title = payload.title || task.title;
    task.url = normalizedPageUrl(payload.url || task.url) || task.url;
    await updateTask(task, { status: "running", stage: "submit" });
    const started = await requestJson("/clip-jobs", {
      method: "POST",
      payload: { jobId: task.id, payload },
      timeoutMs: 30_000
    });
    await updateTask(task, {
      status: "running",
      stage: "feishu",
      serverJobId: started.job.id
    });
    await pollServerJob(task);
  } catch (error) {
    await updateTask(task, { status: "failed", stage: "failed", error: serializedError(error) });
  } finally {
    activeTaskRunners.delete(task.id);
  }
}

async function beginTask(message) {
  const tab = await chrome.tabs.get(message.tabId);
  const url = normalizedPageUrl(message.url || tab.url || "");
  if (!tab?.id || !url) {
    const error = new Error("当前页面不允许扩展读取");
    error.code = "PAGE_UNREADABLE";
    throw error;
  }
  const tasks = await taskStore();
  const running = Object.values(tasks).find((task) => task.url === url && task.status === "running");
  if (running && !message.forceCopy) {
    runTask(running).catch(() => {});
    return publicTask(running);
  }
  const task = {
    id: crypto.randomUUID(),
    tabId: tab.id,
    url,
    title: message.title || tab.title || "未命名网页",
    status: "running",
    stage: "queued",
    serverJobId: "",
    result: null,
    error: null,
    forceCopy: Boolean(message.forceCopy),
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  await saveTask(task);
  runTask(task, Boolean(message.forceCopy)).catch(() => {});
  return publicTask(task);
}

async function getTask(id) {
  const tasks = await taskStore();
  const task = tasks[id];
  if (!task) return null;
  if (task.status === "running") runTask(task).catch(() => {});
  return publicTask(task);
}

async function resumeTasks() {
  const tasks = await taskStore();
  for (const task of Object.values(tasks)) {
    if (task.status === "running") runTask(task).catch(() => {});
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "FEISHU_CLIP_START") {
    beginTask(message)
      .then((task) => sendResponse({ ok: true, task }))
      .catch((error) => sendResponse({ ok: false, error: serializedError(error) }));
    return true;
  }
  if (message?.type === "FEISHU_CLIP_STATUS") {
    getTask(message.taskId)
      .then((task) => sendResponse(task ? { ok: true, task } : { ok: false, error: { code: "CLIP_JOB_NOT_FOUND", message: "剪存任务不存在" } }))
      .catch((error) => sendResponse({ ok: false, error: serializedError(error) }));
    return true;
  }
  return false;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") updateBadge(tabId, changeInfo.url || tab.url || "").catch(() => {});
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then((tab) => updateBadge(tabId, tab.url || "")).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => {
  refreshAllBadges().catch(() => {});
  resumeTasks().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => {
  refreshAllBadges().catch(() => {});
  resumeTasks().catch(() => {});
});
