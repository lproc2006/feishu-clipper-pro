import { spawn } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { URL } from "node:url";

const PORT = Number(process.env.FEISHU_CLIPPER_PORT || 8787);
const HOST = "127.0.0.1";
const FOLDER_NAME = process.env.FEISHU_CLIPPER_FOLDER || "飞书剪存";
const BASE_NAME = process.env.FEISHU_CLIPPER_BASE || "网页剪存库";
const TABLE_NAME = process.env.FEISHU_CLIPPER_TABLE || "剪存记录";
const TIME_ZONE = "Asia/Shanghai";
const SYNC_CONFIRMATIONS = 1;
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

let workspaceCache = null;
let pairRegistry = null;
let registryQueue = Promise.resolve();
let tagOptionQueue = Promise.resolve();
let syncInFlight = null;

function runLark(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("lark-cli", args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
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
        resolve(stdout.trim() ? JSON.parse(stdout) : {});
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
    JSON.stringify({ folder_token: folderToken, page_size: 50 }),
    "--as",
    "user",
    "--format",
    "json"
  ]);
  return extractDriveFiles(result).map(normalizeDriveFile).filter(Boolean);
}

async function findDriveFileInFolder(folderToken, name, expectedType) {
  const files = await listDriveFiles(folderToken);
  return files.find((file) => file.name === name && file.type === expectedType) || null;
}

