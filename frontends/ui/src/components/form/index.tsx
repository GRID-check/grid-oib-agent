// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

'use client'

/**
 * GRID form system — TanStack Form + Zod + shadcn primitives.
 *
 * Usage:
 * ```tsx
 * const form = useAppForm({
 *   defaultValues: { name: '' },
 *   validators: { onChange: createProjectSchema },   // a zod schema
 *   onSubmit: async ({ value }) => { ... },
 * })
 *
 * <form onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); form.handleSubmit() }}>
 *   <form.AppField name="name">
 *     {(field) => <field.TextField label="Project name" placeholder="e.g. Hotel Donaukanal" />}
 *   </form.AppField>
 *   <form.AppForm>
 *     <form.SubmitButton>Create project</form.SubmitButton>
 *   </form.AppForm>
 * </form>
 * ```
 *
 * Every field component renders label, control, and validation errors in a
 * consistent layout. Validation is Zod via TanStack Form's standard-schema
 * support — no manual error wiring.
 */

import * as React from 'react'
import { createFormHook, createFormHookContexts } from '@tanstack/react-form'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Spinner } from '@/components/ui/spinner'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'

const { fieldContext, formContext, useFieldContext, useFormContext } = createFormHookContexts()

/* ----------------------------------------------------------------------------
 * Shared field chrome
 * ------------------------------------------------------------------------- */

interface FieldShellProps {
  label?: string
  description?: string
  required?: boolean
  className?: string
  htmlFor?: string
  errors: Array<string | { message: string } | undefined>
  children: React.ReactNode
}

function FieldShell({ label, description, required, className, htmlFor, errors, children }: FieldShellProps) {
  const messages = errors
    .map((e) => (typeof e === 'string' ? e : e?.message))
    .filter((m): m is string => Boolean(m))

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      {label && (
        <Label htmlFor={htmlFor} className="text-sm font-medium">
          {label}
          {required && <span aria-hidden className="text-destructive"> *</span>}
        </Label>
      )}
      {children}
      {description && messages.length === 0 && (
        <p className="text-xs text-muted-foreground">{description}</p>
      )}
      {messages.length > 0 && (
        <p role="alert" className="text-xs font-medium text-destructive">
          {messages[0]}
        </p>
      )}
    </div>
  )
}

function useFieldErrors(field: { state: { meta: { isTouched: boolean; errors: unknown[] } } }) {
  // Only surface errors once the user has interacted with the field.
  return field.state.meta.isTouched
    ? (field.state.meta.errors as Array<string | { message: string } | undefined>)
    : []
}

/* ----------------------------------------------------------------------------
 * Field components (bound to TanStack field context)
 * ------------------------------------------------------------------------- */

interface TextFieldProps extends Omit<React.ComponentProps<typeof Input>, 'value' | 'onChange' | 'onBlur'> {
  label?: string
  description?: string
  containerClassName?: string
}

function TextField({ label, description, required, containerClassName, ...inputProps }: TextFieldProps) {
  const field = useFieldContext<string>()
  const errors = useFieldErrors(field)
  const id = inputProps.id ?? field.name

  return (
    <FieldShell
      label={label}
      description={description}
      required={required}
      htmlFor={id}
      errors={errors}
      className={containerClassName}
    >
      <Input
        {...inputProps}
        id={id}
        name={field.name}
        value={field.state.value ?? ''}
        onChange={(e) => field.handleChange(e.target.value)}
        onBlur={field.handleBlur}
        aria-invalid={errors.length > 0 || undefined}
      />
    </FieldShell>
  )
}

interface TextAreaFieldProps extends Omit<React.ComponentProps<typeof Textarea>, 'value' | 'onChange' | 'onBlur'> {
  label?: string
  description?: string
  containerClassName?: string
}

function TextAreaField({ label, description, required, containerClassName, ...textareaProps }: TextAreaFieldProps) {
  const field = useFieldContext<string>()
  const errors = useFieldErrors(field)
  const id = textareaProps.id ?? field.name

  return (
    <FieldShell
      label={label}
      description={description}
      required={required}
      htmlFor={id}
      errors={errors}
      className={containerClassName}
    >
      <Textarea
        {...textareaProps}
        id={id}
        name={field.name}
        value={field.state.value ?? ''}
        onChange={(e) => field.handleChange(e.target.value)}
        onBlur={field.handleBlur}
        aria-invalid={errors.length > 0 || undefined}
      />
    </FieldShell>
  )
}

