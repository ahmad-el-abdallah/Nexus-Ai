/** Isometric cube mark: three faces of a building block, violet to cyan. */
export function NexusMark({ className = "size-10" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden>
      <defs>
        <linearGradient id="nx-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#c4b5fd" />
          <stop offset="1" stopColor="#22d3ee" />
        </linearGradient>
        <linearGradient id="nx-left" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8b5cf6" />
          <stop offset="1" stopColor="#4c1d95" />
        </linearGradient>
        <linearGradient id="nx-right" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#22d3ee" />
          <stop offset="1" stopColor="#0e7490" />
        </linearGradient>
      </defs>
      <path d="M32 4 58 19 32 34 6 19Z" fill="url(#nx-top)" />
      <path d="M6 19 32 34V61L6 46Z" fill="url(#nx-left)" />
      <path d="M58 19 32 34V61L58 46Z" fill="url(#nx-right)" />
    </svg>
  );
}
