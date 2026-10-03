# Container Mark Reader

## Utilisation

- Ouvrir l'[URL de l'application](https://gcatrans.github.io/test-ocr-onnx-develop/).
- Sélectionner « Auto » (rognage automatique, mode par défaut) ou « Manual » (rognage manuel).
- Cliquer sur « New » pour prendre une photo ou « Existing » pour sélectionner une photo existante.
- Pendant la prise de vue, suivre le guide de niveau : il devient vert lorsque le téléphone est aligné. La capture reste possible même si le téléphone est incliné.
- Rognage :
  - Manual : tracer un rectangle autour de la zone de marquages sans couper les caractères.
  - Auto : attendre qu'un identifiant complet ou partiel soit localisé, puis vérifier et redimensionner la zone proposée.
- Cliquer sur « Scan selected crop region ».
- Attendre l'affichage des résultats.
- Les résultats affichent, lorsque disponible, le pourcentage de confiance OCR dans une colonne distincte de l'unité et de l'icône de validation.
- Un identifiant partiel est conservé avec l'icône d'avertissement « ⚠ » ; les fragments OCR provenant de lignes différentes ne sont pas assemblés.
- Le texte OCR initial reste visible dans la section « Raw detected text », même si aucun rognage automatique n'est proposé.
- En cas d'erreur, relancer l'application et recommencer la procédure.

## Project Status

The Angular 22 PWA shell supports camera capture, device image selection, automatic crop suggestions, manual rectangle crops with previews and saved normalized coordinates, editable structured fields, ISO 6346 check-digit validation with targeted OCR recovery, same-row partial-ID detection, per-field confidence percentages, retained initial auto-crop OCR text, local saved records, and accessible technical diagnostics.

Auto mode first scans the full photo to suggest a crop; manual mode waits for a user-selected crop. OCR remains local, while explicitly saved records can be uploaded to the configured remote synchronization endpoint.

Current verification status: `111/111` unit tests passing, a successful production build, and `16/16` Playwright E2E tests passing.

## Camera Alignment

The camera preview provides advisory roll guidance. It combines:

- Visual analysis of strong horizontal edges in the preview.
- Device orientation as a fallback when visual evidence is insufficient.
- Screen-orientation normalization for portrait, landscape, and upside-down device orientations.

The capture button remains enabled when the camera is tilted. A warning is shown when the estimated roll exceeds approximately 3 degrees. Captures with a reliable roll between 0.5 and 10 degrees are automatically rotated for the OCR working image. The corrected working image is used for the preview, crop selection, and OCR; the original camera image remains unchanged for saving. Perspective correction is not currently applied.

## Photo Sources

The user can provide an image in two ways:

- **Existing**: select an image from the device.
- **New**: capture an image with the device camera. The rear camera is preferred, with an ideal capture size of 1920 x 1080 pixels.

For an existing image, the application:

1. Verifies that the selected file has an `image/*` MIME type.
2. Keeps the original `Blob` in memory.
3. Creates a preview object URL.
4. Clears previous OCR fields and detected text.
5. Resets the crop to the full image.
6. Displays the image in the crop editor.

The original file is not replaced by a resized OCR image.

## Crop Modes

The application selects **Auto** by default. The user can change the mode before selecting an image. Changing the mode after an image has already been selected only changes the selected mode; it does not automatically restart processing for the existing image.

### Manual Crop Mode

After a photo is selected in Manual mode:

- Automatic OCR does not start.
- The user draws a rectangle around the container ID and markings.
- The rectangle can be resized using its four corner handles.
- Crop coordinates are stored as normalized values from `0` to `1` relative to the original image.
- A crop smaller than 2% of the image width or height is rejected.
- The user starts OCR with **Scan selected crop region**.

The selected region is processed with a requested scale of `1x`, followed by an **Enlarged** pass with a requested scale of `2x`. Both passes are capped at 4,000,000 output pixels and are also constrained by the optional runtime memory budget.

Consequences:

- A crop at or below 4 MP is normally processed at its original dimensions during the first pass.
- A crop larger than 4 MP is downscaled to approximately 4 MP or less.
- A small crop can be enlarged during the second pass to improve character recognition.
- A crop already near or above 4 MP may remain approximately the same size or be reduced.

Both passes are processed sequentially. The temporary OCR image from one pass is released before the next pass is created. Results from both passes are combined and duplicate detected text is removed.

### Auto Crop Mode

After a photo is selected in Auto mode:

1. The application waits for the preview image to finish loading.
2. It scans the full photo to locate the container ID and nearby markings.
3. The full-photo OCR pass is limited to 4,000,000 output pixels.
4. If that pass fails, it retries with a 1,000,000-pixel limit.
5. Detected OCR boxes are mapped back to the original image dimensions.
6. A complete ISO 6346 container ID, or a same-row partial ID anchor, is accepted as a successful initial detection.
7. If a suitable ID and markings are found, the application proposes a crop around them.
8. The user can review and resize the proposed crop.

The suggested crop is not processed automatically. The user must press **Scan selected crop region**. At that point, the selected crop uses the two manual OCR passes described above.

The initial OCR result remains visible in the raw detected text section, including when no crop is proposed. If automatic detection cannot propose a crop, the user can draw one manually. If the user does not draw a crop, scanning processes the full image as the selected region.

## Image Processing

Resizing is based on decoded pixel dimensions, not the compressed file size in megabytes:

- A 3 MB JPEG can still be resized if its decoded dimensions exceed the pixel limit.
- A 10 MB JPEG may not be resized if its decoded dimensions are within the limit.
- A photo of 4000 x 2000 pixels contains 8 MP and is reduced for a 4 MP pass.
- A crop of 1000 x 800 pixels contains 0.8 MP and can be enlarged during the `2x` retry pass, subject to the 4 MP and memory limits.

The application does not use a device-wide free-memory API. If the browser exposes the non-standard `performance.memory` information, the application estimates a conservative temporary pixel budget from the available JavaScript heap. Otherwise, it uses the configured pixel limit.

For each OCR pass, the application:

1. Decodes the OCR working image using `ImageBitmap` when available. For camera captures, this is the rotation-corrected image; for selected files, it is the selected image.
2. Falls back to an HTML image element if `ImageBitmap` decoding fails.
3. Draws the required crop and scale onto a temporary canvas.
4. Encodes the canvas as a temporary PNG `Blob`.
5. Runs local OCR against the temporary object URL.
6. Revokes the object URL after the pass.
7. Releases the decoded bitmap and clears the canvas backing store.

The original image `Blob` remains available throughout the process and is not modified.

## Image Formats

The image picker accepts `image/*`, so it supports formats the user's browser can decode. JPEG (`image/jpeg`), PNG (`image/png`), and WebP (`image/webp`) are recommended and broadly supported for OCR. GIF (`image/gif`) is accepted when supported by the browser, but only its displayed frame is useful for OCR. HEIC/HEIF support depends on the device and browser; convert those photos to JPEG if the browser cannot load them.

## OCR Models

Browser OCR is provided by `@gutenye/ocr-browser`, an MIT-licensed browser implementation built on PaddleOCR and ONNX Runtime. Detector and recognizer sessions initialize during Angular application bootstrap. The package performs detector preprocessing, text-region extraction, recognition preprocessing, and CTC decoding on-device. OpenCV.js is shipped as a local static asset but is not used by the current crop workflow. The UI reports initialization and inference failures with the original technical details.

The active browser model bundle comes from the `@gutenye/ocr-models` npm package and is copied into the Angular build at:

- `/models/ch_PP-OCRv4_det_infer.onnx`
- `/models/ch_PP-OCRv4_rec_infer.onnx`
- `/models/ppocr_keys_v1.txt`

## OCR Engine Mode (Browser / Server)

A second "OCR:" selector beside the Crop mode selector lets the user choose,
at any time, between:

- **Navigateur** (default): the on-device pipeline described above.
- **Serveur**: each OCR pass POSTs its already-cropped/scaled working image to
  a server-side PaddleOCR API (see the sibling project
  `container-storage-mgmt-ocr-api`) instead of running inference locally. The
  response is parsed into the same `{ text, mean, box }` line shape used by
  the local engine, so structured field extraction, ISO 6346 validation, and
  diagnostics behave identically regardless of the selected mode.

The selection is persisted in `localStorage` (`ocr-mode`). Selecting
"Serveur" skips loading the local ONNX models/engine at startup; switching
back to "Navigateur" (re)initializes them on demand.

The server endpoint is a constant in `ocr.service.ts` (`OCR_SERVER_URL`,
currently a local-development placeholder) that production deployments must
replace with the enterprise server's reachable HTTPS endpoint, the same way
`REMOTE_API_URL` must be replaced for saved-result synchronization.

Known follow-ups (not yet implemented):

- Resizing images client-side before upload in server mode, to cap the data
  sent over the network. The current `MAX_*_PIXELS` constants already bound
  what is sent to the *local* engine but are not yet applied as a pre-upload
  size cap for the server path beyond that.
- Authentication for server mode: a future version will add Keycloak-based
  login (OIDC Authorization Code + PKCE) to the PWA, and `OcrService` will
  attach the resulting access token as `Authorization: Bearer <token>` on
  requests to `OCR_SERVER_URL`. Today no such header is sent.

## OCR Recovery

If the image preview fails to load, the application creates a fresh object URL and retries up to two times. After the retry limit is reached, it clears the preview and displays a diagnostic.

If OCR fails or times out:

- A single local OCR retry is attempted using the initialized OCR session.
- A normal-size Auto pass can additionally fall back from 4 MP to 1 MP.
- Memory-related failures display a recommendation to use a tighter crop or smaller photo.
- Decode failures report the image type, approximate file size, and decoder errors.

After the normal crop passes complete, the application accepts a container ID only when it has a valid ISO 6346 check digit. If no normal pass produces a valid ID, it automatically creates a targeted crop around the expected tenth character and runs a separate local OCR pass. The target is restricted to OCR fragments on the same baseline as the first ten ID characters, and only checksum-valid candidates are accepted. A same-row partial ID can still be shown when the check digit is unavailable; it is marked with a warning icon rather than a valid check mark. OCR fragments from different rows are not concatenated into a candidate ID.

The targeted crop is shown as a diagnostic preview and is included in the raw OCR scan list. It does not replace the normal OCR results.

## Structured Markings

The extracted result includes:

- Maximum working pressure in bar and PSI.
- Maximum gross weight (`MPGM`, `MGW`, or `MAX.GR.`) in kilograms and pounds.
- TARE and payload weights in kilograms and pounds.
- Capacity in printed liters, US gallons, cubic meters, and cubic feet.
- For UN tanks, the first two rows matching `number KG / number letters` are extracted as maximum gross weight and TARE. The first number is stored as kilograms and the second as pounds.
- For UN tanks, a row matching `number L / number US GAL` is extracted as capacity. The two OCR rows immediately following that row are extracted as the Kemler code and UN number.

For slash-paired weights, an unreadable second unit may be inferred from the readable first unit. Explicit units remain authoritative, and inferred fields are marked as inferred in the result.

The UN-tank pattern rules take precedence over positional assumptions and do not infer missing weight units. Rows that do not contain the required `KG` suffix and trailing letter suffix are ignored for UN-tank weight extraction.

## JSON Contract

One input image produces one JSON record. It includes source metadata, manual crop coordinates, `container.id`, ISO code, maximum working pressure in bar and PSI, maximum gross weight (`mpgm`, accepting printed `MPGM`, `MGW`, or `MAX.GR.`), TARE, payload, capacity values in their printed kg/lb/liter/US-gallon/cubic units, OCR confidence values when available, raw text, and warnings. Fields remain empty when their markings are absent.

## Local Records

Saving a result writes the JSON payload, a 160-pixel JPEG thumbnail, and the original image `Blob` to the browser's IndexedDB `container-mark-reader` database. The saved-result list loads record metadata and thumbnails; the full photo is loaded only after the user selects **View photo**.

New records are marked **Not saved remotely** and are uploaded in the background when connectivity is available. Uploads are oldest-first and use a multipart `POST` request containing:

- `clientRecordId`: the local IndexedDB record ID.
- `json`: the serialized OCR result.
- `image`: the original image Blob.
- `thumbnail`: the JPEG thumbnail.

A record is marked **Saved remotely** only after a successful 2xx response. Network failures, offline state, and non-2xx responses keep the record on the device and retry with increasing delays from 10 to 60 seconds. Synchronization resumes when the browser reports that it is online. The current development endpoint is `http://localhost:8080/api/saved-results`; production deployments must replace it with a reachable HTTPS endpoint and configure CORS, authentication, validation, deduplication, and server-side storage.

After OCR succeeds:

- Text from all completed passes is deduplicated.
- Structured container fields are extracted.
- A whole-number confidence percentage is shown for each extracted field when OCR provides one.
- The user can edit the extracted fields.
- The JSON record stores the source filename, processing time, crop coordinates, extracted fields, raw OCR text, and warnings.

The resized OCR copies and temporary canvases are not used as the saved full photo.

## Offline Deployment

The Angular service worker pre-caches application files, local ONNX assets, and ONNX Runtime WASM binaries. The Nginx Docker image supplies cross-origin isolation headers. OCR is configured to use one ONNX Runtime WASM thread to reduce memory use on mobile devices. Initial installation requires access to the static server; after assets are cached, browser-side work is offline.

## Installation en mode hors connexion

- Ouvrir l'[URL de l'application](https://gcatrans.github.io/test-ocr-onnx-develop/).
- Type de terminal (iOS recommandé) :
  - iOS : appuyer sur le bouton « Partager » de Safari, sélectionner « Ajouter à l'écran d'accueil », puis valider.
  - Android : ouvrir le menu du navigateur, sélectionner l'installation et ajouter le raccourci.
- Télécharger les [images de test](./images) (optionnel).
- Effectuer au moins une analyse avec les images de test pour télécharger tous les fichiers de l'application.
- Passer en mode avion.
- Vérifier que l'analyse des images de test fonctionne toujours.

## Testing

Run unit tests with:

```text
npm test
```

Run the complete Playwright E2E suite with:

```text
npm run test:e2e
```

Use a maximum command timeout of `240000` ms so the Chromium and WebKit suites can complete.

`playwright.config.ts` starts both the Angular dev server and the OCR API
(`container-storage-mgmt-api-ocr`, via its `docker-compose.e2e.yml`, requires
Docker) automatically if they are not already running, and reuses them
instead of restarting if they are (`reuseExistingServer`, disabled in CI). The
API's `/health` endpoint doubles as its readiness probe, so the first run
after a fresh checkout or an image change can take a few minutes (Docker
build + first-time PaddleOCR model download) before tests actually start.
Note: on Windows, the OCR API container is not reliably stopped when the test
run ends (a `docker compose up` process-teardown quirk) — stop it manually
with `docker compose -f container-storage-mgmt-api-ocr/docker-compose.e2e.yml down`
if you don't want it to keep running between sessions.

## Relevant Implementation

The documented behavior is implemented primarily in:

- `src/app/app.ts`
- `src/app/ocr.service.ts`
- `src/app/app.html`
- `src/app/app.css`
- `src/app/app.spec.ts`
- `e2e/container-markings.spec.ts`

## Improvements Backlog

1. Add text-region overlays to the crop editor.
2. Add glare and denoise variants after measuring failure cases on representative container photos.
3. Add a sample-image evaluation set and field-level accuracy benchmark.
4. Add model-version switching and offline cache status management.
