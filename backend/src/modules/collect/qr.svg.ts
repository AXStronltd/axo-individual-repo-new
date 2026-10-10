import QRCode from 'qrcode';

/**
 * Render an Axo payment string (axo://pay?…) as a scannable QR code, as SVG.
 * Medium error correction tolerates a scuffed print or a cracked screen; the
 * quiet-zone margin is what phone cameras need to lock on.
 */
export function qrSvg(text: string): Promise<string> {
  return QRCode.toString(text, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
}
