// Style widoków MCP Apps: kolory panelu, fonty systemowe i tryb ciemny. Widok działa w ramce aplikacji AI
// bez dostępu do zasobów zewnętrznych, dlatego style nie odwołują się do plików ani adresów.

const LIGHT = [
  '--surface:#FFFFFF', '--ground:#F4F5F2', '--ink:#1A1D1B', '--muted:#5C625E', '--faint:#8A908B', '--rule:#DDE0DA', '--rule-soft:#ECEEE8',
  '--signal:#B4531A', '--signal-dark:#8E4014', '--on-signal:#FFFFFF', '--danger:#A3261F', '--danger-dark:#821D17', '--on-danger:#FFFFFF',
  '--ok-bg:#E4F1E8', '--ok-ink:#0E4A2E', '--wait-bg:#FAF0D6', '--wait-ink:#5E3F04', '--fail-bg:#F8E4E3', '--fail-ink:#741816',
].join(';');

// Tryb ciemny zachowuje ton panelu: grafitowe tło, jaśniejszy sygnał i przygaszone tła plakietek.
const DARK = [
  '--surface:#1D211F', '--ground:#161917', '--ink:#E8EAE6', '--muted:#A3A9A4', '--faint:#7D847F', '--rule:#353B37', '--rule-soft:#2A2F2C',
  '--signal:#E08A4F', '--signal-dark:#C46A2C', '--on-signal:#1A1D1B', '--danger:#E07A73', '--danger-dark:#C95D56', '--on-danger:#1A1D1B',
  '--ok-bg:#173726', '--ok-ink:#A8E0C0', '--wait-bg:#3A2F12', '--wait-ink:#F0D58A', '--fail-bg:#3E1A19', '--fail-ink:#F2B3B0',
].join(';');

const MONO = '"IBM Plex Mono",ui-monospace,Menlo,Consolas,monospace';

