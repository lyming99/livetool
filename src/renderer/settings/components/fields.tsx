import { useEffect, useState, type ChangeEvent, type ReactNode, type Ref } from 'react'

export function Field({ id, label, children, unit }: { id: string; label: string; children: ReactNode; unit?: string }): ReactNode {
  return <div className="field"><label htmlFor={id}>{label}</label>{children}{unit && <span className="unit">{unit}</span>}</div>
}
export function TextField({ id, label, value, onChange, placeholder = '', password = false, inputRef }: { id: string; label: string; value: string; onChange(value: string): void; placeholder?: string; password?: boolean; inputRef?: Ref<HTMLInputElement> }): ReactNode {
  const [draft, setDraft] = useState(value)
  const [focused, setFocused] = useState(false)
  useEffect(() => { if (!focused) setDraft(value) }, [value, focused])
  return <Field id={id} label={label}><input id={id} ref={inputRef} type={password ? 'password' : 'text'} value={draft} placeholder={placeholder} onFocus={() => setFocused(true)} onBlur={() => { setFocused(false); onChange(draft) }} onChange={event => { setDraft(event.target.value); onChange(event.target.value) }} /></Field>
}
export function SelectField({ id, label, value, options, onChange, disabled = false }: { id: string; label: string; value: string | number; options: readonly (readonly [string | number, string])[]; onChange(value: string): void; disabled?: boolean }): ReactNode {
  return <Field id={id} label={label}><select id={id} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>{options.map(([key, text]) => <option value={key} key={key}>{text}</option>)}</select></Field>
}
export function RangeField({ id, label, value, min, max, step = 1, percentage = false, onChange }: { id: string; label: string; value: number; min: number; max: number; step?: number; percentage?: boolean; onChange(value: number): void }): ReactNode {
  const uiValue = percentage ? Math.round(value * 100) : value
  const changed = (event: ChangeEvent<HTMLInputElement>): void => onChange(Number(event.target.value) / (percentage ? 100 : 1))
  return <div className="field range"><label htmlFor={id}>{label}</label><input type="range" id={id} min={min} max={max} step={step} value={uiValue} onChange={changed} /><output id={id + 'Out'}>{Math.round(uiValue)}{percentage ? '%' : ''}</output></div>
}
export function NumberField({ id, label, value, min, max, step = 1, unit, disabled = false, onChange }: { id: string; label: string; value: number; min: number; max: number; step?: number; unit: string; disabled?: boolean; onChange(value: number): void }): ReactNode {
  const [draft, setDraft] = useState(String(value))
  const [focused, setFocused] = useState(false)
  useEffect(() => { if (!focused) setDraft(String(value)) }, [value, focused])
  return <Field id={id} label={label} unit={unit}><input type="number" id={id} min={min} max={max} step={step} disabled={disabled} value={draft} onFocus={() => setFocused(true)} onBlur={() => {
    setFocused(false)
    const number = Number(draft)
    const normalized = draft.trim() && Number.isFinite(number) ? Math.round(Math.min(max, Math.max(min, number))) : value
    setDraft(String(normalized)); onChange(normalized)
  }} onChange={event => {
    setDraft(event.target.value)
    const number = event.target.valueAsNumber
    // Keep intermediate empty/out-of-range text local: typing 120 must not turn 1 into 5.
    if (Number.isFinite(number) && number >= min && number <= max) onChange(Math.round(number))
  }} /></Field>
}
export function Switch({ id, label, checked, disabled = false, onChange }: { id: string; label: string; checked: boolean; disabled?: boolean; onChange(value: boolean): void }): ReactNode {
  return <label className={'switch' + (disabled ? ' disabled' : '')}><input type="checkbox" id={id} checked={checked} disabled={disabled} onChange={event => onChange(event.target.checked)} /><span>{label}</span></label>
}
