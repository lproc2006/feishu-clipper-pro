const PREFERENCES_KEY = "clipperPreferencesV1";
const SERVER = "http://127.0.0.1:8787";
const form = document.getElementById("settings-form");
const baseName = document.getElementById("base-name");
const saveStatus = document.getElementById("save-status");
const connectionStatus = document.getElementById("connection-status");
const refreshFolders = document.getElementById("refresh-folders");
const chooseFolder = document.getElementById("choose-folder");
const closeFolderBrowser = document.getElementById("close-folder-browser");
const folderBrowser = document.getElementById("folder-browser");
const selectedFolderPath = document.getElementById("selected-folder-path");
const useDefaultFolder = document.getElementById("use-default-folder");
const useCurrentFolder = document.getElementById("use-current-folder");
const folderBreadcrumb = document.getElementById("folder-breadcrumb");
const folderList = document.getElementById("folder-list");
const folderLevelStatus = document.getElementById("folder-level-status");

let currentPreferences = {};
let selectedFolder = null;
let navigation = [{ token: "", name: "云盘根目录", path: "云盘根目录" }];
let folderBrowserOpen = false;

function validName(value) {
  const name = String(value || "").trim();
  return name.length > 0 && name.length <= 50 && !/[\\/:*?"<>|]/.test(name);
}

function managedSelection() {
  return {
    mode: "managed",
    token: "",
    name: "飞书剪存",
    path: "云盘根目录 / 飞书剪存"
  };
}

function preferenceSelection(value) {
  if (value.folderMode === "existing" && value.folderToken) {
    return {
      mode: "existing",
      token: String(value.folderToken),
      name: String(value.folderName || "已选文件夹"),
      path: String(value.folderPath || value.folderName || "已选文件夹")
    };
  }
  return managedSelection();
}

function renderSelectedFolder() {
  selectedFolderPath.textContent = selectedFolder.path;
  useDefaultFolder.hidden = selectedFolder.mode !== "existing";
}

function setFolderBrowserOpen(open) {
  folderBrowserOpen = open;
  folderBrowser.hidden = !open;
  chooseFolder.setAttribute("aria-expanded", String(open));
}

function renderBreadcrumb() {
  folderBreadcrumb.replaceChildren();
  navigation.forEach((folder, index) => {
    if (index > 0) {
      const separator = document.createElement("span");
      separator.className = "breadcrumb-separator";
      separator.textContent = ">";
      separator.setAttribute("aria-hidden", "true");
      folderBreadcrumb.append(separator);
    }
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = folder.name;
    button.disabled = index === navigation.length - 1;
    button.addEventListener("click", async () => {
      navigation = navigation.slice(0, index + 1);
      await loadCurrentLevel(false);
    });
    folderBreadcrumb.append(button);
  });
}

function renderFolderList(folders) {
  folderList.replaceChildren();
  if (!folders.length) {
    const empty = document.createElement("p");
    empty.className = "folder-empty";
    empty.textContent = "此文件夹没有下一级文件夹";
    folderList.append(empty);
    return;
  }
  for (const folder of folders) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "folder-row";
    row.setAttribute("role", "listitem");
    const name = document.createElement("span");
    name.textContent = folder.name;
    const chevron = document.createElement("span");
    chevron.className = "folder-chevron";
    chevron.textContent = ">";
    chevron.setAttribute("aria-hidden", "true");
    row.append(name, chevron);
    row.addEventListener("click", async () => {
      const parent = navigation[navigation.length - 1];
      navigation.push({
        token: folder.token,
        name: folder.name,
        path: `${parent.path} / ${folder.name}`
      });
      await loadCurrentLevel(false);
    });
    folderList.append(row);
  }
}

async function loadCurrentLevel(refresh) {
  if (!folderBrowserOpen) return;
  const current = navigation[navigation.length - 1];
  renderBreadcrumb();
  folderList.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "folder-empty";
  loading.textContent = "正在读取当前层级...";
  folderList.append(loading);
  useCurrentFolder.disabled = !current.token;
  refreshFolders.disabled = true;
  connectionStatus.classList.remove("error");
  connectionStatus.textContent = "正在读取当前飞书账号...";

  const params = new URLSearchParams();
  if (current.token) params.set("parent_token", current.token);
  if (refresh) params.set("refresh", "1");
  try {
    const response = await fetch(`${SERVER}/folders${params.size ? `?${params}` : ""}`);
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.hint || result.error || "读取失败");
    const folders = result.folders || [];
    renderFolderList(folders);
    connectionStatus.textContent = "已连接飞书";
    folderLevelStatus.textContent = `当前层级 ${folders.length} 个文件夹`;
  } catch (error) {
    renderFolderList([]);
    connectionStatus.classList.add("error");
    connectionStatus.textContent = `未能读取云盘：${error.message}`;
    folderLevelStatus.textContent = "";
  } finally {
    refreshFolders.disabled = false;
  }
}

async function loadSettings() {
  const stored = await chrome.storage.sync.get(PREFERENCES_KEY);
  currentPreferences = stored[PREFERENCES_KEY] || {};
  selectedFolder = preferenceSelection(currentPreferences);
  renderSelectedFolder();
  baseName.value = currentPreferences.baseName || "网页剪存库";
  form.elements.duplicateBehavior.value =
    currentPreferences.duplicateBehavior === "save_copy" ? "save_copy" : "show_existing";
  setFolderBrowserOpen(false);
  connectionStatus.textContent = "尚未读取云盘";
}

chooseFolder.addEventListener("click", async () => {
  navigation = [{ token: "", name: "云盘根目录", path: "云盘根目录" }];
  setFolderBrowserOpen(true);
  await loadCurrentLevel(false);
});

closeFolderBrowser.addEventListener("click", () => {
  setFolderBrowserOpen(false);
});

useCurrentFolder.addEventListener("click", () => {
  const current = navigation[navigation.length - 1];
  if (!current.token) return;
  selectedFolder = {
    mode: "existing",
    token: current.token,
    name: current.name,
    path: current.path
  };
  renderSelectedFolder();
  setFolderBrowserOpen(false);
  saveStatus.textContent = "已选择，保存设置后生效";
});

useDefaultFolder.addEventListener("click", () => {
  selectedFolder = managedSelection();
  renderSelectedFolder();
  setFolderBrowserOpen(false);
  saveStatus.textContent = "将使用云盘根目录 / 飞书剪存，保存设置后生效";
});

refreshFolders.addEventListener("click", async () => {
  await loadCurrentLevel(true);
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!validName(baseName.value)) {
    saveStatus.textContent = "名称不能包含路径符号";
    return;
  }
  await chrome.storage.sync.set({
    [PREFERENCES_KEY]: {
      folderMode: selectedFolder.mode,
      folderToken: selectedFolder.token,
      folderName: selectedFolder.name,
      folderPath: selectedFolder.path,
      baseName: baseName.value.trim(),
      duplicateBehavior: form.elements.duplicateBehavior.value
    }
  });
  currentPreferences = {
    ...currentPreferences,
    folderMode: selectedFolder.mode,
    folderToken: selectedFolder.token,
    folderName: selectedFolder.name,
    folderPath: selectedFolder.path
  };
  saveStatus.textContent = "已保存";
  setTimeout(() => { saveStatus.textContent = ""; }, 1800);
});

loadSettings();
