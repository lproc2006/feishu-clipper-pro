import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { URL } from "node:url";

const PORT = Number(process.env.FEISHU_CLIPPER_PORT || 8787);
const HOST = "127.0.0.1";
const FOLDER_NAME = process.env.FEISHU_CLIPPER_FOLDER || "飞书剪存";
const BASE_NAME = process.env.FEISHU_CLIPPER_BASE || "网页剪存库";
const TABLE_NAME = process.env.FEISHU_CLIPPER_TABLE || "剪存记录";
const TIME_ZONE = "Asia/Shanghai";
const SYNC_CONFIRMATIONS = 1;
const AI_TIMEOUT_MS = Math.max(5_000, Number(process.env.FEISHU_CLIPPER_AI_TIMEOUT_MS || 45_000));
const OLLAMA_URL = String(process.env.FEISHU_CLIPPER_OLLAMA_URL || "http://127.0.0.1:11434").replace(/\/$/, "");
const AI_PROVIDER = String(process.env.FEISHU_CLIPPER_AI_PROVIDER || "ollama").toLowerCase();
const MIN_TAG_COUNT = 2;
const MAX_TAG_COUNT = 3;
const MAX_TAG_LENGTH = 5;
const MIN_SUMMARY_LENGTH = 100;
const MAX_SUMMARY_LENGTH = 200;
const BODY_PARAGRAPH_INDENT = "　　";
const FOLDER_CACHE_MS = 120_000;
const SYNC_INTERVAL_MS = Math.max(
  10_000,
  Number(process.env.FEISHU_CLIPPER_SYNC_INTERVAL_MS || 15_000)
);
const DEFAULT_STATE_DIR = process.platform === "darwin"
  ? join(homedir(), "Library", "Application Support", "FeishuClipperPro")
  : process.platform === "win32"
    ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "FeishuClipperPro")
    : join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "feishu-clipper-pro");
const STATE_FILE =
  process.env.FEISHU_CLIPPER_STATE_FILE ||
  join(DEFAULT_STATE_DIR, "pairs.json");

const workspaceCache = new Map();
const workspacePromises = new Map();
let pairRegistry = null;
let registryQueue = Promise.resolve();
let tagOptionQueue = Promise.resolve();
let syncInFlight = null;
let ollamaModelCache = null;
const folderListCache = new Map();
const clipRecordCache = new Map();
const clipJobs = new Map();
const CLIP_JOB_RETENTION_MS = 24 * 60 * 60 * 1000;

