// All terminal text arrives through the bounded pricing validator. HTML escapes
// every dynamic label; no scripts, remote fonts, analytics or external assets.
const ASSUMPTION_LABELS = {
  search_content_tokens_included: "Supplied input already contains billable search content (caller-supplied; not independently verified)",
  search_content_tokens_excluded_fixed_block: "Excluded mini search-content blocks are priced as 8,000 uncached input tokens per search (caller-supplied scenario; cache eligibility not independently verified)",
};
const money = (v) => (v === null ? "unknown" : Number(v).toLocaleString("en-US", { maximumFractionDigits: 8 }));
const escape = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
function movement(s) {
  const points = s.points;
  const now = points.at(-1),
    before = points.at(-2);
  if (
    !before ||
    Date.parse(before.effective_to) !== Date.parse(now.effective_from) ||
    before.input_per_mtok === null ||
    now.input_per_mtok === null ||
    Number(before.input_per_mtok) === 0
  )
    return "n/a";
  const delta = (Number(now.input_per_mtok) / Number(before.input_per_mtok) - 1) * 100;
  return `${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`;
}
function spark(points) {
  const nums = points.map((p) => (p.input_per_mtok === null ? null : Number(p.input_per_mtok)));
  const known = nums.filter((n) => n !== null);
  const min = Math.min(...known),
    max = Math.max(...known);
  return nums
    .map((n) => (n === null ? "?" : "▁▂▃▄▅▆▇█"[max === min ? 3 : Math.round(((n - min) / (max - min)) * 7)]))
    .join("");
}
function provenance(d) {
  if (d.api === "public" && ["calculate", "cost"].includes(d.action) && d.result?.fees?.length)
    return `Search fee catalog: ${[...new Set(d.result.fees.map(f => `${f.catalog_version} (${f.catalog_hash})`))].join(", ")}\nCatalog list rates, not your invoice.\n`;

  if (d.api === "public")
    return d.catalog
      ? `Catalog ${d.catalog.version} · verified ${d.catalog.pricing_verified_at} · discovery as of ${d.as_of}\n${d.action === "market" ? "Rates were obtained through separate lookups; public history is unavailable." : "Discovery lists supported dimensions, not numeric rates. Use pricing lookup."}\n`
      : "Public pricing result. The API does not report catalog version or verification time on this response.\nCatalog list rates, not your invoice.\n";
  return `Catalog ${d.catalog.version} · verified ${d.catalog.pricing_verified_at} · served ${d.catalog.served_at}\nCatalog list rates, not your invoice. Base rates exclude conditional rules; use pricing cost.\n`;
}
export function pricingText(e, format, style) {
  if (!e.ok) return `Pricing unavailable\n${e.error.message}\nReason: ${e.error.reason}\n`;
  const d = e.data,
    r = d.result;
  let lines = [
    style.bold(`METERGRAPH / PRICING ${d.action.toUpperCase()}`),
    d.request.at ? `As of ${d.request.at} UTC` : `Effective time: ${r.effective_at ?? d.as_of}`,
    "",
  ];
  if (d.action === "models") {
    lines.push(
      `Canonical models: ${r.total_models}; matching: ${r.matched}; showing: ${r.models.length}${r.truncated ? " (raise --limit for more)" : ""}`,
      `Formats: ${d.formats.join(", ")}`,
      "",
      "MODEL                                  PUBLISHER       CHANNELS",
    );
    for (const m of r.models)
      lines.push(
        `${m.model_id.padEnd(38)} ${m.publisher.padEnd(15)} ${[...new Set(m.prices.map((p) => p.channel))].join(", ")}`,
      );
    lines.push("", "Filters are applied locally to current discovery metadata. Numeric rates require pricing lookup.");
  } else if (d.action === "market" && d.api === "public") {
    lines.push("MODEL                                  STATUS    CCY      INPUT     OUTPUT");
    for (const item of r.items) {
      const p = item.price;
      lines.push(
        `${(item.model_id ?? item.requested_model).padEnd(38)} ${item.status.padEnd(9)} ${(item.currency ?? "---").padEnd(3)} ${money(p?.input_per_mtok ?? null).padStart(10)} ${money(p?.output_per_mtok ?? null).padStart(10)}`,
      );
      if (item.missing_dimensions.length) lines.push(`  Missing: ${item.missing_dimensions.join(", ")}`);
      if (p && d.request.region !== p.region)
        lines.push(`  Requested region: ${d.request.region} · resolved region: ${p.region} (fallback)`);
    }
    lines.push(
      "",
      `${d.request.channel} / ${d.request.region} · base rates per million tokens`,
      `Showing ${r.items.length} of ${r.matched} matching current models${r.truncated ? " · raise --limit for more" : ""}`,
      "Current discovery plus bounded lookups, not an atomic price snapshot. History, returns and sparklines are unavailable from the public API.",
    );
  } else if (d.action === "market") {
    lines.push("MODEL                                  CCY     INPUT     OUTPUT    LAST INPUT CHANGE   HISTORY");
    for (const s of r.series) {
      const p = s.points.at(-1);
      lines.push(
        `${s.model_id.padEnd(38)} ${s.currency} ${money(p.input_per_mtok).padStart(8)} ${money(p.output_per_mtok).padStart(10)} ${movement(s).padStart(12)}      ${spark(s.points)}`,
      );
    }
    lines.push(
      "",
      `${d.request.channel} / ${d.request.region} · rates per million tokens`,
      `Showing ${r.series.length} of ${r.matched} models${r.truncated ? " · raise --limit for more" : ""}`,
      "Change is between the last two contiguous catalog windows, not a 24h return. Sparklines show events, not elapsed time.",
    );
  } else if (d.action === "history") {
    const s = r.series[0];
    if (!s) lines.push("No catalog history for this exact model/channel/region.");
    else {
      lines.push(`${s.model_id} · ${s.channel} / ${s.region} · ${s.currency} per million tokens`);
      if (format === "chart") lines.push(...terminalChart(s, d.request.at));
      lines.push("", "EFFECTIVE FROM             INPUT       OUTPUT       UNTIL");
      for (const p of s.points)
        lines.push(
          `${p.effective_from.slice(0, 19)}   ${money(p.input_per_mtok).padStart(10)}   ${money(p.output_per_mtok).padStart(10)}   ${p.effective_to ?? "open"}`,
        );
      lines.push("", `Last input change: ${movement(s)} · effective windows; gaps mean unknown pricing.`);
    }
  } else {
    lines.push(
      `Status: ${r.status}${r.missing_dimensions.length ? ` · missing ${r.missing_dimensions.join(", ")}` : ""}`,
    );
    if (r.price)
      lines.push(
        `${r.model_id} · ${r.price.channel} / ${r.price.region}`,
        `Input ${money(r.price.input_per_mtok)} · Output ${money(r.price.output_per_mtok)} ${r.price.currency}/million tokens`,
        `Source: ${r.price.source_url}`,
        ...(d.request.region && d.request.region !== r.price.region
          ? [`Requested region: ${d.request.region} · resolved price region: ${r.price.region} (fallback)`]
          : []),
      );
    if (["cost", "calculate"].includes(d.action))
      lines.push(
        `Cost: ${r.cost ?? "unknown"} ${r.currency ?? ""}${r.status === "partial" ? " (known subtotal)" : ""}`,
        ...(r.components ? Object.entries(r.components).map(([k, v]) => `  ${k}: ${v}`) : []),
        ...(r.fees ? r.fees.map(f => `  Fee ${f.operation}: ${f.quantity} ${f.unit} at ${f.rate_per_1k}/1000 = ${f.cost} ${f.currency}; ${f.source_url}`) : []),
        ...(d.api === "public" && r.contract_version === 2 ? [`Assumptions: ${r.assumptions.length ? r.assumptions.map((assumption) => ASSUMPTION_LABELS[assumption]).join("; ") : "none"}`] : []),
        `Reasons: ${r.reasons?.join(", ") || (d.api === "public" ? "not reported" : "none")}`,
      );
  }
  return `${lines.join("\n")}\n\n${provenance(d)}`;
}
function domain(s, at) {
  const end = Date.parse(`${at}T00:00:00Z`);
  const start = Math.min(Date.parse(s.points[0].effective_from), end - 86400000);
  return {
    start,
    end,
    max: Math.max(
      0.00000001,
      ...s.points
        .flatMap((p) => [p.input_per_mtok, p.output_per_mtok])
        .filter((v) => v !== null)
        .map(Number),
    ),
  };
}
function terminalChart(s, at) {
  const { start, end, max } = domain(s, at);
  const grid = Array.from({ length: 9 }, () => Array(55).fill(" "));
  for (let x = 0; x < 55; x++) {
    const t = start + ((end - start) * x) / 54;
    const p = s.points.find(
      (p) => Date.parse(p.effective_from) <= t && (p.effective_to === null || Date.parse(p.effective_to) > t),
    );
    if (!p) continue;
    for (const [key, glyph] of [
      ["output_per_mtok", "o"],
      ["input_per_mtok", "i"],
    ]) {
      if (p[key] === null) continue;
      const y = 8 - Math.round((Number(p[key]) / max) * 8);
      grid[y][x] = grid[y][x] === " " ? glyph : "*";
    }
  }
  return [
    "",
    ...grid.map((row, i) => `${money((max * (8 - i)) / 8).padStart(10)} │${row.join("")}`),
    `           └${"─".repeat(55)}`,
    `            ${new Date(start).toISOString().slice(0, 10)}${" ".repeat(35)}${at}`,
    "            i input · o output · * overlap (linear UTC time)",
  ];
}
export function pricingHtml(d) {
  const s = d.result.series[0];
  if (!s)
    return "<!doctype html><meta charset=utf-8><title>Pricing history</title><p>No matching catalog history.</p>\n";
  const { start, end, max } = domain(s, d.request.at),
    x = (t) => 70 + ((Date.parse(t) - start) / (end - start)) * 850,
    y = (v) => 330 - (Number(v) / max) * 250;
  const paths = [];
  for (const [key, color] of [
    ["input_per_mtok", "#46e3bb"],
    ["output_per_mtok", "#aaa4ff"],
  ]) {
    for (const [index, p] of s.points.entries()) {
      if (p[key] === null) continue;
      const until = Math.min(end, p.effective_to ? Date.parse(p.effective_to) : end);
      if (until < Date.parse(p.effective_from)) continue;
      const next = s.points[index + 1];
      const join =
        next && Date.parse(p.effective_to) === Date.parse(next.effective_from) && next[key] !== null
          ? `V${y(next[key])}`
          : "";
      paths.push(
        `<path d="M${x(p.effective_from)},${y(p[key])}H${70 + ((until - start) / (end - start)) * 850}${join}" stroke="${color}" stroke-width="3" fill="none"/><circle cx="${x(p.effective_from)}" cy="${y(p[key])}" r="3" fill="${color}"><title>${escape(p.effective_from)}: ${money(p[key])}</title></circle>`,
      );
    }
  }
  const last = s.points.at(-1);
  const rows = s.points
    .map(
      (p) =>
        `<tr><td>${escape(p.effective_from)}</td><td>${escape(p.effective_to ?? "open")}</td><td>${money(p.input_per_mtok)}</td><td>${money(p.output_per_mtok)}</td><td><a href="${escape(p.source_url)}">Provider source</a></td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(s.model_id)} · Metergraph price history</title>
<style>body{margin:0;background:#10151e;color:#eef2f8;font:16px system-ui}main{max-width:1050px;margin:55px auto;padding:24px}header,section{border-bottom:1px solid #303847;padding:24px 0}small,p{color:#acb8ca}h1{font-size:40px;margin:14px 0}strong{font-size:32px}svg{width:100%;height:auto} .table-scroll{overflow-x:auto}table{width:100%;text-align:left;border-collapse:collapse}td,th{padding:12px;border-bottom:1px solid #303847}a{color:#46e3bb}.metrics{display:flex;gap:50px;flex-wrap:wrap}.input{color:#46e3bb}.output{color:#aaa4ff}</style>
<main><header><small>METERGRAPH / MODEL PRICE HISTORY · ${escape(d.request.at)} UTC</small><h1>${escape(s.model_id)}</h1><p>${escape(s.channel)} / ${escape(s.region)} · ${escape(s.currency)} per million tokens</p></header>
<section class="metrics"><div class="input">Last recorded input<br><strong>${money(last.input_per_mtok)}</strong></div><div class="output">Last recorded output<br><strong>${money(last.output_per_mtok)}</strong></div><div>Last input change<br><strong>${movement(s)}</strong></div></section>
<svg role="img" aria-labelledby="title desc" viewBox="0 0 1000 400"><title id="title">Effective-dated input and output base rates</title><desc id="desc">Horizontal segments cover known pricing windows. Gaps are unknown. Exact values and sources follow in the table.</desc><g fill="#acb8ca" font-family="system-ui" font-size="14"><text x="10" y="85">${money(max)}</text><text x="45" y="335">0</text><text x="70" y="370">${new Date(start).toISOString().slice(0, 10)}</text><text x="840" y="370">${escape(d.request.at)}</text></g><path d="M70 80V330H920" stroke="#435064" fill="none"/>${paths.join("")}</svg>
<p><span class="input">━ Input</span> &nbsp; <span class="output">━ Output</span> · Linear UTC time; effective windows, not daily observations. Gaps mean unknown.</p>
<div class="table-scroll"><table><caption>Catalog price windows and provider sources</caption><thead><tr><th>From (UTC)</th><th>Until (exclusive)</th><th>Input</th><th>Output</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table></div>
<p>${escape(provenance(d))}</p><footer>Explore your application's actual model costs with <a href="https://www.metergraph.dev/">Metergraph</a>. Free pricing queries require no account.</footer></main></html>\n`;
}
