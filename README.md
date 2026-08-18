# 直播套件，搭配[VideoStreamer](https://github.com/sylw114/AndroidVideoStreamer/)使用

它提供了rtmp流服务器和一个低延迟音频服务器（后者仅本程序提供）。在测试平台上可以达到约90ms的音频延迟。不过需要开启一些以音质和音频稳定性为代价的选项。如果不开启，延迟会逐渐从90ms开始增长，这是因为延迟取决于最慢的一个包，而最慢的包可能变得更慢。

它可以搭配[wasapi_relink](https://github.com/Litttlefish/wasapi_relink)使用以进一步降低音频延迟，但实际效果取决于你的设备，并效果不大（十几毫秒）

它使用了重排序以提高音频稳定性，在拥有足够冗余缓冲数据时，会将乱序音频重组成正常顺序的音频。但是你也可以禁用这一条（开启丢弃乱序包选项），以获取轻微的延迟提升。

## 低延迟视频输出

LiveSuite 专属的 QUIC/UDP 视频接收端默认只提供可拉取的 HTTP-FLV，不在界面内解码画面，也不会把每次推流自动写成文件。地址格式为：

```text
http://<LiveSuite IP>:<HTTP 输出端口>/<推流路径>.flv
```

例如 `/phone/stream` 在默认端口上的本机地址是 `http://localhost:8080/phone/stream.flv`。该地址可用于 ffplay、VLC，或 OBS 的“媒体源”（关闭“本地文件”后填入 URL）。

视频服务运行后，每条推流都可独立开始或结束 MP4 录制，不需要中断其他流。每条流也有独立的滚动回放缓存和缓存时长，可按需将最近一段画面保存成 MP4；断流后已形成的可解码缓存仍可单独保存或释放。两类文件都保存在系统“视频/LiveSuite/Recordings”目录。



### [wasapi_relink](https://github.com/Litttlefish/wasapi_relink)推荐配置（请保存为redirect_config.toml在subbuild文件夹中）

```toml
# 日志文件路径。"" (空字符串) 默认为当前工作目录。
log_path = ""
# 日志级别: Trace, Debug, Info, Warn, Error, Never
log_level = "Info"
# 仅记录到标准输出 (true) 或同时记录到标准输出和文件 (false)。
only_log_stdout = false

[capture]
# (通用) 目标设备周期，单位 0.1ms (u32)。
# 工具将计算最接近但不超过此持续时间、且在驱动允许范围内的周期大小。
# 例如：20 = 2ms。
target_period_hus = 20
# (通用) 对应采样率的目标缓冲区汇报长度（单位为音频帧）。
# 这个数值会自动向上取整到以硬件周期帧数为单位的值，同时会被限制在范围内。
target_buffer_len.48000 = 256
# (通用) 为此流启用原始处理 (bool)。
raw = true
# (通用) 在初始化前报告修改后的周期长度(如果程序真的请求了周期的话)。
force_period = true

[playback]

# 运行模式，可用的模式有：Normal, Compat, Ringbuf, Bypass
mode = "Compat"

# (Ringbuf 模式专用，可选) 为对应的采样率规定环形缓冲区尺寸（单位为帧）。
# 这个数值会自动向上取整到以硬件周期帧数为单位的值。
#ring_buffer_len.48000 = 340 # 差不多7ms的buffer

# (Compat 模式专用，可选) 为对应的采样率规定常规共享模式的缓冲区尺寸（单位为100纳秒）。
# 这个数值会直接用来创建应用侧缓冲区，设置得过低会被Windows自动限制。
compat_buffer_dur_hns.48000 = 0 # 这个会被限制到最低允许值
compat_buffer_dur_hns.96000 = 238350
```

## 开源许可证与合规

本项目使用 [license-checker](https://github.com/davglass/license-checker) 自动生成第三方依赖的许可证文档。

### 生成许可证文档

```bash
# 生成所有格式的许可证文档（推荐）
npm run licenses

# 仅生成 JSON 格式
npm run licenses:check

# 仅生成 CSV 格式
npm run licenses:csv

# 仅生成文本格式
npm run licenses:text
```

### 打包发布

```bash
# 一条命令完成全部构建与打包
npm run release
```

该命令会依次构建原生音频服务器与音频 QUIC 桥、`stream-server`、视频 QUIC
服务器和 Electron TypeScript，随后生成许可证文档并打包 NSIS 安装程序。任一步骤失败都会
立即停止。生成的是带许可协议、安装范围选择、安装目录选择、快捷方式和卸载入口的完整安装
向导，成功产物位于 `dist/LiveSuite Setup 1.0.0.exe`。

### 许可证文档说明

构建后，`licenses/` 目录将包含以下文件：

| 文件 | 格式 | 用途 |
|------|------|------|
| `licenses.json` | JSON | 程序化处理和集成 |
| `licenses.csv` | CSV | 电子表格和数据库导入 |
| `THIRD_PARTY_LICENSES.txt` | 文本 | 完整许可证声明，法律合规 |
| `LICENSE_SUMMARY.md` | Markdown | 许可证类型摘要，快速查看 |

这些文件会自动打包到安装程序的 `resources/licenses/` 目录中。

### 应用内查看

用户可以在应用内点击标题栏的"关于"按钮，查看第三方开源许可证信息。
