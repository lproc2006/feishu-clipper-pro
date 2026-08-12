(() => {
  const CONTENT_VERSION = "1.1.6";
  if (globalThis.__FEISHU_FULL_CLIPPER_LOADED__ === CONTENT_VERSION) return;
  globalThis.__FEISHU_FULL_CLIPPER_LOADED__ = CONTENT_VERSION;

  const TEXT_BLOCK_SELECTOR = "h1,h2,h3,h4,h5,h6,p,blockquote,pre,li,figcaption";
  const FORMULA_SELECTOR = "math,[data-tex],.katex,.MathJax";
  const MAX_BLOCKS = 800;
  const MAX_IMAGES = 60;
  const MAX_TABLE_ROWS = 200;
  const MAX_TABLE_COLUMNS = 30;
  const MAX_CAPTURED_IMAGE_BYTES = 24 * 1024 * 1024;
  const MAX_SINGLE_IMAGE_BYTES = 8 * 1024 * 1024;

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
      image.getAttribute("data-original-src"),
      image.getAttribute("data-actualsrc"),
      image.getAttribute("data-url"),
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

  function meaningfulMediaCount(element) {
    return [...element.querySelectorAll("img,picture,table,math,.katex,.MathJax")]
      .filter((media) => {
        if (media.tagName.toLowerCase() !== "img") return true;
        return Boolean(bestImageUrl(media));
      })
      .length;
  }

  function pruneBoilerplate(root) {
    const candidates = [...root.querySelectorAll("nav,aside,header,footer,div,section,ul,ol")];
    candidates.reverse().forEach((element) => {
      if (!element.isConnected) return;
      const text = normalizeText(element.textContent);
      if (!text) {
        if (!meaningfulMediaCount(element)) element.remove();
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
      ".view-content",
      "#content"
    ];
    const candidates = [...new Set(root.querySelectorAll(selectors.join(",")))];
    let best = null;
    let bestScore = -Infinity;
    for (const element of candidates) {
      const textLength = normalizeText(element.textContent).length;
      const mediaCount = meaningfulMediaCount(element);
      if (textLength < 120 && mediaCount === 0) continue;
      const score =
        textLength +
        element.querySelectorAll("p").length * 100 +
        mediaCount * 180 -
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
      const mediaCount = meaningfulMediaCount(element);
      if (textLength < 120 && mediaCount === 0) continue;
      const paragraphs = element.querySelectorAll("p").length;
      const score = textLength + paragraphs * 80 + mediaCount * 180 - elementLinkDensity(element) * textLength * 1.5;
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
        textContent: normalizeText(explicitArticle.textContent),
        source: "site-adapter"
      };
    }
    if (typeof Readability === "function") {
      try {
        const parsed = new Readability(clone, {
          charThreshold: 120,
          keepClasses: false,
          nbTopCandidates: 8
        }).parse();
        if (parsed && normalizeText(parsed.textContent).length >= 80) {
          return { ...parsed, source: "readability" };
        }
      } catch (_err) {
        // The scored DOM fallback below handles unusual or partially rendered pages.
      }
    }
    return { ...findFallbackArticle(clone), source: "scored-fallback" };
  }

  function waitForPageSettled() {
    if (document.readyState === "complete") return Promise.resolve();
    return new Promise((resolve) => {
      let quietTimer;
      const finish = () => {
        clearTimeout(quietTimer);
        clearTimeout(maxTimer);
        observer.disconnect();
        resolve();
      };
      const observer = new MutationObserver(() => {
        clearTimeout(quietTimer);
        quietTimer = setTimeout(finish, 350);
      });
      const maxTimer = setTimeout(finish, 2_000);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      quietTimer = setTimeout(finish, 350);
    });
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
        return nameOf(value.publisher) || nameOf(value.sourceOrganization);
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

  function readEmbeddedPublisher() {
    const keys = [
      "accountName",
      "account_name",
      "authorName",
      "author_name",
      "mediaName",
      "media_name",
      "publisherName",
      "publisher_name",
      "sourceName",
      "source_name"
    ];
    const keyPattern = keys.join("|");
    const quoted = new RegExp(
      `["'](?:${keyPattern})["']\\s*:\\s*["']([^"'\\n]{2,100})["']`,
      "i"
    );
    const assigned = new RegExp(
      `(?:${keyPattern})\\s*[:=]\\s*["']([^"'\\n]{2,100})["']`,
      "i"
    );
    for (const script of document.querySelectorAll("script:not([src])")) {
      const source = (script.textContent || "").slice(0, 2_000_000);
      if (!source || !new RegExp(keyPattern, "i").test(source)) continue;
      const match = source.match(quoted) || source.match(assigned);
      if (match?.[1]) {
        return normalizeText(
          match[1].replace(
            /\\u([0-9a-f]{4})/gi,
            (_all, hex) => String.fromCharCode(parseInt(hex, 16))
          )
        );
      }
    }
    return "";
  }

  function normalizePublisher(value) {
    const publisher = normalizeText(value)
      .replace(
        /^(?:发文机关|发布机关|制定机关|印发机关|信息来源|文章来源|来源|发布单位|发布机构)\s*[:：]?\s*/,
        ""
      )
      .replace(/\s+(?:编辑|审核|校对)\s*[丨|:：].*$/, "")
      .trim();
    return publisher.length <= 100 ? publisher : "";
  }

  function looksLikeOrganization(value) {
    const text = normalizePublisher(value);
    if (!text) return false;
    return /(?:国务院|人民政府|人民法院|人民检察院|委员会|办公室|领导小组|指挥部|工作组|管理局|管理委员会|发展改革委|发展和改革委员会|厅|局|部|委|署|院|办|中心|研究所|研究院|大学|学院|公司|集团|协会|学会|联合会|商会|基金会|报社|通讯社|电视台|广播台|融媒体中心|新闻中心|出版社|杂志社|网站|政府网|新闻网|公众号)$/.test(
      text
    );
  }

  function isLikelyPersonName(value) {
    const text = normalizePublisher(value);
    return /^[\u4e00-\u9fff·]{2,4}$/.test(text) && !looksLikeOrganization(text);
  }

  function isPlatformPublisher(value) {
    const text = normalizePublisher(value).replace(/\s+/g, "");
    return /^(?:百度|百家号|百度百家号|微信|微信公众号|今日头条|头条号|搜狐|搜狐号|网易|新浪|微博)$/.test(text);
  }

  function readAccountPublisher() {
    const selectors = [
      "#js_name",
      ".rich_media_meta_nickname",
      "[class*='authorName']",
      "[class*='author-name']",
      "[class*='accountName']",
      "[class*='account-name']",
      "[class*='mediaName']",
      "[class*='media-name']",
      "[data-testid*='author']",
      "a[href*='app_id']",
      "a[href*='author']"
    ];
    const candidates = [];
    for (const element of document.querySelectorAll(selectors.join(","))) {
      if (element.closest("nav,footer,[role='navigation'],[role='contentinfo']")) continue;
      const text = normalizePublisher(element.textContent || element.getAttribute("title"));
      if (!text || text.length > 60 || isPlatformPublisher(text)) continue;
      if (/^(?:关注|作者|账号|主页|打开|查看|发布于|来源)$/.test(text)) continue;
      const identity = `${element.id || ""} ${element.className || ""} ${element.getAttribute("href") || ""}`;
      let score = 40;
      if (/account|authorname|author-name|medianame|media-name|app_id/i.test(identity)) score += 40;
      if (looksLikeOrganization(text)) score += 15;
      candidates.push({ text, score });
    }
    candidates.sort((a, b) => b.score - a.score || a.text.length - b.text.length);
    return candidates[0]?.text || "";
  }

  function publisherAfterLabel(element) {
    const ownText = normalizeText(element.textContent);
    const labelMatch = ownText.match(
      /^(?:发文机关|发布机关|制定机关|印发机关|发布单位|发布机构|信息来源|文章来源|来源)\s*[:：]?\s*(.*)$/
    );
    if (!labelMatch) return "";
    if (labelMatch[1]) return normalizePublisher(labelMatch[1]);

    const container = element.closest("td,th,dt,dd,h1,h2,h3,h4,h5,h6,p,span,div") || element;
    const candidates = [
      element.nextElementSibling,
      container.nextElementSibling,
      container.closest("td,th")?.nextElementSibling,
      container.parentElement?.nextElementSibling
    ];
    for (const candidate of candidates) {
      const text = normalizePublisher(candidate?.textContent);
      if (!text || text.length > 100 || /^\d{4}[-/.年]/.test(text)) continue;
      if (isLikelyPersonName(text)) continue;
      return text;
    }
    return "";
  }

  function readVisiblePublisher() {
    const labelPattern = /^(?:发文机关|发布机关|制定机关|印发机关|发布单位|发布机构|信息来源|文章来源|来源)\s*[:：]?/;
    const priority = {
      发文机关: 100,
      发布机关: 95,
      制定机关: 95,
      印发机关: 95,
      发布单位: 90,
      发布机构: 90,
      信息来源: 70,
      文章来源: 65,
      来源: 60
    };
    const candidates = [];
    for (const element of document.querySelectorAll("b,strong,th,td,dt,dd,h1,h2,h3,h4,h5,h6,p,span,div")) {
      if (element.closest("nav,header,footer,aside,[role='navigation'],[role='contentinfo']")) continue;
      const text = normalizeText(element.textContent);
      if (!labelPattern.test(text) || text.length > 140) continue;
      const label = text.match(labelPattern)?.[0].replace(/[\s:：]/g, "") || "";
      const publisher = publisherAfterLabel(element);
      if (!publisher || isLikelyPersonName(publisher)) continue;
      candidates.push({ publisher, score: priority[label] || 50 });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.publisher || "";
  }

  function readPolicySignature() {
    const candidates = [];
    for (const element of document.querySelectorAll("p,td,div")) {
      if (element.closest("nav,header,footer,aside,[role='navigation'],[role='contentinfo']")) continue;
      if (element.querySelector("p,td,div")) continue;
      const publisher = normalizePublisher(element.textContent);
      if (!looksLikeOrganization(publisher) || publisher.length > 60 || /[:：]$/.test(publisher)) continue;

      const nearby = [element.nextElementSibling, element.nextElementSibling?.nextElementSibling]
        .map((item) => normalizeText(item?.textContent))
        .join(" ");
      const style = getComputedStyle(element);
      let score = 0;
      if (/(?:19|20)\d{2}年\d{1,2}月\d{1,2}日/.test(nearby)) score += 80;
      if (style.textAlign === "right" || /右对齐/.test(element.getAttribute("label") || "")) score += 30;
      if (score) candidates.push({ publisher, score });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0]?.publisher || "";
  }

  function publisherFromPolicyTitle(title) {
    const text = normalizeText(title);
    const match = text.match(/^(.{2,50}?)(?=关于|令|公告|通告|通知|决定|批复|意见|办法|规定)/);
    const publisher = normalizePublisher(match?.[1]);
    return looksLikeOrganization(publisher) ? publisher : "";
  }

  function readPublisher(title) {
    const visible = readVisiblePublisher();
    const metadata = readMetaContent([
      "contentsource",
      "content-source",
      "sourceorganization",
      "source_organization",
      "publisher",
      "organization",
      "article:publisher",
      "og:article:publisher",
      "article:author",
      "author",
      "byl"
    ]);
    const account = readAccountPublisher();
    const structured = readStructuredPublisher();
    const embedded = readEmbeddedPublisher();
    const signature = readPolicySignature();
    const titlePublisher = publisherFromPolicyTitle(title);
    const site = readMetaContent(["og:site_name", "application-name"]);
    const candidates = [
      { value: visible, allowPerson: false },
      { value: account, allowPerson: true },
      { value: metadata, allowPerson: location.hostname === "baijiahao.baidu.com" },
      { value: structured, allowPerson: false },
      { value: embedded, allowPerson: location.hostname === "baijiahao.baidu.com" },
      { value: signature, allowPerson: false },
      { value: titlePublisher, allowPerson: false },
      { value: site, allowPerson: false }
    ];
    for (const candidate of candidates) {
      const publisher = normalizePublisher(candidate.value);
      if (!publisher || isPlatformPublisher(publisher)) continue;
      if (!candidate.allowPerson && isLikelyPersonName(publisher)) continue;
      return publisher;
    }
    return "未识别";
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
    const figure = image.closest("figure");
    const caption = normalizeText(
      figure?.querySelector("figcaption")?.textContent ||
      image.getAttribute("data-caption") ||
      image.getAttribute("aria-description")
    );
    return {
      type: "image",
      src,
      alt: normalizeText(image.getAttribute("alt") || image.getAttribute("title")),
      caption,
      width,
      height
    };
  }

  function codeLanguage(element) {
    const identity = [
      element.getAttribute("data-language"),
      element.getAttribute("data-lang"),
      element.className,
      element.querySelector("code")?.className
    ].filter(Boolean).join(" ");
    const match = identity.match(/(?:language|lang)[-_: ]+([a-z0-9+#.-]{1,24})/i);
    return normalizeText(match?.[1]).toLowerCase();
  }

  function formulaBlock(element) {
    if (element.matches("math") && element.parentElement?.closest(".katex, .MathJax")) return null;
    if (element.matches(".katex, .MathJax") && element.closest("math")) return null;
    if (element.matches("[data-tex]") && element.parentElement?.closest("[data-tex]")) return null;
    const text = normalizeText(
      element.getAttribute("data-tex") ||
      element.querySelector("annotation[encoding='application/x-tex']")?.textContent ||
      element.getAttribute("aria-label") ||
      element.textContent
    );
    if (!text || text.length > 5000) return null;
    return { type: "formula", text };
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
    const nodes = [...articleRoot.querySelectorAll(`${TEXT_BLOCK_SELECTOR},table,img,section,div,${FORMULA_SELECTOR}`)];
    const blocks = [];
    const seenImages = new Set();

    for (const element of nodes) {
      if (blocks.length >= MAX_BLOCKS) break;
      const tag = element.tagName.toLowerCase();
      const containingTable = element.closest("table");
      if (containingTable && containingTable !== element) continue;
      if (element.matches(FORMULA_SELECTOR)) {
        const formula = formulaBlock(element);
        if (formula) blocks.push(formula);
        continue;
      }
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
      if (tag === "figcaption" && element.closest("figure")?.querySelector("img")) continue;
      const text = normalizeText(element.textContent);
      if (!text) continue;

      let type = "paragraph";
      const rawAlignment = String(element.getAttribute("align") || element.style.textAlign || "").toLowerCase();
      const block = {
        type,
        text,
        linkDensity: blockLinkDensity(element),
        align: ["left", "center", "right"].includes(rawAlignment) ? rawAlignment : ""
      };
      if (/^h[1-6]$/.test(tag)) {
        block.type = "heading";
        block.level = Number(tag.slice(1));
      } else if (tag === "blockquote") {
        block.type = "quote";
      } else if (tag === "pre") {
        block.type = "code";
        block.language = codeLanguage(element);
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
      if (!["image", "table", "formula"].includes(block.type) && isMenuLike(block)) {
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
      if (["image", "table", "formula"].includes(block.type)) return true;
      const text = normalizeText(block.text);
      if (isSeparator(text) || /^分享到\s*[:：]?\s*$/.test(text)) return false;
      if (/^(?:来源|文章来源|信息来源|作者|编辑|审核|校对|责任编辑|发布机构|发布单位)\s*[:：丨|]/.test(text)) {
        return false;
      }
      return true;
    });
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
      reader.readAsDataURL(blob);
    });
  }

  async function attachImageData(blocks) {
    let capturedBytes = 0;
    const images = blocks.filter((block) => block.type === "image");
    const deadline = Date.now() + 15_000;
    let nextIndex = 0;
    const captureNext = async () => {
      while (
        nextIndex < images.length &&
        capturedBytes < MAX_CAPTURED_IMAGE_BYTES &&
        Date.now() < deadline
      ) {
        const block = images[nextIndex];
        nextIndex += 1;
        const controller = new AbortController();
        const timeout = setTimeout(
          () => controller.abort(),
          Math.max(500, Math.min(6_000, deadline - Date.now()))
        );
        try {
          const response = await fetch(block.src, {
            credentials: "include",
            cache: "force-cache",
            referrer: location.href,
            signal: controller.signal
          });
          if (!response.ok) continue;
          const contentLength = Number(response.headers.get("content-length") || 0);
          if (contentLength > MAX_SINGLE_IMAGE_BYTES) continue;
          const blob = await response.blob();
          if (!blob.type.startsWith("image/") || blob.size > MAX_SINGLE_IMAGE_BYTES) continue;
          if (capturedBytes + blob.size > MAX_CAPTURED_IMAGE_BYTES) continue;
          block.dataUrl = await blobToDataUrl(blob);
          capturedBytes += blob.size;
        } catch (_err) {
          // The original URL remains available as a fallback for public images.
        } finally {
          clearTimeout(timeout);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, images.length) }, captureNext));
    return {
      blocks,
      diagnostics: {
        total: images.length,
        captured: images.filter((block) => block.dataUrl).length,
        remoteFallback: images.filter((block) => !block.dataUrl).length
      }
    };
  }

  async function buildPayload() {
    await waitForPageSettled();
    const article = parseReadableArticle();
    const parsed = new DOMParser().parseFromString(`<article>${article.content || ""}</article>`, "text/html");
    const articleRoot = parsed.querySelector("article") || parsed.body;
    const title = chooseTitle(article, articleRoot);
    const publishedAt = readPublishedAt(title, article);
    const publisher = readPublisher(title);
    const blocks = extractBlocks(articleRoot);
    const imageCapture = await attachImageData(blocks);
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
      diagnostics: {
        extraction: article.source || "unknown",
        images: imageCapture.diagnostics
      },
      capturedAt: new Date().toISOString()
    };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || message.type !== "FEISHU_FULL_CLIP_EXTRACT_V6") return false;
    buildPayload()
      .then(sendResponse)
      .catch((err) => sendResponse({ error: err.message || "网页正文提取失败" }));
    return true;
  });

  globalThis.__FEISHU_FULL_CLIPPER_TEST__ = {
    buildPayload,
    attachImageData,
    prepareDocumentClone,
    readPublisher,
    removeNavigationRuns
  };
})();
