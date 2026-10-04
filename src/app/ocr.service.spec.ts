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

  describe('server modes', () => {
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

    it('should fall back to browser mode for an unrecognized stored value', () => {
      localStorage.setItem('ocr-mode', 'server');
      const service = TestBed.inject(OcrService);

      expect(service.mode()).toBe('browser');
    });

    it.each(['server-fast', 'server-accurate', 'server-node'] as const)(
      'should not initialize the local engine in %s mode',
      async (mode) => {
        const service = TestBed.inject(OcrService);
        service.setMode(mode);

        await service.initialize();

        expect(Ocr.create).not.toHaveBeenCalled();
      },
    );

    it('should persist the selected mode and re-initialize when switching back to browser', () => {
      const service = TestBed.inject(OcrService);
      vi.mocked(Ocr.create).mockResolvedValue({ detect: vi.fn() } as never);

      service.setMode('server-fast');
      expect(localStorage.getItem('ocr-mode')).toBe('server-fast');

      service.setMode('browser');
      expect(localStorage.getItem('ocr-mode')).toBe('browser');
      expect(Ocr.create).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['server-fast', true],
      ['server-accurate', true],
      ['server-node', false],
    ] as const)('isPaddleOcrEngine() reflects %s', (mode, expectedPaddle) => {
      const service = TestBed.inject(OcrService);
      service.setMode(mode);
      expect(service.isPaddleOcrEngine()).toBe(expectedPaddle);
    });

    it.each([
      ['server-fast', ':8000', 'fast'],
      ['server-accurate', ':8000', 'accurate'],
      ['server-node', ':8100', undefined],
    ] as const)('posts the cropped image to the %s endpoint and returns the parsed lines', async (mode, expectedPort, expectedProfile) => {
      const service = TestBed.inject(OcrService);
      service.setMode(mode);

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
      expect(serverUrl).toContain(expectedPort);
      expect(init?.method).toBe('POST');
      expect(init?.body).toBeInstanceOf(FormData);
      expect((init?.body as FormData).get('profile')).toBe(expectedProfile ?? null);
    });

    it('should throw a clear error when the server responds with a failure status', async () => {
      const service = TestBed.inject(OcrService);
      service.setMode('server-fast');

      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(new Blob(['fake-image'])))
        .mockResolvedValueOnce(new Response('', { status: 503, statusText: 'Service Unavailable' }));
      vi.stubGlobal('fetch', fetchMock);

      await expect(service.detect('blob:crop')).rejects.toThrow('503');
    });

    it('should throw a clear error when the server endpoint is unreachable', async () => {
      const service = TestBed.inject(OcrService);
      service.setMode('server-fast');

      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(new Blob(['fake-image'])))
        .mockRejectedValueOnce(new TypeError('Failed to fetch'));
      vi.stubGlobal('fetch', fetchMock);

      await expect(service.detect('blob:crop')).rejects.toThrow('Unable to reach the server OCR endpoint');
    });
  });

  describe('API host override', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    async function detectAndCaptureUrl(service: OcrService): Promise<string> {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(new Blob(['fake-image'])))
        .mockResolvedValueOnce(new Response(JSON.stringify({ lines: [] }), { status: 200 }));
      vi.stubGlobal('fetch', fetchMock);

      await service.detect('blob:crop');

      return fetchMock.mock.calls[1][0] as string;
    }

    it('should default to the prototype LAN IP when no override is stored', async () => {
      const service = TestBed.inject(OcrService);
      service.setMode('server-fast');

      expect(service.apiHost()).toBe('192.168.1.96');
      const url = await detectAndCaptureUrl(service);
      expect(url).toBe(`${window.location.protocol}//192.168.1.96:8000/ocr/detect`);
    });

    it('should fall back to the page hostname once the default is explicitly cleared', async () => {
      const service = TestBed.inject(OcrService);
      service.setMode('server-fast');
      service.setApiHost('');

      const url = await detectAndCaptureUrl(service);
      expect(url).toContain(`//${window.location.hostname}:8000/`);
    });

    it('should persist a bare hostname override and use it for server requests', async () => {
      const service = TestBed.inject(OcrService);
      service.setMode('server-node');
      service.setApiHost('192.168.1.42');

      expect(localStorage.getItem('ocr-api-host')).toBe('192.168.1.42');
      const url = await detectAndCaptureUrl(service);
      expect(url).toBe(`${window.location.protocol}//192.168.1.42:8100/ocr/detect`);
    });

    it('should extract only the hostname from a full URL override', async () => {
      const service = TestBed.inject(OcrService);
      service.setMode('server-fast');
      service.setApiHost('https://dev-machine.local:9000/some/path');

      const url = await detectAndCaptureUrl(service);
      expect(url).toBe(`${window.location.protocol}//dev-machine.local:8000/ocr/detect`);
    });

    it('should extract only the hostname from a "host:port" override', async () => {
      const service = TestBed.inject(OcrService);
      service.setMode('server-fast');
      service.setApiHost('192.168.1.42:9000');

      const url = await detectAndCaptureUrl(service);
      expect(url).toBe(`${window.location.protocol}//192.168.1.42:8000/ocr/detect`);
    });

    it('should revert to the page hostname when the override is cleared', () => {
      const service = TestBed.inject(OcrService);
      service.setApiHost('192.168.1.42');
      expect(localStorage.getItem('ocr-api-host')).toBe('192.168.1.42');

      service.setApiHost('');
      expect(service.apiHost()).toBe('');
      expect(localStorage.getItem('ocr-api-host')).toBeNull();
    });

    it('should trim whitespace around the override before persisting it', () => {
      const service = TestBed.inject(OcrService);
      service.setApiHost('  192.168.1.42  ');
      expect(service.apiHost()).toBe('192.168.1.42');
      expect(localStorage.getItem('ocr-api-host')).toBe('192.168.1.42');
    });

    it('should restore a previously persisted override for a new service instance', () => {
      localStorage.setItem('ocr-api-host', '192.168.1.42');
      const service = TestBed.inject(OcrService);
      expect(service.apiHost()).toBe('192.168.1.42');
    });
  });
});
