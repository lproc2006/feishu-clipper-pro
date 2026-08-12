import assert from "node:assert/strict";
import test from "node:test";

const {
  blocksToPlainText,
  buildBaseRecordPayload,
  buildClipMetadata,
  buildDocXml,
  cleanArticleBlocks,
  detectedImageMime,
  docTokenFromUrl,
  evaluatePairState,
  extractRecordPage,
  inferTags,
  isAllowedRequestOrigin,
  mergeTagOptions,
  normalizeAiEnrichment,
  normalizeComparableUrl,
  normalizeFolderParentToken,
  normalizePreferences,
  normalizePublishedAt,
  normalizeTitle,
  recordExistsFromGet,
  prepareEmbeddedImages
} = await import("./server.js");

test("local service accepts extension origins and rejects ordinary websites", () => {
  assert.equal(isAllowedRequestOrigin({ headers: {} }), true);
  assert.equal(
    isAllowedRequestOrigin({ headers: { origin: "chrome-extension://abcdefghijklmnop" } }),
    true
  );
  assert.equal(
    isAllowedRequestOrigin({ headers: { origin: "https://malicious.example" } }),
    false
  );
});

test("article title is the single source for both destinations", () => {
  assert.equal(
    normalizeTitle({ articleTitle: "全国百佳，成功入选！", title: "错误的网站标题 - 某某网" }),
    "全国百佳，成功入选！"
  );
});

test("heuristic tags are content-specific and limited to three short tags", () => {
  const policyTags = inferTags({
    articleTitle: "国务院关于《扩大消费“十五五”规划》的批复",
    description: "原则同意扩大消费十五五规划，请认真组织实施。",
    text: "深入实施提振消费专项行动，扩大服务消费，升级商品消费。"
  });
  assert.deepEqual(policyTags, ["扩大消费", "十五五规划"]);

  const creditTags = inferTags({
    articleTitle: "构建履约信用综合监管机制，持续优化营商环境",
    text: "完善信用信息归集、信用监管和信用修复机制，持续优化营商环境。"
  });
  assert.deepEqual(creditTags, ["信用建设", "营商环境", "市场监管"]);
  assert.ok(creditTags.length <= 3);
  assert.ok(creditTags.every((tag) => tag.length <= 5));
  assert.equal(creditTags.includes("资料"), false);
  assert.equal(creditTags.includes("工作"), false);

  const aiTags = inferTags({
    articleTitle: "生成式人工智能赋能政务服务场景创新",
    text: "多地探索大模型在政务服务和行政审批中的应用，提升办事效率。"
  });
  assert.deepEqual(new Set(aiTags), new Set(["人工智能", "政务服务"]));
  assert.notDeepEqual(aiTags, policyTags);
  assert.notDeepEqual(aiTags, creditTags);
});

test("AI enrichment keeps a useful summary and two to three short focused tags", () => {
  const payload = {
    articleTitle: "全国就业公共服务地图发布",
    text: "全国就业公共服务地图汇集就业服务机构、零工市场和招聘活动信息，覆盖多类群体与用人单位的查询需求。"
  };
  const rewrittenSummary = "该服务将分散在各地的公共就业资源纳入统一地图入口，使劳动者、用人单位和基层服务人员能够按区域查找机构、岗位与招聘活动。其价值不仅在于集中展示信息，还在于降低求职与招聘两端的搜索成本，帮助用户快速识别附近可用服务。整体上，这一数字化入口强化了就业资源的可达性和匹配效率，也为后续更新服务网点、完善供需对接提供了更清晰的组织基础。";
  const enrichment = normalizeAiEnrichment(
    {
      summary: rewrittenSummary,
      tags: ["政策", "就业服务", "零工市场", "招聘信息", "公共就业", "数据平台", "额外标签", "待整理"],
      source: "ollama"
    },
    payload,
    payload.text
  );
  assert.equal(enrichment.source, "ollama");
  assert.equal(enrichment.summary, rewrittenSummary);
  assert.ok(enrichment.summary.length >= 100 && enrichment.summary.length <= 200);
  assert.ok(enrichment.tags.length >= 2 && enrichment.tags.length <= 3);
  assert.ok(enrichment.tags.every((tag) => tag.length <= 5));
  assert.equal(enrichment.tags.includes("政策"), false);
  assert.equal(enrichment.tags.includes("待整理"), false);
  assert.equal(new Set(enrichment.tags).size, enrichment.tags.length);
});

