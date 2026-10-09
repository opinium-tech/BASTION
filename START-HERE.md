# Computer Swarm Desktop — One-App Build

## What this builds
One portable Windows x64 executable: `dist\Computer-Swarm-Setup-Free.exe`.
It opens a native desktop window (not Chrome) and asks for **Operator** or **Agent** on first run. The selection is saved per Windows user and used on later launches. The app's Operator dashboard runs inside its own app window.

## Build once on Windows
1. Install Node.js 22 LTS x64.
2. Extract this ZIP.
3. Open PowerShell in the extracted `computer-swarm-final` folder.
4. Run:

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\build-all.ps1
```

The first build downloads Electron and dependencies. It requires internet access. The final single-file app is `dist\Computer-Swarm-Setup-Free.exe`. The build script checks that the file really exists and stops on failure.

## Use on PCs
Copy only `Computer-Swarm-Setup-Free.exe` to each PC and launch it. On the Operator PC, choose **Operator**. On other PCs, choose **Agent**. The role is remembered for that Windows account. Use **Reset role selection** inside the Agent window if you intentionally need to change it; a confirmation is shown and the app closes before the next launch offers the role picker.

The Agent attempts LAN discovery first. If it cannot find the Operator, it will prompt for the Operator PC's IPv4 address. For same-LAN connectivity, allow the app through Windows Defender Firewall on a trusted Private network. Operator uses TCP 3001 for Agent WebSockets, TCP 3000 for the embedded dashboard/API, and UDP 41234 for discovery. If discovery is blocked by Wi-Fi client isolation/VLAN/VPN rules, use the saved-IP fallback.

## Agent autostart and closing
Autostart is opt-in. When enabled, the app launches on Windows sign-in. Closing the Agent window hides it to the notification area; the tray menu provides **Open Agent window** and **Exit Agent**. The app is not designed to hide itself from the PC owner or prevent the owner from exiting/uninstalling it. Disable autostart in the Agent window or Windows Startup settings.

## Notes
- Build the executable on Windows x64 with internet access; this workspace does not include a compiled Windows binary.
- Use only on PCs you own or are explicitly authorized to administer. Remote process control, restart, and shutdown commands can disrupt work; use them only with the PC owner's permission.
