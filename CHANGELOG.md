# Changelog

## 1.1.5 - 2026-07-30

- Keeps Drive folders hidden and makes no folder-list request until the user clicks “选择保存文件夹”.
- Uses `云盘根目录 / 飞书剪存` whenever no existing folder is explicitly selected.
- Keeps the configurable `网页剪存库` Base in the same selected or managed folder as clipped documents.

## 1.1.4 - 2026-07-30

- Loads only first-level Drive folders when the options page opens.
- Loads a folder's immediate children only after the user enters that folder.
- Adds breadcrumb navigation and keeps folder browsing separate from the saved destination.

## 1.1.3 - 2026-07-30

- Centers document titles, images, image captions, and formulas for a clearer reading hierarchy.
- Adds two full-width spaces before ordinary Chinese body paragraphs.
- Preserves centered and right-aligned source paragraphs without adding an inappropriate first-line indent.

## 1.1.2 - 2026-07-30

- Preserves media-only article containers so image explainers and other image-first pages remain clippable.
- Recognizes explicit article containers that contain meaningful images, tables, or formulas even when they have little or no text.
- Changes generated summaries to 100–200 Chinese characters while continuing to reject long verbatim spans from the source.

## 1.1.1 - 2026-07-30

- Enforces exactly 2–3 content-grounded tags, each 2–5 characters long.
- Removes status-style and generic fallback tags.
- Expands generated summaries to 150–250 Chinese characters.
- Rejects AI summaries that contain long verbatim spans from the source and falls back to a newly organized local synthesis.
- Reads existing Drive folders through the local companion and current Feishu user authorization, allowing users to select the exact destination for both documents and Base records.

## 1.1.0 - 2026-07-30

### Added

- Cross-browser and cross-device duplicate lookup after the user clicks the extension.
- Optional Drive folder name, Base name, and duplicate-handling settings.
- Native Feishu image captions, code language metadata, LaTeX formulas, and GIF preservation.
- A server-side image download fallback for lazy-loaded and anti-hotlink sources.
- Structured error codes for page access, extraction, local service, authorization, document, image, and Base failures.

### Improved

- Waits briefly for actively loading pages before extracting content.
- Uses site adapters, Readability, and a scored DOM fallback as a three-level extraction strategy.
- Keeps deletion synchronization isolated per configured Base and pauses safely when a Base cannot be queried.
- Updates store promotional images and screenshots to communicate the webpage-to-document-and-Base workflow.

### Compatibility

- Existing users keep the `飞书剪存` folder, `网页剪存库`, one-click clipping, and local checkmark behavior by default.
- Feishu document API copying and batch automation remain planned work and are not presented as completed features.

## 1.0.6 - 2026-07-27

- Starts clipping immediately when the extension icon is clicked and removes the second Full Clip button.
- Shows an explicit completion message after a successful clip.
- Stores normalized clipped-page URLs locally and displays a green checkmark badge when those pages are open in the same browser.
- Produces 2–3 focused tags by default and limits every tag to five characters.
- Updates privacy disclosures, reviewer instructions, and store copy for the new local URL marker.

## 1.0.5 - 2026-07-22

- Uses local AI to generate a concise content summary and 2–5 focused tags, with a non-blocking heuristic fallback.
- Keeps the generated summary consistent between the cloud document and the Base body field.
- Captures rendered article images in the browser and stages them locally so protected or anti-hotlink source images upload reliably.
- Recognizes publisher account names from dynamic article metadata and author components, including Baijiahao pages.
- Filters platform names and ordinary editor names from publisher candidates.

## 1.0.4 - 2026-07-22

- Creates missing Base select options before saving newly inferred content tags.
- Deduplicates existing tag options while preserving their names and colors.
- Serializes tag option updates so simultaneous clips cannot overwrite each other's options.
- Moves tag preparation before document creation to avoid temporary documents on option failures.

## 1.0.3 - 2026-07-22

- Prioritizes explicit issuing authorities such as `发文机关` over page authors.
- Removes individual authors as a publisher fallback.
- Adds policy signature and title-based organization fallbacks for government documents.
- Forces open tabs to load the upgraded publisher extractor before the next clip.
- Replaces generic fixed tags with title-weighted content topics and limits output to three tags.

## 1.0.2 - 2026-07-22

- Uses the unmodified official Feishu application icon as the locked master artwork.
- Adds the product banner and clipping workflow screenshots to the GitHub introduction.

## 1.0.1 - 2026-07-22

- Restores the Feishu app icon across the extension and store assets.
- Adds a canonical icon master and hash lock so accidental icon replacements fail the release build.

## 1.0.0 - 2026-07-20

- First public release.
- Full article clipping to Feishu cloud documents and Base.
- Preserves images, tables, lists, quotations, code, and heading structure.
- Detects publication date and publisher metadata.
- Removes common website navigation, footer, sharing, editor, and reviewer elements.
- Keeps cloud document and Base metadata consistent.
- Adds confirmed two-way deletion synchronization.
- Restricts page access to the active tab after a user action.
- Restricts local companion writes to browser extension origins.
- Adds cross-platform companion installers, privacy policy, and store materials.