test("AI fallback still returns two reviewable tags", () => {
  const enrichment = normalizeAiEnrichment(
    {},
    {
      articleTitle: "公共就业服务平台优化实施方案",
      text: "方案聚焦就业服务、岗位匹配和基层服务网点建设，要求完善信息归集、实施进度跟踪与服务质量评估。"
    },
    "方案聚焦就业服务、岗位匹配和基层服务网点建设，要求完善信息归集、实施进度跟踪与服务质量评估。"
  );
  assert.ok(enrichment.tags.length >= 2 && enrichment.tags.length <= 3);
  assert.ok(enrichment.tags.every((tag) => tag.length <= 5));
  assert.ok(enrichment.summary.length >= 100 && enrichment.summary.length <= 200);
  assert.match(enrichment.summary, /[。！？]$/);
  assert.doesNotMatch(enrichment.summary, /正文包含|摘要仅|材料的信息价值|内容主要从|阅读时应重点把握/);
  assert.equal(enrichment.source, "fallback");
});

test("AI summaries reject meta filler and always end at a complete sentence", () => {
  const body = [
    "南阳市围绕先进制造业发展完善企业服务机制，集中协调项目建设中的审批、用地和融资事项。",
    "当地建立重点项目清单和跨部门会商机制，按照问题类型明确责任单位、办理时限和反馈方式。",
    "相关部门同步优化线上申报流程，减少企业重复提交材料，并为重点产业链企业提供全周期服务。",
    "新机制推动诉求受理、转办、跟踪和回访形成闭环，提升项目落地效率和企业办事体验。"
  ].join("");
  const filler = "正文包含时间、数量或其他可核验信息，摘要仅概括其作用而不直接复制数据段落。材料的信息价值主要体现在对核心事项的集中说明与结构化呈现。内容主要从若干方面进行说明，阅读时应重点把握相关关系。";
  const enrichment = normalizeAiEnrichment(
    { summary: filler, tags: ["企业服务", "项目建设"], source: "ollama" },
    { articleTitle: "南阳完善重点项目企业服务机制", text: body },
    body
  );
  assert.equal(enrichment.source, "fallback");
  assert.ok(enrichment.summary.length >= 100 && enrichment.summary.length <= 200);
  assert.match(enrichment.summary, /[。！？]$/);
  assert.doesNotMatch(enrichment.summary, /正文包含|摘要仅|材料的信息价值|内容主要从|阅读时应重点把握/);
  assert.match(enrichment.summary, /企业服务|项目建设|审批|融资|跨部门|产业链/);
});

test("overlong AI summaries are trimmed only at a sentence boundary", () => {
  const body = "地方围绕政务服务数字化升级统一办事入口，优化事项清单和跨部门数据协同，提升企业群众办事效率。";
  const summary = [
    "地方统一线上办事入口，并围绕高频事项重构申报流程，使企业群众能够在一个平台查询条件、提交材料和跟踪进度。",
    "部门之间通过共享基础数据减少重复填报，同时明确事项清单、办理时限和反馈责任，推动线上线下服务标准保持一致。",
    "后续将根据使用反馈持续调整功能，并加强服务质量监测，让数字化改革更准确地回应实际办事需求。",
    "这一句超过两百字边界后不应留下任何残缺内容，而且不会完整进入最终结果；其后还附有大量关于技术架构、平台运行、人员培训、服务评价、数据治理和安全管理的补充说明，用来确保整个测试输入明显超过规定的字数上限。"
  ].join("");
  const enrichment = normalizeAiEnrichment(
    { summary, tags: ["政务服务", "数据协同"], source: "ollama" },
    { articleTitle: "政务服务数字化升级", text: body },
    body
  );
  assert.equal(enrichment.source, "ollama");
  assert.ok(enrichment.summary.length >= 100 && enrichment.summary.length <= 200);
  assert.match(enrichment.summary, /[。！？]$/);
  assert.doesNotMatch(enrichment.summary, /残缺内容/);
});

