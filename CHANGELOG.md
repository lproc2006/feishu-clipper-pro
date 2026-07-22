# Changelog

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
