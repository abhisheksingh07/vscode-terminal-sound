# Play Sound on Terminal Error/Success

A Visual Studio Code extension that plays an audio alert whenever a terminal command **fails** (non-zero exit) or **succeeds** (exit code 0). Drop in your own `.mp3` / `.wav` sounds, pick one per event, and stay aware of long-running tasks without watching the terminal.

---

## Why This Exists

Running lengthy build, deploy, or test commands? This extension lets you walk away and get an instant audio notification the moment something finishes — whether it passed or crashed.

---

## Features

- Plays a **custom sound** on terminal command failure (non-zero exit code)
- Plays a **custom sound** on terminal command success (exit code 0)
- Works with **any shell command** — `git`, `npm`, `docker`, `make`, custom scripts, etc.
- **Bring your own sounds** — drop `.mp3`, `.wav`, or `.ogg` files into the `media/` folders
- Configurable **volume** (1–100%) and **cooldown** between sounds
- Quick **test commands** to preview each sound without running a command
- Open the sound folder directly from the Command Palette
- All playback backed by `ffplay` → `aplay` → `paplay` fallback chain

---

## Requirements

### macOS
No installation needed. `afplay` is **built-in** on every macOS system — sounds work immediately.

### Windows
No installation needed. The extension uses **PowerShell's built-in `MediaPlayer`** (WPF) which supports MP3, WAV, and OGG out of the box.

### Linux
At least one of the following audio backends must be installed:

| Backend | Plays MP3/OGG? | Plays WAV? | Debian/Ubuntu | Fedora/RHEL | Arch Linux |
|---|---|---|---|---|---|
| `mpg123` ✅ recommended | ✅ Yes | ✅ Yes | `sudo apt install mpg123` | `sudo dnf install mpg123` | `sudo pacman -S mpg123` |
| `ffplay` | ✅ Yes | ✅ Yes | `sudo apt install ffmpeg` | `sudo dnf install ffmpeg` | `sudo pacman -S ffmpeg` |
| `mpv` | ✅ Yes | ✅ Yes | `sudo apt install mpv` | `sudo dnf install mpv` | `sudo pacman -S mpv` |
| `aplay` (pre-installed) | ❌ No — distorts MP3 | ✅ Yes | pre-installed | pre-installed | `sudo pacman -S alsa-utils` |
| `paplay` (pre-installed) | ❌ No — distorts MP3 | ✅ Yes | pre-installed | pre-installed | `sudo pacman -S pulseaudio` |

> **`aplay` and `paplay` are PCM-only players.** They play raw audio bytes, so they work perfectly with `.wav` files but will produce distorted garbage noise when given an `.mp3` or `.ogg` file.

The extension tries players in this order: `mpg123` → `ffplay` → `mpv` → `cvlc` → `mplayer`.  
For `.wav` files, `aplay` / `paplay` are used first (they are more efficient for WAV).

> **If no MP3-capable player is installed**, the extension will **automatically switch your selected MP3 sounds to their `.wav` counterparts** (if a `.wav` file with the same base name exists in the `media/` folder). A notification will appear confirming the switch.

> After installing an MP3 player like `mpg123`, use **PlaySound: Select Error Sound** / **PlaySound: Select Success Sound** to switch back to the MP3 files.

> **If none are installed at all**, a one-time notification will appear at startup with quick-install options (auto-detects `apt`/`dnf`/`pacman`) and the option to switch to WAV files without installing anything.

---

## MP3 vs WAV — Which Should You Use?

| | `.mp3` / `.ogg` | `.wav` |
|---|---|---|
| **File size** | Small (50–100 KB) | Large (500 KB–3 MB) |
| **Quality** | Compressed | Uncompressed / lossless |
| **Requires MP3 player?** | ✅ Yes (`mpg123`, `ffplay`, `mpv`…) | ❌ No — works with built-in `aplay`/`paplay` |
| **macOS / Windows** | ✅ Works out of the box | ✅ Works out of the box |
| **Linux (no extras)** | ⚠️ Needs install | ✅ Works immediately |

**Recommendation for Linux users:**
- If you have `mpg123`/`ffplay` installed → use `.mp3` (smaller, sounds better)
- If you don't want to install anything → use `.wav` (just works)
- **Best practice:** keep both `.mp3` and `.wav` versions with the same base name in `media/` — the extension auto-switches to WAV when needed

---

## Getting Started

### Step 1 — Add Your Sound Files

You need to put your audio files into the extension's `media/` folder. There are two ways:

**Option A — Open the folder from inside VS Code (easiest):**