class ClipError extends Error {
  constructor(code, message, { stage = "unknown", status = 500, hint = "", cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = "ClipError";
    this.code = code;
    this.stage = stage;
    this.status = status;
    this.hint = hint;
  }
}

function cleanResourceName(value, fallback) {
  const name = String(value || "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name) return fallback;
  if (name.length > 50 || /[\\/:*?"<>|]/.test(name)) {
    throw new ClipError("INVALID_PREFERENCES", "保存位置名称无效", {
      stage: "preferences",
      status: 400,
      hint: "文件夹和多维表格名称应为 1 至 50 个字符，且不含路径符号。"
    });
  }
  return name;
}

function normalizePreferences(value = {}) {
  const folderMode = value.folderMode === "existing" ? "existing" : "managed";
  const folderToken = String(value.folderToken || "").trim();
  if (folderMode === "existing" && !/^[A-Za-z0-9_-]{8,128}$/.test(folderToken)) {
    throw new ClipError("INVALID_PREFERENCES", "所选飞书云盘文件夹无效", {
      stage: "preferences",
      status: 400,
      hint: "请在插件设置中重新读取并选择一个现有文件夹。"
    });
  }
  const folderName = folderMode === "existing"
    ? cleanResourceName(value.folderName, "已选文件夹")
    : FOLDER_NAME;
  const rawPath = String(value.folderPath || "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return {
    folderMode,
    folderToken: folderMode === "existing" ? folderToken : "",
    folderName,
    folderPath: folderMode === "existing"
      ? (rawPath.slice(0, 500) || `云盘 / ${folderName}`)
      : `云盘根目录 / ${folderName}`,
    baseName: cleanResourceName(value.baseName, BASE_NAME)
  };
}

function workspaceKey(preferences) {
  return [
    preferences.folderMode,
    preferences.folderToken || preferences.folderName,
    preferences.baseName
  ].join("\u0000");
}

function runLark(args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("lark-cli", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      ...(options.cwd ? { cwd: options.cwd } : {})
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        const error = new Error(`lark-cli failed (${code}): ${stderr || stdout}`);
        error.exitCode = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      try {
        const output = stdout.trim();
        if (!output) {
          resolve({});
          return;
        }
        try {
          resolve(JSON.parse(output));
        } catch (_err) {
          const jsonStart = output.indexOf("{");
          resolve(JSON.parse(jsonStart >= 0 ? output.slice(jsonStart) : output));
        }
      } catch (err) {
        reject(new Error(`Cannot parse lark-cli JSON: ${err.message}\n${stdout}`));
      }
    });

    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

function larkFailurePayload(error) {
  for (const raw of [error?.stderr, error?.stdout]) {
    if (!raw?.trim()) continue;
    try {
      return JSON.parse(raw);
    } catch (_err) {
      // Fall through to the plain-text checks below.
    }
  }
  return null;
}

function isDeletedLarkFailure(error) {
  const payload = larkFailurePayload(error);
  const code = Number(payload?.error?.code);
  const message = payload?.error?.message || error?.message || "";
  return (
    [1061007, 3380003].includes(code) ||
    /(?:has been delete|page has been deleted|record.*not found|not found)/i.test(message)
  );
}

function emptyPairRegistry() {
  return { version: 1, pairs: {} };
}

function normalizePairRegistry(value) {
  const registry = emptyPairRegistry();
  const pairs = value?.pairs && typeof value.pairs === "object" ? value.pairs : {};
  for (const [recordId, pair] of Object.entries(pairs)) {
    if (!recordId || !pair?.docToken) continue;
    registry.pairs[recordId] = {
      recordId,
      docToken: String(pair.docToken),
      docUrl: String(pair.docUrl || `https://my.feishu.cn/docx/${pair.docToken}`),
      baseToken: String(pair.baseToken || ""),
      tableId: String(pair.tableId || ""),
      createdAt: String(pair.createdAt || new Date().toISOString()),
      missingDocChecks: Math.max(0, Number(pair.missingDocChecks || 0)),
      missingRecordChecks: Math.max(0, Number(pair.missingRecordChecks || 0))
    };
  }
  return registry;
}

async function getPairRegistry() {
  if (pairRegistry) return pairRegistry;
  try {
    pairRegistry = normalizePairRegistry(JSON.parse(await readFile(STATE_FILE, "utf8")));
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    pairRegistry = emptyPairRegistry();
  }
  return pairRegistry;
}

async function savePairRegistry(registry) {
  await mkdir(dirname(STATE_FILE), { recursive: true });
  const temporaryFile = `${STATE_FILE}.${process.pid}.tmp`;
  await writeFile(temporaryFile, `${JSON.stringify(registry, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryFile, STATE_FILE);
}

function withPairRegistry(operation) {
  const queued = registryQueue.then(async () => {
    const registry = await getPairRegistry();
    const result = await operation(registry);
    await savePairRegistry(registry);
    return result;
  });
  registryQueue = queued.catch(() => {});
  return queued;
}

function docTokenFromUrl(value) {
  const match = String(value || "").match(/\/docx\/([A-Za-z0-9_-]+)/);
  return match?.[1] || "";
}

function newPair({ recordId, docToken, docUrl, baseToken, tableId }) {
  return {
    recordId,
    docToken,
    docUrl: docUrl || `https://my.feishu.cn/docx/${docToken}`,
    baseToken,
    tableId,
    createdAt: new Date().toISOString(),
    missingDocChecks: 0,
    missingRecordChecks: 0
  };
}

async function registerPair(pair) {
  if (!pair.recordId || !pair.docToken) {
    throw new Error("剪存结果缺少文档 token 或多维表格记录 ID，无法建立删除关联");
  }
  await withPairRegistry((registry) => {
    registry.pairs[pair.recordId] = newPair(pair);
  });
}

function findDeep(value, predicate) {
  if (!value || typeof value !== "object") return null;
  if (predicate(value)) return value;
  for (const child of Object.values(value)) {
    const found = Array.isArray(child)
      ? child.map((item) => findDeep(item, predicate)).find(Boolean)
      : findDeep(child, predicate);
    if (found) return found;
  }
  return null;
}

function extractToken(obj) {
  if (!obj || typeof obj !== "object") return "";
  return (
    obj.token ||
    obj.file_token ||
    obj.folder_token ||
    obj.obj_token ||
    obj.app_token ||
    obj.base_token ||
    obj.document_id ||
    obj.id ||
    ""
  );
}

function extractUrl(obj) {
  if (!obj || typeof obj !== "object") return "";
  return obj.url || obj.share_url || obj.link || obj.app_url || "";
}

function normalizeDriveFile(file) {
  if (!file || typeof file !== "object") return null;
  return {
    name: String(file.name || file.title || "").trim(),
    type: String(file.type || file.file_type || file.doc_type || "").toLowerCase(),
    token: file.token || file.file_token || file.folder_token || file.obj_token || "",
    url: extractUrl(file)
  };
}

function extractDriveFiles(result) {
  if (Array.isArray(result?.data?.files)) return result.data.files;
  if (Array.isArray(result?.files)) return result.files;
  if (Array.isArray(result?.data?.result?.files)) return result.data.result.files;
  return [];
}

async function listDriveFiles(folderToken = "") {
  const result = await runLark([
    "drive",
    "files",
    "list",
    "--params",
    JSON.stringify({ folder_token: folderToken, page_size: 200 }),
    "--page-all",
    "--as",
    "user",
    "--format",
    "json"
  ]);
  return extractDriveFiles(result).map(normalizeDriveFile).filter(Boolean);
}

function normalizeFolderParentToken(value) {
  const token = String(value || "").trim();
  if (token && !/^[A-Za-z0-9_-]{8,128}$/.test(token)) {
    throw new ClipError("INVALID_FOLDER_TOKEN", "飞书云盘文件夹标识无效", {
      stage: "folder_list",
      status: 400,
      hint: "请返回上一级后重新选择文件夹。"
    });
  }
  return token;
}

async function listDriveFolders({ parentToken = "", refresh = false } = {}) {
  const normalizedParentToken = normalizeFolderParentToken(parentToken);
  const cacheKey = normalizedParentToken || "__drive_root__";
  const cached = folderListCache.get(cacheKey);
  if (!refresh && cached?.expiresAt > Date.now()) return cached.value;

  const folders = (await listDriveFiles(normalizedParentToken))
    .filter((file) => file.type === "folder" && file.token)
    .map((file) => ({
      token: file.token,
      name: file.name || "未命名文件夹",
      url: file.url
    }))
    .sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));

  const value = {
    parentToken: normalizedParentToken,
    folders
  };
  folderListCache.set(cacheKey, { expiresAt: Date.now() + FOLDER_CACHE_MS, value });
  return value;
}

async function findDriveFileInFolder(folderToken, name, expectedType) {
  const files = await listDriveFiles(folderToken);
  return files.find((file) => file.name === name && file.type === expectedType) || null;
}

async function ensureFolder(folderName = FOLDER_NAME) {
  const existing = await findDriveFileInFolder("", folderName, "folder").catch(() => null);
  if (existing) {
    return {
      token: existing.token,
      url: existing.url,
      created: false
    };
  }

  const created = await runLark([
    "drive",
    "+create-folder",
    "--name",
    folderName,
    "--as",
    "user",
    "--format",
    "json"
  ]);

  const folder = findDeep(created, (item) => Boolean(extractToken(item))) || created.data || created;
  return {
    token: extractToken(folder),
    url: extractUrl(folder),
    created: true
  };
}

function baseFieldsJson() {
  return JSON.stringify([
    { name: "标题", type: "text" },
    { name: "发布时间", type: "datetime", style: { format: "yyyy-MM-dd" } },
    { name: "发布单位", type: "text" },
    { name: "原网页链接", type: "text", style: { type: "url" } },
    { name: "飞书文档链接", type: "text", style: { type: "url" } },
    {
      name: "标签",
      type: "select",
      multiple: true,
      options: [
        { name: "政策", hue: "Blue" },
        { name: "案例", hue: "Green" },
        { name: "技术", hue: "Purple" },
        { name: "AI", hue: "Wathet" },
        { name: "飞书", hue: "Blue" },
        { name: "工作", hue: "Orange" },
        { name: "资料", hue: "Gray" },
        { name: "待整理", hue: "Red" }
      ]
    },
    { name: "内容摘要", type: "text" },
    { name: "正文", type: "text" }
  ]);
}

async function getTableId(baseToken) {
  const tables = await runLark([
    "base",
    "+table-list",
    "--base-token",
    baseToken,
    "--as",
    "user",
    "--format",
    "json"
  ]);
  const table =
    findDeep(tables, (item) => String(item.name || item.table_name || "") === TABLE_NAME) ||
    findDeep(tables, (item) => Boolean(item.table_id || item.id));
  return table?.table_id || table?.id || "";
}

function extractBaseFields(result) {
  if (Array.isArray(result?.data?.fields)) return result.data.fields;
  if (Array.isArray(result?.fields)) return result.fields;
  if (Array.isArray(result?.data?.data?.fields)) return result.data.data.fields;
  return [];
}

const TAG_OPTION_HUES = [
  "Blue",
  "Green",
  "Wathet",
  "Orange",
  "Purple",
  "Turquoise",
  "Carmine",
  "Lime"
];

function tagOptionHue(name) {
  let hash = 0;
  for (const character of String(name || "")) {
    hash = (hash * 31 + character.codePointAt(0)) >>> 0;
  }
  return TAG_OPTION_HUES[hash % TAG_OPTION_HUES.length];
}

function mergeTagOptions(field, tags) {
  const options = [];
  const names = new Set();
  const add = (value, fallbackHue) => {
    const name = normalizeBlockText(typeof value === "string" ? value : value?.name);
    if (!name || names.has(name)) return;
    names.add(name);
    options.push({
      name,
      hue: typeof value === "object" && value?.hue ? value.hue : fallbackHue || tagOptionHue(name),
      lightness:
        typeof value === "object" && value?.lightness ? value.lightness : "Lighter"
    });
  };

  for (const option of field?.options || []) add(option);
  for (const tag of tags || []) add(tag, tagOptionHue(tag));

  const originalNames = (field?.options || [])
    .map((option) => normalizeBlockText(option?.name))
    .filter(Boolean);
  const changed =
    originalNames.length !== options.length ||
    options.some((option, index) => option.name !== originalNames[index]);
  return { changed, options };
}

async function ensureTagOptionsOnce(base, tags) {
  const listed = await runLark([
    "base",
    "+field-list",
    "--base-token",
    base.token,
    "--table-id",
    base.tableId,
    "--as",
    "user",
    "--format",
    "json"
  ]);
  const tagField = extractBaseFields(listed).find((field) => field.name === "标签");
  if (!tagField || tagField.type !== "select" || tagField.multiple !== true) {
    throw new Error("多维表格中的“标签”字段必须是多选类型");
  }

  const merged = mergeTagOptions(tagField, tags);
  if (!merged.changed) return;
  await runLark([
    "base",
    "+field-update",
    "--base-token",
    base.token,
    "--table-id",
    base.tableId,
    "--field-id",
    tagField.id || tagField.field_id || tagField.name,
    "--json",
    JSON.stringify({
      name: "标签",
      type: "select",
      multiple: true,
      options: merged.options,
      description: "根据剪存内容自动提取的重点主题标签，默认2至3个，每个不超过5个字"
    }),
    "--yes",
    "--as",
    "user",
    "--format",
    "json"
  ]);
}

function ensureTagOptions(base, tags) {
  const queued = tagOptionQueue.then(() => ensureTagOptionsOnce(base, tags));
  tagOptionQueue = queued.catch(() => {});
  return queued;
}

async function ensureBaseSchema(baseToken, tableId) {
  const listed = await runLark([
    "base",
    "+field-list",
    "--base-token",
    baseToken,
    "--table-id",
    tableId,
    "--as",
    "user",
    "--format",
    "json"
  ]);
  const fields = extractBaseFields(listed);
  const legacyNames = new Set(["来源网站", "正文摘要", "保存时间", "保存方式", "状态"]);
  for (const field of fields.filter((item) => legacyNames.has(item.name))) {
    await runLark([
      "base",
      "+field-delete",
      "--base-token",
      baseToken,
      "--table-id",
      tableId,
      "--field-id",
      field.id || field.field_id || field.name,
      "--yes",
      "--as",
      "user",
      "--format",
      "json"
    ]);
  }

  const publishedField = fields.find((field) => field.name === "发布时间");
  if (publishedField) {
    if (publishedField.type !== "datetime") {
      throw new Error("多维表格中的“发布时间”字段必须是日期类型");
    }
    if (publishedField.style?.format !== "yyyy-MM-dd") {
      await runLark([
        "base",
        "+field-update",
        "--base-token",
        baseToken,
        "--table-id",
        tableId,
        "--field-id",
        publishedField.id,
        "--json",
        JSON.stringify({
          name: "发布时间",
          type: "datetime",
          style: { format: "yyyy-MM-dd" },
          description: "网页原始发布日期；仅保留年月日并与云文档保持一致"
        }),
        "--yes",
        "--as",
        "user",
        "--format",
        "json"
      ]);
    }
  } else {
    await runLark([
      "base",
      "+field-create",
      "--base-token",
      baseToken,
      "--table-id",
      tableId,
      "--json",
      JSON.stringify({
        name: "发布时间",
        type: "datetime",
        style: { format: "yyyy-MM-dd" },
        description: "网页原始发布日期；仅保留年月日并与云文档保持一致"
      }),
      "--as",
      "user",
      "--format",
      "json"
    ]);
  }

  if (!fields.some((field) => field.name === "发布单位")) {
    await runLark([
      "base",
      "+field-create",
      "--base-token",
      baseToken,
      "--table-id",
      tableId,
      "--json",
      JSON.stringify({
        name: "发布单位",
        type: "text",
        description: "网页标注的发布单位、信息来源或公众号名称"
      }),
      "--as",
      "user",
      "--format",
      "json"
    ]);
  }

  if (!fields.some((field) => field.name === "内容摘要")) {
    await runLark([
      "base",
      "+field-create",
      "--base-token",
      baseToken,
      "--table-id",
      tableId,
      "--json",
      JSON.stringify({
        name: "内容摘要",
        type: "text",
        description: "仅根据清洗后的文章内容生成的100至200字完整摘要"
      }),
      "--as",
      "user",
      "--format",
      "json"
    ]);
  }

  const views = await runLark([
    "base",
    "+view-list",
    "--base-token",
    baseToken,
    "--table-id",
    tableId,
    "--as",
    "user",
    "--format",
    "json"
  ]);
  const viewItems = views?.data?.views || views?.views || [];
  const visibleFields = [
    "标题",
    "发布时间",
    "发布单位",
    "原网页链接",
    "飞书文档链接",
    "标签",
    "内容摘要",
    "正文"
  ];
  for (const view of viewItems) {
    await runLark([
      "base",
      "+view-set-visible-fields",
      "--base-token",
      baseToken,
      "--table-id",
      tableId,
      "--view-id",
      view.id || view.view_id || view.name,
      "--json",
      JSON.stringify({ visible_fields: visibleFields }),
      "--as",
      "user",
      "--format",
      "json"
    ]);
  }
}

async function ensureBase(folderToken, baseName = BASE_NAME) {
  const existing = await findDriveFileInFolder(folderToken, baseName, "bitable").catch(() => null);
  if (existing) {
    const baseToken = existing.token;
    const tableId = await getTableId(baseToken);
    await ensureBaseSchema(baseToken, tableId);
    return {
      token: baseToken,
      tableId,
      url: existing.url || `https://my.feishu.cn/base/${baseToken}`,
      created: false
    };
  }

  const created = await runLark([
    "base",
    "+base-create",
    "--name",
    baseName,
    "--table-name",
    TABLE_NAME,
    "--fields",
    baseFieldsJson(),
    "--folder-token",
    folderToken,
    "--time-zone",
    TIME_ZONE,
    "--as",
    "user",
    "--format",
    "json"
  ]);

  const base = findDeep(created, (item) => Boolean(extractToken(item))) || created.data || created;
  const baseToken = extractToken(base);
  const tableId = await getTableId(baseToken);
  await ensureBaseSchema(baseToken, tableId);
  return {
    token: baseToken,
    tableId,
    url: extractUrl(base) || `https://my.feishu.cn/base/${baseToken}`,
    created: true
  };
}

async function ensureWorkspace(preferenceValue = {}) {
  const preferences = normalizePreferences(preferenceValue);
  const key = workspaceKey(preferences);
  const cached = workspaceCache.get(key);
  if (cached?.folder?.token && cached?.base?.token) return cached;
  if (workspacePromises.has(key)) return workspacePromises.get(key);
  const promise = (async () => {
    const folder = preferences.folderMode === "existing"
      ? {
          token: preferences.folderToken,
          url: `https://my.feishu.cn/drive/folder/${preferences.folderToken}`,
          created: false
        }
      : await ensureFolder(preferences.folderName);
    if (!folder.token) throw new Error("未能获取飞书剪存文件夹 token");
    if (preferences.folderMode === "existing") {
      await listDriveFiles(folder.token);
    }
    const base = await ensureBase(folder.token, preferences.baseName);
    if (!base.token) throw new Error("未能获取网页剪存库 Base token");
    const workspace = { folder, base, preferences };
    workspaceCache.set(key, workspace);
    return workspace;
  })().finally(() => workspacePromises.delete(key));
  workspacePromises.set(key, promise);
  return promise;
}

function escapeXml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\n/g, "<br/>");
}

function truncate(text, max) {
  const normalized = String(text || "").trim();
  return normalized.length > max ? `${normalized.slice(0, max)}...` : normalized;
}

