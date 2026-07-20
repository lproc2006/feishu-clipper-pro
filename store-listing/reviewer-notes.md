# Notes for extension reviewers

## Purpose

The extension has one purpose: after an explicit user action, archive the current article into the user's own Feishu or Lark cloud document and Base library.

## External dependency disclosure

The extension depends on the open-source local companion included at https://github.com/lproc2006/feishu-clipper-pro and in its release assets. This dependency is prominently disclosed in the short description, detailed listing, README, installation guide, and popup error message.

## Test setup

1. Install Node.js 18 or newer.
2. Download the companion release package from the public GitHub repository.
3. Run the installer for macOS, Linux, or Windows as documented in `INSTALL.md`.
4. The installer uses the official `@larksuite/cli` package and guides the reviewer through `lark-cli config init` and `lark-cli auth login --recommend`.
5. Verify `http://127.0.0.1:8787/health` returns JSON containing `"ok":true`.
6. Open a public article page, open the extension, and click Full Clip.
7. The popup returns links to the created document and Base library in the reviewer's own Feishu or Lark workspace.

No shared test credentials are supplied because the product writes only to the current user's own workspace and the developer has no hosted account system. The official lark-cli guided setup creates or configures the required Feishu application and authorization for the reviewer.

## Permissions

- `activeTab` and `scripting` are used only after the user opens the popup.
- Loopback host access is used only for the local companion.
- The extension has no broad host permission, background browsing monitor, analytics, advertising, or remote code.

## Privacy verification

The popup contains a direct privacy disclosure. The bundled privacy page and public `PRIVACY.md` explain the same data flow. The companion service only listens on `127.0.0.1` and rejects write requests from ordinary web origins.

## Protected pages

Browser-internal pages and extension store pages cannot be clipped because browser security policies prohibit script injection there. This is expected behavior.
