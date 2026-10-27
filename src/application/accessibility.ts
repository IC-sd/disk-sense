export function trapDialogKeydown(event: KeyboardEvent, root: HTMLElement | null, close: () => void) {
  if (event.defaultPrevented) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
  if (event.key !== 'Tab' || !root) return
  const controls = [...root.querySelectorAll<HTMLElement>('button, input, select, textarea, summary, a[href], [tabindex]:not([tabindex="-1"])')]
    .filter(element => !element.matches(':disabled, [hidden], [aria-hidden="true"]') && element.getClientRects().length > 0)
  const first = controls[0], last = controls.at(-1), active = document.activeElement
  if (!first || !last) { event.preventDefault(); root.focus(); return }
  if (event.shiftKey && (active === first || !root.contains(active))) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && (active === last || !root.contains(active))) { event.preventDefault(); first.focus() }
}

export function handleRovingKeydown(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const root = event.currentTarget as HTMLElement | null
  if (!root) return
  const controls = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"], [role="radio"]')].filter(element => !element.disabled)
  if (!controls.length) return
  const index = controls.indexOf(event.target as HTMLButtonElement)
  if (index < 0) return
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1
    : (index + (event.key === 'ArrowLeft' ? -1 : 1) + controls.length) % controls.length
  event.preventDefault()
  controls[next].focus()
  controls[next].click()
}
