import * as vscode from "vscode";
import * as path from "path";
import { exec } from "child_process";
import * as fs from "fs";
import * as os from "os";
import { promisify } from "util";

const execAsync = promisify(exec);

let extensionPath = "";
let setupScriptPath = "";
let outputChannel: vscode.OutputChannel;
let globalState: vscode.Memento;
let lastPlayedTime = 0; // cooldown tracking

const SOUND_EXTENSIONS = [".mp3", ".wav", ".ogg"];
const platform = os.platform(); // 'linux' | 'darwin' | 'win32'

// ── Scan a folder and return all playable sound files ────────────────────────
function scanSoundFolder(folder: string): string[] {
  if (!fs.existsSync(folder)) {
    return [];
  }
  return fs
    .readdirSync(folder)
    .filter((f) => SOUND_EXTENSIONS.includes(path.extname(f).toLowerCase()))
    .sort();
}

// ── Get currently selected sound filename from global state ──────────────────
function getSelectedSound(type: "error" | "success"): string {
  const key = `playsound.selected.${type}`;
  return globalState.get<string>(key, "");
}

// ── Save selected sound to global state ──────────────────────────────────────
async function setSelectedSound(type: "error" | "success", filename: string) {
  const key = `playsound.selected.${type}`;
  await globalState.update(key, filename);
}

// ── Resolve absolute path of selected sound ───────────────────────────────────
function resolveSelectedSoundPath(type: "error" | "success"): string {
  const folder = path.join(extensionPath, "media", type);
  const selected = getSelectedSound(type);
  if (!selected) {
    return "";
  }
  const fullPath = path.join(folder, selected);
  return fs.existsSync(fullPath) ? fullPath : "";
}

// ── Check if a binary exists on PATH ─────────────────────────────────────────
async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execAsync(platform === "win32" ? `where ${cmd}` : `which ${cmd}`);
    return true;
  } catch {
    return false;
  }
}

// ── Check audio backend capability ───────────────────────────────────────────
// Returns: 'mp3-capable' | 'pcm-only' | null
//   mp3-capable — at least one player that decodes MP3/OGG (ffplay, mpg123, mpv…)
//   pcm-only    — only aplay/paplay are present; fine for .wav, DISTORTS .mp3/.ogg
//   null        — nothing at all
async function checkAudioBackend(): Promise<"mp3-capable" | "pcm-only" | null> {
  if (platform === "darwin") { return "mp3-capable"; } // afplay built-in
  if (platform === "win32")  { return "mp3-capable"; } // PowerShell MediaPlayer built-in

  // MP3-decoding players (proper codec support)
  for (const player of ["mpg123", "ffplay", "mpv", "cvlc", "mplayer"]) {
    if (await commandExists(player)) {
      return "mp3-capable";
    }
  }
  // PCM-only players (can play WAV, will DISTORT MP3/OGG)
  for (const player of ["aplay", "paplay"]) {
    if (await commandExists(player)) {
      return "pcm-only";
    }
  }
  return null;
}

// ── Swap MP3/OGG selection to its .wav counterpart if one exists ─────────────
// Returns true if a swap was made
async function autoSwapToWav(type: "error" | "success"): Promise<boolean> {
  const selected = getSelectedSound(type);
  if (!selected) { return false; }

  const ext = path.extname(selected).toLowerCase();
  if (ext === ".wav") { return false; } // already WAV

  const folder  = path.join(extensionPath, "media", type);
  const base    = path.basename(selected, ext);
  const wavName = base + ".wav";
  const wavPath = path.join(folder, wavName);

  if (!fs.existsSync(wavPath)) { return false; } // no WAV counterpart

  await setSelectedSound(type, wavName);
  outputChannel.appendLine(
    `[AutoSwap] No MP3 player found — switched ${type} sound: "${selected}" → "${wavName}"`,
  );
  return true;
}

