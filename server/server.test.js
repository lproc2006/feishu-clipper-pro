import assert from "node:assert/strict";
import test from "node:test";

const {
  blocksToPlainText,
  buildClipMetadata,
  buildDocXml,
  cleanArticleBlocks,
  docTokenFromUrl,
  evaluatePairState,
  extractRecordPage,
  inferTags,
  isAllowedRequestOrigin,
  mergeTagOptions,
  normalizeAiEnrichment,
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

test("heuristic tags are content-specific and limited to five", () => {
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
  assert.ok(creditTags.length <= 5);
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

test("AI enrichment keeps a useful summary and two to five focused tags", () => {
  const payload = {
    articleTitle: "全国就业公共服务地图发布",
    text: "全国就业公共服务地图汇集就业服务机构、零工市场和招聘活动信息。"
  };
  const enrichment = normalizeAiEnrichment(
    {
      summary: "全国就业公共服务地图整合公共就业机构、零工市场和招聘活动信息，为劳动者及用人单位提供统一、便捷的就业资源查询入口。",
      tags: ["政策", "就业服务", "零工市场", "招聘信息", "公共就业", "数据平台", "额外标签", "待整理"],
      source: "ollama"
    },
    payload,
    payload.text
  );
  assert.equal(enrichment.source, "ollama");
  assert.match(enrichment.summary, /就业资源查询入口/);
  assert.ok(enrichment.tags.length >= 2 && enrichment.tags.length <= 5);
  assert.equal(enrichment.tags.includes("政策"), false);
  assert.equal(enrichment.tags.includes("待整理"), false);
  assert.equal(new Set(enrichment.tags).size, enrichment.tags.length);
});

test("AI fallback still returns two reviewable tags", () => {
  const enrichment = normalizeAiEnrichment(
    {},
    { articleTitle: "简短记录", text: "只有一段很短的内容。" },
    "只有一段很短的内容。"
  );
  assert.ok(enrichment.tags.length >= 2 && enrichment.tags.length <= 5);
  assert.equal(enrichment.source, "fallback");
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

  assert.match(xml, /^<title>原始文章标题<\/title>/);
  assert.match(xml, /<b>原网页链接：<\/b><a href="https:\/\/example\.com\/articles\/42">/);
  assert.match(xml, /<b>标签：<\/b>政策、案例、资料/);
  assert.match(xml, /<b>发布时间：<\/b>2025-09-12/);
  assert.match(xml, /<b>发布单位：<\/b>示例市发展和改革委员会/);
  assert.match(xml, /<b>内容摘要：<\/b>这是由 AI 生成并校验后的内容摘要/);
  assert.match(xml, /<h2>分节标题<\/h2>/);
  assert.match(xml, /<p>正文 A &amp; B<\/p>/);
  assert.match(xml, /<ul><li>第一项<\/li><li>第二项<\/li><\/ul>/);
  assert.match(xml, /<blockquote>引用内容<\/blockquote>/);
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
  assert.match(buildDocXml("受保护图片测试", prepared.blocks), /<p>FEISHU_CLIPPER_IMAGE_[a-f0-9]+<\/p>/);
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
