(() => {
  const CONTENT_VERSION = "1.0.0";
  if (globalThis.__FEISHU_FULL_CLIPPER_LOADED__ === CONTENT_VERSION) return;
  globalThis.__FEISHU_FULL_CLIPPER_LOADED__ = CONTENT_VERSION;

  const TEXT_BLOCK_SELECTOR = "h1,h2,h3,h4,h5,h6,p,blockquote,pre,li,figcaption";
  const MAX_BLOCKS = 800;
  const MAX_IMAGES = 60;
  const MAX_TABLE_ROWS = 200;
  const MAX_TABLE_COLUMNS = 30;

  function normalizeText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function readMetaContent(names) {
    const wanted = new Set(names.map((name) => String(name).toLowerCase()));
    for (const meta of document.querySelectorAll("meta")) {
      const keys = [meta.getAttribute("name"), meta.getAttribute("property"), meta.getAttribute("itemprop")]
        .filter(Boolean)
        .map((key) => key.toLowerCase());
      if (keys.some((key) => wanted.has(key))) {
        const value = normalizeText(meta.getAttribute("content"));
        if (value) return value;
      }
    }
    return "";
  }

  function resolveUrl(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    try {
      const resolved = new URL(raw, location.href);
      return /^(https?):$/.test(resolved.protocol) ? resolved.href : "";
    } catch (_err) {
      return "";
    }
  }

  function largestSrcsetCandidate(srcset) {
    const candidates = String(srcset || "")
      .split(",")
      .map((entry) => {
        const [url, descriptor = ""] = entry.trim().split(/\s+/, 2);
        const score = Number.parseFloat(descriptor) || 1;
        return { url, score };
      })
      .filter((item) => item.url);
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.url || "";
  }

  function bestImageUrl(image) {
    const candidates = [
      image.currentSrc,
      image.getAttribute("data-original"),
      image.getAttribute("data-src"),
      image.getAttribute("data-lazy-src"),
      largestSrcsetCandidate(image.getAttribute("data-srcset")),
      largestSrcsetCandidate(image.getAttribute("srcset")),
      image.getAttribute("src")
    ];
    return candidates.map(resolveUrl).find(Boolean) || "";
  }

  function prepareDocumentClone() {
    const clone = document.cloneNode(true);
    const originalImages = [...document.querySelectorAll("img")];
    const clonedImages = [...clone.querySelectorAll("img")];
    clonedImages.forEach((image, index) => {
      const source = bestImageUrl(originalImages[index] || image);
      if (source) image.setAttribute("src", source);
      image.removeAttribute("srcset");
    });

    clone
      .querySelectorAll(
        [
          "script",
          "style",
          "noscript",
          "template",
          "iframe",
          "canvas",
          "form",
          "dialog",
          "[hidden]",
          "[aria-hidden='true']",
          "[role='navigation']",
          "[role='banner']",
          "[role='contentinfo']",
          "[role='complementary']",
          "[role='search']"
        ].join(",")
      )
      .forEach((node) => node.remove());

    pruneBoilerplate(clone);
    return clone;
  }

  function elementLinkDensity(element) {
    const textLength = normalizeText(element.textContent).length;
    if (!textLength) return 0;
    const linkLength = [...element.querySelectorAll("a")].reduce(
      (sum, link) => sum + normalizeText(link.textContent).length,
      0
    );
    return Math.min(1, linkLength / textLength);
  }

  function hasBoilerplateIdentity(element) {
    const identity = `${element.id || ""} ${element.className || ""}`.toLowerCase();
    const tokens = identity.split(/[^a-z0-9\u4e00-\u9fff]+/).filter(Boolean);
    const boilerplateTokens = new Set([
      "nav",
      "navbar",
      "navigation",
      "menu",
      "breadcrumb",
      "breadcrumbs",
      "sidebar",
      "toolbar",
      "tools",
      "share",
      "sharing",
      "related",
      "recommend",
      "recommendation",
      "pagination",
      "pager",
      "copyright",
      "sitemap",
      "site-map",
      "topbar",
      "subnav",
      "channel-nav",
      "footer-nav"
    ]);
    return tokens.some((token) => boilerplateTokens.has(token));
  }

  function pruneBoilerplate(root) {
    const candidates = [...root.querySelectorAll("nav,aside,header,footer,div,section,ul,ol")];
    candidates.reverse().forEach((element) => {
      if (!element.isConnected) return;
      const text = normalizeText(element.textContent);
      if (!text) {
        element.remove();
        return;
      }

      const tag = element.tagName.toLowerCase();
      const anchors = element.querySelectorAll("a").length;
      const linkDensity = elementLinkDensity(element);
      const hasLongParagraph = [...element.querySelectorAll("p")].some(
        (paragraph) => normalizeText(paragraph.textContent).length >= 160
      );
      const semanticBoilerplate = tag === "nav" || tag === "aside" || tag === "footer";
      const namedBoilerplate = hasBoilerplateIdentity(element);
      const linkCluster = anchors >= 3 && text.length <= 800 && linkDensity >= 0.58;

      if (!hasLongParagraph && (semanticBoilerplate || namedBoilerplate || linkCluster)) {
        element.remove();
      }
    });
  }

  function pruneSharingWidgets(root) {
    const candidates = [...root.querySelectorAll("div,section,span,aside,ul")];
    candidates.reverse().forEach((element) => {
      if (!element.isConnected) return;
      const text = normalizeText(element.textContent);
      const identity = `${element.id || ""} ${element.className || ""}`.toLowerCase();
      const namedShare = /(?:^|[\s_-])(?:share|sharing|bdshare|jiathis)(?:$|[\s_-])/.test(identity);
      const shareLabel = /^分享到\s*[:：]?\s*$/.test(text);
      const shareWidget = element.hasAttribute("data-sites") || element.querySelector("[data-sites]");
      if ((namedShare || shareLabel || shareWidget) && text.length <= 160) element.remove();
    });
  }

  function findExplicitArticle(root) {
    const selectors = [
      "#js_content",
      "[itemprop='articleBody']",
      ".rich_media_content",
      ".article-content",
      ".article_content",
      ".articleContent",
      ".article-body",
      ".article_body",
      ".articleBox",
      ".wzcon",
      ".TRS_Editor",
      ".view-content"
    ];
    const candidates = [...new Set(root.querySelectorAll(selectors.join(",")))];
    let best = null;
    let bestScore = -Infinity;
    for (const element of candidates) {
      const textLength = normalizeText(element.textContent).length;
      if (textLength < 120) continue;
      const score =
        textLength +
        element.querySelectorAll("p").length * 100 +
        element.querySelectorAll("img").length * 35 -
        elementLinkDensity(element) * textLength * 1.8;
      if (score > bestScore) {
        best = element;
        bestScore = score;
      }
    }
    return best;
  }

  function findFallbackArticle(root) {
    const candidates = [...root.querySelectorAll("article,main,[role='main'],section,div")];
    let best = root.body || root.documentElement;
    let bestScore = -Infinity;
    for (const element of candidates) {
      const textLength = normalizeText(element.textContent).length;
      if (textLength < 120) continue;
      const paragraphs = element.querySelectorAll("p").length;
      const images = element.querySelectorAll("img").length;
      const score = textLength + paragraphs * 80 + images * 35 - elementLinkDensity(element) * textLength * 1.5;
      if (score > bestScore) {
        best = element;
        bestScore = score;
      }
    }
    return {
      title: "",
      content: best?.outerHTML || "",
      textContent: normalizeText(best?.textContent || "")
    };
  }

  function parseReadableArticle() {
    const clone = prepareDocumentClone();
    pruneSharingWidgets(clone);
    const explicitArticle = findExplicitArticle(clone);
    if (explicitArticle) {
      return {
        title: "",
        content: explicitArticle.outerHTML,
        textContent: normalizeText(explicitArticle.textContent)
      };
    }
    if (typeof Readability === "function") {
      try {
        const parsed = new Readability(clone, {
          charThreshold: 120,
          keepClasses: false,
          nbTopCandidates: 8
        }).parse();
        if (parsed && normalizeText(parsed.textContent).length >= 80) return parsed;
      } catch (_err) {
        // The scored DOM fallback below handles unusual or partially rendered pages.
      }
    }
    return findFallbackArticle(clone);
  }

  function readStructuredHeadline() {
    const types = new Set(["article", "newsarticle", "blogposting", "report", "analysisnewsarticle"]);
    const visit = (value) => {
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = visit(item);
          if (found) return found;
        }
        return "";
      }
      if (!value || typeof value !== "object") return "";
      const rawType = value["@type"];
      const valueTypes = (Array.isArray(rawType) ? rawType : [rawType])
        .filter(Boolean)
        .map((item) => String(item).toLowerCase());
      if (valueTypes.some((item) => types.has(item)) && typeof value.headline === "string") {
        return normalizeText(value.headline);
      }
      if (value["@graph"]) return visit(value["@graph"]);
      return "";
    };

    for (const script of document.querySelectorAll("script[type='application/ld+json']")) {
      try {
        const headline = visit(JSON.parse(script.textContent || "null"));
        if (headline) return headline;
      } catch (_err) {
        // Ignore malformed structured data and continue through title fallbacks.
      }
    }
    return "";
  }

  function readStructuredPublishedAt() {
    const articleTypes = new Set(["article", "newsarticle", "blogposting", "report", "analysisnewsarticle"]);
    const visit = (value) => {
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = visit(item);
          if (found) return found;
        }
        return "";
      }
      if (!value || typeof value !== "object") return "";
      const rawType = value["@type"];
      const valueTypes = (Array.isArray(rawType) ? rawType : [rawType])
        .filter(Boolean)
        .map((item) => String(item).toLowerCase());
      if (valueTypes.some((item) => articleTypes.has(item))) {
        const published = value.datePublished || value.dateCreated;
        if (typeof published === "string") return normalizeText(published);
      }
      if (value["@graph"]) return visit(value["@graph"]);
      return "";
    };

    for (const script of document.querySelectorAll("script[type='application/ld+json']")) {
      try {
        const published = visit(JSON.parse(script.textContent || "null"));
        if (published) return published;
      } catch (_err) {
        // Continue through standard metadata and visible-date fallbacks.
      }
    }
    return "";
  }

  function readEmbeddedPublishedAt() {
    for (const script of document.querySelectorAll("script:not([src])")) {
      const source = script.textContent || "";
      const match = source.match(
        /(?:create_time\s*:|createTime\s*=|publish(?:ed)?Time\s*=)\s*["']((?:19|20)\d{2}[-/.年]\d{1,2}[-/.月]\d{1,2}(?:日)?(?:[ T]\d{1,2}:\d{2}(?::\d{2})?)?)["']/i
      );
      if (match) return normalizeText(match[1]);
    }
    return "";
  }

  function readStructuredPublisher() {
    const articleTypes = new Set(["article", "newsarticle", "blogposting", "report", "analysisnewsarticle"]);
    const nameOf = (value) => {
      if (typeof value === "string") return normalizeText(value);
      if (Array.isArray(value)) return value.map(nameOf).find(Boolean) || "";
      if (value && typeof value === "object") return normalizeText(value.name || value.legalName);
      return "";
    };
    const visit = (value) => {
      if (Array.isArray(value)) return value.map(visit).find(Boolean) || "";
      if (!value || typeof value !== "object") return "";
      const rawType = value["@type"];
      const valueTypes = (Array.isArray(rawType) ? rawType : [rawType])
        .filter(Boolean)
        .map((item) => String(item).toLowerCase());
      if (valueTypes.some((item) => articleTypes.has(item))) {
        return nameOf(value.publisher) || nameOf(value.sourceOrganization) || nameOf(value.author);
      }
      return value["@graph"] ? visit(value["@graph"]) : "";
    };
    for (const script of document.querySelectorAll("script[type='application/ld+json']")) {
      try {
        const publisher = visit(JSON.parse(script.textContent || "null"));
        if (publisher) return publisher;
      } catch (_err) {
        // Continue through page metadata and visible publisher fallbacks.
      }
    }
    return "";
  }

  function normalizePublisher(value) {
    const publisher = normalizeText(value)
      .replace(/^(?:信息来源|文章来源|来源|发布单位|发布机构|作者)\s*[:：]\s*/, "")
      .replace(/\s+(?:编辑|审核|校对)\s*[丨|:：].*$/, "")
      .trim();
    return publisher.length <= 100 ? publisher : "";
  }

  function readPublisher() {
    const metadata = readMetaContent([
      "contentsource",
      "sourceorganization",
      "article:publisher",
      "og:article:publisher"
    ]);
    const account = document.querySelector("#js_name,.rich_media_meta_nickname")?.textContent;
    const structured = readStructuredPublisher();
    const visible = [...document.querySelectorAll("[class*='source' i],p,span,div")]
      .map((element) => normalizeText(element.textContent))
      .find((text) => /^(?:信息来源|文章来源|来源|发布单位|发布机构)\s*[:：]/.test(text) && text.length <= 120);
    const author = readMetaContent(["author", "article:author", "og:article:author"]);
    const site = readMetaContent(["og:site_name", "application-name"]);
    return [metadata, account, structured, visible, author, site]
      .map(normalizePublisher)
      .find(Boolean) || "未识别";
  }

  function extractDateText(value) {
    const text = normalizeText(value);
    const match = text.match(
      /(?:发布时间|发布日期|发表时间|发布于)?\s*[:：]?\s*((?:19|20)\d{2}(?:[-/.年])\d{1,2}(?:[-/.月])\d{1,2}日?(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\s*(?:Z|[+-]\d{2}:?\d{2}))?)?)/i
    );
    return match?.[1] || "";
  }

  function readVisiblePublishedAt(title, article) {
    const articleSample = normalizeText(article?.textContent).slice(0, 48);
    const titleElements = [...document.querySelectorAll("h1,h2,h3,div,p,span")]
      .filter((element) => normalizeText(element.textContent) === title)
      .sort((a, b) => a.children.length - b.children.length);
    const titleElement = titleElements[0] || null;
    const bodyElement = articleSample
      ? [...document.querySelectorAll("p,div,section,article")]
          .filter((element) => normalizeText(element.textContent).includes(articleSample))
          .sort((a, b) => normalizeText(a.textContent).length - normalizeText(b.textContent).length)[0]
      : null;
    const titleTop = titleElement?.getBoundingClientRect().top ?? 0;
    const bodyTop = bodyElement?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
    const selectors = [
      "time",
      "[itemprop='datePublished']",
      "[class*='publish' i]",
      "[class*='date' i]",
      "[class*='time' i]",
      "span",
      "p",
      "div"
    ];
    const candidates = [...new Set(document.querySelectorAll(selectors.join(",")))];
    let best = "";
    let bestScore = -Infinity;

    for (const element of candidates) {
      if (element.closest("nav,header,footer,aside,[role='navigation'],[role='contentinfo']")) continue;
      const raw = element.getAttribute("datetime") || element.getAttribute("content") || element.textContent;
      const published = extractDateText(raw);
      if (!published) continue;
      const text = normalizeText(element.textContent);
      if (text.length > 80) continue;
      const rect = element.getBoundingClientRect();
      const identity = `${element.id || ""} ${element.className || ""} ${element.getAttribute("itemprop") || ""}`;
      let score = 0;
      if (/publish|date|time/i.test(identity) || element.tagName === "TIME") score += 45;
      if (/(?:发布时间|发布日期|发表时间|发布于)/.test(text)) score += 35;
      if (titleElement && titleElement.parentElement?.contains(element)) score += 30;
      if (rect.top >= titleTop - 80 && rect.top <= bodyTop + 80) score += 25;
      if (rect.top > bodyTop + 400) score -= 60;
      if (score > bestScore) {
        best = published;
        bestScore = score;
      }
    }
    return best;
  }

  function readPublishedAt(title, article) {
    const metadataSelectors = [
      "meta[property='article:published_time']",
      "meta[property='og:published_time']",
      "meta[name='date']",
      "meta[name='PubDate']",
      "meta[name='pubdate']",
      "meta[name='publishdate']",
      "meta[name='publish-date']",
      "meta[itemprop='datePublished']"
    ];
    const standardMetadata = readMetaContent(["pubdate", "publishdate", "publish-date", "datepublished", "date"]) || metadataSelectors
      .map((selector) => document.querySelector(selector)?.content)
      .map(normalizeText)
      .find(Boolean);
    return readStructuredPublishedAt() || standardMetadata || readVisiblePublishedAt(title, article) || readEmbeddedPublishedAt();
  }

  function stripSiteSuffix(value) {
    let title = normalizeText(value);
    const siteName = normalizeText(
      document.querySelector("meta[property='og:site_name']")?.content || location.hostname.replace(/^www\./, "")
    );
    if (!siteName) return title;
    const escaped = siteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    title = title.replace(new RegExp(`\\s*[-_|–—·]\\s*${escaped}\\s*$`, "i"), "").trim();
    return title;
  }

  function findVisualTitle(article) {
    const articleSample = normalizeText(article?.textContent).slice(0, 64);
    let bodyElement = null;
    if (articleSample.length >= 24) {
      const matches = [...document.querySelectorAll("p,div,section,article")].filter((element) =>
        normalizeText(element.textContent).includes(articleSample)
      );
      bodyElement = matches.sort(
        (a, b) => normalizeText(a.textContent).length - normalizeText(b.textContent).length
      )[0];
    }

    const bodyTop = bodyElement?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY;
    const candidates = [...document.querySelectorAll("h1,h2,h3,[role='heading'],div,p,span")];
    let best = "";
    let bestScore = -Infinity;

    for (const element of candidates) {
      const text = normalizeText(element.textContent);
      if (text.length < 6 || text.length > 180) continue;
      if (element.closest("nav,header,footer,aside,[role='navigation'],[role='banner'],[role='contentinfo']")) continue;
      if (element.closest("a,button")) continue;
      if (/^\d{4}[-/.年]\d{1,2}[-/.月]\d{1,2}/.test(text)) continue;
      if (/^(?:来源|作者|编辑|责任编辑|发布时间|发布日期)[:：]/.test(text)) continue;

      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) continue;
      if (!rect.width || !rect.height) continue;

      const fontSize = Number.parseFloat(style.fontSize) || 16;
      const fontWeight = Number.parseInt(style.fontWeight, 10) || (style.fontWeight === "bold" ? 700 : 400);
      const identity = `${element.id || ""} ${element.className || ""}`;
      const headingTag = /^H[1-3]$/.test(element.tagName);
      const namedTitle = /title|headline|article[-_]?name|content[-_]?name/i.test(identity);
      const nearBody = bodyElement && rect.top <= bodyTop + 40 && rect.top >= bodyTop - 1400;
      const sharedContainer = Boolean(bodyElement && element.parentElement?.contains(bodyElement));
      const punctuationBonus = /[！？!?]$/.test(text) ? 8 : 0;
      const lengthBonus = text.length >= 10 && text.length <= 90 ? 22 : 0;

      let score = fontSize * 2 + lengthBonus + punctuationBonus;
      if (fontWeight >= 600) score += 22;
      if (headingTag) score += 90;
      if (namedTitle) score += 45;
      if (nearBody) score += 28;
      if (sharedContainer) score += 22;
      if (rect.top > bodyTop + 80) score -= 80;
      if (element.querySelectorAll("a").length) score -= 60;

      if (score > bestScore) {
        best = text;
        bestScore = score;
      }
    }
    return bestScore >= 70 ? best : "";
  }

  function chooseTitle(article, articleRoot) {
    const candidates = [
      readMetaContent(["articletitle"]),
      readStructuredHeadline(),
      articleRoot?.querySelector("h1")?.textContent,
      article?.title,
      document.querySelector("meta[property='og:title']")?.content,
      document.querySelector("meta[name='twitter:title']")?.content,
      document.querySelector("article h1")?.textContent,
      findVisualTitle(article),
      document.title
    ];
    for (const candidate of candidates) {
      const title = stripSiteSuffix(candidate);
      if (title.length >= 2 && title.length <= 300) return title;
    }
    return location.hostname || "未命名网页";
  }

  function blockLinkDensity(element) {
    const ownText = normalizeText(element.textContent);
    if (!ownText) return 0;
    const linkText = [...element.querySelectorAll("a")].reduce(
      (sum, link) => sum + normalizeText(link.textContent).length,
      element.matches("a") ? ownText.length : 0
    );
    return Math.min(1, linkText / ownText.length);
  }

  function imageBlock(image) {
    const src = bestImageUrl(image);
    if (!src) return null;
    const width = Number(image.getAttribute("width") || image.naturalWidth || 0);
    const height = Number(image.getAttribute("height") || image.naturalHeight || 0);
    if (width > 0 && height > 0 && (width < 120 || height < 80)) return null;
    return {
      type: "image",
      src,
      alt: normalizeText(image.getAttribute("alt") || image.getAttribute("title")),
      width,
      height
    };
  }

  function normalizeTableColor(value) {
    const color = String(value || "").trim().toLowerCase();
    if (!color || color === "transparent") return "";
    if (/^(?:red|orange|yellow|green|blue|purple|gray)$/.test(color)) return color;
    const shortHex = color.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
    if (shortHex) {
      return `rgb(${parseInt(shortHex[1] + shortHex[1], 16)},${parseInt(shortHex[2] + shortHex[2], 16)},${parseInt(shortHex[3] + shortHex[3], 16)})`;
    }
    const hex = color.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
    if (hex) return `rgb(${parseInt(hex[1], 16)},${parseInt(hex[2], 16)},${parseInt(hex[3], 16)})`;
    const rgb = color.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/i);
    if (rgb) {
      const channels = rgb.slice(1, 4).map((part) => Math.min(255, Number(part)));
      return `rgb(${channels.join(",")})`;
    }
    return "";
  }

  function numericWidth(value) {
    const width = Number.parseFloat(String(value || ""));
    return Number.isFinite(width) && width > 0 ? Math.min(600, Math.max(40, Math.round(width))) : 0;
  }

  function tableBlock(table) {
    const sourceRows = [...table.querySelectorAll("tr")].filter(
      (row) => row.closest("table") === table
    );
    const rows = [];

    for (const row of sourceRows.slice(0, MAX_TABLE_ROWS)) {
      const cells = [...row.children]
        .filter((cell) => /^(?:TH|TD)$/.test(cell.tagName) && cell.closest("table") === table)
        .slice(0, MAX_TABLE_COLUMNS)
        .map((cell) => {
          const align = String(cell.getAttribute("align") || cell.style.textAlign || "").toLowerCase();
          const verticalAlign = String(
            cell.getAttribute("valign") || cell.style.verticalAlign || ""
          ).toLowerCase();
          return {
            text: normalizeText(cell.textContent),
            header: cell.tagName === "TH" || Boolean(cell.closest("thead")),
            colspan: Math.min(MAX_TABLE_COLUMNS, Math.max(1, Number(cell.getAttribute("colspan") || 1))),
            rowspan: Math.min(MAX_TABLE_ROWS, Math.max(1, Number(cell.getAttribute("rowspan") || 1))),
            backgroundColor: normalizeTableColor(
              cell.style.backgroundColor || cell.getAttribute("bgcolor")
            ),
            align: ["left", "center", "right"].includes(align) ? align : "",
            verticalAlign: ["top", "middle", "bottom"].includes(verticalAlign)
              ? verticalAlign
              : ""
          };
        });
      if (cells.length) rows.push(cells);
    }
    if (!rows.length) return null;

    const columnWidths = [];
    for (const column of table.querySelectorAll(":scope > colgroup > col")) {
      const span = Math.min(MAX_TABLE_COLUMNS, Math.max(1, Number(column.getAttribute("span") || 1)));
      const width = numericWidth(column.getAttribute("width") || column.style.width);
      for (let index = 0; index < span && columnWidths.length < MAX_TABLE_COLUMNS; index += 1) {
        columnWidths.push(width);
      }
    }
    if (!columnWidths.length) {
      for (const cell of [...sourceRows[0].children].slice(0, MAX_TABLE_COLUMNS)) {
        columnWidths.push(numericWidth(cell.getAttribute("width") || cell.style.width));
      }
    }

    return {
      type: "table",
      caption: normalizeText(table.querySelector(":scope > caption")?.textContent),
      rows,
      columnWidths
    };
  }

  function extractBlocks(articleRoot) {
    const nodes = [...articleRoot.querySelectorAll(`${TEXT_BLOCK_SELECTOR},table,img,section,div`)];
    const blocks = [];
    const seenImages = new Set();

    for (const element of nodes) {
      if (blocks.length >= MAX_BLOCKS) break;
      const tag = element.tagName.toLowerCase();
      const containingTable = element.closest("table");
      if (containingTable && containingTable !== element) continue;
      if (tag === "table") {
        if (element.parentElement?.closest("table")) continue;
        const table = tableBlock(element);
        if (table) blocks.push(table);
        continue;
      }
      if (tag === "img") {
        if (seenImages.size >= MAX_IMAGES) continue;
        const image = imageBlock(element);
        if (!image || seenImages.has(image.src)) continue;
        seenImages.add(image.src);
        blocks.push(image);
        continue;
      }

      if (tag === "section" || tag === "div") {
        const nestedTextBlock = [...element.querySelectorAll(`${TEXT_BLOCK_SELECTOR},section,div`)].some(
          (child) => child !== element && normalizeText(child.textContent)
        );
        if (nestedTextBlock) continue;
      }

      const ancestorTextBlock = element.parentElement?.closest(TEXT_BLOCK_SELECTOR);
      if (ancestorTextBlock && ancestorTextBlock !== element) continue;
      const text = normalizeText(element.textContent);
      if (!text) continue;

      let type = "paragraph";
      const block = { type, text, linkDensity: blockLinkDensity(element) };
      if (/^h[1-6]$/.test(tag)) {
        block.type = "heading";
        block.level = Number(tag.slice(1));
      } else if (tag === "blockquote") {
        block.type = "quote";
      } else if (tag === "pre") {
        block.type = "code";
      } else if (tag === "li") {
        block.type = "list_item";
        block.ordered = element.parentElement?.tagName.toLowerCase() === "ol";
      } else if (tag === "figcaption") {
        block.type = "caption";
      }
      blocks.push(block);
    }
    return removeNavigationRuns(blocks);
  }

  function isSeparator(text) {
    return /^[|｜>》/·•\-–—\s]+$/.test(normalizeText(text));
  }

  function isMenuLike(block) {
    if (!block.text) return false;
    if (isSeparator(block.text)) return true;
    return block.text.length <= 36 && Number(block.linkDensity || 0) >= 0.58;
  }

  function removeNavigationRuns(blocks) {
    const remove = new Set();
    let start = -1;
    let menuItems = 0;

    const finishRun = (end) => {
      if (start >= 0 && menuItems >= 3) {
        for (let index = start; index < end; index += 1) remove.add(index);
      }
      start = -1;
      menuItems = 0;
    };

    blocks.forEach((block, index) => {
      if (!["image", "table"].includes(block.type) && isMenuLike(block)) {
        if (start < 0) start = index;
        if (!isSeparator(block.text)) menuItems += 1;
      } else {
        finishRun(index);
      }
    });
    finishRun(blocks.length);

    const tailStart = Math.max(0, blocks.length - 14);
    const tailCreditIndexes = blocks
      .map((block, index) => ({ index, text: normalizeText(block.text) }))
      .filter(({ index, text }) => index >= tailStart && /^(?:编辑|审核|校对|责任编辑)\s*[:：丨|]/.test(text))
      .map(({ index }) => index);
    const trailingUnits = new Set(
      blocks
        .map((block, index) => ({ index, text: normalizeText(block.text) }))
        .filter(({ index, text }) =>
          index >= tailStart &&
          /^(?:[\u4e00-\u9fff]{2,20})(?:委员会|办公室|工作处|协调处|新闻中心|融媒体中心)$/.test(text) &&
          tailCreditIndexes.some((creditIndex) => Math.abs(creditIndex - index) <= 3)
        )
        .map(({ index }) => index)
    );

    return blocks.filter((block, index) => {
      if (remove.has(index)) return false;
      if (trailingUnits.has(index)) return false;
      if (["image", "table"].includes(block.type)) return true;
      const text = normalizeText(block.text);
      if (isSeparator(text) || /^分享到\s*[:：]?\s*$/.test(text)) return false;
      if (/^(?:来源|文章来源|信息来源|作者|编辑|审核|校对|责任编辑|发布机构|发布单位)\s*[:：丨|]/.test(text)) {
        return false;
      }
      return true;
    });
  }

  function buildPayload() {
    const article = parseReadableArticle();
    const parsed = new DOMParser().parseFromString(`<article>${article.content || ""}</article>`, "text/html");
    const articleRoot = parsed.querySelector("article") || parsed.body;
    const title = chooseTitle(article, articleRoot);
    const publishedAt = readPublishedAt(title, article);
    const publisher = readPublisher();
    const blocks = extractBlocks(articleRoot);
    const text = blocks
      .filter((block) => block.text && block.type !== "caption")
      .map((block) => block.text)
      .join("\n")
      .trim();

    return {
      title,
      articleTitle: title,
      publishedAt,
      publisher,
      url: location.href,
      canonicalUrl: document.querySelector("link[rel='canonical']")?.href || location.href,
      description:
        document.querySelector("meta[name='description']")?.content ||
        document.querySelector("meta[property='og:description']")?.content ||
        article.excerpt ||
        "",
      text: text || normalizeText(article.textContent),
      blocks,
      imageCount: blocks.filter((block) => block.type === "image").length,
      capturedAt: new Date().toISOString()
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "FEISHU_FULL_CLIP_EXTRACT_V4") return false;
    try {
      sendResponse(buildPayload());
    } catch (err) {
      sendResponse({ error: err.message || "网页正文提取失败" });
    }
    return true;
  });

  globalThis.__FEISHU_FULL_CLIPPER_TEST__ = {
    buildPayload,
    prepareDocumentClone,
    removeNavigationRuns
  };
})();
