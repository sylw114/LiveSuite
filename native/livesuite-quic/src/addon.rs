//! napi addon 导出层:Electron 主进程通过 `.node` 内嵌加载本模块。
//! Node 侧负责 HTTP-FLV 拉流(`src/main/quicPull.ts`),本模块只提供
//! 收流(QUIC/UDP)、会话状态、录制、回放缓存与帧缓冲;拉流侧通过
//! `take_frames` 轮询取帧,事件通过 `on_event` 注册的回调推送 JSON。

use napi_derive::napi;

use crate::frame_hub::FrameHub;
use crate::{
    create_endpoint, handle_quic_connection, run_udp_server, Options, RuntimeMediaController,
    RuntimeMediaStatus,
};
use napi::bindgen_prelude::Buffer;
use napi::threadsafe_function::{
    ErrorStrategy, ThreadsafeFunction, ThreadsafeFunctionCallMode,
};
use napi::{JsFunction, Result as NapiResult};
use serde_json::json;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 运行中的服务句柄:runtime 持有 QUIC/UDP 任务,命令通过 block_on 执行。
struct ServerHandle {
    runtime: tokio::runtime::Runtime,
    hub: Arc<FrameHub>,
    controller: Arc<RuntimeMediaController>,
    tasks: Vec<tokio::task::JoinHandle<()>>,
}

static SERVER: Mutex<Option<ServerHandle>> = Mutex::new(None);

/// 事件回调:所有 `emit_json` 输出都推送到这里(替代原来的 stdout JSON 行)。
static EVENT_SINK: Mutex<Option<ThreadsafeFunction<String, ErrorStrategy::Fatal>>> =
    Mutex::new(None);

fn to_napi_error(error: anyhow::Error) -> napi::Error {
    napi::Error::from_reason(format!("{error:#}"))
}

fn server_lock() -> NapiResult<std::sync::MutexGuard<'static, Option<ServerHandle>>> {
    SERVER.lock().map_err(|_| napi::Error::from_reason("server state lock poisoned"))
}

/// 事件输出:推送到 JS 回调(如果已注册),否则丢弃。
pub fn emit_json(value: serde_json::Value) {
    let text = value.to_string();
    let Ok(sink) = EVENT_SINK.lock() else {
        return;
    };
    if let Some(sink) = sink.as_ref() {
        let _ = sink.call(text, ThreadsafeFunctionCallMode::NonBlocking);
    }
}

fn parse_session_id(value: &str) -> NapiResult<u64> {
    u64::from_str_radix(value, 16)
        .map_err(|_| napi::Error::from_reason(format!("invalid sessionId: {value}")))
}

#[napi(object)]
pub struct StartOptions {
    pub bind: String,
    pub port: u32,
    pub udp_fallback_port: Option<u32>,
    pub recording_dir: String,
    pub max_latency_ms: u32,
    pub reorder_window_ms: u32,
    pub synchronize_pull_streams: bool,
    pub include_audio_in_pull: bool,
}

#[napi(object)]
pub struct ReadyInfo {
    pub port: u32,
    pub udp_fallback_port: Option<u32>,
    pub recording_dir: String,
    pub synchronize_pull_streams: bool,
    pub include_audio_in_pull: bool,
}

#[napi(object)]
pub struct PullFrame {
    pub ordinal: f64,
    pub kind: u8,
    pub pts_us: f64,
    pub timeline_us: Option<f64>,
    pub release_epoch_ms: Option<f64>,
    pub data: Buffer,
}

#[napi(object)]
pub struct TakeFramesResult {
    pub resync: bool,
    pub closed: bool,
    pub frames: Vec<PullFrame>,
}

#[napi(object)]
pub struct CommandResult {
    pub session_id: String,
    pub ok: bool,
    pub active: bool,
    pub recording_enabled: bool,
    pub replay_buffering: bool,
    pub replay_duration_ms: Option<f64>,
    pub recording_path: Option<String>,
    pub paths: Vec<String>,
    pub synchronize_pull_streams: bool,
    pub message: Option<String>,
}

impl CommandResult {
    fn from_status(
        status: &RuntimeMediaStatus,
        session_id: u64,
        ok: bool,
        paths: Vec<String>,
        synchronize_pull_streams: bool,
        message: Option<String>,
    ) -> Self {
        Self {
            session_id: format!("{session_id:016x}"),
            ok,
            active: status.active,
            recording_enabled: status.recording_enabled,
            replay_buffering: status.replay_duration_ms.is_some(),
            replay_duration_ms: status.replay_duration_ms.map(|ms| ms as f64),
            recording_path: status.recording_path.as_ref().map(|p| p.display().to_string()),
            paths,
            synchronize_pull_streams,
            message,
        }
    }
}

