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

### 1. Add Your Sound Files

Place your `.mp3`, `.wav`, or `.ogg` files into:

```
media/
├── error/      ← sounds played on command failure
└── success/    ← sounds played on command success
```

You can also open these folders from the Command Palette:
- `PlaySound: Open Error Sounds Folder`
- `PlaySound: Open Success Sounds Folder`

### 2. Select a Sound

Open the Command Palette (`Ctrl+Shift+P`) and run:

- `PlaySound: Select Error Sound` — pick which file plays on failure
- `PlaySound: Select Success Sound` — pick which file plays on success

A QuickPick menu will list every sound file found in the respective folder. Choose `None (disabled)` to silence a particular event.

### 3. Test It

- `PlaySound: Test Error Sound`
- `PlaySound: Test Success Sound`

These bypass the cooldown and play the sound immediately.

---

## Commands

| Command | Description |
|---|---|
| `PlaySound: Select Error Sound` | Choose the error sound from `media/error/` |
| `PlaySound: Select Success Sound` | Choose the success sound from `media/success/` |
| `PlaySound: Open Error Sounds Folder` | Open `media/error/` in the file manager |
| `PlaySound: Open Success Sounds Folder` | Open `media/success/` in the file manager |
| `PlaySound: Test Error Sound` | Preview the current error sound |
| `PlaySound: Test Success Sound` | Preview the current success sound |

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

MIT © Abhishek Singh
