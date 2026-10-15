// The static pages the loopback callback listener answers with. They follow
// the look of the server's consent page (green band with the Metergraph mark,
// white card) so the hand-off from the browser back to the terminal reads as
// one flow. Pages are fixed strings: nothing from a request is ever rendered.
// The stylesheet is inline and allowed by its hash, so the policy stays
// default-src 'none' with no script and no 'unsafe-inline'.
import { createHash } from "node:crypto";

const LOGO = `<svg class="logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 134 25" width="134" height="25" role="img" aria-label="Metergraph"><g fill="white" transform="scale(0.03681885)"><circle cx="105" cy="128" r="62"/><circle cx="105" cy="239" r="62"/><circle cx="105" cy="350" r="62"/><circle cx="105" cy="461" r="62"/><circle cx="105" cy="572" r="62"/><circle cx="578" cy="128" r="62"/><circle cx="578" cy="239" r="62"/><circle cx="578" cy="350" r="62"/><circle cx="578" cy="461" r="62"/><circle cx="578" cy="572" r="62"/><circle cx="221" cy="238" r="62"/><circle cx="282.5" cy="346" r="62"/><circle cx="341.5" cy="456" r="62"/><circle cx="400.5" cy="346" r="62"/><circle cx="462" cy="238" r="62"/></g><path d="M34.68 20V6H38.2L42.08 16.38L42.56 17.78C42.7 17.32 42.82 16.9 43.02 16.38L46.82 6H50.28V20H48.12V10.02L48.14 8.16L43.84 20H41.22L36.8 8.16L36.84 10.02V20H34.68ZM56.8091 20.32C53.9091 20.32 51.9691 18.48 51.9691 15.3C51.9691 12.1 53.9691 9.98 56.7091 9.98C59.6491 9.98 61.2891 12.02 61.2891 15.16V15.6H54.0891C54.1091 17.48 55.2491 18.7 56.8091 18.7C57.9291 18.7 58.9291 18.16 59.1291 16.92H61.2091C61.0091 18.76 59.4891 20.32 56.8091 20.32ZM59.1291 14.12C59.1091 12.6 58.2091 11.56 56.7091 11.56C55.2291 11.56 54.2291 12.68 54.1091 14.12H59.1291ZM66.6303 20.16C64.8703 20.16 63.6703 19.3 63.6703 17.14V11.98H61.6703V10.3H63.6703V6.94H65.7503V10.3H67.9503V11.98H65.7503V16.86C65.7503 17.94 66.2303 18.42 67.1903 18.42C67.4303 18.42 67.6503 18.4 67.9103 18.36V20.02C67.6103 20.1 67.1503 20.16 66.6303 20.16ZM73.4997 20.32C70.5997 20.32 68.6597 18.48 68.6597 15.3C68.6597 12.1 70.6597 9.98 73.3997 9.98C76.3397 9.98 77.9797 12.02 77.9797 15.16V15.6H70.7797C70.7997 17.48 71.9397 18.7 73.4997 18.7C74.6197 18.7 75.6197 18.16 75.8197 16.92H77.8997C77.6997 18.76 76.1797 20.32 73.4997 20.32ZM75.8197 14.12C75.7997 12.6 74.8997 11.56 73.3997 11.56C71.9197 11.56 70.9197 12.68 70.7997 14.12H75.8197ZM79.5581 20V10.3H81.6381V10.88L81.5981 11.98C82.0981 10.88 83.0581 9.98 84.5381 9.98C84.6981 9.98 84.8381 9.98 85.0181 10.02V12.04C84.8581 12.02 84.6781 11.98 84.3981 11.98C82.7181 11.98 81.6381 12.88 81.6381 15.02V20H79.5581ZM90.0131 24.44C87.3131 24.44 85.6531 22.96 85.6531 20.8H87.7531C87.7731 22.02 88.6131 22.82 90.0531 22.82C91.5931 22.82 92.6931 21.96 92.6931 20.2V19.08C92.6931 18.76 92.6931 18.46 92.7331 18.16C92.1931 19.08 91.0931 19.76 89.6331 19.76C87.0331 19.76 85.2531 17.92 85.2531 14.88C85.2531 11.88 87.2531 9.98 89.5931 9.98C91.2531 9.98 92.1931 10.74 92.7331 11.64C92.6931 11.36 92.6931 11.08 92.6931 10.78V10.3H94.7731V19.6C94.7731 22.86 92.9931 24.44 90.0131 24.44ZM90.1131 18.12C91.6931 18.12 92.8131 16.8 92.8131 14.88C92.8131 12.98 91.6931 11.62 90.1131 11.62C88.4931 11.62 87.3731 12.96 87.3731 14.88C87.3731 16.82 88.4931 18.12 90.1131 18.12ZM96.9128 20V10.3H98.9928V10.88L98.9528 11.98C99.4528 10.88 100.413 9.98 101.893 9.98C102.053 9.98 102.193 9.98 102.373 10.02V12.04C102.213 12.02 102.033 11.98 101.753 11.98C100.073 11.98 98.9928 12.88 98.9928 15.02V20H96.9128ZM105.929 20.32C104.169 20.32 102.589 19.2 102.589 17.34C102.589 15.3 104.189 14.48 106.089 14.22L107.829 13.96C108.589 13.86 108.849 13.58 108.849 13.04C108.849 12.18 108.169 11.56 107.089 11.56C105.769 11.56 105.029 12.28 104.969 13.38H102.849C102.949 11.5 104.469 9.98 106.949 9.98C109.629 9.98 110.909 11.48 110.909 13.96V20H108.969V19.56C108.969 19.26 108.969 19 109.009 18.68C108.509 19.66 107.489 20.32 105.929 20.32ZM106.389 18.76C107.809 18.76 108.889 17.76 108.889 16.28V15.04C108.729 15.22 108.369 15.36 107.789 15.46L106.689 15.68C105.549 15.9 104.729 16.34 104.729 17.28C104.729 18.22 105.469 18.76 106.389 18.76ZM112.92 24.12V10.3H115V10.86C115 11.12 114.98 11.36 114.96 11.66C115.54 10.7 116.66 9.98 118.14 9.98C120.82 9.98 122.5 12.14 122.5 15.16C122.5 18.28 120.64 20.32 118.08 20.32C116.56 20.32 115.58 19.64 114.96 18.66L115 19.52V24.12H112.92ZM117.64 18.7C119.28 18.7 120.36 17.24 120.36 15.14C120.36 13.08 119.32 11.62 117.64 11.62C116.04 11.62 114.9 12.98 114.9 15.14C114.9 17.26 116.02 18.7 117.64 18.7ZM124.058 20V6H126.138V10.76L126.098 11.64C126.618 10.7 127.658 9.98 129.078 9.98C131.258 9.98 132.578 11.44 132.578 13.88V20H130.498V14.16C130.498 12.54 129.838 11.62 128.478 11.62C127.058 11.62 126.138 12.8 126.138 14.24V20H124.058Z" fill="white"/></svg>`;

