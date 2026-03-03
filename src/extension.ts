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

// ── Check which audio backend is available ────────────────────────────────────
async function checkAudioBackend(): Promise<string | null> {
  if (platform === "darwin") {
    return "afplay"; // built-in on every macOS — never needs installing
  }
  if (platform === "win32") {
    return "powershell"; // always available on Windows
  }
  // Linux — try each player in priority order
  for (const player of ["ffplay", "aplay", "paplay", "mpg123", "mpv", "cvlc", "mplayer"]) {
    if (await commandExists(player)) {
      return player;
    }
  }
  return null;
}

// ── One-time install suggestion if no audio backend is found (Linux only) ─────
async function showInstallSuggestion(context: vscode.ExtensionContext): Promise<void> {
  // macOS and Windows always have a backend — only Linux might be missing one
  if (platform !== "linux") {
    return;
  }
  const alreadyShown = context.globalState.get<boolean>("audioBackendWarningShown", false);
  if (alreadyShown) {
    return;
  }

  const backend = await checkAudioBackend();
  if (backend) {
    return; // at least one player found — nothing to do
  }

  const selection = await vscode.window.showWarningMessage(
    "🔇 PlaySound: No audio player found on your system. Install one to enable sound alerts.",
    "Install ffmpeg (Recommended)",
    "Install mpg123 (Lightweight)",
    "Install mpv",
    "Remind Me Later",
  );

  if (!selection || selection === "Remind Me Later") {
    return;
  }

  const cmdsMap: Record<string, { apt: string; dnf: string; pacman: string }> = {
    "Install ffmpeg (Recommended)": {
      apt: "sudo apt install ffmpeg",
      dnf: "sudo dnf install ffmpeg",
      pacman: "sudo pacman -S ffmpeg",
    },
    "Install mpg123 (Lightweight)": {
      apt: "sudo apt install mpg123",
      dnf: "sudo dnf install mpg123",
      pacman: "sudo pacman -S mpg123",
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

  // Linux — try players in order, stop at first success
  return (
    `ffplay -nodisp -autoexit -loglevel quiet -volume ${volume} "${soundFile}" 2>/dev/null` +
    ` || mpg123 -q "${soundFile}" 2>/dev/null` +
    ` || aplay "${soundFile}" 2>/dev/null` +
    ` || paplay --volume=${Math.round((volume / 100) * 65536)} "${soundFile}" 2>/dev/null` +
    ` || mpv --no-video --really-quiet "${soundFile}" 2>/dev/null` +
    ` || cvlc --play-and-exit --quiet "${soundFile}" 2>/dev/null` +
    ` || mplayer -really-quiet "${soundFile}" 2>/dev/null`
  );
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
    outputChannel.appendLine(`[${label}] No sound file found: ${soundFile}`);
    return;
  }

  const config = vscode.workspace.getConfiguration("playsoundextension");
  const cooldown = config.get<number>("cooldownSeconds", 2) * 1000;
  const volume = Math.max(1, Math.min(100, config.get<number>("volume", 100)));
  const now = Date.now();

  if (!bypassCooldown && now - lastPlayedTime < cooldown) {
    outputChannel.appendLine(
      `[${label}] Skipped (cooldown active, ${Math.round((cooldown - (now - lastPlayedTime)) / 1000)}s left)`,
    );
    return;
  }
  lastPlayedTime = now;

  const cmd = buildPlayCommand(soundFile, volume);
  outputChannel.appendLine(`[${label}] Playing: ${soundFile} (volume: ${volume}%, platform: ${platform})`);

  exec(cmd, (err) => {
    if (err) {
      outputChannel.appendLine(`[${label}] Playback failed: ${err.message}`);
    } else {
      outputChannel.appendLine(`[${label}] Played successfully!`);
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
    // Linux: fallback chain ffplay → mpg123 → aplay
    playErrorCmd = errorFile
      ? `ffplay -nodisp -autoexit -loglevel quiet -volume ${volume} "${errorFile}" >/dev/null 2>&1 ||` +
        ` mpg123 -q "${errorFile}" >/dev/null 2>&1 ||` +
        ` aplay "${errorFile}" >/dev/null 2>&1 &`
      : ": # error sound disabled";
    playSuccessCmd = successFile
      ? `ffplay -nodisp -autoexit -loglevel quiet -volume ${volume} "${successFile}" >/dev/null 2>&1 ||` +
        ` mpg123 -q "${successFile}" >/dev/null 2>&1 ||` +
        ` aplay "${successFile}" >/dev/null 2>&1 &`
      : ": # success sound disabled";
  }

  const scriptContent = [
    "#!/usr/bin/env bash",
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
    'if [[ "$PROMPT_COMMAND" != *"_playsound_hook"* ]]; then',
    '    [ -z "$PROMPT_COMMAND" ] && export PROMPT_COMMAND="_playsound_hook" \\',
    '                             || export PROMPT_COMMAND="_playsound_hook; $PROMPT_COMMAND"',
    "fi",
  ].join("\n");

  fs.writeFileSync(setupScriptPath, scriptContent, { mode: 0o755 });
  outputChannel.appendLine(
    `[Setup] Bash script updated — error: ${errorFile || "none"}, success: ${successFile || "none"}`,
  );
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

// ── Inject hook into a terminal (platform-aware) ─────────────────────────────
function injectIntoTerminal(terminal: vscode.Terminal) {
  setTimeout(() => {
    if (platform === "win32") {
      // PowerShell: dot-source the .ps1 file
      terminal.sendText(`. "${setupScriptPath}"`);
    } else {
      // Linux / macOS: source the bash script and clear the injected line
      terminal.sendText(`source "${setupScriptPath}" && printf '\\r\\033[K'`);
    }
    outputChannel.appendLine(`[Terminal] Hook injected into: ${terminal.name}`);
  }, 500);
}

// ── ACTIVATE ──────────────────────────────────────────────────────────────────
export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("PlaySoundExtension");
  outputChannel.appendLine(`PlaySoundExtension is now active! (platform: ${platform})`);
  outputChannel.show(true);

  extensionPath = context.extensionPath;
  globalState = context.globalState;

  // Platform-specific temp script extension
  const scriptName = platform === "win32"
    ? "vscode_playsound_setup.ps1"
    : "vscode_playsound_setup.sh";
  setupScriptPath = path.join(os.tmpdir(), scriptName);

  // Set defaults if first run (error-1.mp3, success disabled)
  if (!getSelectedSound("error")) {
    context.globalState.update("playsound.selected.error", "error-1.mp3");
  }

  writeSetupScript();

  // Check audio backend and show install suggestion if needed (Linux only)
  await showInstallSuggestion(context);

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

  outputChannel.appendLine(
    'Commands ready. Use Ctrl+Shift+P → "PlaySound" to configure.',
  );
  outputChannel.appendLine(
    `  Error folder:   ${path.join(extensionPath, "media", "error")}`,
  );
  outputChannel.appendLine(
    `  Success folder: ${path.join(extensionPath, "media", "success")}`,
  );
}

export function deactivate() {
  if (setupScriptPath && fs.existsSync(setupScriptPath)) {
    fs.unlinkSync(setupScriptPath);
  }
}