test("verbatim AI summaries are rejected and rewritten locally", () => {
  const body = "各地将建立统一的企业服务响应机制，通过流程再造、数据共享和部门协同减少重复提交材料，提升政策兑现与诉求办理效率。";
  const copied = `${body}${body}${body}`.slice(0, 200);
  const enrichment = normalizeAiEnrichment(
    { summary: copied, tags: ["企业服务", "数据共享"], source: "ollama" },
    { articleTitle: "企业服务机制优化", text: body },
    body
  );
  assert.equal(enrichment.source, "fallback");
  assert.notEqual(enrichment.summary, copied);
  assert.ok(enrichment.summary.length >= 100 && enrichment.summary.length <= 200);
  assert.ok(enrichment.tags.length >= 2 && enrichment.tags.length <= 3);
});

test("tag options are deduplicated and missing content tags are added", () => {
  const merged = mergeTagOptions(
    {
      options: [
        { name: "营商环境", hue: "Green", lightness: "Lighter" },
        { name: "企业服务", hue: "Orange", lightness: "Lighter" },
        { name: "营商环境", hue: "Blue", lightness: "Dark" }
      ]
    },
    ["扩大消费", "十五五规划", "营商环境"]
  );

  assert.equal(merged.changed, true);
  assert.deepEqual(
    merged.options.map((option) => option.name),
    ["营商环境", "企业服务", "扩大消费", "十五五规划"]
  );
  assert.equal(new Set(merged.options.map((option) => option.name)).size, merged.options.length);
});

test("linked navigation cluster is removed while article blocks and image stay ordered", () => {
  const payload = {
    articleTitle: "信用建设推动高质量发展",
    url: "https://example.gov.cn/article/1",
    blocks: [
      { type: "heading", level: 1, text: "信用建设推动高质量发展" },
      { type: "paragraph", text: "信用公示", linkDensity: 1 },
      { type: "paragraph", text: "信用服务", linkDensity: 1 },
      { type: "paragraph", text: "信用监管", linkDensity: 1 },
      { type: "paragraph", text: "信易+", linkDensity: 1 },
      { type: "paragraph", text: "政策法规", linkDensity: 1 },
      { type: "paragraph", text: "今年以来，全市持续完善信用服务体系，推动重点项目加快落地。" },
      { type: "image", src: "https://images.example.com/report/photo.jpg", width: 1200, height: 800 },
      { type: "paragraph", text: "相关举措已覆盖多个行业，并形成常态化工作机制。" }
    ]
  };

  const blocks = cleanArticleBlocks(payload);
  assert.deepEqual(blocks.map((block) => block.type), ["paragraph", "image", "paragraph"]);
  const lines = blocksToPlainText(blocks).split("\n");
  assert.equal(lines.includes("信用公示"), false);
  assert.equal(lines.includes("信用服务"), false);
  assert.equal(lines.includes("信用监管"), false);
  assert.equal(lines.includes("信易+"), false);
  assert.match(buildDocXml(normalizeTitle(payload), blocks), /<img href="https:\/\/images\.example\.com\/report\/photo\.jpg"/);
});

test("separator-delimited plain menu is removed without site-specific keywords", () => {
  const payload = {
    articleTitle: "城市更新年度观察",
    url: "https://example.com/article/2",
    text: [
      "栏目甲",
      "|",
      "栏目乙",
      "|",
      "栏目丙",
      "栏目丁",
      "栏目戊",
      "这是文章第一段，介绍城市更新项目的进展与年度目标。",
      "这是文章第二段，说明下一阶段的具体安排与实施计划。"
    ].join("\n")
  };

  const text = blocksToPlainText(cleanArticleBlocks(payload));
  assert.doesNotMatch(text, /栏目甲|栏目乙|栏目丙|栏目丁|栏目戊/);
  assert.match(text, /这是文章第一段/);
  assert.match(text, /这是文章第二段/);
});