/// 注册全局事件回调。必须在 start 之前调用。
#[napi]
pub fn on_event(callback: JsFunction) -> NapiResult<()> {
    let tsfn: ThreadsafeFunction<String, ErrorStrategy::Fatal> =
        callback.create_threadsafe_function(0, |ctx| Ok(vec![ctx.value]))?;
    let mut sink = EVENT_SINK
        .lock()
        .map_err(|_| napi::Error::from_reason("event sink lock poisoned"))?;
    *sink = Some(tsfn);
    Ok(())
}

/// 启动收流服务(QUIC + 可选 UDP 回退),同步返回就绪信息。
#[napi]
pub fn start(options: StartOptions) -> NapiResult<ReadyInfo> {
    // 先清理可能残留的旧实例。
    stop()?;
    let options = Options::from_start_options(&options).map_err(to_napi_error)?;
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .thread_name("livesuite-quic")
        .build()
        .map_err(|error| napi::Error::from_reason(format!("tokio runtime: {error}")))?;
    // quinn 的 `Endpoint::server` 内部通过 `Handle::try_current()` 探测
    // runtime 上下文并依赖它驱动收包;必须在 tokio runtime 上下文内创建。
    let endpoint = {
        let _guard = runtime.enter();
        create_endpoint(&options).map_err(to_napi_error)?
    };
    let hub = Arc::new(FrameHub::new(
        options.synchronize_pull_streams,
        options.max_latency_ms,
    ));
    let controller = Arc::new(RuntimeMediaController::new(options.recording_dir.clone()));
    let mut tasks = Vec::new();

    // 周期按各流观测延迟重新选择对齐延迟,保证被选同步的流都平滑播放。
    let alignment_hub = hub.clone();
    tasks.push(runtime.spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(1));
        loop {
            interval.tick().await;
            alignment_hub.update_alignment_delay();
        }
    }));

    if let Some(port) = options.udp_fallback_port {
        let socket = {
            let address = std::net::SocketAddr::new(options.bind, port);
            runtime
                .block_on(tokio::net::UdpSocket::bind(address))
                .map_err(|error| {
                    napi::Error::from_reason(format!("failed to bind UDP fallback on {address}: {error}"))
                })?
        };
        let udp_options = options.clone();
        let udp_hub = hub.clone();
        let udp_controller = controller.clone();
        tasks.push(runtime.spawn(async move {
            if let Err(error) = run_udp_server(
                std::sync::Arc::new(socket),
                udp_options,
                (*udp_hub).clone(),
                (*udp_controller).clone(),
            )
            .await
            {
                emit_json(json!({ "type": "error", "message": format!("UDP fallback: {error:#}") }));
            }
        }));
    }

    // QUIC accept 循环。
    let accept_options = options.clone();
    let accept_hub = hub.clone();
    let accept_controller = controller.clone();
    tasks.push(runtime.spawn(async move {
        while let Some(incoming) = endpoint.accept().await {
            let connection_options = accept_options.clone();
            let connection_hub = accept_hub.clone();
            let connection_controller = accept_controller.clone();
            tokio::spawn(async move {
                if let Err(error) = handle_quic_connection(
                    incoming,
                    connection_options,
                    (*connection_hub).clone(),
                    (*connection_controller).clone(),
                )
                .await
                {
                    emit_json(json!({
                        "type": "error",
                        "message": format!("QUIC connection: {error:#}")
                    }));
                }
            });
        }
    }));

    let handle = ServerHandle {
        runtime,
        hub,
        controller,
        tasks,
    };
    *server_lock()? = Some(handle);
    Ok(ReadyInfo {
        port: options.port.into(),
        udp_fallback_port: options.udp_fallback_port.map(u16::into),
        recording_dir: options.recording_dir.display().to_string(),
        synchronize_pull_streams: options.synchronize_pull_streams,
        include_audio_in_pull: options.include_audio_in_pull,
    })
}

/// 停止收流服务,中止所有任务。
#[napi]
pub fn stop() -> NapiResult<()> {
    let handle = server_lock()?.take();
    if let Some(mut handle) = handle {
        for task in handle.tasks.drain(..) {
            task.abort();
        }
        // 等待任务退出,避免 runtime drop 时任务仍在运行。
        handle.runtime.block_on(async {
            tokio::time::sleep(Duration::from_millis(50)).await;
        });
        drop(handle.runtime);
    }
    Ok(())
}

fn with_server<T>(f: impl FnOnce(&ServerHandle) -> NapiResult<T>) -> NapiResult<T> {
    let guard = server_lock()?;
    let handle = guard
        .as_ref()
        .ok_or_else(|| napi::Error::from_reason("LiveSuite 低延迟服务器尚未运行"))?;
    f(handle)
}

