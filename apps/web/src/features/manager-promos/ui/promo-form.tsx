'use client';
import { zodResolver } from '@hookform/resolvers/zod';
import { useTranslations } from 'next-intl';
import { useForm, useWatch } from 'react-hook-form';
import { useCreatePromo } from '@/entities/promo';
import { isApiError } from '@/shared/api/client';
import { Alert, Button, Field, Input } from '@/shared/ui';
import { Select } from '@/shared/ui/input';
import { promoFormSchema, toPromoPayload, type PromoFormValues } from '../model/schema';

export function NewPromoForm({ onDone }: { onDone: () => void }) {
  const t = useTranslations('manager.promos');
  const tv = useTranslations('validation');
  const tc = useTranslations('common');
  const create = useCreatePromo();
  const {
    register,
    handleSubmit,
    control,
    formState: { errors },
  } = useForm<PromoFormValues>({
    resolver: zodResolver(promoFormSchema),
    defaultValues: {
      code: '',
      type: 'percent',
      value: '',
      minOrder: '',
      startsAt: '',
      expiresAt: '',
      maxUses: '',
      oncePerCustomer: true,
    },
  });
  const type = useWatch({ control, name: 'type' });
  const msg = (k?: string) => (k ? tv(k as 'required') : undefined);
  const duplicate = isApiError(create.error) && create.error.status === 409;

  return (
    <form
      noValidate
      aria-label={t('new')}
      className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2"
      onSubmit={handleSubmit((v) => create.mutate(toPromoPayload(v), { onSuccess: onDone }))}
    >
      <h2 className="font-semibold sm:col-span-2">{t('new')}</h2>
      {create.isError ? (
        <Alert tone="danger" className="sm:col-span-2">
          {duplicate ? t('duplicate') : tc('error')}
        </Alert>
      ) : null}
      <Field
        id="promo-code-new"
        label={t('code')}
        hint={t('codeFormat')}
        error={msg(errors.code?.message)}
      >
        {(a) => <Input {...a} autoComplete="off" {...register('code')} />}
      </Field>
      <Field id="promo-type" label={t('type')}>
        {(a) => (
          <Select {...a} {...register('type')}>
            <option value="percent">{t('types.percent')}</option>
            <option value="fixed">{t('types.fixed')}</option>
          </Select>
        )}
      </Field>
      <Field
        id="promo-value"
        label={type === 'percent' ? t('valuePercent') : t('valueFixed')}
        error={msg(errors.value?.message)}
      >
        {(a) => <Input {...a} inputMode="decimal" {...register('value')} />}
      </Field>
      <Field id="promo-min" label={t('minOrder')} error={msg(errors.minOrder?.message)}>
        {(a) => <Input {...a} inputMode="decimal" {...register('minOrder')} />}
      </Field>
      <Field id="promo-starts" label={t('startsAt')}>
        {(a) => <Input {...a} type="datetime-local" {...register('startsAt')} />}
      </Field>
      <Field id="promo-expires" label={t('expiresAt')} error={msg(errors.expiresAt?.message)}>
        {(a) => <Input {...a} type="datetime-local" {...register('expiresAt')} />}
      </Field>
      <Field id="promo-max" label={t('maxUses')} error={msg(errors.maxUses?.message)}>
        {(a) => <Input {...a} inputMode="numeric" {...register('maxUses')} />}
      </Field>
      <label className="flex items-center gap-2 self-end text-sm">
        <input type="checkbox" {...register('oncePerCustomer')} />
        {t('oncePerCustomer')}
      </label>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" disabled={create.isPending}>
          {tc('create')}
        </Button>
        <Button variant="outline" onClick={onDone}>
          {tc('cancel')}
        </Button>
      </div>
    </form>
  );
}
