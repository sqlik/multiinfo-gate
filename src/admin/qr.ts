import qrcode from 'qrcode-generator';

/** Kolory z arkusza panelu; kod graficzny musi zostać kontrastowy także po wydruku. */
const INK = '#1A1D1B';
const PAPER = '#FFFFFF';

/**
 * Kod graficzny jako SVG osadzone w dokumencie. Panel nie sięga do zewnętrznych
 * generatorów, bo sekret drugiego składnika nie może opuścić procesu bramki.
 */
export function qrSvg(text: string, opts: { size?: number; quiet?: number } = {}): string {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();

  const count = qr.getModuleCount();
  const quiet = opts.quiet ?? 4;
  const side = count + quiet * 2;
  const px = opts.size ?? 208;

  let path = '';
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (qr.isDark(row, col)) path += `M${col + quiet} ${row + quiet}h1v1h-1z`;
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" `
    + `viewBox="0 0 ${side} ${side}" shape-rendering="crispEdges" role="img" `
    + `aria-label="Kod do zeskanowania w aplikacji uwierzytelniającej">`
    + `<rect width="${side}" height="${side}" fill="${PAPER}"/>`
    + `<path d="${path}" fill="${INK}"/></svg>`;
}