const STYLE = `
:root{color-scheme:light}
*{box-sizing:border-box}
body{margin:0;background:#edeee9;color:#151b17;font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.55}
.shell{max-width:600px;margin:0 auto;padding:28px 12px 48px}
.hero{background:linear-gradient(90deg,#0a6146,#0a5944 54%,#073d32);color:#fff;padding:26px 30px 34px}
.logo{display:block;width:150px;height:auto;margin:0 0 36px}
.eyebrow{margin:0 0 6px;color:#d7f68e;font-size:13px;font-weight:700;letter-spacing:.06em;text-transform:uppercase}
h1{margin:0;font-size:30px;font-weight:400;letter-spacing:-.6px;line-height:1.2}
.card{background:#fff;padding:30px}
p{margin:0 0 18px}
p:last-child{margin-bottom:0}
.note{color:#505b53;font-size:14px}
@media (max-width:520px){
.shell{padding:0 0 32px}
.hero{padding:22px 20px 28px}
.logo{margin-bottom:28px}
h1{font-size:25px}
.card{padding:22px 20px}
}
`;

export const PAGE_CSP = `default-src 'none'; style-src 'sha256-${createHash("sha256").update(STYLE).digest("base64")}'`;

const page = (title, lead, note) =>
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  `<title>${title} | Metergraph CLI</title><style>${STYLE}</style></head><body>` +
  `<div class="shell"><header class="hero">${LOGO}<p class="eyebrow">Metergraph CLI</p><h1>${title}</h1></header>` +
  `<main class="card"><p>${lead}</p><p class="note">${note}</p></main></div></body></html>\n`;

export const PAGES = {
  done: page(
    "Authorization received",
    "Return to the terminal. The command finishes signing in there and reports the result.",
    "You can close this tab.",
  ),
  failed: page(
    "Authorization did not complete",
    "Return to the terminal for details and the next step.",
    "You can close this tab.",
  ),
  invalid: page(
    "Request not accepted",
    "This page only accepts the browser hand-off for a command that is waiting in your terminal.",
    "If you started a sign-in, return to the terminal and try again.",
  ),
};
