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
 * The `-o` (only-matching) parameter is a deliberate extension: it is present
 * in the local `Grep_schema.json` but not in Claude Code's live source. When set
 * (content mode only) it maps to `rg -o` / `--only-matching`.
 *
 * Omitted from the live source (no pi equivalent, same as picc-glob):
 *   - permission-based ignore patterns (`getFileReadIgnorePatterns`)
 *   - orphaned plugin-cache exclusions (`getGlobExclusionsForPluginCache`)
 *
 * Tool name configuration:
 *   - Default: `"grep"` (lowercase; Claude Code's actual name is `"Grep"`).
 *   - Set `config.json` `toolName` to `"Grep"` (default location
 *     `~/.pi/agent/extensions/picc-grep/config.json`), or set
 *     `PICC_GREP_TOOL_NAME=Grep`. Valid values: `"grep"`, `"Grep"`.
 *
 * Requires `rg` (ripgrep) on PATH.
 *
 * References:
 * - Claude Code Grep tool: tools/GrepTool/GrepTool.ts (+ prompt.ts, UI.tsx)
 * - Claude Code ripgrep: utils/ripgrep.ts
 * - Claude Code path helpers: utils/path.ts
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import type {
	ExtensionAPI,
	ExtensionContext,
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

/** Mirrors Claude Code `DEFAULT_HEAD_LIMIT` (GrepTool.ts). */
const DEFAULT_HEAD_LIMIT = 250;

/** Mirrors Claude Code `utils/ripgrep.ts` MAX_BUFFER_SIZE (20 MB). */
const MAX_BUFFER_SIZE = 20_000_000;

/** Mirrors Claude Code `VCS_DIRECTORIES_TO_EXCLUDE` (GrepTool.ts). */
const VCS_DIRECTORIES_TO_EXCLUDE = [
	".git",
	".svn",
	".hg",
	".bzr",
	".jj",
	".sl",
] as const;

/**
 * Tool description — verbatim from Claude Code `tools/GrepTool/prompt.ts`
 * (`Grep_description.md`).
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
// Path helpers (ports of claude-code utils/path.ts)
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
 * Port of claude-code `expandPath(path, baseDir)`. Handles `~`, POSIX-style
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
 * Port of claude-code `toRelativePath`: relativize against cwd, keeping the
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

// ============================================================================
// Ripgrep execution (port of claude-code utils/ripgrep.ts, shared w/ picc-glob)
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
 */
function runRipgrepOnce(
	args: string[],
	target: string,
	abortSignal: AbortSignal,
	timeoutMs: number,
	singleThread: boolean,
): Promise<RipgrepOutcome> {
	return new Promise<RipgrepOutcome>((resolvePromise) => {
		const threadArgs = singleThread ? ["-j", "1"] : [];
		const fullArgs = [...threadArgs, ...args, target];

		const child = spawn("rg", fullArgs, {
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
 */
async function ripGrep(
	args: string[],
	target: string,
	abortSignal: AbortSignal,
): Promise<string[]> {
	const defaultTimeout = isWsl() ? 60_000 : 20_000;
	const parsedSeconds =
		parseInt(process.env.PI_GREP_TIMEOUT_SECONDS ?? "", 10) || 0;
	const timeoutMs = parsedSeconds > 0 ? parsedSeconds * 1000 : defaultTimeout;

	const run = async (singleThread: boolean): Promise<RipgrepOutcome> =>
		runRipgrepOnce(args, target, abortSignal, timeoutMs, singleThread);

	let result = await run(false);

	// EAGAIN (resource-constrained envs): retry once, single-threaded.
	if (result.error !== null && isEagainError(result.stderr)) {
		result = await run(true);
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
// Tool parameters (schema from Grep_schema.json, incl. the extra `-o`)
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
// Result formatting helpers (ports of GrepTool.ts)
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
// Ripgrep arg construction (faithful to GrepTool.ts call())
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

	const limitInfo = formatLimitInfo(
		appliedLimit,
		offset > 0 ? offset : undefined,
	);
	if (relativeMatches.length === 0) {
		return "No files found";
	}
	const pagination = limitInfo
		? `\n\n[Showing results with pagination = ${limitInfo}]`
		: "";
	return `Found ${relativeMatches.length} ${plural(relativeMatches.length, "file")}\n${relativeMatches.join("\n")}${pagination}`;
}

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
		const colonIndex = line.indexOf(":");
		if (colonIndex > 0) {
			const filePath = line.substring(0, colonIndex);
			const rest = line.substring(colonIndex);
			return toRelativePath(resolveRgPath(filePath, searchDir), cwd) + rest;
		}
		return line;
	});

	const resultContent = finalLines.join("\n") || "No matches found";
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
	const summary = `\n\nFound ${totalMatches} total ${plural(totalMatches, "occurrence")} across ${fileCount} ${plural(fileCount, "file")}.${
		limitInfo ? ` with pagination = ${limitInfo}` : ""
	}`;
	return rawContent + summary;
}

// ============================================================================
// Tool execution
// ============================================================================

async function executeGrep(
	params: GrepParams,
	cwd: string,
	signal: AbortSignal | undefined,
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
				throw new Error(`Directory does not exist: ${params.path}. ${cwd}.`);
			}
		}
	}

	const args = buildRipgrepArgs(params);
	const raw = await ripGrep(args, dir, abort);

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
			_onUpdate,
			ctx: ExtensionContext,
		) {
			try {
				const text = await executeGrep(params as GrepParams, ctx.cwd, signal);
				return {
					content: [{ type: "text", text }],
					details: {
						pattern: params.pattern,
						path: params.path ?? undefined,
						output_mode: params.output_mode ?? "files_with_matches",
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
			}
		},
		renderResult(result, { isPartial }, theme, context) {
			if (isPartial) {
				return new Text(theme.fg("warning", "Searching..."), 0, 0);
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
			// Faithful to Claude Code / pi built-ins: the result body uses the
			// neutral tool-output color; only the pagination footer is highlighted.
			const footerPrefix = "[Showing results with pagination = ";
			const footerIndex = text.lastIndexOf(footerPrefix);
			if (footerIndex !== -1 && text.endsWith("]")) {
				const body = text.slice(0, footerIndex);
				const footer = text.slice(footerIndex);
				t.setText(
					`${theme.fg("toolOutput", body)}\n${theme.fg("warning", footer)}`,
				);
				return t;
			}
			t.setText(theme.fg("toolOutput", text));
			return t;
		},
	});
}
