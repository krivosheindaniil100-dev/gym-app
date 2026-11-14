/** MediaPipe Tasks (on-device, offline) – pose landmarks + body mask, face landmarks. */
import type { FaceLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';

const base = () => new URL(import.meta.env.BASE_URL + 'mediapipe/', location.href).href;

let filesetP: Promise<unknown> | null = null;
async function fileset() {
  const { FilesetResolver } = await import('@mediapipe/tasks-vision');
  filesetP ??= FilesetResolver.forVisionTasks(base() + 'wasm');
  return filesetP as ReturnType<typeof FilesetResolver.forVisionTasks>;
}

let poseP: Promise<PoseLandmarker> | null = null;
export async function getPose(): Promise<PoseLandmarker> {
  if (!poseP) {
    poseP = (async () => {
      const { PoseLandmarker } = await import('@mediapipe/tasks-vision');
      return PoseLandmarker.createFromOptions(await fileset(), {
        baseOptions: { modelAssetPath: base() + 'models/pose_landmarker_full.task', delegate: 'CPU' },
        runningMode: 'IMAGE',
        numPoses: 1,
        outputSegmentationMasks: true,
      });
    })();
  }
  return poseP;
}

let faceP: Promise<FaceLandmarker> | null = null;
export async function getFace(): Promise<FaceLandmarker> {
  if (!faceP) {
    faceP = (async () => {
      const { FaceLandmarker } = await import('@mediapipe/tasks-vision');
      return FaceLandmarker.createFromOptions(await fileset(), {
        baseOptions: { modelAssetPath: base() + 'models/face_landmarker.task', delegate: 'CPU' },
        runningMode: 'IMAGE',
        numFaces: 1,
        outputFacialTransformationMatrixes: true,
      });
    })();
  }
  return faceP;
}

/** Load a File into a canvas, downscaled so the long side ≤ maxSide (EXIF orientation is applied by the browser). */
export async function fileToCanvas(file: File, maxSide = 1600): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions).catch(() => createImageBitmap(file));
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}

export interface PoseResult {
  w: number;
  h: number;
  lm: { x: number; y: number; z: number; visibility?: number }[]; // normalized
  mask: Float32Array; // w*h, 0..1
}

export async function detectPose(c: HTMLCanvasElement): Promise<PoseResult | null> {
  const pose = await getPose();
  const r = pose.detect(c);
  if (!r.landmarks?.length) return null;
  const m = r.segmentationMasks?.[0];
  let mask = new Float32Array(c.width * c.height);
  let mw = c.width,
    mh = c.height;
  if (m) {
    mask = m.getAsFloat32Array().slice();
    mw = m.width;
    mh = m.height;
    m.close();
  }
  return { w: mw, h: mh, lm: r.landmarks[0], mask };
}
