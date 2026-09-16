import { Text } from "@earendil-works/pi-tui";
import type { TerminalClass } from "./session-surface.ts";

interface ToolTheme {
	fg(color: "toolTitle" | "muted" | "dim" | "success" | "warning" | "error", text: string): string;
	bold(text: string): string;
}

/** One compact call row: intent and structured target, never free-text payload. */
export function renderActCall(intent: string, target: string, theme: ToolTheme): Text {
	return new Text(`${theme.fg("toolTitle", theme.bold(intent))} ${theme.fg("muted", `· ${target}`)}`, 0, 0);
}

/** One terminal class with fixed wording; refusal never shares success styling. */
export function renderActTerminal(terminal: TerminalClass, theme: ToolTheme, expandedDetail?: string): Text {
	const face =
		terminal === "success"
			? theme.fg("success", "✓ success")
			: terminal === "refusal"
				? theme.fg("warning", "! refusal")
				: theme.fg("error", "✗ failure");
	const detail = expandedDetail === undefined ? "" : `\n${theme.fg("dim", expandedDetail)}`;
	return new Text(face + detail, 0, 0);
}

export function safeIssueNumber(value: unknown): string {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? ` #${value}` : "";
}
