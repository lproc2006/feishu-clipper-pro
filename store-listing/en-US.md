# Store listing (English)

## Name

Feishu Clipper Pro

## Short description

Clip the current article into a Feishu cloud document and Base record with text, images, tables, and source metadata.

## Detailed description

Feishu Clipper Pro is an independent open-source tool for archiving web articles into a user's own Feishu or Lark workspace. Click the extension icon on an article page and clipping starts immediately, creating a formatted cloud document and a searchable Base record without a second button click.

Key features:

• Detects the article title, publication date, publisher, original URL, and main content.
• Uses local AI to generate a concise summary and 2–3 focused tags, each no longer than five characters.
• Captures article images in the browser so protected and anti-hotlink sources remain archivable.
• Preserves article images, HTML tables, heading levels, paragraphs, lists, quotations, and code blocks.
• Removes common navigation, footer, sharing, editor, and reviewer elements using general content rules.
• Creates a Feishu Clipper folder and Web Clipping Library in the user's Drive root.
• Keeps the document and Base record consistent, including title, date, publisher, tags, URL, and body.
• Links each document to its Base record so a confirmed deletion on one side can remove the matching item.
• Shows a completion message and a green checkmark on the extension icon for pages clipped in the same browser.
• Contains no advertising, behavioral analytics, tracking SDK, or developer-operated content relay server.

Privacy and data flow: the extension reads the active tab only after the user clicks it. Page content is sent to the companion service at 127.0.0.1 on the user's own computer and processed by local Ollama by default. Normalized clipped URLs and timestamps stay in browser-local storage only to display the checkmark. The companion uses the official lark-cli, configured and authorized by the user, to save content into that user's Feishu or Lark workspace. The developer cannot access clipped pages, user accounts, or cloud files.

Companion requirement: this extension depends on an open-source local companion. Before first use, install Node.js 18+, the official lark-cli, and complete Feishu authorization by following the GitHub installation guide. Source code, privacy policy, installation, and uninstallation instructions are publicly available in the project repository.

Compatible with Chrome and Microsoft Edge. Browser-internal pages, extension store pages, and other protected pages cannot be read because of browser security restrictions.

Disclaimer: this is an independent open-source project and is not an official Feishu or Lark product. Feishu and Lark are trademarks of their respective owners.

## Category

Productivity

## Search terms

Feishu clipper, web archive, cloud document, Base, article saver, knowledge management, web clipper
