import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle, NotificationType } from '@capacitor/haptics';

export const isNative = () => Capacitor.isNativePlatform();

export function tap() {
  if (isNative()) Haptics.impact({ style: ImpactStyle.Light }).catch(() => {});
}
export function success() {
  if (isNative()) Haptics.notification({ type: NotificationType.Success }).catch(() => {});
}

// ── Android back button: stack of close handlers (sheets, overlays) ──
const backStack: (() => void)[] = [];
export function pushBack(fn: () => void) {
  backStack.push(fn);
  return () => {
    const i = backStack.lastIndexOf(fn);
    if (i >= 0) backStack.splice(i, 1);
  };
}
export function popBack(): boolean {
  const fn = backStack.pop();
  if (fn) {
    fn();
    return true;
  }
  return false;
}

// ── Scanner ──
export type ScanKind = 'qr' | 'product';

let webScanResolver: ((v: string | null) => void) | null = null;
let webScanListener: ((kind: ScanKind) => void) | null = null;
export function onWebScanRequest(fn: (kind: ScanKind) => void) {
  webScanListener = fn;
}
export function resolveWebScan(v: string | null) {
  webScanResolver?.(v);
  webScanResolver = null;
}

export async function scanCode(kind: ScanKind): Promise<string | null> {
  if (isNative()) {
    const { BarcodeScanner, BarcodeFormat } = await import('@capacitor-mlkit/barcode-scanning');
    try {
      const { available } = await BarcodeScanner.isGoogleBarcodeScannerModuleAvailable();
      if (!available) {
        await BarcodeScanner.installGoogleBarcodeScannerModule();
        // wait for module install (up to ~30s)
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = () => {
            if (!done) {
              done = true;
              resolve();
            }
          };
          BarcodeScanner.addListener('googleBarcodeScannerModuleInstallProgress', (e) => {
            if (e.state === 4 || e.state === 5 || (e.progress ?? 0) >= 100) finish();
          });
          setTimeout(finish, 30000);
        });
      }
      const formats =
        kind === 'qr'
          ? [BarcodeFormat.QrCode, BarcodeFormat.DataMatrix, BarcodeFormat.Pdf417, BarcodeFormat.Aztec]
          : [BarcodeFormat.Ean13, BarcodeFormat.Ean8, BarcodeFormat.UpcA, BarcodeFormat.UpcE, BarcodeFormat.Code128, BarcodeFormat.QrCode];
      const { barcodes } = await BarcodeScanner.scan({ formats });
      const b = barcodes[0];
      return b ? b.rawValue || b.displayValue || null : null;
    } catch (e) {
      const msg = String((e as Error)?.message ?? e);
      if (/cancel/i.test(msg)) return null;
      throw e;
    }
  }
  // Web / dev: ask the UI to show a manual input sheet
  return new Promise((resolve) => {
    webScanResolver = resolve;
    if (webScanListener) webScanListener(kind);
    else resolve(window.prompt(kind === 'qr' ? 'Текст QR-кода' : 'Штрихкод') || null);
  });
}

// ── Export backup ──
export async function shareBackup(json: string) {
  const name = `bodytwin-backup-${new Date().toISOString().slice(0, 10)}.json`;
  if (isNative()) {
    const { Filesystem, Directory, Encoding } = await import('@capacitor/filesystem');
    const { Share } = await import('@capacitor/share');
    const res = await Filesystem.writeFile({ path: name, data: json, directory: Directory.Cache, encoding: Encoding.UTF8 });
    await Share.share({ title: 'Резервная копия Body Twin', url: res.uri, dialogTitle: 'Сохранить резервную копию' });
    return;
  }
  const blob = new Blob([json], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
