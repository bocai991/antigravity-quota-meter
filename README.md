# Antigravity Quota Meter（额度速览）

一个轻量级 **Google Antigravity** 原生 UI 插件（Sidecar），无需进入设置页面，即可在左侧导航栏的 **「扩展」** 区域或对话右侧辅助面板随时查看三个额度池（**Gemini 模型**、**Claude 与 GPT 模型**、**Gemini 4 Argon**）的实时剩余比例、消耗速率与重置时间。

> **零 Token 消耗**：本插件不调用任何大模型，仅只读查询本机 Antigravity 语言服务器的 `RetrieveUserQuotaSummary` 接口。

---

## 功能特性

1. **三池额度一目了然**
   - 实时展示 **Gemini 模型**（5 小时 + 每周）、**Claude 与 GPT 模型**（5 小时 + 每周）、**Gemini 4 Argon**（每周）的剩余百分比、进度条与重置倒计时。
   - 颜色分级：🟢 `> 50%` 充足、🟡 `20%–50%` 偏低、🔴 `< 20%` 告急。
   - 支持展开查看每个额度池下包含的具体模型列表。

2. **消耗速率、耗尽预估与迷你趋势曲线**
   - 自动记录本地额度变化快照，绘制 SVG 迷你趋势折线（5 小时池显示近 5 小时，周额度池显示近 7 天）。
   - 根据近 45 分钟净消耗计算 `消耗 x%/小时`，并预估 `约 N 小时/分钟后耗尽` 或 `重置前用不完`（自动过滤服务端 `< 0.1%` 级别抖动）。

3. **低额度预警 & 恢复回血通知**
   - 当任一额度池低于自定义阈值（默认 `20%`）或跌破 `5%` 时，自动弹出系统通知（Windows 原生 Toast）并记录在面板的“最近提醒”中。
   - 当耗尽的额度池刷新恢复至 `>= 90%` 时，自动发送“额度已恢复”通知。
   - 每个阈值仅提醒一次，不重复打扰。

4. **单次任务“油耗”计量**
   - 类似秒表计次：开始大任务前点击 **“开始计量”**，任务完成后点击 **“结束并保存”**，即可精确查看本次任务在各个额度池上分别消耗了多少百分比（自动兼容计量期间跨越重置的情况）。
   - 保留最近 15 条任务油耗历史，方便对比不同模型（如 Hydrogen、Neon、Argon、Claude Opus）的额度消耗差异。

5. **智能切换模型建议**
   - 当某个额度池余量低于阈值或预计在重置前 45 分钟内耗尽时，面板顶部自动提示切换至余量充足的其他额度池及推荐模型。

---

## 资源占用与隐私

- **0 Token 消耗**：纯本地 loopback HTTP 调用，不向任何外部服务器发送数据。
- **低频轮询**：后台默认每 `2 分钟` 轮询一次（可在面板设置中调整为 `1 / 2 / 5 / 10 分钟`）；前端面板直接读取后台内存缓存，且面板隐藏时不轮询。
- **轻量存储**：仅在数值发生变化时落盘；24 小时前的采样自动稀疏化为 15 分钟一条，8 天前的数据自动清理，历史文件通常小于 `100 KB`。

---

## 安装方法

将本仓库克隆到 Antigravity 的全局插件目录 `~/.gemini/config/plugins/quota-meter`：

### Windows (PowerShell)
```powershell
git clone https://github.com/bocai991/antigravity-quota-meter.git "$env:USERPROFILE\.gemini\config\plugins\quota-meter"
```

### macOS / Linux
```bash
git clone https://github.com/bocai991/antigravity-quota-meter.git ~/.gemini/config/plugins/quota-meter
```

克隆完成后，Antigravity 会自动发现并启动插件，无需额外配置或安装第三方 npm 依赖。

---

## 使用方式

- **从左侧「扩展」栏打开**：在界面左侧栏的 **「扩展」** 分组下（位于「自定义配置」与「项目列表」之间），直接点击 **“🟢 额度”**。
- **在对话中一键打开**：在 Antigravity 对话中点击胶囊链接 `[额度](sidecar://quota-meter/quota_meter/)` 打开右侧辅助面板。

---

## 目录结构

```text
quota-meter/
├── plugin.json                        # 插件清单
├── README.md                          # 说明文档
├── LICENSE                            # MIT 许可证
├── assets/
│   └── logo.svg                       # 插件图标
└── sidecars/
    └── quota_meter/
        ├── sidecar.json               # Sidecar 视图与启动配置（SIDEBAR + AUX_PANE）
        ├── package.json               # Node ESM 模块声明
        ├── main.mjs                   # 后台服务：额度采样、速率计算、油耗统计、Windows Toast 通知
        └── index.html                 # 前端界面：自适应亮/暗主题、SVG 迷你趋势图、交互面板
```
