// Text input - playbook 6.2 interactive row style.
// 7px radius, border token, min 36px touch target.

export default function Input({ value, onChange, type = 'text', className = '', ...rest }) {
  const cls = [
    'block w-full rounded-[7px] border',
    'bg-[var(--color-surface)] text-[var(--color-text)]',
    'border-[var(--color-border)]',
    'px-2.5 py-2 text-[14px] min-h-[36px]',
    'placeholder:text-[var(--color-muted)]',
    'focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40',
    'focus:border-[var(--color-accent)]',
    className,
  ].filter(Boolean).join(' ')
  return <input type={type} value={value} onChange={onChange} className={cls} {...rest} />
}
