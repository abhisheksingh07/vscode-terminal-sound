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

One of the following audio backends must be installed on your system:

| Backend | Debian/Ubuntu | Fedora/RHEL | Arch Linux |
|---|---|---|---|
| `ffplay` (recommended) | `sudo apt install ffmpeg` | `sudo dnf install ffmpeg` | `sudo pacman -S ffmpeg` |
| `aplay` | `sudo apt install alsa-utils` | `sudo dnf install alsa-utils` | `sudo pacman -S alsa-utils` |
| `paplay` | `sudo apt install pulseaudio-utils` | `sudo dnf install pulseaudio-utils` | `sudo pacman -S pulseaudio` |

The extension tries each backend in order (`ffplay` → `aplay` → `paplay`) and stops at the first one that works.

> **If none are installed**, sounds will silently fail to play. No crash or error notification is shown in VS Code — the failure is logged to the **PlaySoundExtension** output channel (`View → Output → PlaySoundExtension`). Install at least one backend to restore audio.

> **Linux only.** The extension uses `PROMPT_COMMAND` bash hooks and `xdg-open`, which are Linux/macOS shell features.

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
        │  sources a generated bash script into every terminal
        ▼
  /tmp/vscode_playsound_setup.sh
        │
        │  registers _playsound_hook() into PROMPT_COMMAND
        ▼
  Shell runs _playsound_hook() after each command
        │
        ├── exit code ≠ 0  →  play error sound (ffplay)
        └── exit code = 0  →  play success sound (ffplay)
```

The extension never intercepts terminal I/O directly — it hooks into bash's `PROMPT_COMMAND`, which runs a function after every command completes. This keeps the integration lightweight and shell-native.

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
│       ├── playSound()        # Executes the sound file via a fallback chain:
│       │                      #   ffplay → aplay → paplay
│       │                      # Respects cooldown and volume settings
│       │
│       ├── writeSetupScript() # Generates the bash PROMPT_COMMAND hook script
│       │                      # at /tmp/vscode_playsound_setup.sh with the
│       │                      # currently selected sound paths baked in
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
    └─▶ writeSetupScript()  →  writes /tmp/vscode_playsound_setup.sh
    └─▶ inject into existing terminals
    └─▶ subscribe to onDidOpenTerminal  →  inject into future terminals

User picks new sound
    └─▶ setSelectedSound()
    └─▶ writeSetupScript()   (regenerates with new path baked in)
    └─▶ re-inject into all open terminals

Extension deactivates
    └─▶ deletes /tmp/vscode_playsound_setup.sh
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
