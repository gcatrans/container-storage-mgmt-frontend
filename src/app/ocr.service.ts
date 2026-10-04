import { computed, Injectable, signal } from '@angular/core';
import Ocr from '@gutenye/ocr-browser';
import * as ort from 'onnxruntime-web';

// 'server-fast' and 'server-accurate' both call the PaddleOCR API (container-storage-mgmt-api-ocr-python)
// with a different model profile; 'server-node' calls container-storage-mgmt-api-ocr-node, which
// runs the exact same ONNX models/decode pipeline as 'browser' (@gutenye/ocr-common) but on
// Node.js/onnxruntime-node instead of the browser's single-threaded WASM runtime. Field-extraction
// code that works around PaddleOCR-specific quirks must key off `isPaddleOcrEngine`, not off
// "server vs browser" - 'server-node' behaves like the browser engine, not like PaddleOCR.
export type OcrMode = 'browser' | 'server-fast' | 'server-accurate' | 'server-node';
export type OcrLine = { text: string; mean: number; box?: number[][] };

const OCR_MODE_STORAGE_KEY = 'ocr-mode';
const OCR_API_HOST_STORAGE_KEY = 'ocr-api-host';
const VALID_OCR_MODES: readonly OcrMode[] = ['browser', 'server-fast', 'server-accurate', 'server-node'];
// Temporary prototype default: the app is published on GitHub Pages (HTTPS) while the OCR APIs
// still run on this LAN-only dev machine. Remove once the APIs are reachable at a stable address.
const DEFAULT_API_HOST = '192.168.1.96';

type ServerEngine = { port: number; profile?: 'fast' | 'accurate' };

// Ports the OCR APIs listen on (see container-storage-mgmt-api-ocr-python and
// container-storage-mgmt-api-ocr-node). The host defaults to the page's own location (so this
// works whether the PWA is opened as localhost, a LAN IP, or a real hostname without needing a
// rebuild), but can be overridden by the user via `setApiHost` - e.g. a tablet that reaches the
// PWA over HTTPS (for camera access) while the OCR APIs run on a different dev machine on the
// local network. If an API is ever reverse-proxied under a different host/path than the PWA,
// adjust `serverDetectUrl` accordingly.
const SERVER_ENGINES: Record<Exclude<OcrMode, 'browser'>, ServerEngine> = {
  'server-fast': { port: 8000, profile: 'fast' },
  'server-accurate': { port: 8000, profile: 'accurate' },
  'server-node': { port: 8100 },
};

@Injectable({ providedIn: 'root' })
export class OcrService {
  readonly initializationError = signal<string | null>(null);
  readonly mode = signal<OcrMode>(loadStoredOcrMode());
  readonly apiHost = signal<string>(loadStoredApiHost());
  readonly isPaddleOcrEngine = computed(() => {
    const mode = this.mode();
    return mode === 'server-fast' || mode === 'server-accurate';
  });

  private ocr: Awaited<ReturnType<typeof Ocr.create>> | null = null;
  private initialization: Promise<void> | null = null;

  initialize(): Promise<void> {
    if (this.mode() !== 'browser') {
      // The local engine is only needed when the user can fall back to browser OCR.
      return Promise.resolve();
    }
    if (!this.initialization) {
      this.initialization = this.createOcr();
    }
    return this.initialization;
  }

  setMode(mode: OcrMode): void {
    this.mode.set(mode);
    try {
      localStorage.setItem(OCR_MODE_STORAGE_KEY, mode);
    } catch {
      // Ignore storage access failures (private browsing, disabled storage, ...).
    }
    if (mode === 'browser') {
      void this.initialize();
    }
  }

  // Accepts a bare hostname/IP ("192.168.1.42"), a "host:port" pair, or a full URL - only the
  // hostname is kept, since each server engine already has a fixed port (see SERVER_ENGINES).
  // An empty value reverts to the page's own hostname.
  setApiHost(host: string): void {
    const trimmed = host.trim();
    this.apiHost.set(trimmed);
    try {
      if (trimmed) {
        localStorage.setItem(OCR_API_HOST_STORAGE_KEY, trimmed);
      } else {
        localStorage.removeItem(OCR_API_HOST_STORAGE_KEY);
      }
    } catch {
      // Ignore storage access failures (private browsing, disabled storage, ...).
    }
  }

  async detect(url: string): Promise<OcrLine[]> {
    const mode = this.mode();
    if (mode !== 'browser') {
      return this.detectRemote(url, SERVER_ENGINES[mode]);
    }
    await this.initialize();
    if (!this.ocr) {
      throw new Error(this.initializationError() ?? 'Local OCR could not be initialized.');
    }
    return this.ocr.detect(url);
  }

  private async detectRemote(url: string, engine: ServerEngine): Promise<OcrLine[]> {
    const blob = await (await fetch(url)).blob();
    const form = new FormData();
    form.append('image', blob, 'crop.png');
    if (engine.profile) {
      form.append('profile', engine.profile);
    }

    let response: Response;
    try {
      response = await fetch(this.serverDetectUrl(engine.port), { method: 'POST', body: form });
    } catch (error: unknown) {
      throw new Error(`Unable to reach the server OCR endpoint: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      throw new Error(`Server OCR request failed (${response.status} ${response.statusText}).`);
    }

    const payload = (await response.json()) as { lines: OcrLine[] };
    return payload.lines;
  }

  private serverDetectUrl(port: number): string {
    return `${window.location.protocol}//${this.resolveApiHost()}:${port}/ocr/detect`;
  }

  private resolveApiHost(): string {
    const override = this.apiHost().trim();
    if (!override) {
      return window.location.hostname;
    }
    try {
      return new URL(override.includes('://') ? override : `http://${override}`).hostname;
    } catch {
      return override;
    }
  }

  private async createOcr(): Promise<void> {
    this.initializationError.set(null);
    ort.env.wasm.wasmPaths = new URL('ort/', document.baseURI).toString();
    // One worker avoids allocating multiple large WASM heaps on memory-constrained mobile devices.
    ort.env.wasm.numThreads = 1;

    try {
      this.ocr = await Ocr.create({
        models: {
          detectionPath: new URL('models/ch_PP-OCRv4_det_infer.onnx', document.baseURI).toString(),
          recognitionPath: new URL('models/ch_PP-OCRv4_rec_infer.onnx', document.baseURI).toString(),
          dictionaryPath: new URL('models/ppocr_keys_v1.txt', document.baseURI).toString(),
        },
      });
    } catch (error: unknown) {
      this.initializationError.set(error instanceof Error ? error.message : String(error));
    }
  }
}

function loadStoredOcrMode(): OcrMode {
  try {
    const stored = localStorage.getItem(OCR_MODE_STORAGE_KEY);
    return (VALID_OCR_MODES as readonly string[]).includes(stored ?? '') ? (stored as OcrMode) : 'browser';
  } catch {
    return 'browser';
  }
}

function loadStoredApiHost(): string {
  try {
    return localStorage.getItem(OCR_API_HOST_STORAGE_KEY) ?? DEFAULT_API_HOST;
  } catch {
    return DEFAULT_API_HOST;
  }
}
