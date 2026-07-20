# Store privacy practices

Use these answers in the Chrome Web Store Privacy and Microsoft Edge Partner Center Privacy sections. They must remain consistent with `PRIVACY.md` and actual product behavior.

## Single purpose

Archive the current web article, after an explicit user click, into the user's own Feishu or Lark cloud document and Base library.

## Data categories handled

- Website content: yes. Article title, URL, text, image references, table structure, publication date, and publisher are required for the clipping feature.
- Web history: no. The extension does not read or store browsing history.
- Authentication information: no. Authentication is handled separately by the official lark-cli on the user's device.
- Personally identifiable information: not intentionally collected. If the selected page contains such information, it is processed only as part of the user-requested clipping operation.
- User activity or analytics: no.
- Location, health, financial, payment, or communications data: not intentionally collected.

## Processing and transfer

- Processing begins only after the user opens the extension and clicks Full Clip.
- Data is sent to `127.0.0.1` on the user's device.
- The companion sends it through the official lark-cli to the user's own Feishu or Lark workspace.
- No data is sent to or accessible by the extension developer.
- No advertising, sale, profiling, analytics, or unrelated use occurs.

## Limited Use certification

The use of information received from browser APIs adheres to the Chrome Web Store User Data Policy, including the Limited Use requirements.

## Permission justifications

`activeTab`: Required to read only the current page after an explicit user action. This replaces broad permanent website access.

`scripting`: Required to inject the bundled, reviewable article extractor into the active tab. No remote code is downloaded or executed.

`http://127.0.0.1:8787/*`: Required to communicate with the open-source companion service running only on the user's computer. The service rejects ordinary website origins.

## Remote code

No remote code is used. Mozilla Readability is bundled in the extension package with its license.
