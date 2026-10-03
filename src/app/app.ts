import { Component, ElementRef, Injector, afterNextRender, computed, inject, signal, viewChild } from '@angular/core';
import { OcrMode, OcrService } from './ocr.service';

type CaptureMode = 'auto-crop' | 'manual-crop';
type FieldKey = 'maxWorkingPressureBar' | 'maxWorkingPressurePsi' | 'containerId' | 'isoCode' | 'approvalCode' | 'applicableRegulations' | 'tankCode' | 'kemlerCode' | 'unNumber' | 'mpgmKg' | 'mpgmLb' | 'tareKg' | 'tareLb' | 'payloadKg' | 'payloadLb' | 'capacityLiters' | 'capacityUsGallons' | 'capacityCubicMeters' | 'capacityCubicFeet';
type OcrLine = { text: string; mean: number; box?: number[][] };
type CropRect = { x: number; y: number; width: number; height: number };
type BoxBounds = { left: number; top: number; right: number; bottom: number };
type CropResizeHandle = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
type DecodedImage = { source: CanvasImageSource; width: number; height: number; release: () => void };
type RawScan = { label: string; lines: Array<{ text: string; confidence: number }>; durationMs: number; pixelCount: number };
type RemoteStatus = 'not-saved-remotely' | 'saved-remotely';
type SyncWarning = 'offline' | 'remote-unavailable' | null;
type StoredRecord = { id: string; savedAt: string; payload: unknown; thumbnail?: Blob; hasImage?: boolean; remoteStatus?: RemoteStatus; image?: Blob };
type StoredImage = { id: string; image: Blob };
type SavedRecord = StoredRecord & { thumbnailUrl: string | null };
const DEFAULT_CROP: CropRect = { x: 0, y: 0, width: 1, height: 1 };
const MAX_FULL_PHOTO_PIXELS = 4_000_000;
const MAX_AUTO_CROP_FALLBACK_PIXELS = 1_000_000;
const MAX_MANUAL_CROP_PIXELS = 4_000_000;
const MAX_MANUAL_RETRY_CROP_PIXELS = 4_000_000;
const MAX_CHECK_DIGIT_CROP_PIXELS = 1_000_000;
const OCR_PASS_TIMEOUT_MS = 180_000;
const CAMERA_ALIGNMENT_WARNING_DEGREES = 3;
const CAMERA_ALIGNMENT_SAMPLE_MS = 150;
const CAMERA_ROTATION_MIN_DEGREES = 0.5;
const CAMERA_ROTATION_MAX_DEGREES = 10;
const CROP_MEMORY_HEADROOM = 0.25;
const CROP_BYTES_PER_PIXEL = 16;
const THUMBNAIL_MAX_DIMENSION = 160;
const THUMBNAIL_JPEG_QUALITY = 0.8;
const REMOTE_API_URL = 'http://localhost:8080/api/saved-results';
const INITIAL_SYNC_RETRY_DELAY_MS = 10_000;
const MAX_SYNC_RETRY_DELAY_MS = 60_000;

function defaultCaptureMode(): CaptureMode {
  return 'auto-crop';
}

interface ContainerField {
  value: string;
  unit?: string;
  confidence?: number;
  inferred?: boolean;
}

interface Diagnostic {
  id: number;
  code: string;
  stage: string;
  message: string;
  technical?: string;
  context?: DiagnosticContext;
}

