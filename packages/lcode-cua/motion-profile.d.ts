export type MotionPoint = readonly [number, number];
export interface MotionProfileOptions {
  profile?: "instant" | "smooth";
  maxSegments?: number;
  segmentPixels?: number;
  durationMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}
export declare function createMotionPath(
  from: MotionPoint,
  to: MotionPoint,
  options?: MotionProfileOptions,
): [number, number][];
export declare function executeMotionPath(
  driver: { moveTo(point: [number, number]): Promise<void> },
  from: MotionPoint,
  to: MotionPoint,
  options?: MotionProfileOptions,
): Promise<{ pointCount: number }>;