1. Press `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (macOS) to open the Command Palette
2. Type `PlaySound: Open Error Sounds Folder` → press `Enter`
3. Your file manager opens — **drag and drop** your `.mp3` or `.wav` files in
4. Repeat with `PlaySound: Open Success Sounds Folder` for success sounds

**Option B — Navigate manually:**

```
~/.vscode/extensions/vynode.playsoundextension-<version>/media/
├── error/      ← drop sounds here for command failure
└── success/    ← drop sounds here for command success
```

> Supported formats: `.mp3`, `.wav`, `.ogg`

---

### Step 2 — Select Which Sound to Play

After adding files, tell the extension which one to use:

1. Press `Ctrl+Shift+P` → type `PlaySound: Select Error Sound` → press `Enter`

   ![QuickPick menu appears listing all files in media/error/]

2. Use the **arrow keys** to browse, press `Enter` to select  
   — A preview of the selected sound plays automatically  
   — Choose `None (disabled)` to turn off that event

3. Repeat: `Ctrl+Shift+P` → `PlaySound: Select Success Sound`

---

### Step 3 — Test Your Sounds

Verify the sounds work before running real commands:

- `Ctrl+Shift+P` → `PlaySound: Test Error Sound` — plays the error sound immediately
- `Ctrl+Shift+P` → `PlaySound: Test Success Sound` — plays the success sound immediately

These bypass the cooldown timer so you hear the sound right away.

---

### Step 4 — Trigger in the Terminal

Open a terminal (`Ctrl+`` ` ```) and run any command:

```bash
invalidcommand     # exit code 127 → plays error sound 🔴
ls                 # exit code 0   → plays success sound 🟢
git push           # exit 0 or 1   → plays the matching sound
npm run build      # depends on build result
```

The hook is injected automatically into every new terminal. If a terminal was open before the extension activated, run:
```bash
source /tmp/vscode_playsound_setup.sh
```

---

## Commands

All commands are accessible via the **Command Palette**:
- **Windows / Linux:** `Ctrl+Shift+P`
- **macOS:** `Cmd+Shift+P`

Then start typing the command name:

| Command | What It Does |
|---|---|
| `PlaySound: Select Error Sound` | Opens a picker listing all files in `media/error/` — choose one, it previews and saves |
| `PlaySound: Select Success Sound` | Opens a picker listing all files in `media/success/` — choose one, it previews and saves |
| `PlaySound: Open Error Sounds Folder` | Opens `media/error/` in your file manager so you can drop in new `.mp3`/`.wav` files |
| `PlaySound: Open Success Sounds Folder` | Opens `media/success/` in your file manager so you can drop in new sound files |
| `PlaySound: Test Error Sound` | Plays the currently selected error sound immediately (bypasses cooldown) |
| `PlaySound: Test Success Sound` | Plays the currently selected success sound immediately (bypasses cooldown) |

> **Tip:** After dropping new files into the `media/` folder, run **Select Error/Success Sound** again — the new files will appear in the picker automatically.

---

## Configuration

Settings are available under `File → Preferences → Settings` (search `playsoundextension`):

| Setting | Default | Description |
|---|---|---|
| `playsoundextension.volume` | `100` | Playback volume (1–100) |
| `playsoundextension.cooldownSeconds` | `2` | Minimum seconds between consecutive sounds |

---

## How It Works

```
VS Code Terminal Opens
        │
        ▼
  injectIntoTerminal()
        │
        │  sources a generated hook script into every terminal
        ▼
  Linux/macOS: /tmp/vscode_playsound_setup.sh   (bash PROMPT_COMMAND)
  Windows:     %TEMP%\vscode_playsound_setup.ps1 (PowerShell prompt override)
        │
        │  hook runs after every command
        ▼
  Shell executes hook after each command
        │
        ├── exit code ≠ 0  →  play error sound
        └── exit code = 0  →  play success sound

Audio Backends:
  macOS   →  afplay (built-in, no install needed)
  Windows →  PowerShell MediaPlayer (built-in, no install needed)
  Linux   →  ffplay → mpg123 → aplay → paplay → mpv → cvlc → mplayer
```

The extension never intercepts terminal I/O directly — it hooks into the shell's built-in prompt mechanism (`PROMPT_COMMAND` on bash, `prompt` function override on PowerShell). This keeps the integration lightweight and shell-native.

---

## Code Architecture

