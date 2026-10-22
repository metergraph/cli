// Presentation for human (non --json) output: a status headline, aligned
// fields and next steps. Color is used only when the stream is a terminal
// and NO_COLOR is unset (https://no-color.org); FORCE_COLOR turns it on.
// Symbols are plain Unicode and are printed with or without color.

const CODES = { bold: [1, 22], dim: [2, 22], red: [31, 39], green: [32, 39], yellow: [33, 39], cyan: [36, 39] };

function makeStyle(color, width = Infinity) {
  const style = { color, width };
  for (const [name, [open, close]] of Object.entries(CODES)) {
    style[name] = color ? (text) => `\u001b[${open}m${text}\u001b[${close}m` : (text) => String(text);
  }
  return style;
}

export const PLAIN = makeStyle(false);

// Prose wraps to the terminal width only on a terminal, so piped output keeps
// one line per message.
export function createStyle(stream, env = process.env) {
  const tty = Boolean(stream?.isTTY);
  const width = tty ? Math.min(Math.max(stream.columns || 80, 40), 100) - 2 : Infinity;
  if (env.NO_COLOR) return makeStyle(false, width);
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return makeStyle(true, width);
  return makeStyle(tty && env.TERM !== "dumb", width);
}

const TONES = {
  ok: ["✓", "green"],
  warn: ["!", "yellow"],
  fail: ["✗", "red"],
  info: ["•", "cyan"],
};

// ok for success; warn when the command stopped for a person to act;
// fail for everything else.
export function toneFor(outcome) {
  if (outcome === "ok") return "ok";
  if (outcome === "action_required" || outcome === "authentication_required") return "warn";
  return "fail";
}

export function headline(style, tone, title) {
  const [icon, color] = TONES[tone];
  const line = `${style[color](icon)} ${style.bold(title)}`;
  // Machine outcomes and numeric codes belong to JSON and the scripting reference.
  return line;
}

// How text output names a workspace: "Name (slug)", or the slug or name
// alone, from data the service verified. Never by its ID; null when neither
// is known, and the row is then left out.
export function workspaceShown(workspace) {
  if (!workspace) return null;
  const slug = workspace.slug ?? null;
  const name = workspace.name ?? null;
  if (slug !== null && name !== null) return `${name} (${slug})`;
  return slug ?? name;
}

// Aligned "label  value" rows. Rows whose value is null or undefined are left out.
export function fields(style, rows, indent = "  ") {
  const shown = rows.filter(([, value]) => value !== null && value !== undefined);
  const width = Math.max(0, ...shown.map(([label]) => label.length));
  return shown.flatMap(([label, value]) => {
    if (!Number.isFinite(style.width)) return [`${indent}${style.dim(label.padEnd(width))}  ${value}`];
    const prefix = `${indent}${label.padEnd(width)}  `;
    if (prefix.length > style.width / 2) {
      return [`${indent}${style.dim(label)}`, ...paragraph(style, value, indent + "  ")];
    }
    const wrapped = paragraph(style, value, " ".repeat(prefix.length));
    if (!wrapped.length) return [`${indent}${style.dim(label.padEnd(width))}  `];
    return [`${indent}${style.dim(label.padEnd(width))}  ${wrapped[0].trimStart()}`, ...wrapped.slice(1)];
  });
}

// Indents prose and wraps it to style.width.
export function paragraph(style, text, indent = "  ") {
  const width = style.width;
  const lines = [];
  let line = "";
  for (const word of String(text).split(/\s+/).filter(Boolean)) {
    if (line && indent.length + line.length + 1 + word.length > width) {
      lines.push(indent + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(indent + line);
  return lines;
}

// "→ label  value" rows for what to do next, aligned like fields.
export function steps(style, rows) {
  const shown = rows.filter(([, value]) => value !== null && value !== undefined);
  const width = Math.max(0, ...shown.map(([label]) => label.length));
  return shown.flatMap(([label, value]) => {
    if (label) {
      if (!Number.isFinite(style.width)) return [`${style.cyan("→")} ${label.padEnd(width)}  ${value}`];
      const prefix = `→ ${label.padEnd(width)}  `;
      if (prefix.length > style.width / 2) {
        return [`${style.cyan("→")} ${label}`, ...paragraph(style, value, "  ")];
      }
      const wrapped = paragraph(style, value, " ".repeat(prefix.length));
      return [`${style.cyan("→")} ${label.padEnd(width)}  ${wrapped[0]?.trimStart() ?? ""}`, ...wrapped.slice(1)];
    }
    // Unlabeled steps are prose: wrap them with a hanging indent.
    const [first, ...rest] = paragraph(style, value, "  ");
    return [`${style.cyan("→")} ${first.trimStart()}`, ...rest];
  });
}

export function section(style, title) {
  return style.bold(title);
}

export function render(lines) {
  // Collapse runs of blank lines and trim blank edges.
  const out = [];
  for (const line of lines) {
    if (line === "" && (out.length === 0 || out[out.length - 1] === "")) continue;
    out.push(line);
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  return `${out.join("\n")}\n`;
}
