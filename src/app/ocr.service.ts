import { Injectable, signal } from '@angular/core';
import Ocr from '@gutenye/ocr-browser';
import * as ort from 'onnxruntime-web';

export type OcrMode = 'browser' | 'server';
export type OcrLine = { text: string; mean: number; box?: number[][] };

const OCR_MODE_STORAGE_KEY = 'ocr-mode';
// Port the OCR API listens on (see container-storage-mgmt-ocr-api). The host is derived
// at call time from the page's own location, not hardcoded, so this works whether the PWA
// is opened as localhost, a LAN IP, or a real hostname (e.g. a tablet reaching a dev
// machine over the network) without needing a rebuild. If the API is ever reverse-proxied
// under a different host/path than the PWA, replace this function accordingly.
const OCR_SERVER_PORT = 8000;

function ocrServerUrl(): string {
  return `${window.location.protocol}//${window.location.hostname}:${OCR_SERVER_PORT}/ocr/detect`;
}

@Injectable({ providedIn: 'root' })
export class OcrService {
  readonly initializationError = signal<string | null>(null);
  readonly mode = signal<OcrMode>(loadStoredOcrMode());

  private ocr: Awaited<ReturnType<typeof Ocr.create>> | null = null;
  private initialization: Promise<void> | null = null;

  initialize(): Promise<void> {
    if (this.mode() === 'server') {
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

  async detect(url: string): Promise<OcrLine[]> {
    if (this.mode() === 'server') {
      return this.detectRemote(url);
    }
    await this.initialize();
    if (!this.ocr) {
      throw new Error(this.initializationError() ?? 'Local OCR could not be initialized.');
    }
    return this.ocr.detect(url);
  }

  private async detectRemote(url: string): Promise<OcrLine[]> {
    const blob = await (await fetch(url)).blob();
    const form = new FormData();
    form.append('image', blob, 'crop.png');

    let response: Response;
    try {
      response = await fetch(ocrServerUrl(), { method: 'POST', body: form });
    } catch (error: unknown) {
      throw new Error(`Unable to reach the server OCR endpoint: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      throw new Error(`Server OCR request failed (${response.status} ${response.statusText}).`);
    }

    const payload = (await response.json()) as { lines: OcrLine[] };
    return payload.lines;
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
    return localStorage.getItem(OCR_MODE_STORAGE_KEY) === 'server' ? 'server' : 'browser';
  } catch {
    return 'browser';
  }
}