function normalizeTitle(payload) {
  const title = String(payload.articleTitle || payload.title || payload.htmlTitle || "").trim();
  if (title) return truncate(title.replace(/\s+/g, " "), 120);
  return truncate(hostnameOf(payload.url) || "未命名网页", 120);
}

function isNoiseLine(line) {
  const text = String(line || "").trim();
  if (!text) return true;
  const compact = text.replace(/\s+/g, "");
  const exactNoise = new Set([
    "首页",
    "园区新闻",
    "部门动态",
    "街道动态",
    "党群之声",
    "调查征集",
    "关闭本页",
    "打印本稿",
    "返回顶部",
    "联系我们",
    "站点地图",
    "隐私声明",
    "当前位置：",
    "当前位置",
    "字号：[大中小]",
    "字号：大中小"
  ]);
  if (exactNoise.has(compact)) return true;
  return [
    /^\|?智能问答\|?微信$/,
    /^当前位置[:：]?$/,
    /^首页[>》]/,
    /【关闭本页】|【打印本稿】|【返回顶部】/,
    /联系我们\s*\|\s*站点地图\s*\|\s*隐私声明/,
    /^地址：.*邮编：.*电话：/,
    /^主办单位：/,
    /^备案号：|ICP备|公网安备|网站标识码/,
    /^发布时间：\d{4}[-/年]\d{1,2}[-/月]\d{1,2}/,
    /^信息来源：/,
    /^字号：/,
    /^首页\s*园区新闻\s*部门动态/,
    /^新闻动态$/,
    /^(?:关闭|打印|返回|分享|分享到|收藏|上一页|下一页)(?:本页|本稿|顶部)?[:：]?$/,
    /^(?:来源|文章来源|信息来源|作者|编辑|审核|校对|责任编辑|发布日期|发布机构|发布单位)[:：丨|]/,
    /^(?:登录|注册|搜索|无障碍浏览|适老版)$/,
    /^(?:ICP备|公网安备|网站标识码)/,
    /^》$/,
    /^>$/
  ].some((pattern) => pattern.test(text) || pattern.test(compact));
}

function articleParagraphs(text) {
  return String(text || "")
    .split(/\n{1,}/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeBlockText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return /^(https?):$/.test(url.protocol) ? url.href : "";
  } catch (_err) {
    return "";
  }
}

const TRACKING_PARAMETERS = new Set(["fbclid", "gclid", "mc_cid", "mc_eid", "spm"]);

function normalizeComparableUrl(value) {
  try {
    const url = new URL(String(value || ""));
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

function normalizeImageDataUrl(value) {
  const raw = String(value || "");
  const match = raw.match(/^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,([A-Za-z0-9+/=]+)$/i);
  if (!match || match[2].length > 12_000_000) return "";
  return `data:${match[1].toLowerCase()};base64,${match[2]}`;
}

function imageMimeType(value) {
  const mime = String(value || "").split(";", 1)[0].trim().toLowerCase();
  return /^(?:image\/(?:png|jpeg|jpg|gif|webp))$/.test(mime) ? mime.replace("image/jpg", "image/jpeg") : "";
}

function detectedImageMime(headerValue, url, buffer) {
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))) return "image/gif";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  const headerMime = imageMimeType(headerValue);
  if (headerMime) return headerMime;
  const extension = String(url || "").match(/\.(png|jpe?g|gif|webp)(?:[?#]|$)/i)?.[1]?.toLowerCase();
  return extension ? `image/${extension.replace("jpg", "jpeg")}` : "";
}

async function hydrateRemoteImages(blocks, sourceUrl) {
  const pending = blocks.filter((block) => block.type === "image" && !block.dataUrl);
  let nextIndex = 0;
  let totalBytes = 0;
  let downloaded = 0;
  const deadline = Date.now() + 20_000;
  const maxTotalBytes = 24 * 1024 * 1024;
  const maxSingleBytes = 8 * 1024 * 1024;

  const downloadNext = async () => {
    while (nextIndex < pending.length && totalBytes < maxTotalBytes && Date.now() < deadline) {
      const block = pending[nextIndex];
      nextIndex += 1;
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        Math.max(500, Math.min(5_000, deadline - Date.now()))
      );
      try {
        const response = await fetch(block.src, {
          headers: {
            Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
            Referer: safeHttpUrl(sourceUrl) || block.src,
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"
          },
          redirect: "follow",
          signal: controller.signal
        });
        if (!response.ok) continue;
        const declaredLength = Number(response.headers.get("content-length") || 0);
        if (declaredLength > maxSingleBytes) continue;
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length || buffer.length > maxSingleBytes || totalBytes + buffer.length > maxTotalBytes) continue;
        const mime = detectedImageMime(response.headers.get("content-type"), block.src, buffer);
        if (!mime) continue;
        block.dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
        totalBytes += buffer.length;
        downloaded += 1;
      } catch (_error) {
        // The document writer can still ask Feishu to fetch the original URL.
      } finally {
        clearTimeout(timeout);
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(6, pending.length) }, downloadNext));
  return { attempted: pending.length, downloaded, failed: pending.length - downloaded };
}

function isSeparatorLine(value) {
  return /^[|｜>》/·•\-–—\s]+$/.test(normalizeBlockText(value));
}

function isMenuLikeBlock(block) {
  if (!block?.text) return false;
  if (isSeparatorLine(block.text)) return true;
  return block.text.length <= 36 && Number(block.linkDensity || 0) >= 0.58;
}

function normalizeTableBlock(source) {
  const rows = (Array.isArray(source.rows) ? source.rows : [])
    .slice(0, 200)
    .map((row) =>
      (Array.isArray(row) ? row : []).slice(0, 30).map((cell) => ({
        text: normalizeBlockText(cell?.text),
        header: Boolean(cell?.header),
        colspan: Math.min(30, Math.max(1, Number(cell?.colspan || 1))),
        rowspan: Math.min(200, Math.max(1, Number(cell?.rowspan || 1))),
        backgroundColor: /^(?:red|orange|yellow|green|blue|purple|gray|rgb\(\d{1,3},\d{1,3},\d{1,3}\))$/.test(
          String(cell?.backgroundColor || "")
        )
          ? String(cell.backgroundColor)
          : "",
        align: ["left", "center", "right"].includes(cell?.align) ? cell.align : "",
        verticalAlign: ["top", "middle", "bottom"].includes(cell?.verticalAlign)
          ? cell.verticalAlign
          : ""
      }))
    )
    .filter((row) => row.length);
  if (!rows.length) return null;
  return {
    type: "table",
    caption: normalizeBlockText(source.caption),
    rows,
    columnWidths: (Array.isArray(source.columnWidths) ? source.columnWidths : [])
      .slice(0, 30)
      .map((width) => Math.min(600, Math.max(0, Number(width || 0))))
  };
}

function removeMenuRuns(blocks) {
  const remove = new Set();
  let start = -1;
  let menuItems = 0;

  const finish = (end) => {
    if (start >= 0 && menuItems >= 3) {
      for (let index = start; index < end; index += 1) remove.add(index);
    }
    start = -1;
    menuItems = 0;
  };

  blocks.forEach((block, index) => {
    if (["image", "table", "formula"].includes(block.type) || !isMenuLikeBlock(block)) {
      finish(index);
      return;
    }
    if (start < 0) start = index;
    if (isMenuLikeBlock(block) && !isSeparatorLine(block.text)) menuItems += 1;
  });
  finish(blocks.length);

  start = -1;
  let separators = 0;
  let shortItems = 0;
  const finishDelimited = (end) => {
    if (start >= 0 && shortItems >= 5 && separators >= 2) {
      for (let index = start; index < end; index += 1) remove.add(index);
    }
    start = -1;
    separators = 0;
    shortItems = 0;
  };

  blocks.forEach((block, index) => {
    const separator = block.text && isSeparatorLine(block.text);
    const shortLabel =
      block.text && block.text.length <= 20 && !/[。！？.!?；;，,：:]/.test(block.text);
    if (["image", "table", "formula"].includes(block.type) || (!separator && !shortLabel)) {
      finishDelimited(index);
      return;
    }
    if (start < 0) start = index;
    if (separator) separators += 1;
    else shortItems += 1;
  });
  finishDelimited(blocks.length);

  return blocks.filter((_block, index) => !remove.has(index));
}

