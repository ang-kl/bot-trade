// Primary card — Ultra Neo Glass: liquid glass panel with specular sheen.
// Material lives in .glass-panel (index.css); this stays a thin wrapper.

export default function Card({ children, className = '', ...rest }) {
  const cls = [
    'glass-panel',
    'px-4 py-3.5',
    'text-[var(--color-text)]',
    className,
  ].filter(Boolean).join(' ')
  return <div className={cls} {...rest}>{children}</div>
}