fn command_result(
    runtime: &tokio::runtime::Runtime,
    hub: &FrameHub,
    controller: &RuntimeMediaController,
    session_id: u64,
    action: impl std::future::Future<Output = anyhow::Result<Vec<std::path::PathBuf>>>,
) -> NapiResult<CommandResult> {
    let synchronize = hub.synchronize_enabled();
    let result = runtime.block_on(action);
    let status = runtime.block_on(controller.status(session_id));
    match result {
        Ok(paths) => Ok(CommandResult::from_status(
            &status,
            session_id,
            true,
            paths.into_iter().map(|path| path.display().to_string()).collect(),
            synchronize,
            None,
        )),
        Err(error) => Ok(CommandResult::from_status(
            &status,
            session_id,
            false,
            Vec::new(),
            synchronize,
            Some(format!("{error:#}")),
        )),
    }
}

#[napi]
pub fn start_recording(session_id: String) -> NapiResult<CommandResult> {
    let session_id = parse_session_id(&session_id)?;
    with_server(|handle| {
        let controller = handle.controller.clone();
        let action = async move { controller.start_recording(session_id).await };
        command_result(&handle.runtime, &handle.hub, &handle.controller, session_id, action)
    })
}

#[napi]
pub fn stop_recording(session_id: String) -> NapiResult<CommandResult> {
    let session_id = parse_session_id(&session_id)?;
    with_server(|handle| {
        let controller = handle.controller.clone();
        let action = async move { controller.stop_recording(session_id).await };
        command_result(&handle.runtime, &handle.hub, &handle.controller, session_id, action)
    })
}

#[napi]
pub fn start_replay_buffer(session_id: String, duration_ms: u32) -> NapiResult<CommandResult> {
    let session_id = parse_session_id(&session_id)?;
    with_server(|handle| {
        let controller = handle.controller.clone();
        let action = async move {
            if !(5_000..=300_000).contains(&duration_ms) {
                anyhow::bail!("replay buffer duration must be 5 to 300 seconds");
            }
            controller
                .start_replay_buffer(session_id, u64::from(duration_ms))
                .await
                .map(|_| Vec::new())
        };
        command_result(&handle.runtime, &handle.hub, &handle.controller, session_id, action)
    })
}

#[napi]
pub fn save_replay_buffer(session_id: String) -> NapiResult<CommandResult> {
    let session_id = parse_session_id(&session_id)?;
    with_server(|handle| {
        let controller = handle.controller.clone();
        let action = async move { controller.save_replay_buffer(session_id).await };
        command_result(&handle.runtime, &handle.hub, &handle.controller, session_id, action)
    })
}

#[napi]
pub fn stop_replay_buffer(session_id: String) -> NapiResult<CommandResult> {
    let session_id = parse_session_id(&session_id)?;
    with_server(|handle| {
        let controller = handle.controller.clone();
        let action = async move {
            controller
                .stop_replay_buffer(session_id)
                .await
                .map(|_| Vec::new())
        };
        command_result(&handle.runtime, &handle.hub, &handle.controller, session_id, action)
    })
}

#[napi]
pub fn set_synchronize_pull_streams(enabled: bool) -> NapiResult<CommandResult> {
    with_server(|handle| {
        handle.hub.set_synchronize(enabled);
        let status = RuntimeMediaStatus::inactive(0);
        Ok(CommandResult::from_status(
            &status,
            0,
            true,
            Vec::new(),
            handle.hub.synchronize_enabled(),
            None,
        ))
    })
}

/// 拉流侧轮询取帧:返回 ordinal 大于 `after_ordinal` 的帧。
#[napi]
pub fn take_frames(session_id: String, after_ordinal: f64) -> NapiResult<TakeFramesResult> {
    let session_id = parse_session_id(&session_id)?;
    let after = after_ordinal.max(0.0) as u64;
    let (resync, closed, frames) = with_server(|handle| {
        Ok(handle
            .hub
            .take_frames(session_id, after)
            .unwrap_or((false, true, Vec::new())))
    })?;
    Ok(TakeFramesResult {
        resync,
        closed,
        frames: frames
            .into_iter()
            .map(|frame| PullFrame {
                ordinal: frame.ordinal as f64,
                kind: frame.kind,
                pts_us: frame.pts_us as f64,
                timeline_us: frame.timeline_us.map(|value| value as f64),
                release_epoch_ms: frame.release_epoch_ms.map(|value| value as f64),
                data: Buffer::from(frame.data.to_vec()),
            })
            .collect(),
    })
}

/// 同步信息 JSON,供 Node 拉流 HTTP 服务的 `/livesuite/sync-info` 端点返回。
#[napi]
pub fn sync_info_json() -> NapiResult<String> {
    with_server(|handle| Ok(handle.hub.sync_info_json()))
}