test("document XML uses the exact article title and preserves basic formatting", () => {
  const metadata = buildClipMetadata(
    {
      url: "https://example.com/articles/42",
      publishedAt: "2025-09-12",
      publisher: "示例市发展和改革委员会"
    },
    ["政策", "案例", "资料"],
    "这是由 AI 生成并校验后的内容摘要。"
  );
  const xml = buildDocXml(
    "原始文章标题",
    [
      { type: "heading", level: 1, text: "分节标题" },
      { type: "paragraph", text: "正文 A & B" },
      { type: "list_item", text: "第一项", ordered: false },
      { type: "list_item", text: "第二项", ordered: false },
      { type: "quote", text: "引用内容" }
    ],
    metadata
  );

  assert.match(xml, /^<title align="center">原始文章标题<\/title>/);
  assert.match(xml, /<b>原网页链接：<\/b><a href="https:\/\/example\.com\/articles\/42">/);
  assert.match(xml, /<b>标签：<\/b>政策、案例、资料/);
  assert.match(xml, /<b>发布时间：<\/b>2025-09-12/);
  assert.match(xml, /<b>发布单位：<\/b>示例市发展和改革委员会/);
  assert.match(xml, /<b>内容摘要：<\/b>这是由 AI 生成并校验后的内容摘要/);
  assert.match(xml, /<h2>分节标题<\/h2>/);
  assert.match(xml, /<p>　　正文 A &amp; B<\/p>/);
  assert.match(xml, /<ul><li>第一项<\/li><li>第二项<\/li><\/ul>/);
  assert.match(xml, /<blockquote>引用内容<\/blockquote>/);
});

test("document paragraphs use Chinese indentation while source alignment is preserved", () => {
  const xml = buildDocXml("排版测试", [
    { type: "paragraph", text: "普通正文" },
    { type: "paragraph", text: "居中落款", align: "center" },
    { type: "paragraph", text: "右对齐日期", align: "right" },
    { type: "formula", text: "E = mc^2" },
    { type: "image", src: "https://example.com/chart.png", alt: "示意图" }
  ]);
  assert.match(xml, /<title align="center">排版测试<\/title>/);
  assert.match(xml, /<p>　　普通正文<\/p>/);
  assert.match(xml, /<p align="center">居中落款<\/p>/);
  assert.match(xml, /<p align="right">右对齐日期<\/p>/);
  assert.match(xml, /<p align="center"><latex>E = mc\^2<\/latex><\/p>/);
  assert.match(xml, /<p align="center"><img href="https:\/\/example\.com\/chart\.png"/);
});

test("Base keeps the summary in its own field and body contains body only", () => {
  const payload = buildBaseRecordPayload(
    { url: "https://example.feishu.cn/docx/doc1" },
    "独立摘要字段测试",
    "这是正文，不应带有内容摘要前缀。",
    {
      publishedAt: "2026-08-12 00:00:00",
      publisher: "示例单位",
      sourceUrl: "https://example.com/article",
      tags: ["企业服务", "项目建设"],
      summary: "这是单独写入内容摘要字段的完整摘要。"
    }
  );
  const summaryIndex = payload.fields.indexOf("内容摘要");
  const bodyIndex = payload.fields.indexOf("正文");
  assert.equal(payload.rows[0][summaryIndex], "这是单独写入内容摘要字段的完整摘要。");
  assert.equal(payload.rows[0][bodyIndex], "这是正文，不应带有内容摘要前缀。");
});

test("browser-captured images are staged locally for protected source sites", () => {
  const payload = {
    articleTitle: "受保护图片测试",
    blocks: [
      {
        type: "image",
        src: "https://example.gov.cn/protected/image.png",
        width: 606,
        height: 693,
        dataUrl: `data:image/png;base64,${Buffer.from("image-bytes").toString("base64")}`
      }
    ]
  };
  const blocks = cleanArticleBlocks(payload);
  assert.match(blocks[0].dataUrl, /^data:image\/png;base64,/);
  const prepared = prepareEmbeddedImages(blocks);
  assert.equal(prepared.assets.length, 1);
  assert.match(prepared.blocks[0].placeholder, /^FEISHU_CLIPPER_IMAGE_[a-f0-9]+$/);
  assert.match(buildDocXml("受保护图片测试", prepared.blocks), /<p align="center">FEISHU_CLIPPER_IMAGE_[a-f0-9]+<\/p>/);
});

test("image bytes override incorrect server MIME declarations", () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  assert.equal(detectedImageMime("image/jpeg", "https://example.gov.cn/chart.png", png), "image/png");
});

