import { TestBed } from '@angular/core/testing';
import Ocr from '@gutenye/ocr-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OcrService } from './ocr.service';

vi.mock('@gutenye/ocr-browser', () => ({
  default: { create: vi.fn() },
}));

describe('OcrService', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [OcrService] });
    vi.mocked(Ocr.create).mockReset();
  });

  it('should share one OCR initialization across concurrent callers', async () => {
    const service = TestBed.inject(OcrService);
    const engine = { detect: vi.fn() };
    vi.mocked(Ocr.create).mockResolvedValue(engine as never);

    await Promise.all([service.initialize(), service.initialize()]);

    expect(Ocr.create).toHaveBeenCalledTimes(1);
  });

  it('should retain an initialization failure without creating replacement sessions', async () => {
    const service = TestBed.inject(OcrService);
    vi.mocked(Ocr.create).mockRejectedValue(new Error('Model allocation failed'));

    await service.initialize();

    expect(service.initializationError()).toBe('Model allocation failed');
    await expect(service.detect('blob:crop')).rejects.toThrow('Model allocation failed');
    expect(Ocr.create).toHaveBeenCalledTimes(1);
  });

  describe('server mode', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it('should default to browser mode and initialize the local engine eagerly', async () => {
      const service = TestBed.inject(OcrService);
      vi.mocked(Ocr.create).mockResolvedValue({ detect: vi.fn() } as never);

      expect(service.mode()).toBe('browser');
      await service.initialize();

      expect(Ocr.create).toHaveBeenCalledTimes(1);
    });

    it('should not initialize the local engine while in server mode', async () => {
      const service = TestBed.inject(OcrService);
      service.setMode('server');

      await service.initialize();

      expect(Ocr.create).not.toHaveBeenCalled();
    });

    it('should persist the selected mode and re-initialize when switching back to browser', () => {
      const service = TestBed.inject(OcrService);
      vi.mocked(Ocr.create).mockResolvedValue({ detect: vi.fn() } as never);

      service.setMode('server');
      expect(localStorage.getItem('ocr-mode')).toBe('server');

      service.setMode('browser');
      expect(localStorage.getItem('ocr-mode')).toBe('browser');
      expect(Ocr.create).toHaveBeenCalledTimes(1);
    });

    it('should post the cropped image to the server endpoint and return the parsed lines', async () => {
      const service = TestBed.inject(OcrService);
      service.setMode('server');

      const blob = new Blob(['fake-image']);
      const lines = [{ text: 'CSQU3054383', mean: 0.97, box: [[0, 0], [10, 0], [10, 10], [0, 10]] }];
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(blob))
        .mockResolvedValueOnce(new Response(JSON.stringify({ lines }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      const result = await service.detect('blob:crop');

      expect(result).toEqual(lines);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0][0]).toBe('blob:crop');
      const [serverUrl, init] = fetchMock.mock.calls[1];
      expect(serverUrl).toContain('/ocr/detect');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBeInstanceOf(FormData);
    });

    it('should throw a clear error when the server responds with a failure status', async () => {
      const service = TestBed.inject(OcrService);
      service.setMode('server');

      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(new Blob(['fake-image'])))
        .mockResolvedValueOnce(new Response('', { status: 503, statusText: 'Service Unavailable' }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(service.detect('blob:crop')).rejects.toThrow('503');
    });

    it('should throw a clear error when the server endpoint is unreachable', async () => {
      const service = TestBed.inject(OcrService);
      service.setMode('server');

      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(new Blob(['fake-image'])))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'));
      vi.stubGlobal('fetch', fetchMock);

      await expect(service.detect('blob:crop')).rejects.toThrow('Unable to reach the server OCR endpoint');
    });
  });
});
