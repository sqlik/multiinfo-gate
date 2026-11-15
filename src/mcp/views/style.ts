// Style widoków MCP Apps: kolory panelu, fonty systemowe i tryb ciemny. Widok działa w ramce aplikacji AI
// bez dostępu do zasobów zewnętrznych, dlatego style nie odwołują się do plików ani adresów.

const LIGHT = [
  '--surface:#FFFFFF', '--ground:#F4F5F2', '--ink:#1A1D1B', '--muted:#5C625E', '--faint:#8A908B', '--rule:#DDE0DA', '--rule-soft:#ECEEE8',
  '--signal:#B4531A', '--signal-dark:#8E4014', '--on-signal:#FFFFFF',
  '--ok-bg:#E4F1E8', '--ok-ink:#0E4A2E', '--wait-bg:#FAF0D6', '--wait-ink:#5E3F04', '--fail-bg:#F8E4E3', '--fail-ink:#741816',
].join(';');

// Tryb ciemny zachowuje ton panelu: grafitowe tło, jaśniejszy sygnał i przygaszone tła plakietek.
const DARK = [
  '--surface:#1D211F', '--ground:#161917', '--ink:#E8EAE6', '--muted:#A3A9A4', '--faint:#7D847F', '--rule:#353B37', '--rule-soft:#2A2F2C',
  '--signal:#E08A4F', '--signal-dark:#C46A2C', '--on-signal:#1A1D1B',
  '--ok-bg:#173726', '--ok-ink:#A8E0C0', '--wait-bg:#3A2F12', '--wait-ink:#F0D58A', '--fail-bg:#3E1A19', '--fail-ink:#F2B3B0',
].join(';');

export const VIEW_STYLE = [
  `:root{${LIGHT};color-scheme:light}`,
  `:root[data-theme="dark"]{${DARK};color-scheme:dark}`,
  `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${DARK};color-scheme:dark}}`,
  '*{box-sizing:border-box}',
  'html,body{margin:0;background:var(--surface);color:var(--ink)}',
  'body{font:14px/1.5 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif}',
  '.head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 14px;border-bottom:1px solid var(--rule)}',
  '.brand{font-size:12px;color:var(--muted)}.brand b{color:var(--ink);font-weight:600}.brand .dot{color:var(--signal)}',
  '.tools{display:flex;gap:8px}',
  '.body{padding:14px}',
  '.who{margin:0 0 12px;color:var(--muted)}.who b{color:var(--ink);font-weight:600}',
  '.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}',
  '@media (max-width:560px){.grid{grid-template-columns:1fr}}',
  '.box{border:1px solid var(--rule);border-radius:3px;padding:10px 12px;min-width:0}',
  '.box h2{margin:0 0 8px;font-size:12px;font-weight:600;color:var(--muted)}',
  '.box p{margin:0 0 6px}',
  '.note{font-size:12px;color:var(--muted);margin:8px 0 0}',
  '.badges{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:6px}',
  '.badge{display:inline-block;font-size:12px;padding:1px 8px;border-radius:3px}',
  '.b-ok{background:var(--ok-bg);color:var(--ok-ink)}.b-wait{background:var(--wait-bg);color:var(--wait-ink)}',
  '.b-fail{background:var(--fail-bg);color:var(--fail-ink)}.b-plain{background:var(--rule-soft);color:var(--muted)}',
  '.list{list-style:none;margin:0;padding:0}.list li{padding:2px 0}',
  '.kv{display:grid;grid-template-columns:auto 1fr;gap:4px 12px;margin:0}.kv dt{color:var(--muted)}.kv dd{margin:0}',
  '.mono{font-family:"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace;font-size:12.5px}',
  '.muted{color:var(--muted)}',
  '.btn{border:1px solid var(--rule);background:var(--surface);color:var(--ink);padding:5px 12px;border-radius:3px;cursor:pointer;font:inherit;font-size:13px}',
  '.btn:hover{background:var(--rule-soft)}.btn:disabled{cursor:default;opacity:.6}',
  '.btn-primary{background:var(--signal);border-color:var(--signal);color:var(--on-signal)}.btn-primary:hover{background:var(--signal-dark)}',
  '.btn:focus-visible{outline:2px solid var(--signal);outline-offset:2px}',
  '.foot{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:0 14px 14px}',
  '.notice{margin:0;padding:6px 10px;border-radius:3px;font-size:13px}',
  '.n-ok{background:var(--ok-bg);color:var(--ok-ink)}.n-wait{background:var(--wait-bg);color:var(--wait-ink)}',
  '.n-fail{background:var(--fail-bg);color:var(--fail-ink)}.n-plain{background:var(--rule-soft);color:var(--muted)}',
].join('\n');