```
PlaySoundExtension/
│
├── src/
│   └── extension.ts          # Entire extension logic (single-file)
│       │
│       ├── activate()         # Entry point: initializes state, writes script,
│       │                      # injects hook into all terminals, registers commands
│       │
│       ├── deactivate()       # Cleanup: removes the temp bash script on exit
│       │
│       ├── scanSoundFolder()  # Reads media/error/ or media/success/ and returns
│       │                      # a sorted list of .mp3/.wav/.ogg filenames
│       │
│       ├── getSelectedSound() # Reads persisted sound choice from VS Code globalState
│       ├── setSelectedSound() # Writes sound choice to VS Code globalState
│       │
│       ├── resolveSelectedSoundPath()
│       │                      # Combines extensionPath + media folder + filename
│       │                      # and verifies the file exists on disk
│       │
│       ├── showSoundPicker()  # Renders a QuickPick UI listing all files in the
│       │                      # media folder; updates state and re-injects script
│       │
│       ├── openSoundFolder()  # Opens media/error/ or media/success/ in the
│       │                      # system file manager via xdg-open/nautilus/thunar
│       │
       └── buildPlayCommand()     # Returns the OS-specific play command:
                              #   macOS:   afplay (built-in)
                              #   Windows: PowerShell MediaPlayer (built-in)
                              #   Linux:   ffplay → mpg123 → aplay → paplay → mpv chain

       checkAudioBackend()    # Checks which audio player is available on PATH
       showInstallSuggestion() # Linux only: one-time popup if no player found;
                              #   auto-detects apt/dnf/pacman, offers Copy or Open Terminal
│       │
       ├── writeUnixSetupScript()  # Linux/macOS bash PROMPT_COMMAND hook
       └── writeWindowsSetupScript() # Windows PowerShell prompt override
│       │
│       └── injectIntoTerminal()
│                              # Sources the setup script into a terminal with
│                              # a 500ms delay to let bash initialize first
│
├── media/
│   ├── error/                 # Drop error sounds (.mp3/.wav/.ogg) here
│   │   └── README.txt
│   └── success/               # Drop success sounds (.mp3/.wav/.ogg) here
│       └── README.txt
│
├── out/                       # Compiled JavaScript output (generated, git-ignored)
│
├── package.json               # Extension manifest: commands, config, activation events
├── tsconfig.json              # TypeScript compiler config (target: ES6, outDir: out/)
├── .vscodeignore              # Files excluded from the .vsix package
└── .gitignore                 # node_modules, out/, *.vsix excluded from git
```

### State Management

Selected sounds are persisted using VS Code's `ExtensionContext.globalState` (`Memento`), keyed as:

```
playsound.selected.error   →  "error-1.mp3"
playsound.selected.success →  "success-1.mp3"
```

This survives VS Code restarts without needing any config file.

### Terminal Hook Lifecycle

```
Extension activates
    └─▶ detect platform (linux / darwin / win32)
    └─▶ writeSetupScript()
         ├─▶ Unix:    writes /tmp/vscode_playsound_setup.sh  (bash)
         └─▶ Windows: writes %TEMP%\vscode_playsound_setup.ps1 (PowerShell)
    └─▶ showInstallSuggestion()  (Linux only: checks for audio players)
    └─▶ inject into existing terminals
    └─▶ subscribe to onDidOpenTerminal  →  inject into future terminals

User picks new sound
    └─▶ setSelectedSound()
    └─▶ writeSetupScript()   (regenerates with new path baked in)
    └─▶ re-inject into all open terminals

Extension deactivates
    └─▶ deletes the temp script file
```

---

## Publishing

```bash
# Install packaging tool
npm install -g @vscode/vsce

# Log in with your Marketplace publisher ID
vsce login <publisher-id>

# Compile TypeScript
npm run compile

# Package
vsce package

# Publish
vsce publish
```

---

## License

This project is licensed under the **MIT License with Attribution Requirement**.

Copyright (c) 2026 **Abhishek Singh** — https://github.com/abhisheksingh07

### Attribution Requirement

If you use, fork, redistribute, or build upon this software in any **public** context — including open-source projects, VS Code extensions, blog posts, videos, or commercial products — you **must** give clear and visible credit to the original author:

```
Original author: Abhishek Singh
Source: https://github.com/abhisheksingh07/vscode-terminal-sound
```

Credit must appear in at least one of:
- The `README` or documentation of your project
- The About / Credits section of your application
- The VS Code Marketplace description (if publishing an extension)
- The description of the blog post, video, or article referencing this work

### Full License Text

```
MIT License with Attribution Requirement

Copyright (c) 2026 Abhishek Singh
https://github.com/abhisheksingh07

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

1. The above copyright notice and this permission notice shall be included in
   all copies or substantial portions of the Software.

2. ATTRIBUTION REQUIREMENT: Any public use, distribution, publication,
   presentation, or derivative work based on this Software must give clear
   and visible credit to the original author:

       Original author: Abhishek Singh
       Source: https://github.com/abhisheksingh07/vscode-terminal-sound

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

See the full [LICENSE](LICENSE) file for details.
