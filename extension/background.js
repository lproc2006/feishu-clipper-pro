const CLIPPED_PAGES_KEY = "clippedPagesV1";
const BADGE_COLOR = "#00B578";
const TRACKING_PARAMETERS = new Set([
  "fbclid",
  "gclid",
  "mc_cid",
  "mc_eid",
  "spm"
]);

function normalizedPageUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!/^https?:$/.test(url.protocol)) return "";
    url.hash = "";
    for (const name of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(name) || TRACKING_PARAMETERS.has(name.toLowerCase())) {
        url.searchParams.delete(name);
      }
    }
    url.searchParams.sort();
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.href;
  } catch (_err) {
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
  await updateBadge(tabId, key);
}

async function refreshAllBadges() {
  const tabs = await chrome.tabs.query({});
  await Promise.all(
    tabs
      .filter((tab) => tab.id)
      .map((tab) => updateBadge(tab.id, tab.url || ""))
  );
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "FEISHU_CLIP_MARKED") return false;
  markPageClipped(message.tabId, message.url)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.status === "complete") {
    updateBadge(tabId, changeInfo.url || tab.url || "").catch(() => {});
  }
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  chrome.tabs.get(tabId).then((tab) => updateBadge(tabId, tab.url || "")).catch(() => {});
});

chrome.runtime.onInstalled.addListener(() => refreshAllBadges().catch(() => {}));
chrome.runtime.onStartup.addListener(() => refreshAllBadges().catch(() => {}));