test("image captions, code languages, formulas, and GIF data stay structured", () => {
  const blocks = cleanArticleBlocks({
    articleTitle: "格式保真测试",
    blocks: [
      {
        type: "image",
        src: "https://example.com/chart.gif",
        caption: "图 1：趋势变化",
        width: 800,
        height: 450,
        dataUrl: `data:image/gif;base64,${Buffer.from("gif-bytes").toString("base64")}`
      },
      { type: "code", text: "const answer = 42;", language: "javascript" },
      { type: "formula", text: "E = mc^2" }
    ]
  });
  const prepared = prepareEmbeddedImages(blocks);
  assert.equal(prepared.assets[0].caption, "图 1：趋势变化");
  assert.match(prepared.assets[0].fileName, /\.gif$/);
  const xml = buildDocXml("格式保真测试", prepared.blocks);
  assert.match(xml, /<pre lang="javascript"><code>const answer = 42;<\/code><\/pre>/);
  assert.match(xml, /<p align="center"><latex>E = mc\^2<\/latex><\/p>/);
});

test("remote images carry their caption in the image block", () => {
  const xml = buildDocXml("图片题注", [
    {
      type: "image",
      src: "https://example.com/photo.jpg",
      caption: "会议现场",
      width: 1000,
      height: 667
    }
  ]);
  assert.match(xml, /<img href="https:\/\/example\.com\/photo\.jpg"[^>]+caption="会议现场"/);
  assert.doesNotMatch(xml, /<em>会议现场<\/em>/);
});

test("cross-device duplicate URLs ignore tracking parameters and fragments", () => {
  assert.equal(
    normalizeComparableUrl("https://example.com/article/?b=2&utm_source=test&a=1#top"),
    "https://example.com/article?a=1&b=2"
  );
  assert.equal(
    normalizeComparableUrl("https://example.com/article?a=1&b=2"),
    "https://example.com/article?a=1&b=2"
  );
});

test("destination preferences keep defaults and reject unsafe names", () => {
  assert.deepEqual(normalizePreferences({}), {
    folderMode: "managed",
    folderToken: "",
    folderName: "飞书剪存",
    folderPath: "云盘根目录 / 飞书剪存",
    baseName: "网页剪存库"
  });
  assert.deepEqual(normalizePreferences({ folderName: "政策资料", baseName: "政策库" }), {
    folderMode: "managed",
    folderToken: "",
    folderName: "飞书剪存",
    folderPath: "云盘根目录 / 飞书剪存",
    baseName: "政策库"
  });
  assert.deepEqual(normalizePreferences({
    folderMode: "existing",
    folderToken: "KANjfgPiBlqLL4dK6o3cHLspnHC",
    folderName: "飞书剪存",
    folderPath: "云盘根目录 / 飞书剪存"
  }), {
    folderMode: "existing",
    folderToken: "KANjfgPiBlqLL4dK6o3cHLspnHC",
    folderName: "飞书剪存",
    folderPath: "云盘根目录 / 飞书剪存",
    baseName: "网页剪存库"
  });
  assert.deepEqual(normalizePreferences({ folderName: "../其他目录" }), {
    folderMode: "managed",
    folderToken: "",
    folderName: "飞书剪存",
    folderPath: "云盘根目录 / 飞书剪存",
    baseName: "网页剪存库"
  });
  assert.throws(() => normalizePreferences({ folderMode: "existing", folderToken: "bad" }), /所选飞书云盘文件夹无效/);
});

test("folder browsing accepts root and valid folder tokens only", () => {
  assert.equal(normalizeFolderParentToken(""), "");
  assert.equal(
    normalizeFolderParentToken("KANjfgPiBlqLL4dK6o3cHLspnHC"),
    "KANjfgPiBlqLL4dK6o3cHLspnHC"
  );
  assert.throws(() => normalizeFolderParentToken("../bad"), /文件夹标识无效/);
});

