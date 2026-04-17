// Primary card - playbook 6.1.
// Surface bg, 1px border, 10px radius, 14px 16px padding, no shadow.

export default function Card({ children, className = '', ...rest }) {
  const cls = [
    'bg-[var(--color-surface)] border border-[var(--color-border)]',
    'rounded-[10px] px-4 py-3.5',
    'text-[var(--color-text)]',
    className,
  ].filter(Boolean).join(' ')
  return <div className={cls} {...rest}>{children}</div>
}
