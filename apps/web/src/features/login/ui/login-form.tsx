'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { useLogin } from '@/entities/session';
import { isApiError } from '@/shared/api/client';
import { Alert, Button, Field, Input } from '@/shared/ui';
import { loginFormSchema, type LoginFormValues } from '../model/schema';

export function LoginForm({ onSuccess }: { onSuccess: () => void }) {
  const t = useTranslations('auth');
  const tv = useTranslations('validation');
  const login = useLogin();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginFormValues>({
    resolver: zodResolver(loginFormSchema),
    defaultValues: { email: '', password: '' },
  });

  const tc = useTranslations('common');
  const err = login.error;
  const message = (() => {
    if (!err) return null;
    if (!isApiError(err)) return tc('error');
    if (err.status === 401) return t('invalid');
    if (err.code === 'rate_limited') {
      return t('tooMany', {
        seconds: Number(
          (err.details as { retryAfterSec?: number } | undefined)?.retryAfterSec ?? 60,
        ),
      });
    }
    return err.status === 0 ? tc('networkError') : tc('error');
  })();

  return (
    <form
      noValidate
      className="grid gap-4"
      onSubmit={handleSubmit((v) => login.mutate(v, { onSuccess }))}
      aria-describedby={err ? 'login-error' : undefined}
    >
      {message ? (
        <Alert tone="danger" id="login-error">
          {message}
        </Alert>
      ) : null}
      <Field
        id="email"
        label={t('email')}
        error={errors.email?.message ? tv(errors.email.message as 'required') : undefined}
      >
        {(a11y) => <Input {...a11y} type="email" autoComplete="username" {...register('email')} />}
      </Field>
      <Field
        id="password"
        label={t('password')}
        error={errors.password?.message ? tv(errors.password.message as 'required') : undefined}
      >
        {(a11y) => (
          <Input
            {...a11y}
            type="password"
            autoComplete="current-password"
            {...register('password')}
          />
        )}
      </Field>
      <Button type="submit" disabled={login.isPending}>
        {t('submit')}
      </Button>
      <p className="text-xs text-muted-foreground">{t('demo')}</p>
    </form>
  );
}