test("sharing controls and editorial credits never enter the saved body", () => {
  const blocks = cleanArticleBlocks({
    articleTitle: "正文清理测试",
    blocks: [
      { type: "paragraph", text: "这是需要保留的文章正文。" },
      { type: "paragraph", text: "分享到：" },
      { type: "paragraph", text: "来源：某单位" },
      { type: "paragraph", text: "编辑丨张三" },
      { type: "paragraph", text: "审核丨李四" }
    ]
  });
  assert.equal(blocksToPlainText(blocks), "这是需要保留的文章正文。");
});

test("publication time is normalized once for document and Base", () => {
  assert.deepEqual(normalizePublishedAt("发布时间：2025年9月12日 15:03"), {
    value: "2025-09-12 00:00:00",
    display: "2025-09-12"
  });
  assert.deepEqual(normalizePublishedAt("2025-09-12"), {
    value: "2025-09-12 00:00:00",
    display: "2025-09-12"
  });
  assert.deepEqual(normalizePublishedAt("未提供"), { value: null, display: "未识别" });
});

test("confirmed document or Base record deletion cascades immediately", () => {
  const pair = {
    recordId: "rec1",
    docToken: "doc1",
    missingDocChecks: 0,
    missingRecordChecks: 0
  };

  const docMissing = evaluatePairState(pair, { recordExists: true, docState: "missing" });
  assert.equal(docMissing.action, "delete_record");

  const recordMissing = evaluatePairState(pair, { recordExists: false, docState: "exists" });
  assert.equal(recordMissing.action, "delete_doc");
});

test("web tables keep structure and formatting in the document and Base body", () => {
  const blocks = cleanArticleBlocks({
    articleTitle: "表格测试",
    url: "https://example.com/table",
    blocks: [
      {
        type: "table",
        caption: "年度数据",
        columnWidths: [120, 180],
        rows: [
          [
            { text: "年度", header: true, backgroundColor: "gray" },
            { text: "案例数", header: true, backgroundColor: "rgb(240,240,240)" }
          ],
          [
            { text: "2025", rowspan: 2, align: "center", verticalAlign: "middle" },
            { text: "18", colspan: 2 }
          ]
        ]
      }
    ]
  });
  assert.equal(blocks[0].type, "table");
  const xml = buildDocXml("表格测试", blocks);
  assert.match(xml, /<table>/);
  assert.match(xml, /<col width="120"\/>/);
  assert.match(xml, /<th background-color="gray">年度<\/th>/);
  assert.match(xml, /rowspan="2"/);
  assert.match(xml, /colspan="2"/);
  assert.match(blocksToPlainText(blocks), /\| 年度 \| 案例数 \|/);
});

test("unknown document state never triggers deletion and successful checks reset counters", () => {
  const pair = {
    recordId: "rec1",
    docToken: "doc1",
    missingDocChecks: 1,
    missingRecordChecks: 1
  };
  const unknown = evaluatePairState(pair, { recordExists: true, docState: "unknown" });
  assert.equal(unknown.action, "none");
  assert.equal(unknown.pair.missingDocChecks, 1);
  assert.equal(unknown.pair.missingRecordChecks, 0);

  const healthy = evaluatePairState(unknown.pair, { recordExists: true, docState: "exists" });
  assert.equal(healthy.action, "none");
  assert.equal(healthy.pair.missingDocChecks, 0);
});

test("record pages restore document-record pairs from the document link field", () => {
  const page = extractRecordPage({
    data: {
      fields: ["飞书文档链接"],
      record_id_list: ["recA"],
      data: [
        [
          "[https://my.feishu.cn/docx/DocTokenA](https://my.feishu.cn/docx/DocTokenA)"
        ]
      ],
      has_more: false
    }
  });
  assert.deepEqual(page.records, [
    { recordId: "recA", docUrl: "https://my.feishu.cn/docx/DocTokenA" }
  ]);
  assert.equal(docTokenFromUrl(page.records[0].docUrl), "DocTokenA");
});

test("post-delete record readback recognizes Feishu record_not_found responses", () => {
  assert.equal(
    recordExistsFromGet(
      {
        data: {
          record_id_list: ["recA"],
          record_not_found: ["recA"],
          data: [[null]]
        }
      },
      "recA"
    ),
    false
  );
  assert.equal(
    recordExistsFromGet({ data: { record_id_list: ["recA"], data: [["value"]] } }, "recA"),
    true
  );
});
