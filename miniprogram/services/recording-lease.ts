// RecorderManager is a process singleton with no reliable offStop API.
// Callback handlers must check the active owner before consuming platform events.
let owner: object | null = null;
export const recordingLease = {
  acquire(candidate: object) {
    if (owner && owner !== candidate) return false;
    owner = candidate;
    return true;
  },
  owns(candidate: object) {
    return owner === candidate;
  },
  release(candidate: object) {
    if (owner === candidate) owner = null;
  },
};