// ── One-time install suggestion (Linux only) ─────────────────────────────────
async function showInstallSuggestion(context: vscode.ExtensionContext): Promise<void> {
  if (platform !== "linux") { return; }

  const alreadyShown = context.globalState.get<boolean>("audioBackendWarningShown", false);
  if (alreadyShown) { return; }

  const backend = await checkAudioBackend();

  const errorFile   = resolveSelectedSoundPath("error");
  const successFile = resolveSelectedSoundPath("success");
  const hasNonWav   = [errorFile, successFile].some(
    (f) => f && path.extname(f).toLowerCase() !== ".wav",
  );

  const needsDecoder = backend === null || (backend === "pcm-only" && hasNonWav);
  if (!needsDecoder) { return; }

  // Check if WAV counterparts exist — offer no-install option
  const hasWavFallback = (["error", "success"] as const).some((t) => {
    const sel = getSelectedSound(t);
    if (!sel) { return false; }
    const ext = path.extname(sel).toLowerCase();
    if (ext === ".wav") { return false; }
    const wavPath = path.join(extensionPath, "media", t, path.basename(sel, ext) + ".wav");
    return fs.existsSync(wavPath);
  });

  const warningMsg = backend === "pcm-only"
    ? "⚠️ PlaySound: MP3 files need an MP3-capable player (only aplay/paplay found). Install one, or switch to WAV for an instant fix:"
    : "🔇 PlaySound: No audio player found. Install one, or use WAV files (work with aplay/paplay):";

  const buttons: string[] = [];
  if (hasWavFallback) { buttons.push("Switch to WAV (no install)"); }
  buttons.push("Install mpg123 (Recommended)", "Install ffmpeg", "Install mpv", "Remind Me Later");

  const selection = await vscode.window.showWarningMessage(warningMsg, ...buttons);

  if (!selection || selection === "Remind Me Later") { return; }

  if (selection === "Switch to WAV (no install)") {
    let switched = false;
    for (const type of ["error", "success"] as const) {
      if (await autoSwapToWav(type)) { switched = true; }
    }
    if (switched) {
      writeSetupScript();
      vscode.window.terminals.forEach(injectIntoTerminal);
      vscode.window.showInformationMessage(
        "✅ Switched to WAV — sound will work immediately. To use MP3 later, install mpg123: sudo apt install mpg123",
      );
    }
    await context.globalState.update("audioBackendWarningShown", true);
    return;
  }

  if (!selection || selection === "Remind Me Later") {
    return;
  }

  const cmdsMap: Record<string, { apt: string; dnf: string; pacman: string }> = {
    "Install mpg123 (Recommended)": {
      apt: "sudo apt install mpg123",
      dnf: "sudo dnf install mpg123",
      pacman: "sudo pacman -S mpg123",
    },
    "Install ffmpeg": {
      apt: "sudo apt install ffmpeg",
      dnf: "sudo dnf install ffmpeg",
      pacman: "sudo pacman -S ffmpeg",
    },
    "Install mpv": {
      apt: "sudo apt install mpv",
      dnf: "sudo dnf install mpv",
      pacman: "sudo pacman -S mpv",
    },
  };

  const cmds = cmdsMap[selection];

  // Auto-detect the distro package manager
  let installCmd = cmds.apt; // default to apt
  if (await commandExists("dnf")) {
    installCmd = cmds.dnf;
  } else if (await commandExists("pacman")) {
    installCmd = cmds.pacman;
  }

  const action = await vscode.window.showInformationMessage(
    `Run this command to install: ${installCmd}`,
    "Copy Command",
    "Open Terminal & Run",
  );

  if (action === "Copy Command") {
    await vscode.env.clipboard.writeText(installCmd);
    vscode.window.showInformationMessage("✅ Copied to clipboard!");
  } else if (action === "Open Terminal & Run") {
    const terminal = vscode.window.createTerminal("PlaySound Setup");
    terminal.show();
    terminal.sendText(installCmd);
  }

  await context.globalState.update("audioBackendWarningShown", true);
}

