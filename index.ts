/**
 * picc-grep: Claude Code-style Grep (content search) tool for pi.
 *
 * A faithful port of Claude Code's `Grep` tool (`tools/GrepTool/GrepTool.ts`),
 * backed by **ripgrep**. Supports the three Claude Code output modes
 * (`content`, `files_with_matches` (default), `count`), rich flags
 * (`-A`/`-B`/`-C`/`context`, `-n`, `-i`, `-o`, `type`, `glob`, `multiline`),
 * `head_limit` (default 250, `0` = unlimited) + `offset` pagination,
 * `--max-columns 500`, VCS-dir excludes, and per-mode result templates with
 * path relativization against cwd.
 *
 * Tool-result text is byte-for-byte Claude Code's: content mode rewrites the
 * path in place on every ripgrep line (`relpath:num:content`, `relpath-num-content`
 * for context lines, `--` group separators preserved), files_with_matches and
 * count carry their `limit: N` inside the summary sentence rather than a
 * trailing footer, and a missing `path` fails with
 * `Path does not exist: <path>. Note: your current working directory is <cwd>.`
 * plus a `Did you mean …?` hint.
 *
 * Deviations from the live source, all deliberate:
 *   - the `-o` (only-matching) parameter is an extension (present in the local
 *     `Grep_schema.json`, absent from Claude Code's live source)
 *   - the path/content boundary is verified against the filesystem
 *     (`parseContentLinePath`) instead of `line.indexOf(':')`
 *   - permission-based ignore patterns (`getFileReadIgnorePatterns`) and
 *     orphaned plugin-cache exclusions (`getGlobExclusionsForPluginCache`) are
 *     omitted — no pi equivalent, same as picc-glob
 *
 * Tool name configuration:
 *   - Default: `"grep"` (lowercase; Claude Code's actual name is `"Grep"`).
 *   - Set `config.json` `toolName` to `"Grep"` (default location
 *     `~/.pi/agent/extensions/picc-grep/config.json`), or set
 *     `PICC_GREP_TOOL_NAME=Grep`. Valid values: `"grep"`, `"Grep"`.
 *
 * Ripgrep resolution: the tool uses `rg` from `~/.pi/agent/bin` (where pi
 * caches its own tool downloads) or from PATH, and — matching pi's built-in
 * grep/find tools — downloads the official BurntSushi release into that bin
 * directory when `rg` is missing entirely. Set `PI_OFFLINE=1` to opt out.
 */

import { spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { arch, homedir, platform } from "node:os";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	normalize,
	relative,
	resolve,
	sep,
} from "node:path";
import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ============================================================================
// Config
// ============================================================================

/** Tool names the grep tool may be registered as. */
const VALID_TOOL_NAMES = ["grep", "Grep"] as const;
type ToolName = (typeof VALID_TOOL_NAMES)[number];

/**
 * Resolve the config.json path.
 * Default: `~/.pi/agent/extensions/picc-grep/config.json` (stable, outside
 * node_modules, so it survives reinstalls — the package itself may live in
 * `~/.pi/agent/npm/node_modules/` when installed via `pi install npm:`).
 * Override at runtime via PICC_GREP_CONFIG_PATH.
 */
function resolveConfigPath(): string {
	const env = process.env.PICC_GREP_CONFIG_PATH;
	if (env) return env;
	return join(
		homedir(),
		".pi",
		"agent",
		"extensions",
		"picc-grep",
		"config.json",
	);
}

function readToolNameFromConfig(): ToolName | undefined {
	const configPath = resolveConfigPath();
	if (!existsSync(configPath)) return undefined;
	try {
		const raw = readFileSync(configPath, "utf-8");
		const parsed = JSON.parse(raw) as { toolName?: unknown };
		const val = parsed?.toolName;
		if (
			typeof val === "string" &&
			(VALID_TOOL_NAMES as readonly string[]).includes(val)
		) {
			return val as ToolName;
		}
		if (val !== undefined) {
			console.warn(
				`[picc-grep] config.json: invalid toolName "${val}" — valid values are ${VALID_TOOL_NAMES.join(", ")}. Falling back to "grep".`,
			);
		}
	} catch {
		// unreadable / malformed — fall through to default
	}
	return undefined;
}

function loadToolName(): ToolName {
	// Precedence: PICC_GREP_TOOL_NAME env var > config.json > "grep" default
	const envVal = process.env.PICC_GREP_TOOL_NAME;
	if (typeof envVal === "string") {
		if ((VALID_TOOL_NAMES as readonly string[]).includes(envVal)) {
			return envVal as ToolName;
		}
		console.warn(
			`[picc-grep] PICC_GREP_TOOL_NAME="${envVal}" is invalid — valid values are ${VALID_TOOL_NAMES.join(", ")}. Falling back to "grep".`,
		);
	}
	return readToolNameFromConfig() ?? "grep";
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_HEAD_LIMIT = 250;

const MAX_BUFFER_SIZE = 20_000_000;

/** Sent as the GitHub User-Agent; the API rejects requests without one. */
const RIPGREP_USER_AGENT = "picc-grep";

const VCS_DIRECTORIES_TO_EXCLUDE = [
	".git",
	".svn",
	".hg",
	".bzr",
	".jj",
	".sl",
] as const;

/**
 * Tool description
 */
const DESCRIPTION = `A powerful search tool built on ripgrep

Usage:
- ALWAYS use grep for search tasks. NEVER invoke \`grep\` or \`rg\` as a Bash command. The grep tool has been optimized for correct permissions and access.
- Supports full regex syntax (e.g., "log.*Error", "function\\s+\\w+")
- Filter files with glob parameter (e.g., "*.js", "**/*.tsx") or type parameter (e.g., "js", "py", "rust")
- Output modes: "content" shows matching lines, "files_with_matches" shows only file paths (default), "count" shows match counts
- Use Agent tool for open-ended searches requiring multiple rounds
- Pattern syntax: Uses ripgrep (not grep) - literal braces need escaping (use \`interface\\{\\}\` to find \`interface{}\` in Go code)
- Multiline matching: By default patterns match within single lines only. For cross-line patterns like \`struct \\{[\\s\\S]*?field\`, use \`multiline: true\``;

type OutputMode = "content" | "files_with_matches" | "count";

// ============================================================================
// Path helpers
// ============================================================================

function isWindows(): boolean {
	return platform() === "win32";
}

/**
 * WSL is not a value in Node's `Platform` union, so compare against the
 * string form (Claude Code's `getPlatform() === 'wsl'`).
 */
function isWsl(): boolean {
	return (platform() as string) === "wsl";
}

/**
 * Handles `~`, POSIX-style
 * Windows paths (`/c/Users/...`), and relative→absolute resolution.
 */
function posixPathToWindowsPath(posixPath: string): string {
	const m = posixPath.match(/^\/([a-zA-Z])\/(.*)$/);
	if (m) {
		return `${m[1]}:/${(m[2] ?? "").split("/").join("\\")}`;
	}
	return posixPath;
}

function expandPath(input: string, baseDir: string): string {
	const trimmed = input.trim();
	if (!trimmed) return normalize(baseDir);

	if (trimmed === "~") return homedir();
	if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));

	let processed = trimmed;
	if (isWindows() && /^\/[a-z]\//i.test(trimmed)) {
		processed = posixPathToWindowsPath(trimmed);
	}

	if (isAbsolute(processed)) return normalize(processed);
	return resolve(baseDir, processed);
}