function cleanArticleBlocks(payload, title = normalizeTitle(payload)) {
  const allowedTypes = new Set([
    "paragraph",
    "heading",
    "quote",
    "code",
    "list_item",
    "caption",
    "formula",
    "image",
    "table"
  ]);
  const sourceBlocks = Array.isArray(payload.blocks) && payload.blocks.length
    ? payload.blocks
    : articleParagraphs(payload.text || payload.description).map((text) => ({ type: "paragraph", text }));
  const normalized = [];

  for (const source of sourceBlocks) {
    if (!source || typeof source !== "object") continue;
    const type = allowedTypes.has(source.type) ? source.type : "paragraph";
    if (type === "image") {
      const src = safeHttpUrl(source.src);
      if (!src) continue;
      const dataUrl = normalizeImageDataUrl(source.dataUrl);
      const width = Number(source.width || 0);
      const height = Number(source.height || 0);
      if (width > 0 && height > 0 && (width < 120 || height < 80)) continue;
      normalized.push({
        type,
        src,
        alt: normalizeBlockText(source.alt),
        caption: normalizeBlockText(source.caption),
        width,
        height,
        ...(dataUrl ? { dataUrl } : {})
      });
      continue;
    }
    if (type === "table") {
      const table = normalizeTableBlock(source);
      if (table) normalized.push(table);
      continue;
    }

    const text = normalizeBlockText(source.text);
    if (!text || isNoiseLine(text)) continue;
    normalized.push({
      type,
      text,
      level: Math.min(6, Math.max(1, Number(source.level || 2))),
      ordered: Boolean(source.ordered),
      language: String(source.language || "").toLowerCase().replace(/[^a-z0-9+#.-]/g, "").slice(0, 24),
      linkDensity: Math.min(1, Math.max(0, Number(source.linkDensity || 0))),
      align: ["left", "center", "right"].includes(source.align) ? source.align : ""
    });
  }

  const titleCompact = title.replace(/\s+/g, "");
  let textIndex = 0;
  const withoutDuplicateTitle = normalized.filter((block) => {
    if (!block.text) return true;
    const duplicate = textIndex <= 4 && block.text.replace(/\s+/g, "") === titleCompact;
    textIndex += 1;
    return !duplicate;
  });

  return removeMenuRuns(withoutDuplicateTitle)
    .filter((block) => ["image", "table", "formula"].includes(block.type) || !isSeparatorLine(block.text))
    .slice(0, 800);
}

function tableToPlainText(block) {
  const lines = [];
  if (block.caption) lines.push(block.caption);
  for (const row of block.rows || []) {
    lines.push(
      `| ${row
        .map((cell) => String(cell.text || "").replace(/\|/g, "\\|").replace(/\n/g, " / "))
        .join(" | ")} |`
    );
  }
  return lines.join("\n");
}

function blocksToPlainText(blocks) {
  return truncate(
    blocks
      .filter((block) => block.type === "table" || (block.text && block.type !== "caption"))
      .map((block) => (block.type === "table" ? tableToPlainText(block) : block.text))
      .join("\n")
      .trim(),
    50000
  );
}

function cleanArticleText(payload) {
  return blocksToPlainText(cleanArticleBlocks(payload));
}

function inferTags(payload) {
  const title = normalizeBlockText(payload.articleTitle || payload.title);
  const description = normalizeBlockText(payload.description).slice(0, 1200);
  const body = normalizeBlockText(payload.text).slice(0, 30000);
  const candidates = new Map();
  const genericTags = new Set(["政策", "资料", "工作", "技术", "文章", "报告", "研究", "分析"]);

  const addCandidate = (tag, score, titleSignal = false) => {
    const normalized = String(tag || "")
      .replace(/[《》“”"'‘’（）()【】\[\]\s]/g, "")
      .trim();
    if (normalized.length < 2 || normalized.length > MAX_TAG_LENGTH || genericTags.has(normalized)) return;
    const existing = candidates.get(normalized) || { tag: normalized, score: 0, titleSignal: false };
    existing.score = Math.max(existing.score, score);
    existing.titleSignal ||= titleSignal;
    candidates.set(normalized, existing);
  };

  const countMatches = (text, pattern) => {
    const flags = pattern.flags.includes("i") ? "gi" : "g";
    return [...String(text || "").matchAll(new RegExp(pattern.source, flags))].length;
  };

  const rules = [
    ["营商环境", /营商环境|营商便利度|放管服/],
    ["信用建设", /社会信用|信用体系|信用监管|信用修复|履约信用/],
    ["扩大消费", /扩大消费|提振消费|促进消费|促消费/],
    ["人工智能", /人工智能|生成式AI|大模型|ChatGPT|Claude|Gemini|DeepSeek/i],
    ["数字经济", /数字经济|数字产业|产业数字化|数据要素/],
    ["政务服务", /政务服务|一网通办|高效办成一件事|行政审批/],
    ["市场监管", /市场监管|综合监管|公平竞争|反垄断/],
    ["知识产权", /知识产权|专利|商标保护|版权保护/],
    ["财政金融", /财政金融|金融支持|信贷投放|专项债|财政资金/],
    ["税费服务", /税费服务|税收征管|减税降费|纳税缴费/],
    ["就业促进", /就业优先|就业促进|稳岗扩岗|职业技能/],
    ["社会保障", /社会保障|基本养老|医疗保险|失业保险|社会救助/],
    ["养老托育", /养老服务|托育服务|银发经济|育儿补贴/],
    ["医疗健康", /医疗健康|卫生健康|医疗服务|健康消费/],
    ["教育培训", /教育培训|职业培训|教育资源|合作办学/],
    ["文化旅游", /文化旅游|文旅|旅游消费|公共文化/],
    ["交通物流", /交通物流|物流配送|交通运输|冷链物流/],
    ["城乡建设", /城市更新|城乡建设|老旧小区|基础设施建设/],
    ["乡村振兴", /乡村振兴|农村改革|农业农村|强农惠农/],
    ["外贸开放", /对外开放|外贸|跨境电商|进出口|离境退税/],
    ["企业服务", /企业服务|惠企服务|企业开办|市场主体|经营主体/]
  ];

  for (const [tag, pattern] of rules) {
    const titleCount = countMatches(title, pattern);
    const descriptionCount = countMatches(description, pattern);
    const bodyCount = countMatches(body, pattern);
    if (!titleCount && !descriptionCount && bodyCount < 2) continue;
    addCandidate(
      tag,
      titleCount * 16 + descriptionCount * 6 + Math.min(bodyCount, 8),
      titleCount > 0 || descriptionCount > 0
    );
  }

  const planningPeriod = title.match(/(十四五|十五五|十六五).{0,4}(规划|纲要)/);
  if (planningPeriod) addCandidate(`${planningPeriod[1]}规划`, 20, true);

  for (const match of title.matchAll(/《([^》]{2,40})》/g)) {
    const phrase = match[1]
      .replace(/(?:十四五|十五五|十六五)/g, "")
      .replace(/(?:总体)?(?:规划|纲要|方案|意见|办法|规定|通知|批复|报告)$/g, "")
      .replace(/[“”"'‘’（）()\s]/g, "")
      .trim();
    addCandidate(phrase, 22, true);
  }

  if (![...candidates.values()].some((item) => item.titleSignal)) {
    const actionPhrase = title.match(/(?:推动|促进|加强|提升|优化|构建|完善|深化)([\u4e00-\u9fff]{2,8})/);
    if (actionPhrase) addCandidate(actionPhrase[1], 18, true);
  }

  let ranked = [...candidates.values()];
  const titleSpecific = ranked.filter((item) => item.titleSignal);
  if (titleSpecific.length >= 2) ranked = titleSpecific;
  ranked.sort((a, b) => b.score - a.score || a.tag.length - b.tag.length);

  const tags = [];
  for (const candidate of ranked) {
    if (tags.some((tag) => tag.includes(candidate.tag) || candidate.tag.includes(tag))) continue;
    tags.push(candidate.tag);
    if (tags.length === MAX_TAG_COUNT) break;
  }

  if (!tags.length) {
    const fallback = title
      .replace(/^.{2,40}?(?:关于|印发)/, "")
      .replace(/(?:通知|意见|办法|规定|方案|报告|公告|通告|批复)$/g, "")
      .replace(/[《》“”"'‘’（）()\s]/g, "")
      .trim();
    if (fallback.length >= 2 && fallback.length <= MAX_TAG_LENGTH) tags.push(fallback);
  }

  return tags.slice(0, MAX_TAG_COUNT);
}

const SUMMARY_META_PATTERN = /(?:正文包含|摘要仅|摘要着重|材料的信息价值|本篇.{0,12}材料|内容主要从|阅读时应重点把握|本文主要|文章主要|材料主要|以下摘要|这篇文章|该文章|该材料)/;

function summarySentences(value) {
  const text = normalizeBlockText(value)
    .replace(/^(?:内容)?摘要\s*[：:]\s*/u, "")
    .replace(/[\r\n　]+/g, "")
    .trim();
  if (!text) return [];
  return text.match(/[^。！？!?]+[。！？!?]/g) || [];
}

function completeSummary(value) {
  const sentences = summarySentences(value);
  if (!sentences.length) return "";
  let summary = "";
  for (const sentence of sentences) {
    const normalized = sentence.replace(/[!?]/g, (mark) => ({ "!": "！", "?": "？" })[mark]);
    if (summary.length + normalized.length > MAX_SUMMARY_LENGTH) break;
    summary += normalized;
  }
  return summary;
}

function summaryIsValid(summary, body) {
  return (
    summary.length >= MIN_SUMMARY_LENGTH &&
    summary.length <= MAX_SUMMARY_LENGTH &&
    /[。！？]$/.test(summary) &&
    !SUMMARY_META_PATTERN.test(summary) &&
    !summaryCopiesSource(summary, body)
  );
}

function sourceSentences(body) {
  return normalizeBlockText(body)
    .replace(/[\r\n]+/g, "。")
    .split(/[。！？!?；;]+/)
    .map((sentence) => sentence.replace(/^\s*(?:发布时间|来源|发布单位)\s*[：:]\s*/u, "").trim())
    .filter((sentence) => sentence.length >= 12 && sentence.length <= 180)
    .filter((sentence) => !SUMMARY_META_PATTERN.test(sentence));
}

function compactSourceSentence(sentence) {
  return sentence
    .replace(/^(?:据悉|据了解|记者获悉|日前|近日|会上|其中|同时|此外|下一步)[，,]?/, "")
    .replace(/^[^，,]{0,24}(?:表示|指出|强调)[，,]/, "")
    .replace(/[\s　]+/g, "")
    .trim();
}

function fallbackSummary(title, body, tags) {
  const safeTitle = truncate(normalizeBlockText(title).replace(/[。！？!?；;]+$/g, ""), 70);
  const keywords = [...new Set([
    ...tags,
    ...contentKeywordTags({ articleTitle: safeTitle }, body).slice(0, 5)
  ])].filter(Boolean);
  const ranked = sourceSentences(body)
    .map((sentence, index) => ({
      sentence: compactSourceSentence(sentence),
      score: Math.max(0, 8 - index) + keywords.reduce((sum, keyword) => sum + (sentence.includes(keyword) ? 5 : 0), 0)
    }))
    .filter((item) => item.sentence.length >= 10)
    .sort((a, b) => b.score - a.score);

  const selected = [];
  for (const item of ranked) {
    if (selected.some((existing) => existing.includes(item.sentence) || item.sentence.includes(existing))) continue;
    selected.push(item.sentence);
    if (selected.length === 4) break;
  }

  const topic = keywords.slice(0, 3).join("、");
  const lead = safeTitle
    ? `${safeTitle.replace(/^(?:关于|国务院关于)/, "").replace(/[《》]/g, "")}聚焦${topic || "相关事项"}，`
    : `${topic || "相关事项"}方面，`;
  const facts = selected.map((sentence, index) => {
    if (index === 0) return `${lead}${sentence.replace(/^(?:本文|文章|材料|该文)/, "")}`;
    return sentence;
  });
  let summary = completeSummary(facts.map((sentence) => `${sentence}。`).join(""));

  if (summary.length < MIN_SUMMARY_LENGTH && selected.length) {
    const remaining = sourceSentences(body)
      .map(compactSourceSentence)
      .filter((sentence) => !selected.includes(sentence));
    for (const sentence of remaining) {
      const next = completeSummary(`${summary}${sentence}。`);
      if (next.length > summary.length) summary = next;
      if (summary.length >= MIN_SUMMARY_LENGTH) break;
    }
  }

  if (summary.length < MIN_SUMMARY_LENGTH) {
    const details = normalizeBlockText(body)
      .split(/[，,。！？!?；;：:]+/)
      .map(compactSourceSentence)
      .filter((detail) => detail.length >= 4 && detail.length <= 45)
      .filter((detail, index, all) => all.indexOf(detail) === index)
      .slice(0, 6);
    const groundedSentences = [
      details.length >= 2 ? `具体安排涉及${details.join("、")}。` : "",
      details.length >= 3
        ? `其中，${details.slice(0, 3).join("、")}构成主要任务，${details.slice(3).join("、")}作为配套环节同步推进。`
        : ""
    ].filter(Boolean);
    for (const sentence of groundedSentences) {
      const next = completeSummary(`${summary}${sentence}`);
      if (next.length > summary.length) summary = next;
      if (summary.length >= MIN_SUMMARY_LENGTH) break;
    }
  }

  if (!summary) {
    const conciseBody = compactSourceSentence(normalizeBlockText(body));
    summary = completeSummary(`${lead}${truncate(conciseBody, MAX_SUMMARY_LENGTH - lead.length - 1)}。`);
  }
  return summary;
}

function normalizeAiTag(value) {
  const genericTags = new Set([
    "政策",
    "资料",
    "工作",
    "技术",
    "文章",
    "报告",
    "研究",
    "分析",
    "新闻",
    "待整理"
  ]);
  const tag = String(value || "")
    .replace(/^[#＃]+/, "")
    .replace(/[《》“”"'‘’（）()【】\[\]，,。；;：:\s]/g, "")
    .trim();
  if (tag.length < 2 || tag.length > MAX_TAG_LENGTH || genericTags.has(tag)) return "";
  return tag;
}

function supplementalTags(payload) {
  const text = `${normalizeTitle(payload)}\n${normalizeBlockText(payload.text || payload.description)}`;
  const rules = [
    ["就业服务", /公共就业|就业公共服务|就业服务地图/],
    ["就业地图", /就业.{0,4}地图|服务地图/],
    ["人才服务", /人才服务|人才招聘|人力资源服务/],
    ["劳动保障", /劳动保障|劳动关系|劳动监察|劳动合同/],
    ["政策解读", /政策解读|答记者问|图解|权威解读/],
    ["产业发展", /产业发展|产业升级|产业链|产业集群/],
    ["科技创新", /科技创新|科技成果|创新驱动|研发投入/],
    ["公共服务", /公共服务|便民服务|服务平台/],
    ["数据发布", /数据发布|统计数据|调查数据|监测数据/]
  ];
  return rules.filter(([, pattern]) => pattern.test(text)).map(([tag]) => tag);
}

function contentKeywordTags(payload, body) {
  const title = normalizeTitle(payload);
  const source = `${title}\n${normalizeBlockText(body)}`;
  const blocked = new Set([
    "内容", "相关", "有关", "关于", "进行", "通过", "主要", "其中", "以及", "本文",
    "文章", "材料", "情况", "问题", "方面", "工作", "政策", "资料", "技术", "报告",
    "研究", "分析", "新闻", "发布", "通知", "意见", "方案", "办法", "规定"
  ]);
  const scores = new Map();
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  for (const item of segmenter.segment(source)) {
    if (!item.isWordLike) continue;
    const word = item.segment.replace(/[^\p{Script=Han}A-Za-z0-9]/gu, "");
    if (word.length < 2 || word.length > MAX_TAG_LENGTH || blocked.has(word) || /^\d+$/.test(word)) continue;
    const count = source.split(word).length - 1;
    scores.set(word, (scores.get(word) || 0) + count * 2 + (title.includes(word) ? 6 : 0));
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
  return ranked.map(([word]) => word);
}

function contentFallbackFragments(payload, body) {
  const source = `${normalizeTitle(payload)}\n${normalizeBlockText(body)}`;
  const fragments = [];
  for (const match of source.matchAll(/[\p{Script=Han}]{2,}/gu)) {
    const phrase = match[0]
      .replace(/^(?:关于|通过|进行|加强|推进|完善|开展|实施)/, "")
      .replace(/(?:通知|意见|方案|办法|规定|报告|文章|材料)$/, "");
    if (phrase.length < 2) continue;
    const candidates = phrase.length <= MAX_TAG_LENGTH
      ? [phrase]
      : [phrase.slice(-MAX_TAG_LENGTH), phrase.slice(0, MAX_TAG_LENGTH)];
    for (const candidate of candidates) {
      if (normalizeAiTag(candidate) && !fragments.includes(candidate)) fragments.push(candidate);
    }
  }
  return fragments;
}

function summaryCopiesSource(summary, body) {
  const compactSummary = normalizeBlockText(summary).replace(/[\s\p{P}\p{S}]/gu, "");
  const compactBody = normalizeBlockText(body).replace(/[\s\p{P}\p{S}]/gu, "");
  if (compactSummary.length < 24 || compactBody.length < 24) return false;
  for (let index = 0; index <= compactSummary.length - 24; index += 4) {
    if (compactBody.includes(compactSummary.slice(index, index + 24))) return true;
  }
  return false;
}

function normalizeAiEnrichment(value, payload, body) {
  const tags = [];
  const add = (valueToAdd) => {
    const tag = normalizeAiTag(valueToAdd);
    if (!tag || tags.some((item) => item === tag || item.includes(tag) || tag.includes(item))) return;
    tags.push(tag);
  };
  const contentPayload = { ...payload, text: body, description: "" };
  for (const tag of Array.isArray(value?.tags) ? value.tags : []) add(tag);
  for (const tag of inferTags(contentPayload)) add(tag);
  for (const tag of supplementalTags(contentPayload)) add(tag);
  for (const tag of contentKeywordTags(contentPayload, body)) {
    if (tags.length >= MIN_TAG_COUNT) break;
    add(tag);
  }

  if (tags.length < MIN_TAG_COUNT) {
    const titleTag = normalizeTitle(payload)
      .replace(/(?:发布|印发|通知|公告|通告|办法|意见|方案|报告|解读)$/g, "")
      .replace(/[《》“”"'‘’（）()【】\[\]\s]/g, "")
      .slice(0, MAX_TAG_LENGTH);
    add(titleTag);
  }
  for (const tag of contentFallbackFragments(contentPayload, body)) {
    if (tags.length >= MIN_TAG_COUNT) break;
    add(tag);
  }
  const finalTags = tags.slice(0, MAX_TAG_COUNT);
  const candidateSummary = completeSummary(value?.summary);
  const aiSummaryIsValid = summaryIsValid(candidateSummary, body);
  const summary = aiSummaryIsValid
    ? candidateSummary
    : fallbackSummary(normalizeTitle(payload), body, finalTags);
  return {
    summary,
    tags: finalTags,
    source: aiSummaryIsValid ? value?.source || "ai" : "fallback"
  };
}

async function fetchJsonWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`AI 服务返回 ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function parseAiJson(value) {
  if (value && typeof value === "object") return value;
  const text = String(value || "").replace(/^```(?:json)?\s*|\s*```$/gi, "").trim();
  try {
    return JSON.parse(text);
  } catch (_err) {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : {};
  }
}

function aiPrompt(payload, body) {
  return [
    "你是中文网页归档编辑。请仅返回 JSON，不要解释。",
    "任务：根据清洗后的正文重新组织一段内容摘要，并仅从该内容提取 2 至 3 个突出核心对象、主题或关键事项的标签。",
    "摘要要求：100 至 200 个汉字，写成一个完整段落；只概括正文中的核心事实、对象、措施、进展、结果或影响，不评价摘要本身，也不补充正文没有的信息。必须使用自己的表述，不得复制原文完整句子，不得连续照抄原文超过 20 个字。",
    "禁止出现‘正文包含’‘摘要仅’‘材料的信息价值’‘内容主要从’‘阅读时应重点把握’‘本文主要介绍了’等空泛套话。每句话都必须写完整，最后一个字符必须是句号、问号或感叹号，不得因字数限制截断半句。",
    "标签要求：必须为 2 至 3 个，每个 2 至 5 个字；只根据正文主题生成；拒绝使用‘政策、资料、工作、技术、文章、报告、研究、分析、新闻’等泛化词；不要使用网站名、发布单位或状态词作为标签。",
    '返回格式：{"summary":"...","tags":["...","..."]}',
    `标题：${normalizeTitle(payload)}`,
    `发布单位：${normalizeBlockText(payload.publisher) || "未识别"}`,
    `正文：${truncate(body, 8000)}`
  ].join("\n");
}

async function getOllamaModel() {
  if (ollamaModelCache) return ollamaModelCache;
  if (process.env.FEISHU_CLIPPER_AI_MODEL) {
    ollamaModelCache = process.env.FEISHU_CLIPPER_AI_MODEL;
    return ollamaModelCache;
  }
  const result = await fetchJsonWithTimeout(`${OLLAMA_URL}/api/tags`);
  ollamaModelCache = result?.models?.[0]?.name || "";
  if (!ollamaModelCache) throw new Error("Ollama 未安装可用模型");
  return ollamaModelCache;
}

async function requestOllamaEnrichment(payload, body) {
  const model = await getOllamaModel();
  const result = await fetchJsonWithTimeout(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt: aiPrompt(payload, body),
      stream: false,
      format: "json",
      think: false,
      options: { temperature: 0.2, num_predict: 680 }
    })
  });
  return { ...parseAiJson(result?.response), source: "ollama" };
}

async function requestOpenAiEnrichment(payload, body) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("未配置 OPENAI_API_KEY");
  const baseUrl = String(process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const model = process.env.FEISHU_CLIPPER_AI_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini";
  const result = await fetchJsonWithTimeout(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.15,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content: aiPrompt(payload, body) }]
    })
  });
  return { ...parseAiJson(result?.choices?.[0]?.message?.content), source: "openai" };
}

async function enrichContent(payload, body) {
  try {
    const value = AI_PROVIDER === "openai"
      ? await requestOpenAiEnrichment(payload, body)
      : AI_PROVIDER === "none"
        ? {}
        : await requestOllamaEnrichment(payload, body);
    return normalizeAiEnrichment(value, payload, body);
  } catch (err) {
    console.error(`AI 摘要失败，已使用本地规则：${err.message}`);
    return normalizeAiEnrichment({}, payload, body);
  }
}

function formatShanghaiDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).formatToParts(date);
  const get = (type) => parts.find((part) => part.type === type)?.value || "00";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

function normalizePublishedAt(value) {
  const raw = String(value || "").trim();
  if (!raw) return { value: null, display: "未识别" };

  if (/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) {
      const datePart = formatShanghaiDate(date).slice(0, 10);
      return { value: `${datePart} 00:00:00`, display: datePart };
    }
  }

  const match = raw.match(
    /((?:19|20)\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/
  );
  if (!match) return { value: null, display: "未识别" };
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4] || 0);
  const minute = Number(match[5] || 0);
  const second = Number(match[6] || 0);
  const validDate = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (
    validDate.getUTCFullYear() !== year ||
    validDate.getUTCMonth() !== month - 1 ||
    validDate.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    return { value: null, display: "未识别" };
  }
  const pad = (part) => String(part).padStart(2, "0");
  const datePart = `${year}-${pad(month)}-${pad(day)}`;
  return {
    value: `${datePart} 00:00:00`,
    display: datePart
  };
}

function hostnameOf(rawUrl) {
  try {
    return new URL(rawUrl).hostname;
  } catch (_err) {
    return "";
  }
}

function escapeXmlAttribute(text) {
  return escapeXml(text).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function imageName(block) {
  try {
    const pathname = decodeURIComponent(new URL(block.src).pathname);
    const candidate = pathname.split("/").filter(Boolean).pop() || "网页图片.jpg";
    return truncate(candidate.replace(/[\\/:*?"<>|]/g, "_"), 80) || "网页图片.jpg";
  } catch (_err) {
    return "网页图片.jpg";
  }
}

function buildClipMetadata(payload, tags, summary = "") {
  const sourceUrl = safeHttpUrl(payload.url);
  const publication = normalizePublishedAt(payload.publishedAt);
  const publisher = truncate(String(payload.publisher || "").replace(/\s+/g, " ").trim(), 100) || "未识别";
  return {
    sourceUrl,
    tags: [...new Set(tags || [])],
    publishedAt: publication.value,
    publishedDisplay: publication.display,
    publisher,
    summary: completeSummary(summary)
  };
}

function prepareEmbeddedImages(blocks) {
  const assets = [];
  const preparedBlocks = blocks.map((block, index) => {
    if (block.type !== "image" || !block.dataUrl) return block;
    const match = block.dataUrl.match(/^data:(image\/(?:png|jpeg|jpg|gif|webp));base64,(.+)$/i);
    if (!match) return block;
    try {
      const buffer = Buffer.from(match[2], "base64");
      if (!buffer.length || buffer.length > 8 * 1024 * 1024) return block;
      const extension = match[1].split("/")[1].replace("jpeg", "jpg");
      const placeholder = `FEISHU_CLIPPER_IMAGE_${randomUUID().replace(/-/g, "")}`;
      assets.push({
        buffer,
        fileName: `image-${String(index + 1).padStart(3, "0")}.${extension}`,
        placeholder,
        caption: normalizeBlockText(block.caption || block.alt),
        width: Math.round(Number(block.width || 0)),
        height: Math.round(Number(block.height || 0))
      });
      return {
        ...block,
        placeholder
      };
    } catch (_err) {
      return block;
    }
  });
  return { blocks: preparedBlocks, assets };
}

function tableCellXml(cell) {
  const tag = cell.header ? "th" : "td";
  const attributes = [];
  if (cell.colspan > 1) attributes.push(`colspan="${cell.colspan}"`);
  if (cell.rowspan > 1) attributes.push(`rowspan="${cell.rowspan}"`);
  if (cell.backgroundColor) {
    attributes.push(`background-color="${escapeXmlAttribute(cell.backgroundColor)}"`);
  }
  if (cell.verticalAlign) attributes.push(`vertical-align="${cell.verticalAlign}"`);
  const alignment = cell.align ? ` align="${cell.align}"` : "";
  const text = escapeXml(cell.text || " ");
  const content = cell.align ? `<p${alignment}>${text}</p>` : text;
  return `<${tag}${attributes.length ? ` ${attributes.join(" ")}` : ""}>${content}</${tag}>`;
}

function tableToDocXml(block) {
  const rows = block.rows || [];
  if (!rows.length) return "";
  const parts = ["<table>"];
  const widths = (block.columnWidths || []).filter((width) => width > 0);
  if (widths.length) {
    parts.push(`<colgroup>${widths.map((width) => `<col width="${Math.round(width)}"/>`).join("")}</colgroup>`);
  }
  const firstRowIsHeader = rows[0].some((cell) => cell.header);
  if (firstRowIsHeader) {
    parts.push(`<thead><tr>${rows[0].map(tableCellXml).join("")}</tr></thead>`);
  }
  const bodyRows = firstRowIsHeader ? rows.slice(1) : rows;
  if (bodyRows.length) {
    parts.push(
      `<tbody>${bodyRows
        .map((row) => `<tr>${row.map(tableCellXml).join("")}</tr>`)
        .join("")}</tbody>`
    );
  }
  parts.push("</table>");
  if (block.caption) parts.push(`<p align="center"><em>${escapeXml(block.caption)}</em></p>`);
  return parts.join("");
}

function buildDocXml(title, blocks, metadata = {}) {
  const sourceUrl = safeHttpUrl(metadata.sourceUrl);
  const tagText = Array.isArray(metadata.tags) && metadata.tags.length ? metadata.tags.join("、") : "无";
  const publishedDisplay = metadata.publishedDisplay || "未识别";
  const publisher = metadata.publisher || "未识别";
  const summary = normalizeBlockText(metadata.summary);
  const content = [
    `<title align="center">${escapeXml(title)}</title>`,
    '<callout background-color="light-blue" border-color="blue">',
    `<p><b>发布时间：</b>${escapeXml(publishedDisplay)}</p>`,
    `<p><b>发布单位：</b>${escapeXml(publisher)}</p>`,
    sourceUrl
      ? `<p><b>原网页链接：</b><a href="${escapeXmlAttribute(sourceUrl)}">${escapeXml(sourceUrl)}</a></p>`
      : "<p><b>原网页链接：</b>未识别</p>",
    `<p><b>标签：</b>${escapeXml(tagText)}</p>`,
    summary ? `<p><b>内容摘要：</b>${escapeXml(summary)}</p>` : "",
    "</callout>",
    "<hr/>"
  ];
  let list = [];
  let listOrdered = false;

  const flushList = () => {
    if (!list.length) return;
    const tag = listOrdered ? "ol" : "ul";
    const items = list
      .map((block) => `<li${listOrdered ? ' seq="auto"' : ""}>${escapeXml(block.text)}</li>`)
      .join("");
    content.push(`<${tag}>${items}</${tag}>`);
    list = [];
  };

  for (const block of blocks) {
    if (block.type === "list_item") {
      if (list.length && listOrdered !== block.ordered) flushList();
      listOrdered = block.ordered;
      list.push(block);
      continue;
    }
    flushList();

    if (block.type === "image") {
      if (block.placeholder) {
        content.push(`<p align="center">${escapeXml(block.placeholder)}</p>`);
      } else {
        const caption = normalizeBlockText(block.caption || block.alt);
        content.push(
          `<p align="center"><img href="${escapeXmlAttribute(block.src)}" name="${escapeXmlAttribute(imageName(block))}"${caption ? ` caption="${escapeXmlAttribute(caption)}"` : ""}/></p>`
        );
      }
    } else if (block.type === "table") {
      const table = tableToDocXml(block);
      if (table) content.push(table);
    } else if (block.type === "heading") {
      const level = Math.min(4, Math.max(2, block.level || 2));
      const alignment = block.align && block.align !== "left" ? ` align="${block.align}"` : "";
      content.push(`<h${level}${alignment}>${escapeXml(block.text)}</h${level}>`);
    } else if (block.type === "quote") {
      content.push(`<blockquote>${escapeXml(block.text)}</blockquote>`);
    } else if (block.type === "code") {
      const language = block.language ? ` lang="${escapeXmlAttribute(block.language)}"` : "";
      content.push(`<pre${language}><code>${escapeXml(block.text)}</code></pre>`);
    } else if (block.type === "formula") {
      content.push(`<p align="center"><latex>${escapeXml(block.text)}</latex></p>`);
    } else if (block.type === "caption") {
      content.push(`<p align="center"><em>${escapeXml(block.text)}</em></p>`);
    } else {
      const aligned = block.align === "center" || block.align === "right";
      content.push(
        aligned
          ? `<p align="${block.align}">${escapeXml(block.text)}</p>`
          : `<p>${BODY_PARAGRAPH_INDENT}${escapeXml(block.text)}</p>`
      );
    }
  }
  flushList();
  if (content.length === 1) content.push("<p></p>");
  return content.join("\n");
}

function documentContentFromResult(result) {
  return String(result?.data?.document?.content || result?.document?.content || "");
}

function placeholderBlockId(content, placeholder) {
  const escaped = placeholder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return content.match(new RegExp(`<p\\s+id="([^"]+)"[^>]*>\\s*${escaped}\\s*</p>`))?.[1] || "";
}

async function insertEmbeddedImages(docToken, assets) {
  if (!assets.length) return;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "feishu-clipper-"));
  try {
    for (const asset of assets) {
      await writeFile(join(temporaryDirectory, asset.fileName), asset.buffer, { mode: 0o600 });
      const mediaArgs = [
        "docs",
        "+media-insert",
        "--doc",
        docToken,
        "--file",
        `./${asset.fileName}`,
        "--selection-with-ellipsis",
        asset.placeholder,
        "--before"
      ];
      if (asset.width > 0) mediaArgs.push("--width", String(asset.width));
      if (asset.height > 0) mediaArgs.push("--height", String(asset.height));
      if (asset.caption) mediaArgs.push("--caption", asset.caption);
      mediaArgs.push("--align", "center");
      mediaArgs.push("--as", "user", "--format", "json");
      await runLark(mediaArgs, undefined, { cwd: temporaryDirectory });

      const located = await runLark([
        "docs",
        "+fetch",
        "--doc",
        docToken,
        "--scope",
        "keyword",
        "--keyword",
        asset.placeholder,
        "--detail",
        "with-ids",
        "--as",
        "user",
        "--format",
        "json"
      ]);
      const blockId = placeholderBlockId(documentContentFromResult(located), asset.placeholder);
      if (!blockId) throw new Error("插入图片后未能定位临时占位块");
      await runLark([
        "docs",
        "+update",
        "--doc",
        docToken,
        "--command",
        "block_delete",
        "--block-id",
        blockId,
        "--as",
        "user",
        "--format",
        "json"
      ]);
    }
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function createDoc(folderToken, title, blocks, metadata) {
  const preparedImages = prepareEmbeddedImages(blocks);
  const content = buildDocXml(title, preparedImages.blocks, metadata);
  const created = await runLark([
    "docs",
    "+create",
    "--api-version",
    "v2",
    "--parent-token",
    folderToken,
    "--title",
    title,
    "--content",
    content,
    "--as",
    "user",
    "--format",
    "json"
  ]);

  const doc = findDeep(created, (item) => Boolean(item.document_id || item.url)) || created.data?.document || created.data || created;
  const normalized = {
    token: doc.document_id || extractToken(doc),
    url: extractUrl(doc)
  };
  try {
    await insertEmbeddedImages(normalized.token, preparedImages.assets);
  } catch (err) {
    if (normalized.token) await deleteClipDoc(normalized.token).catch(() => {});
    throw err;
  }
  return normalized;
}

function buildBaseRecordPayload(doc, title, body, metadata) {
  const fields = [
    "标题",
    "发布时间",
    "发布单位",
    "原网页链接",
    "飞书文档链接",
    "标签",
    "内容摘要",
    "正文"
  ];
  const rows = [
    [
      truncate(title, 300),
      metadata.publishedAt,
      metadata.publisher,
      metadata.sourceUrl || "",
      doc.url || "",
      metadata.tags,
      metadata.summary,
      truncate(body, 50000)
    ]
  ];
  return { fields, rows };
}

async function createRecord(base, doc, title, body, metadata) {
  const recordPayload = buildBaseRecordPayload(doc, title, body, metadata);

  const result = await runLark([
    "base",
    "+record-batch-create",
    "--base-token",
    base.token,
    "--table-id",
    base.tableId,
    "--json",
    JSON.stringify(recordPayload),
    "--as",
    "user",
    "--format",
    "json"
  ]);

  const record =
    findDeep(result, (item) => Boolean(item.record_id || item.record_id_list)) ||
    result.data ||
    result;
  invalidateClipRecordCache(base);
  return {
    id: record.record_id || record.record_id_list?.[0] || ""
  };
}

function extractCellUrl(value) {
  if (!value) return "";
  if (typeof value === "string") {
    const direct = safeHttpUrl(value);
    if (direct) return direct;
    const embedded = value.match(/https?:\/\/[^\s\])]+/i)?.[0] || "";
    return safeHttpUrl(embedded);
  }
  if (Array.isArray(value)) {
    return value.map(extractCellUrl).find(Boolean) || "";
  }
  if (typeof value === "object") {
    return (
      safeHttpUrl(value.link || value.url || value.href || value.text) ||
      Object.values(value).map(extractCellUrl).find(Boolean) ||
      ""
    );
  }
  return "";
}

function extractRecordPage(result) {
  const page = result?.data && typeof result.data === "object" ? result.data : result;
  const rows = Array.isArray(page?.data) ? page.data : [];
  const recordIds = Array.isArray(page?.record_id_list) ? page.record_id_list : [];
  const fields = Array.isArray(page?.fields) ? page.fields : [];
  const linkIndex = fields.indexOf("飞书文档链接");
  const sourceIndex = fields.indexOf("原网页链接");
  const titleIndex = fields.indexOf("标题");
  const records = [];

  for (let index = 0; index < Math.max(rows.length, recordIds.length); index += 1) {
    const row = rows[index];
    const recordId =
      recordIds[index] || row?.record_id || row?.recordId || row?.id || "";
    const rawLink = Array.isArray(row)
      ? row[linkIndex >= 0 ? linkIndex : 0]
      : row?.fields?.["飞书文档链接"] ?? row?.["飞书文档链接"];
    const docUrl = extractCellUrl(rawLink);
    const rawSource = Array.isArray(row)
      ? row[sourceIndex]
      : row?.fields?.["原网页链接"] ?? row?.["原网页链接"];
    const rawTitle = Array.isArray(row)
      ? row[titleIndex]
      : row?.fields?.["标题"] ?? row?.["标题"];
    const sourceUrl = extractCellUrl(rawSource);
    const title = normalizeBlockText(
      typeof rawTitle === "string" ? rawTitle : rawTitle?.text || rawTitle?.value
    );
    if (recordId && docUrl) {
      records.push({
        recordId,
        docUrl,
        ...(sourceUrl ? { sourceUrl } : {}),
        ...(title ? { title } : {})
      });
    }
  }

  return {
    records,
    count: Math.max(rows.length, recordIds.length),
    hasMore: Boolean(page?.has_more)
  };
}

async function listAllClipRecordDetails(base) {
  const records = [];
  let offset = 0;

  while (true) {
    const result = await runLark([
      "base",
      "+record-list",
      "--base-token",
      base.token,
      "--table-id",
      base.tableId,
      "--field-id",
      "标题",
      "--field-id",
      "原网页链接",
      "--field-id",
      "飞书文档链接",
      "--offset",
      String(offset),
      "--limit",
      "200",
      "--as",
      "user",
      "--format",
      "json"
    ]);
    const page = extractRecordPage(result);
    records.push(...page.records);
    if (!page.hasMore) break;
    if (!page.count) throw new Error("多维表格分页返回异常，已停止查询");
    offset += page.count;
  }
  return records;
}

async function cachedClipRecordDetails(base) {
  const key = `${base.token}\u0000${base.tableId}`;
  const cached = clipRecordCache.get(key);
  if (cached?.records && cached.expiresAt > Date.now()) return cached.records;
  if (cached?.promise) return cached.promise;
  const promise = listAllClipRecordDetails(base)
    .then((records) => {
      clipRecordCache.set(key, { records, expiresAt: Date.now() + 30_000 });
      return records;
    })
    .catch((error) => {
      clipRecordCache.delete(key);
      throw error;
    });
  clipRecordCache.set(key, { promise, expiresAt: 0 });
  return promise;
}

function invalidateClipRecordCache(base) {
  clipRecordCache.delete(`${base.token}\u0000${base.tableId}`);
}

async function findExistingClip(base, rawUrl) {
  const wanted = normalizeComparableUrl(rawUrl);
  if (!wanted) return null;
  const records = await cachedClipRecordDetails(base);
  return records.find((record) => normalizeComparableUrl(record.sourceUrl) === wanted) || null;
}

async function listAllClipRecords(base) {
  const records = new Map();
  let offset = 0;

  while (true) {
    const result = await runLark([
      "base",
      "+record-list",
      "--base-token",
      base.token,
      "--table-id",
      base.tableId,
      "--field-id",
      "飞书文档链接",
      "--offset",
      String(offset),
      "--limit",
      "200",
      "--as",
      "user",
      "--format",
      "json"
    ]);
    const page = extractRecordPage(result);
    page.records.forEach((record) => records.set(record.recordId, record.docUrl));
    if (!page.hasMore) break;
    if (!page.count) throw new Error("多维表格分页返回异常，已停止删除同步");
    offset += page.count;
  }

  return records;
}

async function getDocStates(docTokens) {
  const states = new Map(docTokens.map((token) => [token, "unknown"]));
  for (const docToken of docTokens) {
    try {
      const result = await runLark([
        "docs",
        "+fetch",
        "--api-version",
        "v2",
        "--doc",
        docToken,
        "--scope",
        "outline",
        "--max-depth",
        "1",
        "--detail",
        "simple",
        "--as",
        "user",
        "--format",
        "json"
      ]);
      if (result?.ok !== false) {
        states.set(docToken, "exists");
      } else if (
        [1061007, 3380003].includes(Number(result?.error?.code)) ||
        /(?:has been delete|page has been deleted|not found)/i.test(result?.error?.message || "")
      ) {
        states.set(docToken, "missing");
      }
    } catch (err) {
      if (isDeletedLarkFailure(err)) states.set(docToken, "missing");
      // Other network, authentication and permission failures stay unknown and never trigger deletion.
    }
  }
  return states;
}

function evaluatePairState(pair, { recordExists, docState }, confirmations = SYNC_CONFIRMATIONS) {
  const next = {
    ...pair,
    missingRecordChecks: recordExists
      ? 0
      : Math.min(confirmations, Number(pair.missingRecordChecks || 0) + 1),
    missingDocChecks:
      docState === "exists"
        ? 0
        : docState === "missing"
          ? Math.min(confirmations, Number(pair.missingDocChecks || 0) + 1)
          : Number(pair.missingDocChecks || 0)
  };

  let action = "none";
  if (!recordExists && docState === "exists" && next.missingRecordChecks >= confirmations) {
    action = "delete_doc";
  } else if (recordExists && docState === "missing" && next.missingDocChecks >= confirmations) {
    action = "delete_record";
  } else if (
    !recordExists &&
    docState === "missing" &&
    next.missingRecordChecks >= confirmations &&
    next.missingDocChecks >= confirmations
  ) {
    action = "forget";
  }

  return { pair: next, action };
}

function recordExistsFromGet(result, recordId) {
  const data = result?.data || result;
  if (Array.isArray(data?.record_not_found) && data.record_not_found.includes(recordId)) return false;
  if (Array.isArray(data?.record_id_list) && data.record_id_list.includes(recordId)) return true;
  return null;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function getClipRecordState(base, recordId) {
  const result = await runLark([
    "base",
    "+record-get",
    "--base-token",
    base.token,
    "--table-id",
    base.tableId,
    "--record-id",
    recordId,
    "--field-id",
    "飞书文档链接",
    "--as",
    "user",
    "--format",
    "json"
  ]);
  return recordExistsFromGet(result, recordId);
}

async function waitForRecordDeletion(base, recordId) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const exists = await getClipRecordState(base, recordId);
    if (exists === false) return;
    if (attempt < 5) await delay(1_000);
  }
  throw new Error(`多维表格记录 ${recordId} 删除后回查仍存在，将在下一轮自动重试`);
}

async function waitForDocDeletion(docToken) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const state = (await getDocStates([docToken])).get(docToken);
    if (state === "missing") return;
    if (attempt < 5) await delay(1_000);
  }
  throw new Error(`云文档 ${docToken} 删除后回查仍存在，将在下一轮自动重试`);
}

async function deleteClipRecord(base, recordId) {
  try {
    await runLark([
      "base",
      "+record-delete",
      "--base-token",
      base.token,
      "--table-id",
      base.tableId,
      "--record-id",
      recordId,
      "--yes",
      "--as",
      "user",
      "--format",
      "json"
    ]);
  } catch (err) {
    if (!isDeletedLarkFailure(err)) throw err;
  }
  await waitForRecordDeletion(base, recordId);
}

async function deleteClipDoc(docToken) {
  try {
    await runLark([
      "drive",
      "+delete",
      "--file-token",
      docToken,
      "--type",
      "docx",
      "--yes",
      "--as",
      "user",
      "--format",
      "json"
    ]);
  } catch (err) {
    if (!isDeletedLarkFailure(err)) throw err;
  }
  await waitForDocDeletion(docToken);
}

async function syncDeletionPairsOnce() {
  const workspace = await ensureWorkspace();
  const defaultKey = `${workspace.base.token}\u0000${workspace.base.tableId}`;
  const defaultRecords = await listAllClipRecords(workspace.base);

  const pairs = await withPairRegistry((registry) => {
    for (const [recordId, docUrl] of defaultRecords) {
      const docToken = docTokenFromUrl(docUrl);
      if (!docToken || registry.pairs[recordId]) continue;
      registry.pairs[recordId] = newPair({
        recordId,
        docToken,
        docUrl,
        baseToken: workspace.base.token,
        tableId: workspace.base.tableId
      });
    }
    return Object.values(registry.pairs).map((pair) => ({ ...pair }));
  });

  const bases = new Map([[defaultKey, workspace.base]]);
  for (const pair of pairs) {
    if (!pair.baseToken || !pair.tableId) continue;
    const key = `${pair.baseToken}\u0000${pair.tableId}`;
    if (!bases.has(key)) bases.set(key, { token: pair.baseToken, tableId: pair.tableId });
  }
  const recordsByBase = new Map([[defaultKey, defaultRecords]]);
  const errors = [];
  for (const [key, base] of bases) {
    if (key === defaultKey) continue;
    try {
      recordsByBase.set(key, await listAllClipRecords(base));
    } catch (err) {
      errors.push({ baseToken: base.token, error: err.message });
    }
  }

  const docTokens = [...new Set(pairs.map((pair) => pair.docToken).filter(Boolean))];
  const docStates = await getDocStates(docTokens);
  const evaluations = pairs.map((pair) => {
    const key = `${pair.baseToken}\u0000${pair.tableId}`;
    const records = recordsByBase.get(key);
    if (!records) return { original: pair, pair: { ...pair }, action: "none", base: null };
    return {
      original: pair,
      ...evaluatePairState(pair, {
        recordExists: records.has(pair.recordId),
        docState: docStates.get(pair.docToken) || "unknown"
      }),
      base: bases.get(key)
    };
  });
  const completed = new Set();
  let deletedDocs = 0;
  let deletedRecords = 0;

  for (const evaluation of evaluations) {
    try {
      if (evaluation.action === "delete_doc") {
        await deleteClipDoc(evaluation.pair.docToken);
        deletedDocs += 1;
        completed.add(evaluation.pair.recordId);
      } else if (evaluation.action === "delete_record") {
        await deleteClipRecord(evaluation.base, evaluation.pair.recordId);
        deletedRecords += 1;
        completed.add(evaluation.pair.recordId);
      } else if (evaluation.action === "forget") {
        completed.add(evaluation.pair.recordId);
      }
    } catch (err) {
      errors.push({ recordId: evaluation.pair.recordId, error: err.message });
    }
  }

  await withPairRegistry((registry) => {
    for (const evaluation of evaluations) {
      const recordId = evaluation.pair.recordId;
      const current = registry.pairs[recordId];
      if (!current || current.docToken !== evaluation.original.docToken) continue;
      if (completed.has(recordId)) delete registry.pairs[recordId];
      else registry.pairs[recordId] = evaluation.pair;
    }
  });

  return {
    ok: errors.length === 0,
    checked: pairs.length,
    deletedDocs,
    deletedRecords,
    pendingConfirmations: evaluations.filter(
      (item) =>
        item.action === "none" &&
        (item.pair.missingDocChecks > 0 || item.pair.missingRecordChecks > 0)
    ).length,
    errors
  };
}

function syncDeletionPairs() {
  if (syncInFlight) return syncInFlight;
  syncInFlight = syncDeletionPairsOnce().finally(() => {
    syncInFlight = null;
  });
  return syncInFlight;
}

function stageError(error, code, stage, hint) {
  if (error instanceof ClipError) return error;
  const message = String(error?.message || error || "未知错误");
  if (/auth|unauthori|permission|access token|999916|999914|20029/i.test(message)) {
    return new ClipError("FEISHU_AUTH_INVALID", "飞书授权已失效或权限不足", {
      stage,
      status: 401,
      hint: "请运行 lark-cli auth login --recommend 重新授权后再试。",
      cause: error
    });
  }
  return new ClipError(code, message, { stage, hint, cause: error });
}

async function handleClip(payload) {
  if (!payload || !payload.url) {
    throw new ClipError("PAGE_UNREADABLE", "未能读取当前网页地址", {
      stage: "extract",
      status: 400,
      hint: "请在普通 http 或 https 网页中使用扩展。"
    });
  }
  let workspace;
  try {
    workspace = await ensureWorkspace(payload.preferences);
  } catch (error) {
    throw stageError(error, "WORKSPACE_UNAVAILABLE", "workspace", "请检查本机服务、飞书授权和云盘权限。");
  }
  const title = normalizeTitle(payload);
  const blocks = cleanArticleBlocks(payload, title);
  const remoteImages = await hydrateRemoteImages(blocks, payload.url);
  const body = blocksToPlainText(blocks);
  if (!body && !blocks.some((block) => ["image", "table"].includes(block.type))) {
    throw new ClipError("ARTICLE_EMPTY", "未识别到可剪存的正文", {
      stage: "extract",
      status: 422,
      hint: "页面可能尚未加载完成、需要登录，或属于浏览器保护页面。"
    });
  }
  const enrichment = await enrichContent(payload, body);
  const metadata = buildClipMetadata(payload, enrichment.tags, enrichment.summary);
  try {
    await ensureTagOptions(workspace.base, metadata.tags);
  } catch (error) {
    throw stageError(error, "BASE_SCHEMA_FAILED", "base_schema", "请检查多维表格字段类型和编辑权限。");
  }
  let doc;
  try {
    doc = await createDoc(workspace.folder.token, title, blocks, metadata);
  } catch (error) {
    throw stageError(error, "DOC_WRITE_FAILED", "document", "云文档创建或图片上传失败，请稍后重试。");
  }
  let record;
  try {
    record = await createRecord(workspace.base, doc, title, body, metadata);
    await registerPair({
      recordId: record.id,
      docToken: doc.token || docTokenFromUrl(doc.url),
      docUrl: doc.url,
      baseToken: workspace.base.token,
      tableId: workspace.base.tableId
    });
  } catch (err) {
    if (!record?.id && doc.token) {
      await deleteClipDoc(doc.token).catch(() => {});
    }
    throw stageError(err, "BASE_WRITE_FAILED", "base_record", "多维表格记录写入失败，已回滚本次云文档。");
  }
  return {
    ok: true,
    folderName: workspace.preferences.folderName,
    folderPath: workspace.preferences.folderPath,
    baseName: workspace.preferences.baseName,
    docUrl: doc.url,
    baseUrl: workspace.base.url,
    recordId: record.id,
    imageCount: blocks.filter((block) => block.type === "image").length,
    tags: metadata.tags,
    summary: metadata.summary,
    aiSource: enrichment.source,
    publishedAt: metadata.publishedDisplay,
    warnings: remoteImages.failed
      ? [`${remoteImages.failed} 张图片由飞书按原网址尝试获取`]
      : []
  };
}

function pruneClipJobs(now = Date.now()) {
  for (const [id, job] of clipJobs) {
    if (now - job.updatedAt > CLIP_JOB_RETENTION_MS) clipJobs.delete(id);
  }
}

function clipJobPayload(job) {
  return {
    ok: true,
    job: {
      id: job.id,
      status: job.status,
      stage: job.stage,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      ...(job.result ? { result: job.result } : {}),
      ...(job.error ? { error: job.error } : {})
    }
  };
}

function createClipJob(payload, requestedId = "") {
  pruneClipJobs();
  const acceptedId = /^[a-f0-9-]{36}$/i.test(requestedId) ? requestedId : "";
  if (acceptedId && clipJobs.has(acceptedId)) return clipJobs.get(acceptedId);
  const now = Date.now();
  const job = {
    id: acceptedId || randomUUID(),
    status: "queued",
    stage: "queued",
    createdAt: now,
    updatedAt: now,
    result: null,
    error: null
  };
  clipJobs.set(job.id, job);
  queueMicrotask(async () => {
    job.status = "running";
    job.stage = "feishu";
    job.updatedAt = Date.now();
    try {
      job.result = await handleClip(payload);
      job.status = "succeeded";
      job.stage = "complete";
    } catch (error) {
      job.status = "failed";
      job.stage = error.stage || "unknown";
      job.error = {
        code: error.code || "INTERNAL_ERROR",
        message: error.message || "剪存失败",
        hint: error.hint || "请查看本机服务日志后重试。"
      };
    }
    job.updatedAt = Date.now();
  });
  return job;
}

async function waitForClipJob(job, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (["queued", "running"].includes(job.status) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  return job;
}

async function handleLookup(payload) {
  if (!payload?.url) {
    throw new ClipError("PAGE_UNREADABLE", "缺少要查询的网页地址", {
      stage: "lookup",
      status: 400
    });
  }
  let workspace;
  try {
    workspace = await ensureWorkspace(payload.preferences);
    const record = await findExistingClip(workspace.base, payload.url);
    return {
      ok: true,
      exists: Boolean(record),
      ...(record ? {
        recordId: record.recordId,
        title: record.title || "已剪存网页",
        docUrl: record.docUrl,
        baseUrl: workspace.base.url
      } : {})
    };
  } catch (error) {
    throw stageError(error, "DUPLICATE_LOOKUP_FAILED", "lookup", "跨设备查重暂时不可用，不影响继续剪存。");
  }
}

function requestOrigin(req) {
  return String(req.headers.origin || "").trim();
}

function isAllowedRequestOrigin(req) {
  const origin = requestOrigin(req);
  return !origin || /^(?:chrome-extension|moz-extension|extension):\/\/[a-z0-9_-]+$/i.test(origin);
}

function sendJson(req, res, status, body) {
  const text = JSON.stringify(body);
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Length": Buffer.byteLength(text),
    "X-Content-Type-Options": "nosniff"
  };
  const origin = requestOrigin(req);
  if (origin && isAllowedRequestOrigin(req)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  res.writeHead(status, headers);
  res.end(text);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 40_000_000) {
        reject(new Error("请求过大"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  if (!isAllowedRequestOrigin(req)) {
    sendJson(req, res, 403, { ok: false, error: "Forbidden origin" });
    return;
  }

  if (req.method === "OPTIONS") {
    sendJson(req, res, 200, { ok: true });
    return;
  }

  try {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(req, res, 200, {
        ok: true,
        name: "飞书剪存pro",
        folder: FOLDER_NAME,
        base: BASE_NAME,
        ai: {
          provider: AI_PROVIDER,
          enabled: AI_PROVIDER !== "none"
        },
        deletionSync: {
          enabled: true,
          intervalSeconds: Math.round(SYNC_INTERVAL_MS / 1000),
          confirmations: SYNC_CONFIRMATIONS
        }
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/folders") {
      try {
        const result = await listDriveFolders({
          parentToken: url.searchParams.get("parent_token") || "",
          refresh: url.searchParams.get("refresh") === "1"
        });
        sendJson(req, res, 200, { ok: true, ...result });
      } catch (error) {
        throw stageError(
          error,
          "FOLDER_LIST_FAILED",
          "folder_list",
          "请确认本机配套服务已启动，并重新完成飞书用户授权。"
        );
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/clip") {
      const payload = await readJson(req);
      const result = await handleClip(payload);
      sendJson(req, res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/clip-jobs") {
      const request = await readJson(req);
      const payload = request?.payload && typeof request.payload === "object" ? request.payload : request;
      const job = createClipJob(payload, String(request?.jobId || ""));
      sendJson(req, res, 202, clipJobPayload(job));
      return;
    }

    const clipJobMatch = req.method === "GET" && url.pathname.match(/^\/clip-jobs\/([a-f0-9-]+)$/i);
    if (clipJobMatch) {
      const job = clipJobs.get(clipJobMatch[1]);
      if (!job) {
        sendJson(req, res, 404, { ok: false, code: "CLIP_JOB_NOT_FOUND", error: "剪存任务不存在或已过期" });
        return;
      }
      if (url.searchParams.get("wait") === "1") await waitForClipJob(job);
      sendJson(req, res, 200, clipJobPayload(job));
      return;
    }

    if (req.method === "POST" && url.pathname === "/lookup") {
      const payload = await readJson(req);
      const result = await handleLookup(payload);
      sendJson(req, res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/sync") {
      const result = await syncDeletionPairs();
      sendJson(req, res, result.ok ? 200 : 500, result);
      return;
    }

    sendJson(req, res, 404, { ok: false, error: "Not found" });
  } catch (err) {
    const status = err instanceof ClipError ? err.status : 500;
    sendJson(req, res, status, {
      ok: false,
      code: err.code || "INTERNAL_ERROR",
      stage: err.stage || "unknown",
      error: err.message,
      hint: err.hint || "请查看本机服务日志后重试。"
    });
  }
});

if (process.env.FEISHU_CLIPPER_NO_LISTEN !== "1") {
  server.listen(PORT, HOST, () => {
    console.log(`飞书剪存pro服务已启动：http://${HOST}:${PORT}`);
  });
  setTimeout(() => {
    syncDeletionPairs().catch((err) => console.error("首次删除同步失败：", err.message));
  }, 2_000);
  setInterval(() => {
    syncDeletionPairs()
      .then((result) => {
        if (result.deletedDocs || result.deletedRecords) {
          console.log(
            `删除同步完成：云文档 ${result.deletedDocs} 个，多维表格记录 ${result.deletedRecords} 条`
          );
        }
      })
      .catch((err) => console.error("删除同步失败：", err.message));
  }, SYNC_INTERVAL_MS);
}

export {
  blocksToPlainText,
  buildBaseRecordPayload,
  buildClipMetadata,
  buildDocXml,
  cleanArticleBlocks,
  cleanArticleText,
  docTokenFromUrl,
  detectedImageMime,
  evaluatePairState,
  extractRecordPage,
  getDocStates,
  hydrateRemoteImages,
  inferTags,
  isAllowedRequestOrigin,
  isNoiseLine,
  listDriveFolders,
  mergeTagOptions,
  normalizeComparableUrl,
  normalizePreferences,
  normalizeAiEnrichment,
  normalizePublishedAt,
  normalizeFolderParentToken,
  normalizeTitle,
  recordExistsFromGet,
  removeMenuRuns,
  prepareEmbeddedImages
};
