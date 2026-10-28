# Skal

A small SSH client with tabs, an editable server list, file transfer and server status – inspired by Termius. Built with Electron, xterm.js and ssh2, so it doesn't depend on PuTTY.

<img width="952" height="596" alt="{38E9E5EB-4A35-4912-B286-BDA0C8511E2D}" src="https://github.com/user-attachments/assets/4c48bdab-0b0c-47db-805b-fffb0c92d886" /><img width="952" height="596" alt="{12DACB85-8B44-4010-89D8-B888C5C0824E}" src="https://github.com/user-attachments/assets/19458528-97f9-466c-b195-cb9a126e3c3e" />


## Getting started

Requires Node.js 18 or newer.

```
npm install
npm start
```

Build an installable app:

```
npm run dist:win        # Windows installer (recommended – starts quickly)
npm run dist:zip        # Windows: zip that can be extracted and run directly
npm run dist:portable   # Windows: a single portable .exe (starts slowly)
npm run dist            # current platform
```

## Features

- Server list with groups, search and colors. Create, edit, duplicate and delete servers from the panel on the right or by right-clicking. Double-click to connect.
- Multiple sessions in tabs, including several to the same server (Ctrl+Shift+D). Typing `exit` closes the tab; if the connection drops, press Enter to reconnect.
- Log in with a password, private key or SSH agent / Pageant. Keys can be OpenSSH, PEM, PKCS#8 or PuTTY .ppk (v2 and v3). If a passphrase is missing, you'll be prompted.
- Passwords are encrypted with the operating system's keyring (DPAPI on Windows).
- Host key checking with "trust on first use" and a clear warning if a server's key changes.
- Quick connect: type `user@host` or `user@host:2222` in the search field and press Enter.
- PuTTY habits: select text to copy, right-click to paste.

### Files (dual-pane, like Total Commander / mc)

Switch between **Terminal** and **Files** in the top right of a session, or press Ctrl+Shift+F. The left side is this computer, the right side is the server. The file manager uses the session's connection, so there's no need to log in again.

| Key | Action |
|---|---|
| Tab | Switch side |
| Up/Down, PgUp/PgDn, Home/End | Move the cursor |
| Enter / double-click | Open folder or file |
| Backspace | Go up one folder |
| Space / Insert | Select and move on (Shift+arrow also selects) |
| Ctrl+A / Escape | Select all / clear selection |
| Type letters | Jump to a file starting with them |
| F2 (or Shift+F6) | Rename |
| F4 | Open. A server file opens in your default program and is uploaded automatically every time you save |
| F5 | Copy selected to the other side |
| F6 | Move selected to the other side |
| F7 | New folder |
| F8 / Delete | Delete (locally: to the Recycle Bin) |
| Ctrl+R / Ctrl+H | Refresh / show hidden files |

Drag selected files from one side to the other to copy (hold Shift to move), drop them on a folder to put them inside it, or drag files in from Explorer to the server side. If an item already exists, you can choose Overwrite, Skip or Cancel. Transfers show progress and speed and can be cancelled. Click the column headers to sort. Both sides remember the last folder (the server side per server).

### Online dot

Each card on the Hosts page has a dot next to its name: green when the server's SSH port responds, red when it's down or not responding, and gray while checking. Hover over the dot for response time or error. No login takes place – Skal just reads the server's SSH greeting – so it also works for servers without a saved password. The check runs at most every 3 minutes and only while the page is open; if you have a session open, or server status already shows the server is running, no extra check is made. On the server it shows up as a short "Connection closed … [preauth]" line in the log.

### Server status

The Hosts page shows CPU, RAM, disk, load, uptime and operating system for Linux servers, refreshed every 10 seconds while the page is open. Hover over a gauge for details (all disks, swap, load averages).

If you have a session open to the server, it's used. Otherwise Skal keeps a quiet background connection open as long as the page is shown; it closes after 3 minutes of inactivity. Background connections never prompt for anything, so the server must have a saved login (password, key or agent), and its host key must have been accepted during an earlier connection. Can be turned off with **Server status** at the top of the page.

## Languages

Skal is available in Danish, English, German, French, Italian, Spanish and Swedish. On first launch it uses the Windows language (English if it isn't one of the seven). Change it at the bottom of the sidebar – it takes effect immediately, including in open sessions, dialogs and error messages.

All strings live in `renderer/strings.js` with the seven languages side by side. To add a new language, give every string a translation and add the language to `LANGS` and `LOCALES` at the top of the file.

## Shortcuts

| Shortcut | Action |
|---|---|
| Ctrl+Shift+H | Show hosts / search field |
| Ctrl+Shift+N | New host |
| Ctrl+Tab / Ctrl+Shift+Tab | Next / previous tab |
| Ctrl+Shift+W | Close tab |
| Ctrl+Shift+D | Duplicate session |
| Ctrl+Shift+F | Switch between terminal and files |
| Ctrl+Shift+C / V | Copy / paste |
| Middle-click on tab | Close tab |

## Where data is stored

`hosts.json` and `known_hosts.json` are stored in `%APPDATA%\Skal` (Windows), `~/Library/Application Support/skal` (macOS) or `~/.config/skal` (Linux). The installed version lives in `%LOCALAPPDATA%\Programs\skal`.

## Structure

- `main.js`: storage, encryption, SSH connections and host key checking
- `sftp.js`: file transfer and editing of server files
- `local.js`: the local side of the file manager
- `metrics.js`: server status
- `ping.js`: the online dot
- `keyconvert.js`: reading PuTTY and other key formats
- `preload.js`: the secure bridge to the user interface
- `renderer/`: the user interface (`renderer.js`, `commander.js`, `strings.js` with all strings, HTML and CSS)

## License

Skal is free software, licensed under the [GNU General Public License v3.0](LICENSE) or (at your option) any later version.
