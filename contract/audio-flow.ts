/** PCM transport budget, independent of the total length of a spoken reply. */
export const PCM_RATE = 24000;
export const PCM_BYTES_PER_SECOND = PCM_RATE * 2;
export const PLAYBACK_WINDOW_BYTES = PCM_BYTES_PER_SECOND * 4;
export const PLAYBACK_FRAME_BYTES = PCM_BYTES_PER_SECOND / 5;
