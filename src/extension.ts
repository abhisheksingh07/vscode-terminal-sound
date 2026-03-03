import * as vscode from "vscode";
import * as path from "path";
import { exec } from "child_process";
import * as fs from "fs";
import * as os from "os";

let extensionPath = "";
let setupScriptPath = "";
let outputChannel: vscode.OutputChannel;
let globalState: vscode.Memento;
let lastPlayedTime = 0; // cooldown tracking

const SOUND_EXTENSIONS = [".mp3", ".wav", ".ogg"];

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

// ── Open the media folder so user can drop sounds ─────────────────────────────
function openSoundFolder(type: "error" | "success") {
  const folder = path.join(extensionPath, "media", type);
  exec(
    `xdg-open "${folder}" 2>/dev/null || nautilus "${folder}" 2>/dev/null || thunar "${folder}" 2>/dev/null`,
  );
  vscode.window.showInformationMessage(
    `Opened media/${type}/ — drop your .mp3 or .wav files there, then run the select command again.`,
  );
}

// ── Play a sound file (with cooldown + volume) ───────────────────────────────
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

  outputChannel.appendLine(
    `[${label}] Playing: ${soundFile} (volume: ${volume}%)`,
  );
  // ffplay volume: 1.0 = 100%, so divide by 100
  const vol = (volume / 100).toFixed(2);
  const cmd =
    `ffplay -nodisp -autoexit -loglevel quiet -volume ${volume} "${soundFile}" 2>/dev/null` +
    ` || aplay "${soundFile}" 2>/dev/null` +
    ` || paplay --volume=${Math.round((volume / 100) * 65536)} "${soundFile}" 2>/dev/null`;
  exec(cmd, (err) => {
    if (err) {
      outputChannel.appendLine(`[${label}] Playback failed: ${err.message}`);
    } else {
      outputChannel.appendLine(`[${label}] Played successfully!`);
    }
  });
}

// ── Write PROMPT_COMMAND bash hook to temp file ───────────────────────────────
function writeSetupScript() {
  const errorFile = resolveSelectedSoundPath("error");
  const successFile = resolveSelectedSoundPath("success");
  const config = vscode.workspace.getConfiguration("playsoundextension");
  const volume = Math.max(1, Math.min(100, config.get<number>("volume", 100)));

  const playErrorCmd = errorFile
    ? `ffplay -nodisp -autoexit -loglevel quiet -volume ${volume} "${errorFile}" >/dev/null 2>&1 &`
    : ": # error sound disabled";
  const playSuccessCmd = successFile
    ? `ffplay -nodisp -autoexit -loglevel quiet -volume ${volume} "${successFile}" >/dev/null 2>&1 &`
    : ": # success sound disabled";

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
    `[Setup] Script updated — error: ${errorFile || "none"}, success: ${successFile || "none"}`,
  );
}

// ── Inject hook into a terminal ───────────────────────────────────────────────
function injectIntoTerminal(terminal: vscode.Terminal) {
  setTimeout(() => {
    terminal.sendText(`source "${setupScriptPath}" && printf '\\r\\033[K'`);
    outputChannel.appendLine(`[Terminal] Hook injected into: ${terminal.name}`);
  }, 500);
}

// ── ACTIVATE ──────────────────────────────────────────────────────────────────
export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel("PlaySoundExtension");
  outputChannel.appendLine("PlaySoundExtension is now active!");
  outputChannel.show(true);

  extensionPath = context.extensionPath;
  globalState = context.globalState;
  setupScriptPath = path.join(os.tmpdir(), "vscode_playsound_setup.sh");

  // Set defaults if first run (error-1.mp3, success disabled)
  if (!getSelectedSound("error")) {
    context.globalState.update("playsound.selected.error", "error-1.mp3");
  }

  writeSetupScript();

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
