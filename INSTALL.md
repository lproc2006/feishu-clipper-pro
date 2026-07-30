# 安装指南

飞书剪存pro 由浏览器扩展和本机配套服务两部分组成。扩展负责读取用户主动选择的当前网页，本机服务负责通过飞书官方 lark-cli 写入用户自己的飞书空间。

## 1. 安装基础环境

安装 [Node.js 18+](https://nodejs.org/) 后，在终端确认：

```bash
node --version
npm --version
```

## 2. 下载本项目

从 GitHub Releases 下载源码包并解压，或使用 Git：

```bash
git clone https://github.com/lproc2006/feishu-clipper-pro.git
cd feishu-clipper-pro
```

## 3. 安装本机服务并授权飞书

### macOS

```bash
bash scripts/install-macos.sh
```

脚本会安装飞书官方 lark-cli、复制本机服务、配置登录自启动，并引导完成飞书应用配置与账号授权。

### Linux

```bash
bash scripts/install-linux.sh
```

支持 systemd 用户服务。没有 systemd 时，脚本会给出手动启动命令。

### Windows 10/11

在 PowerShell 中运行：

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install-windows.ps1
```

脚本会创建当前用户的登录启动任务，不需要把飞书凭据写入项目目录。

## 4. 验证本机服务

浏览器打开：

```text
http://127.0.0.1:8787/health
```

出现 `"ok":true` 表示服务运行正常。也可运行：

```bash
lark-cli doctor
lark-cli auth status
```

## 5. 安装浏览器扩展

### Chrome Web Store

1. 打开本项目 README 中的 Chrome Web Store 链接（提交审核后更新）。
2. 点击“添加至 Chrome”。
3. 将“飞书剪存pro”固定到工具栏。

### Microsoft Edge Add-ons

1. 打开本项目 README 中的 Edge Add-ons 链接（提交审核后更新）。
2. 点击“获取”。
3. 将“飞书剪存pro”固定到工具栏。

### 开发者模式安装

商店版本审核期间，可从 GitHub Release 下载当前版本的 `feishu-clipper-pro-extension-<版本号>.zip` 并解压。

Chrome：打开 `chrome://extensions`，启用“开发者模式”，点击“加载已解压的扩展程序”，选择解压后的 `extension` 目录。

Edge：打开 `edge://extensions`，启用“开发人员模式”，点击“加载解压缩的扩展”，选择解压后的 `extension` 目录。

## 6. 启用本机 AI 摘要与标签

本机服务会自动连接 `http://127.0.0.1:11434` 的 Ollama，并使用已安装的第一个模型。安装 Ollama 后至少下载一个支持中文的模型即可，无需把网页正文发送到第三方模型服务。未检测到模型时，剪存仍会完成，并自动使用本地规则生成摘要和标签。

高级用户可通过 `FEISHU_CLIPPER_AI_MODEL` 指定 Ollama 模型，或将 `FEISHU_CLIPPER_AI_PROVIDER` 设为 `openai`，同时配置 `OPENAI_API_KEY`、`OPENAI_BASE_URL` 和 `OPENAI_MODEL`。启用远程模型意味着正文会按用户配置发送给对应服务商。

## 7. 卸载

先从浏览器扩展管理页移除扩展，再运行对应脚本：

```bash
bash scripts/uninstall-macos.sh
```

```bash
bash scripts/uninstall-linux.sh
```

Windows PowerShell：

```powershell
.\scripts\uninstall-windows.ps1
```

卸载本机服务会删除本地文档关联数据，但不会删除已经保存在飞书中的云文档和多维表格。lark-cli 由其他飞书工具共用，卸载脚本不会自动删除它。

## 常见问题

### 插件提示本机服务未启动

先访问 `http://127.0.0.1:8787/health`。若无法打开，重新运行对应系统的安装脚本。

### 飞书返回权限不足

运行：

```bash
lark-cli auth login --recommend
```

完成授权后再试。若应用配置不完整，运行 `lark-cli config init`。

### 页面无法剪存

浏览器内部页面、扩展商店页面和部分受保护页面不允许扩展读取。请在普通 `http://` 或 `https://` 文章页面上使用。

### 修改剪存位置

打开扩展设置后，点击“选择保存文件夹”才会通过当前 `lark-cli` 用户授权读取飞书云盘的一级文件夹。选择目标文件夹后，云文档和多维表格会统一保存到该位置；不选择时自动创建或继续使用 `云盘根目录 / 飞书剪存`。多维表格默认名为“网页剪存库”，名称可修改。扩展不会读取飞书桌面客户端的缓存、密码或登录凭据。
