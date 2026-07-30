# Store listing (English)

## Name

Feishu Clipper Pro

## Short description

Clip articles into Feishu documents and Base records with faithful formatting, AI organization, and duplicate checks. Requires the open-source local companion.

## Detailed description

Feishu Clipper Pro is an independent open-source tool for archiving web articles into a user's own Feishu or Lark workspace. Click the extension icon on an article page and clipping starts immediately, creating a formatted cloud document and a searchable Base record without a second button click.

Key features:

• Detects the article title, publication date, publisher, original URL, and main content.
• Uses local AI to rewrite a 100–200 Chinese-character summary without copying source sentences, plus 2–3 content-grounded tags of 2–5 characters each.
• Captures article images in the browser so protected and anti-hotlink sources remain archivable.
• Preserves images, GIFs, native image captions, HTML tables, headings, lists, quotations, code languages, and LaTeX formulas.
• Centers document titles and images, indents ordinary Chinese body paragraphs by two full-width spaces, and preserves centered or right-aligned source paragraphs.
• Removes common navigation, footer, sharing, editor, and reviewer elements using general content rules.
• Creates or reuses the root-level Feishu Clipper folder when no destination is selected. Drive folders are not read until the user clicks Select folder; each next level is loaded only after entering its parent.
• Uses “Web Clip Library” as the default editable Base name and always keeps the Base in the same folder as clipped documents.
• Keeps the document and Base record consistent, including title, date, publisher, tags, URL, and body.
• Links each document to its Base record so a confirmed deletion on one side can remove the matching item.
• Shows a green checkmark for locally known pages and checks the Base library after a click to find duplicates across browsers and devices.
• Distinguishes page access, extraction, local service, authorization, document, image, and Base write failures.
• Contains no advertising, behavioral analytics, tracking SDK, or developer-operated content relay server.

Privacy and data flow: the extension reads the active tab only after the user clicks it. Page content is sent to the companion service at 127.0.0.1 on the user's own computer and processed by local Ollama by default. Normalized clipped URLs and timestamps stay in browser-local storage only to display the checkmark. The companion uses the official lark-cli, configured and authorized by the user, to save content into that user's Feishu or Lark workspace. The developer cannot access clipped pages, user accounts, or cloud files.

Companion requirement: this extension depends on an open-source local companion. Before first use, install Node.js 18+, the official lark-cli, and complete Feishu authorization by following the GitHub installation guide. Source code, privacy policy, installation, and uninstallation instructions are publicly available in the project repository.

Compatible with Chrome and Microsoft Edge. Browser-internal pages, extension store pages, and other protected pages cannot be read because of browser security restrictions.

Disclaimer: this is an independent open-source project and is not an official Feishu or Lark product. Feishu and Lark are trademarks of their respective owners.

## Category

Productivity

## Search terms

Feishu clipper, web archive, cloud document, Base, article saver, knowledge management, web clipper