// ── Build the platform-specific play command string ───────────────────────────
function buildPlayCommand(soundFile: string, volume: number): string {
  if (platform === "darwin") {
    // afplay is built-in on macOS; volume is 0.0–1.0 (not percent)
    const volFloat = (volume / 100).toFixed(2);
    return `afplay -v ${volFloat} "${soundFile}"`;
  }

  if (platform === "win32") {
    // PowerShell WPF MediaPlayer — supports MP3, WAV, OGG
    const fileUri = soundFile.replace(/\\/g, "/");
    return (
      `powershell -NoProfile -WindowStyle Hidden -Command ` +
      `"Add-Type -AssemblyName PresentationCore; ` +
      `$m=[System.Windows.Media.MediaPlayer]::new(); ` +
      `$m.Open([uri]::new('file:///${fileUri}')); ` +
      `$m.Volume=${(volume / 100).toFixed(2)}; ` +
      `$m.Play(); ` +
      `Start-Sleep -Milliseconds 5000"`
    );
  }

  // Linux — MP3-capable players first; aplay/paplay only added for WAV files
  const ext = path.extname(soundFile).toLowerCase();
  const isWav = ext === ".wav";

  // Decoding chain: handles MP3, WAV, OGG without distortion
  const decodingChain =
    `mpg123 -q "${soundFile}" 2>/dev/null` +           // best for MP3, lightweight
    ` || ffplay -nodisp -autoexit -loglevel quiet -volume ${volume} "${soundFile}" 2>/dev/null` +
    ` || mpv --no-video --really-quiet "${soundFile}" 2>/dev/null` +
    ` || cvlc --play-and-exit --quiet "${soundFile}" 2>/dev/null` +
    ` || mplayer -really-quiet "${soundFile}" 2>/dev/null`;

  if (isWav) {
    // WAV: aplay/paplay are perfect — use them first, decoding chain as fallback
    return (
      `aplay "${soundFile}" 2>/dev/null` +
      ` || paplay "${soundFile}" 2>/dev/null` +
      ` || ${decodingChain}`
    );
  }

  // MP3/OGG: skip aplay/paplay entirely — they CANNOT decode compressed audio
  return decodingChain;
}

// ── Show QuickPick to let user choose a sound from the folder ─────────────────
async function showSoundPicker(type: "error" | "success") {
  const folder = path.join(extensionPath, "media", type);
  const files = scanSoundFolder(folder);

  if (files.length === 0) {
    vscode.window.showWarningMessage(
      `No sound files found in media/${type}/. Drop .mp3 or .wav files there and try again.`,
    );
    return;
  }

  const currentSelection = getSelectedSound(type);
  const noneOption = "$(mute) None (disabled)";

  const items: vscode.QuickPickItem[] = [
    {
      label: noneOption,
      description: type === "success" ? "No sound on success" : "",
      picked: !currentSelection,
    },
    ...files.map((f) => ({
      label: `$(unmute) ${f}`,
      description: f === currentSelection ? "✓ currently selected" : "",
      picked: f === currentSelection,
    })),
  ];

  const picked = await vscode.window.showQuickPick(items, {
    title: `Select ${type === "error" ? "🔴 Error" : "🟢 Success"} Sound`,
    placeHolder: `Choose from media/${type}/ — drop your own .mp3/.wav files there`,
    matchOnDescription: true,
  });

  if (!picked) {
    return;
  } // user cancelled

  const filename =
    picked.label === noneOption ? "" : picked.label.replace("$(unmute) ", "");
  await setSelectedSound(type, filename);

  // Re-write setup script with new sound and re-inject into all terminals
  writeSetupScript();
  vscode.window.terminals.forEach(injectIntoTerminal);

  const msg = filename
    ? `PlaySound: ${type} sound set to "${filename}"`
    : `PlaySound: ${type} sound disabled`;
  vscode.window.showInformationMessage(msg);
  outputChannel.appendLine(msg);

  // Preview the selected sound
  if (filename) {
    setTimeout(
      () => playSound(path.join(folder, filename), `${type} preview`, true),
      200,
    );
  }
}

