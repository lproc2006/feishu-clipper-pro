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
6. Open a public article page and click the extension icon. Clipping starts immediately without another button click.
7. The popup shows “已剪存完毕” and returns links to the created document and Base library in the reviewer's own Feishu or Lark workspace. The icon displays a green checkmark for the clipped URL.
8. Open the extension options page. Verify that no Drive folders are shown or requested initially and that the default destination is `云盘根目录 / 飞书剪存` with Base name `网页剪存库`.
9. Click “选择保存文件夹” to load only the Drive root's immediate child folders. Enter a folder to load only its immediate children, then optionally select it. The document and configurable Base always use the same destination folder.
10. Clicking a previously clipped URL checks the Base only after that click and offers the existing document or an explicit “save another copy” action.

No shared test credentials are supplied because the product writes only to the current user's own workspace and the developer has no hosted account system. The official lark-cli guided setup creates or configures the required Feishu application and authorization for the reviewer.

## Permissions

- `activeTab` and `scripting` are used only after the user clicks the extension icon.
- `storage` keeps normalized clipped-page URLs and timestamps locally for the checkmark, and stores the user's destination and duplicate-handling preferences.
- `tabs` compares open-tab URLs with that local list; it does not read the browser history database or transmit browsing data.
- Loopback host access is used only for the local companion.
- The extension has no broad host permission, background browsing monitor, analytics, advertising, or remote code.

## Privacy verification

The popup contains a direct privacy disclosure. The bundled privacy page and public `PRIVACY.md` explain the same data flow. The companion service only listens on `127.0.0.1` and rejects write requests from ordinary web origins.

## Protected pages

Browser-internal pages and extension store pages cannot be clipped because browser security policies prohibit script injection there. This is expected behavior.
