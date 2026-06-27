# Declarative Stream Server

LiveSuite uses `stream-server/` as a git submodule. The submodule package is `@livesuite/stream-server` and exposes a TypeScript declarative API for starting media servers. It no longer depends on Node Media Server, and stream paths are not pre-registered or whitelisted.

## Interface roles

- `StreamServerDeclaration`: declares the whole server, including enabled protocols.
- `RtmpProtocolDeclaration`: declares the RTMP listener and publish/play capability, without limiting stream paths.
- `HttpProtocolDeclaration`: declares a top-level HTTP playback outlet when a built-in protocol combination needs it.
- `ProtocolShapeDeclaration`: declares custom protocols, including transport, framing, reliability, and runtime shape.
- `ProtocolRuntimeShapeDeclaration`: declares the minimum protocol semantics required to run a service: routing, control negotiation, packet fields, media startup, and realtime policy.
- `HttpPlaybackDeclaration`: declares a protocol-level HTTP pull outlet for custom protocols that cannot be played directly by tools such as ffplay.
- `registerProtocolAdapter()`: registers future custom protocol implementations by protocol name.
- `createStreamServer()`: creates a lifecycle controller from a declaration.
- `DeclarativeStreamServer.start()`: starts every enabled protocol in the declaration.
- `DeclarativeStreamServer.stop()`: stops the server and releases ports.
- `DeclarativeStreamServer.on()`: registers one handler for a named event such as `published`, `player-connected`, or `error`.
- `DeclarativeStreamServer.off()`: removes a named event handler.
- `DeclarativeStreamServer.once()`: registers a named event handler that is removed after the first call.
- `DeclarativeStreamServer.describe()`: returns publish/play URLs for UI and tests.

## LiveSuite RTMP declaration

The Electron main process declares RTMP publish and play capability like this:

```ts
import { RtmpProtocol } from '@livesuite/stream-server';

const declaration = {
  name: 'LiveSuite RTMP Server',
  protocols: {
    rtmp: RtmpProtocol.declare({
      port: 1935,
      publish: true,
      play: true,
    }),
  },
};
```

RTMP publish and play both use the RTMP listener. HTTP playback is optional and should be declared only when a protocol needs an HTTP pull outlet.

## Runtime URLs

- RTMP publish: `rtmp://localhost:1935/{app}/{stream}`
- RTMP play: `rtmp://localhost:1935/{app}/{stream}`

Examples:

- `rtmp://localhost:1935/live/stream`
- `rtmp://localhost:1935/z/abc`

Replace `localhost` with a LAN IP for other machines on the same network.

## FFmpeg test commands

This machine has FFmpeg tools under `D:\feverapps\dwrg2\ffmpeg`:

```powershell
$ffmpegDir = 'D:\feverapps\dwrg2\ffmpeg'
$ffmpeg = Join-Path $ffmpegDir 'ffmpeg.exe'
$ffplay = Join-Path $ffmpegDir 'ffplay.exe'
$ffprobe = Join-Path $ffmpegDir 'ffprobe.exe'
```

Push a generated test stream:

```powershell
& $ffmpeg -re -f lavfi -i testsrc=size=1280x720:rate=30 -f lavfi -i sine=frequency=1000 -c:v libx264 -preset veryfast -tune zerolatency -c:a aac -f flv rtmp://localhost:1935/live/stream
```

Push to an arbitrary path:

```powershell
& $ffmpeg -re -f lavfi -i testsrc=size=1280x720:rate=30 -f lavfi -i sine=frequency=1000 -c:v libx264 -preset veryfast -tune zerolatency -c:a aac -f flv rtmp://localhost:1935/z/abc
```

Play through RTMP:

```powershell
& $ffplay rtmp://localhost:1935/live/stream
```

## Custom UDP protocol shape

Custom protocols are scoped first for trusted LAN, low-latency streaming: no encryption by default, UDP media transport preferred, and realtime behavior preferred over perfect delivery. A UDP media plane can still use a TCP control plane first, so the server has negotiated session state before receiving connectionless datagrams.

Custom protocols can declare lossy UDP behavior and TCP negotiation explicitly:

```ts
import { LowLatencyUdpProtocol } from '@livesuite/stream-server';

{
  protocols: {
    custom: [LowLatencyUdpProtocol.declare({
      protocol: 'livesuite-low-latency-v1',
      mediaPort: 25000,
      controlPort: 25002,
      httpPlaybackPort: 25001,
      publish: true,
      play: true,
    })],
  },
}
```

Shape fields intentionally stay small:

- `routing`: stream-path rules and duplicate publisher policy. `arbitrary` keeps paths such as `/z/abc` dynamic.
- `control`: control/negotiation channel. `kind: 'tcp'` lets a UDP media protocol establish publish/play sessions, stream ids, and heartbeat state first.
- `packet`: the media packet fields the adapter must expose to the runtime: session, stream identity, track, sequence, timestamp, keyframe, and config markers.
- `media`: startup cache policy for late subscribers.
- `realtime`: jitter, reorder, latency, and overflow behavior for LAN low-latency delivery.

The runtime rejects UDP declarations that claim fully reliable transport, so protocol behavior stays explicit. If a UDP protocol has no TCP control plane, packet declarations must still provide session id or path identity so the server can bind datagrams to streams. `httpPlayback` is bound to this custom protocol shape and produces an address template such as `http://localhost:25001/{app}/{stream}`; routes remain dynamic, so `/z/abc` does not need to be pre-registered. Custom adapters should use `createHttpPlaybackHeaders()` so browsers receive `Content-Disposition: inline` instead of an attachment-style response.

RTMP is also described through this same shape model by the runtime: TCP reliable transport, RTMP framing, same-transport control, and `config-then-keyframe` startup. Its current adapter still owns RTMP chunking and AMF behavior, but the public model is no longer separate from custom protocols.

The package exports protocol classes for upper services:

- `RtmpProtocol`: creates the built-in RTMP declaration and exposes the default RTMP shape.
- `CustomProtocol`: creates a fully custom protocol declaration when the caller wants to provide every shape field.
- `LowLatencyUdpProtocol`: creates the LAN low-latency UDP preset with optional TCP control negotiation.
- `RtmpProtocolAdapter`: exposes the built-in RTMP adapter class for direct integration and tests.

## Custom HTTP playback test

The submodule includes a small UDP fixture adapter that proves custom protocols can declare HTTP pull playback:

```powershell
cd stream-server
npm run test:custom-http
```

The test publishes one datagram to `/z/abc`, pulls `http://127.0.0.1:29136/z/abc`, verifies the payload and inline response header, and verifies that an unpublished path returns 404.