// ── Open the media folder so user can drop sounds (cross-platform) ──────────────
function openSoundFolder(type: "error" | "success") {
  const folder = path.join(extensionPath, "media", type);
  let cmd: string;

  if (platform === "win32") {
    cmd = `explorer "${folder}"`;
  } else if (platform === "darwin") {
    cmd = `open "${folder}"`;
  } else {
    cmd = `xdg-open "${folder}" 2>/dev/null || nautilus "${folder}" 2>/dev/null || thunar "${folder}" 2>/dev/null`;
  }

  exec(cmd);
  vscode.window.showInformationMessage(
    `Opened media/${type}/ — drop your .mp3 or .wav files there, then run the select command again.`,
  );
}

// ── Play a sound file (with cooldown + volume, cross-platform) ───────────────
function playSound(soundFile: string, label: string, bypassCooldown = false) {
  if (!soundFile || !fs.existsSync(soundFile)) {
    outputChannel.appendLine(`[PlaySound] No sound file at: ${soundFile}`);
    return;
  }

  const config = vscode.workspace.getConfiguration("playsoundextension");
  const cooldown = config.get<number>("cooldownSeconds", 2) * 1000;
  const volume = Math.max(1, Math.min(100, config.get<number>("volume", 100)));
  const now = Date.now();

  if (!bypassCooldown && now - lastPlayedTime < cooldown) {
    return; // silently skip — cooldown is expected behaviour, not an error
  }
  lastPlayedTime = now;

  const cmd = buildPlayCommand(soundFile, volume);
  exec(cmd, (err) => {
    if (err) {
      // Only log failures — normal playback is silent
      outputChannel.appendLine(`[PlaySound] Playback failed (${label}): ${err.message}`);
    }
  });
}

// ── Write the terminal hook script (bash for Linux/macOS, PowerShell for Windows) ─
function writeSetupScript() {
  const errorFile = resolveSelectedSoundPath("error");
  const successFile = resolveSelectedSoundPath("success");
  const config = vscode.workspace.getConfiguration("playsoundextension");
  const volume = Math.max(1, Math.min(100, config.get<number>("volume", 100)));

  if (platform === "win32") {
    writeWindowsSetupScript(errorFile, successFile, volume);
  } else {
    writeUnixSetupScript(errorFile, successFile, volume);
  }
}

// ── Unix (Linux + macOS): bash PROMPT_COMMAND hook ───────────────────────────
function writeUnixSetupScript(errorFile: string, successFile: string, volume: number) {
  let playErrorCmd: string;
  let playSuccessCmd: string;

  if (platform === "darwin") {
    // macOS: afplay is built-in, no external player needed
    const volFloat = (volume / 100).toFixed(2);
    playErrorCmd = errorFile
      ? `afplay -v ${volFloat} "${errorFile}" &`
      : ": # error sound disabled";
    playSuccessCmd = successFile
      ? `afplay -v ${volFloat} "${successFile}" &`
      : ": # success sound disabled";
  } else {
    // Linux: MP3-capable chain first; aplay/paplay only for WAV files
    const buildLinuxCmd = (file: string): string => {
      const ext = path.extname(file).toLowerCase();
      const isWav = ext === ".wav";

      const decodingChain =
        `mpg123 -q "${file}" >/dev/null 2>&1` +
        ` || ffplay -nodisp -autoexit -loglevel quiet -volume ${volume} "${file}" >/dev/null 2>&1` +
        ` || mpv --no-video --really-quiet "${file}" >/dev/null 2>&1` +
        ` || cvlc --play-and-exit --quiet "${file}" >/dev/null 2>&1` +
        ` || mplayer -really-quiet "${file}" >/dev/null 2>&1`;

      return isWav
        ? `aplay "${file}" >/dev/null 2>&1 || paplay "${file}" >/dev/null 2>&1 || ${decodingChain} &`
        : `${decodingChain} &`; // skip aplay/paplay for MP3/OGG — they distort
    };

    playErrorCmd   = errorFile   ? buildLinuxCmd(errorFile)   : ": # error sound disabled";
    playSuccessCmd = successFile ? buildLinuxCmd(successFile) : ": # success sound disabled";
  }

  const scriptContent = [
    "# Auto-generated by PlaySoundExtension — do not edit",
    "_playsound_hook() {",
    "    local _exit=$?",
    "    if [ $_exit -ne 0 ]; then",
    `        ${playErrorCmd}`,
    '    elif [ -n "$_PS_INITIALIZED" ]; then',
    `        ${playSuccessCmd}`,
    "    fi",
    "    _PS_INITIALIZED=1",
    "}",
    // Bash: use PROMPT_COMMAND
    'if [ -n "$BASH_VERSION" ]; then',
    '  if [[ "${PROMPT_COMMAND}" != *"_playsound_hook"* ]]; then',
    '    PROMPT_COMMAND="_playsound_hook${PROMPT_COMMAND:+; $PROMPT_COMMAND}"',
    "  fi",
    "fi",
    // Zsh: use precmd_functions (macOS default shell since Catalina)
    'if [ -n "$ZSH_VERSION" ]; then',
    '  if (( ${precmd_functions[(I)_playsound_hook]} == 0 )); then',
    "    precmd_functions+=(_playsound_hook)",
    "  fi",
    "fi",
  ].join("\n");

  fs.writeFileSync(setupScriptPath, scriptContent, { mode: 0o755 });
  outputChannel.appendLine(`[Setup] Hook script ready (bash + zsh compatible)`);
}

