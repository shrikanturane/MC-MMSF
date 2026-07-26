/** Capture rate asked of the agent. 10 fps is the support-grade target; H.264 keeps it affordable.
 *  Kept in its own module so the recorder and the service can share it without a circular import. */
export const DEFAULT_FPS = 10;