export const VIEW_STYLE = [
  `:root{${LIGHT};color-scheme:light}`,
  `:root[data-theme="dark"]{${DARK};color-scheme:dark}`,
  `@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){${DARK};color-scheme:dark}}`,
  // Jeden promień zaokrągleń i jedna wysokość pól oraz przycisków w całym widoku.
  ':root{--r:6px;--h:34px}',
  '*{box-sizing:border-box}',
  'html,body{margin:0;background:var(--surface);color:var(--ink)}',
  'body{font:14px/1.5 "IBM Plex Sans",system-ui,-apple-system,"Segoe UI",sans-serif}',
  '.head{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 14px;border-bottom:1px solid var(--rule)}',
  '.brand{font-size:12px;color:var(--muted)}.brand b{color:var(--ink);font-weight:600}.brand .dot{color:var(--signal)}',
  '.tools{display:flex;align-items:center;gap:8px}.live{font-size:11.5px;color:var(--ok-ink)}',
  '.body{padding:16px 20px 20px}',
  // Sekcje z pogrubionymi nazwami, oddzielone pojedynczą linią.
  '.sec{padding:20px 0;border-top:1px solid var(--rule)}.sec:first-child{padding-top:4px;border-top:0}.sec:last-child{padding-bottom:0}',
  '.sec h3{margin:0 0 12px;font-size:14px;font-weight:600;color:var(--ink)}',
  '.lead{margin:-6px 0 12px;font-size:12.5px;color:var(--muted)}',
  '.note{margin:8px 0 0;font-size:12.5px;color:var(--muted)}',
  '.say{margin:0;font-size:14px}',
  '.muted{color:var(--muted)}',
  `.mono{font-family:${MONO};font-size:12.5px}`,
  '.sub-lbl{display:block;font-size:12.5px;color:var(--muted);margin:16px 0 6px}',
  // Pola i informacje w dwóch równych kolumnach, etykieta nad wartością.
  '.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px 24px}',
  '@media (max-width:560px){.fields{grid-template-columns:1fr}}',
  '.field{min-width:0}.field .lbl,.lbl-block{display:block;font-size:12.5px;color:var(--muted);margin-bottom:6px}',
  '.txt{font-size:14px;min-height:22px;overflow-wrap:anywhere}',
  // Pola mają obwódkę w kolorze akcji, jak okno treści SMS-a; pole wyłączone ma szarą obwódkę.
  '.sel,.inp{display:block;width:100%;height:var(--h);font:inherit;font-size:14px;border:1px solid var(--signal);border-radius:var(--r);padding:0 10px;background:var(--surface);color:var(--ink)}',
  '.sel{padding:0 6px;cursor:pointer}.sel:disabled,.inp:disabled{cursor:default;color:var(--muted);border-color:var(--rule)}',
  // Lista wyboru z własną strzałką w odstępie od prawej krawędzi, jednakową w każdej przeglądarce. Strzałka
  // powstaje z dwóch gradientów, ponieważ widok nie wczytuje obrazów.
  'select.sel{-webkit-appearance:none;appearance:none;padding:0 34px 0 10px;background-repeat:no-repeat;background-size:5px 5px;'
    + 'background-position:calc(100% - 18px) 50%,calc(100% - 13px) 50%;'
    + 'background-image:linear-gradient(45deg,transparent calc(50% - .75px),var(--muted) calc(50% - .75px),var(--muted) calc(50% + .75px),transparent calc(50% + .75px)),'
    + 'linear-gradient(-45deg,transparent calc(50% - .75px),var(--muted) calc(50% - .75px),var(--muted) calc(50% + .75px),transparent calc(50% + .75px))}',
  // Wybór pliku: przycisk i nazwa pliku wyśrodkowane w pionie w ramce o wysokości pól; pole systemowe jest ukryte.
  '.pick{position:relative;display:flex;align-items:center;gap:10px;height:var(--h);padding:0 4px;border:1px solid var(--signal);border-radius:var(--r);background:var(--surface);cursor:pointer;min-width:0}',
  '.pick input{position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;pointer-events:none}',
  '.pick .pick-btn{flex:none;display:inline-flex;align-items:center;height:26px;padding:0 10px}.pick:hover .pick-btn{background:var(--rule-soft)}',
  '.pick-name{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;color:var(--muted)}.pick-name.set{color:var(--ink)}',
  '.pick:has(input:focus-visible){outline:2px solid var(--signal);outline-offset:2px}',
  // Wartość obok pola wyboru stoi na wysokości tekstu w polu.
  '.align .field .txt{display:flex;align-items:center;min-height:var(--h)}',
  '.check{display:flex;align-items:center;gap:8px;width:fit-content;margin-top:16px;font-size:14px;cursor:pointer}',
  '.check input{width:16px;height:16px;margin:0;accent-color:var(--signal);cursor:pointer}',
  '.scroll{overflow-x:auto}.scroll td{white-space:nowrap;max-width:260px;overflow:hidden;text-overflow:ellipsis}',
  // Kolumna numeru w tabeli podglądu pliku: nagłówek w kolorze akcji.
  'th.ph{color:var(--signal-dark);border-bottom-color:var(--signal);box-shadow:inset 0 -1px 0 var(--signal)}',
  ':root[data-theme="dark"] th.ph{color:var(--signal)}',
  '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) th.ph{color:var(--signal)}}',
  'textarea.inp{height:auto;min-height:68px;padding:8px 10px;resize:vertical}',
  // Przełącznik: równe pola, ta sama wysokość co pola i przyciski.
  '.seg2{display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr);height:var(--h);border:1px solid var(--signal);border-radius:var(--r);overflow:hidden}',
  '.seg2.narrow{max-width:460px;margin-bottom:12px}',
  '.seg2 button{border:0;background:var(--surface);color:var(--muted);font:inherit;font-size:13px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;padding:0 8px}',
  '.seg2 button+button{border-left:1px solid var(--rule)}.seg2 button:hover{background:var(--rule-soft)}',
  '.seg2 button.on,.seg2 button.on:hover{background:var(--ink);color:var(--surface)}.seg2 button:disabled{cursor:default}',
  // Okno treści wysyłanego SMS-a: biała karta z obwódką w kolorze przycisku akcji.
  '.msg{background:var(--surface);border:1px solid var(--signal);border-radius:var(--r);padding:14px 16px}',
  '.msg-head{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;font-size:12.5px;color:var(--muted);margin-bottom:8px}',
  '.msg-head b{color:var(--ink);font-weight:600}',
  '.msg-text{font-size:15px;line-height:1.6;white-space:pre-wrap;overflow-wrap:break-word}',
  '.lnk{color:var(--signal-dark);text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:3px;overflow-wrap:anywhere}',
  ':root[data-theme="dark"] .lnk{color:var(--signal)}',
  '@media (prefers-color-scheme: dark){:root:not([data-theme="light"]) .lnk{color:var(--signal)}}',
  `.slot{background:var(--wait-bg);color:var(--wait-ink);border-radius:var(--r);padding:0 3px;font-family:${MONO};font-size:.9em}`,
  // Numery odbiorców po przecinku w zapisie panelu.
  '.nums{margin:0;font-size:14px;line-height:1.7;max-height:120px;overflow:auto;overflow-wrap:anywhere}',
  // Kafle podsumowania: cztery równe kolumny, w wąskiej ramce dwie.
  '.tiles{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}',
  '@media (max-width:560px){.tiles{grid-template-columns:repeat(2,minmax(0,1fr))}}',
  '.tile{border:1px solid var(--rule);border-radius:var(--r);padding:12px 14px;min-width:0}',
  '.tile .lbl{font-size:12.5px;color:var(--muted)}',
  '.tile .v{font-size:20px;font-weight:600;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.tile .s{font-size:12px;color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
  '.tile.ok{background:var(--ok-bg);border-color:var(--ok-bg)}.tile.ok .lbl,.tile.ok .v,.tile.ok .s{color:var(--ok-ink)}',
  // Przyciski: działanie główne w kolorze akcji, nieodwracalne w kolorze ostrzegawczym, pomocnicze z obwódką.
  // Najechanie zmienia tło, a działanie niedostępne ma szare tło bez koloru znaczenia.
  '.btn{border:1px solid var(--rule);background:var(--surface);color:var(--ink);height:30px;padding:0 12px;border-radius:var(--r);cursor:pointer;font:inherit;font-size:13px}',
  '.btn:hover{background:var(--rule-soft)}',
  '.btn-primary{background:var(--signal);border-color:var(--signal);color:var(--on-signal)}.btn-primary:hover{background:var(--signal-dark)}',
  '.btn-danger{background:var(--danger);border-color:var(--danger);color:var(--on-danger)}.btn-danger:hover{background:var(--danger-dark)}',
  '.btn:disabled,.btn:disabled:hover{background:var(--rule-soft);border-color:var(--rule);color:var(--faint);cursor:not-allowed}',
  '.btn:focus-visible,.sel:focus-visible,.inp:focus-visible,.seg2 button:focus-visible{outline:2px solid var(--signal);outline-offset:2px}',
  // Przyciski w rzędzie mają równą szerokość i razem wypełniają szerokość karty; w wąskiej ramce stoją jeden pod drugim.
  '.btns{display:grid;gap:12px;margin-top:12px}',
  '.btns.n1{grid-template-columns:1fr}.btns.n2{grid-template-columns:repeat(2,minmax(0,1fr))}.btns.n3{grid-template-columns:repeat(3,minmax(0,1fr))}',
  '@media (max-width:360px){.btns.n2,.btns.n3{grid-template-columns:1fr}}',
  '.btns .btn{height:auto;min-height:var(--h);padding:6px 12px;font-size:14px;line-height:1.25;min-width:0}',
  // Plakietki, komunikaty i potwierdzenie wysyłki.
  '.badges{display:flex;flex-wrap:wrap;gap:8px;margin:0}.badges+.badges{margin-top:8px}',
  '.badge{display:inline-block;font-size:13px;padding:3px 10px;border-radius:var(--r)}',
  '.b-ok{background:var(--ok-bg);color:var(--ok-ink)}.b-wait{background:var(--wait-bg);color:var(--wait-ink)}',
  '.b-fail{background:var(--fail-bg);color:var(--fail-ink)}.b-plain{background:var(--rule-soft);color:var(--muted)}',
  '.notice{margin:0;padding:8px 12px;border-radius:var(--r);font-size:13px}.sec .notice{margin-top:12px}',
  '.n-ok{background:var(--ok-bg);color:var(--ok-ink)}.n-wait{background:var(--wait-bg);color:var(--wait-ink)}',
  '.n-fail{background:var(--fail-bg);color:var(--fail-ink)}.n-plain{background:var(--rule-soft);color:var(--muted)}',
  '.foot{padding:0 20px 16px}',
  '.sent{margin:0;padding:10px 14px;background:var(--ok-bg);color:var(--ok-ink);border-radius:var(--r);font-size:14px}.sent .note{color:inherit}',
  // Przebieg doręczenia na osi czasu i panel ponownej wysyłki pod pozycją.
  '.timeline{list-style:none;margin:0;padding:0}',
  '.timeline li{position:relative;padding:0 0 14px 22px;font-size:13.5px}',
  '.timeline li::before{content:"";position:absolute;left:5px;top:6px;width:9px;height:9px;border-radius:50%;background:var(--ok-ink)}',
  '.timeline li::after{content:"";position:absolute;left:9px;top:16px;bottom:0;width:1px;background:var(--rule)}',
  '.timeline li:last-child::after{display:none}',
  '.timeline li.pending{color:var(--muted)}.timeline li.pending::before{background:var(--surface);border:1px solid var(--faint)}',
  '.timeline .t{color:var(--faint);font-size:12px;margin-left:6px}.timeline .note{margin:2px 0 0}',
  '.resend:not(:empty){border-top:1px solid var(--rule);margin-top:20px;padding-top:20px}',
  // Wykresy, pasek udziałów i tabele.
  '.chart{display:block;width:100%;height:auto}.chart rect{fill:var(--signal)}.chart-ok rect{fill:var(--ok-ink)}',
  '.chart text{fill:var(--faint);font-size:10.5px}.chart .val{fill:var(--muted)}.chart .axis{stroke:var(--rule)}',
  '.stack{display:block;width:100%;height:20px;margin:0 0 12px;border-radius:var(--r);background:var(--rule-soft);overflow:hidden}',
  '.t-ok{fill:var(--ok-ink)}.t-fail{fill:var(--fail-ink)}.t-wait{fill:var(--signal)}.t-plain{fill:var(--faint)}.t-rest{fill:var(--rule)}',
  'table{width:100%;border-collapse:collapse;font-size:13.5px}',
  'th{text-align:left;font-weight:600;color:var(--muted);font-size:12.5px;border-bottom:1px solid var(--rule);padding:6px 8px}',
  'td{border-bottom:1px solid var(--rule-soft);padding:8px;vertical-align:top;overflow-wrap:anywhere}tr:last-child td{border-bottom:0}',
  '.num{text-align:right;white-space:nowrap}.nw{white-space:nowrap}',
  // Lista odebranych SMS-ów: wiersz z numerem, godziną i stanem odpowiedzi, treść pod spodem, rozwinięcie po kliknięciu.
  '.inbox{border:1px solid var(--rule);border-radius:var(--r);overflow:hidden;margin-top:16px}',
  '.it+.it{border-top:1px solid var(--rule)}',
  '.it summary{list-style:none;cursor:pointer;padding:12px 16px}.it summary::-webkit-details-marker{display:none}',
  '.it summary:hover{background:var(--rule-soft)}.it[open] summary{background:var(--ground)}',
  '.it-top{display:flex;align-items:center;gap:12px;font-size:14px}.it-top b{font-weight:600}',
  '.it-tag{margin-left:auto}',
  '.it-top::after{content:"";width:8px;height:8px;border-right:1.5px solid var(--muted);border-bottom:1.5px solid var(--muted);transform:rotate(45deg);margin:-4px 2px 0 4px}',
  '.it[open] .it-top::after{transform:rotate(225deg);margin-top:4px}',
  '.it-text{margin-top:4px;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.it[open] .it-text{white-space:normal;overflow-wrap:anywhere}',
  '.it-body{padding:4px 16px 16px;background:var(--ground)}.it-meta{margin:0 0 12px;font-size:12.5px;color:var(--muted)}',
  '.it-body textarea.inp{background:var(--surface)}',
].join('\n');