// ── Windows: PowerShell prompt hook ──────────────────────────────────────────
function writeWindowsSetupScript(errorFile: string, successFile: string, volume: number) {
  const volFloat = (volume / 100).toFixed(2);

  const buildPSPlayCmd = (file: string): string => {
    const uri = file.replace(/\\/g, "/");
    return (
      `Start-Job {` +
      ` Add-Type -AssemblyName PresentationCore;` +
      ` $m=[System.Windows.Media.MediaPlayer]::new();` +
      ` $m.Open([uri]::new('file:///${uri}'));` +
      ` $m.Volume=${volFloat};` +
      ` $m.Play();` +
      ` Start-Sleep 5 } | Out-Null`
    );
  };

  const scriptContent = [
    "# Auto-generated by PlaySoundExtension — do not edit",
    "function global:_PlaySound_Hook {",
    "    $exitCode = $LASTEXITCODE",
    `    if ($exitCode -ne 0 -and '${errorFile}') {`,
    errorFile
      ? `        ${buildPSPlayCmd(errorFile)}`
      : "        # error sound disabled",
    `    } elseif ($global:_PS_Initialized -and '${successFile}') {`,
    successFile
      ? `        ${buildPSPlayCmd(successFile)}`
      : "        # success sound disabled",
    "    }",
    "    $global:_PS_Initialized = $true",
    "    $LASTEXITCODE = $exitCode",
    "}",
    "$__existingPrompt = if (Get-Command prompt -ErrorAction SilentlyContinue) { ${function:prompt}.ToString() } else { '' }",
    "function global:prompt {",
    "    _PlaySound_Hook",
    "    if ($__existingPrompt) { & ([scriptblock]::Create($__existingPrompt)) }",
    "    else { \"PS $($executionContext.SessionState.Path.CurrentLocation)$('>' * ($nestedPromptLevel + 1)) \" }",
    "}",
  ].join("\n");

  fs.writeFileSync(setupScriptPath, scriptContent);
  outputChannel.appendLine(
    `[Setup] PowerShell script updated — error: ${errorFile || "none"}, success: ${successFile || "none"}`,
  );
}

// ── Inject hook into a terminal (platform-aware, invisible to user) ────────────
function injectIntoTerminal(terminal: vscode.Terminal) {
  setTimeout(() => {
    if (platform === "win32") {
      // PowerShell: dot-source silently, clear the echoed line
      terminal.sendText(`. "${setupScriptPath}" 2>$null; [Console]::Write("\r" + " ".PadRight([Console]::WindowWidth) + "\r")`);
    } else {
      // Unix: disable echo → source → re-enable echo → erase line
      // stty -echo hides the typed command; \033[2K\r erases the line entirely
      terminal.sendText(
        `stty -echo 2>/dev/null; source "${setupScriptPath}" 2>/dev/null; stty echo 2>/dev/null; printf '\\033[2K\\r'`,
      );
    }
  }, 600);
}

