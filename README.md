# xhs-publish-cdp

通过 Chrome DevTools Protocol 直连发布小红书图文笔记。

不依赖浏览器扩展、不依赖 macOS 辅助功能权限、不破解验证码，全程走正常网页界面。

## 为什么需要它

如果你试过用常规方式自动化小红书发布，大概会撞上这三堵墙：

| 方案 | 卡在哪 |
|---|---|
| 浏览器扩展注入 | 小红书发布页每 ~2 秒重建整棵 DOM，写操作上下文刚拿到就失效 |
| AppleScript / GUI 模拟 | 需要辅助功能 + Apple Events 权限，`osascript` 常年 -10004 |
| Playwright 自启浏览器 | 新的 profile 没有登录态，重新登录又要处理风控 |

CDP 直连能绕开前两个，同时用一个常驻的独立 profile 保住登录态。

关键突破点是 **`DOM.setFileInputFiles`** —— 这是唯一能把本地文件塞进 `<input type="file">` 的 CDP 命令，而且**不要求元素可见**，正好是扩展方案最容易卡住的地方。

## 前置条件

### 1. Chrome 必须以调试模式启动

```bash
bash scripts/launch-chrome.sh            # 默认端口 9333
# 或手动：
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9333 \
  --user-data-dir="$HOME/xhs-cdp-profile"
```

**注意两点**：

- Chrome 136+ 不允许在**默认 profile** 上开调试端口（防恶意软件读 Cookie），必须用 `--user-data-dir` 指向独立目录
- 这个 Chrome **必须在终端里起、终端不能关**。如果你在 Agent 环境里跑，Agent 侧起的进程活不过一轮对话

### 2. 首次扫码登录

在新窗口里打开 `creator.xiaohongshu.com` 扫码。登录态长期保存在这个 profile 里，之后不用重复登录。

### 3. 验证端口

```bash
node -e "require('http').get({host:'127.0.0.1',port:9333,path:'/json/version'},r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>console.log(d))}).on('error',e=>console.log('端口不通:',e.code))"
```

返回 Browser 版本即正常。

## 用法

```bash
# 先跑 dry-run：只填内容 + 出预览，不发布
node scripts/publish.mjs \
  --title "标题" \
  --body-file body.txt \
  --images a.png,b.png,c.png \
  --tags "ChatGPT,AI新手" \
  --preview preview.png

# 确认预览无误后，加 --publish 真正发布
node scripts/publish.mjs ... --publish
```

| 参数 | 说明 |
|---|---|
| `--title` | 标题，必填 |
| `--body-file` | 正文文件，段落用空行分隔 |
| `--body` | 也可以直接传字符串 |
| `--images` | 图片绝对路径，逗号分隔，**顺序即发布顺序** |
| `--tags` | 话题，逗号分隔，不带 `#` |
| `--port` | CDP 端口，默认 9333 |
| `--preview` | 预览截图保存路径 |
| `--publish` | 真正点击发布；不传则停在预览 |

### 发布后监控数据（只读）

```bash
node scripts/read-stats.mjs           # 人读格式
node scripts/read-stats.mjs --json    # 机器格式，适合接定时任务
```

输出笔记管理页的全部笔记：审核状态计数、每篇的浏览/评论/点赞/收藏/分享。纯只读，适合配 cron/launchd 定时跑。

## 执行流程

1. 连 CDP → 找小红书标签页（没有就新建）
2. 导航到发布页
3. 点「上传图文」
4. `DOM.setFileInputFiles` 塞图片
5. `Input.insertText` 填标题
6. 正文逐段输入，段间按一次 Enter
7. 话题：输入 `#` + 名称 → 等下拉 → Enter 选中
8. 截图预览
9. `elementFromPoint` 定位发布按钮 → 真实鼠标事件点击
10. 轮询 URL 确认跳到 `/publish/success`

## 六个实测绘出来的坑

### ① 发布按钮抓不到

按钮是自定义组件 `<XHS-PUBLISH-BTN>`，在 **shadow DOM** 里。`querySelectorAll` 找不到，文本匹配也无效。

解法：坐标 + `elementFromPoint` 命中。

```js
document.elementFromPoint(658, 608).tagName   // → XHS-PUBLISH-BTN
```

按钮大致在 `x ≈ 视口宽 × 0.55`、`y ≈ 视口高 × 0.92`。点击前务必验证命中元素。

### ② 图片必须用 DOM.setFileInputFiles

`Runtime.evaluate` 里没法给 file input 塞本地文件（浏览器安全限制）。而且这条命令**不要求元素可见**，隐藏 input 也能用。

### ③ 正文换行：一次 Enter，别发三个键盘事件

`rawKeyDown + char + keyUp` 三连会被算成多次换行，产生 4–5 个空行。

正确：只发 `keyDown` + `keyUp`。

### ④ 话题必须从下拉里选

直接打字 `#ChatGPT` 只是普通文本。必须：输入 `#` → 停顿 → 输入名称 → 停顿 2 秒等下拉 → **按 Enter**。

⚠️ **别按方向键**，会跳到第二项。我因此误选过 `#ChatGPT5`。

成功标志：正文里出现 `#ChatGPT[话题]#` 格式。输入的名字可能被平台匹配成规范名（`#AI新手` → `#AI新手村`），属正常。

### ⑤ Chrome 136+ 默认 profile 不能开调试端口

症状很迷惑：进程列表里能看到带 `--remote-debugging-port` 的 Chrome，但端口不监听。

原因就是默认 user-data-dir 被拒。加 `--user-data-dir=` 即可。

### ⑥ 视口太小会让按钮跑到可视区外

发布页不会滚动，视口高度小于内容高度时底部按钮不可见。

补救：`Emulation.setDeviceMetricsOverride` 放大视口，或在更大范围扫 `elementFromPoint`。

## 安全边界

- 只用正常网页界面操作，不调非官方写接口
- 不破解验证码、不做指纹伪装、不用代理池
- 遇到验证码 / 账号异常 / 风险提示，立即停止
- 发布是不可逆的公开行为，**先 dry-run 出预览，确认后再 `--publish`**

## 已知限制

- 一次只发一篇
- 不支持视频笔记
- 不支持定时发布
- 话题依赖平台联想词库，冷门话题可能匹配不到

## 环境

- macOS + Chrome 120+
- Node.js ≥ 21（用到内置 WebSocket，无需第三方依赖）

## License

MIT
