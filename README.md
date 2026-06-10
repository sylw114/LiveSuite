# 直播套件，搭配[VideoStreamer](https://github.com/sylw114/AndroidVideoStreamer/)使用

它提供了rtmp流服务器和一个低延迟音频服务器（后者仅本程序提供）。在测试平台上可以达到约90ms的音频延迟。不过需要开启一些以音质和音频稳定性为代价的选项。如果不开启，延迟会逐渐从90ms开始增长，这是因为延迟取决于最慢的一个包，而最慢的包可能变得更慢。

它可以搭配[wasapi_relink](https://github.com/Litttlefish/wasapi_relink)使用以进一步降低音频延迟，但实际效果取决于你的设备，并效果不大（十几毫秒）

它使用了重排序以提高音频稳定性，在拥有足够冗余缓冲数据时，会将乱序音频重组成正常顺序的音频。但是你也可以禁用这一条（开启丢弃乱序包选项），以获取轻微的延迟提升。



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