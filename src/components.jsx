import React, { useEffect, useRef } from 'react';
import { X, ChevronDown, Package, ArrowUpRight, ArrowDownLeft, ShoppingBag, RotateCcw } from 'lucide-react';

export function ProductArt({ product, large = false }) {
  return <div className={`product-art ${product.tone || 'sage'} ${large ? 'large' : ''}`} aria-hidden="true"><div className={`packaging ${product.style || 'bottle'}`}><span className="packaging-cap" /><span className="packaging-label">{product.brand?.split(' ')[0] || 'V'}<i /></span></div></div>;
}
export function Badge({ children, tone }) {
  const color = tone || ({ 'In stock': 'green', 'Low stock': 'amber', 'Out of stock': 'red', Expired: 'red', 'Expiring soon': 'amber', Skincare: 'sage', Cosmetics: 'pink', Bodycare: 'tan', Sale: 'green', Purchase: 'blue', Expense: 'tan', Income: 'sage', Refund: 'pink' }[children] || 'neutral');
  return <span className={`badge ${color}`}>{['In stock', 'Low stock', 'Out of stock'].includes(children) && <i />}{children}</span>;
}
export function Empty({ title = 'Nothing here yet', description = 'Your entries will appear here.', action }) {
  return <div className="empty"><span><Package size={26} strokeWidth={1.5} /></span><h3>{title}</h3><p>{description}</p>{action}</div>;
}
export function Field({ label, children, hint, className = '' }) {
  return <label className={`field ${className}`}><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}
export function Select({ children, className = '', ...props }) {
  return <span className={`select-wrap ${className}`}><select {...props}>{children}</select><ChevronDown size={14} /></span>;
}
export function Modal({ title, subtitle, children, onClose, wide = false, busy = false }) {
  const ref = useRef(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const node = ref.current;
    const focusable = () => [...node.querySelectorAll('button, input, select, textarea, [tabindex="0"]')].filter(el => !el.disabled && el.offsetParent !== null);
    (focusable().find(el => el.tagName === 'INPUT') || focusable()[0])?.focus();
    const listener = e => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab') {
        const elements = focusable(), first = elements[0], last = elements.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown', listener);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.removeEventListener('keydown', listener); document.body.style.overflow = previousOverflow; previous?.focus(); };
  }, []);
  return <div className="modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}><section ref={ref} className={`modal ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby="modal-title"><header className="modal-header"><div><h2 id="modal-title">{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} disabled={busy} aria-label="Close dialog"><X size={20} /></button></header>{children}</section></div>;
}
export function TransactionIcon({ type }) {
  const Icon = { sale: ShoppingBag, income: ArrowDownLeft, expense: ArrowUpRight, purchase: Package, refund: RotateCcw }[type];
  return <span className={`transaction-icon ${type}`}><Icon size={17} strokeWidth={1.7} /></span>;
}
export function download(content, filename, type = 'text/csv;charset=utf-8') {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
