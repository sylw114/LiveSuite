





### 推荐配置（请保存为redirect_config.toml在subbuild文件夹中）

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