import * as vscode from "vscode";
import * as path from "path";
import { exec } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as https from "https";
import { promisify } from "util";

const execAsync = promisify(exec);

let extensionPath = "";
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

// ── Get the current version from the extension's own package.json ────────────
function getInstalledVersion(context: vscode.ExtensionContext): string {
  return (context.extension.packageJSON as { version?: string }).version ?? "0.0.0";
}

// ── Show "What's New" notification once after each extension update ───────────
async function showWhatsNewIfUpdated(context: vscode.ExtensionContext): Promise<void> {
  const current  = getInstalledVersion(context);
  const lastSeen = context.globalState.get<string>("lastSeenVersion", "");
  if (lastSeen === current) { return; }

  await context.globalState.update("lastSeenVersion", current);

  const choice = await vscode.window.showInformationMessage(
    `🎵 PlaySound updated to v${current}!`,
    "What's New",
    "Dismiss",
  );

  if (choice === "What's New") {
    outputChannel.appendLine(`\n── What's New in v${current} ─────────────────────────────────────────`);
    outputChannel.appendLine(`• Zero terminal restart required — works instantly in all open terminals`);
    outputChannel.appendLine(`• No RC file modification — ~/.bashrc / ~/.zshrc are never touched`);
    outputChannel.appendLine(`• Uses VS Code shell integration API for clean exit-code detection`);
    outputChannel.appendLine(`• Uninstall is fully clean — nothing left behind`);
    outputChannel.appendLine(`• Terminal is always completely silent`);
    outputChannel.appendLine(`──────────────────────────────────────────────────────────────────────\n`);
    outputChannel.show(true); // reveal without stealing focus
  }
}

// ── Background: poll VS Code Marketplace for a newer release ─────────────────
function checkForMarketplaceUpdate(context: vscode.ExtensionContext): void {
  const current  = getInstalledVersion(context);
  const postData = JSON.stringify({
    filters: [{ criteria: [{ filterType: 7, value: "Vynode.playsoundextension" }] }],
    flags: 103,
  });

  const req = https.request(
    {
      hostname: "marketplace.visualstudio.com",
      path: "/_apis/public/gallery/extensionquery",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json;api-version=3.0-preview.1",
        "Content-Length": Buffer.byteLength(postData),
      },
    },
    (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", async () => {
        try {
          const json = JSON.parse(body);
          const latest: string =
            json?.results?.[0]?.extensions?.[0]?.versions?.[0]?.version ?? "";
          if (!latest || latest === current) { return; }

          // Simple numeric semver compare
          const n = (v: string) => v.split(".").map(Number);
          const [lM, lm, lp] = n(latest);
          const [cM, cm, cp] = n(current);
          const isNewer =
            lM > cM ||
            (lM === cM && lm > cm) ||
            (lM === cM && lm === cm && lp > cp);
          if (!isNewer) { return; }

          const choice = await vscode.window.showInformationMessage(
            `🎵 PlaySound v${latest} is available! (installed: v${current})`,
            "Update Now",
            "Later",
          );
          if (choice === "Update Now") {
            vscode.commands.executeCommand("workbench.extensions.action.checkForUpdates");
            vscode.commands.executeCommand(
              "workbench.extensions.action.showExtensionsWithIds",
              ["Vynode.playsoundextension"],
            );
          }
        } catch { /* ignore network/parse errors silently */ }
      });
    },
  );
  req.on("error", () => { /* ignore */ });
  req.write(postData);
  req.end();
}

// ── ACTIVATE ──────────────────────────────────────────────────────────────────
export async function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("PlaySoundExtension");
  outputChannel.appendLine(`PlaySoundExtension is now active! (platform: ${platform})`);

  extensionPath = context.extensionPath;
  globalState = context.globalState;

  // Set defaults on first run — prefer .wav when no MP3-capable player (avoids distortion on Linux)
  if (!getSelectedSound("error")) {
    const backend  = platform === "linux" ? await checkAudioBackend() : "mp3-capable";
    const allFiles = scanSoundFolder(path.join(context.extensionPath, "media", "error"));
    const wavFiles = allFiles.filter((f) => path.extname(f).toLowerCase() === ".wav");
    const preferred = (backend !== "mp3-capable" && wavFiles.length > 0) ? wavFiles[0] : allFiles[0];
    if (preferred) {
      context.globalState.update("playsound.selected.error", preferred);
    }
  }

  // ── Core: listen for terminal command completions via VS Code shell integration ──
  // Fires for every command in every terminal — no hooks, no RC files, no restart needed.
  // Works instantly in all currently open terminals the moment the extension activates.
  // Stops the moment the extension is disabled/uninstalled (subscription is auto-disposed).
  context.subscriptions.push(
    vscode.window.onDidEndTerminalShellExecution((event) => {
      const exitCode = event.exitCode;
      if (exitCode === undefined) { return; } // shell integration didn't capture exit code

      if (exitCode !== 0) {
        const f = resolveSelectedSoundPath("error");
        if (f) { playSound(f, "error"); }
      } else {
        const f = resolveSelectedSoundPath("success");
        if (f) { playSound(f, "success"); }
      }
    })
  );

  // Background: auto-swap MP3 → WAV if no MP3 decoder, or show install suggestion
  (async () => {
    if (platform === "linux") {
      const backend = await checkAudioBackend();
      if (backend !== "mp3-capable") {
        let swapped = false;
        for (const type of ["error", "success"] as const) {
          if (await autoSwapToWav(type)) { swapped = true; }
        }
        if (swapped) {
          vscode.window.showInformationMessage(
            "✅ PlaySound: Switched to WAV — sounds will play correctly now. " +
            "To use MP3, install mpg123: sudo apt install mpg123",
          );
          return;
        }
      }
    }
    showInstallSuggestion(context);
  })();

  // Show "What's New" if just updated; check Marketplace for newer release
  showWhatsNewIfUpdated(context);
  checkForMarketplaceUpdate(context);

  // Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand("playsoundextension.selectErrorSound", () =>
      showSoundPicker("error"),
    ),
    vscode.commands.registerCommand("playsoundextension.selectSuccessSound", () =>
      showSoundPicker("success"),
    ),
    vscode.commands.registerCommand("playsoundextension.openErrorFolder", () =>
      openSoundFolder("error"),
    ),
    vscode.commands.registerCommand("playsoundextension.openSuccessFolder", () =>
      openSoundFolder("success"),
    ),
    vscode.commands.registerCommand("playsoundextension.testErrorSound", () => {
      const f = resolveSelectedSoundPath("error");
      if (!f) {
        vscode.window.showWarningMessage("No error sound selected. Run: PlaySound: Select Error Sound");
        return;
      }
      playSound(f, "Error test", true);
    }),
    vscode.commands.registerCommand("playsoundextension.testSuccessSound", () => {
      const f = resolveSelectedSoundPath("success");
      if (!f) {
        vscode.window.showWarningMessage("No success sound selected. Run: PlaySound: Select Success Sound");
        return;
      }
      playSound(f, "Success test", true);
    }),
  );

  outputChannel.appendLine(`PlaySoundExtension v1.2.4 active — platform: ${platform}`);
  outputChannel.appendLine(`Open View → Output → PlaySoundExtension to see errors only.`);
}

export function deactivate() {
  // All listeners are in context.subscriptions — VS Code disposes them automatically.
  // No RC files were ever written, nothing to clean up.
}
