# M3U8 Sniffer & Downloader

Chrome 浏览器扩展，自动嗅探网页中的 m3u8 视频流地址，支持下载为 m3u8 文件或转码合并为 MP4。

## 功能

- **m3u8 嗅探** — webRequest 拦截 `*.m3u8` 请求 + DOM `<video>` 标签检测，自动发现视频流
- **下载模式** — 仅下载 .m3u8 索引文件，或下载所有 TS 分片后合并为 MP4
- **MP4 合并** — 通过 ffmpeg `-c copy` 无损拼接，速度快
- **并发下载** — 同时下载 5 个 TS 分片
- **AES-128 解密** — 支持 EXT-X-KEY 加密的 m3u8 流
- **多码率选择** — 自动选取最高码率的子播放列表
- **多任务管理** — 管理器支持添加多个下载任务，各自独立进度
- **实时进度** — 显示百分比、已下载量、速度、ETA

## 项目结构

```
├── extension/                  # Chrome 扩展
│   ├── manifest.json           # 扩展清单 (Manifest V3)
│   ├── background.js           # Service Worker — 嗅探拦截
│   ├── content.js              # 内容脚本 — DOM 视频检测
│   ├── popup/                  # 弹窗界面
│   └── manager/                # 下载管理器页面
├── native-host/                # Native Messaging Host
│   ├── host.js                 # 下载后端 (Node.js)
│   ├── host_launcher.bat       # 启动脚本
│   ├── install.bat             # 一键安装脚本
│   ├── com.m3u8.sniffer.json   # Native Host 清单模板
│   └── package.json
└── README.md
```

## 安装步骤

### 前提条件

- [Node.js](https://nodejs.org/)（运行下载后端）
- [ffmpeg](https://ffmpeg.org/)（可选，MP4 合并需要）

### 1. 加载扩展

打开 Chrome 浏览器，访问 `chrome://extensions/`：

1. 开启右上角 **「开发者模式」**
2. 点击 **「加载已解压的扩展程序」**
3. 选择本项目中的 `extension/` 目录
4. 加载完成后记下页面显示的 **32 位扩展 ID**（类似 `nkaebidaipanapffkppiofbepkeakmmg`）

### 2. 安装 Native Host

右键以 **管理员身份** 运行 `native-host/install.bat`：

1. 脚本自动检测 Node.js 和 ffmpeg 是否已安装
2. 输入第 1 步记下的扩展 ID
3. 脚本自动完成：
   - 生成启动脚本 `host_launcher.bat`
   - 生成 Native Host 清单 `com.m3u8.sniffer.json`
   - 写入 Windows 注册表（Chrome / Chromium）

### 3. 开始使用

1. 访问任意视频网站页面
2. 点击扩展图标，弹出窗口中会列出检测到的 m3u8 地址
3. 点击地址旁的 **「下载 m3u8」** 或 **「下载 MP4」** 按钮
4. 点击 **「下载管理器」** 查看所有任务的进度
5. 文件默认保存到项目根目录

## 注意事项

- 下载 MP4 需要安装 ffmpeg，否则仅支持下载 m3u8 索引文件
- `native-host/extension_id.txt` 为本地文件，含用户扩展 ID，已被 .gitignore 排除
- 更换浏览器或扩展 ID 后需重新运行 `install.bat`
