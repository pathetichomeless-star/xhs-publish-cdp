---
name: xhs-publish-cdp
version: 1.0.0
display_name: 小红书发布（CDP 直连）
display_name_en: Xiaohongshu Publish via CDP
description: 通过 Chrome DevTools Protocol 直连发布小红书图文笔记，绕过浏览器扩展注入和 macOS 权限限制。适用于需要稳定上传本地图片、填写标题正文话题、并执行正式发布的场景。关键词：小红书发布、发笔记、图文笔记、CDP 发布、自动发布、小红书创作服务平台。
---

# 小红书发布（CDP 直连）

把本地图片 + 文案发布成小红书图文笔记，全程走正常网页界面，不使用非官方写入接口。

## 何时使用

- 需要把做好的图 + 文案发布到小红书
- 需要**稳定上传本地图片**（这是 BrowserSkill 扩展最容易被卡住的环节）
- 需要可重复的发布流程，而不是每次手动点

## 前置条件（必须满足，否则跑不通）

### 1. Chrome 必须以调试模式启动

小红书发布页所在的浏览器**必须带远程调试端口**，且**不能使用默认 profile**（Chrome 136+ 的安全限制）。

让用户在自己的终端里执行，并保持终端窗口不关：

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9333 \
  --user-data-dir="~/xhs-cdp-profile"
```

**为什么必须由用户启动**：Agent 侧启动的进程活不过一轮对话（会被清理），只有用户终端里的进程能常驻。

### 2. 首次需登录一次

在那个新窗口里打开 `creator.xiaohongshu.com` 扫码登录。登录态长期保存在该 profile，之后不用重复登录。

### 3. 验证端口

```bash
node -e "require('http').get({host:'127.0.0.1',port:9333,path:'/json/version'},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(d))}).on('error',e=>console.log('端口不通:',e.code))"
```

返回 Browser 版本即正常。

## 用法

```bash
node scripts/publish.mjs \
  --title "ChatGPT 用不了？先别急着注册！" \
  --body-file body.txt \
  --images img1.png,img2.png,img3.png \
  --tags "ChatGPT,AI新手,零基础学AI" \
  --preview ./preview.png \
  --publish
```

不加 `--publish` 时只填内容并截图，不点发布（**dry-run，推荐先跑一次**）。

| 参数 | 说明 |
|---|---|
| `--title` | 标题，必填 |
| `--body-file` | 正文文本文件，段落用空行分隔 |
| `--images` | 图片绝对路径，逗号分隔，**顺序即发布顺序** |
| `--tags` | 话题，逗号分隔，不带 `#` |
| `--port` | CDP 端口，默认 9333 |
| `--preview` | 预览截图保存路径 |
| `--publish` | 真正点击发布，不传则停在预览 |

## 执行流程

1. 连 CDP → 找到小红书标签页
2. 导航到 `publish/publish`
3. 点击「上传图文」（**点最后一个匹配项**）
4. `DOM.setFileInputFiles` 塞图片
5. `Input.insertText` 填标题
6. 正文逐段输入，段间按**一次** Enter
7. 话题：输入 `#` + 名称 → 等下拉 → Enter 选中
8. 截图预览
9. 找发布按钮 → 真实鼠标事件点击
10. 等跳转 → 读 `/publish/success` 确认

## 关键坑位（都是实测踩出来的）

### ① 发布按钮抓不到

按钮是自定义组件 `<XHS-PUBLISH-BTN>`，在 shadow DOM 里，`querySelectorAll` 找不到，文本匹配也无效。

解法：用坐标 + `elementFromPoint` 命中。

```js
document.elementFromPoint(658, 608).tagName  // 返回 XHS-PUBLISH-BTN
```

坐标随视口变化，脚本里按视口比例算：按钮通常在 `x ≈ 55% 视口宽`、`y ≈ 92% 视口高`。**点击前必须先用 `elementFromPoint` 验证命中元素是 `XHS-PUBLISH-BTN`**。

### ② 图片上传必须用 DOM.setFileInputFiles

`Runtime.evaluate` 里没法给 file input 塞本地文件（安全限制）。用：

```js
DOM.getDocument → DOM.querySelector('input[type=file]') → DOM.setFileInputFiles({files, nodeId})
```

这条命令**不要求元素可见**，所以不怕隐藏 input。

### ③ 正文换行：一次 Enter，不要三个键盘事件

`rawKeyDown + char + keyUp` 三连会被算成多次换行，产生 4-5 个空行。

正确做法：只发 `keyDown` + `keyUp`，一次 Enter = 一个空行。

### ④ 话题必须从下拉选中

直接打字 `#ChatGPT` 只是普通文本，不算话题。必须：

1. 输入 `#` → 停顿 400ms
2. 输入话题名 → 停顿 2000ms（等下拉）
3. 按 **Enter**（不要按方向键，会跳到第二项）

成功标志：正文里出现 `#ChatGPT[话题]#` 格式。

**输入的话题名可能被平台匹配成别的规范名**（如 `#AI新手` → `#AI新手村`），这是正常的。

### ⑤ Chrome 136+ 不能用默认 profile 开调试端口

症状：进程带 `--remote-debugging-port` 但端口不监听。

原因：新版 Chrome 拒绝在默认 user-data-dir 上开调试端口（防恶意软件读 Cookie）。

解法：必须加 `--user-data-dir=` 指向独立目录。

### ⑥ 视口过小会导致按钮在可视区外

发布页布局不会滚动，视口高度小于内容高度时，底部按钮不可见。

补救：`Emulation.setDeviceMetricsOverride` 放大视口，或用 `elementFromPoint` 在更大范围内扫描。

## 失败时怎么办

| 症状 | 排查 |
|---|---|
| `ECONNREFUSED` | 用户没启动 Chrome，或终端窗口被关了 |
| 找不到小红书标签 | Chrome 里没打开过 creator.xiaohongshu.com |
| 上传后无缩略图 | `input[type=file]` 选择器命中错，检查 DOM 数量 |
| 点发布无反应 | 坐标偏移，先 `elementFromPoint` 验证 |
| 跳转但没 success | 可能有平台风控提示，截图记录后人工判断 |

详细排查见 `references/troubleshooting.md`。

## 安全边界

- 只用正常网页界面操作，不调非官方写接口
- 不破解验证码、不做指纹伪装
- 遇到验证码 / 账号异常 / 风险提示，**立即停止并报告**，不重复点击
- 发布是不可逆的公开行为，**必须先跑 dry-run 出预览，确认后再加 `--publish`**

## 已知限制

- 一次只发一篇
- 不支持视频笔记
- 不支持定时发布
- 话题依赖平台联想词库，冷门话题可能匹配不到