// ── ACTIVATE ──────────────────────────────────────────────────────────────────
export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("PlaySoundExtension");
  outputChannel.appendLine(`PlaySoundExtension is now active! (platform: ${platform})`);
  // Output panel stays hidden — only opens if there's an error to investigate

  extensionPath = context.extensionPath;
  globalState = context.globalState;

  // Platform-specific temp script extension
  const scriptName = platform === "win32"
    ? "vscode_playsound_setup.ps1"
    : "vscode_playsound_setup.sh";
  setupScriptPath = path.join(os.tmpdir(), scriptName);

  // Set defaults if first run:
  // Prefer .wav when no MP3-capable player detected (avoids distortion on Linux)
  if (!getSelectedSound("error")) {
    const backend  = platform === "linux" ? await checkAudioBackend() : "mp3-capable";
    const allFiles = scanSoundFolder(path.join(context.extensionPath, "media", "error"));
    const wavFiles = allFiles.filter((f) => path.extname(f).toLowerCase() === ".wav");
    const preferred = (backend !== "mp3-capable" && wavFiles.length > 0) ? wavFiles[0] : allFiles[0];
    if (preferred) {
      context.globalState.update("playsound.selected.error", preferred);
    }
  }

  writeSetupScript();

  // Background: auto-swap any existing MP3 selections → WAV if no MP3 decoder,
  // or show install suggestion. Runs after commands register so UI is unblocked.
  (async () => {
    if (platform === "linux") {
      const backend = await checkAudioBackend();
      if (backend !== "mp3-capable") {
        let swapped = false;
        for (const type of ["error", "success"] as const) {
          if (await autoSwapToWav(type)) { swapped = true; }
        }
        if (swapped) {
          writeSetupScript();
          vscode.window.terminals.forEach(injectIntoTerminal);
          vscode.window.showInformationMessage(
            "✅ PlaySound: Switched to WAV — sounds will play correctly now. " +
            "To use MP3, install mpg123: sudo apt install mpg123",
          );
          return; // skip further popup — already fixed silently
        }
      }
    }
    showInstallSuggestion(context);
  })();

  // Inject into already-open terminals
  vscode.window.terminals.forEach(injectIntoTerminal);
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal(injectIntoTerminal),
  );

  // Register Commands
  context.subscriptions.push(
    // Select error sound from media/error/
    vscode.commands.registerCommand("playsoundextension.selectErrorSound", () =>
      showSoundPicker("error"),
    ),

    // Select success sound from media/success/
    vscode.commands.registerCommand(
      "playsoundextension.selectSuccessSound",
      () => showSoundPicker("success"),
    ),

    // Open media/error/ folder in file manager
    vscode.commands.registerCommand("playsoundextension.openErrorFolder", () =>
      openSoundFolder("error"),
    ),

    // Open media/success/ folder in file manager
    vscode.commands.registerCommand(
      "playsoundextension.openSuccessFolder",
      () => openSoundFolder("success"),
    ),

    // Test error sound
    vscode.commands.registerCommand("playsoundextension.testErrorSound", () => {
      const f = resolveSelectedSoundPath("error");
      if (!f) {
        vscode.window.showWarningMessage(
          "No error sound selected. Run: PlaySound: Select Error Sound",
        );
        return;
      }
      playSound(f, "Error test", true); // bypass cooldown for manual tests
    }),

    // Test success sound
    vscode.commands.registerCommand(
      "playsoundextension.testSuccessSound",
      () => {
        const f = resolveSelectedSoundPath("success");
        if (!f) {
          vscode.window.showWarningMessage(
            "No success sound selected. Run: PlaySound: Select Success Sound",
          );
          return;
        }
        playSound(f, "Success test", true); // bypass cooldown for manual tests
      },
    ),
  );

  outputChannel.appendLine(`PlaySoundExtension v1.2.1 active — platform: ${platform}`);
  outputChannel.appendLine(`Open View → Output → PlaySoundExtension to see errors only.`);
}

export function deactivate() {
  if (setupScriptPath && fs.existsSync(setupScriptPath)) {
    fs.unlinkSync(setupScriptPath);
  }
}
