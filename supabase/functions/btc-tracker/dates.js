// Kept dependency-free: this module is shared verbatim with the Supabase
// edge-function build, which has no fs/path.
export const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