async function ensureFolder() {
  const existing = await findDriveFileInFolder("", FOLDER_NAME, "folder").catch(() => null);
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
    FOLDER_NAME,
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
      description: "根据剪存内容自动提取的主题标签，最多三个"
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
  const visibleFields = ["标题", "发布时间", "发布单位", "原网页链接", "飞书文档链接", "标签", "正文"];
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

async function ensureBase(folderToken) {
  const existing = await findDriveFileInFolder(folderToken, BASE_NAME, "bitable").catch(() => null);
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
    BASE_NAME,
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

async function ensureWorkspace() {
  if (workspaceCache?.folder?.token && workspaceCache?.base?.token) return workspaceCache;
  const folder = await ensureFolder();
  if (!folder.token) throw new Error("未能获取飞书剪存文件夹 token");
  const base = await ensureBase(folder.token);
  if (!base.token) throw new Error("未能获取网页剪存库 Base token");
  workspaceCache = { folder, base };
  return workspaceCache;
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
    if (["image", "table"].includes(block.type) || !isMenuLikeBlock(block)) {
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
    if (["image", "table"].includes(block.type) || (!separator && !shortLabel)) {
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
      const width = Number(source.width || 0);
      const height = Number(source.height || 0);
      if (width > 0 && height > 0 && (width < 120 || height < 80)) continue;
      normalized.push({
        type,
        src,
        alt: normalizeBlockText(source.alt),
        width,
        height
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
      linkDensity: Math.min(1, Math.max(0, Number(source.linkDensity || 0)))
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
    .filter((block) => ["image", "table"].includes(block.type) || !isSeparatorLine(block.text))
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
    if (normalized.length < 2 || normalized.length > 10 || genericTags.has(normalized)) return;
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
    if (tags.length === 3) break;
  }

  if (!tags.length) {
    const fallback = title
      .replace(/^.{2,40}?(?:关于|印发)/, "")
      .replace(/(?:通知|意见|办法|规定|方案|报告|公告|通告|批复)$/g, "")
      .replace(/[《》“”"'‘’（）()\s]/g, "")
      .trim();
    if (fallback.length >= 2 && fallback.length <= 10) tags.push(fallback);
  }

  return tags.length ? tags.slice(0, 3) : ["待整理"];
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

function buildClipMetadata(payload, tags) {
  const sourceUrl = safeHttpUrl(payload.url);
  const publication = normalizePublishedAt(payload.publishedAt);
  const publisher = truncate(String(payload.publisher || "").replace(/\s+/g, " ").trim(), 100) || "未识别";
  return {
    sourceUrl,
    tags: [...new Set(tags || [])],
    publishedAt: publication.value,
    publishedDisplay: publication.display,
    publisher
  };
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
  const content = [
    `<title>${escapeXml(title)}</title>`,
    '<callout background-color="light-blue" border-color="blue">',
    `<p><b>发布时间：</b>${escapeXml(publishedDisplay)}</p>`,
    `<p><b>发布单位：</b>${escapeXml(publisher)}</p>`,
    sourceUrl
      ? `<p><b>原网页链接：</b><a href="${escapeXmlAttribute(sourceUrl)}">${escapeXml(sourceUrl)}</a></p>`
      : "<p><b>原网页链接：</b>未识别</p>",
    `<p><b>标签：</b>${escapeXml(tagText)}</p>`,
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
      content.push(
        `<img href="${escapeXmlAttribute(block.src)}" name="${escapeXmlAttribute(imageName(block))}"/>`
      );
    } else if (block.type === "table") {
      const table = tableToDocXml(block);
      if (table) content.push(table);
    } else if (block.type === "heading") {
      const level = Math.min(4, Math.max(2, block.level || 2));
      content.push(`<h${level}>${escapeXml(block.text)}</h${level}>`);
    } else if (block.type === "quote") {
      content.push(`<blockquote>${escapeXml(block.text)}</blockquote>`);
    } else if (block.type === "code") {
      content.push(`<pre><code>${escapeXml(block.text)}</code></pre>`);
    } else if (block.type === "caption") {
      content.push(`<p align="center"><em>${escapeXml(block.text)}</em></p>`);
    } else {
      content.push(`<p>${escapeXml(block.text)}</p>`);
    }
  }
  flushList();
  if (content.length === 1) content.push("<p></p>");
  return content.join("\n");
}

async function createDoc(folderToken, title, blocks, metadata) {
  const content = buildDocXml(title, blocks, metadata);
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
  return {
    token: doc.document_id || extractToken(doc),
    url: extractUrl(doc)
  };
}

async function createRecord(base, doc, title, body, metadata) {
  const fields = [
    "标题",
    "发布时间",
    "发布单位",
    "原网页链接",
    "飞书文档链接",
    "标签",
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
      truncate(body, 50000)
    ]
  ];

  const result = await runLark([
    "base",
    "+record-batch-create",
    "--base-token",
    base.token,
    "--table-id",
    base.tableId,
    "--json",
    JSON.stringify({ fields, rows }),
    "--as",
    "user",
    "--format",
    "json"
  ]);

  const record =
    findDeep(result, (item) => Boolean(item.record_id || item.record_id_list)) ||
    result.data ||
    result;
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
  const records = [];

  for (let index = 0; index < Math.max(rows.length, recordIds.length); index += 1) {
    const row = rows[index];
    const recordId =
      recordIds[index] || row?.record_id || row?.recordId || row?.id || "";
    const rawLink = Array.isArray(row)
      ? row[linkIndex >= 0 ? linkIndex : 0]
      : row?.fields?.["飞书文档链接"] ?? row?.["飞书文档链接"];
    const docUrl = extractCellUrl(rawLink);
    if (recordId && docUrl) records.push({ recordId, docUrl });
  }

  return {
    records,
    count: Math.max(rows.length, recordIds.length),
    hasMore: Boolean(page?.has_more)
  };
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
  const records = await listAllClipRecords(workspace.base);

  const pairs = await withPairRegistry((registry) => {
    for (const [recordId, docUrl] of records) {
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

  const docTokens = [...new Set(pairs.map((pair) => pair.docToken).filter(Boolean))];
  const docStates = await getDocStates(docTokens);
  const evaluations = pairs.map((pair) => ({
    original: pair,
    ...evaluatePairState(pair, {
      recordExists: records.has(pair.recordId),
      docState: docStates.get(pair.docToken) || "unknown"
    })
  }));
  const completed = new Set();
  const errors = [];
  let deletedDocs = 0;
  let deletedRecords = 0;

  for (const evaluation of evaluations) {
    try {
      if (evaluation.action === "delete_doc") {
        await deleteClipDoc(evaluation.pair.docToken);
        deletedDocs += 1;
        completed.add(evaluation.pair.recordId);
      } else if (evaluation.action === "delete_record") {
        await deleteClipRecord(workspace.base, evaluation.pair.recordId);
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

async function handleClip(payload) {
  if (!payload || !payload.url) throw new Error("缺少网页 URL");
  const workspace = await ensureWorkspace();
  const title = normalizeTitle(payload);
  const blocks = cleanArticleBlocks(payload, title);
  const body = blocksToPlainText(blocks);
  const tags = inferTags(payload);
  const metadata = buildClipMetadata(payload, tags);
  await ensureTagOptions(workspace.base, metadata.tags);
  const doc = await createDoc(workspace.folder.token, title, blocks, metadata);
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
    throw err;
  }
  return {
    ok: true,
    folderName: FOLDER_NAME,
    baseName: BASE_NAME,
    docUrl: doc.url,
    baseUrl: workspace.base.url,
    recordId: record.id,
    imageCount: blocks.filter((block) => block.type === "image").length,
    tags: metadata.tags,
    publishedAt: metadata.publishedDisplay
  };
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
      if (body.length > 2_000_000) {
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
        deletionSync: {
          enabled: true,
          intervalSeconds: Math.round(SYNC_INTERVAL_MS / 1000),
          confirmations: SYNC_CONFIRMATIONS
        }
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/clip") {
      const payload = await readJson(req);
      const result = await handleClip(payload);
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
    sendJson(req, res, 500, { ok: false, error: err.message });
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
  buildClipMetadata,
  buildDocXml,
  cleanArticleBlocks,
  cleanArticleText,
  docTokenFromUrl,
  evaluatePairState,
  extractRecordPage,
  getDocStates,
  inferTags,
  isAllowedRequestOrigin,
  isNoiseLine,
  mergeTagOptions,
  normalizePublishedAt,
  normalizeTitle,
  recordExistsFromGet,
  removeMenuRuns
};