interface SelectFieldProps {
  label?: string
  description?: string
  required?: boolean
  placeholder?: string
  options: Array<{ value: string; label: string; disabled?: boolean }>
  containerClassName?: string
  triggerClassName?: string
  disabled?: boolean
}

function SelectField({
  label,
  description,
  required,
  placeholder,
  options,
  containerClassName,
  triggerClassName,
  disabled,
}: SelectFieldProps) {
  const field = useFieldContext<string>()
  const errors = useFieldErrors(field)

  return (
    <FieldShell
      label={label}
      description={description}
      required={required}
      htmlFor={field.name}
      errors={errors}
      className={containerClassName}
    >
      <Select
        value={field.state.value ?? ''}
        onValueChange={(value) => field.handleChange(value)}
        disabled={disabled}
      >
        <SelectTrigger
          id={field.name}
          className={triggerClassName}
          onBlur={field.handleBlur}
          aria-invalid={errors.length > 0 || undefined}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FieldShell>
  )
}

interface CheckboxFieldProps {
  label: string
  description?: string
  containerClassName?: string
  disabled?: boolean
}

function CheckboxField({ label, description, containerClassName, disabled }: CheckboxFieldProps) {
  const field = useFieldContext<boolean>()
  const errors = useFieldErrors(field)
  const id = field.name

  return (
    <FieldShell errors={errors} className={containerClassName}>
      <div className="flex items-start gap-2">
        <Checkbox
          id={id}
          checked={field.state.value ?? false}
          onCheckedChange={(checked) => field.handleChange(checked === true)}
          onBlur={field.handleBlur}
          disabled={disabled}
        />
        <div className="flex flex-col gap-0.5">
          <Label htmlFor={id} className="text-sm font-normal">
            {label}
          </Label>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
      </div>
    </FieldShell>
  )
}

interface SwitchFieldProps {
  label: string
  description?: string
  containerClassName?: string
  disabled?: boolean
}

function SwitchField({ label, description, containerClassName, disabled }: SwitchFieldProps) {
  const field = useFieldContext<boolean>()
  const errors = useFieldErrors(field)
  const id = field.name

  return (
    <FieldShell errors={errors} className={containerClassName}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col gap-0.5">
          <Label htmlFor={id} className="text-sm font-medium">
            {label}
          </Label>
          {description && <p className="text-xs text-muted-foreground">{description}</p>}
        </div>
        <Switch
          id={id}
          checked={field.state.value ?? false}
          onCheckedChange={(checked) => field.handleChange(checked)}
          onBlur={field.handleBlur}
          disabled={disabled}
        />
      </div>
    </FieldShell>
  )
}

/* ----------------------------------------------------------------------------
 * Form-level components (bound to form context)
 * ------------------------------------------------------------------------- */

interface SubmitButtonProps extends React.ComponentProps<typeof Button> {
  children: React.ReactNode
}

function SubmitButton({ children, disabled, ...buttonProps }: SubmitButtonProps) {
  const form = useFormContext()

  return (
    <form.Subscribe selector={(state) => [state.canSubmit, state.isSubmitting] as const}>
      {([canSubmit, isSubmitting]) => (
        <Button type="submit" disabled={disabled || !canSubmit || isSubmitting} {...buttonProps}>
          {isSubmitting && <Spinner size="sm" />}
          {children}
        </Button>
      )}
    </form.Subscribe>
  )
}

/* ----------------------------------------------------------------------------
 * The app form hook
 * ------------------------------------------------------------------------- */

export const { useAppForm, withForm } = createFormHook({
  fieldContext,
  formContext,
  fieldComponents: {
    TextField,
    TextAreaField,
    SelectField,
    CheckboxField,
    SwitchField,
  },
  formComponents: {
    SubmitButton,
  },
})

export { useFieldContext, useFormContext, FieldShell }
