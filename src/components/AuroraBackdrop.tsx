export function AuroraBackdrop() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 -z-10 overflow-hidden bg-slate-50 dark:bg-[#0B1120] transition-colors duration-300"
    >
      <div
        className="aurora-layer-a absolute -top-[28%] -left-[12%] h-[68vh] w-[68vw] rounded-full opacity-75 dark:opacity-90"
        style={{
          background:
            'radial-gradient(circle at center, rgba(59, 130, 246, 0.16) 0%, rgba(99, 102, 241, 0.08) 42%, transparent 72%)',
        }}
      />
      <div
        className="aurora-layer-b absolute -bottom-[26%] -right-[10%] h-[64vh] w-[64vw] rounded-full opacity-70 dark:opacity-85"
        style={{
          background:
            'radial-gradient(circle at center, rgba(139, 92, 246, 0.16) 0%, rgba(56, 189, 248, 0.08) 42%, transparent 72%)',
        }}
      />
      <div
        className="absolute inset-0 opacity-[0.025] dark:opacity-[0.04]"
        style={{
          backgroundImage:
            'radial-gradient(circle, currentColor 1px, transparent 1px)',
          backgroundSize: '28px 28px',
        }}
      />
    </div>
  );
}
