// Text input — Ultra Neo Glass inset field with neon focus ring.

export default function Input({ value, onChange, type = 'text', className = '', ...rest }) {
  const cls = [
    'block w-full rounded-[12px]',
    'glass-inset text-[var(--color-text)]',
    'px-3 py-2 text-[14px] min-h-[36px]',
    'placeholder:text-[var(--color-muted)]',
    'transition-shadow',
    'focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/50',
    'focus:border-[var(--color-accent)] focus:shadow-[var(--glow-accent)]',
    className,
  ].filter(Boolean).join(' ')
  return <input type={type} value={value} onChange={onChange} className={cls} {...rest} />
}
