# 故障排查

## 连接类

### `ECONNREFUSED 127.0.0.1:9333`

**原因**：Chrome 没以调试模式启动，或终端窗口被关了。

**检查**：
```bash
lsof -nP -iTCP:9333 -sTCP:LISTEN
```
无输出 = 端口没在监听。

**注意一个假象**：进程列表里能看到带 `--remote-debugging-port=9333` 的 Chrome，但端口不监听——这说明用了默认 profile，被 Chrome 136+ 的安全策略拒绝。必须加 `--user-data-dir=`。

### `WebSocket 连接失败`

daemon 或浏览器刚启动，稍等 2-3 秒重试。或 `/json/version` 返回了但 WS 端点异常，重启 Chrome。

### `未找到小红书标签页`

那个 Chrome 窗口里没打开过 `creator.xiaohongshu.com`。先打开，再跑脚本。

---

## 页面类

### `未登录，请先扫码`

URL 跳到了 `/login`。在那个 Chrome 窗口里扫码登录（只需一次，登录态保存在 profile 里）。

### `找不到「上传图文」入口`

可能：
- 页面还没加载完 → 加大 `navigateToPublish` 里的 sleep
- 已经停在图文模式 → 属于正常，可以跳过这一步

### 上传后没有缩略图 / 计数不是 `N/18`

`input[type=file]` 选择器命中了错的元素。检查：

```js
document.querySelectorAll('input[type=file]').length
```

如果 > 1，需要按 `accept` 属性筛选：
```js
[...document.querySelectorAll('input[type=file]')].findIndex(e => (e.accept||'').includes('image'))
```

### 标题填不进去

小红书标题是受控 input，`element.value = x` 不会触发 React 更新。必须用 `Input.insertText`（模拟真实输入）。

---

## 发布按钮类

### `未找到发布按钮（XHS-PUBLISH-BTN）`

按钮在 **shadow DOM** 里，普通选择器抓不到。

排查步骤：

1. 先确认按钮真的在视口内。发布页不滚动，视口太小会把底部裁掉：
   ```js
   JSON.stringify({w:innerWidth,h:innerHeight,sh:document.body.scrollHeight})
   ```
   如果 `sh > h` 且页面不能滚，说明内容溢出了。

2. 放大视口再找：
   ```js
   Emulation.setDeviceMetricsOverride({width:1440,height:1200,deviceScaleFactor:1,mobile:false})
   ```

3. 用 `elementFromPoint` 逐点扫：
   ```js
   document.elementFromPoint(658, 608).tagName   // 期望 XHS-PUBLISH-BTN
   ```

按钮大致位置：`x ≈ 视口宽 × 0.55`，`y ≈ 视口高 × 0.92`。

### 点了没反应

- 坐标算错 → 先 `elementFromPoint` 验证
- 按钮 disabled（内容不合规/未填完）→ 检查页面有没有红色提示
- 事件类型不对 → 必须是完整序列：`mouseMoved` → `mousePressed` → `mouseReleased`

### 跳转了但不是 success 页

读取页面文本确认是"发布成功"还是报错。**不要重复点击发布**。

---

## 内容类

### 正文空行太多

用了 `rawKeyDown + char + keyUp` 三个事件。改成只发 `keyDown` + `keyUp`，一次 Enter = 一个空行。

### 话题没变成 `[话题]#`

- 下拉没出来 → 输入后等太短，加到 2000ms
- 按了方向键 → 会跳到第二项，别按，直接 Enter
- 话题名太冷门 → 平台词库没有，换成联想词里的

### 话题选错了（比如想选 `#ChatGPT` 结果进了 `#ChatGPT5`）

删掉重来。删除时注意：**不要盲删固定次数**，容易连正文一起删掉。用 `Range` 定位后逐字确认，或者清空整个正文重建。

---

## 状态类

### 页面出现"编辑于 刚刚"

这是编辑器的时间戳，**不代表已发布**。判断发布成功只看 URL 是否含 `/publish/success`。

### `/json/list` 里的 URL 显示 login，但实际是登录态

标签页 URL 有历史残留：打开时经过 login 页再跳转，`/json/list` 记录的是**最初 URL**。实际登录态要以 DOM 为准：

```js
document.body.innerText.includes('你的用户名')   // true = 登录着
```

或者直接导航到目标页，看是否被踢回 `/login`。不要看到 URL 含 login 就断定掉线。

### 笔记管理页 innerText 拿不到笔记条目

列表是异步渲染的。导航后**至少等 6 秒**再读。另外页面用 tab（全部/已发布/审核中/未通过）切换视图，注意当前 tab；`全部 N` 的 N 是笔记总数。

数据解析时数字列的顺序是：浏览 · 评论 · 点赞 · 收藏 · 分享。

### 发布后想确认结果

去 `creator.xiaohongshu.com/new/note-manager`，看列表第一条的状态：
- 审核中 → 已提交，等审核
- 已发布 → 审核通过
- 未通过 → 看审核意见

---

## 环境限制（不是 bug）

| 限制 | 说明 |
|---|---|
| 不能让 Agent 自己启动常驻 Chrome | 进程活不过一轮对话，必须用户终端启动 |
| macOS 辅助功能权限拿不到 | `osascript` 控制 System Events / Chrome 均报 -10004，GUI 模拟路线不可用 |
| 隔离 profile 的 Chrome 起不来 | 沙箱下 `sandbox initialization failed`，且 GPU 进程崩溃 |
| BrowserSkill 扩展在此页面失效 | 页面频繁重建 DOM，写操作上下文一次性失效 |

## ⚠️ 高频坑：新手引导弹窗挡住话题选择（第 ⑦ 坑）

**症状**：话题输入后下拉正常弹出，但按 Enter 不选中，话题变成死文本。下次运行又正常。

**根因**：上传图片后小红书弹"图片可以编辑啦"引导（`feature-guide` 弹窗），抢占焦点。它只在 profile 首次上传时出现，所以"上次成功这次失败"极具迷惑性。

**修复**：发布流程每个关键步骤前调用 `dismissPopups()`。原实现用 `b.offsetParent` 判断可见性——**position:fixed 弹窗里 offsetParent 是 null**，导致永远匹配不到。已改为 `getBoundingClientRect().width>0`。

**教训**：判断元素可见性永远用 `getBoundingClientRect`，不要用 `offsetParent`。

## ⚠️ 草稿恢复导致内容追加（第 ⑧ 坑）

**症状**：标题/正文填入后变成"旧内容+新内容"拼接。

**根因**：小红书发布页会恢复上次未发布的草稿，`insertText` 是追加不是覆盖。

**修复**：`fillTitle` 用 `e.select()` 全选后 Backspace；`fillBody` 用 `getSelection().selectAllChildren` + Backspace。填入前先清空。
