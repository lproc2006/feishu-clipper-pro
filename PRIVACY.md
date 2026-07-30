# 隐私政策 / Privacy Policy

最后更新：2026-07-27

## 中文

飞书剪存pro 的唯一目的，是在用户明确点击扩展图标后，将当前网页归档到用户自己的飞书或 Lark 空间。

### 处理的数据

扩展仅在用户点击时读取当前标签页，并处理完成剪存所必需的网页标题、网址、正文文本、正文图片数据、表格结构、发布时间、发布单位、内容摘要及自动标签。为显示已剪存对号，扩展会将用户成功剪存过的规范化网址和剪存时间保存在当前浏览器本地，并将打开标签页的网址与该本地清单比较。扩展不读取浏览器历史数据库，不向开发者发送该清单，也不收集与剪存无关的数据。

### 数据流向与用途

网页数据通过 `http://127.0.0.1:8787` 发送到用户设备上的本机配套服务，仅用于整理内容并生成飞书云文档和多维表格记录。默认 AI 整理只连接用户设备上的本机 Ollama。高级用户可自行选择并配置 OpenAI 兼容服务；启用后，正文会依照用户的配置发送给该服务商。本机服务通过用户本人配置并授权的飞书官方 lark-cli 与飞书或 Lark Open Platform 通信。插件开发者没有内容中转服务器，不能访问用户剪存的网页内容、飞书账号或飞书文件。

### 存储与保留

浏览器扩展不持久保存网页正文或图片，只在浏览器本地保存已剪存网页的规范化网址和时间，用于显示图标对号；清除扩展存储或卸载扩展即可删除。为兼容防盗链图片，本机服务会在系统临时目录短暂写入正文图片，完成上传后立即删除。本机服务另保存云文档 token、多维表格记录 ID 和关联所需的资源标识，以实现双向删除同步。该关联数据保存在用户设备的应用数据目录，卸载本机服务时可删除。飞书中的内容由用户自己的账号和飞书服务管理，用户可在飞书中删除。

### 分享、出售与分析

项目不出售、出租或用于广告投放，不使用第三方分析、追踪器或遥测。除为完成用户要求而发送给用户自己的飞书或 Lark 空间外，不向第三方传输网页数据。

### 权限

- `activeTab`：仅在用户点击扩展时读取当前标签页。
- `scripting`：在当前标签页运行正文提取代码。
- `storage`：在当前浏览器本地保存已剪存网页的规范化网址和时间。
- `tabs`：将当前打开网页的网址与本地已剪存清单比较，以显示或清除图标对号。
- `http://127.0.0.1:8787/*`：连接用户设备上的本机配套服务。

本项目对从浏览器 API 获得的信息的使用遵守 Chrome Web Store User Data Policy，包括 Limited Use 要求。

### 联系方式

隐私或安全问题请通过项目 GitHub Issues 提交；敏感安全问题请按 [SECURITY.md](SECURITY.md) 的方式报告，不要在公开 Issue 中披露。

## English

Feishu Clipper Pro has one purpose: after the user explicitly clicks the extension icon, archive the current web page into the user's own Feishu or Lark workspace.

### Data handled

Only after a user action, the extension processes the current tab's title, URL, article text, article image data, table structure, publication date, publisher, generated summary, and tags. To display the clipped checkmark, it stores normalized URLs and clipping times locally in the current browser and compares open-tab URLs with that local list. It does not read the browser history database, transmit this list to the developer, or collect unrelated data.

### Data flow and use

Page data is sent to the companion service on the user's device at `http://127.0.0.1:8787` solely to organize content and create a Feishu cloud document and Base record. AI processing uses local Ollama by default. Advanced users may explicitly configure an OpenAI-compatible provider; in that case, article text is sent according to the user's provider configuration. The companion uses the official lark-cli configured and authorized by the user to communicate with Feishu or Lark Open Platform. The extension developer operates no content relay server and cannot access clipped page content, Feishu accounts, or Feishu files.

### Storage and retention

The browser extension does not persist page text or images. It stores only normalized clipped-page URLs and clipping times in browser-local storage for the icon checkmark; clearing extension storage or uninstalling the extension removes them. For protected images, the local companion writes short-lived files in the operating system's temporary directory and deletes them immediately after upload. It stores document tokens, Base record IDs, and resource identifiers needed for two-way deletion synchronization. This mapping remains in the user's local application data directory and can be removed by uninstalling the companion. Content stored in Feishu is controlled by the user's account and Feishu service.

### Sharing, sale, and analytics

The project does not sell or rent data, use it for advertising, or include third-party analytics, trackers, or telemetry. Page data is transferred only as necessary to save it in the user's own Feishu or Lark workspace.

The use of information received from browser APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.
