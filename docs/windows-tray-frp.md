# Windows Tray FRP Setup

This project includes a Windows tray launcher, but it does not include the
machine-specific FRP client binary or FRP client config. A new Windows machine
needs those FRP files prepared before the tray launcher can expose CodexUI
through the public FRP address.

## What Is External

The tray launcher depends on these project-external FRP files:

```text
frpc.exe
frpc.toml
```

The current local setup uses:

```text
C:\Users\youdo\Documents\Codex\2026-05-06\new-chat-2\frp\frp_0.68.1_windows_amd64\frpc.exe
C:\Users\youdo\Documents\Codex\2026-05-06\new-chat-2\frpc-hk-5173.toml
```

Other programs used by the tray launcher, such as `wscript.exe`,
`powershell.exe`, `cmd.exe`, `taskkill.exe`, `explorer.exe`, and `notepad.exe`,
are Windows-provided tools. `node.exe` and `pnpm` are required for running the
project itself, not specifically for FRP.

Runtime config, logs, and pid files are created automatically under:

```text
%LOCALAPPDATA%\CodexUI
```

These files do not need to be copied between machines.

## Prepare FRP On A New Machine

1. Download the official FRP Windows package from:

```text
https://github.com/fatedier/frp/releases
```

Use the Windows AMD64 package when running on normal 64-bit Windows:

```text
frp_0.68.1_windows_amd64.zip
```

2. Extract the zip and keep the `frpc.exe` path.

3. Create a local FRP client config file, for example `frpc.toml`:

```toml
serverAddr = "162.211.183.146"
serverPort = 443

auth.method = "token"
auth.token = "fill in the frps token from the server"
transport.tls.enable = true

[[proxies]]
name = "local-web"
type = "tcp"
localIP = "127.0.0.1"
localPort = 5189
remotePort = 18080
```

Field meanings:

- `serverAddr` and `serverPort` point to the self-hosted `frps` server.
- `auth.token` must match the token in the server's `/etc/frp/frps.toml`.
- `localPort` should point to the local public-auth proxy port. The tray
  launcher's current default is `5189`.
- `remotePort` is the public port on the FRP server. The current default is
  `18080`.

With the current server, the public address is:

```text
http://162.211.183.146:18080/
```

## Configure The Tray Launcher

Start the tray launcher once, then right-click the tray icon and choose
`Open config`. Set or verify these fields:

```json
{
  "frpEnabled": true,
  "frpExe": "C:\\path\\to\\frpc.exe",
  "frpConfig": "C:\\path\\to\\frpc.toml",
  "publicUrl": "http://162.211.183.146:18080/",
  "publicProxyPort": 5189
}
```

Save the config, then right-click the tray icon and run:

```text
Restart public proxy
Restart FRP tunnel
```

Restarting the tray launcher also applies the same config.

## Windows Security

Windows Defender may flag `frpc.exe` as a potentially unwanted tool because FRP
is a tunneling client. If the binary came from the official FRP release, allow
it in Windows Security or add the folder containing `frpc.exe` to the exclusion
list.

## Recommended Portable Layout

For a new machine, prefer a stable local layout instead of a temporary
Documents/Codex path:

```text
D:\Project\CodexUI\tools\frp\frpc.exe
D:\Project\CodexUI\config\frpc.toml
```

Do not commit the real `frpc.toml` if it contains a live token. Commit an
example file instead, such as:

```text
config\frpc.example.toml
```