/**
 * relativize against cwd, keeping the
 * absolute path when it would escape cwd (starts with `..`).
 */
function toRelativePath(absolutePath: string, cwd: string): string {
	const rel = relative(cwd, absolutePath);
	return rel.startsWith("..") ? absolutePath : rel;
}

/**
 * Resolve a path as returned by ripgrep against the search directory.
 *
 * rg emits paths relative to its target directory. On Windows the output
 * mixes separators (a drive-rooted prefix uses `/`, the rest uses `\`), and
 * Node's `path.join` mangles drive-rooted relative paths. So:
 *   - if the path is already absolute (either separator) → normalize it;
 *   - else if it starts with the search directory → slice it off;
 *   - otherwise fall back to `path.join`.
 */
function resolveRgPath(p: string, searchDir: string): string {
	const norm = p.replace(/\//g, sep);
	if (isAbsolute(norm)) return normalize(norm);
	if (isAbsolute(p)) return normalize(p);
	if (p.startsWith(searchDir)) return normalize(p.slice(searchDir.length));
	return normalize(join(searchDir, p));
}

/**
 * Port of Claude Code's `suggestPathUnderCwd` (`utils/file.ts`): a missing path
 * that lives *next to* cwd (a sibling directory of the current project) usually
 * means the same relative path under cwd was intended — return that candidate
 * when it exists, else `undefined`.
 *
 * `cwd` is threaded in rather than read from a global, since pi hands it to
 * `execute()` per call.
 */
async function suggestPathUnderCwd(
	requestedPath: string,
	cwd: string,
): Promise<string | undefined> {
	const cwdParent = dirname(cwd);

	// Resolve symlinks in the requested path's parent directory (e.g. /tmp ->
	// /private/tmp on macOS) so the prefix comparison works against `cwd`,
	// which is already realpath-resolved.
	let resolvedPath = requestedPath;
	try {
		const resolvedDir = await realpath(dirname(requestedPath));
		resolvedPath = join(resolvedDir, basename(requestedPath));
	} catch {
		// Parent directory doesn't exist — use the original path.
	}

	// Only check when the requested path is under cwd's parent but not under
	// cwd itself. When cwd's parent is the root, use it directly as the prefix
	// to avoid a double separator that would never match.
	const cwdParentPrefix = cwdParent === sep ? sep : cwdParent + sep;
	if (
		!resolvedPath.startsWith(cwdParentPrefix) ||
		resolvedPath.startsWith(cwd + sep) ||
		resolvedPath === cwd
	) {
		return undefined;
	}

	// Same relative path, but rooted at cwd.
	const correctedPath = join(cwd, relative(cwdParent, resolvedPath));
	try {
		await stat(correctedPath);
		return correctedPath;
	} catch {
		return undefined;
	}
}

// ============================================================================
// Ripgrep resolution (override → pi bin dir → PATH → auto-download)
// ============================================================================

const RIPGREP_REPO = "BurntSushi/ripgrep";

const RIPGREP_VERSION_TIMEOUT_MS = 10_000;

const RIPGREP_DOWNLOAD_TIMEOUT_MS = 120_000;

/**
 * `~/.pi/agent/bin` — the same directory pi's own tools-manager uses, so a
 * single downloaded `rg` serves both pi's built-ins and this tool. Resolved via
 * pi's `getAgentDir()` so `PI_CODING_AGENT_DIR` overrides are honored.
 */
function getBinDir(): string {
	return join(getAgentDir(), "bin");
}

/** Offline opt-out, mirroring pi's own `PI_OFFLINE` handling. */
function isOfflineModeEnabled(): boolean {
	const value = process.env.PI_OFFLINE;
	if (!value) return false;
	const lower = value.toLowerCase();
	return value === "1" || lower === "true" || lower === "yes";
}

function rgBinaryName(): string {
	return isWindows() ? "rg.exe" : "rg";
}

/** Probe PATH by actually executing the command (a missing binary sets `error`). */
function executableWorks(command: string): boolean {
	try {
		const result = spawnSync(command, ["--version"], {
			stdio: "pipe",
			windowsHide: true,
		});
		return result.error === undefined || result.error === null;
	} catch {
		return false;
	}
}

/** Resolve the latest release tag from the redirect, avoiding the API quota. */
async function resolveLatestRipgrepVersion(): Promise<string> {
	const response = await fetch(
		`https://github.com/${RIPGREP_REPO}/releases/latest`,
		{
			headers: { "User-Agent": RIPGREP_USER_AGENT },
			redirect: "manual",
			signal: AbortSignal.timeout(RIPGREP_VERSION_TIMEOUT_MS),
		},
	);
	// Only the status and headers matter; discard the body to reuse the socket.
	try {
		await response.body?.cancel();
	} catch {
		// Best-effort.
	}
	const location =
		response.status >= 300 && response.status < 400
			? response.headers.get("location")
			: null;
	if (!location) {
		throw new Error(
			`failed to resolve the latest ripgrep release (HTTP ${response.status} without a redirect)`,
		);
	}
	const tag = new URL(location, "https://github.com").pathname.split("/").pop();
	if (!tag || !location.includes("/releases/tag/")) {
		throw new Error(
			`failed to resolve the latest ripgrep release (unexpected redirect to ${location})`,
		);
	}
	return decodeURIComponent(tag).replace(/^v/, "");
}

/** Official release asset for this platform/arch, or `null` when unavailable. */
function ripgrepAssetName(
	version: string,
	plat: string = platform(),
	architecture: string = arch(),
): string | null {
	const rustArch =
		architecture === "x64"
			? "x86_64"
			: architecture === "arm64"
				? "aarch64"
				: architecture === "ia32"
					? "i686"
					: architecture === "arm"
						? "armv7"
						: null;
	if (!rustArch) return null;
	if (plat === "darwin") {
		// Only x64/arm64 builds are published for macOS.
		if (architecture !== "x64" && architecture !== "arm64") return null;
		return `ripgrep-${version}-${rustArch}-apple-darwin.tar.gz`;
	}
	if (plat === "linux") {
		// musl builds are static, so they work on any glibc/musl distro.
		if (architecture === "x64" || architecture === "arm64") {
			return `ripgrep-${version}-${rustArch}-unknown-linux-musl.tar.gz`;
		}
		if (architecture === "arm") {
			return `ripgrep-${version}-armv7-unknown-linux-musleabihf.tar.gz`;
		}
		return null;
	}
	if (plat === "win32") {
		if (
			architecture === "x64" ||
			architecture === "arm64" ||
			architecture === "ia32"
		) {
			return `ripgrep-${version}-${rustArch}-pc-windows-msvc.zip`;
		}
		return null;
	}
	return null;
}

async function downloadFile(url: string, dest: string): Promise<void> {
	const response = await fetch(url, {
		redirect: "follow",
		signal: AbortSignal.timeout(RIPGREP_DOWNLOAD_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`download failed with HTTP ${response.status}: ${url}`);
	}
	// The release archives are a few MB, so buffering the whole body is fine and
	// avoids the DOM/node `ReadableStream` type friction of `Readable.fromWeb`.
	writeFileSync(dest, Buffer.from(await response.arrayBuffer()));
}

function runExtractionCommand(command: string, args: string[]): string | null {
	const result = spawnSync(command, args, { stdio: "pipe", windowsHide: true });
	if (!result.error && result.status === 0) return null;
	const stderr = result.stderr?.toString().trim();
	const stdout = result.stdout?.toString().trim();
	const detail =
		result.error?.message || stderr || stdout || `exit status ${result.status}`;
	return `${command}: ${detail}`;
}

/**
 * Windows ships bsdtar as `System32\tar.exe`, which reads zip archives — prefer
 * it over Git Bash's GNU tar, which does not.
 */
function getWindowsTarCommand(): string {
	const systemRoot = process.env.SystemRoot;
	if (systemRoot) {
		const systemTar = join(systemRoot, "System32", "tar.exe");
		if (existsSync(systemTar)) return systemTar;
	}
	return "tar.exe";
}

function extractZipArchive(
	archivePath: string,
	extractDir: string,
	assetName: string,
): void {
	const failures: string[] = [];
	if (isWindows()) {
		const tarFailure = runExtractionCommand(getWindowsTarCommand(), [
			"xf",
			archivePath,
			"-C",
			extractDir,
		]);
		if (!tarFailure) return;
		failures.push(tarFailure);
		const script =
			"& { param($archive, $destination) $ErrorActionPreference = 'Stop'; Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }";
		const powershellFailure = runExtractionCommand("powershell.exe", [
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-ExecutionPolicy",
			"Bypass",
			"-Command",
			script,
			archivePath,
			extractDir,
		]);
		if (!powershellFailure) return;
		failures.push(powershellFailure);
	} else {
		const unzipFailure = runExtractionCommand("unzip", [
			"-q",
			archivePath,
			"-d",
			extractDir,
		]);
		if (!unzipFailure) return;
		failures.push(unzipFailure);
		const tarFailure = runExtractionCommand("tar", [
			"xf",
			archivePath,
			"-C",
			extractDir,
		]);
		if (!tarFailure) return;
		failures.push(tarFailure);
	}
	throw new Error(`failed to extract ${assetName}: ${failures.join("; ")}`);
}

function extractTarGzArchive(
	archivePath: string,
	extractDir: string,
	assetName: string,
): void {
	const failure = runExtractionCommand("tar", [
		"xzf",
		archivePath,
		"-C",
		extractDir,
	]);
	if (failure) throw new Error(`failed to extract ${assetName}: ${failure}`);
}

function findBinaryRecursively(
	rootDir: string,
	binaryFileName: string,
): string | null {
	const stack = [rootDir];
	while (stack.length > 0) {
		const currentDir = stack.pop();
		if (!currentDir) continue;
		const entries = readdirSync(currentDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = join(currentDir, entry.name);
			if (entry.isFile() && entry.name === binaryFileName) return fullPath;
			if (entry.isDirectory()) stack.push(fullPath);
		}
	}
	return null;
}

/**
 * Download the official ripgrep release and install the binary into
 * `~/.pi/agent/bin` (the directory pi's own tools-manager reads from).
 */
async function downloadRipgrep(): Promise<string> {
	const version = await resolveLatestRipgrepVersion();
	const assetName = ripgrepAssetName(version);
	if (!assetName) {
		throw new Error(`no official ripgrep release for ${platform()}/${arch()}`);
	}

	const binDir = getBinDir();
	mkdirSync(binDir, { recursive: true });

	const binaryName = rgBinaryName();
	const binaryPath = join(binDir, binaryName);
	const archivePath = join(binDir, assetName);
	const downloadUrl = `https://github.com/${RIPGREP_REPO}/releases/download/${version}/${assetName}`;

	await downloadFile(downloadUrl, archivePath);

	// Extract into a unique temp dir: parallel tool calls can both reach here
	// (the promise cache only dedupes within one process run).
	const extractDir = join(
		binDir,
		`extract_tmp_rg_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
	);
	mkdirSync(extractDir, { recursive: true });
	try {
		if (assetName.endsWith(".tar.gz")) {
			extractTarGzArchive(archivePath, extractDir, assetName);
		} else if (assetName.endsWith(".zip")) {
			extractZipArchive(archivePath, extractDir, assetName);
		} else {
			throw new Error(`unsupported archive format: ${assetName}`);
		}

		// Archives nest the binary under a versioned directory in some releases
		// and place it at the root in others.
		const extractedDir = join(
			extractDir,
			assetName.replace(/\.(tar\.gz|zip)$/, ""),
		);
		let extractedBinary = [
			join(extractedDir, binaryName),
			join(extractDir, binaryName),
		].find((candidate) => existsSync(candidate));
		if (!extractedBinary) {
			extractedBinary =
				findBinaryRecursively(extractDir, binaryName) ?? undefined;
		}
		if (!extractedBinary) {
			throw new Error(`binary ${binaryName} not found in ${assetName}`);
		}

		// rename() replaces an existing target on POSIX; on Windows it fails if
		// the file is locked (rg running), so fall back to an in-place write.
		try {
			renameSync(extractedBinary, binaryPath);
		} catch {
			copyFileSync(extractedBinary, binaryPath);
		}
		if (!isWindows()) chmodSync(binaryPath, 0o755);
	} finally {
		rmSync(archivePath, { force: true });
		rmSync(extractDir, { recursive: true, force: true });
	}

	return binaryPath;
}

async function resolveRipgrepBinary(
	notify?: (message: string) => void,
): Promise<string> {
	const override = process.env.PICC_GREP_RG_PATH;
	if (override) {
		if (!existsSync(override)) {
			throw new Error(
				`PICC_GREP_RG_PATH is set to ${override}, but no file exists there`,
			);
		}
		return override;
	}

	// Prefer the shared pi bin dir, then PATH, then download. A present-but-broken
	// binary (truncated download, wrong architecture) is treated as missing so the
	// next branch — or a fresh download — can take over, instead of failing every
	// search until the user deletes the file by hand.
	const localPath = join(getBinDir(), rgBinaryName());
	if (existsSync(localPath) && executableWorks(localPath)) return localPath;
	if (executableWorks("rg")) return "rg";

	if (isOfflineModeEnabled()) {
		throw new Error(
			"ripgrep (rg) not found and PI_OFFLINE is set, so it will not be downloaded. Install ripgrep or set PICC_GREP_RG_PATH.",
		);
	}
	// Linux binaries cannot run on Android (Bionic libc); Termux must use pkg.
	if (platform() === "android") {
		throw new Error(
			"ripgrep (rg) not found. Install it with: pkg install ripgrep",
		);
	}

	notify?.("ripgrep (rg) not found — downloading...");
	try {
		const installedPath = await downloadRipgrep();
		notify?.(`ripgrep installed to ${installedPath}`);
		return installedPath;
	} catch (err) {
		// Include the cause chain: a `fetch failed` hides DNS/TLS/timeout detail.
		const messages: string[] = [];
		for (
			let current: unknown = err, depth = 0;
			current instanceof Error && depth < 5;
			current = current.cause, depth++
		) {
			if (!messages.includes(current.message)) messages.push(current.message);
		}
		const detail = messages.length > 0 ? messages.join(": ") : String(err);
		throw new Error(
			`ripgrep (rg) not found and automatic download failed (${detail}). Install ripgrep or set PICC_GREP_RG_PATH.`,
		);
	}
}

/**
 * Process-wide memo for the resolved `rg` path, so the (potentially slow)
 * download runs once even when parallel tool calls race.
 */
let ripgrepPathPromise: Promise<string> | undefined;

let resolvedRipgrepPath: string | undefined;

function getRipgrepPath(notify?: (message: string) => void): Promise<string> {
	if (resolvedRipgrepPath) return Promise.resolve(resolvedRipgrepPath);
	if (!ripgrepPathPromise) {
		ripgrepPathPromise = resolveRipgrepBinary(notify)
			.then((resolved) => {
				resolvedRipgrepPath = resolved;
				return resolved;
			})
			.catch((err: unknown) => {
				// Do not cache failures — a later call may succeed (e.g. the user
				// installed rg, or the network came back).
				ripgrepPathPromise = undefined;
				throw err;
			});
	}
	return ripgrepPathPromise;
}

/** Forget the memoized path so the next call re-resolves (e.g. after ENOENT). */
function invalidateRipgrepPath(): void {
	resolvedRipgrepPath = undefined;
	ripgrepPathPromise = undefined;
}

// ============================================================================
// Ripgrep execution
// ============================================================================

function isEagainError(stderr: string): boolean {
	return (
		stderr.includes("os error 11") ||
		stderr.includes("Resource temporarily unavailable")
	);
}

interface RipgrepOutcome {
	lines: string[];
	stderr: string;
	/** Non-null when ripgrep could not complete cleanly (exit != 0/1 or spawn error). */
	error: string | null;
	/** True when the invocation was cut short by the timeout. */
	timedOut: boolean;
}

/**
 * Run a single ripgrep invocation, resolving with its outcome. Handles the
 * timeout (SIGTERM→SIGKILL on POSIX; default on Windows) and abort signal.
 * `singleThread` prepends `-j 1` (used for the EAGAIN retry).
 * `rgPath` comes from `getRipgrepPath()` — an absolute path when downloaded,
 * the bare `rg` command when found on PATH.
 */
function runRipgrepOnce(
	rgPath: string,
	args: string[],
	target: string,
	abortSignal: AbortSignal,
	timeoutMs: number,
	singleThread: boolean,
): Promise<RipgrepOutcome> {
	return new Promise<RipgrepOutcome>((resolvePromise) => {
		const threadArgs = singleThread ? ["-j", "1"] : [];
		const fullArgs = [...threadArgs, ...args, target];

		const child = spawn(rgPath, fullArgs, {
			signal: abortSignal,
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";
		let stdoutTruncated = false;
		let stderrTruncated = false;
		let settled = false;
		let killedByTimeout = false;
		let killTimeoutId: ReturnType<typeof setTimeout> | undefined;

		child.stdout?.on("data", (data: Buffer) => {
			if (!stdoutTruncated) {
				stdout += data.toString();
				if (stdout.length > MAX_BUFFER_SIZE) {
					stdout = stdout.slice(0, MAX_BUFFER_SIZE);
					stdoutTruncated = true;
				}
			}
		});
		child.stderr?.on("data", (data: Buffer) => {
			if (!stderrTruncated) {
				stderr += data.toString();
				if (stderr.length > MAX_BUFFER_SIZE) {
					stderr = stderr.slice(0, MAX_BUFFER_SIZE);
					stderrTruncated = true;
				}
			}
		});

		const timeoutId = setTimeout(() => {
			killedByTimeout = true;
			if (platform() === "win32") {
				child.kill();
			} else {
				child.kill("SIGTERM");
				killTimeoutId = setTimeout(() => child.kill("SIGKILL"), 5_000);
			}
		}, timeoutMs);

		const finish = (result: RipgrepOutcome) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			if (killTimeoutId) clearTimeout(killTimeoutId);
			resolvePromise(result);
		};

		child.on("close", (code) => {
			if (code === 0 || code === 1) {
				// 0 = matches found, 1 = no matches — both success.
				finish({
					lines: parseLines(stdout),
					stderr,
					error: null,
					timedOut: false,
				});
			} else {
				finish({
					lines: parseLines(stdout),
					stderr,
					error: `ripgrep exited with code ${code}`,
					timedOut: killedByTimeout,
				});
			}
		});

		child.on("error", (err: NodeJS.ErrnoException) => {
			finish({
				lines: parseLines(stdout),
				stderr,
				error: `${err.message}`,
				timedOut: false,
			});
		});
	});
}

function parseLines(stdout: string): string[] {
	return stdout
		.trim()
		.split("\n")
		.map((line) => line.replace(/\r$/, ""))
		.filter(Boolean);
}

/**
 * Run ripgrep with Claude Code's semantics: retry once on EAGAIN with
 * `-j 1`, treat exit 1 as "no matches", and throw a descriptive error when a
 * timeout yields zero results.
 *
 * The `rg` binary is resolved (and, when missing, downloaded) before the first
 * spawn. A spawn ENOENT — the resolved path vanished underneath us — drops the
 * memoized path and retries once so the next attempt re-resolves/downloads.
 */
async function ripGrep(
	args: string[],
	target: string,
	abortSignal: AbortSignal,
	notify?: (message: string) => void,
): Promise<string[]> {
	const timeoutMs = isWsl() ? 60_000 : 20_000;

	const run = async (
		rgPath: string,
		singleThread: boolean,
	): Promise<RipgrepOutcome> =>
		runRipgrepOnce(rgPath, args, target, abortSignal, timeoutMs, singleThread);

	let rgPath = await getRipgrepPath(notify);

	let result = await run(rgPath, false);

	// The memoized binary disappeared (uninstalled, bin dir cleaned). Re-resolve
	// once — this also re-downloads when there is no fallback on PATH.
	if (
		result.error !== null &&
		/ENOENT|not found/i.test(result.error) &&
		result.lines.length === 0
	) {
		invalidateRipgrepPath();
		rgPath = await getRipgrepPath(notify);
		result = await run(rgPath, false);
	}

	// EAGAIN (resource-constrained envs): retry once, single-threaded.
	if (result.error !== null && isEagainError(result.stderr)) {
		result = await run(rgPath, true);
	}

	if (result.error === null) return result.lines;

	// A timeout that produced no results is reported as an error so the caller
	// knows the search did not complete (rather than assuming no matches).
	if (result.timedOut && result.lines.length === 0) {
		const secs = Math.round(timeoutMs / 1000);
		throw new Error(
			`Ripgrep search timed out after ${secs} seconds. The search may have matched files but did not complete in time. Try searching a more specific path or pattern.`,
		);
	}

	throw new Error(result.error);
}

// ============================================================================
// Tool parameters
// ============================================================================

const GREP_SCHEMA = Type.Object({
	"-A": Type.Optional(
		Type.Number({
			description:
				'Number of lines to show after each match (rg -A). Requires output_mode: "content", ignored otherwise.',
		}),
	),
	"-B": Type.Optional(
		Type.Number({
			description:
				'Number of lines to show before each match (rg -B). Requires output_mode: "content", ignored otherwise.',
		}),
	),
	"-C": Type.Optional(
		Type.Number({
			description: "Alias for context.",
		}),
	),
	"-i": Type.Optional(
		Type.Boolean({
			description: "Case insensitive search (rg -i)",
		}),
	),
	"-n": Type.Optional(
		Type.Boolean({
			description:
				'Show line numbers in output (rg -n). Requires output_mode: "content", ignored otherwise. Defaults to true.',
		}),
	),
	"-o": Type.Optional(
		Type.Boolean({
			description:
				'Print only the matched (non-empty) parts of each matching line, one match per output line (rg -o / --only-matching). Requires output_mode: "content", ignored otherwise. Defaults to false.',
		}),
	),
	context: Type.Optional(
		Type.Number({
			description:
				'Number of lines to show before and after each match (rg -C). Requires output_mode: "content", ignored otherwise.',
		}),
	),
	glob: Type.Optional(
		Type.String({
			description:
				'Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}") - maps to rg --glob',
		}),
	),
	head_limit: Type.Optional(
		Type.Number({
			description:
				'Limit output to first N lines/entries, equivalent to "| head -N". Works across all output modes: content (limits output lines), files_with_matches (limits file paths), count (limits count entries). Defaults to 250 when unspecified. Pass 0 for unlimited (use sparingly — large result sets waste context).',
		}),
	),
	multiline: Type.Optional(
		Type.Boolean({
			description:
				"Enable multiline mode where . matches newlines and patterns can span lines (rg -U --multiline-dotall). Default: false.",
		}),
	),
	offset: Type.Optional(
		Type.Number({
			description:
				'Skip first N lines/entries before applying head_limit, equivalent to "| tail -n +N | head -N". Works across all output modes. Defaults to 0.',
		}),
	),
	output_mode: Type.Optional(
		Type.Union(
			[
				Type.Literal("content"),
				Type.Literal("files_with_matches"),
				Type.Literal("count"),
			],
			{
				description:
					'Output mode: "content" shows matching lines (supports -A/-B/-C context, -n line numbers, head_limit), "files_with_matches" shows file paths (supports head_limit), "count" shows match counts (supports head_limit). Defaults to "files_with_matches".',
			},
		),
	),
	path: Type.Optional(
		Type.String({
			description:
				"File or directory to search in (rg PATH). Defaults to current working directory.",
		}),
	),
	pattern: Type.String({
		description:
			"The regular expression pattern to search for in file contents",
	}),
	type: Type.Optional(
		Type.String({
			description:
				"File type to search (rg --type). Common types: js, py, rust, go, java, etc. More efficient than include for standard file types.",
		}),
	),
});

type GrepParams = {
	pattern: string;
	path?: string;
	glob?: string;
	output_mode?: OutputMode;
	"-B"?: number;
	"-A"?: number;
	"-C"?: number;
	context?: number;
	"-n"?: boolean;
	"-i"?: boolean;
	"-o"?: boolean;
	type?: string;
	head_limit?: number;
	offset?: number;
	multiline?: boolean;
};

// ============================================================================
// Result formatting helpers
// ============================================================================

function plural(n: number, word: string): string {
	return n === 1 ? word : `${word}s`;
}

function formatLimitInfo(
	appliedLimit: number | undefined,
	appliedOffset: number | undefined,
): string {
	const parts: string[] = [];
	if (appliedLimit !== undefined) parts.push(`limit: ${appliedLimit}`);
	if (appliedOffset) parts.push(`offset: ${appliedOffset}`);
	return parts.join(", ");
}

/**
 * Port of GrepTool.ts `applyHeadLimit`. Explicit `0` = unlimited escape hatch;
 * otherwise `limit ?? 250`. `appliedLimit` is set only when truncation
 * actually occurred (so the model knows to paginate with offset).
 */
function applyHeadLimit<T>(
	items: T[],
	limit: number | undefined,
	offset = 0,
): { items: T[]; appliedLimit: number | undefined } {
	if (limit === 0) {
		return { items: items.slice(offset), appliedLimit: undefined };
	}
	const effectiveLimit = limit ?? DEFAULT_HEAD_LIMIT;
	const sliced = items.slice(offset, offset + effectiveLimit);
	const wasTruncated = items.length - offset > effectiveLimit;
	return {
		items: sliced,
		appliedLimit: wasTruncated ? effectiveLimit : undefined,
	};
}

// ============================================================================
// Ripgrep arg construction
// ============================================================================

/**
 * Port of GrepTool.ts glob-fragment parser: split on whitespace, keep braced
 * patterns whole, else split on commas.
 */
function parseGlobFragments(glob: string): string[] {
	const globPatterns: string[] = [];
	const rawPatterns = glob.split(/\s+/);
	for (const rawPattern of rawPatterns) {
		if (rawPattern.includes("{") && rawPattern.includes("}")) {
			globPatterns.push(rawPattern);
		} else {
			globPatterns.push(...rawPattern.split(",").filter(Boolean));
		}
	}
	return globPatterns.filter(Boolean);
}

function buildRipgrepArgs(params: GrepParams): string[] {
	const output_mode = params.output_mode ?? "files_with_matches";
	const context_before = params["-B"];
	const context_after = params["-A"];
	const context_c = params["-C"];
	const show_line_numbers = params["-n"] ?? true;
	const case_insensitive = params["-i"] ?? false;
	const only_matching = params["-o"] ?? false;
	const multiline = params.multiline ?? false;

	const args: string[] = ["--hidden"];

	// Exclude VCS directories to avoid noise from version control metadata.
	for (const dir of VCS_DIRECTORIES_TO_EXCLUDE) {
		args.push("--glob", `!${dir}`);
	}

	// Limit line length to prevent base64/minified content from cluttering output.
	args.push("--max-columns", "500");

	// Only apply multiline flags when explicitly requested.
	if (multiline) {
		args.push("-U", "--multiline-dotall");
	}

	// Optional flags.
	if (case_insensitive) {
		args.push("-i");
	}

	// `-o` / only-matching (extension; content mode only).
	if (only_matching && output_mode === "content") {
		args.push("-o");
	}

	// Output mode flags.
	if (output_mode === "files_with_matches") {
		args.push("-l");
	} else if (output_mode === "count") {
		args.push("-c");
	}

	// Line numbers if requested.
	if (show_line_numbers && output_mode === "content") {
		args.push("-n");
	}

	// Context flags (-C/context takes precedence over -B/-A).
	if (output_mode === "content") {
		if (params.context !== undefined) {
			args.push("-C", params.context.toString());
		} else if (context_c !== undefined) {
			args.push("-C", context_c.toString());
		} else {
			if (context_before !== undefined) {
				args.push("-B", context_before.toString());
			}
			if (context_after !== undefined) {
				args.push("-A", context_after.toString());
			}
		}
	}

	// Pattern (use -e if it starts with a dash so rg does not parse it as a flag).
	if (params.pattern.startsWith("-")) {
		args.push("-e", params.pattern);
	} else {
		args.push(params.pattern);
	}

	// Type filter.
	if (params.type) {
		args.push("--type", params.type);
	}

	// Glob filter (fragment parser).
	if (params.glob) {
		for (const globPattern of parseGlobFragments(params.glob)) {
			args.push("--glob", globPattern);
		}
	}

	return args;
}

// ============================================================================
// Per-mode result builders
// ============================================================================

async function filesWithMatches(
	results: string[],
	searchDir: string,
	cwd: string,
	head_limit: number | undefined,
	offset: number,
): Promise<string> {
	// rg emits paths relative to searchDir; convert to absolute so `stat`
	// and relativization work regardless of target form.
	const absolute = results.map((p) => resolveRgPath(p, searchDir));
	// Stat each path for mtime; a single ENOENT must not reject the batch.
	const stats = await Promise.allSettled(absolute.map((p) => stat(p)));
	const sorted = absolute
		.map((p, i) => {
			const r = stats[i];
			const mtime = r && r.status === "fulfilled" ? (r.value.mtimeMs ?? 0) : 0;
			return [p, mtime] as const;
		})
		.sort((a, b) => {
			const timeComparison = b[1] - a[1];
			if (timeComparison === 0) return a[0].localeCompare(b[0]);
			return timeComparison;
		})
		.map((x) => x[0]);

	const { items, appliedLimit } = applyHeadLimit(sorted, head_limit, offset);
	const relativeMatches = items.map((p) => toRelativePath(p, cwd));

	// head_limit/offset were already applied above, so show exactly what is in
	// hand — and carry `limit: N` on the summary line (GrepTool's
	// mapToolResultToToolResultBlockParam), not as a trailing footer.
	const limitInfo = formatLimitInfo(
		appliedLimit,
		offset > 0 ? offset : undefined,
	);
	if (relativeMatches.length === 0) {
		return "No files found";
	}
	return `Found ${relativeMatches.length} ${plural(relativeMatches.length, "file")}${limitInfo ? ` ${limitInfo}` : ""}\n${relativeMatches.join("\n")}`;
}

/**
 * Split a ripgrep content-mode output line (`path:line:content` for matches
 * or `path-line-content` for context) into the file path and the remainder.
 *
 * Content can itself contain `:N:` / `-N-` sequences (timestamps, dashed
 * numbers), so a single "last colon" or "first boundary" split is unsafe.
 * Instead, enumerate every candidate `[:\-]<digits>[:\-]` boundary and use
 * the earliest one whose path resolves to an existing file. Returns
 * `undefined` when no candidate resolves (e.g. bare `line:content` output
 * from a single-file search, `-o` output, or a deleted file), letting the
 * caller pass the line through untouched.
 */
function parseContentLinePath(
	line: string,
	searchDir: string,
	cwd: string,
): { path: string; rest: string } | undefined {
	const re = /[-:](\d+)([-:])/g;
	let match = re.exec(line);
	while (match !== null) {
		if (match.index > 0) {
			const rawPath = line.substring(0, match.index);
			const resolved = resolveRgPath(rawPath, searchDir);
			if (fileExists(resolved)) {
				return {
					path: toRelativePath(resolved, cwd),
					rest: line.substring(match.index),
				};
			}
		}
		match = re.exec(line);
	}
	return undefined;
}

/** `existsSync` that never throws (odd path characters on some platforms). */
function fileExists(p: string): boolean {
	try {
		return existsSync(p);
	} catch {
		return false;
	}
}

/**
 * Content mode: one output line per ripgrep line, with the path relativized in
 * place — `relpath:num:content` for a match, `relpath-num-content` for a
 * context line (`-A`/`-B`/`-C`). This mirrors `GrepTool.call`, which does
 * `toRelativePath(filePath) + rest` per line and leaves everything else
 * (ripgrep's `--` group separators, path-less lines from a single-file target)
 * untouched.
 *
 * The path boundary is located with `parseContentLinePath` (which checks that
 * the candidate path exists) instead of `line.indexOf(':')`, so a Windows drive
 * letter or a `:N:` inside the content cannot be mistaken for the boundary.
 */
function contentMode(
	results: string[],
	searchDir: string,
	cwd: string,
	head_limit: number | undefined,
	offset: number,
	onlyMatching: boolean,
): string {
	const { items, appliedLimit } = applyHeadLimit(results, head_limit, offset);

	const finalLines = items.map((line) => {
		// With -o, rg emits bare matches (no `path:` prefix) — keep as-is.
		if (onlyMatching) return line;
		const parsed = parseContentLinePath(line, searchDir, cwd);
		// `rest` starts at the `:`/`-` delimiter, so path + rest rebuilds the
		// ripgrep line with only the path rewritten.
		return parsed ? parsed.path + parsed.rest : line;
	});

	const resultContent = finalLines.join("\n") || "No matches found";
	// Nothing to paginate when the offset skipped past all results.
	if (items.length === 0) return resultContent;
	const limitInfo = formatLimitInfo(
		appliedLimit,
		offset > 0 ? offset : undefined,
	);
	return limitInfo
		? `${resultContent}\n\n[Showing results with pagination = ${limitInfo}]`
		: resultContent;
}

function countMode(
	results: string[],
	searchDir: string,
	cwd: string,
	head_limit: number | undefined,
	offset: number,
): string {
	const { items, appliedLimit } = applyHeadLimit(results, head_limit, offset);

	const finalCountLines = items.map((line) => {
		const colonIndex = line.lastIndexOf(":");
		if (colonIndex > 0) {
			const filePath = line.substring(0, colonIndex);
			const count = line.substring(colonIndex);
			return toRelativePath(resolveRgPath(filePath, searchDir), cwd) + count;
		}
		return line;
	});

	let totalMatches = 0;
	let fileCount = 0;
	for (const line of finalCountLines) {
		const colonIndex = line.lastIndexOf(":");
		if (colonIndex > 0) {
			const count = parseInt(line.substring(colonIndex + 1), 10);
			if (!Number.isNaN(count)) {
				totalMatches += count;
				fileCount += 1;
			}
		}
	}

	const limitInfo = formatLimitInfo(
		appliedLimit,
		offset > 0 ? offset : undefined,
	);
	const rawContent = finalCountLines.join("\n") || "No matches found";
	// The summary is always present in count mode (Claude Code appends it even
	// for zero matches: "Found 0 total occurrences across 0 files.").
	const summary = `\n\nFound ${totalMatches} total ${plural(totalMatches, "occurrence")} across ${fileCount} ${plural(fileCount, "file")}.${
		limitInfo ? ` with pagination = ${limitInfo}` : ""
	}`;
	return rawContent + summary;
}

// ============================================================================
// Result rendering helpers
// ============================================================================

/**
 * Dim the ripgrep line-number column of a content-mode body so the numbers
 * recede behind the match text — mirroring how picc-write renders its line
 * numbers (`dim` on the gutter, default color on the content).
 *
 * ripgrep emits `path:line:content` / `path-line-content` for a match/context
 * line, and the path-less `line:content` / `line-content` for a single-file
 * target — so the line number is the first `(\d+)` run followed by `:` or `-`.
 * Paths can themselves contain digits (`v2-a.ts`), which would make the first
 * such run ambiguous, so the number is dimmed only when no digit precedes it on
 * the line: a path with digits loses its gutter dim rather than risk dimming a
 * span inside the path.
 *
 * Only called when the output actually has a line-number column (`-n`, the
 * default), so content digits are never candidates.
 */
function dimLineNumbers(
	body: string,
	theme: { fg: (c: "dim", t: string) => string },
): string {
	return body
		.split("\n")
		.map((line) =>
			line.replace(
				/^([^\d]*)(\d+)([-:].*)$/,
				(_m, prefix: string, num: string, rest: string) =>
					`${prefix}${theme.fg("dim", num)}${rest}`,
			),
		)
		.join("\n");
}

// ============================================================================
// Tool execution
// ============================================================================

async function executeGrep(
	params: GrepParams,
	cwd: string,
	signal: AbortSignal | undefined,
	notify?: (message: string) => void,
): Promise<string> {
	const abort = signal ?? new AbortController().signal;
	const output_mode = params.output_mode ?? "files_with_matches";
	const offset = params.offset ?? 0;
	const onlyMatching = params["-o"] ?? false;

	// Resolve search directory (port of GrepTool.getPath).
	const dir = params.path ? expandPath(params.path, cwd) : cwd;
	// Validate the provided path exists (port of GrepTool.validateInput).
	// UNC paths are skipped to avoid NTLM credential leaks.
	if (params.path) {
		if (dir.startsWith("\\\\") || dir.startsWith("//")) {
			// UNC — skip filesystem check.
		} else {
			let exists = false;
			try {
				statSync(dir);
				exists = true;
			} catch {
				exists = false;
			}
			if (!exists) {
				// Port of GrepTool.validateInput's ENOENT message, which is
				// `Path does not exist: <path>. ${FILE_NOT_FOUND_CWD_NOTE} <cwd>.`
				// plus a `Did you mean …?` hint when the same relative path
				// exists directly under cwd.
				let message = `Path does not exist: ${params.path}. Note: your current working directory is ${cwd}.`;
				const suggestion = await suggestPathUnderCwd(dir, cwd);
				if (suggestion) message += ` Did you mean ${suggestion}?`;
				throw new Error(message);
			}
		}
	}

	const args = buildRipgrepArgs(params);
	const raw = await ripGrep(args, dir, abort, notify);

	switch (output_mode) {
		case "content":
			return contentMode(
				raw,
				dir,
				cwd,
				params.head_limit,
				offset,
				onlyMatching,
			);
		case "count":
			return countMode(raw, dir, cwd, params.head_limit, offset);
		default:
			// files_with_matches (default)
			return await filesWithMatches(raw, dir, cwd, params.head_limit, offset);
	}
}

// ============================================================================
// Extension entry point
// ============================================================================

export default function (pi: ExtensionAPI): void {
	const toolName = loadToolName();

	pi.registerTool({
		name: toolName,
		label: toolName,
		description: DESCRIPTION,
		promptSnippet: "Search file contents with regex (ripgrep)",
		parameters: GREP_SCHEMA,
		// Inherit the framework's colored result shell (pending/success/error
		// background) rather than self-framing.
		renderShell: "default",
		async execute(
			_toolCallId,
			params,
			signal,
			onUpdate,
			ctx: ExtensionContext,
		) {
			// Surface the one-time ripgrep download instead of appearing hung: the
			// message goes to the footer status line and as a partial result.
			const notify = (message: string) => {
				onUpdate?.({
					content: [{ type: "text", text: message }],
					details: { notice: message },
				});
				ctx.ui.setStatus("picc-grep", message);
			};
			try {
				const text = await executeGrep(
					params as GrepParams,
					ctx.cwd,
					signal,
					notify,
				);
				return {
					content: [{ type: "text", text }],
					details: {
						pattern: params.pattern,
						path: params.path ?? undefined,
						output_mode: params.output_mode ?? "files_with_matches",
						only_matching: params["-o"] ?? false,
						line_numbers: params["-n"] ?? true,
					},
				};
			} catch (err) {
				// pi's agent loop only flags a tool result as errored when execute()
				// rejects — a resolved `{ isError: true }` is dropped because
				// AgentToolResult has no such field. Throw so the failure is surfaced
				// as a real tool error (matching picc-edit). Keep the human-readable
				// prefix the model previously saw.
				const message = err instanceof Error ? err.message : String(err);
				throw new Error(`Grep search failed: ${message}`);
			} finally {
				ctx.ui.setStatus("picc-grep", undefined);
			}
		},
		renderResult(result, { isPartial }, theme, context) {
			const partialText = isPartial
				? result.content
						.filter(
							(c): c is { type: "text"; text: string } => c.type === "text",
						)
						.map((c) => c.text)
						.join("\n")
				: "";
			if (isPartial) {
				return new Text(
					theme.fg("warning", partialText || "Searching..."),
					0,
					0,
				);
			}
			const t =
				(context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const text = result.content
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			// A custom renderResult replaces the framework's default content display,
			// so we render the match/error text ourselves.
			if (context.isError) {
				t.setText(theme.fg("error", text || "Grep search failed"));
				return t;
			}
			// Content mode with line numbers: dim the ripgrep gutter numbers so the
			// match text stands out (mirrors picc-write's dimmed line numbers).
			// Skipped for `-o` (bare matches, no `path:line` shape) and for
			// `-n: false` (no gutter — digits in the content are not line numbers).
			const details = result.details as
				| {
						output_mode?: string;
						only_matching?: boolean;
						line_numbers?: boolean;
				  }
				| undefined;
			const dimNumbers =
				details?.output_mode === "content" &&
				details.only_matching !== true &&
				details.line_numbers !== false &&
				text !== "No matches found";
			// Faithful to Claude Code / pi built-ins: the result body uses the
			// neutral tool-output color; only the pagination footer is highlighted.
			const footerPrefix = "[Showing results with pagination = ";
			const footerIndex = text.lastIndexOf(footerPrefix);
			// Split off the footer before dimming: dimLineNumbers injects ANSI
			// escapes, so it must run on a stable string, not one we index into.
			const rawBody =
				footerIndex !== -1 && text.endsWith("]")
					? text.slice(0, footerIndex)
					: text;
			const footer =
				footerIndex !== -1 && text.endsWith("]") ? text.slice(footerIndex) : "";
			const dimmedBody = dimNumbers ? dimLineNumbers(rawBody, theme) : rawBody;
			if (footer) {
				t.setText(
					`${theme.fg("toolOutput", dimmedBody)}\n${theme.fg("warning", footer)}`,
				);
				return t;
			}
			t.setText(theme.fg("toolOutput", dimmedBody));
			return t;
		},
	});
}
