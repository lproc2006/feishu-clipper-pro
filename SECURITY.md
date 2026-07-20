# Security Policy

## Supported version

Security fixes are provided for the latest published release.

## Reporting a vulnerability

Do not include credentials, tokens, private documents, personal information, or exploit details in a public issue. Open a GitHub issue containing only a short request for a private security contact channel. A maintainer will provide a private follow-up path.

## Security model

- The extension reads only the active tab after an explicit user action.
- Page data is sent only to the loopback address `127.0.0.1`.
- The local service rejects write requests from ordinary web origins.
- Feishu credentials and OAuth tokens are managed by the official lark-cli, not by this project.
- No remote analytics, advertising SDK, or developer-operated content server is used.

Users should keep Node.js, lark-cli, Chrome or Edge, and this extension up to date.
