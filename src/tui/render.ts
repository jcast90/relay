const ESC = "\x1b[";
const BOLD = `${ESC}1m`;
const DIM = `${ESC}2m`;
const RESET = `${ESC}0m`;
const CYAN = `${ESC}36m`;
const GREEN = `${ESC}32m`;
const YELLOW = `${ESC}33m`;
const RED = `${ESC}31m`;
const MAGENTA = `${ESC}35m`;
const BLUE = `${ESC}34m`;
const WHITE = `${ESC}37m`;
const BG_DARK = `${ESC}48;5;236m`;
const CLEAR_SCREEN = `${ESC}2J${ESC}H`;

export function clearScreen(): void {
  process.stdout.write(CLEAR_SCREEN);
}

export function hideCursor(): void {
  process.stdout.write(`${ESC}?25l`);
}

export function showCursor(): void {
  process.stdout.write(`${ESC}?25h`);
}

export function moveTo(row: number, col: number): void {
  process.stdout.write(`${ESC}${row};${col}H`);
}

export function getTerminalSize(): { rows: number; cols: number } {
  return {
    rows: process.stdout.rows ?? 24,
    cols: process.stdout.columns ?? 80
  };
}

export function bold(text: string): string {
  return `${BOLD}${text}${RESET}`;
}

export function dim(text: string): string {
  return `${DIM}${text}${RESET}`;
}

export function cyan(text: string): string {
  return `${CYAN}${text}${RESET}`;
}

export function green(text: string): string {
  return `${GREEN}${text}${RESET}`;
}

export function yellow(text: string): string {
  return `${YELLOW}${text}${RESET}`;
}

export function red(text: string): string {
  return `${RED}${text}${RESET}`;
}

export function magenta(text: string): string {
  return `${MAGENTA}${text}${RESET}`;
}

export function blue(text: string): string {
  return `${BLUE}${text}${RESET}`;
}

export function statusColor(status: string): string {
  switch (status) {
    case "completed":
    case "passed":
    case "active":
      return green(status);
    case "executing":
    case "verifying":
    case "running":
      return cyan(status);
    case "ready":
    case "pending":
    case "idle":
      return yellow(status);
    case "blocked":
    case "retry":
      return magenta(status);
    case "failed":
    case "failed_terminal":
    case "offline":
      return red(status);
    default:
      return dim(status);
  }
}

export function boxTop(width: number, title?: string): string {
  if (title) {
    const titleStr = ` ${title} `;
    const remaining = width - titleStr.length - 2;
    const left = Math.floor(remaining / 2);
    const right = remaining - left;
    return `${DIM}┌${"─".repeat(left)}${RESET}${BOLD}${titleStr}${RESET}${DIM}${"─".repeat(right)}┐${RESET}`;
  }

  return `${DIM}┌${"─".repeat(width - 2)}┐${RESET}`;
}

export function boxBottom(width: number): string {
  return `${DIM}└${"─".repeat(width - 2)}┘${RESET}`;
}

export function boxRow(content: string, width: number): string {
  const stripped = stripAnsi(content);
  const padding = Math.max(0, width - stripped.length - 4);
  return `${DIM}│${RESET} ${content}${" ".repeat(padding)} ${DIM}│${RESET}`;
}

export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + "…";
}

export function divider(width: number): string {
  return `${DIM}├${"─".repeat(width - 2)}┤${RESET}`;
}