type DiagnosticContext = {
  imageName?: string;
  imageBytes?: number;
  imageType?: string;
  sourceWidth?: number;
  sourceHeight?: number;
  crop?: CropRect;
  canvasWidth?: number;
  canvasHeight?: number;
  pass?: string;
  pixelCount?: number;
  scale?: number;
};

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly fileInput = viewChild<ElementRef<HTMLInputElement>>('fileInput');
  protected readonly previewImage = viewChild<ElementRef<HTMLImageElement>>('previewImage');
  protected readonly videoPreview = viewChild<ElementRef<HTMLVideoElement>>('videoPreview');
  protected readonly sourceName = signal('');
  protected readonly previewUrl = signal<string | null>(null);
  protected readonly checkDigitPreviewUrl = signal<string | null>(null);
  protected readonly imageBlob = signal<Blob | null>(null);
  private readonly originalImageBlob = signal<Blob | null>(null);
  protected readonly cropRect = signal<CropRect | null>(null);
  protected readonly cropDraft = signal<CropRect>(DEFAULT_CROP);
  protected readonly applyingCrop = signal(false);
  protected readonly cropResizeHandles: CropResizeHandle[] = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  protected readonly captureMode = signal<CaptureMode>(defaultCaptureMode());
  protected readonly cameraOpen = signal(false);
  protected readonly cameraAlignmentAngle = signal<number | null>(null);
  protected readonly cameraAlignmentStatus = computed(() => {
    const angle = this.cameraAlignmentAngle();
    if (angle === null) return 'unknown';
    return Math.abs(angle) <= CAMERA_ALIGNMENT_WARNING_DEGREES ? 'aligned' : 'tilted';
  });
  protected readonly processing = signal(false);
  protected readonly analysisSuccessful = signal(false);
  protected readonly status = signal('Choose a container image to begin.');
  protected readonly diagnostics = signal<Diagnostic[]>([]);
  protected readonly rawText = signal<string[]>([]);
  protected readonly rawScans = signal<RawScan[]>([]);
  protected readonly rawScansCollapsed = signal(false);
  private readonly selectedOcrLines = signal<OcrLine[]>([]);
  protected readonly savedRecords = signal<SavedRecord[]>([]);
  protected readonly savedJson = signal<string | null>(null);
  protected readonly savedPhoto = signal<{ id: string; name: string; url: string } | null>(null);
  protected readonly syncWarning = signal<SyncWarning>(null);
  protected readonly savedResultsWarning = computed(() => this.hasPendingRemoteSync() ? this.syncWarning() : null);
  protected readonly fields = signal<Record<FieldKey, ContainerField>>({
    maxWorkingPressureBar: { value: '', unit: 'BAR' },
    maxWorkingPressurePsi: { value: '', unit: 'PSI' },
    containerId: { value: '' },
    isoCode: { value: '' },
    approvalCode: { value: '' },
    applicableRegulations: { value: '' },
    tankCode: { value: '' },
    kemlerCode: { value: '' },
    unNumber: { value: '' },
    mpgmKg: { value: '', unit: 'KG' },
    mpgmLb: { value: '', unit: 'LB' },
    tareKg: { value: '', unit: 'KG' },
    tareLb: { value: '', unit: 'LB' },
    payloadKg: { value: '', unit: 'KG' },
    payloadLb: { value: '', unit: 'LB' },
    capacityLiters: { value: '', unit: 'L' },
    capacityUsGallons: { value: '', unit: 'US GAL' },
    capacityCubicMeters: { value: '', unit: 'CU.M.' },
    capacityCubicFeet: { value: '', unit: 'CU.FT.' },
  });
  protected readonly containerIdValid = computed(() => this.validateContainerId(this.fields().containerId.value));
  protected readonly containerIdPartial = computed(() => /^[A-Z]{3}[UJZ]\d{6}$/.test(this.fields().containerId.value));
  protected readonly formattedContainerId = computed(() => this.formatContainerId(this.fields().containerId.value));
  protected readonly formattedContainerIdStem = computed(() => this.formatContainerId(this.fields().containerId.value.slice(0, 10)));
  protected readonly inferredContainerIdDigit = computed(() => this.fields().containerId.value.replace(/[^A-Z0-9]/gi, '').toUpperCase().slice(10, 11));
  protected readonly hasImage = computed(() => this.previewUrl() !== null);
  protected readonly detectedMarkings = computed(() => {
    const text = this.rawText().join('\n').toUpperCase();
    return {
      mpgm: /\bMPGM\b/.test(text),
      mgw: /\bMGW\b/.test(text),
      maxGr: /\bMAX\.?\s*GR\.?/.test(text),
      payload: /\bPAY(?:LOAD|J?LAD|JLOAD)(?=\s|\d|$)/.test(text),
      net: /\bNET(?:\s*WEIGHT)?\b/.test(text),
    };
  });
  protected readonly detectedWeightLabels = computed(() => {
    const markings = this.detectedMarkings();
    const text = this.rawText().join('\n').toUpperCase();
    const unTankGross = /\bUN\s*TANK\b/.test(text) && Boolean(this.fields().mpgmKg.value);
    return {
       gross: unTankGross || markings.maxGr ? 'MAX.GR.' : markings.mpgm ? 'MPGM' : markings.mgw ? 'MGW' : '',
      payload: markings.payload ? 'PAYLOAD' : markings.net || this.fields().payloadKg.value ? 'NET' : '',
    };
  });

  private stream: MediaStream | null = null;
  private cameraAlignmentTimer: ReturnType<typeof setInterval> | null = null;
  private cameraOrientationAngle: number | null = null;
  private readonly orientationHandler = (event: DeviceOrientationEvent) => {
    const roll = this.cameraRollFromOrientation(event);
    if (roll !== null) {
      this.cameraOrientationAngle = roll;
      if (this.cameraAlignmentAngle() === null) this.cameraAlignmentAngle.set(this.roundAngle(roll));
    }
  };
  private readonly injector = inject(Injector);
  protected readonly ocrService = inject(OcrService);
  private cropStart: { x: number; y: number } | null = null;
  private cropResize: { handle: CropResizeHandle; crop: CropRect } | null = null;
  private imageSelection = 0;
  private previewLoad: { selection: number; resolve: (image: HTMLImageElement) => void; reject: (reason: Error) => void } | null = null;
  private lastAutoCropPixelCount = 0;
  private lastCropPassPixelCount = 0;
  private nextDiagnosticId = 0;
  private syncingSavedRecords = false;
  private syncRetryTimer: ReturnType<typeof setTimeout> | null = null;
  private syncRetryDelayMs = INITIAL_SYNC_RETRY_DELAY_MS;
  private readonly onlineHandler = () => {
    this.syncWarning.set(null);
    this.cancelSyncRetry();
    void this.syncSavedRecords();
  };
  private readonly offlineHandler = () => {
    this.cancelSyncRetry();
    if (this.hasPendingRemoteSync()) this.syncWarning.set('offline');
  };

  protected openFilePicker(): void {
    this.clearFields();
    this.fileInput()?.nativeElement.click();
  }

  protected selectFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    const imageExtension = /\.(avif|bmp|gif|jpe?g|png|webp)$/i.test(file.name);
    if (!file.type.startsWith('image/') && !imageExtension) {
      this.addDiagnostic('File selection', 'Please select an image file.', `Received ${file.type || 'an unknown file type'}.`);
      input.value = '';
      return;
    }
    this.useImage(file, file.name);
    input.value = '';
  }

  protected startCrop(event: PointerEvent): void {
    if (this.processing() || this.applyingCrop()) return;
    const point = this.cropPoint(event);
    if (!point) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.cropStart = point;
    this.cropResize = null;
    this.cropDraft.set({ x: point.x, y: point.y, width: 0, height: 0 });
  }

  protected startCropResize(event: PointerEvent, handle: CropResizeHandle): void {
    if (this.processing() || this.applyingCrop()) return;
    const point = this.cropPoint(event);
    if (!point) return;
    event.preventDefault();
    event.stopPropagation();
    const canvas = (event.currentTarget as HTMLElement).closest('.crop-canvas');
    if (!canvas) return;
    canvas.setPointerCapture(event.pointerId);
    this.cropStart = null;
    this.cropResize = { handle, crop: this.cropDraft() };
  }

  protected updateCrop(event: PointerEvent): void {
    if (this.processing() || this.applyingCrop()) return;
    const point = this.cropPoint(event);
    if (!point) return;
    if (this.cropResize) {
      this.resizeCrop(this.cropResize.handle, this.cropResize.crop, point);
      return;
    }
    if (!this.cropStart) return;
    const x = Math.min(this.cropStart.x, point.x);
    const y = Math.min(this.cropStart.y, point.y);
    this.cropDraft.set({ x, y, width: Math.abs(point.x - this.cropStart.x), height: Math.abs(point.y - this.cropStart.y) });
  }

  protected finishCrop(event: PointerEvent): void {
    if (!this.cropStart && !this.cropResize) return;
    this.updateCrop(event);
    this.cropStart = null;
    this.cropResize = null;
    const canvas = event.currentTarget as HTMLElement;
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
  }

  protected async applyCropAndProcess(): Promise<void> {
    const crop = this.cropDraft();
    if (crop.width < 0.02 || crop.height < 0.02) {
      this.addDiagnostic('Manual crop', 'Draw a larger rectangle around the marking to scan.', undefined, { crop }, 'CROP_TOO_SMALL');
      return;
    }
    this.applyingCrop.set(true);
    try {
      this.cropRect.set(crop);
      await this.processImage();
    } finally {
      this.applyingCrop.set(false);
    }
  }

  protected async openCamera(): Promise<void> {
    this.clearFields();
    this.cameraAlignmentAngle.set(null);
    this.cameraOrientationAngle = null;
    if (!navigator.mediaDevices?.getUserMedia) {
      this.addDiagnostic('Camera', 'This browser does not provide camera access.', 'navigator.mediaDevices.getUserMedia is unavailable.');
      return;
    }
    try {
      await this.requestCameraOrientationPermission();
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      this.stream = stream;
      this.cameraOpen.set(true);
      afterNextRender(() => {
        const video = this.videoPreview()?.nativeElement;
        if (video && this.stream === stream) {
          video.srcObject = stream;
          void video.play();
          this.startCameraAlignmentMonitoring();
        }
      }, { injector: this.injector });
    } catch (error: unknown) {
      this.addDiagnostic('Camera', 'Camera access was not available. Check browser permission and try again.', this.errorMessage(error));
    }
  }

  protected capturePhoto(): void {
    const video = this.videoPreview()?.nativeElement;
    if (!video || video.videoWidth === 0 || video.videoHeight === 0) {
      this.addDiagnostic('Camera', 'The camera is not ready yet. Wait for the preview, then capture again.');
      return;
    }
    if (this.cameraAlignmentStatus() === 'tilted') {
      this.addDiagnostic('Camera alignment', `The camera appears tilted by about ${Math.abs(this.cameraAlignmentAngle() ?? 0)}°. You can capture anyway, but horizontal lines may be split by OCR.`);
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    canvas.toBlob(async (blob) => {
      if (!blob) {
        this.addDiagnostic('Camera', 'The photo could not be created from the camera preview.', `canvas=${canvas.width}x${canvas.height}`, {}, 'CAMERA_CAPTURE_FAILED');
        return;
      }
      const angle = this.cameraAlignmentAngle();
      const correction = angle !== null && Math.abs(angle) >= CAMERA_ROTATION_MIN_DEGREES && Math.abs(angle) <= CAMERA_ROTATION_MAX_DEGREES ? -angle : 0;
      if (angle !== null && Math.abs(angle) > CAMERA_ROTATION_MAX_DEGREES) {
        this.addDiagnostic('Camera alignment', `The image is tilted by about ${Math.abs(angle)}°. Automatic rotation is limited to ${CAMERA_ROTATION_MAX_DEGREES}°; review the crop before scanning.`);
      }
      try {
        const workingImage = correction === 0 ? blob : await this.rotateCameraImage(canvas, correction);
        this.useImage(workingImage, `container-${new Date().toISOString().replaceAll(':', '-')}.jpg`, blob);
        if (correction !== 0) this.status.set(`Camera tilt automatically corrected by ${Math.abs(correction)}° for OCR. Review the crop before scanning.`);
      } catch (error: unknown) {
        this.addDiagnostic('Camera alignment', 'The captured image could not be rotation-corrected. The original image is still available for OCR.', this.errorMessage(error));
        this.useImage(blob, `container-${new Date().toISOString().replaceAll(':', '-')}.jpg`, blob);
      }
      this.closeCamera();
    }, 'image/jpeg', 0.92);
  }

  private async rotateCameraImage(source: HTMLCanvasElement, angle: number): Promise<Blob> {
    const radians = angle * Math.PI / 180;
    const sine = Math.abs(Math.sin(radians));
    const cosine = Math.abs(Math.cos(radians));
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(source.width * cosine + source.height * sine);
    canvas.height = Math.ceil(source.width * sine + source.height * cosine);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('The rotation canvas could not be created.');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(radians);
    context.drawImage(source, -source.width / 2, -source.height / 2);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
    canvas.width = 0;
    canvas.height = 0;
    if (!blob) throw new Error('The rotation image could not be encoded.');
    return blob;
  }

  protected closeCamera(): void {
    this.stopCameraAlignmentMonitoring();
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.cameraOpen.set(false);
    this.cameraAlignmentAngle.set(null);
    this.cameraOrientationAngle = null;
  }

  private startCameraAlignmentMonitoring(): void {
    this.stopCameraAlignmentMonitoring();
    if (typeof window === 'undefined') return;
    window.addEventListener('deviceorientation', this.orientationHandler);
    this.cameraAlignmentTimer = setInterval(() => this.updateCameraAlignment(), CAMERA_ALIGNMENT_SAMPLE_MS);
  }

  private stopCameraAlignmentMonitoring(): void {
    if (this.cameraAlignmentTimer !== null) {
      clearInterval(this.cameraAlignmentTimer);
      this.cameraAlignmentTimer = null;
    }
    if (typeof window !== 'undefined') window.removeEventListener('deviceorientation', this.orientationHandler);
  }

  private async requestCameraOrientationPermission(): Promise<void> {
    if (typeof DeviceOrientationEvent === 'undefined') return;
    const orientation = DeviceOrientationEvent as typeof DeviceOrientationEvent & { requestPermission?: () => Promise<'granted' | 'denied'> };
    if (!orientation.requestPermission) return;
    try {
      await orientation.requestPermission();
    } catch {
      // Camera capture remains available when motion permission is unavailable.
    }
  }

  private cameraRollFromOrientation(event: DeviceOrientationEvent, orientationAngle = this.screenOrientationAngle()): number | null {
    const beta = typeof event.beta === 'number' && Number.isFinite(event.beta) ? event.beta : null;
    const gamma = typeof event.gamma === 'number' && Number.isFinite(event.gamma) ? event.gamma : null;
    switch (orientationAngle) {
      case 90: return beta;
      case 180: return gamma === null ? null : -gamma;
      case 270: return beta === null ? null : -beta;
      default: return gamma;
    }
  }

  private screenOrientationAngle(): number {
    if (typeof screen === 'undefined' || !screen.orientation) return 0;
    return ((screen.orientation.angle % 360) + 360) % 360;
  }

  private updateCameraAlignment(): void {
    const video = this.videoPreview()?.nativeElement;
    const visualAngle = video ? this.measurePreviewRoll(video) : null;
    const nextAngle = visualAngle ?? this.cameraOrientationAngle;
    if (nextAngle === null) return;
    const previous = this.cameraAlignmentAngle();
    const smoothed = previous === null ? nextAngle : previous * 0.7 + nextAngle * 0.3;
    this.cameraAlignmentAngle.set(this.roundAngle(smoothed));
  }

  private measurePreviewRoll(video: HTMLVideoElement): number | null {
    if (video.videoWidth < 32 || video.videoHeight < 32) return null;
    const canvas = document.createElement('canvas');
    const width = 240;
    const height = Math.max(32, Math.round((video.videoHeight / video.videoWidth) * width));
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(video, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    let cosine = 0;
    let sine = 0;
    let edges = 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const index = (y * width + x) * 4;
        const left = this.previewLuma(pixels, index - 4);
        const right = this.previewLuma(pixels, index + 4);
        const top = this.previewLuma(pixels, index - width * 4);
        const bottom = this.previewLuma(pixels, index + width * 4);
        const horizontalGradient = right - left;
        const verticalGradient = bottom - top;
        const magnitude = Math.hypot(horizontalGradient, verticalGradient);
        if (magnitude < 35 || Math.abs(verticalGradient) < Math.abs(horizontalGradient) * 1.15) continue;
        const weight = magnitude * magnitude;
        cosine += weight * (horizontalGradient * horizontalGradient - verticalGradient * verticalGradient);
        sine += weight * 2 * horizontalGradient * verticalGradient;
        edges++;
      }
    }
    if (edges < 30 || Math.hypot(cosine, sine) === 0) return null;
    const angle = (Math.atan2(sine, cosine) / 2) * (180 / Math.PI);
    return Math.abs(angle) <= 45 ? angle : angle - Math.sign(angle) * 90;
  }

  private previewLuma(pixels: Uint8ClampedArray, index: number): number {
    return pixels[index] * 0.299 + pixels[index + 1] * 0.587 + pixels[index + 2] * 0.114;
  }

  private roundAngle(angle: number): number {
    return Math.round(angle * 10) / 10;
  }

  protected setOcrMode(mode: OcrMode): void {
    if (this.processing() || this.applyingCrop()) return;
    this.ocrService.setMode(mode);
  }

  protected async setCaptureMode(mode: CaptureMode): Promise<void> {
    if (this.processing() || this.applyingCrop()) return;
    this.captureMode.set(mode);
    if (mode !== 'auto-crop') return;

    const image = this.imageBlob();
    if (!image) return;
    this.clearFields();
    this.cropRect.set(null);
    this.cropDraft.set(DEFAULT_CROP);
    await this.prepareInitialCrop(image, this.imageSelection);
  }

  protected previewFailed(failedUrl: string): void {
    if (this.previewUrl() !== failedUrl) return;
    this.previewUrl.set(null);
    URL.revokeObjectURL(failedUrl);
    this.cancelPreviewLoad(new Error('The selected image preview could not be loaded.'));
    this.addDiagnostic('Image preview', 'The selected image could not be displayed. Choose the image again.', undefined, {}, 'PREVIEW_LOAD_FAILED');
  }

  protected previewLoaded(url: string): void {
    const pending = this.previewLoad;
    const image = this.previewImage()?.nativeElement;
    if (!pending || pending.selection !== this.imageSelection || this.previewUrl() !== url || !image?.naturalWidth || !image.naturalHeight) {
      return;
    }
    this.previewLoad = null;
    pending.resolve(image);
  }

  protected updateField(key: FieldKey, value: string): void {
    const fieldValue = key === 'containerId' ? value.replace(/[^A-Z0-9]/gi, '').toUpperCase() : value;
    this.fields.update((fields) => {
      const updated = {
        ...fields,
        [key]: { ...fields[key], value: fieldValue },
      };
      return updated;
    });
  }

  protected async processImage(): Promise<void> {
    const image = this.imageBlob();
    if (!image) {
      this.addDiagnostic('Image input', 'Choose or capture a photo before starting OCR.');
      return;
    }
    this.analysisSuccessful.set(false);
    this.processing.set(true);
    this.clearCheckDigitPreview();
    this.selectedOcrLines.set([]);
    this.diagnostics.set([]);
    this.status.set('Preparing local OCR models...');
    const imageUrl = this.previewUrl();
    if (!imageUrl) {
      this.processing.set(false);
      this.addDiagnostic('Image input', 'The selected image preview is unavailable. Choose the image again.');
      return;
    }
    try {
      this.status.set('Loading local PaddleOCR models...');
      this.status.set('Detecting painted text regions...');
      this.rawText.set([]);
      this.rawScans.set([]);
      this.rawScansCollapsed.set(false);
      const scanResults = await this.scanOcrPasses(image);
      const lines = this.selectBestOcrLines(scanResults);
      this.selectedOcrLines.set(lines);
      const rawText = lines.map((line) => `${line.text} (${Math.round(line.mean * 100)}%)`);
      this.rawText.set(rawText);
      const fields = this.extractFields(lines);
      this.fields.set(fields);
      if (this.cropRect() && !this.hasValidContainerId(scanResults)) {
        await this.runCheckDigitScan();
      }
      let suggestedCrop: CropRect | null = null;
      if (!this.cropRect()) {
        try {
          suggestedCrop = await this.createSuggestedCrop(lines, fields.containerId.value, image);
        } catch (error: unknown) {
          this.addDiagnostic('Crop suggestion', 'OCR results are ready, but a suggested crop could not be prepared.', this.errorMessage(error));
        }
      }
      if (suggestedCrop) {
        this.cropDraft.set(suggestedCrop);
        this.status.set('OCR complete. Review the suggested region around the container ID and the aligned markings above and below it.');
      } else {
        this.status.set(`OCR complete. Found ${lines.length} text region${lines.length === 1 ? '' : 's'}. Review the fields before saving.`);
      }
      this.analysisSuccessful.set(true);
      this.processing.set(false);
    } catch (error: unknown) {
      this.analysisSuccessful.set(false);
      this.processing.set(false);
      this.addDiagnostic('ONNX OCR', this.ocrFailureMessage(error), this.errorMessage(error), { pass: 'OCR' }, 'OCR_PASS_FAILED');
    }
  }

  protected async saveJsonToIndexedDb(): Promise<void> {
    const image = this.originalImageBlob() ?? this.imageBlob();
    if (!image) {
      this.addDiagnostic('IndexedDB', 'Choose or capture an image before saving a record.');
      return;
    }
    try {
      const thumbnail = await this.createThumbnail(image);
      const database = await this.openSavedRecordsDatabase();
      const payload = this.createJsonPayload();
      const id = crypto.randomUUID();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(['records', 'images'], 'readwrite');
        transaction.objectStore('records').add({ id, savedAt: new Date().toISOString(), payload, thumbnail, hasImage: true, remoteStatus: 'not-saved-remotely' });
        transaction.objectStore('images').add({ id, image });
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
      await this.loadSavedRecords();
      void this.syncSavedRecords();
      this.status.set('Result and photo saved locally in browser database.');
    } catch (error: unknown) {
      this.addDiagnostic('IndexedDB', 'JSON data could not be saved locally.', this.errorMessage(error));
    }
  }

  protected showSavedJson(record: SavedRecord): void {
    this.savedJson.set(JSON.stringify(record.payload, null, 2));
  }

  protected closeSavedJson(): void {
    this.savedJson.set(null);
  }

  protected async viewSavedPhoto(record: SavedRecord): Promise<void> {
    if (!record.hasImage) return;
    try {
      const database = await this.openSavedRecordsDatabase();
      const storedImage = await new Promise<StoredImage | undefined>((resolve, reject) => {
        const transaction = database.transaction('images', 'readonly');
        const request = transaction.objectStore('images').get(record.id);
        request.onsuccess = () => resolve(request.result as StoredImage | undefined);
        request.onerror = () => reject(request.error);
      });
      database.close();
      if (!storedImage?.image) {
        this.addDiagnostic('IndexedDB', 'The saved photo is no longer available.');
        return;
      }
      this.closeSavedPhoto();
      this.savedPhoto.set({ id: record.id, name: this.savedRecordName(record), url: URL.createObjectURL(storedImage.image) });
    } catch (error: unknown) {
      this.addDiagnostic('IndexedDB', 'The saved photo could not be loaded.', this.errorMessage(error));
    }
  }

  protected closeSavedPhoto(): void {
    const photo = this.savedPhoto();
    if (photo) URL.revokeObjectURL(photo.url);
    this.savedPhoto.set(null);
  }

  protected async deleteSavedRecord(id: string): Promise<void> {
    try {
      const database = await this.openSavedRecordsDatabase();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(['records', 'images'], 'readwrite');
        transaction.objectStore('records').delete(id);
        transaction.objectStore('images').delete(id);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
      this.savedRecords.update((records) => {
        const deleted = records.find((record) => record.id === id);
        if (deleted?.thumbnailUrl) URL.revokeObjectURL(deleted.thumbnailUrl);
        return records.filter((record) => record.id !== id);
      });
      if (this.savedPhoto()?.id === id) this.closeSavedPhoto();
      this.status.set('Saved record deleted.');
    } catch (error: unknown) {
      this.addDiagnostic('IndexedDB', 'The saved record could not be deleted.', this.errorMessage(error));
    }
  }

  protected async deleteAllSavedRecords(): Promise<void> {
    if (!window.confirm('Delete all saved results from this device?')) {
      return;
    }
    try {
      const database = await this.openSavedRecordsDatabase();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(['records', 'images'], 'readwrite');
        transaction.objectStore('records').clear();
        transaction.objectStore('images').clear();
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();
      for (const record of this.savedRecords()) {
        if (record.thumbnailUrl) URL.revokeObjectURL(record.thumbnailUrl);
      }
      this.savedRecords.set([]);
      this.savedJson.set(null);
      this.closeSavedPhoto();
      this.status.set('All saved results deleted.');
    } catch (error: unknown) {
      this.addDiagnostic('IndexedDB', 'Saved results could not be deleted.', this.errorMessage(error));
    }
  }

  protected dismissDiagnostics(): void {
    this.diagnostics.set([]);
  }

  protected ngOnDestroy(): void {
    this.closeCamera();
    this.cancelSyncRetry();
    window.removeEventListener('online', this.onlineHandler);
    window.removeEventListener('offline', this.offlineHandler);
    this.cancelPreviewLoad(new Error('The component was destroyed.'));
    const current = this.previewUrl();
    if (current) {
      URL.revokeObjectURL(current);
    }
    for (const record of this.savedRecords()) {
      if (record.thumbnailUrl) URL.revokeObjectURL(record.thumbnailUrl);
    }
    this.closeSavedPhoto();
  }

  protected ngOnInit(): void {
    window.addEventListener('online', this.onlineHandler);
    window.addEventListener('offline', this.offlineHandler);
    void this.loadSavedRecords();
    const initializationError = this.ocrService.initializationError();
    if (initializationError) {
      this.addDiagnostic('OCR initialization', 'Local OCR could not be initialized. Refresh the app and try again.', initializationError);
    }
  }

  private useImage(image: Blob, name: string, originalImage = image): void {
    this.cancelPreviewLoad(new Error('A different image was selected.'));
    const current = this.previewUrl();
    if (current) {
      URL.revokeObjectURL(current);
    }
    this.imageBlob.set(image);
    this.originalImageBlob.set(originalImage);
    this.previewUrl.set(URL.createObjectURL(image));
    this.sourceName.set(name);
    this.applyingCrop.set(false);
    this.cropRect.set(null);
    this.cropDraft.set(DEFAULT_CROP);
    this.clearCheckDigitPreview();
    this.selectedOcrLines.set([]);
    this.rawText.set([]);
    this.rawScans.set([]);
    this.rawScansCollapsed.set(false);
    const selection = ++this.imageSelection;
    if (this.captureMode() === 'manual-crop') {
      this.status.set('Draw a crop around the ID and markings, then use the selected region to run OCR.');
      return;
    }
    void this.prepareInitialCrop(image, selection);
  }

  private clearFields(): void {
    this.analysisSuccessful.set(false);
    this.fields.set({
      maxWorkingPressureBar: { value: '', unit: 'BAR' },
      maxWorkingPressurePsi: { value: '', unit: 'PSI' },
      containerId: { value: '' },
      isoCode: { value: '' },
      approvalCode: { value: '' },
      applicableRegulations: { value: '' },
      tankCode: { value: '' },
      kemlerCode: { value: '' },
      unNumber: { value: '' },
      mpgmKg: { value: '', unit: 'KG' },
      mpgmLb: { value: '', unit: 'LB' },
      tareKg: { value: '', unit: 'KG' },
      tareLb: { value: '', unit: 'LB' },
      payloadKg: { value: '', unit: 'KG' },
      payloadLb: { value: '', unit: 'LB' },
      capacityLiters: { value: '', unit: 'L' },
      capacityUsGallons: { value: '', unit: 'US GAL' },
      capacityCubicMeters: { value: '', unit: 'CU.M.' },
      capacityCubicFeet: { value: '', unit: 'CU.FT.' },
    });
    this.rawText.set([]);
    this.rawScans.set([]);
    this.rawScansCollapsed.set(false);
    this.selectedOcrLines.set([]);
    this.clearCheckDigitPreview();
  }

  protected updateInferredContainerIdStem(value: string): void {
    const digit = this.inferredContainerIdDigit();
    this.updateField('containerId', `${value}${digit}`);
  }

  protected updateInferredContainerIdDigit(value: string): void {
    this.updateField('containerId', `${this.fields().containerId.value.slice(0, 10)}${value.slice(-1)}`);
  }

  private async loadSavedRecords(): Promise<void> {
    try {
      const database = await this.openSavedRecordsDatabase();
      const records = await new Promise<StoredRecord[]>((resolve, reject) => {
        const transaction = database.transaction('records', 'readonly');
        const request = transaction.objectStore('records').getAll();
        request.onsuccess = () => resolve(request.result as StoredRecord[]);
        request.onerror = () => reject(request.error);
      });
      database.close();
      for (const record of this.savedRecords()) {
        if (record.thumbnailUrl) URL.revokeObjectURL(record.thumbnailUrl);
      }
      this.savedRecords.set(records
        .sort((first, second) => second.savedAt.localeCompare(first.savedAt))
        .map((record) => this.hydrateSavedRecord(record)));
      if (!navigator.onLine && this.hasPendingRemoteSync()) this.syncWarning.set('offline');
      void this.syncSavedRecords();
    } catch (error: unknown) {
      this.addDiagnostic('IndexedDB', 'Saved records could not be loaded.', this.errorMessage(error));
    }
  }

  private hydrateSavedRecord(record: StoredRecord): SavedRecord {
    return {
      ...record,
      remoteStatus: record.remoteStatus ?? 'not-saved-remotely',
      thumbnailUrl: record.thumbnail instanceof Blob ? URL.createObjectURL(record.thumbnail) : null,
    };
  }

  protected savedRecordName(record: SavedRecord): string {
    const source = (record.payload as { source?: { fileName?: unknown } }).source;
    return typeof source?.fileName === 'string' && source.fileName ? source.fileName : 'Container image';
  }

  protected remoteStatusLabel(record: SavedRecord): string {
    return record.remoteStatus === 'saved-remotely' ? 'Saved remotely' : 'Not saved remotely';
  }

  private async syncSavedRecords(): Promise<void> {
    if (this.syncingSavedRecords) return;
    if (typeof navigator !== 'undefined' && !navigator.onLine) {
      this.cancelSyncRetry();
      if (this.hasPendingRemoteSync()) this.syncWarning.set('offline');
      return;
    }
    if (!this.hasPendingRemoteSync()) {
      this.clearSyncStateWhenComplete();
      return;
    }

    this.syncingSavedRecords = true;
    let retryRequired = false;
    try {
      const pendingRecords = this.savedRecords()
        .filter((record) => record.remoteStatus !== 'saved-remotely' && record.hasImage)
        .sort((first, second) => first.savedAt.localeCompare(second.savedAt));
      for (const record of pendingRecords) {
        const image = await this.loadStoredImage(record.id);
        if (!image) continue;
        const thumbnail = await this.ensureThumbnail(record, image);
        if (!thumbnail) continue;

        const form = new FormData();
        form.append('clientRecordId', record.id);
        form.append('json', JSON.stringify(record.payload));
        form.append('image', image, 'container-image');
        form.append('thumbnail', thumbnail, 'thumbnail.jpg');
        try {
          const response = await fetch(REMOTE_API_URL, { method: 'POST', body: form });
          if (!response.ok) {
            retryRequired = true;
            this.syncWarning.set('remote-unavailable');
            break;
          }
          await this.markRecordSavedRemotely(record.id);
          this.syncRetryDelayMs = INITIAL_SYNC_RETRY_DELAY_MS;
        } catch {
          retryRequired = true;
          this.syncWarning.set('remote-unavailable');
          break;
        }
      }
    } finally {
      this.syncingSavedRecords = false;
      if (!this.hasPendingRemoteSync()) {
        this.clearSyncStateWhenComplete();
      } else if (typeof navigator !== 'undefined' && !navigator.onLine) {
        this.offlineHandler();
      } else if (retryRequired) {
        this.scheduleSyncRetry();
      }
    }
  }

  private hasPendingRemoteSync(): boolean {
    return this.savedRecords().some((record) => record.remoteStatus !== 'saved-remotely' && record.hasImage);
  }

  private scheduleSyncRetry(): void {
    if (this.syncRetryTimer !== null || (typeof navigator !== 'undefined' && !navigator.onLine)) return;
    this.syncRetryTimer = setTimeout(() => {
      this.syncRetryTimer = null;
      void this.syncSavedRecords();
    }, this.syncRetryDelayMs);
    this.syncRetryDelayMs = Math.min(this.syncRetryDelayMs * 2, MAX_SYNC_RETRY_DELAY_MS);
  }

  private cancelSyncRetry(): void {
    if (this.syncRetryTimer === null) return;
    clearTimeout(this.syncRetryTimer);
    this.syncRetryTimer = null;
  }

  private clearSyncStateWhenComplete(): void {
    if (this.hasPendingRemoteSync()) return;
    this.cancelSyncRetry();
    this.syncRetryDelayMs = INITIAL_SYNC_RETRY_DELAY_MS;
    this.syncWarning.set(null);
  }

  private async loadStoredImage(id: string): Promise<Blob | null> {
    const database = await this.openSavedRecordsDatabase();
    try {
      return await new Promise<Blob | null>((resolve, reject) => {
        const request = database.transaction('images', 'readonly').objectStore('images').get(id);
        request.onsuccess = () => resolve((request.result as StoredImage | undefined)?.image ?? null);
        request.onerror = () => reject(request.error);
      });
    } finally {
      database.close();
    }
  }

  private async ensureThumbnail(record: SavedRecord, image: Blob): Promise<Blob | null> {
    if (record.thumbnail instanceof Blob) return record.thumbnail;
    try {
      const thumbnail = await this.createThumbnail(image);
      await this.updateStoredRecord(record.id, (stored) => ({ ...stored, thumbnail }));
      this.savedRecords.update((records) => records.map((current) => {
        if (current.id !== record.id) return current;
        if (current.thumbnailUrl) URL.revokeObjectURL(current.thumbnailUrl);
        return { ...current, thumbnail, thumbnailUrl: URL.createObjectURL(thumbnail) };
      }));
      return thumbnail;
    } catch {
      return null;
    }
  }

  private async markRecordSavedRemotely(id: string): Promise<void> {
    await this.updateStoredRecord(id, (record) => ({ ...record, remoteStatus: 'saved-remotely' }));
    this.savedRecords.update((records) => records.map((record) => record.id === id ? { ...record, remoteStatus: 'saved-remotely' } : record));
  }

  private async updateStoredRecord(id: string, update: (record: StoredRecord) => StoredRecord): Promise<void> {
    const database = await this.openSavedRecordsDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction('records', 'readwrite');
        const store = transaction.objectStore('records');
        const request = store.get(id);
        request.onsuccess = () => {
          const record = request.result as StoredRecord | undefined;
          if (!record) {
            reject(new Error('The saved record no longer exists.'));
            return;
          }
          store.put(update(record));
        };
        request.onerror = () => reject(request.error);
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  }

  private async prepareInitialCrop(image: Blob, selection: number): Promise<void> {
    const startedAt = performance.now();
    this.processing.set(true);
    this.status.set('Locating the container ID and markings in the full photo...');
    try {
      const preview = await this.waitForPreviewImage(selection);
      if (selection !== this.imageSelection) return;

      let lines: OcrLine[];
      const scanStartedAt = performance.now();
      try {
        lines = await this.scanAutoCrop(preview, MAX_FULL_PHOTO_PIXELS);
      } catch (error: unknown) {
        this.status.set('Automatic crop failed. Retrying with reduced crop resolution...');
        try {
          lines = await this.scanAutoCrop(preview, MAX_AUTO_CROP_FALLBACK_PIXELS);
        } catch (fallbackError: unknown) {
          throw new Error(`Normal-size auto crop failed: ${this.errorMessage(error)}. Reduced auto crop failed: ${this.errorMessage(fallbackError)}`);
        }
      }
      this.rawText.set(lines.map((line) => `${line.text} (${Math.round(line.mean * 100)}%)`));
       this.rawScans.set([{
         label: 'Full photo',
         lines: lines.map((line) => ({ text: line.text, confidence: Math.round(line.mean * 100) })),
         durationMs: Math.round(performance.now() - scanStartedAt),
         pixelCount: this.lastAutoCropPixelCount,
       }]);
       let fields = this.extractFields(lines);
        const containerId = fields.containerId.value;
        const partialContainerId = /^[A-Z]{3}[UJZ]\d{6}$/.test(containerId)
          ? containerId
          : containerId ? '' : this.findContainerIdAnchor(lines);
      if (partialContainerId) {
        fields.containerId = { value: partialContainerId, confidence: this.containerIdConfidence(lines, partialContainerId) };
      }
      this.fields.set(fields);
      this.analysisSuccessful.set(Boolean(containerId || partialContainerId));
       let suggestedCrop = await this.createSuggestedCrop(lines, containerId || partialContainerId, image, {
         width: preview.naturalWidth,
         height: preview.naturalHeight,
       });
       let automaticRetryReason = '';
       const shouldRetryAutomaticCrop = Boolean(suggestedCrop && this.hasLowConfidenceForAutomaticCrop(fields));
         if (suggestedCrop && shouldRetryAutomaticCrop) {
           try {
             const retryStartedAt = performance.now();
             automaticRetryReason = this.lowConfidenceSummary(fields);
            this.status.set(`Low confidence detected in ${automaticRetryReason}. Retrying the automatic crop at 2x to improve recognition...`);
            const retryLines = await this.scanCropRegion(image, suggestedCrop, 2, MAX_MANUAL_RETRY_CROP_PIXELS);
            this.rawScans.update((scans) => [...scans, {
              label: '2x automatic crop',
              lines: retryLines.map((line) => ({ text: line.text, confidence: Math.round(line.mean * 100) })),
              durationMs: Math.round(performance.now() - retryStartedAt),
              pixelCount: this.lastCropPassPixelCount,
            }]);
           lines = this.selectBestOcrLines([lines, retryLines]);
           this.rawText.set(lines.map((line) => `${line.text} (${Math.round(line.mean * 100)}%)`));
           fields = this.mergeFieldsByConfidence(fields, this.extractFields(retryLines));
            this.fields.set(fields);
             suggestedCrop = await this.createSuggestedCrop(lines, fields.containerId.value || partialContainerId, image, {
               width: preview.naturalWidth,
               height: preview.naturalHeight,
             });
           } catch (error: unknown) {
            this.addDiagnostic('Automatic crop retry', 'The enlarged automatic crop could not be scanned.', this.errorMessage(error), {
              crop: suggestedCrop ?? undefined,
              pass: '2x automatic crop',
              pixelCount: MAX_MANUAL_RETRY_CROP_PIXELS,
              scale: 2,
            }, 'OCR_PASS_FAILED');
          }
        }
        if (partialContainerId && !this.validateContainerId(fields.containerId.value) && suggestedCrop) {
          this.fields.set(fields);
          this.selectedOcrLines.set(lines);
          await this.runCheckDigitScan(suggestedCrop, lines);
          fields = this.fields();
        }
       if (selection !== this.imageSelection || this.cropRect()) return;
      const duration = ` (${Math.round(performance.now() - startedAt)} ms)`;
       if (suggestedCrop) {
         this.cropDraft.set(suggestedCrop);
          const retryStatus = automaticRetryReason ? `\nAutomatic 2x scan ran because some fields had confidence below the 85% threshold: ${automaticRetryReason}.` : '';
           const completeContainerId = this.validateContainerId(fields.containerId.value);
           this.status.set(completeContainerId
             ? `Container ID located${duration}: ${this.formatContainerId(fields.containerId.value)}${retryStatus}\n`
             : partialContainerId
               ? `Partial container ID located: ${this.formatContainerId(partialContainerId)}${retryStatus}`
               : `Container ID located${duration}.${retryStatus}\n`);
      } else if (partialContainerId) {
        this.status.set(`Partial container ID located: ${this.formatContainerId(partialContainerId)}`);
      } else {
        this.status.set(`Container ID was not located. Draw a crop around the ID and markings you want to scan.${duration}`);
      }
    } catch (error: unknown) {
      if (selection === this.imageSelection) {
        this.addDiagnostic('Initial crop detection', 'The ID could not be located automatically. Draw a crop around the markings to scan.', this.errorMessage(error), { pass: 'Full photo / reduced fallback' }, 'AUTO_CROP_FAILED');
      }
    } finally {
      if (selection === this.imageSelection) {
        this.processing.set(false);
      }
    }
  }

  private waitForPreviewImage(selection: number): Promise<HTMLImageElement> {
    const image = this.previewImage()?.nativeElement;
    if (selection === this.imageSelection && image?.src === this.previewUrl() && image.complete && image.naturalWidth && image.naturalHeight) {
      return Promise.resolve(image);
    }
    return new Promise<HTMLImageElement>((resolve, reject) => {
      this.previewLoad = { selection, resolve, reject };
    });
  }

  private cancelPreviewLoad(reason: Error): void {
    const pending = this.previewLoad;
    this.previewLoad = null;
    pending?.reject(reason);
  }

  private async scanAutoCrop(source: HTMLImageElement, maximumPixels: number): Promise<OcrLine[]> {
    const pass = await this.createCropPassFromSource(source, source.naturalWidth, source.naturalHeight, DEFAULT_CROP, 1, undefined, maximumPixels);
    this.lastAutoCropPixelCount = pass.pixelCount;
    try {
      return this.deduplicateLines((await this.detectWithTimeout(pass.url)).map((line) => ({
        ...line,
        box: line.box?.map(([x, y]) => [x / pass.scale, y / pass.scale]),
      })));
    } finally {
      URL.revokeObjectURL(pass.url);
    }
  }

  private async detectWithTimeout(url: string) {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.ocrService.detect(url),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error(`OCR did not finish within ${OCR_PASS_TIMEOUT_MS / 1000} seconds.`)), OCR_PASS_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private addDiagnostic(stage: string, message: string, technical?: string, context: DiagnosticContext = {}, code = 'GENERAL'): void {
    this.status.set(message);
    const diagnosticContext = { ...this.currentDiagnosticContext(), ...context };
    this.diagnostics.update((diagnostics) => [...diagnostics, {
      id: ++this.nextDiagnosticId,
      code,
      stage,
      message,
      technical: this.formatDiagnosticDetails(technical, diagnosticContext),
      context: diagnosticContext,
    }]);
  }

  private currentDiagnosticContext(): DiagnosticContext {
    const image = this.imageBlob();
    const preview = this.previewImage()?.nativeElement;
    return {
      imageName: this.sourceName() || undefined,
      imageBytes: image?.size,
      imageType: image?.type || undefined,
      sourceWidth: preview?.naturalWidth || undefined,
      sourceHeight: preview?.naturalHeight || undefined,
    };
  }

  private formatDiagnosticDetails(technical: string | undefined, context: DiagnosticContext): string | undefined {
    const details = [
      context.imageName ? `image=${JSON.stringify(context.imageName)}` : undefined,
      context.imageBytes !== undefined ? `bytes=${context.imageBytes}` : undefined,
      context.imageType ? `type=${context.imageType}` : undefined,
      context.sourceWidth !== undefined && context.sourceHeight !== undefined ? `source=${context.sourceWidth}x${context.sourceHeight}` : undefined,
      context.crop ? `crop=${context.crop.x.toFixed(3)},${context.crop.y.toFixed(3)},${context.crop.width.toFixed(3)},${context.crop.height.toFixed(3)}` : undefined,
      context.canvasWidth !== undefined && context.canvasHeight !== undefined ? `canvas=${context.canvasWidth}x${context.canvasHeight}` : undefined,
      context.pass ? `pass=${context.pass}` : undefined,
      context.pixelCount !== undefined ? `pixels=${context.pixelCount}` : undefined,
      context.scale !== undefined ? `scale=${context.scale}` : undefined,
      technical ? `error=${technical}` : undefined,
    ].filter((detail): detail is string => Boolean(detail));
    return details.length ? details.join('\n') : undefined;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }

  private async scanCropRegion(image: Blob, crop: CropRect, scale: number, maximumPixels: number): Promise<OcrLine[]> {
    const pass = await this.createCropPass(image, crop, scale, undefined, maximumPixels);
    this.lastCropPassPixelCount = pass.pixelCount;
    try {
      return this.deduplicateLines((await this.detectWithTimeout(pass.url)).map((line) => ({
        ...line,
        box: line.box?.map(([x, y]) => [x / pass.scale + pass.offsetX, y / pass.scale + pass.offsetY]),
      })));
    } finally {
      if (pass.revokeUrl) URL.revokeObjectURL(pass.url);
    }
  }

  private ocrFailureMessage(error: unknown): string {
    const message = this.errorMessage(error).toLowerCase();
    if (error instanceof RangeError || /memory|allocate|canvas|bitmap|decoded image|webgl/i.test(message)) {
      return 'The browser ran out of memory while preparing this image for OCR. Try a tighter crop or a smaller photo.';
    }
    return 'Local OCR could not process this image.';
  }

  private async scanOcrPasses(image: Blob): Promise<OcrLine[][]> {
    const manualCrop = this.cropRect();
    const definitions = manualCrop
      ? [
        { label: 'Original size', crop: manualCrop, scale: 1, maximumPixels: MAX_MANUAL_CROP_PIXELS },
        { label: 'Enlarged', crop: manualCrop, scale: 2, maximumPixels: MAX_MANUAL_RETRY_CROP_PIXELS },
        ]
      : [{ label: 'Full photo', crop: DEFAULT_CROP, scale: 1, maximumPixels: MAX_FULL_PHOTO_PIXELS }];
    const scanResults: OcrLine[][] = [];

    for (const [index, definition] of definitions.entries()) {
      // Release each temporary OCR image before creating the next one.
      const pass = await this.createCropPass(image, definition.crop, definition.scale, undefined, definition.maximumPixels);
      try {
        this.status.set(`Scanning ${definition.label}${definitions.length > 1 ? ` (${index + 1} of ${definitions.length})` : ''}...`);
        const startedAt = performance.now();
        const detected = await this.detectWithTimeout(pass.url);
        const scan = detected.map((line) => ({
          ...line,
          box: line.box?.map(([x, y]) => [x / pass.scale + pass.offsetX, y / pass.scale + pass.offsetY]),
         }));
         scanResults.push(scan);
         const lines = this.deduplicateLines(scanResults.flat());
         this.rawText.set(lines.map((line) => `${line.text} (${Math.round(line.mean * 100)}%)`));
          this.rawScans.update((scans) => [...scans, {
           label: definition.label === 'Enlarged' ? `${pass.scale.toFixed(1)}x enlarged` : definition.label,
            lines: scan.map((line) => ({ text: line.text, confidence: Math.round(line.mean * 100) })),
            durationMs: Math.round(performance.now() - startedAt),
            pixelCount: pass.pixelCount,
          }]);
          if (manualCrop && index === 0) {
           if (!this.hasLowConfidence(this.extractFields(scan))) {
             break;
           }
         }
       } finally {
        if (pass.revokeUrl) URL.revokeObjectURL(pass.url);
      }
    }

    return scanResults;
  }

  private async runCheckDigitScan(crop = this.cropRect(), lines = this.selectedOcrLines()): Promise<void> {
    const image = this.imageBlob();
    if (!image || !crop) return;
    const imageSize = this.previewImage()?.nativeElement;
    if (!imageSize?.naturalWidth || !imageSize.naturalHeight) {
      this.addDiagnostic('Check digit OCR', 'The source image dimensions are not available yet.', undefined, { pass: 'Check digit' }, 'SOURCE_DIMENSIONS_UNAVAILABLE');
      return;
    }
     const region = this.checkDigitRegion(lines, imageSize.naturalWidth, imageSize.naturalHeight, crop);
    if (!region) {
      this.addDiagnostic('Check digit OCR', 'The first 10 container-ID characters could not define a check-digit region.', undefined, { crop, pass: 'Check digit' }, 'CHECK_DIGIT_REGION_UNAVAILABLE');
      return;
    }

    this.processing.set(true);
    const startedAt = performance.now();
    let retainPass = false;
    let pass: { url: string; revokeUrl: boolean; pixelCount: number } | null = null;
    try {
      this.status.set('Scanning the expected check-digit region...');
       pass = await this.createCheckDigitPass(image, region, 2);
      this.clearCheckDigitPreview();
      this.checkDigitPreviewUrl.set(pass.url);
      retainPass = true;
        const detected = await this.detectWithTimeout(pass.url);
       // Server-only: the server engine has been observed dropping the space between the
       // approval code and the regulations text that follows it (e.g. "58K2RID-ADR-IMDG" instead
       // of "58K2 RID-ADR-IMDG"). The browser path is untouched (same pattern as before).
       const isServerCheckDigitScan = this.ocrService.mode() === 'server';
       const approvalCandidatePattern = isServerCheckDigitScan
         ? /\b([0-9A-Z]{2})\s*([A-Z])\s*([0-9])\s*[-:.]?\s*(.+)$/
         : /\b([0-9A-Z]{2})\s*([A-Z])\s*([0-9])\b\s+(.+)$/;
       const approvalLine = detected.find((line) => {
         const match = line.text.match(approvalCandidatePattern);
         return Boolean(match && (!isServerCheckDigitScan || /\b(?:RID|ADR|IMDG)\b/.test(match[4])));
       });
       const approvalMatch = approvalLine?.text.match(/\b([0-9A-Z]{2})\s*([A-Z])\s*([0-9])\b/);
       if (approvalLine && approvalMatch) {
         const regulations = approvalLine.text.replace(approvalMatch[0], '').replace(/^\s*[-:.]?\s*/, '').trim();
         this.fields.update((fields) => ({
           ...fields,
           approvalCode: { ...fields.approvalCode, value: `${approvalMatch[1]}${approvalMatch[2]}${approvalMatch[3]}`, confidence: approvalLine.mean },
           ...(regulations ? { applicableRegulations: { ...fields.applicableRegulations, value: regulations, confidence: approvalLine.mean } } : {}),
         }));
       }
       const scan = detected.map((line) => ({ text: line.text, confidence: Math.round(line.mean * 100) }));
       this.rawScans.update((scans) => [...scans, {
          label: '2x container ID',
         lines: scan,
         durationMs: Math.round(performance.now() - startedAt),
         pixelCount: pass!.pixelCount,
       }]);
       let directlyDetected = this.applyCheckDigitCandidate(lines, detected, false);
       if (!directlyDetected) {
         if (pass.revokeUrl) URL.revokeObjectURL(pass.url);
         retainPass = false;
         pass = await this.createCheckDigitPass(image, this.checkDigitDigitRegion(region), 3);
         this.clearCheckDigitPreview();
         this.checkDigitPreviewUrl.set(pass.url);
         retainPass = true;
          const digitDetected = await this.detectWithTimeout(pass.url);
         const digitScan = digitDetected.map((line) => ({ text: line.text, confidence: Math.round(line.mean * 100) }));
          this.rawScans.update((scans) => [...scans, {
            label: '3x container ID check digit',
            lines: digitScan,
            durationMs: Math.round(performance.now() - startedAt),
            pixelCount: pass!.pixelCount,
          }]);
         directlyDetected = this.applyCheckDigitCandidate(lines, digitDetected, false);
         if (!directlyDetected) this.applyCheckDigitCandidate(lines, digitDetected);
       }
       this.status.set('Check-digit scan complete.');
    } catch (error: unknown) {
      this.addDiagnostic('Check digit OCR', 'The targeted check-digit scan could not be completed.', this.errorMessage(error), { crop, pass: '2x / 3x check digit' }, 'OCR_PASS_FAILED');
    } finally {
      if (pass?.revokeUrl && !retainPass) URL.revokeObjectURL(pass.url);
      this.processing.set(false);
    }
  }

  private applyCheckDigitCandidate(lines: OcrLine[], detected: OcrLine[], allowInference = true): boolean {
     const stem = this.findCheckDigitStem(lines);
     if (!stem) return false;
    const current = this.fields().containerId;
    const candidates = detected
      .map((line) => {
        const normalized = line.text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        const suffix = normalized.startsWith(stem) ? normalized.slice(stem.length) : '';
         const digits = normalized.match(/\d/g) ?? [];
         const stemTail = stem.slice(-3);
         const tailSuffix = normalized.startsWith(stemTail) && normalized.length === stemTail.length + 1
           ? normalized.slice(stemTail.length)
           : '';
         return {
           digit: /^\d$/.test(suffix) ? suffix : /^\d$/.test(tailSuffix) ? tailSuffix : digits.length === 1 ? digits[0] : undefined,
          confidence: line.mean,
        };
      })
      .filter((item): item is { digit: string; confidence: number } => Boolean(item.digit))
      .sort((first, second) => second.confidence - first.confidence);
    const candidate = candidates.find((item) => this.validateContainerId(stem + item.digit));
     if (!candidate && !allowInference) return false;
     const inferred = !candidate;
     const recoveredDigit = candidate?.digit ?? this.containerIdCheckDigit(stem);
     if (!recoveredDigit) return false;
     const recoveredConfidence = candidate?.confidence ?? this.containerIdConfidence(lines, stem) ?? 0;
     if (this.validateContainerId(current.value) && recoveredConfidence < (current.confidence ?? 0)) return false;
    this.fields.update((fields) => ({
       ...fields,
       containerId: { ...fields.containerId, value: stem + recoveredDigit, confidence: recoveredConfidence, inferred },
     }));
     return true;
  }

  private hasValidContainerId(results: OcrLine[][]): boolean {
    return results.some((lines) => this.validateContainerId(this.extractFields(lines).containerId.value));
  }

  private findCheckDigitStem(lines: OcrLine[]): string {
    const value = this.fields().containerId.value.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    if (/^[A-Z]{3}[UJZ]\d{6}/.test(value)) return value.slice(0, 10);
    return this.findContainerIdAnchor(lines);
  }

  private checkDigitRegion(lines: OcrLine[], imageWidth: number, imageHeight: number, crop = this.cropRect()): CropRect | null {
    const stem = this.findCheckDigitStem(lines);
    if (!stem) return null;
    const stemLines = this.linesForCheckDigitStem(lines, stem);
    const idBounds = this.combineBounds(stemLines
      .map((line) => this.boxBounds(line.box))
      .filter((bounds): bounds is BoxBounds => Boolean(bounds)));
    if (!idBounds || !crop) return null;
    const cropBounds = {
      left: crop.x * imageWidth,
      top: crop.y * imageHeight,
      right: (crop.x + crop.width) * imageWidth,
      bottom: (crop.y + crop.height) * imageHeight,
    };
    const idWidth = Math.max(1, idBounds.right - idBounds.left);
    const anchor = stemLines.find((line) => line.box?.length && line.text.replace(/[^A-Z0-9]/gi, '').toUpperCase().includes(stem));
    const normalizedAnchor = anchor?.text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const anchorBounds = anchor ? this.boxBounds(anchor.box) : null;
     const stemRight = anchor && normalizedAnchor
        ? anchorBounds!.left + (anchorBounds!.right - anchorBounds!.left) * ((normalizedAnchor.indexOf(stem) + stem.length) / normalizedAnchor.length)
        : idBounds.right;
     const characterWidth = Math.max(1, (stemRight - idBounds.left) / 10);
     const verticalPadding = Math.max(4, idBounds.bottom - idBounds.top);
     const left = Math.max(cropBounds.left, idBounds.left - characterWidth * 0.5);
     const right = Math.min(cropBounds.right, stemRight + characterWidth * 2.8);
     const top = Math.max(cropBounds.top, idBounds.top - verticalPadding);
     const bottom = Math.min(cropBounds.bottom, idBounds.bottom + verticalPadding);
    if (right <= left || bottom <= top) return null;
     return { x: left / imageWidth, y: top / imageHeight, width: (right - left) / imageWidth, height: (bottom - top) / imageHeight };
   }

  private checkDigitDigitRegion(region: CropRect): CropRect {
    const digitWidth = region.width * 0.35;
    return {
      ...region,
      x: region.x + region.width - digitWidth,
      width: digitWidth,
    };
  }

  private linesForCheckDigitStem(lines: OcrLine[], stem: string): OcrLine[] {
    const fragments = lines
      .map((line) => ({ line, text: line.text.replace(/[^A-Z0-9]/gi, '').toUpperCase(), bounds: this.boxBounds(line.box) }))
      .filter((fragment) => fragment.text && fragment.bounds)
      .sort((first, second) => first.bounds!.top - second.bounds!.top || first.bounds!.left - second.bounds!.left);
    for (let start = 0; start < fragments.length; start++) {
      for (let length = 1; length <= 3 && start + length <= fragments.length; length++) {
        const candidate = fragments.slice(start, start + length);
        if (!candidate.map((fragment) => fragment.text).join('').includes(stem)) continue;
        const centers = candidate.map((fragment) => (fragment.bounds!.top + fragment.bounds!.bottom) / 2);
        const heights = candidate.map((fragment) => fragment.bounds!.bottom - fragment.bounds!.top);
        const baselineTolerance = Math.max(6, Math.min(...heights) * 0.75);
        if (Math.max(...centers) - Math.min(...centers) <= baselineTolerance) {
          return candidate.map((fragment) => fragment.line);
        }
      }
    }
    return [];
  }

  private async createCheckDigitPass(image: Blob, region: CropRect, requestedScale = 2): Promise<{ url: string; revokeUrl: boolean; pixelCount: number }> {
    const decodedImage = await this.decodeImage(image);
    try {
      const sourceX = Math.round(region.x * decodedImage.width);
      const sourceY = Math.round(region.y * decodedImage.height);
      const sourceWidth = Math.max(1, Math.round(region.width * decodedImage.width));
      const sourceHeight = Math.max(1, Math.round(region.height * decodedImage.height));
       const scale = this.cropOutputScale(sourceWidth, sourceHeight, requestedScale, undefined, this.runtimeCropPixelBudget(MAX_CHECK_DIGIT_CROP_PIXELS));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      try {
        const context = canvas.getContext('2d');
        if (!context) throw new Error(`Canvas 2D context is unavailable (canvas=${canvas.width}x${canvas.height}).`);
        context.drawImage(decodedImage.source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
        const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => result ? resolve(result) : reject(new Error(`Check-digit crop could not be created (canvas=${canvas.width}x${canvas.height}).`)), 'image/png'));
        return { url: URL.createObjectURL(blob), revokeUrl: true, pixelCount: canvas.width * canvas.height };
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    } finally {
      decodedImage.release();
    }
  }

  private clearCheckDigitPreview(): void {
    const url = this.checkDigitPreviewUrl();
    if (url) URL.revokeObjectURL(url);
    this.checkDigitPreviewUrl.set(null);
  }

  private selectBestOcrLines(results: OcrLine[][]): OcrLine[] {
    return results
      .map((result) => this.deduplicateLines(result))
      .sort((first, second) => this.ocrResultScore(second) - this.ocrResultScore(first))[0] ?? [];
  }

  private mergeFieldsByConfidence(original: Record<FieldKey, ContainerField>, retry: Record<FieldKey, ContainerField>): Record<FieldKey, ContainerField> {
    const merged = { ...original };
    for (const key of Object.keys(original) as FieldKey[]) {
      const candidate = retry[key];
      const current = original[key];
      if (candidate?.value && (!current.value || (candidate.confidence ?? 0) > (current.confidence ?? 0))) {
        merged[key] = { ...current, ...candidate };
      }
    }
    return merged;
  }

  private lowConfidenceSummary(fields: Record<string, ContainerField>): string {
    const labels: Record<string, string> = {
      mpgmKg: 'MGW',
      mpgmLb: 'MGW',
      tareKg: 'TARE',
      tareLb: 'TARE',
      payloadKg: 'PAYLOAD',
      payloadLb: 'PAYLOAD',
      capacityLiters: 'CAPACITY',
      capacityUsGallons: 'CAPACITY',
      capacityCubicMeters: 'CAPACITY',
      capacityCubicFeet: 'CAPACITY',
    };
    return Object.entries(fields)
      .filter(([key, field]) => key !== 'containerId' && field.value && field.confidence !== undefined && field.confidence < 0.85)
      .map(([key, field]) => `${labels[key] ?? key} ${Math.round((field.confidence ?? 0) * 100)}%`)
      .join(', ');
  }

  private hasLowConfidence(fields: Record<string, ContainerField>): boolean {
    return Object.values(fields).some((field) => field.value && field.confidence !== undefined && field.confidence < 0.85);
  }

  private hasLowConfidenceForAutomaticCrop(fields: Record<string, ContainerField>): boolean {
    return Object.entries(fields).some(([key, field]) => key !== 'containerId'
      && field.value && field.confidence !== undefined && field.confidence < 0.85);
  }

  private ocrResultScore(lines: OcrLine[]): number {
    const fields = this.extractFields(lines);
    const detectedFields = Object.values(fields).filter((field) => field.value).length;
    const confidence = lines.reduce((total, line) => total + line.mean, 0);
    return detectedFields * 10
      + (fields.containerId.value ? 100 : 0)
      + (this.validateContainerId(fields.containerId.value) ? 100 : 0)
      + confidence;
  }

  private cropPoint(event: PointerEvent): { x: number; y: number } | null {
    const canvas = (event.currentTarget as HTMLElement).closest('.crop-canvas');
    const image = canvas?.querySelector('img');
    if (!image) return null;
    const bounds = image.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return null;
    return {
      x: Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)),
      y: Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height)),
    };
  }

  private resizeCrop(handle: CropResizeHandle, crop: CropRect, point: { x: number; y: number }): void {
    const minimumSize = 0.02;
    let left = crop.x;
    let top = crop.y;
    let right = crop.x + crop.width;
    let bottom = crop.y + crop.height;
    if (handle === 'top-left' || handle === 'bottom-left') {
      left = Math.max(0, Math.min(point.x, right - minimumSize));
    } else {
      right = Math.min(1, Math.max(point.x, left + minimumSize));
    }
    if (handle === 'top-left' || handle === 'top-right') {
      top = Math.max(0, Math.min(point.y, bottom - minimumSize));
    } else {
      bottom = Math.min(1, Math.max(point.y, top + minimumSize));
    }
    this.cropDraft.set({ x: left, y: top, width: right - left, height: bottom - top });
  }

  protected cropResizeHandleLabel(handle: CropResizeHandle): string {
    return `Resize crop from ${handle.replace('-', ' ')}`;
  }

  protected rawScanPixelSize(scan: RawScan): string {
    if (scan.pixelCount >= 1_000_000) return `${this.formatPixelValue(scan.pixelCount / 1_000_000)} MP`;
    if (scan.pixelCount >= 1_000) return `${this.formatPixelValue(scan.pixelCount / 1_000)} kpx`;
    return `${scan.pixelCount} px`;
  }

  private formatPixelValue(value: number): string {
    return value >= 100 ? value.toFixed(0) : value >= 10 ? value.toFixed(1) : value.toFixed(2);
  }

  private async createSuggestedCrop(lines: OcrLine[], containerId: string, image: Blob, sourceSize?: { width: number; height: number }): Promise<CropRect | null> {
    const markingsBounds = this.suggestedMarkingBounds(lines, containerId);
    if (!markingsBounds) return null;

    const decodedImage = sourceSize ? null : await this.decodeImage(image);
    const width = sourceSize?.width ?? decodedImage!.width;
    const height = sourceSize?.height ?? decodedImage!.height;
    try {
      const padding = Math.max(24, Math.max(markingsBounds.right - markingsBounds.left, markingsBounds.bottom - markingsBounds.top) * 0.08);
      const leftPadding = Math.max(48, Math.max(markingsBounds.right - markingsBounds.left, markingsBounds.bottom - markingsBounds.top) * 0.12);
      const markingSize = Math.max(markingsBounds.right - markingsBounds.left, markingsBounds.bottom - markingsBounds.top);
      const isUnTank = lines.some((line) => /\bUN\s*TANK\b/i.test(line.text));
      const rightPadding = isUnTank ? Math.max(48, markingSize * 0.07) : Math.max(72, markingSize * 0.12);
      const left = Math.max(0, markingsBounds.left - leftPadding);
      const top = Math.max(0, markingsBounds.top - padding);
      const right = Math.min(width, markingsBounds.right + rightPadding);
      const bottom = Math.min(height, markingsBounds.bottom + padding);
      return {
        x: left / width,
        y: top / height,
        width: (right - left) / width,
        height: (bottom - top) / height,
      };
    } finally {
      decodedImage?.release();
    }
  }

  private suggestedMarkingBounds(lines: OcrLine[], containerId: string): BoxBounds | null {
    const cropAnchor = containerId || this.findContainerIdAnchor(lines);
    if (!cropAnchor) return null;
    const isIncompleteIdAnchor = !containerId;
    const idLines = this.linesForContainerId(lines, cropAnchor);
    const idBounds = this.combineBounds(idLines.map((line) => this.boxBounds(line.box)).filter((bounds): bounds is BoxBounds => Boolean(bounds)));
    if (!idBounds) return null;

    const idHeight = idBounds.bottom - idBounds.top;
    const relevantBounds = lines
      .map((line) => this.boxBounds(line.box))
      .filter((bounds): bounds is BoxBounds => Boolean(bounds))
      .filter((bounds) => bounds.bottom <= idBounds.top || bounds.top >= idBounds.bottom)
      .filter((bounds) => bounds.right >= idBounds.left && bounds.left <= idBounds.right);
    const markingsBounds = this.combineBounds([idBounds, ...relevantBounds]);
    if (!markingsBounds) return null;
    const right = isIncompleteIdAnchor
      ? idBounds.right + (idBounds.right - idBounds.left) / 10
      : idBounds.right;
    return { left: idBounds.left, top: markingsBounds.top, right, bottom: markingsBounds.bottom };
  }

  private findContainerIdAnchor(lines: OcrLine[]): string {
    // Server-only: UN tank marking plates, read through the server OCR engine, have occasionally
    // produced a single detection box covering the container ID that is many times taller than
    // the page's median line height (observed ~6x on a real photo, vs. ~2x for the tallest
    // legitimate same-row label) - likely the detector merging in surrounding clutter on a busy
    // plate. That fails `isLikelySingleOcrRow` outright and blocks anchor detection entirely,
    // even though the fragment's own text is already a clean, self-contained ID match needing no
    // stitching with any neighbor. Browser-mode OCR has not shown this failure mode, so this
    // bypass is scoped to UN tank images in server mode only, rather than loosening the
    // row-height check globally.
    // Checked on the space-stripped text, not with a `\bUN\s*TANK\b` word-boundary pattern: the
    // server engine has read "UN TANK T22" as "UNTANKT22" (no gap at all) on a real photo, which
    // fails any boundary-anchored match.
    const isUnTankImage = lines.some((line) => /UNTANK/i.test(line.text.replace(/\s+/g, '')));
    if (isUnTankImage && this.ocrService.mode() === 'server') {
      for (const line of lines) {
        const compact = line.text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        const fullMatch = compact.match(/[A-Z]{3}[UJZ]\d{7}/g)?.find((value) => this.validateContainerId(value));
        if (fullMatch) return fullMatch.slice(0, 10);
      }
      for (const line of lines) {
        const compact = line.text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        const partialMatch = compact.match(/^[A-Z]{3}[UJZ]\d{6}$/)?.[0];
        if (partialMatch) return partialMatch;
      }
    }
    const fragments = lines
      .map((line) => ({
        line,
        text: line.text.replace(/[^A-Z0-9]/gi, '').toUpperCase(),
        bounds: this.boxBounds(line.box),
      }))
      .filter((fragment) => fragment.text && fragment.bounds && this.isLikelySingleOcrRow(fragment.line, lines))
      .sort((first, second) => first.bounds!.top - second.bounds!.top || first.bounds!.left - second.bounds!.left);
    let partialAnchor = '';
    for (let start = 0; start < fragments.length; start++) {
      for (let length = 1; length <= 3 && start + length <= fragments.length; length++) {
        const candidateFragments = fragments.slice(start, start + length);
        if (!candidateFragments.every((fragment) => this.sameOcrRow(candidateFragments[0], fragment))) continue;
        const candidate = candidateFragments.map((fragment) => fragment.text).join('');
        const compactCandidate = candidate.replace(/[^A-Z0-9]/gi, '').toUpperCase();
        const candidatePattern = candidateFragments.length === 1
          ? /[A-Z]{3}[UJZ]\d{7}/g
          : /^[A-Z]{3}[UJZ]\d{7}$/;
        const fullMatch = compactCandidate.match(candidatePattern)?.find((value) => this.validateContainerId(value));
        if (fullMatch) return fullMatch.slice(0, 10);
        const partialPattern = candidateFragments.length === 1
          ? /[A-Z]{3}[UJZ]\d{6}/
          : /^[A-Z]{3}[UJZ]\d{6}$/;
        const partialMatch = compactCandidate.match(partialPattern)?.[0];
        if (partialMatch && !partialAnchor) partialAnchor = partialMatch;
      }
    }
    return partialAnchor;
  }

  private containerIdConfidence(lines: OcrLine[], containerId: string): number | undefined {
    const normalizedId = containerId.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    return lines
      .filter((line) => line.text.replace(/[^A-Z0-9]/gi, '').toUpperCase().includes(normalizedId))
      .sort((first, second) => second.mean - first.mean)[0]?.mean;
  }

  private linesForContainerId(lines: OcrLine[], containerId: string): OcrLine[] {
    const normalizedId = containerId.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const fragments = lines
      .map((line) => ({
        line,
        text: line.text.replace(/[^A-Z0-9]/gi, '').toUpperCase(),
        bounds: this.boxBounds(line.box),
      }))
      .filter((fragment) => fragment.text && fragment.bounds)
      .sort((first, second) => first.bounds!.top - second.bounds!.top || first.bounds!.left - second.bounds!.left);
    for (let start = 0; start < fragments.length; start++) {
      for (let length = 1; length <= 3 && start + length <= fragments.length; length++) {
        const candidate = fragments.slice(start, start + length);
        if (!candidate.every((fragment) => this.sameOcrRow(candidate[0], fragment))) continue;
        if (candidate.map((fragment) => fragment.text).join('').includes(normalizedId)) {
          return candidate.map((fragment) => this.narrowLineToContainerId(fragment.line, normalizedId));
        }
      }
    }
    return [];
  }

  private boxBounds(box: number[][] | undefined): BoxBounds | null {
    if (!box?.length) return null;
    const xs = box.map(([x]) => x);
    const ys = box.map(([, y]) => y);
    return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
  }

  private combineBounds(bounds: BoxBounds[]): BoxBounds | null {
    if (!bounds.length) return null;
    return {
      left: Math.min(...bounds.map((bound) => bound.left)),
      top: Math.min(...bounds.map((bound) => bound.top)),
      right: Math.max(...bounds.map((bound) => bound.right)),
      bottom: Math.max(...bounds.map((bound) => bound.bottom)),
    };
  }

  private async createCropPass(image: Blob, crop: CropRect, scale: number, maximumWidth?: number, maximumPixels?: number): Promise<{ url: string; offsetX: number; offsetY: number; scale: number; revokeUrl: boolean; pixelCount: number }> {
    const decodedImage = await this.decodeImage(image);
    try {
      return await this.createCropPassFromSource(decodedImage.source, decodedImage.width, decodedImage.height, crop, scale, maximumWidth, maximumPixels);
    } finally {
      decodedImage.release();
    }
  }

  private async createThumbnail(image: Blob): Promise<Blob> {
    const decodedImage = await this.decodeImage(image);
    const scale = Math.min(1, THUMBNAIL_MAX_DIMENSION / Math.max(decodedImage.width, decodedImage.height));
    const canvas = document.createElement('canvas');
    try {
      canvas.width = Math.max(1, Math.round(decodedImage.width * scale));
      canvas.height = Math.max(1, Math.round(decodedImage.height * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error(`Canvas 2D context is unavailable (canvas=${canvas.width}x${canvas.height}).`);
      context.drawImage(decodedImage.source, 0, 0, canvas.width, canvas.height);
      return await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error(`Thumbnail could not be created (canvas=${canvas.width}x${canvas.height}).`));
      }, 'image/jpeg', THUMBNAIL_JPEG_QUALITY));
    } finally {
      canvas.width = 0;
      canvas.height = 0;
      decodedImage.release();
    }
  }

  private async createCropPassFromSource(source: CanvasImageSource, imageWidth: number, imageHeight: number, crop: CropRect, scale: number, maximumWidth?: number, maximumPixels?: number): Promise<{ url: string; offsetX: number; offsetY: number; scale: number; revokeUrl: boolean; pixelCount: number }> {
    const sourceX = Math.round(crop.x * imageWidth);
    const sourceY = Math.round(crop.y * imageHeight);
    const sourceWidth = Math.max(1, Math.round(crop.width * imageWidth));
    const sourceHeight = Math.max(1, Math.round(crop.height * imageHeight));
    const outputScale = this.cropOutputScale(sourceWidth, sourceHeight, scale, maximumWidth, this.runtimeCropPixelBudget(maximumPixels));
    const baseWidth = Math.max(1, Math.round(sourceWidth * outputScale));
    const baseHeight = Math.max(1, Math.round(sourceHeight * outputScale));
    const canvas = document.createElement('canvas');
    try {
      canvas.width = baseWidth;
      canvas.height = baseHeight;
      const context = canvas.getContext('2d');
      if (!context) throw new Error(`Canvas 2D context is unavailable (canvas=${canvas.width}x${canvas.height}).`);
      context.drawImage(source, sourceX, sourceY, sourceWidth, sourceHeight, 0, 0, baseWidth, baseHeight);
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((result) => {
        if (result) resolve(result);
        else reject(new Error(`Manual crop could not be created (canvas=${canvas.width}x${canvas.height}).`));
      }, 'image/png'));
      return { url: URL.createObjectURL(blob), offsetX: sourceX, offsetY: sourceY, scale: outputScale, revokeUrl: true, pixelCount: baseWidth * baseHeight };
    } finally {
      // Reset dimensions to release this large backing store before the next image pass.
      canvas.width = 0;
      canvas.height = 0;
    }
  }

  private narrowLineToContainerId(line: OcrLine, containerId: string): OcrLine {
    const source = line.text.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const target = containerId.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const start = source.indexOf(target);
    const bounds = this.boxBounds(line.box);
    if (start < 0 || !bounds || !source.length) return line;
    const left = bounds.left + (bounds.right - bounds.left) * start / source.length;
    const right = bounds.left + (bounds.right - bounds.left) * (start + target.length) / source.length;
    return {
      ...line,
      box: [[left, bounds.top], [right, bounds.top], [right, bounds.bottom], [left, bounds.bottom]],
    };
  }

  private isLikelySingleOcrRow(line: OcrLine, lines: OcrLine[]): boolean {
    const bounds = this.boxBounds(line.box);
    if (!bounds) return false;
    const heights = lines
      .map((candidate) => this.boxBounds(candidate.box))
      .filter((candidate): candidate is BoxBounds => Boolean(candidate))
      .map((candidate) => candidate.bottom - candidate.top)
      .sort((first, second) => first - second);
    if (!heights.length) return true;
    const medianHeight = heights[Math.floor((heights.length - 1) / 2)];
    // Server-only: a short fragment's detection box can legitimately run a bit taller relative to
    // the page's median line height with server-mode PaddleOCR than with the browser engine
    // (observed splitting a 4-char owner code like "AGZU" into its own slightly-taller box, at
    // ~1.8x median, instead of merging it with the following digits) without actually spanning
    // multiple rows. The browser path keeps its original, stricter ratio.
    const ratio = this.ocrService.mode() === 'server' ? 2.0 : 1.75;
    return bounds.bottom - bounds.top <= medianHeight * ratio;
  }

  private sameOcrRow(first: { bounds: BoxBounds | null }, second: { bounds: BoxBounds | null }): boolean {
    if (!first.bounds || !second.bounds) return false;
    const firstHeight = first.bounds.bottom - first.bounds.top;
    const secondHeight = second.bounds.bottom - second.bounds.top;
    const firstCenter = (first.bounds.top + first.bounds.bottom) / 2;
    const secondCenter = (second.bounds.top + second.bounds.bottom) / 2;
    return Math.abs(firstCenter - secondCenter) <= Math.min(firstHeight, secondHeight) * 0.5;
  }

  // Server-only (see call site in extractFields): merges OCR fragments that sit on the same
  // visual row into one combined line, before any field-specific parsing runs. The server engine
  // (PaddleOCR) splits a label and its value into separate detection boxes where the browser's
  // ONNX pipeline keeps them as one line, and draws disproportionately tall boxes for short label
  // words - which breaks both same-line regexes (label and value no longer share one string) and
  // center-based "is this line above or below the label" comparisons (a tall label box's center
  // drifts toward the next row). Vertical overlap between boxes, not their center distance, is
  // used here specifically because it stays reliable even when one box is abnormally tall.
  private mergeLinesByRow(lines: OcrLine[]): OcrLine[] {
    const entries = lines.map((line, index) => ({ line, index, bounds: this.boxBounds(line.box) }));
    const parent = entries.map((entry) => entry.index);
    const find = (index: number): number => {
      while (parent[index] !== index) {
        parent[index] = parent[parent[index]];
        index = parent[index];
      }
      return index;
    };
    const union = (first: number, second: number) => {
      const firstRoot = find(first);
      const secondRoot = find(second);
      if (firstRoot !== secondRoot) parent[firstRoot] = secondRoot;
    };
    // Two boxes belong to the same visual row only if ALL of these hold:
    // - they overlap vertically (plain overlap ratio alone is NOT reliable: a genuine label+value
    //   split can measure as low as ~0.5-0.6 while two distinct-but-tightly-spaced rows in dense
    //   tank-marking layouts can measure ~0.4-0.46 on a real image - there is no safe cutoff
    //   between those two using this signal alone);
    // - they do NOT overlap horizontally (real label+value fragments sit side by side, left to
    //   right; two different rows that happen to be tall and close together instead share the
    //   same left margin/column and overlap heavily in x);
    // - the horizontal gap between them is small relative to their height (a few character
    //   widths, like a real label-to-value gap). Without this, a cluttered/noisy photo (lots of
    //   small, scattered misread fragments from background text/other plates) chains fragments
    //   transitively across the ENTIRE image into one giant merged line, since "no x overlap +
    //   some y overlap" alone has no sense of distance - observed on a real UN-tank photo.
    const sameRow = (first: BoxBounds, second: BoxBounds): boolean => {
      const verticalOverlap = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
      const minHeight = Math.min(first.bottom - first.top, second.bottom - second.top);
      const verticallyAligned = minHeight > 0 && verticalOverlap / minHeight >= 0.3;
      const horizontalOverlap = Math.min(first.right, second.right) - Math.max(first.left, second.left);
      const maxHeight = Math.max(first.bottom - first.top, second.bottom - second.top);
      const closeEnough = horizontalOverlap <= 0 && -horizontalOverlap <= maxHeight * 5;
      return verticallyAligned && closeEnough;
    };
    for (let first = 0; first < entries.length; first++) {
      if (!entries[first].bounds) continue;
      for (let second = first + 1; second < entries.length; second++) {
        if (!entries[second].bounds) continue;
        if (sameRow(entries[first].bounds!, entries[second].bounds!)) {
          union(first, second);
        }
      }
    }
    const groups = new Map<number, typeof entries>();
    for (const entry of entries) {
      const root = find(entry.index);
      const group = groups.get(root);
      if (group) group.push(entry);
      else groups.set(root, [entry]);
    }
    const merged = [...groups.values()].map((group) => {
      if (group.length === 1) return group[0].line;
      const sorted = [...group].sort((first, second) => (first.bounds?.left ?? 0) - (second.bounds?.left ?? 0));
      const bounds = this.combineBounds(sorted.map((entry) => entry.bounds).filter((bounds): bounds is BoxBounds => Boolean(bounds)));
      const box = bounds
        ? [[bounds.left, bounds.top], [bounds.right, bounds.top], [bounds.right, bounds.bottom], [bounds.left, bounds.bottom]]
        : sorted[0].line.box;
      return {
        text: sorted.map((entry) => entry.line.text).join(' '),
        mean: sorted.reduce((sum, entry) => sum + entry.line.mean, 0) / sorted.length,
        box,
      };
    });
    return merged.sort((first, second) => {
      const firstBounds = this.boxBounds(first.box);
      const secondBounds = this.boxBounds(second.box);
      return (firstBounds?.top ?? 0) - (secondBounds?.top ?? 0) || (firstBounds?.left ?? 0) - (secondBounds?.left ?? 0);
    });
  }


  private cropOutputScale(sourceWidth: number, sourceHeight: number, requestedScale: number, maximumWidth?: number, maximumPixels?: number): number {
    const widthScale = maximumWidth ? maximumWidth / sourceWidth : Number.POSITIVE_INFINITY;
    const pixelScale = maximumPixels ? Math.sqrt(maximumPixels / (sourceWidth * sourceHeight)) : Number.POSITIVE_INFINITY;
    return Math.min(requestedScale, widthScale, pixelScale);
  }

  private runtimeCropPixelBudget(configuredMaximumPixels?: number): number | undefined {
    if (!configuredMaximumPixels || typeof performance === 'undefined') return configuredMaximumPixels;

    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    if (!memory || !Number.isFinite(memory.usedJSHeapSize) || !Number.isFinite(memory.jsHeapSizeLimit)) {
      return configuredMaximumPixels;
    }

    // Keep most free heap available for the source image, OCR worker, and other transient buffers.
    const availableBytes = Math.max(0, memory.jsHeapSizeLimit - memory.usedJSHeapSize);
    const availablePixels = Math.max(1, Math.floor((availableBytes * CROP_MEMORY_HEADROOM) / CROP_BYTES_PER_PIXEL));
    return Math.min(configuredMaximumPixels, availablePixels);
  }

  private async decodeImage(image: Blob): Promise<DecodedImage> {
    try {
      const bitmap = await createImageBitmap(image);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close() };
    } catch (error: unknown) {
      throw new Error(`Unable to decode the source image (type=${image.type || 'unknown'}, size=${Math.round(image.size / 1024)}KiB, ImageBitmap=${this.errorMessage(error)}).`);
    }
  }

  private deduplicateLines(lines: OcrLine[]): OcrLine[] {
    const retained: OcrLine[] = [];
    for (const line of lines) {
      const normalized = line.text.replace(/\s/g, '').toUpperCase();
      const duplicate = retained.find((existing) => existing.text.replace(/\s/g, '').toUpperCase() === normalized);
      if (!duplicate) {
        retained.push(line);
      } else if (line.mean > duplicate.mean) {
        retained[retained.indexOf(duplicate)] = line;
      }
    }
    return retained;
  }

  private createJsonPayload() {
    const fields = this.fields();
    const warnings = this.diagnostics().map((diagnostic) => `${diagnostic.stage}: ${diagnostic.message}`);
    if (fields.containerId.value && !this.containerIdValid()) {
      warnings.push('Container ID does not pass ISO 6346 format and check-digit validation.');
    }
    return {
      source: {
        fileName: this.sourceName(),
        processedAt: new Date().toISOString(),
        manualCrop: this.cropRect(),
      },
      container: {
        maxWorkingPressure: { bar: fields.maxWorkingPressureBar, psi: fields.maxWorkingPressurePsi },
        id: { ...fields.containerId, iso6346Valid: this.containerIdValid() },
        isoCode: fields.isoCode,
        unTank: {
          approvalCode: fields.approvalCode,
          applicableRegulations: fields.applicableRegulations,
          tankCode: fields.tankCode,
          kemlerCode: fields.kemlerCode,
          unNumber: fields.unNumber,
        },
        mpgm: { kg: fields.mpgmKg, lb: fields.mpgmLb },
        tare: { kg: fields.tareKg, lb: fields.tareLb },
        payload: { kg: fields.payloadKg, lb: fields.payloadLb },
        capacity: {
          liters: fields.capacityLiters,
          usGallons: fields.capacityUsGallons,
          cubicMeters: fields.capacityCubicMeters,
          cubicFeet: fields.capacityCubicFeet,
        },
      },
      warnings,
      rawText: this.rawText(),
    };
  }

  private openSavedRecordsDatabase(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('container-mark-reader', 2);
      request.onupgradeneeded = (event) => {
        const database = request.result;
        const transaction = request.transaction;
        if (!database.objectStoreNames.contains('records')) {
          database.createObjectStore('records', { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains('images')) {
          database.createObjectStore('images', { keyPath: 'id' });
        }
        if (event.oldVersion < 2 && transaction) {
          const records = transaction.objectStore('records');
          const images = transaction.objectStore('images');
          records.openCursor().onsuccess = (event) => {
            const cursor = (event.target as IDBRequest<IDBCursorWithValue | null>).result;
            if (!cursor) return;
            const record = cursor.value as StoredRecord;
            if (record.image instanceof Blob) {
              images.put({ id: record.id, image: record.image });
              delete record.image;
              record.hasImage = true;
              cursor.update(record);
            }
            cursor.continue();
          };
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  private extractFields(rawLines: OcrLine[]): Record<FieldKey, ContainerField> {
    const isServerMode = this.ocrService.mode() === 'server';
    // Server-only: merges same-row OCR fragments before any parsing below runs (see
    // mergeLinesByRow). The browser path is untouched - same raw lines as before.
    const lines = isServerMode ? this.mergeLinesByRow(rawLines) : rawLines;
    const fields: Record<FieldKey, ContainerField> = {
      maxWorkingPressureBar: { value: '', unit: 'BAR' }, maxWorkingPressurePsi: { value: '', unit: 'PSI' },
      containerId: { value: '' }, isoCode: { value: '' },
      approvalCode: { value: '' }, applicableRegulations: { value: '' }, tankCode: { value: '' },
      kemlerCode: { value: '' }, unNumber: { value: '' },
      mpgmKg: { value: '', unit: 'KG' }, mpgmLb: { value: '', unit: 'LB' },
      tareKg: { value: '', unit: 'KG' }, tareLb: { value: '', unit: 'LB' },
      payloadKg: { value: '', unit: 'KG' }, payloadLb: { value: '', unit: 'LB' },
      capacityLiters: { value: '', unit: 'L' },
      capacityUsGallons: { value: '', unit: 'US GAL' },
      capacityCubicMeters: { value: '', unit: 'CU.M.' },
      capacityCubicFeet: { value: '', unit: 'CU.FT.' },
    };
    const text = lines.map((line) => ({ ...line, normalized: line.text.toUpperCase().replace(/[|]/g, 'I') }));
    const find = (pattern: RegExp) => text.find((line) => pattern.test(line.normalized));
    const idCandidates = text.flatMap((line) => {
      const match = line.normalized.match(/\b([A-Z]{3}[UJZ])\s*((?:\d\s*){5}\d)\s*(\d)?\b/);
      if (!match) return [];
      const stem = `${match[1]}${match[2].replace(/\s/g, '')}`;
      const checkDigit = match[3] ?? '';
      return [{ line, stem, value: checkDigit ? `${stem}${checkDigit}` : '' }];
    });
    const validId = idCandidates.find((candidate) => candidate.value && this.validateContainerId(candidate.value));
    if (validId) {
      fields.containerId = { value: validId.value, confidence: validId.line.mean };
    } else {
      const idFragments = text
        .map((line) => ({
          ...line,
          fragment: line.normalized.replace(/[^A-Z0-9]/g, ''),
          bounds: this.boxBounds(line.box),
        }))
        .filter((line) => line.fragment && line.bounds)
        .sort((first, second) => first.bounds!.top - second.bounds!.top || first.bounds!.left - second.bounds!.left);
      const sameRow = (first: typeof idFragments[number], second: typeof idFragments[number]) => {
        return this.sameOcrRow(first, second);
      };
      for (let start = 0; start < idFragments.length && !fields.containerId.value; start++) {
        for (let length = 2; length <= 3 && start + length <= idFragments.length; length++) {
          const candidate = idFragments.slice(start, start + length);
          if (!candidate.every((line) => sameRow(candidate[0], line))) continue;
          const compactCandidate = candidate.map((line) => line.fragment).join('').toUpperCase();
          const recovered = compactCandidate.match(/^[A-Z]{3}[UJZ]\d{7}$/)?.[0];
          if (recovered && this.validateContainerId(recovered)) {
            fields.containerId = {
              value: recovered,
              confidence: Math.min(...candidate.map((line) => line.mean)),
            };
            break;
          }
        }
      }
    }
    // Server-only: a strict `\bUN\s*TANK\b` misses "UNTANKT22" (no gap at all, read that way by
    // the server engine on a real photo). The browser path keeps the original, stricter pattern.
    const unTankIndex = isServerMode
      ? text.findIndex((line) => /UNTANK/i.test(line.normalized.replace(/\s+/g, '')))
      : text.findIndex((line) => /\bUN\s*TANK\b/.test(line.normalized));
    const isoLine = unTankIndex < 0 ? find(/\b[0-9]{2}[A-Z][0-9A-Z]\b/) : undefined;
    if (isoLine) {
      fields.isoCode = { value: isoLine.normalized.match(/\b[0-9]{2}[A-Z][0-9A-Z]\b/)![0], confidence: isoLine.mean };
    }

    if (unTankIndex >= 0) {
      const tankLine = text[unTankIndex];
      const tankRemainder = tankLine.normalized.split(/\bUN\s*TANK\b/)[1]?.replace(/^\s*[:.-]?\s*/, '').trim() ?? '';
      // Server-only: the gap between the approval code and the regulations text that follows it
      // (e.g. "58K2 RID-ADR-IMDG") has been observed missing in the server engine's output (e.g.
      // "58K2RID-ADR-IMDG") on the same physical plate. `\s*[-:.]?\s*` accepts both, but is loose
      // enough on its own to also match short unrelated noise fragments - requiring a known
      // UN-tank regulation code right after is what actually distinguishes a genuine
      // approval-code line from that noise. The browser path keeps the original, stricter pattern.
      const approvalPattern = isServerMode
        ? /\b([0-9A-Z]{2})\s*([A-Z])\s*([0-9])\s*[-:.]?\s*(.+)$/
        : /\b([0-9A-Z]{2})\s*([A-Z])\s*([0-9])\b\s+(.+)$/;
      const isApprovalLine = (line: { normalized: string }) => {
        const match = line.normalized.match(approvalPattern);
        return Boolean(match && (!isServerMode || /\b(?:RID|ADR|IMDG)\b/.test(match[4])));
      };
      const approvalLine = text.find((line) => isApprovalLine(line));
      const approvalMatch = approvalLine?.normalized.match(approvalPattern);
      const regulationsValue = approvalMatch?.[4].replace(/^APPLICABLE\s+REGULATIONS\s*:?-?\s*/i, '').trim() ?? '';
      const tankCodeText = tankRemainder
        .replace(approvalMatch?.[0] ?? '', '')
        .trim();
      const tankCode = tankCodeText.match(/^([0-9A-Z][0-9A-Z./-]*)/)?.[1];
      if (approvalMatch && approvalLine) fields.approvalCode = { value: `${approvalMatch[1]}${approvalMatch[2]}${approvalMatch[3]}`, confidence: approvalLine.mean };
      if (regulationsValue && approvalLine) fields.applicableRegulations = { value: regulationsValue, confidence: approvalLine.mean };
      if (tankCode) fields.tankCode = { value: tankCode, confidence: tankLine.mean };

      const parseTankWeight = (line: typeof text[number]) => {
        const match = line.normalized.match(/(\d[\d ,.]*?)\s*KG\s*\/\s*(\d[\d ,.]*?)\s*[A-Z]+\b/);
        if (!match) return undefined;
        return {
          line,
          kg: { value: match[1].trim() },
          lb: { value: match[2].trim() },
        };
      };
      const tankWeightRows = text.flatMap((line) => {
        const match = parseTankWeight(line);
        return match ? [match] : [];
      });
      // Server-only: prefer the row's own label over raw position. Pure `[0]`/`[1]` indexing
      // breaks whenever only one of the two rows gets detected/read at all (observed on a real
      // server-mode scan: the gross-weight line was missing from both OCR passes entirely,
      // leaving a single row that then got wrongly attributed to "gross" by sitting at index 0 -
      // showing the tare reading as the gross weight instead of leaving gross blank). "RE WEIGHT"
      // (not just "TARE") is also accepted: the server engine has read "TARE WEIGHT" with the
      // leading "TA" missing on a real photo. The browser path keeps the original indexing.
      let gross: (typeof tankWeightRows)[number] | undefined;
      let tare: (typeof tankWeightRows)[number] | undefined;
      if (isServerMode) {
        const classifyTankWeightRow = (row: (typeof tankWeightRows)[number]): 'gross' | 'tare' | undefined => {
          if (/GROSS/.test(row.line.normalized)) return 'gross';
          if (/\bTARE\b|\bRE\s*WEIGHT\b/.test(row.line.normalized)) return 'tare';
          return undefined;
        };
        const explicitGross = tankWeightRows.find((row) => classifyTankWeightRow(row) === 'gross');
        const explicitTare = tankWeightRows.find((row) => classifyTankWeightRow(row) === 'tare');
        const unclassifiedWeightRows = tankWeightRows.filter((row) => row !== explicitGross && row !== explicitTare);
        gross = explicitGross ?? (explicitTare ? undefined : unclassifiedWeightRows[0]);
        tare = explicitTare ?? (explicitGross ? unclassifiedWeightRows[0] : unclassifiedWeightRows[1]);
      } else {
        gross = tankWeightRows[0];
        tare = tankWeightRows[1];
      }
      const capacityPattern = /(\d[\d ,.]*?)\s*L\b[^\d]*(\d[\d ,.]*?)\s*US\s*GAL\b/;
      let capacityIndex = -1;
      let capacityEndIndex = -1;
      let capacity: RegExpMatchArray | undefined;
      for (let index = 0; index < text.length; index++) {
        const sameLine = text[index].normalized.match(capacityPattern);
        if (sameLine) {
          capacityIndex = index;
          capacityEndIndex = index;
          capacity = sameLine;
          break;
        }
        const nextLine = text[index + 1];
        if (!nextLine) continue;
        const combined = `${text[index].normalized} ${nextLine.normalized}`.match(capacityPattern);
        if (combined) {
          capacityIndex = index;
          capacityEndIndex = index + 1;
          capacity = combined;
          break;
        }
      }
      const setTankWeight = (pair: ReturnType<typeof parseTankWeight>, kgKey: 'mpgmKg' | 'tareKg', lbKey: 'mpgmLb' | 'tareLb', line: typeof text[number] | undefined) => {
        if (!pair) return;
        fields[kgKey] = { value: pair.kg.value, unit: 'KG', confidence: line?.mean };
        fields[lbKey] = { value: pair.lb.value, unit: 'LB', confidence: line?.mean };
      };
      setTankWeight(gross, 'mpgmKg', 'mpgmLb', gross?.line);
      setTankWeight(tare, 'tareKg', 'tareLb', tare?.line);
      if (capacityIndex >= 0 && capacity) {
        const liters = capacity[1].trim().match(/[\d,.]+$/)?.[0] ?? capacity[1].trim();
        const gallons = capacity[2].trim().match(/[\d,.]+$/)?.[0] ?? capacity[2].trim();
        fields.capacityLiters = { value: liters, unit: 'L', confidence: text[capacityIndex].mean };
        fields.capacityUsGallons = { value: gallons, unit: 'US GAL', confidence: text[capacityIndex].mean };
      }
      const kemlerLine = capacityEndIndex >= 0 ? text[capacityEndIndex + 1] : undefined;
      const unNumberLine = capacityEndIndex >= 0 ? text[capacityEndIndex + 2] : undefined;
      if (kemlerLine) fields.kemlerCode = { value: kemlerLine.normalized.trim(), confidence: kemlerLine.mean };
      if (unNumberLine) fields.unNumber = { value: unNumberLine.normalized.replace(/^UN\s*/, '').trim(), confidence: unNumberLine.mean };
    }

    const weightAfter = (label: RegExp, unit: 'KG' | 'LB') => {
      const parseWeight = (line: OcrLine & { normalized: string }, source = line.normalized): { value: string; confidence: number; inferred?: boolean } | undefined => {
        const explicitWeights = /(?<value>\d[\d ,.]*?)\s*(?<unit>KG|LBS?)/g;
        for (const match of source.matchAll(explicitWeights)) {
          const firstUnit = match.groups?.['unit']?.startsWith('K') ? 'KG' : 'LB';
          if (firstUnit === unit) {
            return { value: match.groups?.['value']?.trim() ?? '', confidence: line.mean };
          }
          const end = (match.index ?? 0) + match[0].length;
          const paired = source.slice(end).match(/^\s*\/\s*(\d[\d ,.]*?)\s*([A-Z]+)/);
          if (!paired) continue;
          const readableUnit = paired[2] === 'KG' ? 'KG' : /^(?:LB|LBS)$/.test(paired[2]) ? 'LB' : undefined;
          const pairedUnit = readableUnit ?? (firstUnit === 'KG' ? 'LB' : 'KG');
          if (pairedUnit === unit) {
            return { value: paired[1].trim(), confidence: line.mean, inferred: !readableUnit };
          }
        }
        return undefined;
      };
      const labeledWeight = text
        .map((line) => {
          const labelMatch = line.normalized.match(label);
          const source = labelMatch?.index === undefined
            ? undefined
            : line.normalized.slice(labelMatch.index + labelMatch[0].length);
          return { line, match: source === undefined ? undefined : parseWeight(line, source) };
        })
        .filter(({ match }) => match)
        .sort((first, second) => second.line.mean - first.line.mean)[0];
      if (labeledWeight?.match) {
        return labeledWeight.match;
      }
      const labelIndex = text.findIndex((line) => label.test(line.normalized));
      if (labelIndex < 0) return undefined;
      const labelLine = text[labelIndex];
      const center = (line: OcrLine) => {
        if (!line.box?.length) return undefined;
        const [x, y] = line.box.reduce(([totalX, totalY], [pointX, pointY]) => [totalX + pointX, totalY + pointY], [0, 0]);
        return [x / line.box.length, y / line.box.length] as const;
      };
      const labelCenter = center(labelLine);
      if (labelCenter) {
        const closestWeight = text
          .map((line) => ({ line, match: parseWeight(line), center: center(line) }))
          .filter(({ match, center }) => match && center)
          .sort((first, second) => {
            // Container markings list a label before its weight rows; an earlier row belongs to the preceding label.
            const firstAboveLabel = first.center![1] < labelCenter[1] - 4;
            const secondAboveLabel = second.center![1] < labelCenter[1] - 4;
            if (firstAboveLabel !== secondAboveLabel) return firstAboveLabel ? 1 : -1;
            const firstDistance = Math.abs(first.center![1] - labelCenter[1]) * 10 + Math.abs(first.center![0] - labelCenter[0]);
            const secondDistance = Math.abs(second.center![1] - labelCenter[1]) * 10 + Math.abs(second.center![0] - labelCenter[0]);
            return firstDistance - secondDistance;
          })[0];
        if (closestWeight?.match) {
          return closestWeight.match;
        }
      }
      const nearby = text.slice(labelIndex);
      for (const line of nearby) {
        const match = parseWeight(line);
        if (match) {
          return match;
        }
      }
      return undefined;
    };
    const capacityAfter = (label: RegExp, unit: RegExp) => {
      const candidates: Array<{ value: string; confidence: number }> = [];
      for (let labelIndex = 0; labelIndex < text.length; labelIndex++) {
        if (!label.test(text[labelIndex].normalized)) continue;
        const nearby = text.slice(labelIndex, labelIndex + 4);
        for (const line of nearby) {
          const match = line.normalized.match(new RegExp(`(\\d[\\d ,.]*)\\s*${unit.source}`));
          if (match) {
            candidates.push({ value: match[1].trim(), confidence: line.mean });
          }
        }
      }
      for (const line of text) {
        const match = line.normalized.match(new RegExp(`(\\d[\\d ,.]*)\\s*${unit.source}`));
        if (match) candidates.push({ value: match[1].trim(), confidence: line.mean });
      }
      return candidates.sort((first, second) => second.confidence - first.confidence)[0];
    };
    const pressureAfter = (label: RegExp, unit: 'BAR' | 'PSI') => {
      const unitPattern = unit === 'BAR' ? /BAR\b/ : /PSI\b/;
      const candidates: Array<{ value: string; confidence: number }> = [];
      for (let labelIndex = 0; labelIndex < text.length; labelIndex++) {
        const labelMatch = text[labelIndex].normalized.match(label);
        if (!labelMatch || labelMatch.index === undefined) continue;
        const sameLine = text[labelIndex].normalized.slice(labelMatch.index + labelMatch[0].length);
        const nearby = [sameLine, ...text.slice(labelIndex + 1, labelIndex + 4).map((line) => line.normalized)];
        for (const source of nearby) {
          const match = source.match(new RegExp(`(\\d[\\d ,.]*)\\s*${unitPattern.source}`));
          if (match) candidates.push({ value: match[1].trim(), confidence: text[labelIndex].mean });
        }
      }
      return candidates.sort((first, second) => second.confidence - first.confidence)[0];
    };
    const grossLabel = /\bMPGM\b|\bMGW\b|GROSS\s*WEIGHT|\bMAX\.?\s*GR(?:[O0]SS)?\.?/;
    const mpgmKg = weightAfter(grossLabel, 'KG');
    const mpgmLb = weightAfter(grossLabel, 'LB');
    const tareKg = weightAfter(/\bTARE\b/, 'KG');
    const tareLb = weightAfter(/\bTARE\b/, 'LB');
    const payloadLabel = /\bPAY(?:LOAD|J?LAD|JLOAD)(?=\s|\d|$)|\bNET(?:\s*WEIGHT)?\b/;
    const payloadKg = weightAfter(payloadLabel, 'KG');
    const payloadLb = weightAfter(payloadLabel, 'LB');
    const capacityLiters = capacityAfter(/\bCAP(?:ACITY|CITY)\b|\bCAPAC\.?\b/, /L\b/);
    const capacityUsGallons = capacityAfter(/\bCAP(?:ACITY|CITY)\b|\bCAPAC\.?\b/, /US\s*GAL\b/);
    const capacityCubicMeters = capacityAfter(/\bCU\.?\s*CAP\.?/, /CU\.?\s*M\.?/);
    const capacityCubicFeet = capacityAfter(/\bCU\.?\s*CAP\.?/, /CU\.?\s*FT\.?/);
    const maxWorkingPressureBar = pressureAfter(/MAX\s*WORKING\s*PRESSURE/, 'BAR');
    const maxWorkingPressurePsi = pressureAfter(/MAX\s*WORKING\s*PRESSURE/, 'PSI');
    fields.maxWorkingPressureBar = { value: maxWorkingPressureBar?.value ?? '', unit: 'BAR', confidence: maxWorkingPressureBar?.confidence };
    fields.maxWorkingPressurePsi = { value: maxWorkingPressurePsi?.value ?? '', unit: 'PSI', confidence: maxWorkingPressurePsi?.confidence };
    if (unTankIndex < 0) {
      fields.mpgmKg = { value: mpgmKg?.value ?? '', unit: 'KG', confidence: mpgmKg?.confidence, inferred: mpgmKg?.inferred };
      fields.mpgmLb = { value: mpgmLb?.value ?? '', unit: 'LB', confidence: mpgmLb?.confidence, inferred: mpgmLb?.inferred };
      fields.tareKg = { value: tareKg?.value ?? '', unit: 'KG', confidence: tareKg?.confidence, inferred: tareKg?.inferred };
      fields.tareLb = { value: tareLb?.value ?? '', unit: 'LB', confidence: tareLb?.confidence, inferred: tareLb?.inferred };
    }
    fields.payloadKg = payloadKg
      ? { value: payloadKg.value, unit: 'KG', confidence: payloadKg.confidence, inferred: payloadKg.inferred }
      : { value: '', unit: 'KG' };
    fields.payloadLb = payloadLb
      ? { value: payloadLb.value, unit: 'LB', confidence: payloadLb.confidence, inferred: payloadLb.inferred }
      : { value: '', unit: 'LB' };
    this.recoverMissingWeightRows(fields, text);
    if (unTankIndex < 0) {
      fields.capacityLiters = { value: capacityLiters?.value ?? '', unit: 'L', confidence: capacityLiters?.confidence };
      fields.capacityUsGallons = { value: capacityUsGallons?.value ?? '', unit: 'US GAL', confidence: capacityUsGallons?.confidence };
    }
    fields.capacityCubicMeters = { value: capacityCubicMeters?.value ?? '', unit: 'CU.M.', confidence: capacityCubicMeters?.confidence };
    fields.capacityCubicFeet = { value: capacityCubicFeet?.value ?? '', unit: 'CU.FT.', confidence: capacityCubicFeet?.confidence };
    return fields;
  }

  private recoverMissingWeightRows(fields: Record<FieldKey, ContainerField>, lines: Array<OcrLine & { normalized: string }>): void {
    const hasGrossLabel = lines.some((line) => /\bMPGM\b|\bMGW\b|GROSS\s*WEIGHT|\bMAX\.?\s*GR\.?/.test(line.normalized));
    const hasTareLabel = lines.some((line) => /\bTARE\b/.test(line.normalized));
    const hasPayloadLabel = lines.some((line) => /\bPAY(?:LOAD|J?LAD|JLOAD)(?=\s|\d|$)|\bNET(?:\s*WEIGHT)?\b/.test(line.normalized));
    // A complete pair of unlabeled rows after gross weight is the only safe layout
    // to recover. A single missing label could simply mean no such marking exists.
    if (!hasGrossLabel || hasTareLabel || hasPayloadLabel) {
      return;
    }
    const grossIndex = lines.findIndex((line) => /\bMPGM\b|\bMGW\b|GROSS\s*WEIGHT|\bMAX\.?\s*GR\.?/.test(line.normalized));
    const unlabeledRows = lines
      .slice(grossIndex + 1)
      .filter((line) => !/\bMPGM\b|\bMGW\b|GROSS\s*WEIGHT|\bMAX\.?\s*GR\.?|\bTARE\b|\bPAY(?:LOAD|J?LAD|JLOAD)(?=\s|\d|$)|\bNET(?:\s*WEIGHT)?\b/.test(line.normalized))
      .map((line) => ({
        line,
        kg: line.normalized.match(/(\d[\d ,.]*)\s*KG/),
        lb: line.normalized.match(/(\d[\d ,.]*)\s*LB/),
        y: line.box ? line.box.reduce((total, [, y]) => total + y, 0) / line.box.length : Number.NaN,
      }))
      .filter((row) => row.kg || row.lb)
      .sort((first, second) => Number.isNaN(first.y) || Number.isNaN(second.y) ? 0 : first.y - second.y);
    const recover = (row: typeof unlabeledRows[number] | undefined, key: 'tareKg' | 'payloadKg', match: RegExpMatchArray | null) => {
      if (row && match && !fields[key].value) {
        fields[key] = { value: match[1].trim(), unit: 'KG', confidence: row.line.mean, inferred: true };
      }
    };
    const kgRows = unlabeledRows.filter((row) => row.kg);
    const firstKgIndex = unlabeledRows.findIndex((row) => row.kg);
    const firstKgHasLb = firstKgIndex >= 0 && Boolean(unlabeledRows[firstKgIndex].lb);
    const lbRows = unlabeledRows.filter((row, index) => row.lb && (firstKgHasLb ? index >= firstKgIndex : index > firstKgIndex));
    recover(kgRows[0], 'tareKg', kgRows[0]?.kg ?? null);
    recover(kgRows[1], 'payloadKg', kgRows[1]?.kg ?? null);
    if (lbRows[0]?.lb && !fields.tareLb.value) fields.tareLb = { value: lbRows[0].lb[1].trim(), unit: 'LB', confidence: lbRows[0].line.mean, inferred: true };
    if (lbRows[1]?.lb && !fields.payloadLb.value) fields.payloadLb = { value: lbRows[1].lb[1].trim(), unit: 'LB', confidence: lbRows[1].line.mean, inferred: true };
  }

  private formatContainerId(value: string): string {
    const normalized = value.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    return [normalized.slice(0, 4), normalized.slice(4, 10), normalized.slice(10, 11)]
      .filter(Boolean)
      .join(' ');
  }

  protected confidenceText(field: ContainerField): string {
    return field.confidence === undefined ? '' : `${Math.round(field.confidence * 100)}%`;
  }

  protected isLowConfidence(field: ContainerField): boolean {
    return field.confidence !== undefined && field.confidence < 0.85;
  }

  private validateContainerId(value: string): boolean {
    const normalized = value.replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z]{3}[UJZ]\d{7}$/.test(normalized)) return false;
    const expectedCheckDigit = this.containerIdCheckDigit(normalized.slice(0, 10));
    return expectedCheckDigit !== null && expectedCheckDigit === normalized[10];
  }

  private containerIdCheckDigit(stem: string): string | null {
    const normalized = stem.replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z]{3}[UJZ]\d{6}$/.test(normalized)) return null;
    const weights = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512];
    const letterValue = (letter: string) => {
      let value = letter.charCodeAt(0) - 55;
      // ISO 6346 skips 11, 22 and 33 in the letter value sequence.
      if (value >= 11) {
        value++;
      }
      if (value >= 22) {
        value++;
      }
      if (value >= 33) {
        value++;
      }
      return value;
    };
    const sum = normalized.slice(0, 10).split('').reduce((total, character, index) => {
      const value = /\d/.test(character) ? Number(character) : letterValue(character);
      return total + value * weights[index];
    }, 0);
    const checkDigit = (sum % 11) % 10;
    return String(checkDigit);
  }
}
