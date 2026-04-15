// Text input — themed via CSS variables. Extra DOM props (placeholder,
// name, id, disabled, aria-*, ...) flow through ...rest.

export default function Input({ value, onChange, type = 'text', className = '', ...rest }) {
  const cls =
    `block w-full rounded border bg-[var(--color-bg)] text-[var(--color-fg)] ` +
    `border-[var(--color-border)] px-2 py-1.5 text-sm placeholder:text-[var(--color-muted)] ` +
    `focus:outline-none focus:ring-2 focus:ring-[var(--color-up)]/40 ${className}`
  return <input type={type} value={value} onChange={onChange} className={cls.trim()} {...rest} />
}
