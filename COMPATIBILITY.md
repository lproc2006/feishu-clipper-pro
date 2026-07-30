# Compatibility and quality gates

Every release should be checked against representative pages in these groups:

| Group | Required result |
| --- | --- |
| WeChat articles | Complete title, all visible rounds/sections, inline images, publisher and date |
| Government and policy sites | Exact title, issuing organization, date, tables, no navigation/share/footer noise |
| Baijiahao and news platforms | Account or issuing organization instead of platform/editor names |
| Dynamic and lazy-loaded pages | Content waits for initial rendering; lazy image URLs are resolved |
| ChatGPT-style conversations | All rendered conversation turns remain in order |
| Wikipedia and technical docs | Headings, lists, code language, formulas, tables and image captions remain structured |
| Protected-image pages | Browser capture first, local companion fallback second, explicit warning last |
| Feishu documents | Do not claim DOM clipping as API-level copying; API copying remains a planned feature |

Release quality targets:

- Overall clipping success rate: at least 95% on the maintained representative set.
- Title, publication date and publisher accuracy: at least 95%.
- Body image retention: at least 95%.
- No obvious navigation, sharing or footer clusters in saved content.
- A failed AI request must fall back locally and must not fail clipping.
- A failed duplicate lookup must not block a new clip.
- An unavailable Base must never trigger deletion of the paired document.

The automated server suite covers normalization, metadata, tags, noise removal, document XML, image captions, GIFs, code, formulas, tables, duplicate URL normalization and deletion safety. Browser-level fixtures should be expanded whenever a real page exposes a new general extraction failure.
